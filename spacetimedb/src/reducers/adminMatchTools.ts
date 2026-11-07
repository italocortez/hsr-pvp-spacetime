import spacetimedb from '../schema';
import { t, SenderError } from 'spacetimedb/server';
import { getAuthenticatedUser, isRoleAtLeast } from '../helpers/ensurePermissions';
import { runFinalization } from '../helpers/finalizationHelpers';
import { hardDeleteLobby } from './lobbyGc';
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

        // A31: no draws. A concede record keeps its winner; otherwise winnerTeamId must name a side.
        // S8 (D.8.3): for tournament lobbies this reducer points at resolve_bracket_match instead.
        if (!winnerTeamSide && matchResult.winnerTeamSide === undefined) {
            throw new SenderError('winnerTeamId must name the winning team (1 = Blue, 2 = Red, or a bracket team id): no draws.');
        }
        const matchEndReason: any = { tag: 'Completed', value: {} };

        // Update MatchResultRecord with winner and validated status
        ctx.db.MatchResultRecord.id.update(updateWithAudit(ctx, matchResult, {
            winnerTeamSide: winnerTeamSide ? { tag: winnerTeamSide, value: {} } as any : matchResult.winnerTeamSide,
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
