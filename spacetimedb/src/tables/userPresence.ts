import { table, t } from 'spacetimedb/server';

/**
 * Per-identity presence (S3; A48, ACCESS-SECURITY-OPS D-A1 / CH-S2).
 *
 * One row per connected identity (device), keyed by the identity itself, rather than a per-user
 * connection count:
 * - A count drifts: a missed `client_disconnected` (host restart, module crash, a hook that threw)
 *   leaves the user "online" forever and the A22a referee transfer never fires. A per-identity row
 *   self-heals: the next connect or disconnect of that identity rewrites its own row, and identity GC
 *   removes it with the identity.
 * - The 2.10.2 session takeover (a second connection on the same token runs the old connection's
 *   `client_disconnected`, then accepts the new one) touches the same row twice and ends `isOnline = true`,
 *   with no decrement/increment pair to get out of order.
 * - "User online" = any row of that user with `isOnline = true` (`user_id` index); `LobbyMember.isOnline`
 *   follows that value, so closing one device while another is connected never shows the player offline.
 *
 * S4 contract: `client_connected` upserts `{ identity, userId, isOnline: true, lastLoginAt: now, lastSeenAt: now }`
 * (after `login_as_guest` / the link flow created the UserIdentity mapping); `client_disconnected` sets
 * `isOnline = false, lastSeenAt = now` on the one row and inserts the RefereeTransferCheck only when the
 * user has no other live row; identity GC and user deletion delete the rows with the identity.
 * Private: only `view_admin_presence` (S9) reads it.
 */
export const userPresenceColumns = {
    identity: t.identity().primaryKey(),
    userId: t.u32(),
    isOnline: t.bool(),
    lastLoginAt: t.timestamp(),
    lastSeenAt: t.timestamp(),
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

export const UserPresence = table({
    name: 'user_presence',
    public: false,
    indexes: [
        { accessor: 'user_id', algorithm: 'btree', columns: ['userId'] },
    ],
}, userPresenceColumns);
