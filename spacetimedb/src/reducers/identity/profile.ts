import spacetimedb from '@module/schema';
import { t, SenderError } from 'spacetimedb/server';
import { updateWithAudit } from '@module/helpers/admin/auditHelpers';
import { performUserDeletion } from '@module/helpers/identity/userDeletionHelper';
import { membershipHold } from '@module/helpers/lobby/lobbyHelpers';

/**
 * Helper: resolve ctx.sender → UserIdentity → User.
 * Returns { mapping, user } or null if identity is not linked.
 */
function resolveUser(ctx: any) {
    const mapping = ctx.db.UserIdentity.identity.find(ctx.sender);
    if (!mapping) return null;
    const user = ctx.db.User.id.find(mapping.userId);
    if (!user) return null;
    return { mapping, user };
}

/**
 * A45(3): delete the caller's own account. Replaces delete_guest_account.
 *
 * Guests keep the old delete_guest_account behaviour: the caller's UserIdentity mapping is removed, and the User row
 * too once no other identity points at it.
 *
 * Verified users: rejected while they sit in a lobby (as ensureNotInLobby counts it, an away membership included, A68(4)), or hold an enrollment in a
 * tournament that is not Completed / Cancelled (Withdrawn and Disqualified enrollments do not block). Otherwise the
 * deletion cascades through performUserDeletion at once (UserPrivate, calendars, presence, rate state, identities,
 * HSR accounts; the User row is archived to DeletedUser when history references it).
 */
export const delete_my_account = spacetimedb.reducer((ctx) => {
    const resolved = resolveUser(ctx);
    if (!resolved) {
        throw new SenderError('No account found for this identity.');
    }
    const user = resolved.user;

    if (user.isGuest) {
        // Delete the UserIdentity mapping for this identity and its presence row (A48)
        ctx.db.UserIdentity.identity.delete(ctx.sender);
        if (ctx.db.UserPresence.identity.find(ctx.sender)) ctx.db.UserPresence.identity.delete(ctx.sender);

        // No other identity points at this user: run the full cascade (UserPrivate, calendars, remaining presence
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
    for (const enrollment of ctx.db.TournamentEnrolled.user_id.filter(user.id)) {
        if (enrollment.status.tag === 'Withdrawn' || enrollment.status.tag === 'Disqualified') continue;
        const tournament = ctx.db.Tournament.id.find(enrollment.tournamentId);
        if (tournament && tournament.stage.tag !== 'Completed' && tournament.stage.tag !== 'Cancelled') {
            throw new SenderError('You are enrolled in a tournament that has not finished. Withdraw first, or wait until it ends.');
        }
    }

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
    const trimmed = newDisplayName.trim();
    if (trimmed.length === 0) {
        throw new SenderError('Display name cannot be empty');
    }
    if (trimmed.length > 32) {
        throw new SenderError('Display name must be 32 characters or fewer');
    }

    const resolved = resolveUser(ctx);
    if (!resolved) {
        throw new SenderError('User not found — login first');
    }

    ctx.db.User.id.update(updateWithAudit(ctx, resolved.user, {
        displayName: trimmed,
    }, resolved.user.id));

    // Lazy sync: update TournamentTeam.name for active solo non-anonymous tournaments
    // A solo player's team name = their displayName (invisible team for bracket purposes)
    for (const team of [...ctx.db.TournamentTeam.captain_user_id.filter(resolved.user.id)]) {
        const tournament = ctx.db.Tournament.id.find(team.tournamentId);
        if (!tournament) continue;
        // Only sync if: tournament is active (not Completed/Cancelled), solo tournament, and not anonymous
        const isActive = tournament.stage.tag !== 'Completed' && tournament.stage.tag !== 'Cancelled';
        const isSolo = tournament.teamSize === 1;
        const isNotAnonymous = !tournament.isAnonymousDefault;
        if (isActive && isSolo && isNotAnonymous) {
            ctx.db.TournamentTeam.id.update(updateWithAudit(ctx, team, {
                name: trimmed,
            }, resolved.user.id));
        }
    }
});

/**
 * Update the caller's username.
 * Only verified (non-guest) users with a linked Discord can change their username.
 * Uniqueness is enforced by the database constraint.
 */
export const update_username = spacetimedb.reducer({
    newUsername: t.string(),
}, (ctx, { newUsername }) => {
    const trimmed = newUsername.trim();
    if (trimmed.length === 0) {
        throw new SenderError('Username cannot be empty');
    }
    if (trimmed.length > 32) {
        throw new SenderError('Username must be 32 characters or fewer');
    }

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
});
