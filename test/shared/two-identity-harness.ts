/**
 * Phase 15 D-20: Two-identity test helper for cross-user isolation tests.
 *
 * All 5 history-view bindings (view_my_mmr_history, view_my_match_participant_history,
 * view_my_match_session_history, view_my_match_session_step_history,
 * view_my_match_result_game_history) are present in src/module_bindings/index.ts and
 * re-exported through DbConnection.db. Views are auto-subscribed via
 * subscribeToAllTables() in createVerifiedTestHarness (test/shared/connection.ts),
 * so isolation tests use the subscription + .iter() path (preferred) rather than SQL fallback.
 *
 * SQL-on-backing-table cross-check is still used in some assertions to verify that
 * VIEW rows are a subset of what the backing table contains for the caller's userId.
 */

import { createVerifiedTestHarness, hasServerToken, type TestHarness } from './connection';

export interface TwoIdentities {
    userA: TestHarness;
    userB: TestHarness;
}

/**
 * Creates two fresh verified harnesses (distinct Discord IDs).
 * Each call to `createVerifiedTestHarness` generates a unique
 * `test_<timestamp>_<random>` provider ID, so userA and userB end up
 * as independent UserIdentity → User rows on the server.
 */
export async function createTwoVerifiedHarnesses(): Promise<TwoIdentities> {
    const [userA, userB] = await Promise.all([
        createVerifiedTestHarness(),
        createVerifiedTestHarness(),
    ]);
    return { userA, userB };
}

export async function disconnectBoth(pair: TwoIdentities | undefined): Promise<void> {
    if (!pair) return;
    await Promise.allSettled([
        pair.userA?.disconnect(),
        pair.userB?.disconnect(),
    ]);
}

export { hasServerToken };
