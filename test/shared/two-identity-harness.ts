/**
 * Phase 15 D-20: Two-identity test helper for cross-user isolation tests.
 *
 * S10n (A115): the history views are view_my_match_history(page, gameMode, draftMode, matchType),
 * view_my_match_history_count(gameMode, draftMode, matchType), view_my_match_history_participants /
 * _steps / _games / _lineups(matchHistoryId) and view_my_mmr_history(page, gameMode); their bindings are
 * in web/src/module_bindings/index.ts. All of them take arguments, and views with arguments are NOT
 * delivered by subscribeToAllTables() in createVerifiedTestHarness (test/shared/connection.ts): the SDK
 * skips them. The S11 isolation tests must subscribe each one explicitly with its argument literals
 * (e.g. `SELECT * FROM view_my_match_history(0, '', '', '')`) before reading it with .iter().
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
 * Each call to `createVerifiedTestHarness` signs in with a random
 * 18-digit Discord id (sign-in.ts, T-M5a3), so userA and userB end up
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
