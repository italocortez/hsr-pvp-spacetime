// ─── Game close and series submission (A60, S7b) ─────────────────────────────────────────────────────────
// closeGame, submitSeriesResult and the Admin-edit series recompute. Kept out of scoringHelpers because they call
// runFinalization: finalizationHelpers already imports scoringHelpers, and a back-import would close a cycle.

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
    seriesTally,
    teamSideValue,
    type TeamTag,
} from './scoringHelpers';

function writeTally(ctx: any, lobbyId: number, tally: { blue: number; red: number }, actorId: number): void {
    const session = ctx.db.MatchSession.lobbyId.find(lobbyId);
    if (!session || (session.gamesWonBlue === tally.blue && session.gamesWonRed === tally.red)) return;
    ctx.db.MatchSession.lobbyId.update(updateWithAudit(ctx, session, { gamesWonBlue: tally.blue, gamesWonRed: tally.red }, actorId));
}

/**
 * A60(3)/(4), A63: closes a game. Called only by close_game, the explicit submit (A63(2)): the confirmations are the
 * captains' ready flags and never close a game by themselves. Sets closedAt / closedById and both confirmation flags; with a staff override (only
 * on a level-4 tie; the caller checks the authority) the game's winner becomes the override (tieBreakLevel stays 4)
 * and MatchResultRecord.winnerOverride* records it (the latest one; runFinalization copies it to
 * MatchSessionHistory, A60(6)). Then the series tally (closed games + A27 head start) goes to MatchSession, the
 * ConfirmGame step is logged (closed: true; actorSlot = confirmedSide = closedBy.actorSlot: the closer's team side for a
 * captain or a seated referee, Spectator otherwise, A63(5)), and either the lobby
 * moves to BetweenGames or, when the series is decided, submitSeriesResult runs. A level-4 tie without an override
 * is rejected.
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
        throw new SenderError(`Game ${game.gameNumber} is tied after every tie-break: staff closes the game with winnerOverride.`);
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

    const session = ctx.db.MatchSession.lobbyId.find(lobby.id);
    const tally = seriesTally(ctx, record, lobby, session?.seriesBestOf ?? 1);
    writeTally(ctx, lobby.id, tally, actorId);

    ctx.db.MatchSessionStep.insert(insertWithAudit(ctx, {
        id: 0, // autoInc
        lobbyId: lobby.id,
        gameNumber: game.gameNumber,
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

    console.log(`[MATCH] Game ${game.gameNumber} of match result #${record.id} closed by user #${actorId}${override ? ` (override ${override.side})` : ''}; series ${tally.blue}-${tally.red}`);

    if (tally.decided) {
        submitSeriesResult(ctx, ctx.db.MatchResultRecord.id.find(record.id), ctx.db.Lobby.id.find(lobby.id), actorId);
        return;
    }
    const freshLobby = ctx.db.Lobby.id.find(lobby.id);
    ctx.db.Lobby.id.update(updateWithAudit(ctx, freshLobby, {
        stage: { tag: 'BetweenGames', value: {} } as any,
        lastActivityAt: ctx.timestamp,
    }, actorId));
    postSystemChat(ctx, lobby.id, `Game ${game.gameNumber} complete (${tally.blue}-${tally.red}). Stage: BetweenGames`, actorId);
}

/**
 * A60(6): the automatic series submission, run by the close of the deciding game (the body of the removed
 * submit_match_result reducer, without its confirmation check and override arguments). Every game of the record must
 * be closed with a complete result (defensive); series winner = closed-game wins + the A27 head start (a level
 * series is rejected, which closeGame cannot produce). Casual → Validated and runFinalization inline (D-04 / D-37);
 * otherwise Submitted (staff backlog: force-finalize). refereeUserId = the closer. The lobby moves to AwaitingResult
 * with the system chat line.
 * Tournament records (A24(1)(2)(4), A36, S8d): Submitted when the tournament has requireResultValidation (forced on
 * for countTowardsMmr; staff validate with validate_match_result), otherwise Validated with settledAt and the
 * bracket hand-off (handOffToBracket); never finalized here: the lobby parks in AwaitingResult until the tournament's
 * Completed / Cancelled finalize job (casual tournament matches validate but do not finalize, A24(4)).
 */
export function submitSeriesResult(ctx: any, record: any, lobby: any, actorId: number): void {
    const games = [...ctx.db.MatchResultGame.match_result_id.filter(record.id)]
        .sort((a: any, b: any) => a.gameNumber - b.gameNumber);
    if (games.length === 0) throw new SenderError('No game scores have been recorded.');
    const unfinished = games.find((g: any) => !isClosedGame(g) || g.tieBreakLevel === undefined);
    if (unfinished) throw new SenderError(`Game ${unfinished.gameNumber} is not closed.`);

    const session = ctx.db.MatchSession.lobbyId.find(record.lobbyId);
    const tally = seriesTally(ctx, record, lobby, session?.seriesBestOf ?? 1);
    if (tally.blue === tally.red) {
        throw new SenderError(`The series is level (${tally.blue}-${tally.red}): play the deciding game first.`);
    }
    const winnerTeamSide: TeamTag = tally.blue > tally.red ? 'Blue' : 'Red';
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

    if (lobby && lobby.stage.tag !== 'AwaitingResult' && lobby.stage.tag !== 'Finished') {
        ctx.db.Lobby.id.update(updateWithAudit(ctx, lobby, {
            stage: { tag: 'AwaitingResult', value: {} } as any,
            lastActivityAt: ctx.timestamp,
        }, actorId));
        postSystemChat(ctx, lobby.id, (session?.seriesBestOf ?? 1) > 1
            ? `Series complete (${tally.blue}-${tally.red}). Stage: AwaitingResult`
            : 'Match complete. Stage: AwaitingResult', actorId);
    }

    console.log(`[MATCH] Match result #${record.id} ${validates ? 'Validated (auto)' : 'Submitted'} by the close of user #${actorId}, winnerTeamSide: ${winnerTeamSide}`);

    // A24(1): a validated tournament result advances the bracket now; the record parks with the lobby (A24(2)).
    if (isTournament && validates) handOffToBracket(ctx, ctx.db.MatchResultRecord.id.find(record.id), 'Played');
    // Auto-finalize casual standalone matches inline (per D-37); never a tournament record (A24(4)).
    if (isCasual) runFinalization(ctx, ctx.db.MatchResultRecord.id.find(record.id), actorId);
}

/**
 * A60(7), A65(4): after an Admin's edit of a closed game (`gameNumber`: the current game or an earlier closed one; see
 * ensureOpenGame / ensureEditableGame). Recomputes that game; a game
 * that ends up a level-4 tie rejects the whole edit, unless it was already a tie closed with a staff override, whose
 * decision is kept (S7b interpretation: the override is part of the closed game). Then the tally (closed games +
 * A27 head start) is rewritten. A Submitted record keeps a decided series (its winnerTeamSide follows the tally);
 * an edit that leaves it undecided is rejected. A Pending record (closed game between games) whose series becomes
 * decided is submitted now, as the deciding close would have done.
 */
export function recomputeSeriesAfterAdminEdit(ctx: any, lobby: any, record: any, actorId: number, gameNumber: number): void {
    const session = ctx.db.MatchSession.lobbyId.find(lobby.id);
    if (!session) throw new SenderError('Match session not found.');
    const before = findGame(ctx, record.id, gameNumber);
    const result = recomputeGame(ctx, record, lobby, gameNumber, actorId);
    if (!result) throw new SenderError('The edit would leave the game without a complete result.');
    const game = findGame(ctx, record.id, gameNumber);
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

    const tally = seriesTally(ctx, record, lobby, session.seriesBestOf);
    if (record.status.tag === 'Submitted') {
        if (!tally.decided || tally.blue === tally.red) {
            throw new SenderError('The edit would undo the series result; void or force-finalize the match instead.');
        }
        writeTally(ctx, lobby.id, tally, actorId);
        const winner: TeamTag = tally.blue > tally.red ? 'Blue' : 'Red';
        if (record.winnerTeamSide?.tag !== winner) {
            ctx.db.MatchResultRecord.id.update(updateWithAudit(ctx, ctx.db.MatchResultRecord.id.find(record.id), {
                winnerTeamSide: teamSideValue(winner),
            }, actorId));
        }
        return;
    }
    writeTally(ctx, lobby.id, tally, actorId);
    if (tally.decided) {
        submitSeriesResult(ctx, ctx.db.MatchResultRecord.id.find(record.id), ctx.db.Lobby.id.find(lobby.id), actorId);
    }
}
