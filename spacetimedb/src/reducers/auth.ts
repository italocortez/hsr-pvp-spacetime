import spacetimedb from '../schema';
import { SYSTEM_USER_ID } from '../helpers/auditColumns';
import { insertWithAudit, updateWithAudit } from '../helpers/auditHelpers';

/**
 * Login as a guest user.
 * - If identity already linked → update lastLoginAt (no-op).
 * - Otherwise → create a new User + UserIdentity mapping.
 */
export const login_as_guest = spacetimedb.reducer((ctx) => {
    const mapping = ctx.db.UserIdentity.identity.find(ctx.sender);
    if (mapping) {
        const user = ctx.db.User.id.find(mapping.userId);
        if (user) {
            // Already registered — update lastLoginAt and lastSeenAt
            ctx.db.User.id.update(
                updateWithAudit(ctx, user, { lastLoginAt: ctx.timestamp, isOnline: true }, user.id),
            );
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
        isOnline: true,
        lastLoginAt: ctx.timestamp,
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
});
