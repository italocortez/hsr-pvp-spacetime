import spacetimedb from '@module/schema';
import { t, SenderError } from 'spacetimedb/server';
import { getAuthenticatedUser } from '@module/helpers/identity/ensurePermissions';
import { ensureMemberPresent, slotIsCoach, slotIsSpectator } from '@module/helpers/lobby/lobbyHelpers';

// ─── select_match_account ─────────────────────────────────────────────────────
// Sets the HSR account a lobby member will use for the current match.
//
// Tournament path (D-05): validates the account is locked in TournamentPlayerAccount
// and enforces the Tournament.maxAccountsPerPlayer limit. Multiple accounts allowed
// (for asymmetric formats like 1v2). Additive — does NOT replace existing selections.
//
// Non-tournament path (D-07): validates account ownership only. Replace behavior —
// deletes all existing selections before inserting, enforcing max 1 account.
//
// Stage guard (D-06): only allowed during Waiting (A67(1): one game per lobby).
// A69(3): the D-B-03 snapshot ratchet is gone; the snapshot is taken once at start_draft (A66).

export const select_match_account = spacetimedb.reducer(
    {
        lobbyId: t.u32(),
        hsrAccountId: t.u32(),
    },
    (ctx, { lobbyId, hsrAccountId }) => {
        const user = getAuthenticatedUser(ctx);

        // Look up lobby
        const lobby = ctx.db.Lobby.id.find(lobbyId);
        if (!lobby) throw new SenderError('Lobby not found.');

        // Look up lobby member
        const member = [...ctx.db.LobbyMember.by_lobby_and_user.filter([lobbyId, user.id])][0];
        if (!member) throw new SenderError('You are not a member of this lobby.');
        ensureMemberPresent(member); // A98

        // Stage guard (D-06): Waiting only (A67(1))
        if (lobby.stage.tag !== 'Waiting') {
            throw new SenderError('Account selection is only allowed during the Waiting stage.');
        }

        // Spectator guard
        if (slotIsSpectator(member.lobbySlot)) {
            throw new SenderError('Spectators cannot select match accounts.');
        }

        // Coach guard
        if (slotIsCoach(member.lobbySlot)) {
            throw new SenderError('Coaches cannot select match accounts.');
        }

        // Validate account exists and is owned by caller
        const account = ctx.db.HsrAccount.id.find(hsrAccountId);
        if (!account) throw new SenderError('HSR account not found.');
        if (account.userId !== user.id) throw new SenderError('This is not your account.');

        if (lobby.isTournamentControlled && lobby.tournamentId) {
            // Tournament path (D-05, D-11)
            // Account must be locked in TournamentPlayerAccount
            const tpa = [...ctx.db.TournamentPlayerAccount.by_tournament_and_user.filter([lobby.tournamentId, user.id])];
            const lockedEntry = tpa.find((e: any) => e.hsrAccountId === hsrAccountId);
            if (!lockedEntry) {
                throw new SenderError('This account is not locked for this tournament. Use a registered tournament account.');
            }

            // Look up tournament for maxAccountsPerPlayer limit
            const tournament = ctx.db.Tournament.id.find(lobby.tournamentId);

            // Get current selected accounts for this user in this lobby
            const currentAccounts = [...ctx.db.LobbyMemberAccount.by_lobby_and_user.filter([lobbyId, user.id])];

            // Check if this account is already selected
            if (currentAccounts.some((a: any) => a.hsrAccountId === hsrAccountId)) {
                throw new SenderError('This account is already selected for this match.');
            }

            // Check maxAccountsPerPlayer limit (D-10, D-11)
            if (currentAccounts.length >= (tournament?.maxAccountsPerPlayer ?? 1)) {
                throw new SenderError('Maximum accounts per player reached for this tournament.');
            }

            // Insert new selection (additive for tournament — no replace)
            ctx.db.LobbyMemberAccount.insert({ lobbyId, userId: user.id, hsrAccountId });
        } else {
            // Non-tournament path (D-07): replace behavior — delete existing + insert new
            for (const existing of [...ctx.db.LobbyMemberAccount.by_lobby_and_user.filter([lobbyId, user.id])]) {
                ctx.db.LobbyMemberAccount.delete(existing);
            }
            ctx.db.LobbyMemberAccount.insert({ lobbyId, userId: user.id, hsrAccountId });
        }

        console.log(`[ACCOUNT] User #${user.id} selected account #${hsrAccountId} for lobby #${lobbyId}`);
    }
);

// ─── deselect_match_account ───────────────────────────────────────────────────
// Removes a specific HSR account selection from a lobby member.
// Primarily used in tournament multi-account mode to remove one of multiple selections.
// Non-tournament lobbies can also deselect (leaving them with no account selected).

export const deselect_match_account = spacetimedb.reducer(
    {
        lobbyId: t.u32(),
        hsrAccountId: t.u32(),
    },
    (ctx, { lobbyId, hsrAccountId }) => {
        const user = getAuthenticatedUser(ctx);

        // Look up lobby
        const lobby = ctx.db.Lobby.id.find(lobbyId);
        if (!lobby) throw new SenderError('Lobby not found.');

        // Look up lobby member
        const member = [...ctx.db.LobbyMember.by_lobby_and_user.filter([lobbyId, user.id])][0];
        if (!member) throw new SenderError('You are not a member of this lobby.');
        ensureMemberPresent(member); // A98

        // Stage guard (D-06): Waiting only (A67(1))
        if (lobby.stage.tag !== 'Waiting') {
            throw new SenderError('Account deselection is only allowed during the Waiting stage.');
        }

        // Find the specific LobbyMemberAccount row to delete
        const row = [...ctx.db.LobbyMemberAccount.by_lobby_and_user.filter([lobbyId, user.id])]
            .find((r: any) => r.hsrAccountId === hsrAccountId);
        if (!row) throw new SenderError('This account is not selected for this match.');

        ctx.db.LobbyMemberAccount.delete(row);

        console.log(`[ACCOUNT] User #${user.id} deselected account #${hsrAccountId} for lobby #${lobbyId}`);
    }
);
