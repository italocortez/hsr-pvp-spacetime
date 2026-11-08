import spacetimedb from '@module/schema';
import { RefereeTransferCheck } from '@module/tables/lobby/refereeTransferCheck';
import {
    ACTIVE_STAGES,
    decideAutoPause,
    decideRefereeTransfer,
    type LobbyStage,
    type MemberLite,
} from '@shared/lobby-rules';
import { SYSTEM_USER_ID } from '@module/helpers/admin/auditColumns';
import { insertWithAudit, updateWithAudit } from '@module/helpers/admin/auditHelpers';
import { moveRefereeFlag, toMemberLite, transferCaptain, transferHost } from '@module/helpers/lobby/flagTransferHelpers';
import { memberHasLeft, slotToTeamSide } from '@module/helpers/lobby/lobbyHelpers';
import { hasLivePresence } from '@module/helpers/identity/presenceHelpers';
import { getNextSequence } from '@module/helpers/draft/stepSequence';

// ─── run_referee_transfer_check ───────────────────────────────────────────────
// A22a scheduled check (ACCESS-SECURITY-OPS D.8.2), bound to RefereeTransferCheck through `onSchedule`
// (SDK 2.7+ form, no table→reducer cycle). `client_disconnected` inserts one row per active-stage membership,
// 15 s out, when the user's last connection drops, and a player's `leave_lobby` in a live stage inserts one too
// (A68(1)); `client_connected` deletes the pending rows of rows without `leftAt`, so a page refresh inside the
// window never reaches this reducer (a leaver's check survives the refresh, A68(2)). The scheduler consumes the row; the reducer is a
// no-op when the lobby or the member is gone.
//
// Decisions come from the pure core in shared/lobby-rules (`decideRefereeTransfer`, `decideAutoPause`):
//   - referee flag: moves only if the subject is still offline, still referee and the stage is active, to the
//     first online candidate in the A22(5) order (host → Blue players → Red players → spectators → coaches,
//     by joinSeq; leaver, offline and away / abandoned rows skipped);
//   - captain and host: the A68(7) transfers (A22(5) order), run with the same grace when still offline; the host
//     goes to an online candidate only (as before), the captain to an online teammate first, then any teammate;
//   - an away / abandoned subject (A68(2)) counts as offline regardless of the user's presence rows;
//   - auto-pause: only an offline *team player* in Drafting under Standard/Deferred, when not already paused.
//     Spectators and coaches never pause anything (F5); a spectator referee or host loses that flag only by the
//     A22(5) rule above, like anyone else.

export const run_referee_transfer_check = spacetimedb.reducer(
    { onSchedule: RefereeTransferCheck },
    { arg: RefereeTransferCheck.rowType },
    (ctx, { arg }) => {
        const lobbyId = arg.lobbyId;
        const userId = arg.userId;

        const lobby = ctx.db.Lobby.id.find(lobbyId);
        if (!lobby) return;
        const members = [...ctx.db.LobbyMember.lobby_id.filter(lobbyId)];
        const member = members.find((m) => m.userId === userId);
        if (!member) return;

        const stage = lobby.stage.tag as LobbyStage;
        // "Still offline" (A48): the membership flag is false AND no device of the user holds a live presence row.
        // A68(2): an away / abandoned row is offline regardless of presence (the leaver may still be browsing the site).
        const subject: MemberLite = {
            ...toMemberLite(member),
            isOnline: !memberHasLeft(member) && (member.isOnline || hasLivePresence(ctx, userId)),
        };

        const decision = decideRefereeTransfer({
            subjectUserId: userId,
            subject,
            members: members.map(toMemberLite),
            hostUserId: lobby.hostUserId,
            stage,
        });
        if (decision.action === 'transfer') {
            moveRefereeFlag(ctx, lobbyId, userId, decision.toUserId);
            console.log(`[REFEREE_CHECK] Lobby #${lobbyId}: referee flag moved from user #${userId} to user #${decision.toUserId}`);
        } else {
            console.log(`[REFEREE_CHECK] Lobby #${lobbyId}, user #${userId}: no referee transfer (${decision.reason})`);
        }

        // D.8.2: captain and host move with the same grace, only while the lobby is still in an active stage.
        if (!subject.isOnline && ACTIVE_STAGES.includes(stage)) {
            transferCaptain(ctx, lobbyId, userId);
            const freshLobby = ctx.db.Lobby.id.find(lobbyId);
            if (freshLobby) {
                transferHost(ctx, lobbyId, freshLobby, userId, { onlineOnly: true });
            }
        }

        if (stage !== 'Drafting') return;
        const session = ctx.db.MatchSession.lobbyId.find(lobbyId);
        if (!session) return;
        const shouldPause = decideAutoPause({
            subject,
            stage,
            isPaused: session.timerState.isPaused,
            disconnectPolicy: lobby.disconnectPolicy.tag,
        });
        if (!shouldPause) return;

        // Snapshot of the clock, same formula as pause_draft (F10 revisits the pause/resume math for both).
        const elapsedMicros = ctx.timestamp.microsSinceUnixEpoch - session.timerState.turnStartAt.microsSinceUnixEpoch;
        const elapsedMs = Number(elapsedMicros) / 1000;
        const timeRemainingMs = Math.max(
            0,
            lobby.standardTurnSeconds * 1000 - elapsedMs + session.timerState.accumulatedPauseMs,
        );

        ctx.db.MatchSessionStep.insert(insertWithAudit(ctx, {
            id: 0,
            lobbyId,
            sequence: getNextSequence(ctx, lobbyId), // F9: audit rows never share a sequence with a draft step
            actorUserId: SYSTEM_USER_ID,
            anonymousLabel: undefined,
            actorSlot: slotToTeamSide(member.lobbySlot),
            action: { tag: 'Pause' },
            payload: { tag: 'Pause', value: { timeRemainingMs: Math.round(timeRemainingMs), isAutoPause: true } },
            timestamp: ctx.timestamp,
        }, SYSTEM_USER_ID));
        ctx.db.MatchSession.lobbyId.update(updateWithAudit(ctx, session, {
            timerState: {
                ...session.timerState,
                isPaused: true,
            },
        }, SYSTEM_USER_ID));
        console.log(`[REFEREE_CHECK] Lobby #${lobbyId}: draft auto-paused, player #${userId} still offline after the grace period`);
    },
);
