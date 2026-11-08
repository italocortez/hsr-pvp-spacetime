import { shouldAnonymize } from './anonymousHelpers';
import { computeAnonymousLabel } from './anonymousLabels';
import { resolveUserLabel } from './userLabel';
import { slotIsSpectator, slotSameTeam } from '@module/helpers/lobby/lobbyHelpers';
import { parseMemberEvent, renderMemberEvent } from '@module/helpers/lobby/memberEventChat';
import { isRoleAtLeast } from './ensurePermissions';

// ─── View-side anonymity (S9a; A37, A40) ────────────────────────────────────────────────────────────────────
// Read-only helpers shared by the per-sender lobby / match views. Index-only: UserIdentity.identity,
// LobbyMember.user_id / by_lobby_and_user, Lobby.id. Nothing here writes.

/** The caller's user id and the memberships the per-sender views fan out from: abandoned rows excluded (A68(4)(10)). */
export function callerMemberships(ctx: any): { userId: number; memberships: any[] } | null {
    const mapping = ctx.db.UserIdentity.identity.find(ctx.sender);
    if (!mapping) return null;
    const memberships = [...ctx.db.LobbyMember.user_id.filter(mapping.userId)]
        .filter((m: any) => m.abandonedAt === undefined);
    return { userId: mapping.userId, memberships };
}

/** The lobby's anonymity flags apply to this caller at all (D-71: a spectator referee sees every real identity). */
export function lobbyAnonymousFor(lobby: any, caller: any): boolean {
    if (!lobby || (!lobby.isAnonymousPlayers && !lobby.isAnonymousSpectators)) return false;
    return !(caller?.isReferee && slotIsSpectator(caller.lobbySlot));
}

/**
 * A37: whether `targetUserId` must be withheld from `caller` in this lobby. The caller and 0 (SYSTEM) are never
 * hidden; a current member follows shouldAnonymize (D-69..D-71); in a lobby whose anonymity applies to the caller,
 * an id that is no longer a member (a leaver, an outsider staff actor) is withheld too, because no seat rule can
 * clear it.
 */
export function hideUserId(ctx: any, lobby: any, caller: any, targetUserId: number | undefined): boolean {
    if (targetUserId === undefined || targetUserId === 0 || targetUserId === caller.userId) return false;
    if (!lobbyAnonymousFor(lobby, caller)) return false;
    const target = [...ctx.db.LobbyMember.by_lobby_and_user.filter([lobby.id, targetUserId])][0];
    if (!target) return true;
    return shouldAnonymize(ctx, lobby.id, targetUserId, lobby);
}

/** `id` or 0 per hideUserId; undefined stays undefined. */
export function maskUserId(ctx: any, lobby: any, caller: any, id: number | undefined): number | undefined {
    if (id === undefined) return undefined;
    return hideUserId(ctx, lobby, caller, id) ? 0 : id;
}

/** The full Lobby row with every user id the caller may not see set to 0 (host and audit columns, A37). */
export function maskLobbyRow(ctx: any, lobby: any, caller: any): any {
    if (!lobbyAnonymousFor(lobby, caller)) return lobby;
    return {
        ...lobby,
        hostUserId: maskUserId(ctx, lobby, caller, lobby.hostUserId),
        createdById: maskUserId(ctx, lobby, caller, lobby.createdById),
        lastModifiedById: maskUserId(ctx, lobby, caller, lobby.lastModifiedById),
    };
}

/**
 * A40: an account rating of `target` is shown to `caller` when the lobby's roster visibility allows ratings
 * (OpenRoster / ClosedWithRating), on anonymized seats too; under ClosedNoRating only the caller's own, a teammate's
 * (D-70) or, for a spectator referee (D-71), everyone's.
 */
export function ratingVisible(lobby: any, caller: any, target: any): boolean {
    const vis = lobby.rosterVisibility.tag;
    if (vis === 'OpenRoster' || vis === 'ClosedWithRating') return true;
    if (!target) return false;
    if (target.userId === caller.userId) return true;
    if (caller.isReferee && slotIsSpectator(caller.lobbySlot)) return true;
    return slotSameTeam(caller.lobbySlot, target.lobbySlot);
}

/**
 * A37 seat label of `userId` for a reader who may not see them: the live computeAnonymousLabel (slot + joinSeq) while
 * they hold a LobbyMember row, else `fallback` (a label stored at write time, or a slot-based text). Never "Unknown".
 */
export function anonymousLabelOr(ctx: any, lobbyId: number, userId: number, fallback: string): string {
    const isMember = [...ctx.db.LobbyMember.by_lobby_and_user.filter([lobbyId, userId])].length > 0;
    return isMember ? computeAnonymousLabel(ctx, lobbyId, userId) : fallback;
}

/**
 * S9a fix (A37): the content / metadata of a System chat message as `caller` reads it. A member-event line
 * (helpers/lobby/memberEventChat.ts) is rendered from its template with the subject's label for this reader: the
 * display name when the subject is visible (resolveUserLabel), else the seat label (anonymousLabelOr, falling back to
 * the label stored at write time, then "A player"); its metadata goes out with subjectUserId 0 for a hidden subject.
 * Any other System line passes through unchanged.
 */
export function renderSystemChat(ctx: any, lobby: any, caller: any, msg: any): { content: string; metadata: string | undefined } {
    const ev = parseMemberEvent(msg.metadata);
    if (!ev) return { content: msg.content, metadata: msg.metadata };
    const hidden = hideUserId(ctx, lobby, caller, ev.subjectUserId);
    const label = hidden
        ? anonymousLabelOr(ctx, lobby.id, ev.subjectUserId, msg.anonymousLabel ?? 'A player')
        : resolveUserLabel(ctx, ev.subjectUserId).displayName;
    return {
        content: renderMemberEvent(ev.event, label),
        metadata: hidden ? JSON.stringify({ event: ev.event, subjectUserId: 0 }) : msg.metadata,
    };
}

// ─── S9b additions ───────────────────────────────────────────────────────────────────────────────────────────

/** S9b: the caller's user id (UserIdentity.identity), or undefined for an unmapped identity. */
export function callerUserId(ctx: any): number | undefined {
    return ctx.db.UserIdentity.identity.find(ctx.sender)?.userId;
}

/** S9b staff views: the caller's User row when their role is Moderator or above, else undefined (the view returns []). */
export function staffCaller(ctx: any): any | undefined {
    const userId = callerUserId(ctx);
    if (userId === undefined) return undefined;
    const user = ctx.db.User.id.find(userId);
    if (!user || !isRoleAtLeast(user.role, 'Moderator')) return undefined;
    return user;
}

/** The MMR modes in the order of every `mmrByMode` array: [MemoryOfChaos, ApocalypticShadow, AnomalyArbitration]. */
export const MMR_GAME_MODES = ['MemoryOfChaos', 'ApocalypticShadow', 'AnomalyArbitration'] as const;

/**
 * S9b (A40): a user's MMR per mode for the active season (0 = pre-season), `EloConfig.initialRating` for a mode never
 * played; index-only (Season.is_active, EloConfigTable.id, MmrRating.by_user_mode_season). The same reading as the
 * lobby member row's `mmrByMode`.
 */
export function mmrByModeOf(ctx: any, userId: number): number[] {
    const activeSeason = [...ctx.db.Season.is_active.filter(true)][0];
    const seasonId = activeSeason ? activeSeason.id : 0;
    const initialRating = ctx.db.EloConfigTable.id.find(1)?.initialRating ?? 0;
    return MMR_GAME_MODES.map((mode) => {
        const row = [...ctx.db.MmrRating.by_user_mode_season.filter([userId, { tag: mode } as any, seasonId])][0];
        return row ? row.rating : initialRating;
    });
}
