import spacetimedb from '../schema';
import { t, SenderError } from 'spacetimedb/server';
import { getAuthenticatedUser } from '../helpers/ensurePermissions';
import { slotIsCoach, slotIsSpectator } from '../helpers/lobbyHelpers';
import { updateWithAudit } from '../helpers/auditHelpers';

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
// Stage guard (D-06): only allowed during Waiting or BetweenGames stages.

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

        // Stage guard (D-06): Waiting and BetweenGames only
        if (lobby.stage.tag !== 'Waiting' && lobby.stage.tag !== 'BetweenGames') {
            throw new SenderError('Account selection is only allowed during Waiting or BetweenGames stages.');
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

        // D-B-03 (Phase 12.3): monotonic-upward snapshot update for BetweenGames account swaps.
        // Gated by MRP existence, not lobby stage:
        //   - Waiting stage: no MatchResultRecord yet (created at draftClassic.ts:178 inside
        //     start_draft). The lookup returns empty -> this block is a no-op. Pre-draft
        //     swaps are harmless because MRP rows don't exist yet (D-B-04).
        //   - BetweenGames stage: MRR exists, MRP exists -> apply max rule.
        //   - Stand-ins joining after start_draft: LMA row seeded on join but no MRP row
        //     for them (MRP only inserted at start_draft:204). This block short-circuits
        //     at `if (!existingMrp) return;`. Stand-ins are intentionally excluded from
        //     MMR attribution here (D-B-05, D-B-06) — mid-series stand-in MMR is deferred.
        //   - `deselect_match_account` does NOT run this hook (removing an account from
        //     the selection can never lower the max — D-B-03).
        const mr = [...ctx.db.MatchResultRecord.lobby_id.filter(lobbyId)][0];
        if (mr) {
            const existingMrp = [...ctx.db.MatchResultParticipant.by_result_and_user.filter([mr.id, user.id])][0];
            if (existingMrp) {
                const freshAccount = ctx.db.HsrAccount.id.find(hsrAccountId);
                if (freshAccount) {
                    const newSnapshot = Math.max(existingMrp.accountRatingSnapshot, freshAccount.accountRating);
                    if (newSnapshot !== existingMrp.accountRatingSnapshot) {
                        ctx.db.MatchResultParticipant.delete(existingMrp);
                        ctx.db.MatchResultParticipant.insert(
                            updateWithAudit(ctx, existingMrp, { accountRatingSnapshot: newSnapshot }, user.id),
                        );
                    }
                }
            }
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

        // Stage guard (D-06): Waiting and BetweenGames only
        if (lobby.stage.tag !== 'Waiting' && lobby.stage.tag !== 'BetweenGames') {
            throw new SenderError('Account deselection is only allowed during Waiting or BetweenGames stages.');
        }

        // Find the specific LobbyMemberAccount row to delete
        const row = [...ctx.db.LobbyMemberAccount.by_lobby_and_user.filter([lobbyId, user.id])]
            .find((r: any) => r.hsrAccountId === hsrAccountId);
        if (!row) throw new SenderError('This account is not selected for this match.');

        ctx.db.LobbyMemberAccount.delete(row);

        console.log(`[ACCOUNT] User #${user.id} deselected account #${hsrAccountId} for lobby #${lobbyId}`);
    }
);
