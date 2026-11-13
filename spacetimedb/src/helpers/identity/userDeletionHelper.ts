import { deleteAllCalendarDataForUser, handCalendarEventTo } from '@module/helpers/calendar/calendarCascade';
import { transferFlagsOnRemoval } from '@module/helpers/lobby/flagTransferHelpers';
import { removeMemberRow } from '@module/helpers/lobby/memberRemoval';
import { deleteCursorStamps } from '@module/helpers/lobby/cursorStamps';
import { LIVE_STAGES, slotIsCoach, slotIsSpectator } from '@module/helpers/lobby/lobbyHelpers';
import { updateWithAudit } from '@module/helpers/admin/auditHelpers';
import { recalcDuplicateUid } from '@module/helpers/roster/rosterHelpers';
import { settleTournamentTiesForDeletion } from '@module/helpers/tournament/disqualification';
import { DEFAULT_COST_SET_ID, deleteCostSetRows, isCostSetInUse } from '@module/helpers/draft/costSetGuards';
import { SYSTEM_USER_ID } from '@module/helpers/admin/auditColumns';
import { isRoleAtLeast } from '@module/helpers/identity/ensurePermissions';
import { cancelTournament } from '@module/helpers/tournament/tournamentHelpers';
import { removeUserStandIns } from '@module/helpers/tournament/standIns';
import { removeDeletedUserFromLeaderboard } from '@module/helpers/stats/leaderboardRebuild';
import { deleteLinkRequestsOfUser } from './linkCode';

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
 * S10r (A122(6), L22, L89): deletes the user's lobby presets (LobbyPreset.creator_user_id; the system preset is owned
 * by SYSTEM and never matches) and unpublished cost sets (CostSet.creator_id, isPublished false: drafts and unpublished
 * sets, with their live and draft rows through deleteCostSetRows). Published sets stay. References are detected as
 * follows, and a referenced row is kept:
 *   - preset: an unfinished tournament (stage not Completed / Cancelled) whose lobbyPresetId is the preset. Lobbies do
 *     not reference presets (a preset's values are copied at creation; A116), so a lobby never holds one.
 *     Tournament has no lobbyPresetId index: one Tournament scan for all of the user's presets (small table, deletion only).
 *   - cost set: isCostSetInUse, as delete_cost_set: any existing Lobby row on the set, or an unfinished tournament.
 */
function deleteOwnedPresetsAndCostSets(ctx: any, userId: number): void {
    const presets = [...ctx.db.LobbyPreset.creator_user_id.filter(userId)].filter((p: any) => !p.isSystemPreset);
    if (presets.length > 0) {
        const heldPresetIds = new Set<number>();
        // iter() required: Tournament has no lobbyPresetId index (see above).
        for (const tournament of ctx.db.Tournament.iter()) {
            if (tournament.stage.tag !== 'Completed' && tournament.stage.tag !== 'Cancelled') heldPresetIds.add(tournament.lobbyPresetId);
        }
        for (const preset of presets) {
            if (!heldPresetIds.has(preset.id)) ctx.db.LobbyPreset.id.delete(preset.id);
        }
    }
    for (const costSet of [...ctx.db.CostSet.creator_id.filter(userId)]) {
        if (costSet.id === DEFAULT_COST_SET_ID || costSet.isPublished) continue;
        if (isCostSetInUse(ctx, costSet.id)) continue;
        deleteCostSetRows(ctx, costSet.id);
    }
}

/**
 * S10s (A121, L70): the assistant who takes over a tournament: the longest-serving assistant row (earliest createdDate;
 * equal dates by the lower user id, never the row id) that holds all three permissions, whose user exists, is not a
 * guest, is not pending deletion and is not the user being deleted.
 */
function longestServingFullAssistant(ctx: any, tournamentId: number, deletedUserId: number): any | undefined {
    let best: any | undefined;
    for (const a of ctx.db.TournamentAssistant.tournament_id.filter(tournamentId)) {
        if (a.userId === deletedUserId) continue;
        if (!a.canManageParticipants || !a.canManageBracket || !a.canResolveResults) continue;
        const u = ctx.db.User.id.find(a.userId);
        if (!u || u.isGuest || u.deletedAt) continue;
        const at: bigint = a.createdDate.microsSinceUnixEpoch;
        const bestAt: bigint | undefined = best?.createdDate.microsSinceUnixEpoch;
        if (!best || at < bestAt! || (at === bestAt && a.userId < best.userId)) best = a;
    }
    return best;
}

/**
 * S10s (A121, L70): a staff deletion or ban of the organizer of a tournament that is not Completed or Cancelled hands
 * the tournament over before the cascade removes the user:
 *   1. to the longest-serving assistant holding all three permissions (that assistant row is deleted), else
 *   2. to the acting Moderator or Admin (`actorId`, read at run time: the user must still exist, not be pending
 *      deletion and hold Moderator or above), else
 *   3. nothing changes (Moderator+ still manage the tournament, as before).
 * Not a staff deletion, so nothing changes here: a self-deletion (`actorId === userId`; A94(1) refuses it for an
 * organizer anyway; also the reconnect-ban path of client_connected, whose job names the banned user), or a SYSTEM
 * actor (`SYSTEM_USER_ID` or the SYSTEM user). A server deletion proper (A124) does not reach this function: it is
 * signalled by `serverDeletion` and cancels the tournaments (cancelOrganizedTournaments).
 * The new organizer loses any assistant row of their own in the tournament (the organizer holds every permission). The
 * calendar events of the tournament's bracket matches that the old organizer organized move to the new organizer
 * (CalendarEvent.organizerId), so deleteAllCalendarDataForUser does not delete them; the new organizer's own invite to
 * such an event is deleted (S11a, A163(2), handCalendarEventTo), the other invites are unchanged. Everything
 * else reads Tournament.organizerId at call time and follows the new organizer. The ban and admin_delete_row paths run
 * this from the scheduled run_user_deletion, whose actor is the job row's createdById (the Admin who asked).
 */
function handOverOrganizedTournaments(ctx: any, userId: number, actorId: number): void {
    if (actorId === userId || actorId === SYSTEM_USER_ID) return;
    const actor = ctx.db.User.id.find(actorId);
    if (actor?.username === 'SYSTEM') return;
    const actorCanOrganize = !!actor && !actor.deletedAt && isRoleAtLeast(actor.role, 'Moderator');
    for (const tournament of [...ctx.db.Tournament.organizer_id.filter(userId)]) {
        if (tournament.stage.tag === 'Completed' || tournament.stage.tag === 'Cancelled') continue;
        const heir = longestServingFullAssistant(ctx, tournament.id, userId);
        const newOrganizerId: number | undefined = heir ? heir.userId : actorCanOrganize ? actorId : undefined;
        if (newOrganizerId === undefined) continue;
        for (const a of [...ctx.db.TournamentAssistant.by_tournament_and_user.filter([tournament.id, newOrganizerId])]) {
            ctx.db.TournamentAssistant.id.delete(a.id);
        }
        ctx.db.Tournament.id.update(updateWithAudit(ctx, tournament, { organizerId: newOrganizerId }, actorId));
        removeUserStandIns(ctx, tournament.id, newOrganizerId, actorId); // S10v review F3 (A135(2)): staff never stand in
        for (const match of [...ctx.db.BracketMatch.tournament_id.filter(tournament.id)]) {
            for (const event of [...ctx.db.CalendarEvent.bracket_match_id.filter(match.id)]) {
                if (event.organizerId !== userId) continue;
                handCalendarEventTo(ctx, event, newOrganizerId, actorId); // S11a (A163(2)): drops the heir's own invite
            }
        }
        console.log(`[DELETE] Tournament #${tournament.id} handed from organizer #${userId} to #${newOrganizerId} (${heir ? 'assistant' : 'acting staff'}).`);
    }
}

/**
 * S10s fix pass (A124): a server deletion of an organizer cancels every tournament of that organizer that is not
 * Completed or Cancelled, through cancelTournament (the cancel_tournament path: cascade clean-up, stage Cancelled,
 * finalize job). No assistant takes over. Runs only when the caller passes `serverDeletion: true` (see
 * performUserDeletion), never from the actor id alone.
 */
function cancelOrganizedTournaments(ctx: any, userId: number, actorId: number): void {
    for (const tournament of [...ctx.db.Tournament.organizer_id.filter(userId)]) {
        if (tournament.stage.tag === 'Completed' || tournament.stage.tag === 'Cancelled') continue;
        cancelTournament(ctx, tournament, actorId);
        console.log(`[DELETE] Tournament #${tournament.id} cancelled: its organizer #${userId} was deleted by the server (A124).`);
    }
}

/** S10s fix pass (A124): options of performUserDeletion. */
export interface UserDeletionOptions {
    /**
     * True only when a server identity (Owner or Delegate) deleted or banned the user with no staff user behind it:
     * three sites set it: server_delete_user; run_user_deletion for a job created by the SYSTEM user (a ban or
     * admin_delete_row('User') sent by the Owner or a Delegate); and admin_delete_row('UserIdentity') sent as the SYSTEM
     * user when it removes a guest's last identity (admin.ts). Identity GC, server_link_provider and the other paths
     * never set it.
     */
    serverDeletion?: boolean;
}

/**
 * Cascade-delete active-state rows, then remove the User row.
 *
 * Cascade: the organizer hand-over of a staff deletion (S10s, A121, handOverOrganizedTournaments), tournament ties
 * (A94(2), settleTournamentTiesForDeletion), lobby memberships (below), calendar data, UserPresence, UserRateState, UserIdentity,
 * HsrAccount, HsrAccountCharacter, then (S10r, A122(6)) the user's unreferenced lobby presets and unpublished cost sets.
 * Guest users with no history references → hard-delete (row removed entirely).
 * All others → the User row is hard-deleted and archived to DeletedUser (id, displayName, isGuest, deletedAt), which
 * resolveUserLabel reads for history rows (Phase 15.2 D-09).
 *
 * Safe to call even if UserIdentity rows were already deleted (e.g. identity re-pointed
 * during Discord linking) — the filter returns 0 rows and the loop is a no-op.
 */
export function performUserDeletion(ctx: any, userId: number, actorId: number, opts: UserDeletionOptions = {}): void {
    const user = ctx.db.User.id.find(userId);
    if (!user) return;

    // S10s (A121, L70): a staff deletion hands the user's unfinished tournaments to a new organizer first.
    // Fix pass (A124): a server deletion cancels them instead (explicit opts.serverDeletion signal).
    if (opts.serverDeletion) {
        cancelOrganizedTournaments(ctx, userId, actorId);
    } else {
        handOverOrganizedTournaments(ctx, userId, actorId);
    }

    // A94(2) (S10g): tournament ties are settled first (withdrawal before the bracket exists, DQ once it exists;
    // requests, assistant rows, stand-in rows, account locks and remembered waitlist accounts deleted).
    settleTournamentTiesForDeletion(ctx, userId, actorId);

    // A77 (S11a): the provider link (formerly UserPrivate) is on the User row and goes with it below
    // (D-03: BanRecord retains the provider id independently).

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
        deleteCursorStamps(ctx, membership.lobbyId, userId); // S11a (L19): the kept row sends no more cursors
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
    // M5a: the user's pending one-time link codes (LinkRequest.user_id)
    deleteLinkRequestsOfUser(ctx, userId);
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

    // S10r (A122(6), L22, L89): the user's lobby presets and unpublished cost sets go with them.
    deleteOwnedPresetsAndCostSets(ctx, userId);

    // Guest users with no history → hard-delete (no references to preserve; no Leaderboard row either, as
    // hasHistoryReferences checks it)
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

    // A163(1) (S11a): no card of a deleted account stays on the public leaderboard. After the User row is gone, so the
    // active-season rebuild no longer ranks them.
    removeDeletedUserFromLeaderboard(ctx, userId);
}
