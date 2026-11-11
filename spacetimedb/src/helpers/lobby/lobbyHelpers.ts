import { SenderError } from 'spacetimedb/server';
import { isRoleAtLeast } from '@module/helpers/identity/ensurePermissions';
import { updateWithAudit } from '@module/helpers/admin/auditHelpers';
import { transferFlagsOnRemoval } from './flagTransferHelpers';
import { memberHasLeft, slotTeam } from './memberPredicates';
import { hasLivePresence } from '@module/helpers/identity/presenceHelpers';

// ─── Server-generated join codes ──────────────────────────────────────────────
// Deterministic hash-based code generation (no Math.random — reducers must be deterministic).
// 6 uppercase alphanumeric chars = 36^6 = ~2.2G possible codes. Retry on collision.
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

/** A99: create_lobby and update_lobby_settings reject a private lobby that would have no password. */
export const PRIVATE_LOBBY_PASSWORD_TEXT = 'A private lobby needs a password.';

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
 * S10e fix pass (lobby audit #12, review F3): the abandoned row keeps its LobbyMemberAccount rows, so the team's
 * ownership pool, eidolon pricing and auto-pick pool stay intact mid-draft; the roster guards ("Leave the lobby
 * first") ignore them instead (accountLobbyLocks).
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
 * Deletes the member's LobbyMemberAccount rows in one lobby (the account lock of that membership). Used when a row is
 * removed (removeMemberRow); an abandoned row keeps its rows (S10e review F3, see accountLobbyLocks).
 */
export function releaseMemberAccounts(ctx: any, lobbyId: number, userId: number): void {
    for (const lma of [...ctx.db.LobbyMemberAccount.by_lobby_and_user.filter([lobbyId, userId])]) {
        ctx.db.LobbyMemberAccount.delete(lma);
    }
}

/**
 * The LobbyMemberAccount rows that lock an HSR account for the roster guards ("Leave the lobby first", D-24 / D-G-01):
 * every row of the account except those whose membership is abandoned (`abandonedAt` set, A68(4)). Lobby audit #12 /
 * S10e review F3: an abandoned player can never return to that match, so their accounts are free for their roster,
 * while the rows themselves stay for the match (team ownership pool, eidolon pricing, auto-pick pool). A row whose
 * membership is gone (orphan) still locks, as before.
 */
export function accountLobbyLocks(ctx: any, hsrAccountId: number): any[] {
    return [...ctx.db.LobbyMemberAccount.by_account.filter(hsrAccountId)].filter((lma: any) => {
        const member = [...ctx.db.LobbyMember.by_lobby_and_user.filter([lma.lobbyId, lma.userId])][0];
        return member?.abandonedAt === undefined;
    });
}

/**
 * S10w (A142): the Admin roster tools (admin_batch_upsert_characters, admin_batch_remove_characters) refuse an account
 * that accountLobbyLocks holds, exactly as the owner's own edits are refused (D-24); an abandoned member's account stays
 * free (S10e review F3). Names the first lobby by its join code (fallback: its id). S10w fix pass (review F3): a player
 * who leaves during a match is away and the lock stays; it ends when the membership row goes (removal in Waiting, the
 * lobby closing) or is abandoned.
 */
export function ensureAccountRosterEditable(ctx: any, hsrAccountId: number): void {
    const locks = accountLobbyLocks(ctx, hsrAccountId);
    if (locks.length === 0) return;
    const lobby = ctx.db.Lobby.id.find(locks[0].lobbyId);
    const label = lobby?.joinCode ? `lobby ${lobby.joinCode}` : `lobby #${locks[0].lobbyId}`;
    throw new SenderError(
        `This account is selected in active ${label}; its roster cannot be edited until the player's membership in that lobby ends or the lobby closes.`,
    );
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
 * Next per-lobby join counter (R4, A74(3)): `lobby.lastJoinSeq + 1`. The host's seat is 1, written with
 * `lastJoinSeq: 1` by create_lobby and create_tournament_lobby; join_lobby takes the next number and writes it back
 * as `lastJoinSeq` in the Lobby update it already makes (currentPlayerCount / lastActivityAt), so a departed member's
 * seat number is never handed to a later joiner. The A22(5) referee-candidate order and the S9 anonymous labels
 * derive from it.
 */
export function nextJoinSeq(lobby: any): number {
    return lobby.lastJoinSeq + 1;
}

/**
 * A74(1): the LobbyMember row holding seat `joinSeq` (`view_my_lobby_members.joinSeq`) of the lobby, through
 * `LobbyMember.lobby_id`. The member-targeting reducers (kick_member, ban_member, set_team_slot, set_captain,
 * transfer_referee) resolve their `targetJoinSeq` here and continue with the row's user id. The rejection names the
 * seat, never a user id (A74(4)).
 */
export function resolveSeat(ctx: any, lobbyId: number, joinSeq: number): any {
    for (const member of ctx.db.LobbyMember.lobby_id.filter(lobbyId)) {
        if (member.joinSeq === joinSeq) return member;
    }
    throw new SenderError(`No member sits at seat ${joinSeq} of this lobby.`);
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

// ─── A98: away and abandoned members cannot act ──────────────────────────────
/** A98 / A146: the rejection for an away row (`leftAt`, A68(2)); join_lobby is the way back. */
export const AWAY_MEMBER_TEXT = 'You are away from this match. Return to it before acting.';
/** A98 / A146: the rejection for an abandoned row (`abandonedAt`, A68(4)); it never returns. */
export const ABANDONED_MEMBER_TEXT = 'You abandoned this match and can no longer act in it.';

/**
 * A98: throws when the member row is abandoned (checked first: an abandoned row keeps its `leftAt`) or away.
 * A no-op for a present row.
 */
export function ensureMemberPresent(member: any): void {
    if (member.abandonedAt !== undefined) throw new SenderError(ABANDONED_MEMBER_TEXT);
    if (member.leftAt !== undefined) throw new SenderError(AWAY_MEMBER_TEXT);
}

/**
 * A98: the caller's LobbyMember row, which must exist ("You are not a member of this lobby.") and be present (not
 * away, not abandoned). The guard of every lobby action reducer whose power comes from the membership.
 */
export function ensurePresentMember(ctx: any, lobbyId: number, userId: number): any {
    const member = ensureLobbyMember(ctx, lobbyId, userId);
    ensureMemberPresent(member);
    return member;
}

/**
 * A98: for reducers a non-member may call (Moderator+ powers, a host without a row): when the caller holds a row, it
 * must be present. Returns the row or undefined.
 */
export function ensurePresentIfMember(ctx: any, lobbyId: number, userId: number): any | undefined {
    const member = [...ctx.db.LobbyMember.by_lobby_and_user.filter([lobbyId, userId])][0];
    if (member) ensureMemberPresent(member);
    return member;
}

/**
 * A98 (S10h review F8): the caller's LobbyMember row, which must exist ("You are not a member of this lobby."); it must
 * be present unless the caller is Moderator+, whose powers never depend on presence (as in ensureHostOrAbove).
 * Callers: kick_member, ban_member, set_captain.
 */
export function ensureMemberPresentUnlessStaff(ctx: any, lobbyId: number, user: any): any {
    const member = ensureLobbyMember(ctx, lobbyId, user.id);
    if (!isRoleAtLeast(user.role, 'Moderator')) ensureMemberPresent(member);
    return member;
}

/**
 * Checks that the user is the lobby host or has Moderator+ role.
 * Per D-21: host, admin, moderator can perform administrative lobby actions.
 * A98: a host who is not Moderator+ acts through the host role, so their row (when they hold one) must be present;
 * a Moderator+ power does not depend on membership and is unaffected.
 * Throws if neither condition is met.
 */
export function ensureHostOrAbove(ctx: any, lobby: any, user: any): void {
    const isHost = lobby.hostUserId === user.id;
    const isModOrAbove = isRoleAtLeast(user.role, 'Moderator');
    if (!isHost && !isModOrAbove) {
        throw new SenderError('Only the host, moderators, or admins can perform this action.');
    }
    if (!isModOrAbove) ensurePresentIfMember(ctx, lobby.id, user.id);
}

/**
 * A80: the caller holds the referee flag in this lobby (their LobbyMember row has `isReferee`) or has Moderator+ role.
 * No lobby setting gates it. Callers: start_draft, advance_stage.
 * A98: a referee who is not Moderator+ must be present (not away, not abandoned).
 * Throws if neither condition is met.
 */
export function ensureRefereeOrAbove(ctx: any, lobby: any, user: any): void {
    const member = [...ctx.db.LobbyMember.by_lobby_and_user.filter([lobby.id, user.id])][0];
    const isReferee = member?.isReferee === true;
    const isModOrAbove = isRoleAtLeast(user.role, 'Moderator');
    if (!isReferee && !isModOrAbove) {
        throw new SenderError('Only the referee, moderators, or admins can perform this action.');
    }
    if (!isModOrAbove) ensureMemberPresent(member);
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
 * The `member` param is the CALLER's LobbyMember row (not the target); A98: callers pass a present row
 * (ensurePresentMember).
 */
export function canKickOrBan(lobby: any, user: any, member: any): boolean {
    if (lobby.hostUserId === user.id) return true;
    if (isRoleAtLeast(user.role, 'Moderator')) return true; // Moderator or Admin
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

/** A85: a seated player = a Blue or Red player seat (not a coach, not a spectator). */
export function isSeatedPlayer(member: any): boolean {
    return slotTeam(member.lobbySlot) !== null && !slotIsCoach(member.lobbySlot);
}

/**
 * A85(1): whether a seated player of either team is still offline, away or abandoned, by the A22a "still offline"
 * test of run_referee_transfer_check (away / abandoned rows count as offline; otherwise the membership flag or a
 * live presence row of the user counts as online).
 */
export function anySeatedPlayerAway(ctx: any, lobbyId: number): boolean {
    return [...ctx.db.LobbyMember.lobby_id.filter(lobbyId)].some((m: any) =>
        isSeatedPlayer(m) && (memberHasLeft(m) || !(m.isOnline || hasLivePresence(ctx, m.userId))));
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
