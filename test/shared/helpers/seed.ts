/**
 * Shared idempotent seeding helpers for per-test setup.
 */

import type { TestHarness } from '../connection';

/**
 * Ensure the EloConfig row exists. Calls admin_seed_elo_config and swallows
 * any error (the row is keyed on a singleton — subsequent inserts throw).
 * Caller must be an Admin.
 */
export async function ensureEloConfig(admin: TestHarness): Promise<void> {
    try {
        await admin.call.adminSeedEloConfig({});
    } catch (_) { /* already exists */ }
    await admin.sync(500);
}

/**
 * Ensure the AccountRatingConfig row exists. Calls admin_seed_rating_config
 * and swallows any error (the row is keyed on a singleton — subsequent
 * inserts throw). Computes maxPossible from current character pool at seed time.
 * Caller must be an Admin.
 *
 * See test/data-templates/account-rating-config-defaults.json for default values.
 */
export async function ensureAccountRatingConfig(admin: TestHarness): Promise<void> {
    try {
        await admin.call.adminSeedRatingConfig({});
    } catch (_) { /* already exists */ }
    await admin.sync(500);
}
