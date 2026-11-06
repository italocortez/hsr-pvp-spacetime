/**
 * Shared HsrAccount seeding helper.
 *
 * HsrAccount is a private table since Phase 10.4 — existence is checked via
 * view_my_roster subscription (no CLI roundtrip). Idempotent: returns early
 * if the user already has at least one HSR account.
 */

import type { TestHarness } from '../connection';

/**
 * Ensure a test player has an HSR account (needed for D-08 LMA gate on
 * Ranked/MMR lobbies). If the user has any hsr_account row, returns
 * immediately; otherwise creates one using a deterministic UID derived from
 * userId.
 */
export async function ensureHsrAccount(h: TestHarness): Promise<void> {
    // view_my_roster returns one row per account-character pair; any row
    // means the caller has at least one HsrAccount.
    const hasAccount = [...h.conn.db.view_my_roster.iter()].length > 0;
    if (hasAccount) return;
    const uid = `8${String(h.userId).padStart(7, '0')}1`;
    await h.call.createHsrAccount({ uid, displayLabel: `Test ${h.userId}` });
    await h.sync(1500);
}
