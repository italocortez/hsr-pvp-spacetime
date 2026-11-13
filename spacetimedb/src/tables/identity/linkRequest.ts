import { table, t } from 'spacetimedb/server';

/**
 * One-time link codes for the guest -> verified merge (S3; A44(3) / A46, MIGRATION-PLAN 4.6 step 1).
 *
 * A connected guest calls `request_link_code()` (M5a): a row with a random code, the requesting
 * identity and user, and a 5-minute expiry. The Vercel auth function completes the Discord OAuth exchange
 * and calls `server_link_by_code({ linkCode, ... })` with the delegate token; the module resolves the code
 * back to the identity, so the browser's SpacetimeDB token never leaves the browser.
 * Single use (a spent code's row is deleted; `usedAt` has no writer and is read as "used" if ever set), one live
 * request per identity (unique); stale rows are swept (helpers/identity/linkCode.ts, docs/auth/architecture.md M5a).
 * Private: the caller reads its own row through `view_my_link_request` (M5a).
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
