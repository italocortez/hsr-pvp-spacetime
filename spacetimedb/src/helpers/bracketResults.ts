// ─── Bracket results (A23, A24, A26, A35, A67(4), review §5.5; S8a) ──────────────────────────────────────
// The single result → bracket hand-off and its inverse. S8c: the legacy writers are deleted; callers are
// resolve_bracket_match / rollback_bracket_match, dq_participant, override_match_result and handOffToBracket
// (game close, validate_match_result, performConcede).
// A67(4): the bracket match is the only series. team1Games / team2Games are the running tally, derived here (never
// incremented): head start (team1 gets winnerAdvantage, A27 / A71(1)) + the Validated
// records of the match won by each team under the match's colour mapping (A70(1), matchSides.ts).

import { SenderError } from 'spacetimedb/server';
import { updateWithAudit } from './auditHelpers';
import { placeEntrant, settle, slotEntrant, type BracketSlot, type Entrant } from './bracketStore';
import { winsNeededFor } from './seriesSettings';
import { sideSlot, slotChangeReset } from './matchSides';
import { hardDeleteLobby } from '../reducers/lobbyGc';

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
 * - The match must hold two real teams and `winnerTeamId` must be one of them (by slot; colours do not matter here:
 *   callers map a winning side to a team through matchSides.ts, A70(1)).
 * - Ready → Decided. Decided with the same winner → no-op (idempotent); a different winner → "roll back first"
 *   (A24(3)). Any other state is refused.
 * - Sets winner, loser, `decidedBy`, the tally (`games`, A30 game differential; A67(4): the derived tally), routes the winner and
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
        ...slotChangeReset(fresh), // A71(3): colours voided, tally back to the head start
        state: tag('Pending'),
        winnerTeamId: undefined,
        loserTeamId: undefined,
    }, actorId));
}

/**
 * The inverse of `applyBracketResult` (A24(3)): refuses when the winner's or the loser's destination is Decided
 * ("roll that back first"); takes this match's winner and loser out of the downstream slots (those go back to
 * Pending, unwinding any walkover they had settled into), clears winner / loser / `decidedBy`, returns the match
 * to Ready and un-eliminates the loser (Eliminated → Active).
 * A67(4): with `voidDeciding` (rollback_bracket_match) a match decided by play (Played / Concede) also voids its
 * deciding record only (voidDecidingRecord; earlier games stay); a staff or DQ decision has no deciding record, so
 * nothing is voided. resolve_bracket_match and override_match_result pass false (they keep every Validated game).
 * Then the tally is recomputed from the remaining Validated records (head start on team1, A71(1);
 * games credited through the match's colour mapping, A70(1)) and written.
 * A67(4) (S8e review): with `redecide` (rollback_bracket_match) a Ready match whose tally already gives a side
 * ceil(bestOf / 2) games is decided again as Played (e.g. 2-0 by play, then a staff resolve for the other team, then
 * a rollback: the games decide it). resolve and override pass false: they decide the match themselves right after.
 */
export function rollbackBracketResult(ctx: any, bracketMatchId: number, actorId: number, voidDeciding = true, redecide = true): void {
    const row = ctx.db.BracketMatch.id.find(bracketMatchId);
    if (!row) throw new SenderError(`Bracket match ${bracketMatchId} not found.`);
    if (row.state.tag !== 'Decided') throw new SenderError(`${row.positionKey} is ${row.state.tag}; only a decided match can be rolled back.`);
    if (row.nextWinnerMatchId !== undefined) unplaceEntrant(ctx, row.nextWinnerMatchId, row.nextWinnerSlot, row.winnerTeamId, actorId);
    if (row.nextLoserMatchId !== undefined) unplaceEntrant(ctx, row.nextLoserMatchId, row.nextLoserSlot, row.loserTeamId, actorId);
    else if (row.bracketSide.tag !== 'Group' && row.loserTeamId !== undefined) {
        setTeamStatus(ctx, row.loserTeamId, 'Eliminated', 'Active', actorId);
    }
    const byPlay = row.decidedBy?.tag === 'Played' || row.decidedBy?.tag === 'Concede';
    if (voidDeciding && byPlay) voidDecidingRecord(ctx, row, actorId);
    const fresh = ctx.db.BracketMatch.id.find(bracketMatchId);
    const games = matchGames(ctx, fresh);
    ensureGames(games);
    ctx.db.BracketMatch.id.update(updateWithAudit(ctx, fresh, {
        state: tag('Ready'),
        winnerTeamId: undefined,
        loserTeamId: undefined,
        decidedBy: undefined,
        team1Games: games.team1,
        team2Games: games.team2,
    }, actorId));
    if (!redecide) return;
    const need = winsNeededFor(fresh.bestOf);
    const winnerTeamId = games.team1 >= need ? fresh.team1Id : games.team2 >= need ? fresh.team2Id : undefined;
    if (winnerTeamId !== undefined) applyBracketResult(ctx, bracketMatchId, winnerTeamId, 'Played', games, actorId);
}


/**
 * A67(4), A27, A70(1), A71(1): the derived tally of a bracket match. team1 (slot 1, the WB finalist) starts at
 * winnerAdvantage whatever the colours, team2 at 0; each Validated record of the match adds one game to the team that played its
 * winnerTeamSide under the match's colour mapping (matchSides.ts). A record counts only when Validated (a concede is
 * Validated, A24(1)); Pending, Submitted, Disputed, Rejected and Voided records do not.
 */
export function matchGames(ctx: any, match: any): SeriesGames {
    const games = { team1: match.winnerAdvantage, team2: 0 }; // A71(1): head start on slot 1 (A27)
    const credit = (slot: number | undefined, n: number) => {
        if (slot === 1) games.team1 += n;
        else if (slot === 2) games.team2 += n;
    };
    for (const record of ctx.db.MatchResultRecord.bracket_match_id.filter(match.id)) {
        if (record.status.tag !== 'Validated') continue;
        credit(sideSlot(match, record.winnerTeamSide?.tag), 1);
    }
    return games;
}

/**
 * Writes the derived tally on the bracket match when it changed (any state); returns it. dq_participant calls it
 * after the force-concede of the DQ'd team's live lobby, so the stored tally equals the derived one (A67(4)).
 */
export function writeMatchGames(ctx: any, matchId: number, actorId: number): SeriesGames {
    const row = ctx.db.BracketMatch.id.find(matchId);
    const games = matchGames(ctx, row);
    ensureGames(games);
    if (row.team1Games !== games.team1 || row.team2Games !== games.team2) {
        ctx.db.BracketMatch.id.update(updateWithAudit(ctx, row, { team1Games: games.team1, team2Games: games.team2 }, actorId));
    }
    return games;
}

/**
 * A67(4): a game of the bracket match settled (its record became Validated by the close, validate_match_result, an
 * override, or a concede). Only a Ready match counts it: a match staff already settled (resolve, DQ) stays as it is.
 * Recomputes and writes the tally (matchGames: the record's winning colour is credited to the team playing it,
 * A70(1)); when a side reaches ceil(bestOf / 2) the match is decided for that side through
 * applyBracketResult with the tally (routing, A30, audit actor as given). A non-deciding game only updates the tally.
 */
export function recordGameSettled(ctx: any, record: any, decidedBy: BracketDecisionTag, actorId: number): void {
    if (record.bracketMatchId === undefined) return;
    const match = ctx.db.BracketMatch.id.find(record.bracketMatchId);
    if (!match || match.state.tag !== 'Ready') return;
    const games = writeMatchGames(ctx, match.id, actorId);
    const need = winsNeededFor(match.bestOf); // A67(4): ceil(BracketMatch.bestOf / 2), A28 chain
    const winnerTeamId = games.team1 >= need ? match.team1Id : games.team2 >= need ? match.team2Id : undefined;
    if (winnerTeamId === undefined) return;
    applyBracketResult(ctx, match.id, winnerTeamId, decidedBy, games, actorId);
}

/**
 * A67(4), A24(3): the deciding record of a match decided by play (decidedBy Played or Concede) = its latest
 * Validated record: the latest settledAt (the moment it became Validated), record id only as a tie-break (ids are
 * not an ordering, CLAUDE.md §3.4). It is marked Voided (kept for audit until the finalize job deletes it) and its
 * lobby is hard-deleted (keepResultRecord), so a replay lobby can be created. Earlier games stay Validated.
 */
function voidDecidingRecord(ctx: any, match: any, actorId: number): void {
    const at = (r: any) => r.settledAt?.microsSinceUnixEpoch ?? r.lastModifiedDate.microsSinceUnixEpoch;
    const deciding = [...ctx.db.MatchResultRecord.bracket_match_id.filter(match.id)]
        .filter((r: any) => r.status.tag === 'Validated')
        .sort((a: any, b: any) => (at(a) === at(b) ? b.id - a.id : at(a) < at(b) ? 1 : -1))[0];
    if (!deciding) return;
    ctx.db.MatchResultRecord.id.update(updateWithAudit(ctx, deciding, { status: tag('Voided') }, actorId));
    if (ctx.db.Lobby.id.find(deciding.lobbyId)) hardDeleteLobby(ctx, deciding.lobbyId, true);
}
