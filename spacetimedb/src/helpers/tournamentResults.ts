// ─── Tournament results: bracket hand-off, parked-lobby voiding, bracket order (S8d) ─────────────────────────────
// A24(1)(2)(3), A35, A38(1), A54, ACCESS-SECURITY-OPS §D.8.1 / §D.8.3. A tournament lobby's one MatchResultRecord
// (A54) is the durable input of the Completed / Cancelled finalization: a settled record parks with its lobby in
// AwaitingResult (A24(2)); a rolled-back or overruled one is marked Voided and its lobby hard-deleted (A24(3)).

import { SYSTEM_USER_ID } from './auditColumns';
import { updateWithAudit } from './auditHelpers';
import { applyBracketResult, seriesGames } from './bracketResults';
import { findLobbyResult } from './scoringHelpers';
import { hardDeleteLobby } from '../reducers/lobbyGc';

const unit = (tag: string) => ({ tag, value: {} }) as any;

/** A35: the bracket team a record's winning side stands for (Blue = team1, Red = team2), or undefined. */
export function recordWinnerTeamId(match: any, record: any): number | undefined {
    const side = record.winnerTeamSide?.tag;
    return side === 'Blue' ? match.team1Id : side === 'Red' ? match.team2Id : undefined;
}

/**
 * A24(1), A38(1): the settled-result hand-off, called when a tournament lobby's record becomes Validated (the deciding
 * close of a tournament without requireResultValidation, validate_match_result, override_match_result) or settles by
 * concede. Applies the record's winner to its bracket match through the single writer (decidedBy Played / Concede,
 * the series score of the session, A35 Blue = team1). Idempotent and quiet: only a Ready match of an InProgress
 * tournament is decided; a match already settled (staff resolve, DQ) is left as it is. Audit actor SYSTEM_USER_ID
 * (A37: the public BracketMatch row never carries a player's id). Nothing derived runs here (A24(4)).
 */
export function handOffToBracket(ctx: any, record: any, decidedBy: 'Played' | 'Concede'): void {
    if (!record.isTournamentControlled || record.bracketMatchId === undefined) return;
    const match = ctx.db.BracketMatch.id.find(record.bracketMatchId);
    if (!match || match.state.tag !== 'Ready') return;
    const tournament = ctx.db.Tournament.id.find(match.tournamentId);
    if (!tournament || tournament.stage.tag !== 'InProgress') return;
    const winnerTeamId = recordWinnerTeamId(match, record);
    if (winnerTeamId === undefined) return;
    const session = ctx.db.MatchSession.lobbyId.find(record.lobbyId);
    applyBracketResult(ctx, match.id, winnerTeamId, decidedBy,
        session ? seriesGames(session) : { team1: 0, team2: 0 }, SYSTEM_USER_ID);
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
 * Voids every lobby of a bracket match (Lobby.bracket_match_id), except a lobby whose record is Validated for
 * `keepWinnerTeamId` (a staff decision that agrees with the played result keeps it). Used by rollback_bracket_match
 * (keep nothing), resolve_bracket_match (keep the agreeing record) and the Cancelled transition.
 */
export function voidMatchLobbies(ctx: any, bracketMatchId: number, actorId: number, keepWinnerTeamId?: number): void {
    const match = ctx.db.BracketMatch.id.find(bracketMatchId);
    for (const lobby of [...ctx.db.Lobby.bracket_match_id.filter(bracketMatchId)]) {
        const record = findLobbyResult(ctx, lobby.id);
        const agrees = keepWinnerTeamId !== undefined && !!match && !!record
            && record.status.tag === 'Validated' && recordWinnerTeamId(match, record) === keepWinnerTeamId;
        if (!agrees) voidTournamentLobby(ctx, lobby.id, actorId);
    }
}

const SIDE_ORDER: Record<string, number> = { Group: 0, Winners: 1, Losers: 2, ThirdPlace: 3, GrandFinals: 4 };

/**
 * D.8.1: the tournament's surviving result records in bracket order: group matches first, then Winners, Losers,
 * third place, grand final, each by roundNumber then matchNumber (then id). Side before round keeps every team's own
 * matches in the order they were played (a team never returns from the losers bracket to the winners bracket, and
 * the grand final, numbered round 1, comes last), which is what the sequential MMR updates need.
 */
export function tournamentRecordsInBracketOrder(ctx: any, tournamentId: number): any[] {
    const matches = [...ctx.db.BracketMatch.tournament_id.filter(tournamentId)].sort((a: any, b: any) =>
        (SIDE_ORDER[a.bracketSide.tag] ?? 9) - (SIDE_ORDER[b.bracketSide.tag] ?? 9)
        || a.roundNumber - b.roundNumber
        || a.matchNumber - b.matchNumber
        || a.id - b.id);
    return matches.flatMap((m: any) =>
        [...ctx.db.MatchResultRecord.bracket_match_id.filter(m.id)].sort((a: any, b: any) => a.id - b.id));
}
