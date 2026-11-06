import { SenderError } from 'spacetimedb/server';
import { isRoleAtLeast } from './ensurePermissions';

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

/**
 * Ensures the user is not currently in any lobby.
 * Per D-22: one lobby at a time per user.
 * Throws if the user is already a member of any lobby.
 */
export function ensureNotInLobby(ctx: any, userId: number): void {
    const memberships = [...ctx.db.LobbyMember.user_id.filter(userId)];
    // Skip memberships in AwaitingResult lobbies and voluntarilyLeft members
    const activeMemberships = memberships.filter((m: any) => {
        const lobby = ctx.db.Lobby.id.find(m.lobbyId);
        return lobby && lobby.stage.tag !== 'AwaitingResult' && !m.voluntarilyLeft;
    });
    if (activeMemberships.length > 0) {
        throw new SenderError('You are already in a lobby. Leave it before creating or joining another.');
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

/** Get team from LobbySlot: BluePlayer→'Blue', RedCoach→'Red', Spectator→null */
export function slotTeam(slot: any): string | null {
    const tag: string = slot.tag;
    if (tag.startsWith('Blue')) return 'Blue';
    if (tag.startsWith('Red')) return 'Red';
    return null;
}

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
