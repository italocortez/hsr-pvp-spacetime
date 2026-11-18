import { updateWithAudit } from '@module/helpers/admin/auditHelpers';
import { LIVE_STAGES, memberHasLeft, slotIsCoach, slotIsSpectator } from './lobbyHelpers';
import { removeMemberRow } from './memberRemoval';
import { memberEventLabel, postMemberEventChat } from './memberEventChat';
import { markMemberOffline } from './disconnectHelpers';

/** What leaveMembership did with the row. */
export type LeaveOutcome =
    | 'away'          // a player in a live stage: the row is kept and marked away (A68(1)(2))
    | 'alreadyAway'   // a player in a live stage who was already away or abandoned: nothing written
    | 'removed'       // the row was removed (A68(5)(7))
    | 'lobbyDeleted'; // the row was removed and the emptied Waiting lobby hard-deleted

/**
 * The body of leave_lobby, shared with a suspension (suspension-s1, A214(6)) so the Leave rules live in one place.
 * A68(1): a player's Leave in Drafting / Equipping / Scoring is a disconnect (markMemberOffline) plus leftAt (A68(2),
 * away), the "left the match" chat line and the lobby's activity stamp; the row, its LobbyMemberAccount rows and
 * currentPlayerCount are kept and the player may return through join_lobby. A68(5)(7): every other Leave (a player in
 * Waiting / AwaitingResult, a spectator or coach in any stage) removes the row through removeMemberRow (flags handed
 * over) and, outside the live stages, writes the "left the lobby" line. `user` is the member's User row (the chat line
 * names them); `actorId` is the audit actor (the member for a Leave, SYSTEM_USER_ID for a suspension, so the
 * other members never learn which staff user acted).
 */
export function leaveMembership(ctx: any, lobby: any, member: any, user: any, actorId: number): LeaveOutcome {
    const isLiveStage = LIVE_STAGES.includes(lobby.stage.tag);
    const isPlayer = !slotIsSpectator(member.lobbySlot) && !slotIsCoach(member.lobbySlot);

    if (isLiveStage && isPlayer) {
        // A68(2): already away (or abandoned): a second Leave changes nothing, so the clock keeps its first stamp.
        if (memberHasLeft(member)) return 'alreadyAway';

        markMemberOffline(ctx, lobby, member, actorId, { leftAt: ctx.timestamp });

        // D-11: system message (S9a fix, A37: rendered per reader by view_my_lobby_chat)
        postMemberEventChat(ctx, lobby, 'away', user.id, user.displayName, actorId);

        // Update activity (do NOT decrement currentPlayerCount — row is kept)
        ctx.db.Lobby.id.update(updateWithAudit(ctx, lobby, {
            lastActivityAt: ctx.timestamp,
        }, actorId));
        return 'away';
    }

    const leaverLabel = memberEventLabel(ctx, lobby, user.id); // read before the row is removed
    if (!removeMemberRow(ctx, lobby.id, user.id, actorId)) return 'lobbyDeleted'; // empty Waiting lobby deleted

    // D-11: system message (a spectator's or coach's leave during the match stays silent, as before)
    // S9a fix (A37): rendered per reader by view_my_lobby_chat
    if (!isLiveStage) {
        postMemberEventChat(ctx, lobby, 'left', user.id, user.displayName, actorId, leaverLabel);
    }
    return 'removed';
}
