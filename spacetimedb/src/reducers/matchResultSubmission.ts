import spacetimedb from '../schema';
import { t, SenderError } from 'spacetimedb/server';
import { getAuthenticatedUser, isRoleAtLeast } from '../helpers/ensurePermissions';
import { updateWithAudit } from '../helpers/auditHelpers';
import { runFinalization } from '../helpers/finalizationHelpers';
import { ensureNotConceded } from '../helpers/disconnectHelpers';
import { slotIsSpectator } from '../helpers/lobbyHelpers';
import {
    ensureTeamTag,
    isUnresolvedTie,
    recomputeGame,
    replaceGame,
    teamSideValue,
    type TeamTag,
} from '../helpers/scoringHelpers';
import { TeamSide } from '../types/enums';
import type { MatchResultRecord } from '@bindings/types';

// ─── confirm_match_scores ─────────────────────────────────────────────────────
// Confirms scores for a team side. Two paths:
// 1. Participant captain: confirms their own side only.
// 2. Spectator referee (refereeFullControl=true): confirms both sides at once.
//    A participant referee can only confirm their own side like any captain.

export const confirm_match_scores = spacetimedb.reducer(
    {
        matchResultId: t.u32(),
    },
    (ctx, { matchResultId }) => {
        const user = getAuthenticatedUser(ctx);

        // Find the MatchResultRecord
        const matchResult = ctx.db.MatchResultRecord.id.find(matchResultId);
        if (!matchResult) {
            throw new SenderError('Match result not found.');
        }

        // Validate status is Pending
        if (matchResult.status.tag !== 'Pending') {
            throw new SenderError('Scores can only be confirmed when the match is in Pending status.');
        }

        // D-12: Liveness guard — block confirmation after concede (F8/A22(4): AwaitingResult is allowed here)
        const confirmLobby = ctx.db.Lobby.id.find(matchResult.lobbyId);
        if (confirmLobby) {
            ensureNotConceded(ctx, confirmLobby);
        }

        // Check if caller is a participant
        const participant = [...ctx.db.MatchResultParticipant.by_result_and_user.filter([matchResultId, user.id])][0];

        if (participant) {
            // Participant path: must be a captain, confirms their own side
            if (!participant.isCaptain) {
                throw new SenderError('Only the team captain can confirm match scores.');
            }

            const sideFlag = participant.teamSide.tag === 'Blue' ? 'blueConfirmed' : 'redConfirmed';
            ctx.db.MatchResultRecord.id.update(updateWithAudit(ctx, matchResult, {
                [sideFlag]: true,
            } as Partial<MatchResultRecord>, user.id));

            console.log(`[MATCH] Captain #${user.id} confirmed ${participant.teamSide.tag} scores for match result #${matchResultId}`);
        } else {
            // Non-participant path: must be a spectator referee with refereeFullControl
            if (!matchResult.refereeFullControl) {
                throw new SenderError('Referee full control is not enabled for this match.');
            }

            const lobbyMember = [...ctx.db.LobbyMember.by_lobby_and_user.filter([matchResult.lobbyId, user.id])][0];
            if (!lobbyMember || !lobbyMember.isReferee) {
                throw new SenderError('You are not a participant or referee of this match.');
            }

            // Spectator referee confirms both sides
            ctx.db.MatchResultRecord.id.update(updateWithAudit(ctx, matchResult, {
                blueConfirmed: true,
                redConfirmed: true,
            }, user.id));

            console.log(`[MATCH] Spectator referee #${user.id} confirmed both sides for match result #${matchResultId}`);
        }
    }
);

// ─── submit_match_result ──────────────────────────────────────────────────────
// Submits the final match result. A21/A31: the server computes the winner; there is no winnerId argument.
// Permission: lobby referee OR Moderator/Admin (for tournament matches also the TO/assistant with
// canResolveResults). Requires: both captains confirmed the scores.
// Per game: the current game is recomputed from its inputs (earlier games of a series keep the outcome computed
// while they were played: their steps are gone); every game needs complete group scores.
// winnerOverride (A21 tie-break 4, A39): accepted only while a game is an unresolved tie (level 4); it decides
// every tied game. From a referee not seated on either team, or from staff (Moderator+, the tournament organizer,
// an assistant with canResolveResults): accepted. From a referee seated on a team (player or coach seat): in a
// tournament lobby the record goes to Disputed for staff (no winner, no finalization); in a casual
// (non-tournament) lobby it is accepted. Both are audited in winnerOverride / winnerOverrideById / winnerOverrideReason.
// Series winner: game wins plus the A27 head start; the side with more wins.

export const submit_match_result = spacetimedb.reducer(
    {
        matchResultId: t.u32(),
        winnerOverride: TeamSide.optional(),
        winnerOverrideReason: t.string().optional(),
    },
    (ctx, { matchResultId, winnerOverride, winnerOverrideReason }) => {
        const user = getAuthenticatedUser(ctx);

        // Find the MatchResultRecord
        const matchResult = ctx.db.MatchResultRecord.id.find(matchResultId);
        if (!matchResult) {
            throw new SenderError('Match result not found.');
        }

        // Validate status is Pending
        if (matchResult.status.tag !== 'Pending') {
            throw new SenderError('Match result can only be submitted when in Pending status.');
        }

        // D-12: Liveness guard — block submission after concede (F8/A22(4): AwaitingResult is allowed here)
        const submitLobby = ctx.db.Lobby.id.find(matchResult.lobbyId);
        if (submitLobby) {
            ensureNotConceded(ctx, submitLobby);
        }

        // Check both sides have confirmed (record-level flags)
        if (!matchResult.blueConfirmed || !matchResult.redConfirmed) {
            throw new SenderError('All team captains must confirm scores before submission.');
        }

        // Validate caller has referee authority:
        // 1. The lobby referee (seated or not)
        const lobbyMember = [...ctx.db.LobbyMember.by_lobby_and_user.filter([matchResult.lobbyId, user.id])][0];
        const isReferee = !!lobbyMember && lobbyMember.isReferee;

        // 2. Staff (A39): Moderator/Admin, and for tournament matches the organizer or an assistant with
        // canResolveResults. Derive tournamentId from bracketMatch (no tournamentId on MatchResultRecord, D-42).
        let isStaff = isRoleAtLeast(user.role, 'Moderator');
        if (!isStaff && matchResult.isTournamentControlled && matchResult.bracketMatchId !== undefined) {
            const bracketMatch = ctx.db.BracketMatch.id.find(matchResult.bracketMatchId);
            const derivedTournamentId = bracketMatch?.tournamentId;
            if (derivedTournamentId) {
                const tournament = ctx.db.Tournament.id.find(derivedTournamentId);
                if (tournament && tournament.organizerId === user.id) {
                    isStaff = true;
                }
                if (!isStaff) {
                    const assistant = [...ctx.db.TournamentAssistant.by_tournament_and_user.filter([derivedTournamentId, user.id])][0];
                    if (assistant && assistant.canResolveResults) { // A25
                        isStaff = true;
                    }
                }
            }
        }

        if (!isReferee && !isStaff) {
            throw new SenderError('You do not have referee authority to submit this match result.');
        }

        // Recompute the game being played (its steps still exist), then read every game of the record.
        const lobby = ctx.db.Lobby.id.find(matchResult.lobbyId);
        const session = ctx.db.MatchSession.lobbyId.find(matchResult.lobbyId);
        if (lobby && session) {
            recomputeGame(ctx, matchResult, lobby, session.currentGameNumber, user.id);
        }
        const games = [...ctx.db.MatchResultGame.match_result_id.filter(matchResultId)]
            .sort((a: any, b: any) => a.gameNumber - b.gameNumber);
        if (games.length === 0) {
            throw new SenderError('No game scores have been recorded.');
        }
        const incomplete = games.find((g: any) => g.tieBreakLevel === undefined);
        if (incomplete) {
            throw new SenderError(`Game ${incomplete.gameNumber} does not have complete group scores for both teams.`);
        }

        const tiedGames = games.filter(isUnresolvedTie);
        let overrideTag: TeamTag | undefined;
        if (winnerOverride !== undefined) {
            overrideTag = ensureTeamTag(winnerOverride);
            if (tiedGames.length === 0) {
                throw new SenderError('A winner override is only accepted on an unresolved tie.');
            }
        } else if (tiedGames.length > 0) {
            throw new SenderError(
                `Game ${tiedGames[0].gameNumber} is tied after every tie-break: the referee decides with winnerOverride.`,
            );
        }
        const trimmedReason = winnerOverrideReason?.trim();
        if (trimmedReason && trimmedReason.length > 1000) {
            throw new SenderError('winnerOverrideReason cannot exceed 1000 characters.');
        }
        const overrideAudit = overrideTag
            ? {
                winnerOverride: teamSideValue(overrideTag),
                winnerOverrideById: user.id,
                winnerOverrideReason: trimmedReason ? trimmedReason : undefined,
            }
            : {};

        // A39: an override from a referee seated on a team, without staff authority, in a tournament lobby goes to staff.
        const isSeatedReferee = isReferee && !slotIsSpectator(lobbyMember.lobbySlot);
        if (overrideTag && !isStaff && isSeatedReferee && matchResult.isTournamentControlled) {
            ctx.db.MatchResultRecord.id.update(updateWithAudit(ctx, matchResult, {
                ...overrideAudit,
                status: { tag: 'Disputed', value: {} } as MatchResultRecord['status'],
                disputedByUserId: user.id,
                disputeReason: 'A39: tie override by a referee seated on a team; staff must resolve the result.',
                refereeUserId: user.id,
            }, user.id));
            if (lobby && lobby.stage.tag !== 'AwaitingResult' && lobby.stage.tag !== 'Finished') {
                ctx.db.Lobby.id.update(updateWithAudit(ctx, lobby, {
                    stage: { tag: 'AwaitingResult' as const },
                    lastActivityAt: ctx.timestamp,
                }, user.id));
            }
            console.log(`[MATCH] Match result #${matchResultId} Disputed: seated referee #${user.id} overrode a tie (A39)`);
            return;
        }

        // The override decides every tied game; then the series winner from the games (+ the A27 head start).
        let blueWins = lobby?.bestOfNAdvantage?.tag === 'Blue' ? 1 : 0;
        let redWins = lobby?.bestOfNAdvantage?.tag === 'Red' ? 1 : 0;
        for (const game of games) {
            let winnerTag = game.winnerTeamSide.tag;
            if (isUnresolvedTie(game) && overrideTag) {
                winnerTag = overrideTag;
                replaceGame(ctx, game, { winnerTeamSide: teamSideValue(overrideTag) }, user.id);
            }
            if (winnerTag === 'Blue') blueWins++;
            else if (winnerTag === 'Red') redWins++;
        }
        if (blueWins === redWins) {
            throw new SenderError(`The series is level (${blueWins}-${redWins}): play the deciding game first.`);
        }
        const winnerTeamSide: TeamTag = blueWins > redWins ? 'Blue' : 'Red';

        // Determine status based on matchType (per D-04, D-05)
        // NOTE: D-04 (locked decision) supersedes MTCH-05's mismatch clause for Casual matches.
        // Casual matches auto-validate on submit -- there is no mismatch detection path for Casual.
        // Mismatch detection only applies to Ranked matches (both sides submit, referee validates).
        const newStatus = matchResult.matchType.tag === 'Casual'
            ? { tag: 'Validated', value: {} }
            : { tag: 'Submitted', value: {} };

        ctx.db.MatchResultRecord.id.update(updateWithAudit(ctx, matchResult, {
            ...overrideAudit,
            status: newStatus as MatchResultRecord['status'],
            winnerTeamSide: teamSideValue(winnerTeamSide),
            matchEndReason: { tag: 'Completed', value: {} } as MatchResultRecord['matchEndReason'],
            refereeUserId: user.id,
        }, user.id));

        // Transition lobby → AwaitingResult (frees players to join new lobbies)
        if (lobby && lobby.stage.tag !== 'AwaitingResult' && lobby.stage.tag !== 'Finished') {
            ctx.db.Lobby.id.update(updateWithAudit(ctx, lobby, {
                stage: { tag: 'AwaitingResult', value: {} } as any,
                lastActivityAt: ctx.timestamp,
            }, user.id));
        }

        const statusLabel = matchResult.matchType.tag === 'Casual' ? 'Validated (auto)' : 'Submitted';
        console.log(`[MATCH] Match result #${matchResultId} ${statusLabel} by user #${user.id}, winnerTeamSide: ${winnerTeamSide}${overrideTag ? ' (override)' : ''}`);

        // Auto-finalize casual matches inline (per D-37)
        if (matchResult.matchType.tag === 'Casual') {
            const updatedResult = ctx.db.MatchResultRecord.id.find(matchResultId)!;
            runFinalization(ctx, updatedResult, user.id);
        }
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
