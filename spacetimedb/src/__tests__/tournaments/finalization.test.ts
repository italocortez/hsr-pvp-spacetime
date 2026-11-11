// Tournaments: finalization at Completed and Cancelled (placements, the finalize job, restart, leaderboard).
// Decisions: A24
// Contracts: docs/tournament/contract.md, docs/brackets/contract.md
// From S8d (s8d-finalization.test.ts).
//
// T-S8d: in-memory tests for finalization at the terminal stage (A24(4)(5)(7), A56, ACCESS-SECURITY-OPS §D.8.1):
// the InProgress → Completed guards (format check, canComplete, parked lobbies), the placements on
// TournamentTeam.finalPlacement (the landed "1224" rule), finalizationStartedAt and the TournamentFinalizeJob row,
// run_tournament_finalize ticks (K = 4 records in bracket order, reschedule row, history with tournamentId /
// bracketMatchId, MMR only for a Completed MMR tournament, MatchLineupHistory, lobbies hard-deleted, Voided records
// deleted without history, the last tick: leaderboard once, finalizedAt, job gone) and the Cancelled path (stats
// counted, MMR skipped). Scheduled ticks are driven by hand (`tick` in s8d-fixtures.ts). Nothing reaches maincloud.
import { describe, expect, it } from 'vitest';
import { M, expectReject, lobbyRow, snap, tx, type Actor, type Harness } from '../fixtures/harness';
import { admin, verified } from '../fixtures/identity';
import {
    advanceStage,
    assignAssistant,
    bracketRows,
    liveField,
    matchRow,
    resolveMatch,
    tRow,
    teamRow,
    teams,
    BO1,
} from '../fixtures/tournaments';
import {
    byKey,
    drain,
    historyOf,
    jobsOf,
    openMatchLobby,
    playMatch,
    recordsOfLobby,
    seedElo,
    tick,
    validate,
    type Field,
} from '../fixtures/tournament-matches';
import { TOURNAMENT_PERM_MESSAGES } from '@module/helpers/tournament/tournamentPermissions';
import { FINALIZE_BATCH_SIZE } from '@module/helpers/tournament/tournamentFinalization';

const complete = (f: Field) => advanceStage(f.test, f.org, f.id, 'Completed');
const placement = (test: Harness, teamId: number | undefined) => teamRow(test, teamId!)!.finalPlacement;

/** Staff-resolves every Ready match (team1 wins unless `pick` says otherwise) until none is Ready. */
function resolveAll(test: Harness, who: Actor, tournamentId: number, pick: (m: any) => number = (m) => m.team1Id) {
    for (let guard = 0; guard < 64; guard++) {
        const ready = bracketRows(test, tournamentId).filter((r) => r.state.tag === 'Ready')
            .sort((a, b) => a.roundNumber - b.roundNumber || a.matchNumber - b.matchNumber);
        if (ready.length === 0) return;
        resolveMatch(test, who, ready[0].id, pick(ready[0]));
    }
    throw new Error('resolveAll did not converge');
}

/** Plays every Ready match of the tournament (lowest round first) through a lobby; Blue (team1) wins. */
function playAll(f: Field, opts: { validateWith?: Actor } = {}) {
    for (let guard = 0; guard < 32; guard++) {
        const ready = bracketRows(f.test, f.id).filter((r) => r.state.tag === 'Ready')
            .sort((a, b) => a.roundNumber - b.roundNumber || a.matchNumber - b.matchNumber);
        if (ready.length === 0) return;
        const s = playMatch(f, ready[0].id, 'Blue');
        if (opts.validateWith) validate(f.test, opts.validateWith, s.lobbyId);
    }
    throw new Error('playAll did not converge');
}

// ─── InProgress → Completed guards ────────────────────────────────────────────

describe('advance_tournament_stage(Completed): guards (review §5.1, D.8.1)', () => {
    it('rejected while a bracket match is open', () => {
        const f = liveField(4, BO1);
        expectReject(f.test, f.org, (ctx) => M.advance_tournament_stage(ctx, { tournamentId: f.id, nextStage: 'Completed' }),
            /bracket match\(es\) are not settled/);
        resolveMatch(f.test, f.org, byKey(f.test, f.id, 'W-R1-M1').id, byKey(f.test, f.id, 'W-R1-M1').team1Id!);
        expectReject(f.test, f.org, (ctx) => M.advance_tournament_stage(ctx, { tournamentId: f.id, nextStage: 'Completed' }),
            /2 bracket match\(es\) are not settled/);
        expect(tRow(f.test, f.id).stage.tag).toBe('InProgress');
        expect(jobsOf(f.test, f.id)).toHaveLength(0);
    });

    it('rejected while a tournament lobby is not parked in AwaitingResult; accepted once it is', () => {
        const f = liveField(2, BO1);
        const m = byKey(f.test, f.id, 'W-R1-M1');
        const s = playMatch(f, m.id, 'Blue');
        // Direct row edit: a settled match whose lobby is still live (no reducer reaches this; the guard must hold).
        const parked = lobbyRow(f.test, s.lobbyId);
        f.test.db.Lobby.id.update({ ...parked, stage: { tag: 'Scoring' } as any });
        expectReject(f.test, f.org, (ctx) => M.advance_tournament_stage(ctx, { tournamentId: f.id, nextStage: 'Completed' }),
            '1 tournament lobby(ies) still open.');
        f.test.db.Lobby.id.update({ ...lobbyRow(f.test, s.lobbyId), stage: { tag: 'AwaitingResult' } as any });
        complete(f);
        expect(tRow(f.test, f.id).stage.tag).toBe('Completed');
    });

    it('GroupInto*: rejected before the elimination rows exist, even with every group match settled', () => {
        const f = liveField(4, { ...BO1, format: 'GroupIntoSingleElim', groupSize: 4, groupAdvanceCount: 2 });
        resolveAll(f.test, f.org, f.id);
        expect(bracketRows(f.test, f.id).every((r) => r.bracketSide.tag === 'Group')).toBe(true);
        expectReject(f.test, f.org, (ctx) => M.advance_tournament_stage(ctx, { tournamentId: f.id, nextStage: 'Completed' }),
            'The elimination stage has not been generated yet (advance_group_stage).');
        tx(f.test, f.org, (ctx) => M.advance_group_stage(ctx, { tournamentId: f.id }));
        resolveAll(f.test, f.org, f.id);
        complete(f);
        expect(tRow(f.test, f.id).stage.tag).toBe('Completed');
    });

    it('owner permission: an assistant with every flag and a captain cannot complete', () => {
        const f = liveField(2, BO1);
        resolveAll(f.test, f.org, f.id);
        const res = verified(f.test, 'res');
        assignAssistant(f.test, f.org, f.id, res, { results: true, bracket: true, participants: true });
        expectReject(f.test, res, (ctx) => M.advance_tournament_stage(ctx, { tournamentId: f.id, nextStage: 'Completed' }), TOURNAMENT_PERM_MESSAGES.owner);
        expectReject(f.test, f.ts[0].captain, (ctx) => M.advance_tournament_stage(ctx, { tournamentId: f.id, nextStage: 'Completed' }), TOURNAMENT_PERM_MESSAGES.owner);
        expect(jobsOf(f.test, f.id)).toHaveLength(0);
    });
});

// ─── Placements ───────────────────────────────────────────────────────────────

describe('placements on TournamentTeam.finalPlacement ("1224", as landed)', () => {
    it('single elimination with a third-place match: 1 / 2 / 3 / 4; finalizationStartedAt and one job row', () => {
        const f = liveField(4, { ...BO1, has3rdPlaceMatch: true });
        resolveAll(f.test, f.org, f.id);
        const rows = bracketRows(f.test, f.id);
        const final = rows.find((r) => r.bracketSide.tag === 'Winners' && r.roundNumber === 2)!;
        const tp = rows.find((r) => r.bracketSide.tag === 'ThirdPlace')!;
        complete(f);
        expect(placement(f.test, final.winnerTeamId)).toBe(1);
        expect(placement(f.test, final.loserTeamId)).toBe(2);
        expect(placement(f.test, tp.winnerTeamId)).toBe(3);
        expect(placement(f.test, tp.loserTeamId)).toBe(4);
        const t = tRow(f.test, f.id);
        expect(t.finalizationStartedAt).toBeDefined();
        expect(t.finalizedAt).toBeUndefined();
        const jobs = jobsOf(f.test, f.id);
        expect(jobs).toHaveLength(1);
        expect(jobs[0].tournamentId).toBe(f.id); // S11a (L84): the job row has no progress cursor
        // Team statuses are left as they are (A26 names no end state).
        expect(teamRow(f.test, final.winnerTeamId!)!.status.tag).toBe('Active');
        expect(teamRow(f.test, tp.loserTeamId!)!.status.tag).toBe('Eliminated');
    });

    it('single elimination of 8 without a third-place match: 1, 2, 3, 3, 5, 5, 5, 5 (shared by elimination round)', () => {
        const f = liveField(8, BO1);
        resolveAll(f.test, f.org, f.id);
        complete(f);
        const rows = bracketRows(f.test, f.id);
        const final = rows.find((r) => r.roundNumber === 3)!;
        expect(placement(f.test, final.winnerTeamId)).toBe(1);
        expect(placement(f.test, final.loserTeamId)).toBe(2);
        for (const sf of rows.filter((r) => r.roundNumber === 2)) expect(placement(f.test, sf.loserTeamId)).toBe(3);
        for (const qf of rows.filter((r) => r.roundNumber === 1)) expect(placement(f.test, qf.loserTeamId)).toBe(5);
        expect(teams(f.test, f.id).map((t) => t.finalPlacement).sort()).toEqual([1, 2, 3, 3, 5, 5, 5, 5]);
    });

    it('double elimination: champion 1, grand-final loser 2, losers-final loser 3, then by losers round', () => {
        const f = liveField(4, { ...BO1, format: 'DoubleElimination' });
        resolveAll(f.test, f.org, f.id);
        complete(f);
        const rows = bracketRows(f.test, f.id).filter((r) => r.state.tag === 'Decided');
        const gf = rows.find((r) => r.bracketSide.tag === 'GrandFinals')!;
        expect(placement(f.test, gf.winnerTeamId)).toBe(1);
        expect(placement(f.test, gf.loserTeamId)).toBe(2);
        const losers = rows.filter((r) => r.bracketSide.tag === 'Losers').sort((a, b) => b.roundNumber - a.roundNumber);
        expect(placement(f.test, losers[0].loserTeamId)).toBe(3);
        expect(placement(f.test, losers[losers.length - 1].loserTeamId)).toBe(4);
        expect(teams(f.test, f.id).map((t) => t.finalPlacement).sort()).toEqual([1, 2, 3, 4]);
    });

    it('GroupOnly: by group position; equal positions in different groups share a placement', () => {
        const f = liveField(8, { ...BO1, format: 'GroupOnly', groupSize: 4 });
        resolveAll(f.test, f.org, f.id);
        complete(f);
        const placements = teams(f.test, f.id).map((t) => t.finalPlacement).sort((a, b) => a! - b!);
        expect(placements).toEqual([1, 1, 3, 3, 5, 5, 7, 7]);
        // team1 always won: within a group, more wins → better placement.
        const wins = new Map<number, number>();
        for (const r of bracketRows(f.test, f.id)) wins.set(r.winnerTeamId!, (wins.get(r.winnerTeamId!) ?? 0) + 1);
        for (const groupId of new Set(teams(f.test, f.id).map((t) => t.groupId))) {
            const g = teams(f.test, f.id).filter((t) => t.groupId === groupId)
                .sort((a, b) => a.finalPlacement! - b.finalPlacement!);
            for (let i = 1; i < g.length; i++) expect(wins.get(g[i - 1].id) ?? 0).toBeGreaterThanOrEqual(wins.get(g[i].id) ?? 0);
        }
    });

    it('a Disqualified team gets no placement', () => {
        const f = liveField(4, BO1);
        const m = byKey(f.test, f.id, 'W-R1-M1');
        const dqTeam = f.ts.find((t) => t.teamId === m.team2Id)!;
        tx(f.test, f.org, (ctx) => M.dq_participant(ctx, { tournamentId: f.id, userId: dqTeam.captain.userId, reason: 't', dqWholeTeam: true }));
        resolveAll(f.test, f.org, f.id);
        complete(f);
        expect(teamRow(f.test, dqTeam.teamId)!.status.tag).toBe('Disqualified');
        expect(teamRow(f.test, dqTeam.teamId)!.finalPlacement).toBeUndefined();
        expect(teams(f.test, f.id).filter((t) => t.finalPlacement !== undefined)).toHaveLength(3);
    });
});

// ─── run_tournament_finalize ticks ────────────────────────────────────────────

describe('run_tournament_finalize: K = 4 per tick in bracket order (D.8.1)', () => {
    it('8-team Casual SE: tick 1 finalizes round 1, tick 2 the rest, tick 3 ends the job', () => {
        expect(FINALIZE_BATCH_SIZE).toBe(4);
        const f = liveField(8, BO1);
        playAll(f);
        const rows = bracketRows(f.test, f.id);
        const ordered = rows.sort((a, b) => a.roundNumber - b.roundNumber || a.matchNumber - b.matchNumber);
        expect(ordered.every((r) => r.decidedBy?.tag === 'Played')).toBe(true);
        const lobbyOf = new Map(ordered.map((r) => [r.id, [...f.test.db.Lobby.bracket_match_id.filter(r.id)][0].id]));
        expect([...f.test.db.MatchSessionHistory.iter()]).toHaveLength(0);
        complete(f);

        tick(f.test, f.id);
        const h1 = historyOf(f.test, f.id);
        expect(h1).toHaveLength(4);
        expect(h1.map((h) => h.bracketMatchId).sort()).toEqual(ordered.slice(0, 4).map((r) => r.id).sort());
        expect(h1.every((h) => h.tournamentId === f.id)).toBe(true);
        for (const r of ordered.slice(0, 4)) {
            expect(f.test.db.Lobby.id.find(lobbyOf.get(r.id)!)).toBeFalsy(); // hard-deleted
            expect([...f.test.db.MatchResultRecord.bracket_match_id.filter(r.id)]).toHaveLength(0);
        }
        for (const r of ordered.slice(4)) expect(lobbyRow(f.test, lobbyOf.get(r.id)!).stage.tag).toBe('AwaitingResult');
        // The reschedule row (S11a, L84: no progress cursor; the finalized records are gone).
        const after1 = jobsOf(f.test, f.id);
        expect(after1).toHaveLength(1);
        expect(after1[0].tournamentId).toBe(f.id);
        // A56: lineups archived per finalized match (two per game).
        const lineupHistory = [...f.test.db.MatchLineupHistory.iter()];
        expect(lineupHistory.length).toBe(8);
        // Casual: stats counted, no MMR.
        expect([...f.test.db.PlayerStat.iter()].length).toBeGreaterThan(0);
        expect([...f.test.db.MmrHistory.iter()]).toHaveLength(0);

        tick(f.test, f.id);
        expect(historyOf(f.test, f.id)).toHaveLength(7);
        expect(jobsOf(f.test, f.id)).toHaveLength(1);
        expect(tRow(f.test, f.id).finalizedAt).toBeUndefined();
        expect([...f.test.db.Lobby.iter()].filter((l) => l.tournamentId === f.id)).toHaveLength(0);

        tick(f.test, f.id);
        expect(jobsOf(f.test, f.id)).toHaveLength(0);
        expect(tRow(f.test, f.id).finalizedAt).toBeDefined();
        expect(historyOf(f.test, f.id)).toHaveLength(7);
        expect([...f.test.db.MatchSessionStep.iter()]).toHaveLength(0);
    });

    it('a Voided record (rollback) is deleted without history; the replayed Validated one is finalized', () => {
        const f = liveField(2, BO1);
        const m = byKey(f.test, f.id, 'W-R1-M1');
        const first = playMatch(f, m.id, 'Blue');
        const [voided] = recordsOfLobby(f.test, first.lobbyId);
        tx(f.test, f.org, (ctx) => M.rollback_bracket_match(ctx, { bracketMatchId: m.id, reason: 'replay' }));
        const replay = playMatch(f, m.id, 'Red');
        complete(f);
        expect(drain(f.test, f.id)).toBe(2);
        expect(f.test.db.MatchResultRecord.id.find(voided.id)).toBeFalsy();
        const history = historyOf(f.test, f.id);
        expect(history).toHaveLength(1);
        expect(history[0].bracketMatchId).toBe(m.id);
        expect(f.test.db.Lobby.id.find(replay.lobbyId)).toBeFalsy();
        expect([...f.test.db.MatchResultRecord.iter()]).toHaveLength(0);
    });

    it('MMR tournament, Completed: MMR applied per record with the real history id; leaderboard rebuilt at the last tick only', () => {
        const f = liveField(4, { ...BO1, countTowardsMmr: true });
        seedElo(f.test);
        playAll(f, { validateWith: f.org });
        expect([...f.test.db.MmrHistory.iter()]).toHaveLength(0);
        complete(f);

        tick(f.test, f.id); // 3 records ≤ K
        const history = historyOf(f.test, f.id);
        expect(history).toHaveLength(3);
        const mmr = [...f.test.db.MmrHistory.iter()];
        expect(mmr).toHaveLength(12); // 4 participants × 3 matches
        expect(new Set(mmr.map((x) => x.matchHistoryId))).toEqual(new Set(history.map((h) => h.id)));
        expect(mmr.every((x) => x.matchHistoryId !== 0)).toBe(true);
        expect([...f.test.db.Leaderboard.iter()]).toHaveLength(0); // not rebuilt per record

        tick(f.test, f.id);
        expect(tRow(f.test, f.id).finalizedAt).toBeDefined();
        const board = [...f.test.db.Leaderboard.iter()];
        expect(board.length).toBeGreaterThan(0); // the finalists played 2 matches (MIN_MATCHES)
        expect(board.every((b) => b.matchesPlayed >= 2)).toBe(true);
    });

    it('a non-MMR tournament never writes MMR or rebuilds the leaderboard', () => {
        const f = liveField(2, BO1);
        seedElo(f.test);
        playMatch(f, byKey(f.test, f.id, 'W-R1-M1').id, 'Blue');
        complete(f);
        drain(f.test, f.id);
        expect(historyOf(f.test, f.id)).toHaveLength(1);
        expect([...f.test.db.MmrHistory.iter()]).toHaveLength(0);
        expect([...f.test.db.MmrRating.iter()]).toHaveLength(0);
    });

    // S11a (L11): the module guard (ensureScheduler, ctx.senderAuth.isInternal) refuses a caller that is not the
    // scheduler; the harness's scheduler is TestAuth.internal() (the `tick` fixture).
    it('a non-scheduler caller of run_tournament_finalize is refused and changes nothing (S11a, L11)', () => {
        const f = liveField(4, BO1);
        resolveAll(f.test, f.org, f.id);
        complete(f);
        const [row] = jobsOf(f.test, f.id);
        const state = () => snap([...f.test.db.TournamentFinalizeJob.iter()], [...f.test.db.MatchResultRecord.iter()],
            [...f.test.db.MatchSessionHistory.iter()], tRow(f.test, f.id));
        const before = state();
        for (const who of [f.org, admin(f.test)]) {
            expectReject(f.test, who, (ctx) => M.run_tournament_finalize(ctx, { arg: row }),
                'Forbidden: run_tournament_finalize is a scheduled reducer and runs only from the scheduler.');
        }
        expect(state()).toBe(before);
        tick(f.test, f.id); // the scheduler path still runs
        expect(tRow(f.test, f.id).finalizedAt).toBeDefined();
    });
});

// ─── Cancelled (A24(5)) ───────────────────────────────────────────────────────

describe('Cancelled: the same job, stats counted, MMR skipped (A24(5))', () => {
    it('live lobbies voided, unfinished records Voided then deleted; the parked Validated record finalized without MMR', () => {
        const f = liveField(4, { ...BO1, countTowardsMmr: true });
        seedElo(f.test);
        const m1 = byKey(f.test, f.id, 'W-R1-M1');
        const m2 = byKey(f.test, f.id, 'W-R1-M2');
        const done = playMatch(f, m1.id, 'Blue');
        validate(f.test, f.org, done.lobbyId);
        const live = openMatchLobby(f, m2.id); // Drafting
        const [liveRecord] = recordsOfLobby(f.test, live.lobbyId);

        advanceStage(f.test, f.org, f.id, 'Cancelled');
        expect(tRow(f.test, f.id).stage.tag).toBe('Cancelled');
        expect(f.test.db.Lobby.id.find(live.lobbyId)).toBeFalsy();
        expect(f.test.db.MatchResultRecord.id.find(liveRecord.id)!.status.tag).toBe('Voided');
        expect(lobbyRow(f.test, done.lobbyId).stage.tag).toBe('AwaitingResult'); // parked Validated: kept for the job
        expect(jobsOf(f.test, f.id)).toHaveLength(1);
        expect(tRow(f.test, f.id).finalizationStartedAt).toBeDefined();

        drain(f.test, f.id);
        const history = historyOf(f.test, f.id);
        expect(history).toHaveLength(1);
        expect(history[0].bracketMatchId).toBe(m1.id);
        expect([...f.test.db.MmrHistory.iter()]).toHaveLength(0);
        expect([...f.test.db.MmrRating.iter()]).toHaveLength(0);
        expect([...f.test.db.PlayerStat.iter()].length).toBeGreaterThan(0); // stats counted
        expect([...f.test.db.MatchResultRecord.iter()]).toHaveLength(0);
        expect(tRow(f.test, f.id).finalizedAt).toBeDefined();
        expect(matchRow(f.test, m1.id).state.tag).toBe('Decided'); // the bracket is kept (S8d interpretation 2)
    });

    // server_nuke_test_data clears TournamentFinalizeJob (reducers/server.ts), but requireTestDatabase reads ctx.env,
    // which the 2.14.1 harness cannot set (harness.smoke (f)): not testable in-memory.
    it.todo('server_nuke_test_data clears TournamentFinalizeJob (needs module env STDB_TARGET; live residue)');
});

// ─── S8d review fixes ─────────────────────────────────────────────────────────

const restart = (test: Harness, who: Actor | 'internal', tournamentId: number) =>
    tx(test, who, (ctx) => M.admin_restart_tournament_finalize(ctx, { tournamentId }));

describe('admin_restart_tournament_finalize (S8d review, A24(7), D.8.1)', () => {
    it('guards: Moderator+, unknown id, non-terminal stage, job still scheduled, already finalized', () => {
        const f = liveField(2, BO1);
        playMatch(f, byKey(f.test, f.id, 'W-R1-M1').id, 'Blue');
        expectReject(f.test, 'internal', (ctx) => M.admin_restart_tournament_finalize(ctx, { tournamentId: 99999 }), 'Tournament not found.');
        expectReject(f.test, 'internal', (ctx) => M.admin_restart_tournament_finalize(ctx, { tournamentId: f.id }),
            'Only a Completed or Cancelled tournament is finalized.');
        complete(f);
        expectReject(f.test, f.org, (ctx) => M.admin_restart_tournament_finalize(ctx, { tournamentId: f.id }), /Moderator/i);
        expectReject(f.test, 'internal', (ctx) => M.admin_restart_tournament_finalize(ctx, { tournamentId: f.id }),
            'The finalize job of this tournament is still scheduled.');
        drain(f.test, f.id);
        expectReject(f.test, 'internal', (ctx) => M.admin_restart_tournament_finalize(ctx, { tournamentId: f.id }),
            'This tournament is already finalized.');
        expect(jobsOf(f.test, f.id)).toHaveLength(0);
    });

    it('a tick that throws loses the job (the rollback takes the reschedule row too); the restart brings it back at cursor 0', () => {
        const g = liveField(4, BO1);
        playAll(g);
        // Direct row edit: the record of W-R1-M2 (second in bracket order) loses its winner, so its finalization throws.
        const brokenMatch = byKey(g.test, g.id, 'W-R1-M2');
        const broken = [...g.test.db.MatchResultRecord.bracket_match_id.filter(brokenMatch.id)][0];
        g.test.db.MatchResultRecord.id.update({ ...broken, winnerTeamSide: undefined });
        complete(g);

        const [row] = jobsOf(g.test, g.id);
        g.test.db.TournamentFinalizeJob.scheduledId.delete(row.scheduledId); // the scheduler consumed the row
        expect(() => tx(g.test, 'internal', (ctx) => M.run_tournament_finalize(ctx, { arg: row }))).toThrow(/without a winner/);
        expect(jobsOf(g.test, g.id)).toHaveLength(0); // the job stopped for good
        expect(historyOf(g.test, g.id)).toHaveLength(0); // the whole tick rolled back (W-R1-M1 included)
        expect(tRow(g.test, g.id).finalizedAt).toBeUndefined();

        // Staff repair the input (direct row edit), then restart.
        g.test.db.MatchResultRecord.id.update({ ...g.test.db.MatchResultRecord.id.find(broken.id)!, winnerTeamSide: { tag: 'Blue' } as any });
        restart(g.test, 'internal', g.id);
        const jobs = jobsOf(g.test, g.id);
        expect(jobs).toHaveLength(1);
        expect(jobs[0].tournamentId).toBe(g.id); // S11a (L84): no progress cursor
        drain(g.test, g.id);
        expect(historyOf(g.test, g.id)).toHaveLength(3);
        expect(tRow(g.test, g.id).finalizedAt).toBeDefined();
        expect([...g.test.db.MatchResultRecord.iter()]).toHaveLength(0);
    });

    it('restart after a partial run: cursor 0 resumes at the first surviving record, nothing finalized twice', () => {
        const f = liveField(8, BO1);
        playAll(f);
        complete(f);
        tick(f.test, f.id); // 4 of 7 finalized
        for (const r of jobsOf(f.test, f.id)) f.test.db.TournamentFinalizeJob.scheduledId.delete(r.scheduledId); // row lost
        restart(f.test, 'internal', f.id);
        drain(f.test, f.id);
        expect(historyOf(f.test, f.id)).toHaveLength(7);
        expect(new Set(historyOf(f.test, f.id).map((h) => h.bracketMatchId)).size).toBe(7);
    });
});

describe('placements with a walkover final (S8d review)', () => {
    it("a final settled by Walkover (finalist DQ'd while it was Pending) still places the champion; the DQ'd team has none", () => {
        const f = liveField(4, BO1);
        const m1 = byKey(f.test, f.id, 'W-R1-M1');
        const m2 = byKey(f.test, f.id, 'W-R1-M2');
        const final = byKey(f.test, f.id, 'W-R2-M1');
        resolveMatch(f.test, f.org, m1.id, m1.team1Id!);
        expect(matchRow(f.test, final.id).state.tag).toBe('Pending');
        const dqTeam = f.ts.find((t) => t.teamId === m1.team1Id)!;
        tx(f.test, f.org, (ctx) => M.dq_participant(ctx, { tournamentId: f.id, userId: dqTeam.captain.userId, reason: 't', dqWholeTeam: true }));
        resolveMatch(f.test, f.org, m2.id, m2.team2Id!);
        const settled = matchRow(f.test, final.id);
        expect(settled.state.tag).toBe('Walkover');
        expect(settled.winnerTeamId).toBe(m2.team2Id);
        complete(f);
        expect(placement(f.test, m2.team2Id)).toBe(1);
        expect(teamRow(f.test, dqTeam.teamId)!.finalPlacement).toBeUndefined();
        expect(teams(f.test, f.id).filter((t) => t.finalPlacement === 1)).toHaveLength(1);
    });
});

describe('leaderboard: rebuilt only for a Completed MMR tournament (S8d review, A24(5))', () => {
    it('a Cancelled MMR tournament finalizes without a rebuild (a seeded rating stays off the board)', () => {
        const f = liveField(2, { ...BO1, countTowardsMmr: true });
        seedElo(f.test);
        const s = playMatch(f, byKey(f.test, f.id, 'W-R1-M1').id, 'Blue');
        validate(f.test, f.org, s.lobbyId);
        // A rating any rebuild would list (matchesPlayed >= 2, season 0).
        const ts = f.test.clock.now();
        f.test.db.MmrRating.insert({
            userId: f.ts[0].captain.userId, gameMode: { tag: 'MemoryOfChaos' } as any, rating: 1200, matchesPlayed: 5,
            globalCompositeRating: undefined, seasonId: 0, createdById: 0, createdDate: ts, lastModifiedById: 0, lastModifiedDate: ts,
        });
        advanceStage(f.test, f.org, f.id, 'Cancelled');
        drain(f.test, f.id);
        expect(tRow(f.test, f.id).finalizedAt).toBeDefined();
        expect(historyOf(f.test, f.id)).toHaveLength(1);
        expect([...f.test.db.Leaderboard.iter()]).toHaveLength(0);
        expect([...f.test.db.MmrHistory.iter()]).toHaveLength(0);
    });
});

describe('Cancelled cascade (S8d interpretation 2, A24(5))', () => {
    it('keeps bracket, teams, members and assistants; voids every lobby except parked Validated ones', () => {
        const f = liveField(8, { ...BO1, requireResultValidation: true });
        const asst = verified(f.test, 'asst');
        assignAssistant(f.test, f.org, f.id, asst, { results: true });
        const [m1, m2, m3] = ['W-R1-M1', 'W-R1-M2', 'W-R1-M3'].map((k) => byKey(f.test, f.id, k));
        const validated = playMatch(f, m1.id, 'Blue');
        validate(f.test, asst, validated.lobbyId);
        const submitted = playMatch(f, m2.id, 'Red'); // parked, Submitted
        const live = openMatchLobby(f, m3.id); // Drafting
        const subRec = recordsOfLobby(f.test, submitted.lobbyId)[0];
        const memberCount = () => teams(f.test, f.id).flatMap((t) => [...f.test.db.TournamentTeamMember.team_id.filter(t.id)]).length;
        const before = { bracket: bracketRows(f.test, f.id).length, teams: teams(f.test, f.id).length, members: memberCount() };

        advanceStage(f.test, f.org, f.id, 'Cancelled');
        expect(bracketRows(f.test, f.id)).toHaveLength(before.bracket);
        expect(teams(f.test, f.id)).toHaveLength(before.teams);
        expect(memberCount()).toBe(before.members);
        expect([...f.test.db.TournamentAssistant.tournament_id.filter(f.id)]).toHaveLength(1);
        expect(lobbyRow(f.test, validated.lobbyId).stage.tag).toBe('AwaitingResult');
        expect(f.test.db.Lobby.id.find(submitted.lobbyId)).toBeFalsy();
        expect(f.test.db.Lobby.id.find(live.lobbyId)).toBeFalsy();
        expect(f.test.db.MatchResultRecord.id.find(subRec.id)!.status.tag).toBe('Voided');

        drain(f.test, f.id);
        expect(historyOf(f.test, f.id).map((h) => h.bracketMatchId)).toEqual([m1.id]);
    });
});
