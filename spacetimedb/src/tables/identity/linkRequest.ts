import { table, t } from 'spacetimedb/server';

/**
 * One-time link codes for the guest -> verified merge (S3; A44(3) / A46, MIGRATION-PLAN 4.6 step 1).
 *
 * A connected guest calls `request_link_code()` (M5a): a row with a random code, the requesting
 * identity and user, and a 5-minute expiry. The Vercel auth function completes the Discord OAuth exchange
 * and calls `linker_present_code({ linkCode, ... })` with the linker token (M5a3); the module resolves the code
 * back to the identity, so the browser's SpacetimeDB token never leaves the browser.
 * M5a2 (the second lock): the function's call no longer links. It presents the code once: `usedAt` is set, the
 * Discord account is stored in the pending columns with `confirmHash` (base64url SHA-256 of a one-time token the
 * function gave to the browser that finished Discord), and `expiresAt` moves to now + 2 minutes. The requesting
 * identity then calls `confirm_link({ confirmToken })`, which links and deletes the row.
 * One live request per identity (unique); a row is stale once `expiresAt` passes and is swept
 * (helpers/identity/linkCode.ts, docs/auth/architecture.md M5a / M5a2).
 * Private: the caller reads its own row through `view_my_link_request` (never the hash or the provider id).
 * The four pending columns are appended at the end with a default (None), so an existing table can migrate in place.
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
    // M5a2: the pending stage, set by linker_present_code (appended last, default None: an additive migration)
    pendingProvider: t.string().optional().default(undefined),
    pendingProviderId: t.string().optional().default(undefined),
    pendingProviderName: t.string().optional().default(undefined),
    confirmHash: t.string().optional().default(undefined),
};

export const LinkRequest = table({
    name: 'link_request',
    public: false,
    indexes: [
        { accessor: 'user_id', algorithm: 'btree', columns: ['userId'] },
    ],
}, linkRequestColumns);
