// ─── Tournament finalization at the terminal stage (A24(4)(5)(7), A56, ACCESS-SECURITY-OPS §D.8.1; S8d) ─────────────
// advance_tournament_stage(Completed) checks the format and canComplete, writes the placements and starts the job;
// Cancelled (cancelTournament) voids the live lobbies and starts the same job. run_tournament_finalize processes the
// tournament's surviving result records K = 4 per tick in bracket order: a Validated record is finalized by
// runFinalization (history rows with tournamentId / bracketMatchId, private, A37; stats; achievements;
// MatchLineupHistory and the A56 deletes; hardDeleteLobby), with MMR only when the tournament counts toward MMR and
// is Completed (A24(5): Cancelled counts stats, never MMR); any other record (Voided by a rollback or a staff
// decision, Rejected, or unfinished) is deleted without effect. When none remains: the leaderboard is rebuilt once
// (MMR tournaments), Tournament.finalizedAt is set and the job ends.

import { SenderError } from 'spacetimedb/server';
import { ScheduleAt } from 'spacetimedb';
import { canComplete } from '@shared/bracket';
import { SYSTEM_USER_ID } from '@module/helpers/admin/auditColumns';
import { updateWithAudit } from '@module/helpers/admin/auditHelpers';
import { runFinalization } from '@module/helpers/results/finalizationHelpers';
import { rebuildLeaderboard } from '@module/helpers/stats/leaderboardRebuild';
import { groupStandings } from './tournamentStandings';
import { tournamentRecordsInBracketOrder } from './tournamentResults';
import { hardDeleteLobby } from '@module/reducers/lobby/lobbyGc';

/** D.8.1: records finalized per tick. */
export const FINALIZE_BATCH_SIZE = 4;

const ELIMINATION_FORMATS = new Set(['SingleElimination', 'DoubleElimination']);
const HYBRID_FORMATS = new Set(['GroupIntoSingleElim', 'GroupIntoDoubleElim']);
const UNPLACED_STATUSES = new Set(['Withdrawn', 'Disqualified']);

/**
 * InProgress → Completed guard (review §5.1, S8a gap closed here): the format check first (GroupInto*: the
 * elimination rows exist; GroupOnly: only group rows), then canComplete (every row Decided / Walkover / Void) and no
 * tournament lobby outside AwaitingResult.
 */
export function ensureCanComplete(ctx: any, tournament: any): void {
    const rows = [...ctx.db.BracketMatch.tournament_id.filter(tournament.id)];
    const format = tournament.format.tag as string;
    const hasElimination = rows.some((m: any) => m.bracketSide.tag !== 'Group');
    if (HYBRID_FORMATS.has(format) && !hasElimination) {
        throw new SenderError('The elimination stage has not been generated yet (advance_group_stage).');
    }
    if (format === 'GroupOnly' && hasElimination) {
        throw new SenderError('A group-only tournament cannot hold elimination matches.');
    }
    let liveLobbies = 0;
    for (const m of rows) {
        for (const lobby of ctx.db.Lobby.bracket_match_id.filter(m.id)) {
            if (lobby.stage.tag !== 'AwaitingResult') liveLobbies++;
        }
    }
    const guard = canComplete(rows, liveLobbies);
    if (!guard.ok) throw new SenderError(guard.reason);
}

/**
 * Elimination standing key of a team (higher is better), or undefined when the team never played an elimination
 * match. Champion 5; final loser 4 (the final = the grand final, or the last Winners round in single elimination);
 * third-place match winner 3.1, loser 3.0; otherwise the match that eliminated the team (lost with no loser route):
 * Losers rounds 2.x above Winners rounds 1.x, a later round above an earlier one. In double elimination the
 * losers-bracket final loser is therefore third (A29), and teams knocked out in the same round share a placement.
 */
function eliminationKeys(rows: any[]): Map<number, number> {
    // A walkover carries winnerTeamId too (bracketResults / bracketStore.settle): a final or third-place match settled
    // by walkover still places its winner; its loser side is a BYE or a DQ'd team (no placement when Disqualified).
    const elim = rows.filter((m: any) => m.bracketSide.tag !== 'Group'
        && (m.state.tag === 'Decided' || m.state.tag === 'Walkover'));
    const keys = new Map<number, number>();
    const all = rows.filter((m: any) => m.bracketSide.tag !== 'Group');
    const grandFinal = all.find((m: any) => m.bracketSide.tag === 'GrandFinals');
    const winners = all.filter((m: any) => m.bracketSide.tag === 'Winners');
    const maxWinnersRound = winners.reduce((r: number, m: any) => Math.max(r, m.roundNumber), 0);
    const final = grandFinal ?? winners.find((m: any) => m.roundNumber === maxWinnersRound);
    const set = (teamId: number | undefined, key: number) => {
        if (teamId === undefined) return;
        if (!keys.has(teamId) || keys.get(teamId)! < key) keys.set(teamId, key);
    };
    for (const m of elim) {
        if (final && m.id === final.id) {
            set(m.winnerTeamId, 5);
            set(m.loserTeamId, 4);
        } else if (m.bracketSide.tag === 'ThirdPlace') {
            set(m.winnerTeamId, 3.1);
            set(m.loserTeamId, 3);
        } else if (m.nextLoserMatchId === undefined) {
            const sideBase = m.bracketSide.tag === 'Losers' ? 2 : 1;
            set(m.loserTeamId, sideBase + Math.min(m.roundNumber, 999) / 1000);
        }
    }
    return keys;
}

/**
 * Competition ranking ("1224"): placement = 1 + the number of ranked teams strictly better. Elimination formats rank
 * by eliminationKeys; GroupOnly by the A30 group position (rankGroup through groupStandings), equal positions in
 * different groups sharing a placement; GroupInto* ranks the elimination teams first, then the teams that did not
 * qualify by their group position. Withdrawn and Disqualified teams get no placement (finalPlacement stays unset).
 * Team statuses are left as they are (Active / Eliminated): A26 names no end state.
 */
export function assignFinalPlacements(ctx: any, tournament: any, actorId: number): void {
    const rows = [...ctx.db.BracketMatch.tournament_id.filter(tournament.id)];
    const teams = [...ctx.db.TournamentTeam.tournament_id.filter(tournament.id)]
        .filter((t: any) => !UNPLACED_STATUSES.has(t.status.tag));
    const format = tournament.format.tag as string;

    // score: [tier, value]; tier 1 = elimination standing, tier 0 = group position (value = -position).
    const score = new Map<number, [number, number]>();
    if (ELIMINATION_FORMATS.has(format) || HYBRID_FORMATS.has(format)) {
        for (const [teamId, key] of eliminationKeys(rows)) score.set(teamId, [1, key]);
    }
    if (format === 'GroupOnly' || HYBRID_FORMATS.has(format)) {
        const groupIds = new Set<number>();
        for (const t of teams) if (t.groupId !== undefined) groupIds.add(t.groupId);
        for (const groupId of groupIds) {
            groupStandings(ctx, tournament.id, groupId)
                .filter((r) => teams.some((t: any) => t.id === r.teamId))
                .forEach((r, index) => { if (!score.has(r.teamId)) score.set(r.teamId, [0, -(index + 1)]); });
        }
    }

    const better = (a: [number, number], b: [number, number]) => a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);
    const ranked = teams.filter((t: any) => score.has(t.id));
    for (const team of ranked) {
        const own = score.get(team.id)!;
        const placement = 1 + ranked.filter((o: any) => better(score.get(o.id)!, own)).length;
        if (team.finalPlacement !== placement) {
            ctx.db.TournamentTeam.id.update(updateWithAudit(ctx, team, { finalPlacement: placement }, actorId));
        }
    }
}

/**
 * Starts the D.8.1 job: Tournament.finalizationStartedAt = now and one TournamentFinalizeJob { tournamentId,
 * cursor: 0 } scheduled now (a second start while a job row exists is a no-op).
 */
export function startTournamentFinalization(ctx: any, tournamentId: number, actorId: number): void {
    const tournament = ctx.db.Tournament.id.find(tournamentId);
    if (!tournament) return;
    ctx.db.Tournament.id.update(updateWithAudit(ctx, tournament, { finalizationStartedAt: ctx.timestamp }, actorId));
    if ([...ctx.db.TournamentFinalizeJob.tournament_id.filter(tournamentId)].length > 0) return;
    ctx.db.TournamentFinalizeJob.insert({
        scheduledId: 0n,
        scheduledAt: ScheduleAt.time(ctx.timestamp.microsSinceUnixEpoch),
        tournamentId,
        cursor: 0,
    });
}

/**
 * Moderator+ recovery (S8d review): a tick that throws rolls back with its own reschedule row, so the job stops with
 * finalizationStartedAt set and finalizedAt unset. This re-inserts a job row scheduled now with `cursor` (progress
 * only; admin_restart_tournament_finalize passes 0, the stopped row's value is gone). Restarting is safe: every record a finished tick processed was
 * finalized or deleted with its row, so the next tick starts at the first surviving record in bracket order.
 */
export function restartTournamentFinalization(ctx: any, tournamentId: number, cursor: number): void {
    ctx.db.TournamentFinalizeJob.insert({
        scheduledId: 0n,
        scheduledAt: ScheduleAt.time(ctx.timestamp.microsSinceUnixEpoch),
        tournamentId,
        cursor,
    });
}

/**
 * One tick of the job (one transaction). Reschedules first (F14 lesson): the next row (cursor + batch size) is
 * inserted before any record is processed, so a tick that returns early still leaves the job alive; a tick that
 * throws rolls back as a whole, leaving every earlier tick's matches finalized. `cursor` counts the records already
 * processed (finalized records are deleted, so each tick reads the first K survivors in bracket order).
 */
export function runTournamentFinalizeTick(ctx: any, job: { tournamentId: number; cursor: number }): void {
    const tournament = ctx.db.Tournament.id.find(job.tournamentId);
    if (!tournament) return; // nothing left to finalize; the job ends with its row
    const batch = tournamentRecordsInBracketOrder(ctx, job.tournamentId).slice(0, FINALIZE_BATCH_SIZE);

    if (batch.length === 0) {
        if (tournament.countTowardsMmr && tournament.stage.tag === 'Completed') { // A24(5): no MMR ran on Cancelled
            const activeSeason = [...ctx.db.Season.is_active.filter(true)][0];
            rebuildLeaderboard(ctx, SYSTEM_USER_ID, activeSeason ? activeSeason.id : 0); // once, A37 audit actor
        }
        ctx.db.Tournament.id.update(updateWithAudit(ctx, tournament, { finalizedAt: ctx.timestamp }, SYSTEM_USER_ID));
        for (const row of [...ctx.db.TournamentFinalizeJob.tournament_id.filter(job.tournamentId)]) {
            ctx.db.TournamentFinalizeJob.scheduledId.delete(row.scheduledId);
        }
        console.log(`[TOURNAMENT_FINALIZE] Tournament #${job.tournamentId} finalized (${job.cursor} records)`);
        return;
    }

    // Reschedule first (F14).
    ctx.db.TournamentFinalizeJob.insert({
        scheduledId: 0n,
        scheduledAt: ScheduleAt.time(ctx.timestamp.microsSinceUnixEpoch),
        tournamentId: job.tournamentId,
        cursor: job.cursor + batch.length,
    });

    const tournamentMmr = tournament.countTowardsMmr && tournament.stage.tag === 'Completed'; // A24(5)
    for (const record of batch) {
        if (record.status.tag === 'Validated') {
            runFinalization(ctx, record, SYSTEM_USER_ID, { tournamentMmr });
        } else if (ctx.db.Lobby.id.find(record.lobbyId)) {
            hardDeleteLobby(ctx, record.lobbyId); // deletes the record with its lobby, no effect
        } else {
            ctx.db.MatchResultRecord.id.delete(record.id); // Voided: its lobby is already gone
        }
    }
    console.log(`[TOURNAMENT_FINALIZE] Tournament #${job.tournamentId}: ${batch.length} record(s) processed (cursor ${job.cursor + batch.length})`);
}
