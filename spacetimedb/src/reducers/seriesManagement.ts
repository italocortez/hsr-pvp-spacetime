// ─── Series Management Reducers ───────────────────────────────────────────────
// Reducers for best-of-N series lifecycle: advance to next game, shelve, resume.
// Per D-02, D-04, D-07, D-08, D-14, D-15.

import spacetimedb from '../schema';
import { t, SenderError } from 'spacetimedb/server';
import { getAuthenticatedUser, isRoleAtLeast } from '../helpers/ensurePermissions';
import { ensureLobbyMember, slotTeam, slotIsCoach, slotIsSpectator } from '../helpers/lobbyHelpers';
import { insertWithAudit, updateWithAudit } from '../helpers/auditHelpers';
import type { TimerState } from '../module_bindings/types';

// ─── D-07 authority check ─────────────────────────────────────────────────────
// Returns true if caller has authority to control series state.
// Authority: lobby host, TO, TO assistant, admin/mod.
// If lobby.refereeControlsShelving === true AND caller is 3rd-party referee: also allowed.
function hasSeriesAuthority(ctx: any, lobby: any, user: any): boolean {
    // Admin/Mod always have authority
    if (isRoleAtLeast(user.role, 'Moderator')) return true;

    // Lobby host has authority
    if (lobby.hostUserId === user.id) return true;

    // Tournament authority: TO or assistant
    if (lobby.isTournamentControlled && lobby.tournamentId) {
        const tournament = ctx.db.Tournament.id.find(lobby.tournamentId);
        if (tournament && tournament.organizerId === user.id) return true;

        const assistant = [...ctx.db.TournamentAssistant.by_tournament_and_user.filter([lobby.tournamentId, user.id])][0];
        if (assistant) return true;
    }

    // Referee: only if refereeControlsShelving is true
    if (lobby.refereeControlsShelving) {
        const member = [...ctx.db.LobbyMember.by_lobby_and_user.filter([lobby.id, user.id])][0];
        if (member && member.isReferee) return true;
    }

    return false;
}

// ─── advance_to_next_game ─────────────────────────────────────────────────────
// Transitions a BetweenGames lobby to Drafting for the next game.
// Per D-02, D-04, D-07, D-14:
//   1. Deletes all current MatchSessionStep rows (finalization archives final game's steps)
//   2. Resets MatchSession: turnIndex=0, timerState reset, budgets reset, increments currentGameNumber
//   3. Transitions lobby stage: BetweenGames -> Drafting

export const advance_to_next_game = spacetimedb.reducer(
    {
        lobbyId: t.u32(),
    },
    (ctx, { lobbyId }) => {
        const user = getAuthenticatedUser(ctx);

        const lobby = ctx.db.Lobby.id.find(lobbyId);
        if (!lobby) throw new SenderError('Lobby not found.');

        // D-07: permission check
        if (!hasSeriesAuthority(ctx, lobby, user)) {
            throw new SenderError('Only the host, tournament organizer, assistant, admin, or authorized referee can advance to the next game.');
        }

        // Pre-condition: must be in BetweenGames
        if (lobby.stage.tag !== 'BetweenGames') {
            throw new SenderError('Lobby must be in BetweenGames stage to advance to the next game.');
        }

        const session = ctx.db.MatchSession.lobbyId.find(lobbyId);
        if (!session) throw new SenderError('Match session not found.');

        // Pre-condition: series must not be won
        const winsNeeded = Math.ceil(session.seriesBestOf / 2);
        if (session.gamesWonBlue >= winsNeeded || session.gamesWonRed >= winsNeeded) {
            throw new SenderError('Series is already won. Cannot advance to next game.');
        }

        // Step 1: Delete all current MatchSessionStep rows for this lobby.
        // These are the inter-game steps. Finalization at end-of-series will archive the final game's steps.
        // Important: do NOT archive here — there is no MatchSessionHistory row yet.
        const currentSteps = [...ctx.db.MatchSessionStep.lobby_id.filter(lobbyId)];
        for (const step of currentSteps) {
            ctx.db.MatchSessionStep.id.delete(step.id);
        }

        // Step 2: Reset MatchSession for next game
        // - Reset turnIndex to 0
        // - Reset draftSequence (clear — start_draft will regenerate)
        // - Reset budgets from lobby config
        // - Reset pause state
        // - Increment currentGameNumber
        const initialTimerState: TimerState = {
            turnStartAt: ctx.timestamp,
            teamBlueReserveMs: lobby.reserveBankSeconds * 1000,
            teamRedReserveMs: lobby.reserveBankSeconds * 1000,
            isPaused: false,
            accumulatedPauseMs: 0,
        };

        ctx.db.MatchSession.lobbyId.update(updateWithAudit(ctx, session, {
            turnIndex: 0,
            draftSequence: [],
            teamBlueCharBudget: lobby.characterBudget,
            teamRedCharBudget: lobby.characterBudget,
            teamBlueLcBudget: lobby.lightconeBudget,
            teamRedLcBudget: lobby.lightconeBudget,
            timerState: initialTimerState,
            pausesUsedBlue: 0,
            pausesUsedRed: 0,
            isAuctionPhase: false,
            currentNomination: undefined,
            currentBidAmount: undefined,
            blueCharactersWon: 0,
            redCharactersWon: 0,
            currentGameNumber: session.currentGameNumber + 1,
        }, user.id));

        // Step 3: Transition lobby stage: BetweenGames -> Drafting
        ctx.db.Lobby.id.update(updateWithAudit(ctx, lobby, {
            stage: { tag: 'Drafting', value: {} } as any,
            lastActivityAt: ctx.timestamp,
        }, user.id));

        // System chat message
        ctx.db.ChatMessage.insert(insertWithAudit(ctx, {
            id: 0,
            lobbyId,
            senderUserId: 0,
            senderType: { tag: 'System', value: {} } as any,
            content: `Game ${session.currentGameNumber + 1} starting. Stage: Drafting`,
            metadata: undefined,
            anonymousLabel: undefined,
        }, user.id));

        console.log(`[SERIES] Lobby #${lobbyId} advanced to game ${session.currentGameNumber + 1} by user #${user.id}`);
    }
);

// ─── shelve_series ────────────────────────────────────────────────────────────
// Transitions a BetweenGames lobby to Shelved for a long-term pause.
// Per D-15.

export const shelve_series = spacetimedb.reducer(
    {
        lobbyId: t.u32(),
    },
    (ctx, { lobbyId }) => {
        const user = getAuthenticatedUser(ctx);

        const lobby = ctx.db.Lobby.id.find(lobbyId);
        if (!lobby) throw new SenderError('Lobby not found.');

        // D-07: permission check
        if (!hasSeriesAuthority(ctx, lobby, user)) {
            throw new SenderError('Only the host, tournament organizer, assistant, admin, or authorized referee can shelve the series.');
        }

        // Pre-condition: must be in BetweenGames
        if (lobby.stage.tag !== 'BetweenGames') {
            throw new SenderError('Lobby must be in BetweenGames stage to shelve.');
        }

        // Transition: BetweenGames -> Shelved
        ctx.db.Lobby.id.update(updateWithAudit(ctx, lobby, {
            stage: { tag: 'Shelved', value: {} } as any,
            lastActivityAt: ctx.timestamp,
        }, user.id));

        // System chat message
        ctx.db.ChatMessage.insert(insertWithAudit(ctx, {
            id: 0,
            lobbyId,
            senderUserId: 0,
            senderType: { tag: 'System', value: {} } as any,
            content: 'Series shelved. Players may leave and return later.',
            metadata: undefined,
            anonymousLabel: undefined,
        }, user.id));

        console.log(`[SERIES] Lobby #${lobbyId} shelved by user #${user.id}`);
    }
);

// ─── resume_series ────────────────────────────────────────────────────────────
// Transitions a Shelved lobby back to BetweenGames.
// Per D-08, D-15.
// Unshelve gate: at least 1 non-coach, non-spectator player per team must be present
// (have a LobbyMember row with voluntarilyLeft=false or undefined).
// 3rd party referee NOT required to be present.

export const resume_series = spacetimedb.reducer(
    {
        lobbyId: t.u32(),
    },
    (ctx, { lobbyId }) => {
        const user = getAuthenticatedUser(ctx);

        const lobby = ctx.db.Lobby.id.find(lobbyId);
        if (!lobby) throw new SenderError('Lobby not found.');

        // D-07: permission check
        if (!hasSeriesAuthority(ctx, lobby, user)) {
            throw new SenderError('Only the host, tournament organizer, assistant, admin, or authorized referee can resume the series.');
        }

        // Pre-condition: must be Shelved
        if (lobby.stage.tag !== 'Shelved') {
            throw new SenderError('Lobby must be in Shelved stage to resume.');
        }

        // D-08: Unshelve gate — at least 1 non-coach, non-spectator player per team present
        const members = [...ctx.db.LobbyMember.lobby_id.filter(lobbyId)];

        const bluePresent = members.some((m: any) => {
            if (m.voluntarilyLeft) return false;
            return slotTeam(m.lobbySlot) === 'Blue' && !slotIsCoach(m.lobbySlot) && !slotIsSpectator(m.lobbySlot);
        });

        const redPresent = members.some((m: any) => {
            if (m.voluntarilyLeft) return false;
            return slotTeam(m.lobbySlot) === 'Red' && !slotIsCoach(m.lobbySlot) && !slotIsSpectator(m.lobbySlot);
        });

        if (!bluePresent || !redPresent) {
            throw new SenderError('Cannot resume: at least 1 player per team must be present.');
        }

        // Transition: Shelved -> BetweenGames
        ctx.db.Lobby.id.update(updateWithAudit(ctx, lobby, {
            stage: { tag: 'BetweenGames', value: {} } as any,
            lastActivityAt: ctx.timestamp,
        }, user.id));

        // System chat message
        ctx.db.ChatMessage.insert(insertWithAudit(ctx, {
            id: 0,
            lobbyId,
            senderUserId: 0,
            senderType: { tag: 'System', value: {} } as any,
            content: 'Series resumed.',
            metadata: undefined,
            anonymousLabel: undefined,
        }, user.id));

        console.log(`[SERIES] Lobby #${lobbyId} resumed by user #${user.id}`);
    }
);
