// ─── Game close and game submission (A60, A63, A67(3); S7b, S8e) ─────────────────────────────────────────
// closeGame, submitGameResult and the Admin-edit recompute. Kept out of scoringHelpers because they call
// runFinalization: finalizationHelpers already imports scoringHelpers, and a back-import would close a cycle.
// A67: a lobby hosts one game; the close of the game submits it (no series tally inside a match: the bracket match
// is the only series, helpers/bracketResults.ts).

import { SenderError } from 'spacetimedb/server';
import { insertWithAudit, updateWithAudit } from './auditHelpers';
import { runFinalization } from './finalizationHelpers';
import { getNextSequence } from './stepSequence';
import { handOffToBracket } from './tournamentResults';
import {
    findGame,
    isClosedGame,
    isUnresolvedTie,
    postSystemChat,
    recomputeGame,
    replaceGame,
    teamSideValue,
    type TeamTag,
} from './scoringHelpers';

/**
 * A60(3)/(4), A63: closes the lobby's game. Called only by close_game, the explicit submit (A63(2)): the
 * confirmations are the captains' ready flags and never close a game by themselves. Sets closedAt / closedById and
 * both confirmation flags; with a staff override (only on a level-4 tie; the caller checks the authority) the game's
 * winner becomes the override (tieBreakLevel stays 4) and MatchResultRecord.winnerOverride* records it
 * (runFinalization copies it to MatchSessionHistory, A60(6)). Then the ConfirmGame step is logged (closed: true;
 * actorSlot = confirmedSide = closedBy.actorSlot: the closer's team side for a captain or a seated referee,
 * Spectator otherwise, A63(5)) and, A67(3), the close submits the game (submitGameResult). A level-4 tie without an
 * override is rejected.
 */
export function closeGame(
    ctx: any,
    lobby: any,
    record: any,
    game: any,
    closedBy: { userId: number; actorSlot: 'Blue' | 'Red' | 'Spectator' },
    override?: { side: TeamTag; reason?: string },
): void {
    if (isUnresolvedTie(game) && !override) {
        throw new SenderError('The game is tied after every tie-break: staff closes the game with winnerOverride.');
    }
    const actorId = closedBy.userId;
    replaceGame(ctx, game, {
        closedAt: ctx.timestamp,
        closedById: actorId,
        blueConfirmed: true,
        redConfirmed: true,
        ...(override ? { winnerTeamSide: teamSideValue(override.side) } : {}),
    }, actorId);
    if (override) {
        ctx.db.MatchResultRecord.id.update(updateWithAudit(ctx, ctx.db.MatchResultRecord.id.find(record.id), {
            winnerOverride: teamSideValue(override.side),
            winnerOverrideById: actorId,
            winnerOverrideReason: override.reason,
        }, actorId));
    }

    ctx.db.MatchSessionStep.insert(insertWithAudit(ctx, {
        id: 0, // autoInc
        lobbyId: lobby.id,
        sequence: getNextSequence(ctx, lobby.id),
        actorUserId: actorId,
        anonymousLabel: undefined,
        actorSlot: teamSideValue(closedBy.actorSlot),
        action: { tag: 'ConfirmGame', value: {} } as any,
        payload: {
            tag: 'ConfirmGame',
            value: {
                confirmedSide: teamSideValue(closedBy.actorSlot),
                closed: true,
                winnerOverride: override ? teamSideValue(override.side) : undefined,
                winnerOverrideReason: override?.reason,
            },
        } as any,
        timestamp: ctx.timestamp,
    }, actorId));

    console.log(`[MATCH] Game of match result #${record.id} closed by user #${actorId}${override ? ` (override ${override.side})` : ''}`);

    submitGameResult(ctx, ctx.db.MatchResultRecord.id.find(record.id), ctx.db.Lobby.id.find(lobby.id), actorId);
}

/** The winner of a closed game (Blue / Red; a level-4 tie closed with an override carries the override). */
function closedGameWinner(game: any): TeamTag {
    const tag = game.winnerTeamSide?.tag;
    if (tag !== 'Blue' && tag !== 'Red') throw new SenderError('The game has no winner.');
    return tag;
}

/**
 * A60(6), A67(3): the game submission, run by the close of the game (the body of the removed submit_match_result
 * reducer, without its confirmation check and override arguments). The record's game must be closed with a
 * complete result (defensive); the record's winnerTeamSide is the game's winner (ties: the A60 / A63 staff override,
 * already on the game row). Casual → Validated and runFinalization inline (D-04 / D-37); otherwise Submitted (staff
 * backlog: force-finalize). refereeUserId = the closer. The lobby moves to AwaitingResult with the system chat line.
 * Tournament records (A24(1)(2)(4), A36, S8d): Submitted when the tournament has requireResultValidation (forced on
 * for countTowardsMmr; staff validate with validate_match_result), otherwise Validated with settledAt and the
 * bracket hand-off (handOffToBracket: the game counts toward the bracket match's derived tally, A67(4)); never
 * finalized here: the lobby parks in AwaitingResult until the tournament's Completed / Cancelled finalize job
 * (casual tournament matches validate but do not finalize, A24(4)).
 */
export function submitGameResult(ctx: any, record: any, lobby: any, actorId: number): void {
    const game = findGame(ctx, record.id);
    if (!game) throw new SenderError('No game scores have been recorded.');
    if (!isClosedGame(game) || game.tieBreakLevel === undefined) throw new SenderError('The game is not closed.');
    const winnerTeamSide = closedGameWinner(game);
    const isTournament = record.isTournamentControlled && record.bracketMatchId !== undefined;
    const tournament = isTournament && lobby?.tournamentId !== undefined ? ctx.db.Tournament.id.find(lobby.tournamentId) : undefined;
    // A36: a tournament's own validation gate decides; a casual standalone match validates at once.
    const validates = isTournament ? !(tournament?.requireResultValidation ?? true) : record.matchType.tag === 'Casual';
    const isCasual = validates && !isTournament; // finalized inline below

    ctx.db.MatchResultRecord.id.update(updateWithAudit(ctx, record, {
        status: (validates ? { tag: 'Validated', value: {} } : { tag: 'Submitted', value: {} }) as any,
        winnerTeamSide: teamSideValue(winnerTeamSide),
        matchEndReason: { tag: 'Completed', value: {} } as any,
        refereeUserId: actorId,
        ...(validates ? { settledAt: ctx.timestamp } : {}),
    }, actorId));

    if (lobby && lobby.stage.tag !== 'AwaitingResult') {
        ctx.db.Lobby.id.update(updateWithAudit(ctx, lobby, {
            stage: { tag: 'AwaitingResult', value: {} } as any,
            lastActivityAt: ctx.timestamp,
        }, actorId));
        postSystemChat(ctx, lobby.id, 'Match complete. Stage: AwaitingResult', actorId);
    }

    console.log(`[MATCH] Match result #${record.id} ${validates ? 'Validated (auto)' : 'Submitted'} by the close of user #${actorId}, winnerTeamSide: ${winnerTeamSide}`);

    // A24(1): a validated tournament result advances the bracket now; the record parks with the lobby (A24(2)).
    if (isTournament && validates) handOffToBracket(ctx, ctx.db.MatchResultRecord.id.find(record.id), 'Played');
    // Auto-finalize casual standalone matches inline (per D-37); never a tournament record (A24(4)).
    if (isCasual) runFinalization(ctx, ctx.db.MatchResultRecord.id.find(record.id), actorId);
}

/**
 * A60(7), A67(3), A69(2)/(3): after an Admin's edit of the record's closed game (see ensureOpenGame; the record is
 * Submitted: the close always submits, and a validated record is no longer editable).
 * Recomputes the game; a game that ends up a level-4 tie rejects the whole edit, unless it was already a tie closed
 * with a staff override, whose decision is kept (S7b interpretation: the override is part of the closed game). The
 * record's winnerTeamSide then follows the game's winner.
 */
export function recomputeAfterAdminEdit(ctx: any, lobby: any, record: any, actorId: number): void {
    const session = ctx.db.MatchSession.lobbyId.find(lobby.id);
    if (!session) throw new SenderError('Match session not found.');
    const before = findGame(ctx, record.id);
    const result = recomputeGame(ctx, record, lobby, actorId);
    if (!result) throw new SenderError('The edit would leave the game without a complete result.');
    const game = findGame(ctx, record.id);
    if (isUnresolvedTie(game)) {
        const overridden = before && isUnresolvedTie(before) && before.winnerTeamSide.tag !== 'Spectator';
        if (!overridden) throw new SenderError('The edit would leave the game tied; add an adjustment that decides it.');
        replaceGame(ctx, game, { winnerTeamSide: before.winnerTeamSide }, actorId);
    } else if (before && isUnresolvedTie(before) && before.winnerTeamSide.tag !== 'Spectator') {
        // The edit resolved a tie this game had closed with a staff override: the override no longer decides
        // anything, so clear it before runFinalization copies a stale one to MatchSessionHistory (A60(6)).
        ctx.db.MatchResultRecord.id.update(updateWithAudit(ctx, ctx.db.MatchResultRecord.id.find(record.id), {
            winnerOverride: undefined,
            winnerOverrideById: undefined,
            winnerOverrideReason: undefined,
        }, actorId));
    }

    const winner = closedGameWinner(findGame(ctx, record.id));
    if (record.winnerTeamSide?.tag !== winner) {
        ctx.db.MatchResultRecord.id.update(updateWithAudit(ctx, ctx.db.MatchResultRecord.id.find(record.id), {
            winnerTeamSide: teamSideValue(winner),
        }, actorId));
    }
}
