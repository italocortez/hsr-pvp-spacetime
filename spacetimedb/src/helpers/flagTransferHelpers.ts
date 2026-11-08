import { pickSuccessor, type MemberLite, type Slot } from '@shared/lobby-rules';
import { slotTeam, memberHasLeft } from './memberPredicates';
import { SYSTEM_USER_ID } from './auditColumns';
import { updateWithAudit } from './auditHelpers';

// ─── Flag transfers (A22(5), A68(7)) ──────────────────────────────────────────
// Host, captain and referee move in the A22(5) order (host → Blue players → Red players → spectators → coaches, by
// joinSeq), online candidates first, then any remaining member (A68(7): a lobby with members always has a host and a
// referee); the leaver and away / abandoned rows (A68(2)(4)) are never candidates. D-35's lowest-user-id rule is
// retired. `onlineOnly` is the 15 s check's rule (A22a: the first online candidate, or the flag stays). Flags never
// return automatically to the original holder. Audit actor: SYSTEM_USER_ID.

export interface TransferOptions {
    onlineOnly?: boolean;
}

/** The pure-core view of a LobbyMember row; an away / abandoned row is offline whatever its flag says (A68(2)). */
export const toMemberLite = (m: any): MemberLite => ({
    userId: m.userId,
    slot: m.lobbySlot.tag as Slot,
    isOnline: m.isOnline && !memberHasLeft(m),
    hasLeft: memberHasLeft(m),
    isReferee: m.isReferee,
    joinOrder: m.joinSeq,
});

function setMemberFlags(ctx: any, member: any, patch: Record<string, unknown>): void {
    ctx.db.LobbyMember.by_lobby_and_user.delete([member.lobbyId, member.userId]);
    ctx.db.LobbyMember.insert(updateWithAudit(ctx, member, patch, SYSTEM_USER_ID));
}

/** Captain (D-34, A68(7)): to a player of the same team, A22(5) order, online first then any. */
export function transferCaptain(ctx: any, lobbyId: number, leavingUserId: number, opts: TransferOptions = {}): void {
    const members = [...ctx.db.LobbyMember.lobby_id.filter(lobbyId)];
    const leavingMember = members.find((m: any) => m.userId === leavingUserId);
    if (!leavingMember || !leavingMember.isCaptain) return;

    const team = slotTeam(leavingMember.lobbySlot);
    if (!team) return; // spectator — no captain transfer needed

    const hostUserId = ctx.db.Lobby.id.find(lobbyId)?.hostUserId ?? 0;
    const toUserId = pickSuccessor(
        members.map(toMemberLite), hostUserId, leavingUserId, (m) => m.slot === `${team}Player`, opts.onlineOnly ?? false,
    );
    if (toUserId === null) return; // nobody else on the team: the flag stays with its holder

    setMemberFlags(ctx, members.find((m: any) => m.userId === toUserId), { isCaptain: true });
    setMemberFlags(ctx, leavingMember, { isCaptain: false });
}

/** Referee (A22(5), A68(7)): any member, A22(5) order, online first then any. */
export function transferReferee(ctx: any, lobbyId: number, leavingUserId: number, opts: TransferOptions = {}): void {
    const members = [...ctx.db.LobbyMember.lobby_id.filter(lobbyId)];
    const leavingMember = members.find((m: any) => m.userId === leavingUserId);
    if (!leavingMember || !leavingMember.isReferee) return;

    const lobby = ctx.db.Lobby.id.find(lobbyId);
    if (!lobby) return;

    const toUserId = pickSuccessor(members.map(toMemberLite), lobby.hostUserId, leavingUserId, undefined, opts.onlineOnly ?? false);
    if (toUserId === null) return; // no other member: nothing to hand over

    setMemberFlags(ctx, members.find((m: any) => m.userId === toUserId), { isReferee: true });
    setMemberFlags(ctx, leavingMember, { isReferee: false });
}

/**
 * Moves the referee flag from `fromUserId` to `toUserId` (A22(5)/A22a). The candidate is chosen by
 * `decideRefereeTransfer` (shared/lobby-rules) in `run_referee_transfer_check`; this helper only writes the
 * two rows, re-read at call time, with the SYSTEM_USER_ID audit actor. No-op when either row is missing or
 * the source no longer holds the flag.
 */
export function moveRefereeFlag(ctx: any, lobbyId: number, fromUserId: number, toUserId: number): void {
    const from = [...ctx.db.LobbyMember.by_lobby_and_user.filter([lobbyId, fromUserId])][0];
    const to = [...ctx.db.LobbyMember.by_lobby_and_user.filter([lobbyId, toUserId])][0];
    if (!from || !to || !from.isReferee) return;

    setMemberFlags(ctx, to, { isReferee: true });
    setMemberFlags(ctx, from, { isReferee: false });
}

/** Host (D-36, A68(7)): any member, A22(5) order (the host tier is the leaver, so it starts at Blue players). */
export function transferHost(ctx: any, lobbyId: number, lobby: any, leavingUserId: number, opts: TransferOptions = {}): void {
    if (lobby.hostUserId !== leavingUserId) return;

    const members = [...ctx.db.LobbyMember.lobby_id.filter(lobbyId)];
    const toUserId = pickSuccessor(members.map(toMemberLite), lobby.hostUserId, leavingUserId, undefined, opts.onlineOnly ?? false);
    if (toUserId === null) return; // no other member: the host stays (an empty Waiting lobby is deleted by the caller)

    ctx.db.Lobby.id.update(
        updateWithAudit(ctx, lobby, { hostUserId: toUserId }, SYSTEM_USER_ID),
    );
}

/**
 * A68(7): every row removal in every stage (leave in Waiting / AwaitingResult, a spectator's or coach's leave, kick,
 * ban, user deletion) hands over captain, referee and host when the leaver held them. Runs while the leaver's row
 * still exists; the caller deletes the row afterwards and must re-read the Lobby row before writing it (the host may
 * have moved).
 */
export function transferFlagsOnRemoval(ctx: any, lobbyId: number, leavingUserId: number): void {
    transferCaptain(ctx, lobbyId, leavingUserId);
    transferReferee(ctx, lobbyId, leavingUserId);
    const lobby = ctx.db.Lobby.id.find(lobbyId);
    if (lobby) transferHost(ctx, lobbyId, lobby, leavingUserId);
}
