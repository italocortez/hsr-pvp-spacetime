import { table, t } from 'spacetimedb/server';

/**
 * Stores the auth-provider identity of a verified user.
 * Private (public: false) — never exposed to client subscriptions.
 * 1:1 with User (userId is both PK and FK to User.id); a row exists only once a provider is linked.
 * D-01, CR-01
 *
 * S3 (A46): generalized from discordId/discordUsername to loginMethod + providerId + providerUsername,
 * the shape of the SpacetimeAuth token claims (`login_method`, `provider_id`, `preferred_username`), so a
 * later switch to SpacetimeAuth needs no schema change. Policy stays Discord-only at launch (reducer check).
 * `email` was dropped (D-B4): never written, one less personal-data column.
 */
export const userPrivateColumns = {
    userId: t.u32().primaryKey(),       // FK to User.id (1:1)
    loginMethod: t.string(),            // 'discord' today; mirrors the token's login_method claim
    providerId: t.string(),             // the provider's user id (Discord snowflake)
    providerUsername: t.string(),       // display name at link time
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

export const UserPrivate = table({
    name: 'user_private',
    public: false,      // CR-01: MUST be explicit
    indexes: [
        { accessor: 'provider_id', algorithm: 'btree', columns: ['providerId'] },
        { accessor: 'by_method_and_provider', algorithm: 'btree', columns: ['loginMethod', 'providerId'] },
    ],
}, userPrivateColumns);
