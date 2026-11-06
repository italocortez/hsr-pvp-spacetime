/**
 * Shared user-query helpers.
 */

import type { TestHarness } from '../connection';

/** Look up the username for a harness's user via the User table */
export function getUsername(h: TestHarness): string {
    const user = [...h.conn.db.User.iter()].find(u => u.id === h.userId);
    if (!user) {
        throw new Error(`User not found for userId ${h.userId}`);
    }
    return user.username;
}
