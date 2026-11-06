import { table, t } from 'spacetimedb/server';

/**
 * Stores sensitive auth provider data for each user.
 * Private (public: false) — never exposed to client subscriptions.
 * 1:1 with User (userId is both PK and FK to User.id).
 * D-01, CR-01
 */
export const userPrivateColumns = {
    userId: t.u32().primaryKey(),       // FK to User.id (1:1)
    discordId: t.string().optional(),
    discordUsername: t.string().optional(),
    email: t.string().optional(),        // schema-only, not populated (D-01)
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

export const UserPrivate = table({
    name: 'user_private',
    public: false,      // CR-01: MUST be explicit
    indexes: [
        { accessor: 'user_private_discord_id', algorithm: 'btree', columns: ['discordId'] },
    ],
}, userPrivateColumns);
