import { table, t } from 'spacetimedb/server';

/**
 * Maps SpacetimeDB identities (per-device) to persistent User IDs (many-to-one).
 * Each device/browser generates a unique identity; this table links them all
 * back to a single User record.
 */
export const userIdentityColumns = {
    identity: t.identity().primaryKey(),
    userId: t.u32(),
    lastSeenAt: t.timestamp(), // For future cleanup of stale identity mappings
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

export const UserIdentity = table({
    name: 'user_identity',
    public: false,    // D-14: private -- clients use view_my_identity instead
    indexes: [
        { accessor: 'user_id', algorithm: 'btree', columns: ['userId'] },
    ]
}, userIdentityColumns);
