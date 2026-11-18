import { SenderError } from 'spacetimedb/server';
import { insertWithAudit } from '@module/helpers/admin/auditHelpers';
import { SYSTEM_USER_ID } from '@module/helpers/admin/auditColumns';
import { DISCORD_LOGIN_METHOD } from '@module/helpers/lobby/banHelper';
import { leaveMembership } from '@module/helpers/lobby/memberLeave';
import { transferFlagsOnRemoval } from '@module/helpers/lobby/flagTransferHelpers';
import { deleteCursorStamps } from '@module/helpers/lobby/cursorStamps';
import { isRoleAtLeast } from './ensurePermissions';
import { deleteLinkRequestsOfUser } from './linkCode';
import { isSuspended } from './suspension';

// ─── Account suspension: suspend and lift (A195, A213, A214; suspension-s1) ───────────────────────────────────────
// Shared by admin_suspend_user / admin_lift_suspension (reducers/admin/suspensionAdmin.ts) and the server twins
// server_suspend_user / server_lift_suspension (reducers/identity/server.ts). The caller resolves the target and the
// actor; these functions check the target and write.

/** The longest reason, in UTF-16 units (as the ban's reason). */
export const SUSPENSION_REASON_MAX_LENGTH = 500;

export const SUSPENSION_REASON_TOO_LONG_TEXT = `The reason must be ${SUSPENSION_REASON_MAX_LENGTH} characters or fewer.`;
export const SUSPEND_PENDING_DELETION_TEXT = 'This account is already pending deletion.';
export const SUSPEND_SYSTEM_TEXT = 'The SYSTEM user cannot be suspended.';
export const SUSPEND_SELF_TEXT = 'You cannot suspend yourself.';
export const SUSPEND_NOT_VERIFIED_TEXT = 'Only a verified (Discord-linked) account can be suspended.';
export const SUSPEND_ADMIN_FROM_APP_TEXT = 'An Admin cannot be suspended from the app.';
export const ALREADY_SUSPENDED_TEXT = 'This user is already suspended.';
export const NOT_SUSPENDED_TEXT = 'This user is not suspended.';

export interface SuspendOptions {
    /**
     * True for admin_suspend_user: an Admin target is refused (user ruling 2026-11-17: an Admin is suspended only
     * through the server reducers). False for the server twins, which accept any verified user except SYSTEM.
     */
    fromApp: boolean;
}

/**
 * Suspends `target` (a User row the caller found). Checks, in order: the reason's length; pending deletion; the SYSTEM
 * user; the actor themself; a guest or an account with no Discord link (A213(7)); an Admin from the app; already
 * suspended. Then, in the same transaction:
 *   - the UserSuspension row (reason kept for the admins' record only);
 *   - every lobby membership as a Leave would treat it (leaveMembership: Waiting / AwaitingResult and every spectator or
 *     coach seat removed; a player in Drafting / Equipping / Scoring kept and marked away), and for a kept player row
 *     the host, captain and referee flags handed over at once (transferFlagsOnRemoval) and the cursor stamp dropped.
 *     No automatic forfeit (A68(3)); the absent-player rules run unchanged; abandoned rows are left alone;
 *   - the user's pending link requests deleted;
 *   - one log line (never the reason).
 * Tournament entries, teams, captaincy and organizer roles are untouched (A214(3)); public traces too (A213(6)).
 */
export function suspendUser(ctx: any, target: any, reason: string, actorId: number, opts: SuspendOptions): void {
    if (reason.length > SUSPENSION_REASON_MAX_LENGTH) throw new SenderError(SUSPENSION_REASON_TOO_LONG_TEXT);
    if (target.deletedAt !== undefined) throw new SenderError(SUSPEND_PENDING_DELETION_TEXT);
    if (target.username === 'SYSTEM') throw new SenderError(SUSPEND_SYSTEM_TEXT);
    if (target.id === actorId) throw new SenderError(SUSPEND_SELF_TEXT);
    if (target.isGuest || target.loginMethod !== DISCORD_LOGIN_METHOD) throw new SenderError(SUSPEND_NOT_VERIFIED_TEXT);
    if (opts.fromApp && isRoleAtLeast(target.role, 'Admin')) throw new SenderError(SUSPEND_ADMIN_FROM_APP_TEXT);
    if (isSuspended(ctx, target.id)) throw new SenderError(ALREADY_SUSPENDED_TEXT);

    ctx.db.UserSuspension.insert(insertWithAudit(ctx, {
        userId: target.id,
        reason,
        suspendedById: actorId,
    }, actorId));

    for (const membership of [...ctx.db.LobbyMember.user_id.filter(target.id)]) {
        if (membership.abandonedAt !== undefined) continue; // A68(4): an abandoned row never acts or returns
        const lobby = ctx.db.Lobby.id.find(membership.lobbyId);
        if (!lobby) continue;
        // The lobby-side writes carry SYSTEM_USER_ID, not the staff user: lobby rows reach the other members, who must
        // not learn which staff member acted (review M1). The UserSuspension row and the log line keep the real actor.
        const outcome = leaveMembership(ctx, lobby, membership, target, SYSTEM_USER_ID);
        if (outcome === 'away' || outcome === 'alreadyAway') {
            // The person cannot act until lifted, so the flags move now rather than after the 15 s check.
            transferFlagsOnRemoval(ctx, lobby.id, target.id);
            deleteCursorStamps(ctx, lobby.id, target.id);
        }
    }

    deleteLinkRequestsOfUser(ctx, target.id);
    console.log(`[SUSPEND] User #${target.id} suspended by #${actorId}`);
}

/** Lifts the suspension of `target` (deletes the row); refused when the user is not suspended. One log line. */
export function liftSuspension(ctx: any, target: any, actorId: number): void {
    if (!isSuspended(ctx, target.id)) throw new SenderError(NOT_SUSPENDED_TEXT);
    ctx.db.UserSuspension.userId.delete(target.id);
    console.log(`[UNSUSPEND] User #${target.id} suspension lifted by #${actorId}`);
}
