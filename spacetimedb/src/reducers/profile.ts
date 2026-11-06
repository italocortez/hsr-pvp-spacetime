import spacetimedb from '../schema';
import { t, SenderError } from 'spacetimedb/server';
import { updateWithAudit } from '../helpers/auditHelpers';

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
 * Delete a guest account permanently.
 * Only works for guest users (no Discord linked).
 * Removes the UserIdentity mapping and the User row.
 */
export const delete_guest_account = spacetimedb.reducer((ctx) => {
    const resolved = resolveUser(ctx);
    if (!resolved) {
        throw new SenderError('No account found for this identity.');
    }
    if (!resolved.user.isGuest) {
        throw new SenderError('Only guest accounts can be deleted this way. Verified accounts persist across devices.');
    }

    // Delete the UserIdentity mapping for this identity
    ctx.db.UserIdentity.identity.delete(ctx.sender);

    // Check if any other identities still point to this user
    const remainingLinks = [...ctx.db.UserIdentity.user_id.filter(resolved.user.id)];
    if (remainingLinks.length === 0) {
        // No more identities linked — safe to delete the User row
        ctx.db.User.id.delete(resolved.user.id);
    }
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
