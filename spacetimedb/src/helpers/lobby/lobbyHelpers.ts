import { SenderError } from 'spacetimedb/server';
import { isRoleAtLeast } from '@module/helpers/identity/ensurePermissions';
import { updateWithAudit } from '@module/helpers/admin/auditHelpers';
import { transferFlagsOnRemoval } from './flagTransferHelpers';
import { memberHasLeft, slotTeam } from './memberPredicates';

// ─── Server-generated join codes ──────────────────────────────────────────────
// Deterministic hash-based code generation (no Math.random — reducers must be deterministic).
// 5 uppercase alphanumeric chars = 36^5 = ~60M possible codes. Retry on collision.
const JOIN_CODE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const JOIN_CODE_LENGTH = 6;
const MAX_RETRIES = 10;

export function generateJoinCode(ctx: any, userId: number): string {
    const timeMicros = Number(ctx.timestamp.microsSinceUnixEpoch % BigInt(2_000_000_000));
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        let hash = (userId * 2654435761 + timeMicros + attempt * 31) >>> 0;
        let code = '';
        for (let i = 0; i < JOIN_CODE_LENGTH; i++) {
            code += JOIN_CODE_CHARS[hash % JOIN_CODE_CHARS.length];
            hash = (hash * 31 + 17) >>> 0;
        }
        if (!ctx.db.Lobby.joinCode.find(code)) {
            return code;
        }
    }
    throw new SenderError('Could not generate a unique join code. Please try again.');
}

/** A67(1): the live stages of a lobby's one game. */
export const LIVE_STAGES: readonly string[] = ['Drafting', 'Equipping', 'Scoring'];

// memberHasLeft (A68(2)(4)) and slotTeam live in memberPredicates (no imports) and are re-exported here.
export { memberHasLeft, slotTeam } from './memberPredicates';

/** A68(8): the spectator count setting, 0-12; `value` omitted takes `fallback`. */
export function resolveMaxSpectators(value: number | undefined, fallback: number): number {
    const resolved = value ?? fallback;
    if (resolved < 0 || resolved > 12) {
        throw new SenderError('maxSpectators must be between 0 and 12.');
    }
    return resolved;
}

/**
 * D-22 / A68(4): how a membership counts for the one-lobby-at-a-time rule.
 *   - 'free': the lobby is gone or parked in AwaitingResult, or the row is abandoned (A68(4)); never counts.
 *   - 'away': a `leftAt` row in a live stage (A68(2)); the user may give it up with abandonCurrentMatch.
 *   - 'held': anything else (online in any stage, a Waiting row, a spectator / coach row, A68(5)).
 */
export function membershipHold(ctx: any, member: any): { kind: 'free' | 'away' | 'held'; lobby: any } {
    const lobby = ctx.db.Lobby.id.find(member.lobbyId);
    if (!lobby || lobby.stage.tag === 'AwaitingResult' || member.abandonedAt !== undefined) return { kind: 'free', lobby };
    if (member.leftAt !== undefined && LIVE_STAGES.includes(lobby.stage.tag)) return { kind: 'away', lobby };
    return { kind: 'held', lobby };
}

/**
 * D-22 / A68(4): one lobby at a time. Throws when the user holds a membership; an away membership (A68(2)) is given
 * up only when the caller confirms (`abandonCurrentMatch`): its row becomes abandoned (`abandonedAt` set, `leftAt`,
 * `isOnline = false` and `disconnectedAt` kept; it still counts as an offline player for the forfeit test and in
 * currentPlayerCount) and the caller may proceed. Callers: create_lobby, join_lobby (new joins), create_tournament_lobby.
 */
export function ensureNotInLobby(ctx: any, userId: number, abandonCurrentMatch: boolean): void {
    const away: Array<{ member: any; lobby: any }> = [];
    for (const member of [...ctx.db.LobbyMember.user_id.filter(userId)]) {
        const hold = membershipHold(ctx, member);
        if (hold.kind === 'held') {
            throw new SenderError('You are already in a lobby. Leave it before creating or joining another.');
        }
        if (hold.kind === 'away') away.push({ member, lobby: hold.lobby });
    }
    if (away.length === 0) return;
    if (!abandonCurrentMatch) {
        // A68(4): the prompt text the client shows before the caller confirms.
        throw new SenderError(`You left lobby ${away[0].lobby.joinCode} mid-match. Joining here means you cannot return to it.`);
    }
    for (const { member } of away) {
        // A68(4) "the flag transfers" / A68(7) "always has a host and a referee": flags the 15 s check left on the away
        // row (no online candidate then) move now, online first then any; the abandoned row is never a candidate again.
        transferFlagsOnRemoval(ctx, member.lobbyId, userId);
        const current = [...ctx.db.LobbyMember.by_lobby_and_user.filter([member.lobbyId, userId])][0] ?? member;
        ctx.db.LobbyMember.by_lobby_and_user.delete([member.lobbyId, userId]);
        ctx.db.LobbyMember.insert(updateWithAudit(ctx, current, { abandonedAt: ctx.timestamp }, userId));
        console.log(`[LOBBY] User #${userId} abandoned lobby #${member.lobbyId} to take another lobby (A68(4))`);
    }
}

/**
 * Enforces guest restrictions for lobby creation/join.
 * Per D-23: guests cannot create or join Ranked lobbies.
 */
export function ensureGuestRestrictions(user: any, matchType: any): void {
    if (user.isGuest === true && matchType.tag === 'Ranked') {
        throw new SenderError('Guests cannot create or join Ranked lobbies.');
    }
}

/**
 * Next per-lobby join counter (R4): max existing `LobbyMember.joinSeq` in the lobby + 1, starting at 1
 * for the first member (the host). Assigned at insert time by create_lobby, join_lobby and
 * create_tournament_lobby; the A22(5) referee-candidate order and the S9 anonymous labels derive from it.
 */
export function nextJoinSeq(ctx: any, lobbyId: number): number {
    const members = [...ctx.db.LobbyMember.lobby_id.filter(lobbyId)];
    if (members.length === 0) return 1;
    return Math.max(...members.map((m: any) => m.joinSeq)) + 1;
}

/**
 * Returns the LobbyMember row for the given user in the given lobby.
 * Throws if the user is not a member of the lobby.
 */
export function ensureLobbyMember(ctx: any, lobbyId: number, userId: number): any {
    const member = [...ctx.db.LobbyMember.by_lobby_and_user.filter([lobbyId, userId])][0];
    if (!member) {
        throw new SenderError('You are not a member of this lobby.');
    }
    return member;
}

/**
 * Checks that the user is the lobby host or has Moderator+ role.
 * Per D-21: host, admin, moderator can perform administrative lobby actions.
 * Throws if neither condition is met.
 */
export function ensureHostOrAbove(ctx: any, lobby: any, user: any): void {
    const isHost = lobby.hostUserId === user.id;
    const isModOrAbove = isRoleAtLeast(user.role, 'Moderator');
    if (!isHost && !isModOrAbove) {
        throw new SenderError('Only the host, moderators, or admins can perform this action.');
    }
}

/**
 * Ensures the user is not banned from the given lobby.
 * Per D-21: banned users cannot rejoin.
 * Throws if a ban record exists for this user in this lobby.
 */
export function ensureNotBanned(ctx: any, lobbyId: number, userId: number): void {
    const ban = [...ctx.db.LobbyBan.by_lobby_and_user.filter([lobbyId, userId])][0];
    if (ban) {
        throw new SenderError('You are banned from this lobby.');
    }
}

/**
 * Ensures the lobby is in one of the given stages.
 * Throws with the current stage name if not.
 */
export function ensureStageIs(lobby: any, ...stages: string[]): void {
    if (!stages.includes(lobby.stage.tag)) {
        throw new SenderError(
            'This action is not allowed in the current lobby stage (' + lobby.stage.tag + ').'
        );
    }
}

/**
 * Returns true if the caller user can kick or ban a member.
 * Per D-21: host, admin, moderator can kick/ban.
 * Per D-32: refereeCanKick flag on lobby controls whether referees can kick.
 * The `member` param is the CALLER's LobbyMember row (not the target).
 */
export function canKickOrBan(ctx: any, lobby: any, user: any, member: any): boolean {
    if (lobby.hostUserId === user.id) return true;
    if (isRoleAtLeast(user.role, 'Admin')) return true;
    if (isRoleAtLeast(user.role, 'Moderator')) return true;
    if (member.isReferee && lobby.refereeCanKick) return true;
    return false;
}

// ─── LobbySlot helpers ──────────────────────────────────────────────────────
// Utility functions for extracting team/role info from the unified LobbySlot enum.

/** Check if slot is a coach variant */
export function slotIsCoach(slot: any): boolean {
    return slot.tag === 'BlueCoach' || slot.tag === 'RedCoach';
}

/** Check if slot is a spectator */
export function slotIsSpectator(slot: any): boolean {
    return slot.tag === 'Spectator';
}

/** Check if two slots are on the same team (both Blue* or both Red*) */
export function slotSameTeam(a: any, b: any): boolean {
    const teamA = slotTeam(a);
    const teamB = slotTeam(b);
    return teamA !== null && teamA === teamB;
}

/** Convert LobbySlot to a TeamSide enum value (for match recording) */
export function slotToTeamSide(slot: any): any {
    const team = slotTeam(slot);
    if (team === 'Blue') return { tag: 'Blue', value: {} };
    if (team === 'Red') return { tag: 'Red', value: {} };
    return { tag: 'Spectator', value: {} };
}
