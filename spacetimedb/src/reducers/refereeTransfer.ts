import spacetimedb from '../schema';
import { RefereeTransferCheck } from '../tables/refereeTransferCheck';
import {
    ACTIVE_STAGES,
    decideAutoPause,
    decideRefereeTransfer,
    type LobbyStage,
    type MemberLite,
    type Slot,
} from '@shared/lobby-rules';
import { SYSTEM_USER_ID } from '../helpers/auditColumns';
import { insertWithAudit, updateWithAudit } from '../helpers/auditHelpers';
import { moveRefereeFlag, transferCaptain, transferHost } from '../helpers/flagTransferHelpers';
import { slotToTeamSide } from '../helpers/lobbyHelpers';
import { hasLivePresence } from '../helpers/presenceHelpers';
import { getNextSequence } from '../helpers/stepSequence';

// ─── run_referee_transfer_check ───────────────────────────────────────────────
// A22a scheduled check (ACCESS-SECURITY-OPS D.8.2), bound to RefereeTransferCheck through `onSchedule`
// (SDK 2.7+ form, no table→reducer cycle). `client_disconnected` inserts one row per active-stage membership,
// 15 s out, when the user's last connection drops; `client_connected` deletes the pending rows, so a page
// refresh inside the window never reaches this reducer. The scheduler consumes the row; the reducer is a
// no-op when the lobby or the member is gone.
//
// Decisions come from the pure core in shared/lobby-rules (`decideRefereeTransfer`, `decideAutoPause`):
//   - referee flag: moves only if the subject is still offline, still referee and the stage is active, to the
//     first online candidate in the A22(5) order (host → Blue players → Red players → spectators → coaches,
//     by joinSeq; leaver, offline and voluntarilyLeft skipped);
//   - captain and host: the existing D-34 / D-36 transfers, run with the same grace when still offline;
//   - auto-pause: only an offline *team player* in Drafting under Standard/Deferred, when not already paused.
//     Spectators and coaches never pause anything (F5); a spectator referee or host loses that flag only by the
//     A22(5) rule above, like anyone else.

const toLite = (m: any): MemberLite => ({
    userId: m.userId,
    slot: m.lobbySlot.tag as Slot,
    isOnline: m.isOnline,
    voluntarilyLeft: m.voluntarilyLeft,
    isReferee: m.isReferee,
    joinOrder: m.joinSeq,
});

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
        const subject: MemberLite = { ...toLite(member), isOnline: member.isOnline || hasLivePresence(ctx, userId) };

        const decision = decideRefereeTransfer({
            subjectUserId: userId,
            subject,
            members: members.map(toLite),
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
                transferHost(ctx, lobbyId, freshLobby, userId);
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
            gameNumber: session.currentGameNumber,
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
