import { table, t } from 'spacetimedb/server';

/**
 * Per-identity presence (S3; A48, ACCESS-SECURITY-OPS D-A1 / CH-S2).
 *
 * One row per connected identity (device), keyed by the identity itself, rather than a per-user
 * connection count:
 * - A count drifts: a missed `client_disconnected` (host restart, module crash, a hook that threw)
 *   leaves the user "online" forever and the A22a referee transfer never fires. A per-identity row keeps
 *   the damage to one wrong bit for one device (see the staleness rule below).
 * - The 2.10.2 session takeover (a second connection on the same token runs the old connection's
 *   `client_disconnected`, then accepts the new one) touches the same row twice and ends `isOnline = true`,
 *   with no decrement/increment pair to get out of order.
 * - "User online" = any row of that user with `isOnline = true` (`user_id` index); `LobbyMember.isOnline`
 *   follows that value, so closing one device while another is connected never shows the player offline.
 *
 * Writers (A48): `client_connected` upserts `{ identity, userId, isOnline: true, lastLoginAt: now,
 * lastSeenAt: now }` once the UserIdentity mapping exists; `login_as_guest` does the same for a fresh guest
 * (its connect preceded the mapping); `confirm_link` rewrites `userId` + `lastLoginAt` when it
 * re-points an identity to another user; `client_disconnected` sets `isOnline = false, lastSeenAt = now` on
 * the one row and, only when the user has no other live row, marks the active-stage memberships offline and
 * inserts the RefereeTransferCheck; identity GC and user deletion delete the rows with the identity;
 * `server_set_online` (test only) forces every identity row of the user.
 *
 * Staleness rule (S3 review L3): a live row whose disconnect was missed is NOT self-correcting on its own.
 * It is corrected by that identity's next `client_connected` / `client_disconnected`, by identity GC when it
 * removes the identity, or by `server_set_online` on the test database. There is no heartbeat (energy, A16):
 * until one of those runs, the user reads as online on that device and the A22a check does not fire.
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
