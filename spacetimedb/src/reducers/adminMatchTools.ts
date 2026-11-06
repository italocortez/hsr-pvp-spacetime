import spacetimedb from '../schema';
import { t, SenderError } from 'spacetimedb/server';
import { getAuthenticatedUser, isRoleAtLeast } from '../helpers/ensurePermissions';
import { runFinalization } from '../helpers/finalizationHelpers';
import { hardDeleteLobby } from './lobbyGc';
import { advanceBracketMatch } from '../helpers/bracketHelpers';
import { updateWithAudit } from '../helpers/auditHelpers';
import { slotTeam, slotIsCoach, slotIsSpectator } from '../helpers/lobbyHelpers';

// ─── Permission helper ───────────────────────────────────────────────────────
// Checks Moderator+ role, OR tournament organizer for tournament-controlled lobbies.

function ensureAdminOrOrganizer(ctx: any, user: any, lobby: any): void {
    if (isRoleAtLeast(user.role, 'Moderator')) return;

    // Check if user is the tournament organizer
    if (lobby.isTournamentControlled && lobby.tournamentId) {
        const tournament = ctx.db.Tournament.id.find(lobby.tournamentId);
        if (tournament && tournament.organizerId === user.id) return;
        // Also check tournament assistants
        const assistant = [...ctx.db.TournamentAssistant.by_tournament_and_user
            .filter([lobby.tournamentId, user.id])][0];
        if (assistant) return;
    }

    throw new SenderError('Only moderators, admins, or the tournament organizer can perform this action.');
}

// ─── admin_force_finalize ────────────────────────────────────────────────────
// Resolves an AwaitingResult match by setting a winner and running full
// finalization pipeline. Per D-52.

export const admin_force_finalize = spacetimedb.reducer(
    {
        lobbyId: t.u32(),
        winnerTeamId: t.u32(),
    },
    (ctx, { lobbyId, winnerTeamId }) => {
        const user = getAuthenticatedUser(ctx);

        const lobby = ctx.db.Lobby.id.find(lobbyId);
        if (!lobby) {
            throw new SenderError('Lobby not found.');
        }

        ensureAdminOrOrganizer(ctx, user, lobby);

        // D-52: Only AwaitingResult
        if (lobby.stage.tag !== 'AwaitingResult') {
            throw new SenderError('Can only force-finalize matches in AwaitingResult stage.');
        }

        // Find MatchResultRecord
        const matchResult = [...ctx.db.MatchResultRecord.lobby_id.filter(lobbyId)][0];
        if (!matchResult) {
            throw new SenderError('No match result record found for this lobby.');
        }

        // D-56: Cannot process already-processed matches
        if (matchResult.mmrProcessedAt !== undefined) {
            throw new SenderError('This match has already been processed. Cannot force-finalize.');
        }

        // Determine winnerTeamSide from winnerTeamId
        // Convention: team1 = Blue, team2 = Red on BracketMatch
        // For non-tournament matches: 1 = Blue wins, 2 = Red wins (admin tool convention)
        let winnerTeamSide: 'Blue' | 'Red' | undefined;

        if (lobby.isTournamentControlled && matchResult.bracketMatchId) {
            const bracketMatch = ctx.db.BracketMatch.id.find(matchResult.bracketMatchId);
            if (bracketMatch) {
                if (winnerTeamId === bracketMatch.team1Id) {
                    winnerTeamSide = 'Blue';
                } else if (winnerTeamId === bracketMatch.team2Id) {
                    winnerTeamSide = 'Red';
                }
            }
        } else {
            // Non-tournament: winnerTeamId is used as a team side indicator
            // 1 = Blue wins, 2 = Red wins (convention for admin tool)
            if (winnerTeamId === 1) winnerTeamSide = 'Blue';
            else if (winnerTeamId === 2) winnerTeamSide = 'Red';
        }

        // Determine matchEndReason: Draw when no winner, Completed when there is one
        const matchEndReason: any = winnerTeamSide
            ? { tag: 'Completed', value: {} }
            : { tag: 'Draw', value: {} };

        // Update MatchResultRecord with winner and validated status
        ctx.db.MatchResultRecord.id.update(updateWithAudit(ctx, matchResult, {
            winnerTeamSide: winnerTeamSide ? { tag: winnerTeamSide, value: {} } as any : undefined,
            matchEndReason: matchResult.matchEndReason ?? matchEndReason, // Keep concede outcome if already set
            status: { tag: 'Validated', value: {} } as any,
        }, user.id));

        // Re-read for finalization
        const updatedResult = ctx.db.MatchResultRecord.id.find(matchResult.id)!;

        // Run finalization (archives data, writes stats/MMR, then hardDeleteLobby)
        runFinalization(ctx, updatedResult, user.id);

        console.log(`[ADMIN] Force-finalized lobby #${lobbyId} with winnerTeamId=${winnerTeamId} by user #${user.id}`);
    }
);

// ─── admin_void_match ────────────────────────────────────────────────────────
// Erases an AwaitingResult match completely without running finalization.
// No stats written. Per D-53, D-55.

export const admin_void_match = spacetimedb.reducer(
    {
        lobbyId: t.u32(),
    },
    (ctx, { lobbyId }) => {
        const user = getAuthenticatedUser(ctx);

        const lobby = ctx.db.Lobby.id.find(lobbyId);
        if (!lobby) {
            throw new SenderError('Lobby not found.');
        }

        ensureAdminOrOrganizer(ctx, user, lobby);

        // D-53: Only AwaitingResult
        if (lobby.stage.tag !== 'AwaitingResult') {
            throw new SenderError('Can only void matches in AwaitingResult stage.');
        }

        // Find MatchResultRecord
        const matchResult = [...ctx.db.MatchResultRecord.lobby_id.filter(lobbyId)][0];

        // D-56: Cannot void already-processed matches
        if (matchResult?.mmrProcessedAt !== undefined) {
            throw new SenderError('This match has already been processed. Cannot void.');
        }

        // Extended hardDeleteLobby handles MatchResult* cleanup
        hardDeleteLobby(ctx, lobbyId);

        console.log(`[ADMIN] Match voided for lobby #${lobbyId} by user #${user.id}`);
    }
);

// ─── admin_set_bracket_winner ────────────────────────────────────────────────
// Directly sets a bracket match winner and advances bracket.
// Used post-finalization for bracket fixes. Per D-54.

export const admin_set_bracket_winner = spacetimedb.reducer(
    {
        bracketMatchId: t.u32(),
        winnerTeamId: t.u32(),
    },
    (ctx, { bracketMatchId, winnerTeamId }) => {
        const user = getAuthenticatedUser(ctx);

        const bracketMatch = ctx.db.BracketMatch.id.find(bracketMatchId);
        if (!bracketMatch) {
            throw new SenderError('Bracket match not found.');
        }

        // Validate permission: Moderator+ or tournament organizer
        if (!isRoleAtLeast(user.role, 'Moderator')) {
            const tournament = ctx.db.Tournament.id.find(bracketMatch.tournamentId);
            if (!tournament || tournament.organizerId !== user.id) {
                const assistant = [...ctx.db.TournamentAssistant.by_tournament_and_user
                    .filter([bracketMatch.tournamentId, user.id])][0];
                if (!assistant) {
                    throw new SenderError('Only moderators, admins, or the tournament organizer can set bracket winners.');
                }
            }
        }

        // D-54: Only when no winner set (rollback was called first)
        if (bracketMatch.winnerTeamId !== undefined && bracketMatch.winnerTeamId !== 0) {
            throw new SenderError('Bracket match already has a winner. Call rollback_bracket_match first.');
        }

        // Validate winnerTeamId is one of the match participants
        if (winnerTeamId !== bracketMatch.team1Id && winnerTeamId !== bracketMatch.team2Id) {
            throw new SenderError('Winner team must be one of the bracket match participants.');
        }

        // Set winner and advance bracket
        advanceBracketMatch(ctx, bracketMatchId, winnerTeamId, user.id);

        console.log(`[ADMIN] Bracket winner set for match #${bracketMatchId}: team ${winnerTeamId} by user #${user.id}`);
    }
);
