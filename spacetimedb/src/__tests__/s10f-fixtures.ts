// T-S10f: shared builders for the S10f in-memory tests (and the s9b leaderboard re-alignment). Not a test file.
import { AUDIT } from './s8-fixtures';
import type { Harness } from './s4-fixtures';

/**
 * Results audit #9 (S10f): the leaderboard rebuild skips rating rows whose user has no live User row, so tests that
 * write MmrRating rows directly seed a plain User row for each id (written outside a transaction; no-op if present).
 */
export function seedUserRow(test: Harness, userId: number, o: { deletedAt?: any } = {}) {
    if (test.db.User.id.find(userId)) return;
    test.db.User.insert({
        id: userId, username: `user-${userId}`, displayName: `user-${userId}`, isGuest: false, role: { tag: 'User' },
        hasDiscordLinked: true, avatarCharacterName: '', displayedAchievementId: undefined, deletedAt: o.deletedAt, ...AUDIT(test),
    } as any);
}
