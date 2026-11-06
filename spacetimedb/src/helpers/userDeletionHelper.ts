import { deleteAllCalendarDataForUser } from './calendarCascade';

/**
 * Returns true if the iterator yields at least one element.
 * Only reads the first row — O(1) after index lookup.
 */
function any(iter: Iterable<any>): boolean {
    for (const _ of iter) return true;
    return false;
}

/**
 * Check if a user has any history/stat references that would be orphaned by hard-delete.
 * Uses btree indexes for O(log n) lookups — early exit on first match.
 *
 * Tables checked (HIGH risk — user-facing display breaks if User row is gone):
 *   MatchResultParticipant, MmrHistory, PlayerStat, PlayerCharacterStat,
 *   PlayerRelationship, Leaderboard, TournamentEnrolled, UserAchievement
 */
export function hasHistoryReferences(ctx: any, userId: number): boolean {
    return any(ctx.db.MatchResultParticipant.user_id.filter(userId))
        || any(ctx.db.MmrHistory.user_id.filter(userId))
        || any(ctx.db.PlayerStat.by_user.filter(userId))
        || any(ctx.db.PlayerCharacterStat.by_user.filter(userId))
        || any(ctx.db.PlayerRelationship.by_user.filter(userId))
        || any(ctx.db.Leaderboard.by_user.filter(userId))
        || any(ctx.db.TournamentEnrolled.user_id.filter(userId))
        || any(ctx.db.UserAchievement.by_user.filter(userId));
}

/**
 * Cascade-delete active-state rows + soft-delete (or hard-delete guest) User row.
 *
 * Cascade: UserIdentity, HsrAccount, HsrAccountCharacter
 * Guest users with no history references → hard-delete (row removed entirely).
 * All others → soft-delete: username='deleted_<id>', discordId cleared, displayName preserved.
 *
 * Safe to call even if UserIdentity rows were already deleted (e.g. identity re-pointed
 * during Discord linking) — the filter returns 0 rows and the loop is a no-op.
 */
export function performUserDeletion(ctx: any, userId: number, actorId: number): void {
    const user = ctx.db.User.id.find(userId);
    if (!user) return;

    // D-09 audit (Phase 12.1): UserPrivate cascade verified complete -- hard-deleted here
    // Cascade: hard-delete UserPrivate (D-03: BanRecord retains discordId independently)
    const userPrivate = ctx.db.UserPrivate.userId.find(userId);
    if (userPrivate) {
        ctx.db.UserPrivate.userId.delete(userId);
    }

    // Cascade: delete all calendar data (availability slots, saved calendars, events, invites) (D-23)
    deleteAllCalendarDataForUser(ctx, userId);

    // Cascade: delete all UserIdentity rows (severs auth link)
    const identities = [...ctx.db.UserIdentity.user_id.filter(userId)];
    for (const ui of identities) {
        ctx.db.UserIdentity.identity.delete(ui.identity);
    }

    // Cascade: delete all HSR accounts and their characters
    const hsrAccounts = [...ctx.db.HsrAccount.user_id.filter(userId)];
    for (const account of hsrAccounts) {
        const characters = [...ctx.db.HsrAccountCharacter.hsr_account_id.filter(account.id)];
        for (const char of characters) {
            ctx.db.HsrAccountCharacter.delete(char);
        }
        ctx.db.HsrAccount.id.delete(account.id);
    }

    // Guest users with no history → hard-delete (no references to preserve)
    if (user.isGuest && !hasHistoryReferences(ctx, userId)) {
        ctx.db.User.id.delete(userId);
        console.log(`[DELETE] Guest user #${userId} hard-deleted (no history references).`);
        return;
    }

    // Phase 15.2 D-09: evict non-guest-with-history users to DeletedUser archive
    // and hard-delete the live User row. Ghosts no longer accumulate in User.iter().
    // displayName is preserved in DeletedUser for resolveUserLabel (D-12).
    ctx.db.DeletedUser.insert({
        id: user.id,
        displayName: user.displayName,
        isGuest: user.isGuest,
        deletedAt: user.deletedAt ?? ctx.timestamp,
    });
    ctx.db.User.id.delete(user.id);
    console.log(`[DELETE] User #${userId} evicted to DeletedUser archive. Display name preserved: "${user.displayName}".`);
}
