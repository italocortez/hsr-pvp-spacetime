import spacetimedb from '../schema';
import { t, SenderError } from 'spacetimedb/server';
import { getAuthenticatedUser } from '../helpers/ensurePermissions';
import { insertWithAudit, updateWithAudit } from '../helpers/auditHelpers';
import { ensureMatchAlive } from '../helpers/disconnectHelpers';
import { ensureStageIs, slotIsCoach, slotIsSpectator, slotTeam } from '../helpers/lobbyHelpers';
import { getNextSequence } from '../helpers/stepSequence';
import { closeGame } from '../helpers/gameClose';
import {
    ensureAuctionSurchargeFits,
    ensureResultAuthority,
    ensureTeamTag,
    findGame,
    findLineup,
    findPendingResult,
    isClosedGame,
    isUnresolvedTie,
    recomputeGame,
    replaceGame,
    teamSideValue,
    type TeamTag,
} from '../helpers/scoringHelpers';
import { TeamSide } from '../types/enums';

// A60 (S7b): games are confirmed and closed one at a time. confirm_match_scores (series-level flags) and
// submit_match_result (the referee's submission click) were removed: the close of the deciding game submits the
// series itself (submitSeriesResult in helpers/gameClose.ts, A60(6)).

/**
 * Shared preconditions of confirm_game and close_game for the current game: Equipping or Scoring, match alive, the
 * lobby's Pending record, the game not closed, the given sides' lineups arranged, both sides' group scores complete
 * (the game is recomputed from its inputs) and the A60(4) Auction gate for the given sides. Returns the fresh game
 * row, the record and the session.
 */
function readyGame(ctx: any, lobby: any, sides: TeamTag[], verb: 'confirming' | 'closing', actorId: number): { game: any; record: any; session: any } {
    ensureStageIs(lobby, 'Equipping', 'Scoring');
    ensureMatchAlive(ctx, lobby);
    const record = findPendingResult(ctx, lobby.id);
    const session = ctx.db.MatchSession.lobbyId.find(lobby.id);
    if (!session) throw new SenderError('Match session not found.');
    const gameNumber = session.currentGameNumber;
    if (isClosedGame(findGame(ctx, record.id, gameNumber))) throw new SenderError('This game is closed.');
    for (const side of sides) {
        if (!findLineup(ctx, lobby.id, gameNumber, side)) {
            throw new SenderError(`Arrange the lineup before ${verb} the game.`);
        }
    }
    if (!recomputeGame(ctx, record, lobby, gameNumber, actorId)) {
        throw new SenderError(`Both teams' group scores are needed before ${verb}.`);
    }
    for (const side of sides) ensureAuctionSurchargeFits(ctx, lobby, session, gameNumber, side);
    return { game: findGame(ctx, record.id, gameNumber), record, session };
}

// ─── confirm_game ─────────────────────────────────────────────────────────────
// A60(3): one confirmation per captain per game, covering lineup, light cones, eidolons and scores. Callers:
// 1. The captain of teamSide (live LobbyMember.isCaptain on a player seat of that team): sets that side's flag. A
//    referee seated on a team acts only as the captain of its own side, if it is the captain.
// 2. A spectator referee when the record has refereeFullControl: sets both flags at once (teamSide is ignored).
// Preconditions (readyGame): Equipping or Scoring, match alive, Pending record, the game open, the confirming side's
// lineup arranged (both for the full-control referee), both sides' group scores complete, and in Auction the
// confirming team's synergy surcharge within its remaining budget (A60(4)).
// Effect: the flag(s) are set. When both flags are now set the game closes (closeGame: one ConfirmGame step with
// closed: true; BetweenGames, or the series submits itself), after the Auction gate for both teams; a level-4 tie
// stays open with both flags set (no error) until staff close it with an override (close_game). Otherwise a
// ConfirmGame step with closed: false is logged. A side that already confirmed cannot confirm again (S7b choice).

export const confirm_game = spacetimedb.reducer(
    {
        lobbyId: t.u32(),
        teamSide: TeamSide,
    },
    (ctx, { lobbyId, teamSide }) => {
        const user = getAuthenticatedUser(ctx);
        const lobby = ctx.db.Lobby.id.find(lobbyId);
        if (!lobby) throw new SenderError('Lobby not found.');

        const member = [...ctx.db.LobbyMember.by_lobby_and_user.filter([lobbyId, user.id])][0];
        let sides: TeamTag[];
        if (member && member.isCaptain && !slotIsCoach(member.lobbySlot) && !slotIsSpectator(member.lobbySlot)) {
            const side = ensureTeamTag(teamSide);
            if (slotTeam(member.lobbySlot) !== side) {
                throw new SenderError(`Only the team captain can confirm the ${side} side of the game.`);
            }
            sides = [side];
        } else if (member && member.isReferee && slotIsSpectator(member.lobbySlot)) {
            const fullControl = [...ctx.db.MatchResultRecord.lobby_id.filter(lobbyId)]
                .find((r: any) => r.status.tag === 'Pending')?.refereeFullControl;
            if (!fullControl) throw new SenderError('Referee full control is not enabled for this match.');
            sides = ['Blue', 'Red'];
        } else {
            throw new SenderError('Only the team captain can confirm the game.');
        }

        const { game, record, session } = readyGame(ctx, lobby, sides, 'confirming', user.id);
        if (sides.length === 1 && (sides[0] === 'Blue' ? game.blueConfirmed : game.redConfirmed)) {
            throw new SenderError(`The ${sides[0]} captain has already confirmed this game.`);
        }
        const blueConfirmed = game.blueConfirmed || sides.includes('Blue');
        const redConfirmed = game.redConfirmed || sides.includes('Red');
        const confirmedSide: 'Blue' | 'Red' | 'Spectator' = sides.length === 1 ? sides[0] : 'Spectator';

        if (blueConfirmed && redConfirmed && !isUnresolvedTie(game)) {
            // The close covers both teams: the Auction gate for the other side too.
            for (const side of ['Blue', 'Red'] as TeamTag[]) ensureAuctionSurchargeFits(ctx, lobby, session, game.gameNumber, side);
            closeGame(ctx, lobby, record, game, { userId: user.id, actorSlot: confirmedSide });
            return;
        }

        replaceGame(ctx, game, { blueConfirmed, redConfirmed }, user.id);
        ctx.db.MatchSessionStep.insert(insertWithAudit(ctx, {
            id: 0, // autoInc
            lobbyId,
            gameNumber: game.gameNumber,
            sequence: getNextSequence(ctx, lobbyId),
            actorUserId: user.id,
            anonymousLabel: undefined,
            actorSlot: teamSideValue(confirmedSide),
            action: { tag: 'ConfirmGame', value: {} } as any,
            payload: {
                tag: 'ConfirmGame',
                value: { confirmedSide: teamSideValue(confirmedSide), closed: false, winnerOverride: undefined, winnerOverrideReason: undefined },
            } as any,
            timestamp: ctx.timestamp,
        }, user.id));
        ctx.db.Lobby.id.update(updateWithAudit(ctx, lobby, { lastActivityAt: ctx.timestamp }, user.id));

        console.log(`[MATCH] Game ${game.gameNumber} of match result #${record.id}: ${confirmedSide} confirmation by user #${user.id}${blueConfirmed && redConfirmed ? ' (tied: open until a staff close)' : ''}`);
    }
);

// ─── close_game ───────────────────────────────────────────────────────────────
// A60(4): the staff close, without both confirmations. Authority (A39 staff set, ensureResultAuthority): any lobby
// referee (seated or spectator), Moderator+, or in a tournament lobby the organizer or an assistant with
// canResolveResults. Preconditions (readyGame): Equipping or Scoring, match alive, Pending record, the game open,
// both lineups arranged, both sides' scores complete, the Auction gate for both teams.
// winnerOverride: accepted only while the game is a level-4 tie (and required then: closeGame rejects a tie without
// it); reason trimmed, at most 1000 characters. A39 at the close (replaces S7's Disputed route): in a tournament
// lobby a referee seated on a Blue/Red slot (player or coach) who is not staff cannot decide a tie; in a casual lobby
// the same referee's override is accepted and audited. The override becomes the game's winner (tieBreakLevel stays
// 4) and MatchResultRecord.winnerOverride* (copied to MatchSessionHistory by runFinalization, A60(6)).

const MAX_OVERRIDE_REASON_LENGTH = 1000;

export const close_game = spacetimedb.reducer(
    {
        lobbyId: t.u32(),
        winnerOverride: TeamSide.optional(),
        winnerOverrideReason: t.string().optional(),
    },
    (ctx, { lobbyId, winnerOverride, winnerOverrideReason }) => {
        const user = getAuthenticatedUser(ctx);
        const lobby = ctx.db.Lobby.id.find(lobbyId);
        if (!lobby) throw new SenderError('Lobby not found.');

        const { member, isStaff } = ensureResultAuthority(ctx, lobby, user,
            'Only a referee, a Moderator or, in a tournament lobby, the organizer or a results assistant can close a game.');
        const { game, record } = readyGame(ctx, lobby, ['Blue', 'Red'], 'closing', user.id);

        let override: { side: TeamTag; reason?: string } | undefined;
        if (winnerOverride !== undefined) {
            const side = ensureTeamTag(winnerOverride);
            if (!isUnresolvedTie(game)) {
                throw new SenderError('A winner override is only accepted on an unresolved tie.');
            }
            const trimmed = winnerOverrideReason?.trim();
            if (trimmed && trimmed.length > MAX_OVERRIDE_REASON_LENGTH) {
                throw new SenderError(`winnerOverrideReason cannot exceed ${MAX_OVERRIDE_REASON_LENGTH} characters.`);
            }
            // A39: a referee seated on a team (player or coach) without staff authority cannot decide a tie in a
            // tournament lobby; in a casual lobby the override is accepted and audited.
            const seatedReferee = !!member?.isReferee && !slotIsSpectator(member.lobbySlot);
            if (record.isTournamentControlled && seatedReferee && !isStaff) {
                throw new SenderError('A referee seated on a team cannot decide a tie in a tournament lobby; staff must close this game.');
            }
            override = { side, reason: trimmed ? trimmed : undefined };
        }

        closeGame(ctx, lobby, record, game, { userId: user.id, actorSlot: 'Spectator' }, override);
    }
);

// ─── dispute_match_result ─────────────────────────────────────────────────────
// Allows a match participant to dispute the submitted result.
// Permission: match participant.
// Constraints: status must be Submitted, only one dispute per match.

export const dispute_match_result = spacetimedb.reducer(
    {
        matchResultId: t.u32(),
        reason: t.string(),
    },
    (ctx, { matchResultId, reason }) => {
        const user = getAuthenticatedUser(ctx);

        // Find the MatchResultRecord
        const matchResult = ctx.db.MatchResultRecord.id.find(matchResultId);
        if (!matchResult) {
            throw new SenderError('Match result not found.');
        }

        // Check idempotency first — more specific error when already disputed
        // Note: use status.tag check instead of disputedByUserId !== undefined
        // because SpacetimeDB optional u32 representation may not equal JS undefined.
        if (matchResult.status.tag === 'Disputed') {
            throw new SenderError('This match result has already been disputed.');
        }

        // Validate status is Submitted (can only dispute after submission)
        if (matchResult.status.tag !== 'Submitted') {
            throw new SenderError('A match result can only be disputed after it has been submitted.');
        }

        // Block dispute after concede (but NOT after AwaitingResult — disputes happen there)
        const disputeLobby = ctx.db.Lobby.id.find(matchResult.lobbyId);
        if (disputeLobby) {
            const existingResult = [...ctx.db.MatchResultRecord.lobby_id.filter(disputeLobby.id)][0];
            if (existingResult?.matchEndReason?.tag === 'Concede') {
                throw new SenderError('Match has been conceded.');
            }
        }

        // Validate caller is a match participant via MatchResultParticipant
        const participant = [...ctx.db.MatchResultParticipant.by_result_and_user.filter([matchResultId, user.id])][0];
        if (!participant) {
            throw new SenderError('You are not a participant of this match.');
        }

        // Validate reason length
        const trimmedReason = reason.trim();
        if (trimmedReason.length === 0) {
            throw new SenderError('Dispute reason cannot be empty.');
        }
        if (trimmedReason.length > 1000) {
            throw new SenderError('Dispute reason cannot exceed 1000 characters.');
        }

        // Update the MatchResultRecord
        ctx.db.MatchResultRecord.id.update(updateWithAudit(ctx, matchResult, {
            status: { tag: 'Disputed', value: {} } as any,
            disputedByUserId: user.id,
            disputeReason: trimmedReason,
        }, user.id));

        console.log(`[MATCH] Match result #${matchResultId} disputed by player #${user.id}`);
    }
);
