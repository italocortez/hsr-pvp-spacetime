// ─── Tournament results: bracket hand-off, parked-lobby voiding, bracket order (S8d) ─────────────────────────────
// A24(1)(2)(3), A35, A38(1), A54, ACCESS-SECURITY-OPS §D.8.1 / §D.8.3. A tournament lobby's one MatchResultRecord
// (A54) is the durable input of the Completed / Cancelled finalization: a settled record parks with its lobby in
// AwaitingResult (A24(2)); a rolled-back or overruled one is marked Voided and its lobby hard-deleted (A24(3)).

import { SYSTEM_USER_ID } from '@module/helpers/admin/auditColumns';
import { updateWithAudit } from '@module/helpers/admin/auditHelpers';
import { recordGameSettled } from './bracketResults';
import { findLobbyResult } from '@module/helpers/results/scoringHelpers';
import { sideTeamId } from './matchSides';
import { hardDeleteLobby } from '@module/reducers/lobby/lobbyGc';

const unit = (tag: string) => ({ tag, value: {} }) as any;

/** A35 / A70(1): the bracket team a record's winning side stands for under the match's colour mapping, or undefined. */
export function recordWinnerTeamId(match: any, record: any): number | undefined {
    return sideTeamId(match, record.winnerTeamSide?.tag);
}

/**
 * A24(1), A38(1), A67(4): the settled-result hand-off, called when a tournament lobby's record becomes Validated (the
 * close of the game in a tournament without requireResultValidation, validate_match_result) or settles by concede.
 * Hands the game to its bracket match through the single writer (recordGameSettled: the derived tally is rewritten
 * and the match is decided, decidedBy Played / Concede, when a side reaches ceil(bestOf / 2); colours by the match's mapping, A70(1)).
 * Idempotent and quiet: only a Ready match of an InProgress tournament counts the game; a match already settled
 * (staff resolve, DQ) is left as it is. Audit actor SYSTEM_USER_ID (A37: the public BracketMatch row never carries a
 * player's id). Nothing derived runs here (A24(4)).
 */
export function handOffToBracket(ctx: any, record: any, decidedBy: 'Played' | 'Concede'): void {
    if (!record.isTournamentControlled || record.bracketMatchId === undefined) return;
    const match = ctx.db.BracketMatch.id.find(record.bracketMatchId);
    if (!match || match.state.tag !== 'Ready') return;
    const tournament = ctx.db.Tournament.id.find(match.tournamentId);
    if (!tournament || tournament.stage.tag !== 'InProgress') return;
    if (recordWinnerTeamId(match, record) === undefined) return;
    recordGameSettled(ctx, record, decidedBy, SYSTEM_USER_ID);
}

/**
 * A24(3): marks the lobby's record Voided (kept for audit until the tournament's finalize job deletes it) and
 * hard-deletes the lobby with every other row of the match (participants, games, scoring rows, steps, session,
 * members), so a replay lobby can be created for the bracket match.
 */
export function voidTournamentLobby(ctx: any, lobbyId: number, actorId: number): void {
    const record = findLobbyResult(ctx, lobbyId);
    if (record && record.status.tag !== 'Voided') {
        ctx.db.MatchResultRecord.id.update(updateWithAudit(ctx, record, { status: unit('Voided') }, actorId));
    }
    hardDeleteLobby(ctx, lobbyId, true);
}

/**
 * A67(4)(8): voids every lobby of a bracket match (Lobby.bracket_match_id) that is not settled: a lobby without a
 * record or whose record is not Validated (Waiting or playing, or parked with a Pending / Submitted / Disputed
 * record). Settled lobbies (Validated record, parked in AwaitingResult) stay for the finalize job: every played game
 * of the match is kept. Used by resolve_bracket_match and rollback_bracket_match.
 */
export function voidMatchLobbies(ctx: any, bracketMatchId: number, actorId: number): void {
    for (const lobby of [...ctx.db.Lobby.bracket_match_id.filter(bracketMatchId)]) {
        const record = findLobbyResult(ctx, lobby.id);
        if (record?.status.tag !== 'Validated') voidTournamentLobby(ctx, lobby.id, actorId);
    }
}

const SIDE_ORDER: Record<string, number> = { Group: 0, Winners: 1, Losers: 2, ThirdPlace: 3, GrandFinals: 4 };

/**
 * D.8.1: the tournament's surviving result records in bracket order: group matches first, then Winners, Losers,
 * third place, grand final, each by roundNumber then matchNumber (then id). Side before round keeps every team's own
 * matches in the order they were played (a team never returns from the losers bracket to the winners bracket, and
 * the grand final, numbered round 1, comes last), which is what the sequential MMR updates need. A67(8): a bracket
 * match has one record per game (one lobby per game), ordered within the match by the record's creation time
 * (start_draft), id only as a tie-break (ids are not an ordering, CLAUDE.md §3.4).
 */
export function tournamentRecordsInBracketOrder(ctx: any, tournamentId: number): any[] {
    const matches = [...ctx.db.BracketMatch.tournament_id.filter(tournamentId)].sort((a: any, b: any) =>
        (SIDE_ORDER[a.bracketSide.tag] ?? 9) - (SIDE_ORDER[b.bracketSide.tag] ?? 9)
        || a.roundNumber - b.roundNumber
        || a.matchNumber - b.matchNumber
        || a.id - b.id);
    const created = (r: any) => r.createdDate.microsSinceUnixEpoch;
    return matches.flatMap((m: any) =>
        [...ctx.db.MatchResultRecord.bracket_match_id.filter(m.id)].sort((a: any, b: any) =>
            created(a) === created(b) ? a.id - b.id : created(a) < created(b) ? -1 : 1));
}
