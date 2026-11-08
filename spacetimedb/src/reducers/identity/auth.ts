import spacetimedb from '@module/schema';
import { SYSTEM_USER_ID } from '@module/helpers/admin/auditColumns';
import { insertWithAudit, updateWithAudit } from '@module/helpers/admin/auditHelpers';
import { markPresenceOnline } from '@module/helpers/identity/presenceHelpers';

/**
 * Login as a guest user.
 * - If identity already linked → bump UserIdentity.lastSeenAt (presence was written by client_connected).
 * - Otherwise → create a new User + UserIdentity mapping and the UserPresence row (A48): the fresh guest's
 *   connect ran before the mapping existed, so client_connected could not write it.
 */
export const login_as_guest = spacetimedb.reducer((ctx) => {
    const mapping = ctx.db.UserIdentity.identity.find(ctx.sender);
    if (mapping) {
        const user = ctx.db.User.id.find(mapping.userId);
        if (user) {
            // Already registered — bump lastSeenAt; isOnline / lastLoginAt live on UserPresence (client_connected)
            ctx.db.UserIdentity.identity.update(
                updateWithAudit(ctx, mapping, { lastSeenAt: ctx.timestamp }, user.id),
            );
            return;
        }
    }

    // Generate a guest username from the identity hex (first 8 chars)
    const shortId = ctx.sender.toHexString().slice(0, 8);
    const guestUsername = `Guest_${shortId}`;

    // Create the User row (id is autoInc, pass 0)
    const newUser = ctx.db.User.insert(insertWithAudit(ctx, {
        id: 0,
        username: guestUsername,
        displayName: guestUsername,
        isGuest: true,
        role: { tag: 'User' },
        hasDiscordLinked: false,
        avatarCharacterName: 'march7th',
        displayedAchievementId: undefined,
        deletedAt: undefined,
    }, SYSTEM_USER_ID));

    // Link this identity to the new user
    ctx.db.UserIdentity.insert(insertWithAudit(ctx, {
        identity: ctx.sender,
        userId: newUser.id,
        lastSeenAt: ctx.timestamp,
    }, newUser.id));

    // A48: this identity's presence row; its connect preceded the mapping
    markPresenceOnline(ctx, ctx.sender, newUser.id);
});
