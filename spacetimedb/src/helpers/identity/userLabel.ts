/**
 * Phase 15.2 D-12: Three-path server-side label resolution.
 *
 * Lookup order:
 *   1. Live ctx.db.User row by id → returns { displayName, isDeleted: false }
 *   2. ctx.db.DeletedUser archive by id → returns { displayName, isDeleted: true }
 *   3. Fallback synthetic label `User #${userId}` → returns { displayName, isDeleted: true }
 *
 * Use at render sites where a referenced user may have been cascaded/evicted
 * (match history, lobby kick/ban announcements, finalization snapshots).
 * Do NOT use at sites where the user is the caller — ctx.sender is always live.
 *
 * Returns a struct (not a bare string) so call sites that want to badge
 * deleted users with "(deleted)" can branch on `isDeleted` without a second
 * lookup. Call sites that only need the display name destructure the field.
 */
export function resolveUserLabel(
    ctx: any,
    userId: number,
): { displayName: string; isDeleted: boolean } {
    const liveUser = ctx.db.User.id.find(userId);
    if (liveUser) {
        return { displayName: liveUser.displayName, isDeleted: false };
    }
    const archivedUser = ctx.db.DeletedUser.id.find(userId);
    if (archivedUser) {
        return { displayName: archivedUser.displayName, isDeleted: true };
    }
    return { displayName: `User #${userId}`, isDeleted: true };
}
