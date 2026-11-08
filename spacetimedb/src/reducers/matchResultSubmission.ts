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
    resultAuthority,
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

// A60 (S7b): the game is confirmed and closed by its captains. confirm_match_scores (series-level flags) and
// submit_match_result (the referee's submission click) were removed: A67(3), the close of the game submits it
// (submitGameResult in helpers/gameClose.ts).

/**
 * Shared preconditions of confirm_game and close_game for the lobby's game: Equipping or Scoring, match alive, the
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
    if (isClosedGame(findGame(ctx, record.id))) throw new SenderError('This game is closed.');
    for (const side of sides) {
        if (!findLineup(ctx, lobby.id, side)) {
            throw new SenderError(`Arrange the lineup before ${verb} the game.`);
        }
    }
    if (!recomputeGame(ctx, record, lobby, actorId)) {
        throw new SenderError(`Both teams' group scores are needed before ${verb}.`);
    }
    for (const side of sides) ensureAuctionSurchargeFits(ctx, lobby, session, side);
    return { game: findGame(ctx, record.id), record, session };
}

// ─── confirm_game ─────────────────────────────────────────────────────────────
// A63 (amends A60(3)): the captain's ready flag for the game package (lineup, light cones, eidolons, scores). It only
// sets that side's flag and never closes a game, tie or not; close_game is the explicit submit. Caller: the captain
// of teamSide (live LobbyMember.isCaptain on a player seat of that team; a referee who is that captain confirms as the
// captain). The full-control spectator referee's shortcut is gone (A63(4)): the referee closes with close_game.
// Preconditions (readyGame): Equipping or Scoring, match alive, Pending record, the game open, the side's lineup
// arranged, both sides' group scores complete, and in Auction the side's synergy surcharge within its remaining
// budget (A60(4)). A side cannot confirm twice; every edit of the game clears both flags (A60(2)).
// Effect: the flag is set, a ConfirmGame step { confirmedSide: side, closed: false } is logged, lastActivityAt bumped.

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
        if (!member || !member.isCaptain || slotIsCoach(member.lobbySlot) || slotIsSpectator(member.lobbySlot)) {
            throw new SenderError('Only the team captain can confirm the game.');
        }
        const side = ensureTeamTag(teamSide);
        if (slotTeam(member.lobbySlot) !== side) {
            throw new SenderError(`Only the team captain can confirm the ${side} side of the game.`);
        }

        const { game, record } = readyGame(ctx, lobby, [side], 'confirming', user.id);
        if (side === 'Blue' ? game.blueConfirmed : game.redConfirmed) {
            throw new SenderError(`The ${side} captain has already confirmed this game.`);
        }

        replaceGame(ctx, game, side === 'Blue' ? { blueConfirmed: true } : { redConfirmed: true }, user.id);
        ctx.db.MatchSessionStep.insert(insertWithAudit(ctx, {
            id: 0, // autoInc
            lobbyId,
            sequence: getNextSequence(ctx, lobbyId),
            actorUserId: user.id,
            anonymousLabel: undefined,
            actorSlot: teamSideValue(side),
            action: { tag: 'ConfirmGame', value: {} } as any,
            payload: {
                tag: 'ConfirmGame',
                value: { confirmedSide: teamSideValue(side), closed: false, winnerOverride: undefined, winnerOverrideReason: undefined },
            } as any,
            timestamp: ctx.timestamp,
        }, user.id));
        ctx.db.Lobby.id.update(updateWithAudit(ctx, lobby, { lastActivityAt: ctx.timestamp }, user.id));

        console.log(`[MATCH] Game of match result #${record.id}: ${side} ready (confirm_game) by user #${user.id}`);
    }
);

// ─── close_game ───────────────────────────────────────────────────────────────
// A63(2): the submit of a game. Authority: (a) the A60(4) staff set at any time (ensureResultAuthority's lookup: any
// lobby referee, seated or spectator; Moderator+; in a tournament lobby the organizer or an assistant with
// canResolveResults), which is the staff close when the flags are not both set; (b) once both captains confirmed
// (MatchResultGame.blueConfirmed && redConfirmed), the captain of either team (player seat).
// Preconditions (readyGame): Equipping or Scoring, match alive, Pending record, the game open, both lineups arranged,
// both sides' scores complete, the Auction gate for both teams.
// winnerOverride: from the staff set only (a captain cannot decide a tie); accepted only while the game is a level-4
// tie (and required then: closeGame rejects a tie without it); reason trimmed, at most 1000 characters. A39 at the
// close: in a tournament lobby a referee seated on a Blue/Red slot (player or coach) who is not staff cannot decide a
// tie; in a casual lobby the same referee's override is accepted and audited. The override becomes the game's winner
// (tieBreakLevel stays 4) and MatchResultRecord.winnerOverride* (copied to MatchSessionHistory, A60(6)).
// The ConfirmGame step's actorSlot / confirmedSide = the closer's team side when the closer is a captain or a referee
// seated on a team, Spectator otherwise (A63(5)).

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

        const { member, isReferee, isStaff } = resultAuthority(ctx, lobby, user);
        const staffSet = isReferee || isStaff;
        const isCaptain = !!member && member.isCaptain && !slotIsCoach(member.lobbySlot) && !slotIsSpectator(member.lobbySlot);
        if (!staffSet) {
            if (!isCaptain) {
                throw new SenderError('Only a captain (once both sides confirmed), a referee, a Moderator or, in a tournament lobby, the organizer or a results assistant can close a game.');
            }
            const pending = findPendingResult(ctx, lobbyId); // no Pending record → 'No pending match result for this lobby.'
            const current = findGame(ctx, pending.id);
            if (!current || !current.blueConfirmed || !current.redConfirmed) {
                throw new SenderError('Both captains must confirm the game before it can be submitted.');
            }
            if (winnerOverride !== undefined) throw new SenderError('Only staff may decide a tie.');
        }

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

        // A63(5): a captain or a referee seated on a team closes as that team; anyone else as Spectator.
        const seatedTeam = member && !slotIsSpectator(member.lobbySlot) && (isCaptain || member.isReferee)
            ? (slotTeam(member.lobbySlot) as TeamTag)
            : undefined;
        closeGame(ctx, lobby, record, game, { userId: user.id, actorSlot: seatedTeam ?? 'Spectator' }, override);
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

        // Block dispute after concede (but NOT after AwaitingResult — disputes happen there). A54 (S8d): the
        // lobby's one record is this record, so its own matchEndReason is the concede marker.
        if (matchResult.matchEndReason?.tag === 'Concede') {
            throw new SenderError('Match has been conceded.');
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
