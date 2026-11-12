import spacetimedb from '@module/schema';
import { t, SenderError } from 'spacetimedb/server';
import { updateWithAudit } from '@module/helpers/admin/auditHelpers';
import { performUserDeletion } from '@module/helpers/identity/userDeletionHelper';
import { membershipHold } from '@module/helpers/lobby/lobbyHelpers';
import { syncSoloTeamNames } from '@module/helpers/tournament/tournamentHelpers';
import { checkDisplayName, checkUsername } from '@module/helpers/identity/usernames';
import { syncLeaderboardCard } from '@module/helpers/stats/leaderboardRebuild';
import { ensureNotInMaintenance } from '@module/helpers/identity/ensurePermissions';

/**
 * Helper: resolve ctx.sender → UserIdentity → User.
 * Returns { mapping, user } or null if identity is not linked.
 */
function resolveUser(ctx: any) {
    const mapping = ctx.db.UserIdentity.identity.find(ctx.sender);
    const user = mapping ? ctx.db.User.id.find(mapping.userId) : undefined;
    ensureNotInMaintenance(ctx, user); // A163(3) (S11a): only an Admin acts while maintenance mode is on
    if (!mapping || !user) return null;
    return { mapping, user };
}

/**
 * A45(3): delete the caller's own account. Replaces delete_guest_account.
 *
 * Guests keep the old delete_guest_account behaviour: the caller's UserIdentity mapping is removed, and the User row
 * too once no other identity points at it.
 *
 * A94(1) (S10g): both branches reject the organizer of a tournament that is not Completed or Cancelled. A94(2): the
 * cascade (performUserDeletion) settles every remaining tournament tie (withdrawal before the bracket, DQ after it).
 *
 * Verified users: rejected while they sit in a lobby (as ensureNotInLobby counts it, an away membership included, A68(4)).
 * A live tournament enrolment does not block (A94(2), S10g review F1): the cascade withdraws or disqualifies. The
 * deletion cascades through performUserDeletion at once (calendars, presence, rate state, identities,
 * HSR accounts; the User row is archived to DeletedUser when history references it).
 */
export const delete_my_account = spacetimedb.reducer((ctx) => {
    const resolved = resolveUser(ctx);
    if (!resolved) {
        throw new SenderError('No account found for this identity.');
    }
    const user = resolved.user;

    // A94(1): the organizer of a tournament that is not Completed or Cancelled cannot delete the account (guest and
    // verified branch alike). Tournament.organizer_id btree index.
    for (const tournament of ctx.db.Tournament.organizer_id.filter(user.id)) {
        if (tournament.stage.tag !== 'Completed' && tournament.stage.tag !== 'Cancelled') {
            throw new SenderError('You organize a tournament that has not finished. Cancel it, or wait until it ends, before deleting your account.');
        }
    }

    if (user.isGuest) {
        // Delete the UserIdentity mapping for this identity and its presence row (A48)
        ctx.db.UserIdentity.identity.delete(ctx.sender);
        if (ctx.db.UserPresence.identity.find(ctx.sender)) ctx.db.UserPresence.identity.delete(ctx.sender);

        // No other identity points at this user: run the full cascade (calendars, remaining presence
        // rows, UserRateState, HSR accounts, then the User row or its DeletedUser archive when history references it).
        const remainingLinks = [...ctx.db.UserIdentity.user_id.filter(user.id)];
        if (remainingLinks.length === 0) {
            performUserDeletion(ctx, user.id, user.id);
        }
        return;
    }

    // Same notion of "in a lobby" as ensureNotInLobby (D-22, A68(4)): AwaitingResult lobbies and abandoned rows do
    // not count; an away membership (A68(2)) blocks deletion like any other (there is no abandon option here).
    for (const membership of ctx.db.LobbyMember.user_id.filter(user.id)) {
        if (membershipHold(ctx, membership).kind !== 'free') {
            throw new SenderError('Leave your lobby before deleting your account.');
        }
    }
    // A94(2) (S10g review F1): a live tournament enrolment no longer blocks the deletion; performUserDeletion settles
    // it (withdrawn before the bracket exists, disqualified once it exists), as for a guest.
    performUserDeletion(ctx, user.id, user.id);
    console.log(`[DELETE] User #${user.id} deleted their own account.`);
});

/**
 * Update the caller's display name.
 * Only non-empty strings are accepted. Max 32 characters.
 */
export const update_display_name = spacetimedb.reducer({
    newDisplayName: t.string(),
}, (ctx, { newDisplayName }) => {
    // S10r (A122(1)): the name rules live in checkDisplayName, shared with admin_update_user.
    const trimmed = checkDisplayName(newDisplayName);

    const resolved = resolveUser(ctx);
    if (!resolved) {
        throw new SenderError('User not found — login first');
    }

    ctx.db.User.id.update(updateWithAudit(ctx, resolved.user, {
        displayName: trimmed,
    }, resolved.user.id));

    // Lazy sync of the solo team names (S10r, A122(1): the loop moved to syncSoloTeamNames, shared with
    // admin_update_user).
    syncSoloTeamNames(ctx, resolved.user.id, trimmed, resolved.user.id);
    syncLeaderboardCard(ctx, resolved.user.id); // A77 (S11a): the public leaderboard carries the name
});

/**
 * Update the caller's username.
 * Only verified (non-guest) users with a linked Discord can change their username.
 * Uniqueness is enforced by the database constraint.
 */
export const update_username = spacetimedb.reducer({
    newUsername: t.string(),
}, (ctx, { newUsername }) => {
    // S10r (A122(1)): the name rules live in checkUsername, shared with admin_update_user.
    const trimmed = checkUsername(newUsername);

    const resolved = resolveUser(ctx);
    if (!resolved) {
        throw new SenderError('User not found — login first');
    }
    if (resolved.user.isGuest) {
        throw new SenderError('Guest users cannot change their username. Link your Discord account first.');
    }

    // Pre-check uniqueness. Without this the unique-index violation surfaces
    // to the client as the opaque "The instance encountered a fatal error."
    if (trimmed !== resolved.user.username) {
        const existing = ctx.db.User.username.find(trimmed);
        if (existing) {
            throw new SenderError(`Username "${trimmed}" is already taken.`);
        }
    }

    ctx.db.User.id.update(updateWithAudit(ctx, resolved.user, {
        username: trimmed,
    }, resolved.user.id));
});

/**
 * Update the caller's avatar character.
 * Validates that the characterName exists in the HsrCharacter table.
 */
export const update_avatar = spacetimedb.reducer({
    characterName: t.string(),
}, (ctx, { characterName }) => {
    const resolved = resolveUser(ctx);
    if (!resolved) {
        throw new SenderError('User not found — login first');
    }

    // Validate character exists in the HsrCharacter table
    const character = ctx.db.HsrCharacter.name.find(characterName);
    if (!character) {
        throw new SenderError(`Character "${characterName}" not found. Please select a valid character.`);
    }

    ctx.db.User.id.update(updateWithAudit(ctx, resolved.user, {
        avatarCharacterName: characterName,
    }, resolved.user.id));
    syncLeaderboardCard(ctx, resolved.user.id); // A77 (S11a): the public leaderboard carries the avatar
});
