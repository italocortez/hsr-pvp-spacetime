import spacetimedb from '../schema';
import { t, SenderError } from 'spacetimedb/server';
import { getAuthenticatedUser, isRoleAtLeast } from '../helpers/ensurePermissions';
import { updateWithAudit } from '../helpers/auditHelpers';
import { runFinalization } from '../helpers/finalizationHelpers';
import { ensureMatchAlive } from '../helpers/disconnectHelpers';
import type { MatchResultRecord } from '../module_bindings/types';

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

        // D-12: Liveness guard — block confirmation after concede
        const confirmLobby = ctx.db.Lobby.id.find(matchResult.lobbyId);
        if (confirmLobby) {
            ensureMatchAlive(ctx, confirmLobby);
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
// Submits the final match result with a winner.
// Permission: lobby referee OR Moderator/Admin (for tournament matches also the TO/assistant).
// Requires: all team captains must have confirmed scores first.
// winnerId: participant userId, or 0 as sentinel for draw/no winner.

export const submit_match_result = spacetimedb.reducer(
    {
        matchResultId: t.u32(),
        winnerId: t.u32(),
    },
    (ctx, { matchResultId, winnerId }) => {
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

        // D-12: Liveness guard — block submission after concede
        const submitLobby = ctx.db.Lobby.id.find(matchResult.lobbyId);
        if (submitLobby) {
            ensureMatchAlive(ctx, submitLobby);
        }

        // Check both sides have confirmed (record-level flags)
        if (!matchResult.blueConfirmed || !matchResult.redConfirmed) {
            throw new SenderError('All team captains must confirm scores before submission.');
        }

        // Validate winnerId is a valid participant (or 0 for draw)
        const participants = [...ctx.db.MatchResultParticipant.match_result_id.filter(matchResultId)];
        let winnerTeamSide: 'Blue' | 'Red' | undefined;
        if (winnerId !== 0) {
            const winnerParticipant = participants.find((p: any) => p.userId === winnerId);
            if (!winnerParticipant) {
                throw new SenderError('Invalid winner: must be a match participant or 0 for a draw.');
            }
            winnerTeamSide = winnerParticipant.teamSide.tag as 'Blue' | 'Red';
        }

        // Validate caller has referee authority:
        // 1. Check if caller is the lobby referee
        let hasAuthority = false;

        const lobbyMember = [...ctx.db.LobbyMember.by_lobby_and_user.filter([matchResult.lobbyId, user.id])][0];
        if (lobbyMember && lobbyMember.isReferee) {
            hasAuthority = true;
        }

        // 2. Moderator or Admin can always submit
        if (!hasAuthority && isRoleAtLeast(user.role, 'Moderator')) {
            hasAuthority = true;
        }

        // 3. For tournament matches, also check tournament access (TO/assistant)
        // Derive tournamentId from bracketMatch since tournamentId was removed from MatchResultRecord (D-42)
        if (!hasAuthority && matchResult.isTournamentControlled && matchResult.bracketMatchId !== undefined) {
            const bracketMatch = ctx.db.BracketMatch.id.find(matchResult.bracketMatchId);
            const derivedTournamentId = bracketMatch?.tournamentId;
            if (derivedTournamentId) {
                const tournament = ctx.db.Tournament.id.find(derivedTournamentId);
                if (tournament && tournament.organizerId === user.id) {
                    hasAuthority = true;
                }
                if (!hasAuthority) {
                    const assistant = [...ctx.db.TournamentAssistant.by_tournament_and_user.filter([derivedTournamentId, user.id])][0];
                    if (assistant && assistant.canValidateResults) {
                        hasAuthority = true;
                    }
                }
            }
        }

        if (!hasAuthority) {
            throw new SenderError('You do not have referee authority to submit this match result.');
        }

        // Determine status based on matchType (per D-04, D-05)
        // NOTE: D-04 (locked decision) supersedes MTCH-05's mismatch clause for Casual matches.
        // Casual matches auto-validate on submit -- there is no mismatch detection path for Casual.
        // Mismatch detection only applies to Ranked matches (both sides submit, referee validates).
        const newStatus = matchResult.matchType.tag === 'Casual'
            ? { tag: 'Validated', value: {} }
            : { tag: 'Submitted', value: {} };

        // Determine matchEndReason based on whether there is a winner
        const matchEndReason: any = winnerTeamSide
            ? { tag: 'Completed', value: {} }
            : { tag: 'Draw', value: {} };

        ctx.db.MatchResultRecord.id.update(updateWithAudit(ctx, matchResult, {
            status: newStatus as MatchResultRecord['status'],
            winnerTeamSide: winnerTeamSide ? { tag: winnerTeamSide, value: {} } as any : undefined,
            matchEndReason,
            refereeUserId: user.id,
        }, user.id));

        // Transition lobby → AwaitingResult (frees players to join new lobbies)
        const lobby = ctx.db.Lobby.id.find(matchResult.lobbyId);
        if (lobby && lobby.stage.tag !== 'AwaitingResult' && lobby.stage.tag !== 'Finished') {
            ctx.db.Lobby.id.update(updateWithAudit(ctx, lobby, {
                stage: { tag: 'AwaitingResult', value: {} } as any,
                lastActivityAt: ctx.timestamp,
            }, user.id));
        }

        const statusLabel = matchResult.matchType.tag === 'Casual' ? 'Validated (auto)' : 'Submitted';
        console.log(`[MATCH] Match result #${matchResultId} ${statusLabel} by user #${user.id}, winnerTeamSide: ${winnerTeamSide ?? 'draw'}`);

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
