import { SenderError } from 'spacetimedb/server';

// ─── M5a3: the three kinds of server identity (ServerIdentity.kind) ─────────────────────────────────────────────────
// Owner (the publisher) and Delegate (bootstrap, seeding, scripts) are trusted server identities: they pass
// requireServer, the seed gates and the maintenance gate of client_connected, and both map to the SYSTEM user.
// Linker (the Vercel auth function) may only present a sign-in code (linker_present_code): it is not a trusted server
// identity, has no UserIdentity row, and every other reducer refuses it.

/** The refusal of a linker identity by login_as_guest. */
export const LINKER_NOT_A_USER_TEXT = 'Forbidden: a linker identity cannot sign in as a user.';
/** The refusal of any caller but a linker identity by linker_present_code. */
export const LINKER_ONLY_TEXT = 'Forbidden: caller is not the registered linker identity.';

/** The ServerIdentity row of `identity` when it is an Owner or a Delegate; undefined for a Linker or no row. */
export function trustedServerRow(ctx: any, identity: any): any | undefined {
    const row = ctx.db.ServerIdentity.identity.find(identity);
    return row && row.kind.tag !== 'Linker' ? row : undefined;
}

/** True when `identity` is a registered Linker. */
export function isLinkerIdentity(ctx: any, identity: any): boolean {
    return ctx.db.ServerIdentity.identity.find(identity)?.kind.tag === 'Linker';
}

/** Guard of linker_present_code: the caller is a registered Linker (not the Owner, not a Delegate). */
export function requireLinker(ctx: any): void {
    if (!isLinkerIdentity(ctx, ctx.sender)) throw new SenderError(LINKER_ONLY_TEXT);
}
