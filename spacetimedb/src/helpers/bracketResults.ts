// ─── Bracket results (A23, A24, A26, A35, review §5.5; S8a) ───────────────────────────────────────────────
// The single result → bracket hand-off and its inverse. S8c: the legacy writers are deleted; callers are
// resolve_bracket_match / rollback_bracket_match, dq_participant, performConcede and the finalization step 17.

import { SenderError } from 'spacetimedb/server';
import { updateWithAudit } from './auditHelpers';
import { placeEntrant, settle, slotEntrant, type BracketSlot, type Entrant } from './bracketStore';

export type BracketDecisionTag = 'Played' | 'Concede' | 'Dq' | 'Staff';
export interface SeriesGames { team1: number; team2: number }

const tag = (t: string) => ({ tag: t, value: {} }) as any;

function ensureGames(games: SeriesGames): void {
    for (const g of [games.team1, games.team2]) {
        if (!Number.isInteger(g) || g < 0 || g > 255) throw new SenderError('Series games must be integers 0..255.');
    }
}

function setTeamStatus(ctx: any, teamId: number, from: string, to: string, actorId: number): void {
    const team = ctx.db.TournamentTeam.id.find(teamId);
    if (team && team.status.tag === from) {
        ctx.db.TournamentTeam.id.update(updateWithAudit(ctx, team, { status: tag(to) }, actorId));
    }
}

/**
 * Records a settled result on a bracket match. **This is the only writer of `BracketMatch.winnerTeamId`**
 * (every other writer was deleted in S8c; `settle` only stamps structural BYE walkovers).
 *
 * - The match must hold two real teams and `winnerTeamId` must be one of them; team1 = Blue, team2 = Red (A35).
 * - Ready → Decided. Decided with the same winner → no-op (idempotent); a different winner → "roll back first"
 *   (A24(3)). Any other state is refused.
 * - Sets winner, loser, `decidedBy`, the series score (`games`, A30 game differential), routes the winner and
 *   the loser into their exact next slots, marks the loser `Eliminated` when it has no loser route (A26; never
 *   for group matches, whose standings decide advancement), then settles BYEs. Placing the champion is the
 *   Completed transition's job (S8d).
 */
export function applyBracketResult(
    ctx: any,
    bracketMatchId: number,
    winnerTeamId: number,
    decidedBy: BracketDecisionTag,
    games: SeriesGames,
    actorId: number,
): void {
    const row = ctx.db.BracketMatch.id.find(bracketMatchId);
    if (!row) throw new SenderError(`Bracket match ${bracketMatchId} not found.`);
    const a = slotEntrant(row, 1);
    const b = slotEntrant(row, 2);
    if (typeof a !== 'number' || typeof b !== 'number') throw new SenderError(`${row.positionKey} does not hold two teams.`);
    if (winnerTeamId !== a && winnerTeamId !== b) throw new SenderError(`Team ${winnerTeamId} does not play ${row.positionKey}.`);
    if (row.state.tag === 'Decided') {
        if (row.winnerTeamId === winnerTeamId) return;
        throw new SenderError(`${row.positionKey} is already decided; roll back first.`);
    }
    if (row.state.tag !== 'Ready') throw new SenderError(`${row.positionKey} is ${row.state.tag}, not Ready.`);
    ensureGames(games);
    const loserTeamId = winnerTeamId === a ? b : a;
    ctx.db.BracketMatch.id.update(updateWithAudit(ctx, row, {
        state: tag('Decided'),
        winnerTeamId,
        loserTeamId,
        decidedBy: tag(decidedBy),
        team1Games: games.team1,
        team2Games: games.team2,
    }, actorId));
    if (row.nextWinnerMatchId !== undefined) placeEntrant(ctx, row.nextWinnerMatchId, row.nextWinnerSlot, winnerTeamId, actorId);
    if (row.nextLoserMatchId !== undefined) placeEntrant(ctx, row.nextLoserMatchId, row.nextLoserSlot, loserTeamId, actorId);
    else if (row.bracketSide.tag !== 'Group') setTeamStatus(ctx, loserTeamId, 'Active', 'Eliminated', actorId);
    settle(ctx, row.tournamentId, actorId);
}

/**
 * Removes `expected` from a downstream slot. A downstream Decided match refuses ("roll that back first"); a
 * downstream Walkover / Void (settled because the other slot is a BYE) is unwound first, recursively, so it
 * returns to Pending and re-settles when the slot is filled again.
 */
function unplaceEntrant(ctx: any, matchId: number, slot: BracketSlot, expected: Entrant, actorId: number): void {
    const row = ctx.db.BracketMatch.id.find(matchId);
    if (!row) return;
    if (slotEntrant(row, slot) !== expected) {
        throw new SenderError(`${row.positionKey} slot ${slot} does not hold ${expected}.`);
    }
    if (row.state.tag === 'Decided') throw new SenderError(`${row.positionKey} is decided; roll that back first.`);
    if (row.state.tag === 'Walkover' || row.state.tag === 'Void') {
        const winner: Entrant = row.state.tag === 'Walkover' ? row.winnerTeamId : 'BYE';
        if (row.nextWinnerMatchId !== undefined) unplaceEntrant(ctx, row.nextWinnerMatchId, row.nextWinnerSlot, winner, actorId);
        if (row.nextLoserMatchId !== undefined) unplaceEntrant(ctx, row.nextLoserMatchId, row.nextLoserSlot, 'BYE', actorId);
    }
    const fresh = ctx.db.BracketMatch.id.find(matchId);
    ctx.db.BracketMatch.id.update(updateWithAudit(ctx, fresh, {
        ...(slot === 1 ? { team1Id: undefined, team1IsBye: false } : { team2Id: undefined, team2IsBye: false }),
        state: tag('Pending'),
        winnerTeamId: undefined,
        loserTeamId: undefined,
    }, actorId));
}

/**
 * The inverse of `applyBracketResult` (A24(3)): refuses when the winner's or the loser's destination is Decided
 * ("roll that back first"); takes this match's winner and loser out of the downstream slots (those go back to
 * Pending, unwinding any walkover they had settled into), clears winner / loser / `decidedBy`, resets the games
 * to 0-0, returns the match to Ready and un-eliminates the loser (Eliminated → Active). Does not touch
 * `MatchResultRecord` or lobbies (the S8c / S8d reducers do).
 */
export function rollbackBracketResult(ctx: any, bracketMatchId: number, actorId: number): void {
    const row = ctx.db.BracketMatch.id.find(bracketMatchId);
    if (!row) throw new SenderError(`Bracket match ${bracketMatchId} not found.`);
    if (row.state.tag !== 'Decided') throw new SenderError(`${row.positionKey} is ${row.state.tag}; only a decided match can be rolled back.`);
    if (row.nextWinnerMatchId !== undefined) unplaceEntrant(ctx, row.nextWinnerMatchId, row.nextWinnerSlot, row.winnerTeamId, actorId);
    if (row.nextLoserMatchId !== undefined) unplaceEntrant(ctx, row.nextLoserMatchId, row.nextLoserSlot, row.loserTeamId, actorId);
    else if (row.bracketSide.tag !== 'Group' && row.loserTeamId !== undefined) {
        setTeamStatus(ctx, row.loserTeamId, 'Eliminated', 'Active', actorId);
    }
    const fresh = ctx.db.BracketMatch.id.find(bracketMatchId);
    ctx.db.BracketMatch.id.update(updateWithAudit(ctx, fresh, {
        state: tag('Ready'),
        winnerTeamId: undefined,
        loserTeamId: undefined,
        decidedBy: undefined,
        team1Games: 0,
        team2Games: 0,
    }, actorId));
}

/** The series score to store from a `MatchSession` (A35: Blue = team1, Red = team2). */
export function seriesGames(session: any): SeriesGames {
    return { team1: session.gamesWonBlue, team2: session.gamesWonRed };
}
