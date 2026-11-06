import { table, t } from 'spacetimedb/server';

/**
 * One-time link codes for the guest -> verified merge (S3; A44(3) / A46, MIGRATION-PLAN 4.6 step 1).
 *
 * A connected guest calls `request_link_code()` (M5): a row with a short random code, the requesting
 * identity and user, and a 5-minute expiry. The Vercel auth function completes the Discord OAuth exchange
 * and calls `server_link_provider({ linkCode, ... })` with the delegate token; the module resolves the code
 * back to the identity, so the browser's SpacetimeDB token never leaves the browser.
 * Single use (`usedAt`), one live request per identity (unique), rows expire and are cleaned up by M5.
 * Private: the caller reads its own row through `view_my_link_request` (M5/S9).
 */
export const linkRequestColumns = {
    code: t.string().primaryKey(),
    identity: t.identity().unique(),
    userId: t.u32(),
    expiresAt: t.timestamp(),
    usedAt: t.timestamp().optional(),
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

export const LinkRequest = table({
    name: 'link_request',
    public: false,
    indexes: [
        { accessor: 'user_id', algorithm: 'btree', columns: ['userId'] },
    ],
}, linkRequestColumns);
