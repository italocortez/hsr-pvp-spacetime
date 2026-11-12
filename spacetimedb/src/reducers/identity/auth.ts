import spacetimedb from '@module/schema';
import { SYSTEM_USER_ID } from '@module/helpers/admin/auditColumns';
import { insertWithAudit, updateWithAudit } from '@module/helpers/admin/auditHelpers';
import { markPresenceOnline } from '@module/helpers/identity/presenceHelpers';
import { recordGuestCreation } from '@module/helpers/lobby/abuseControls';
import { guestUsernameBase, uniqueUsername } from '@module/helpers/identity/usernames';
import { ensureNotInMaintenance } from '@module/helpers/identity/ensurePermissions';

/**
 * Login as a guest user.
 * - If identity already linked → bump UserIdentity.lastSeenAt (presence was written by client_connected).
 * - Otherwise → create a new User + UserIdentity mapping and the UserPresence row (A48): the fresh guest's
 *   connect ran before the mapping existed, so client_connected could not write it.
 * - A95(2): a new guest user is counted by the guest creation breaker (recordGuestCreation): rejected while
 *   AbuseConfig.guestCreationEnabled is off; the creation that crosses the threshold trips it. A returning guest (the
 *   first branch) is never counted or blocked.
 * - Identity audit #10: a mapping whose User row is gone (orphan) is repointed to the new user instead of inserting a
 *   second row with the same identity (which aborted the call on the primary key).
 * - S10h: the username is "Guest_" + the last 8 hex characters of the identity, made unique (uniqueUsername) so the
 *   insert never aborts on the unique User.username index.
 */
export const login_as_guest = spacetimedb.reducer((ctx) => {
    const mapping = ctx.db.UserIdentity.identity.find(ctx.sender);
    // A163(3) (S11a): while maintenance mode is on only an Admin acts; no guest is created or refreshed.
    ensureNotInMaintenance(ctx, mapping ? ctx.db.User.id.find(mapping.userId) : undefined);
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

    // A95(2): guest creation breaker (throws while the switch is off)
    recordGuestCreation(ctx);

    // A guest username from the identity hex: "Guest_" + its last 8 characters (the first ones are a fixed tag and a
    // short checksum, guestUsernameBase); on a collision with any existing username the first free "_2", "_3", ...
    // variant (uniqueUsername), so a guest login never aborts on the unique User.username index.
    const guestUsername = uniqueUsername(ctx, guestUsernameBase(ctx.sender.toHexString()), -1);

    // Create the User row (id is autoInc, pass 0)
    const newUser = ctx.db.User.insert(insertWithAudit(ctx, {
        id: 0,
        username: guestUsername,
        displayName: guestUsername,
        isGuest: true,
        role: { tag: 'User' },
        avatarCharacterName: 'march7th',
        displayedAchievementId: undefined,
        deletedAt: undefined,
        loginMethod: undefined,      // A77: no provider linked yet
        providerId: undefined,
        providerUsername: undefined,
        linkedAt: undefined,
    }, SYSTEM_USER_ID));

    // Link this identity to the new user (identity audit #10: an orphan mapping is repointed, not duplicated)
    if (mapping) {
        ctx.db.UserIdentity.identity.update(
            updateWithAudit(ctx, mapping, { userId: newUser.id, lastSeenAt: ctx.timestamp }, newUser.id),
        );
    } else {
        ctx.db.UserIdentity.insert(insertWithAudit(ctx, {
            identity: ctx.sender,
            userId: newUser.id,
            lastSeenAt: ctx.timestamp,
        }, newUser.id));
    }

    // A48: this identity's presence row; its connect preceded the mapping
    markPresenceOnline(ctx, ctx.sender, newUser.id);
});
