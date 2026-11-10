import { deleteAllCalendarDataForUser } from '@module/helpers/calendar/calendarCascade';
import { transferFlagsOnRemoval } from '@module/helpers/lobby/flagTransferHelpers';
import { removeMemberRow } from '@module/helpers/lobby/memberRemoval';
import { LIVE_STAGES, slotIsCoach, slotIsSpectator } from '@module/helpers/lobby/lobbyHelpers';
import { updateWithAudit } from '@module/helpers/admin/auditHelpers';
import { recalcDuplicateUid } from '@module/helpers/roster/rosterHelpers';

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
 * Cascade-delete active-state rows, then remove the User row.
 *
 * Cascade: UserPrivate, lobby memberships (below), calendar data, UserPresence, UserRateState, UserIdentity,
 * HsrAccount, HsrAccountCharacter.
 * Guest users with no history references → hard-delete (row removed entirely).
 * All others → the User row is hard-deleted and archived to DeletedUser (id, displayName, isGuest, deletedAt), which
 * resolveUserLabel reads for history rows (Phase 15.2 D-09).
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

    // A68(7): user deletion is a row removal. Waiting / AwaitingResult, a spectator or coach in any stage (A68(5)),
    // or an orphan row: removeMemberRow, as leave_lobby (flags transferred in the A22(5) order, online first then any;
    // LobbyMemberAccount rows deleted, currentPlayerCount decremented, an emptied Waiting lobby hard-deleted).
    // A player in Drafting / Equipping / Scoring (an admin deletion mid-match, or a guest's delete_my_account: only the
    // verified branch refuses an away or live membership, A45(3)): A68(6) keeps the row, so the flags move and the row becomes away and abandoned (isOnline
    // false, leftAt, abandonedAt, disconnectedAt under Standard / Deferred): an offline player for the forfeit test
    // (A68(3)) and never a flag candidate again (A68(7) hasLeft). Stamps already on the row are kept (the grace clock
    // does not restart). The kept row keeps its LobbyMemberAccount rows (S10e review F3: abandoned rows are not
    // released; the roster guards ignore them, accountLobbyLocks).
    for (const membership of [...ctx.db.LobbyMember.user_id.filter(userId)]) {
        const lobby = ctx.db.Lobby.id.find(membership.lobbyId);
        const isPlayer = !slotIsSpectator(membership.lobbySlot) && !slotIsCoach(membership.lobbySlot);
        if (!lobby || !LIVE_STAGES.includes(lobby.stage.tag) || !isPlayer) {
            removeMemberRow(ctx, membership.lobbyId, userId, actorId);
            continue;
        }
        transferFlagsOnRemoval(ctx, membership.lobbyId, userId);
        const row = [...ctx.db.LobbyMember.by_lobby_and_user.filter([membership.lobbyId, userId])][0];
        if (!row) continue;
        const tracksDisconnect = lobby.disconnectPolicy.tag !== 'NoAction';
        ctx.db.LobbyMember.by_lobby_and_user.delete([membership.lobbyId, userId]);
        ctx.db.LobbyMember.insert(updateWithAudit(ctx, row, {
            isOnline: false,
            leftAt: row.leftAt ?? ctx.timestamp,
            abandonedAt: row.abandonedAt ?? ctx.timestamp,
            disconnectedAt: tracksDisconnect ? (row.disconnectedAt ?? ctx.timestamp) : row.disconnectedAt,
        }, actorId));
    }

    // Cascade: delete all calendar data (availability slots, saved calendars, events, invites) (D-23)
    deleteAllCalendarDataForUser(ctx, userId);

    // Cascade: delete the per-identity presence rows (A48) and all UserIdentity rows (severs auth link)
    for (const presence of [...ctx.db.UserPresence.user_id.filter(userId)]) {
        ctx.db.UserPresence.identity.delete(presence.identity);
    }
    // B-7: the per-user abuse rate windows (UserRateState)
    if (ctx.db.UserRateState.userId.find(userId)) ctx.db.UserRateState.userId.delete(userId);
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
    // Roster audit #6 (S10f): the other holders of a deleted account's UID get their isDuplicateUid recomputed, as the
    // two delete reducers do (a UID left with one account reverts to false).
    for (const uid of new Set(hsrAccounts.map((a: any) => a.uid))) {
        recalcDuplicateUid(ctx, uid, actorId);
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
