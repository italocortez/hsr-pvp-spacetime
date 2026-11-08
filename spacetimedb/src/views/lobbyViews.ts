// ─── Lobby Views ──────────────────────────────────────────────────────────────
// Per-user and anonymous views scoped to the lobby domain (S9a: A37, A40, A44, A48, A68(10)).
//
// 1. view_lobby_browser       — anonymous shared, projected lobby list (no user id at all)
// 2. view_my_lobbies          — per-user, layer-0 list of the caller's lobbies (away listed, abandoned dropped)
// 3. view_my_lobby            — per-user, the full Lobby row of each of the caller's lobbies, user ids masked (A37)
// 4. view_my_lobby_chat       — per-user, anonymized ChatMessage rows (D-92, A37)
// 5. view_my_lobby_members    — per-user, the R3/R4 member row with the A68(10) presence state
// 6. view_my_lobby_bans       — per-user, LobbyBan rows of lobbies the caller hosts or referees (D4)
// 7. view_lobby_presets       — per-user, the system preset plus the caller's own presets
//
// Index-only: no table scan in any view body.

import spacetimedb from '@module/schema';
import { t } from 'spacetimedb/server';
import { Lobby } from '@module/tables/lobby/lobby';
import { lobbyPresetColumns } from '@module/tables/lobby/lobbyPreset';
import {
    GameMode, DraftMode, MatchType, LobbyStage, ChatSenderType, LobbySlot, MemberPresence, BanMode, BanRestriction,
    LineupFormat, RosterVisibility, DisconnectPolicy,
} from '@module/types/enums';
import { shouldAnonymize } from '@module/helpers/identity/anonymousHelpers';
import { computeAnonymousLabel } from '@module/helpers/identity/anonymousLabels';
import { resolveUserLabel } from '@module/helpers/identity/userLabel';
import { hasLivePresence } from '@module/helpers/identity/presenceHelpers';
import {
    callerMemberships, hideUserId, maskLobbyRow, lobbyAnonymousFor, ratingVisible, renderSystemChat, anonymousLabelOr,
} from '@module/helpers/identity/viewAnonymity';
import { slotIsSpectator } from '@module/helpers/lobby/lobbyHelpers';
import { computeLobbyMemberRating } from '@module/helpers/stats/accountRating';
import { SYSTEM_USER_ID } from '@module/helpers/admin/auditColumns';

const GAME_MODES = ['MemoryOfChaos', 'ApocalypticShadow', 'AnomalyArbitration'] as const;

// ---------------------------------------------------------------------------
// 1. view_lobby_browser (anonymous shared; PAGE-MAP lobbies page; F17, D-A4, D-A8, A45(2), A68(8))
//    Live stages via the `stage` index (Waiting, Drafting, Equipping, Scoring; AwaitingResult excluded, S8e-V2):
//    spectators may join a running match (A68(8)). Public and private lobbies are listed, as before; a private
//    lobby carries no joinCode (F17: it needs the password). No user id at all: the host is a label.
// ---------------------------------------------------------------------------
const LobbyBrowserRow = t.row('LobbyBrowserRow', {
    id: t.u32().primaryKey(),
    name: t.string(),                       // D-A8: an empty name is labelled ("Lobby <code>" / "Private lobby"), never the host's name
    joinCode: t.string().optional(),        // F17: only when isPublic
    hostLabel: t.string(),                  // D-A4: the host's display name, or "Anonymous host" when the host's seat kind is anonymous
    gameMode: GameMode,
    draftMode: DraftMode,
    matchType: MatchType,
    banMode: BanMode,
    banRestriction: BanRestriction,         // A45(2)
    lineupFormat: LineupFormat,
    rosterVisibility: RosterVisibility,
    disconnectPolicy: DisconnectPolicy,
    teamSize: t.u8(),
    currentPlayerCount: t.u8(),
    coachCount: t.u8(),
    spectatorCount: t.u8(),
    maxSpectators: t.u8(),                  // A68(8)
    isPublic: t.bool(),
    isAnonymousPlayers: t.bool(),
    isAnonymousSpectators: t.bool(),
    isTournamentControlled: t.bool(),
    stage: LobbyStage,
    createdDate: t.timestamp(),
    tournamentName: t.string().optional(),
    costSetName: t.string().optional(),
});

const BROWSER_STAGES = ['Waiting', 'Drafting', 'Equipping', 'Scoring'] as const;

export const view_lobby_browser = spacetimedb.anonymousView(
    { name: 'view_lobby_browser', public: true },
    t.array(LobbyBrowserRow),
    (ctx) => {
        const rows: any[] = [];
        for (const stage of BROWSER_STAGES) {
            for (const lobby of ctx.db.Lobby.stage.filter({ tag: stage, value: {} } as any)) {
                let coachCount = 0;
                let spectatorCount = 0;
                for (const m of ctx.db.LobbyMember.lobby_id.filter(lobby.id)) {
                    const tag = m.lobbySlot.tag;
                    if (tag === 'BlueCoach' || tag === 'RedCoach') coachCount++;
                    else if (tag === 'Spectator') spectatorCount++;
                }
                const trimmed = lobby.name.trim();
                const name = trimmed.length > 0 ? trimmed : lobby.isPublic ? `Lobby ${lobby.joinCode}` : 'Private lobby';
                // S9a fix (A37): the host's own seat kind picks the flag (a spectator host follows isAnonymousSpectators);
                // a host without a member row is hidden when either flag is on.
                const hostSeat = [...ctx.db.LobbyMember.by_lobby_and_user.filter([lobby.id, lobby.hostUserId])][0];
                const hostHidden = hostSeat
                    ? (slotIsSpectator(hostSeat.lobbySlot) ? lobby.isAnonymousSpectators : lobby.isAnonymousPlayers)
                    : lobby.isAnonymousPlayers || lobby.isAnonymousSpectators;
                const hostLabel = hostHidden ? 'Anonymous host' : resolveUserLabel(ctx, lobby.hostUserId).displayName;
                const tournamentName = lobby.tournamentId !== undefined ? ctx.db.Tournament.id.find(lobby.tournamentId)?.name : undefined;
                const costSetName = lobby.costSetId > 0 ? ctx.db.CostSet.id.find(lobby.costSetId)?.name : undefined;
                rows.push({
                    id: lobby.id,
                    name,
                    joinCode: lobby.isPublic ? lobby.joinCode : undefined,
                    hostLabel,
                    gameMode: lobby.gameMode,
                    draftMode: lobby.draftMode,
                    matchType: lobby.matchType,
                    banMode: lobby.banMode,
                    banRestriction: lobby.banRestriction,
                    lineupFormat: lobby.lineupFormat,
                    rosterVisibility: lobby.rosterVisibility,
                    disconnectPolicy: lobby.disconnectPolicy,
                    teamSize: lobby.teamSize,
                    currentPlayerCount: lobby.currentPlayerCount,
                    coachCount,
                    spectatorCount,
                    maxSpectators: lobby.maxSpectators,
                    isPublic: lobby.isPublic,
                    isAnonymousPlayers: lobby.isAnonymousPlayers,
                    isAnonymousSpectators: lobby.isAnonymousSpectators,
                    isTournamentControlled: lobby.isTournamentControlled,
                    stage: lobby.stage,
                    createdDate: lobby.createdDate,
                    tournamentName,
                    costSetName,
                });
            }
        }
        return rows;
    }
);

// ---------------------------------------------------------------------------
// 2. view_my_lobbies (layer 0, PAGE-MAP D10): one small row per lobby the caller belongs to; an away row keeps its
//    lobby listed (still their match), an abandoned one drops it (A68(4)(10)). The full row is view_my_lobby (room).
// ---------------------------------------------------------------------------
const MyLobbyListRow = t.row('MyLobbyListRow', {
    id: t.u32().primaryKey(),
    joinCode: t.string(),
    name: t.string(),
    stage: LobbyStage,
    isAway: t.bool(),                       // A68(2): the caller's membership has leftAt (may return through join_lobby)
});

export const view_my_lobbies = spacetimedb.view(
    { name: 'view_my_lobbies', public: true },
    t.array(MyLobbyListRow),
    (ctx) => {
        const me = callerMemberships(ctx);
        if (!me) return [];
        const rows: any[] = [];
        for (const membership of me.memberships) {
            const lobby = ctx.db.Lobby.id.find(membership.lobbyId);
            if (!lobby) continue;
            rows.push({
                id: lobby.id,
                joinCode: lobby.joinCode,
                name: lobby.name,
                stage: lobby.stage,
                isAway: membership.leftAt !== undefined,
            });
        }
        return rows;
    }
);

// ---------------------------------------------------------------------------
// 3. view_my_lobby (PAGE-MAP lobbyroom; §A.4 P1): the full Lobby row of each lobby the caller is a member of
//    (away included, abandoned excluded). The password hash lives in the private LobbyPassword table, never here.
//    A37: hostUserId / createdById / lastModifiedById are 0 when that user is anonymized for the caller.
// ---------------------------------------------------------------------------
export const view_my_lobby = spacetimedb.view(
    { name: 'view_my_lobby', public: true },
    t.array(Lobby.rowType),
    (ctx) => {
        const me = callerMemberships(ctx);
        if (!me) return [];
        const rows: any[] = [];
        for (const membership of me.memberships) {
            const lobby = ctx.db.Lobby.id.find(membership.lobbyId);
            if (lobby) rows.push(maskLobbyRow(ctx, lobby, membership));
        }
        return rows;
    }
);

// ---------------------------------------------------------------------------
// 4. view_my_lobby_chat (D-92, A37): senderUserId 0 + the stored label when the sender is anonymized for the caller
//    (a sender who is no longer a member of an anonymous lobby included); System messages have no sender to mask,
//    but a member-event line ("{member} joined the lobby.") is rendered per reader (S9a fix, renderSystemChat).
// ---------------------------------------------------------------------------
const AnonymousChatRow = t.row('AnonymousChatRow', {
    id: t.u32().primaryKey(),
    lobbyId: t.u32(),
    senderUserId: t.u32(),
    senderType: ChatSenderType,
    content: t.string(),
    metadata: t.string().optional(),
    anonymousLabel: t.string().optional(),
    createdDate: t.timestamp(),
});

export const view_my_lobby_chat = spacetimedb.view(
    { name: 'view_my_lobby_chat', public: true },
    t.array(AnonymousChatRow),
    (ctx) => {
        const me = callerMemberships(ctx);
        if (!me) return [];
        const results: any[] = [];
        for (const membership of me.memberships) {
            const lobby = ctx.db.Lobby.id.find(membership.lobbyId);
            if (!lobby) continue;
            for (const msg of ctx.db.ChatMessage.lobby_id.filter(lobby.id)) {
                const isSystem = msg.senderType.tag === 'System';
                const anonymize = !isSystem && hideUserId(ctx, lobby, membership, msg.senderUserId);
                // S9a fix (A37): a System member-event line is rendered for this reader (renderSystemChat)
                const shown = isSystem ? renderSystemChat(ctx, lobby, membership, msg) : msg;
                results.push({
                    id: msg.id,
                    lobbyId: msg.lobbyId,
                    senderUserId: anonymize ? 0 : msg.senderUserId,
                    senderType: msg.senderType,
                    content: shown.content,
                    metadata: shown.metadata,
                    anonymousLabel: anonymize ? msg.anonymousLabel : undefined,
                    createdDate: msg.createdDate,
                });
            }
        }
        return results;
    }
);

// ---------------------------------------------------------------------------
// 5. view_my_lobby_members (PAGE-MAP lobbyroom "after S9"; §A.4 P1; A37, A40, A48, A68(10); R3 / R4)
//    One row per member of each of the caller's lobbies; the only source of the seat cards and the peek card.
//    Anonymized seat (shouldAnonymize): userId 0, label from computeAnonymousLabel (slot + joinSeq), no avatar /
//    title / MMR. MMR only when identified and the lobby does not hide it (A40 (2)); the account rating (merged over
//    the member's selected accounts, backlog #10) and the account count per ratingVisible (A40: anonymized seats too).
//    Never the cursor / lineup throttle stamps (S5 finding 2) nor audit columns.
//    memberKey = lobbyId << 32 | joinSeq: the PK must be unique across the caller's lobbies (a player may hold parked
//    AwaitingResult rows next to a live one, D-22 `free`), and joinSeq is unique only within a lobby.
// ---------------------------------------------------------------------------
const LobbyMemberViewRow = t.row('LobbyMemberViewRow', {
    memberKey: t.u64().primaryKey(),
    lobbyId: t.u32(),
    joinSeq: t.u32(),
    userId: t.u32(),                        // 0 when anonymized
    label: t.string(),                      // anonymous label or the real display name
    lobbySlot: LobbySlot,
    presence: MemberPresence,               // A68(10)
    isHost: t.bool(),                       // view_my_lobby masks hostUserId on anonymized seats; the seat keeps the crown
    isReferee: t.bool(),
    isCaptain: t.bool(),
    isConfirmed: t.bool(),
    avatarCharacterName: t.string().optional(),   // R3: identified seats only
    displayedAchievementId: t.u32().optional(),   // R3: identified seats only
    mmrByMode: t.array(t.u32()).optional(),       // [MemoryOfChaos, ApocalypticShadow, AnomalyArbitration], active season
    accountRating: t.u32().optional(),
    accountCount: t.u8().optional(),
});

function memberPresence(ctx: any, member: any): { tag: string; value: {} } {
    if (member.abandonedAt !== undefined) return { tag: 'Gone', value: {} };
    if (member.leftAt !== undefined) return { tag: 'Away', value: {} };
    return member.isOnline || hasLivePresence(ctx, member.userId)
        ? { tag: 'Online', value: {} }
        : { tag: 'Offline', value: {} };
}

export const view_my_lobby_members = spacetimedb.view(
    { name: 'view_my_lobby_members', public: true },
    t.array(LobbyMemberViewRow),
    (ctx) => {
        const me = callerMemberships(ctx);
        if (!me) return [];

        // MMR inputs, read once: the active season (0 = pre-season) and the default rating for a mode never played.
        const activeSeason = [...ctx.db.Season.is_active.filter(true)][0];
        const seasonId = activeSeason ? activeSeason.id : 0;
        const initialRating = ctx.db.EloConfigTable.id.find(1)?.initialRating ?? 0;

        const results: any[] = [];
        for (const myMembership of me.memberships) {
            const lobby = ctx.db.Lobby.id.find(myMembership.lobbyId);
            if (!lobby) continue;
            for (const member of ctx.db.LobbyMember.lobby_id.filter(lobby.id)) {
                const anonymize = shouldAnonymize(ctx, lobby.id, member.userId, lobby);
                const user = anonymize ? undefined : ctx.db.User.id.find(member.userId);
                const label = anonymize
                    ? computeAnonymousLabel(ctx, lobby.id, member.userId)
                    : resolveUserLabel(ctx, member.userId).displayName;

                let mmrByMode: number[] | undefined;
                if (!anonymize && !lobby.hideMmr) {
                    mmrByMode = GAME_MODES.map((mode) => {
                        const row = [...ctx.db.MmrRating.by_user_mode_season.filter([member.userId, { tag: mode } as any, seasonId])][0];
                        return row ? row.rating : initialRating;
                    });
                }

                let accountRating: number | undefined;
                let accountCount: number | undefined;
                if (ratingVisible(lobby, myMembership, member)) {
                    accountRating = computeLobbyMemberRating(ctx, lobby.id, member.userId); // integer already (A40: exact)
                    accountCount = [...ctx.db.LobbyMemberAccount.by_lobby_and_user.filter([lobby.id, member.userId])].length;
                }

                results.push({
                    memberKey: (BigInt(lobby.id) << 32n) | BigInt(member.joinSeq),
                    lobbyId: lobby.id,
                    joinSeq: member.joinSeq,
                    userId: anonymize ? 0 : member.userId,
                    label,
                    lobbySlot: member.lobbySlot,
                    presence: memberPresence(ctx, member),
                    isHost: lobby.hostUserId === member.userId,
                    isReferee: member.isReferee,
                    isCaptain: member.isCaptain,
                    isConfirmed: member.isConfirmed,
                    avatarCharacterName: user ? user.avatarCharacterName : undefined,
                    displayedAchievementId: user ? user.displayedAchievementId : undefined,
                    mmrByMode,
                    accountRating,
                    accountCount,
                });
            }
        }
        return results;
    }
);

// ---------------------------------------------------------------------------
// 6. view_my_lobby_bans (PAGE-MAP D4; A44(1)): LobbyBan rows of the lobbies where the caller is the host or holds
//    the referee flag (the ban list of the context menu; A74(2): unban_member takes the row's `bannedJoinSeq`, the
//    seat the member held when banned, so an anonymized caller can lift a ban it cannot name). bannedByUserId is
//    withheld when the lobby's anonymity applies to the caller (A37). S9a fix (A37): the banned user follows
//    hideUserId (a former member of an anonymous lobby is hidden): bannedUserId 0 and the label "Banned player" (a
//    banned user holds no member row while banned); `bannedJoinSeq` (a unique key of the row with lobbyId) identifies
//    the ban to the client and to unban_member.
// ---------------------------------------------------------------------------
const LobbyBanViewRow = t.row('LobbyBanViewRow', {
    lobbyId: t.u32(),
    bannedUserId: t.u32(),
    bannedJoinSeq: t.u32(),
    label: t.string(),
    bannedByUserId: t.u32().optional(),
    createdDate: t.timestamp(),
});

export const view_my_lobby_bans = spacetimedb.view(
    { name: 'view_my_lobby_bans', public: true },
    t.array(LobbyBanViewRow),
    (ctx) => {
        const me = callerMemberships(ctx);
        if (!me) return [];
        const results: any[] = [];
        for (const membership of me.memberships) {
            const lobby = ctx.db.Lobby.id.find(membership.lobbyId);
            if (!lobby) continue;
            if (lobby.hostUserId !== me.userId && !membership.isReferee) continue;
            const hideBanner = lobbyAnonymousFor(lobby, membership);
            for (const ban of ctx.db.LobbyBan.lobby_id.filter(lobby.id)) {
                // S9a fix (A37): a banned user hidden from the caller (a former member is a non-member) reads 0 + label
                const hideBanned = hideUserId(ctx, lobby, membership, ban.bannedUserId);
                results.push({
                    lobbyId: ban.lobbyId,
                    bannedUserId: hideBanned ? 0 : ban.bannedUserId,
                    bannedJoinSeq: ban.bannedJoinSeq,
                    label: hideBanned
                        ? anonymousLabelOr(ctx, lobby.id, ban.bannedUserId, 'Banned player')
                        : resolveUserLabel(ctx, ban.bannedUserId).displayName,
                    bannedByUserId: hideBanner && ban.bannedByUserId !== me.userId ? undefined : ban.bannedByUserId,
                    createdDate: ban.createdDate,
                });
            }
        }
        return results;
    }
);

// ---------------------------------------------------------------------------
// 7. view_lobby_presets (PAGE-MAP D4 / D5; A33a; S6 hand-off): LobbyPreset is private; the caller reads the system
//    preset (owned by SYSTEM) plus their own presets, full row minus the audit columns. Unknown sender → [].
// ---------------------------------------------------------------------------
const {
    createdById: _presetCreatedById,
    createdDate: _presetCreatedDate,
    lastModifiedById: _presetLastModifiedById,
    lastModifiedDate: _presetLastModifiedDate,
    ...presetViewColumns
} = lobbyPresetColumns;

const LobbyPresetViewRow = t.row('LobbyPresetViewRow', {
    ...presetViewColumns,
    id: t.u32().primaryKey(),
});

function presetViewRow(preset: any): any {
    const { createdById, createdDate, lastModifiedById, lastModifiedDate, ...rest } = preset;
    return rest;
}

export const view_lobby_presets = spacetimedb.view(
    { name: 'view_lobby_presets', public: true },
    t.array(LobbyPresetViewRow),
    (ctx) => {
        const mapping = ctx.db.UserIdentity.identity.find(ctx.sender);
        if (!mapping) return [];
        const results: any[] = [];
        for (const preset of ctx.db.LobbyPreset.creator_user_id.filter(SYSTEM_USER_ID)) {
            if (preset.isSystemPreset) results.push(presetViewRow(preset));
        }
        if (mapping.userId !== SYSTEM_USER_ID) {
            for (const preset of ctx.db.LobbyPreset.creator_user_id.filter(mapping.userId)) {
                results.push(presetViewRow(preset));
            }
        }
        return results;
    }
);
