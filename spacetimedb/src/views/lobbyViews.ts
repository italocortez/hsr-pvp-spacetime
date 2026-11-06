// ─── Lobby Views ──────────────────────────────────────────────────────────────
// Per-user and anonymous views scoped to lobby domain.
//
// 1. view_lobby_browser       — anonymous, projected subset of active lobby columns
// 2. view_my_lobbies          — per-user, lobbies where the caller is a member
// 3. view_my_lobby_chat       — per-user, anonymized ChatMessage rows (D-92)
// 4. view_my_lobby_members    — per-user, anonymized LobbyMember rows (D-92)

import spacetimedb from '../schema';
import { t } from 'spacetimedb/server';
import { Lobby } from '../tables/lobby';
import { Tournament } from '../tables/tournament';
import { CostSet } from '../tables/costSet';
import { GameMode, DraftMode, MatchType, LobbyStage, ChatSenderType, LobbySlot } from '../types/enums';
import { shouldAnonymize } from '../helpers/anonymousHelpers';
import { computeAnonymousLabel } from '../helpers/anonymousLabels';
import { resolveUserLabel } from '../helpers/userLabel';

// ---------------------------------------------------------------------------
// 1. Lobby Browser (anonymous view) — projected subset of lobby columns
//    D-05: Excludes config details (timers, budgets, penalties, disconnect, audit).
//    D-06: Tournament name and cost set name resolved via PK lookup server-side.
//    D-08: Finished lobbies excluded — only Waiting, Drafting, Equipping, Scoring shown.
// ---------------------------------------------------------------------------
const LobbyBrowserRow = t.object('LobbyBrowserRow', {
    id: t.u32(),
    joinCode: t.string(),
    gameMode: GameMode,
    draftMode: DraftMode,
    matchType: MatchType,
    currentPlayerCount: t.u8(),
    isTournamentControlled: t.bool(),
    isAnonymousPlayers: t.bool(),
    stage: LobbyStage,
    isPublic: t.bool(),
    teamSize: t.u8(),
    tournamentName: t.string().optional(),
    costSetName: t.string().optional(),
});

// Phase 15 D-01/D-02: moved from securityViews.ts
export const view_lobby_browser = spacetimedb.anonymousView(
    { name: 'view_lobby_browser', public: true },
    t.array(LobbyBrowserRow),
    (ctx) => {
        const lobbies: any[] = [];

        // D-08: Only Waiting, Drafting, Equipping, Scoring — exclude Finished.
        // Use the stage btree index to avoid scanning Finished lobbies.
        const activeStages: any[] = [
            { tag: 'Waiting', value: {} },
            { tag: 'Drafting', value: {} },
            { tag: 'Equipping', value: {} },
            { tag: 'Scoring', value: {} },
        ];
        const activeLobbyRows: any[] = [];
        for (const stageVal of activeStages) {
            for (const lobby of ctx.db.Lobby.stage.filter(stageVal)) {
                activeLobbyRows.push(lobby);
            }
        }

        for (const lobby of activeLobbyRows) {

            // D-06: Resolve tournament name via PK lookup
            let tournamentName: string | undefined;
            if (lobby.tournamentId) {
                const tournament = ctx.db.Tournament.id.find(lobby.tournamentId);
                if (tournament) tournamentName = tournament.name;
            }

            // D-06: Resolve cost set name via PK lookup (costSetId=0 = default, no name)
            let costSetName: string | undefined;
            if (lobby.costSetId > 0) {
                const costSet = ctx.db.CostSet.id.find(lobby.costSetId);
                if (costSet) costSetName = costSet.name;
            }

            lobbies.push({
                id: lobby.id,
                joinCode: lobby.joinCode,
                gameMode: lobby.gameMode,
                draftMode: lobby.draftMode,
                matchType: lobby.matchType,
                currentPlayerCount: lobby.currentPlayerCount,
                isTournamentControlled: lobby.isTournamentControlled,
                isAnonymousPlayers: lobby.isAnonymousPlayers,
                stage: lobby.stage,
                isPublic: lobby.isPublic,
                teamSize: lobby.teamSize,
                tournamentName,
                costSetName,
            });
        }
        return lobbies;
    }
);

// ---------------------------------------------------------------------------
// 2. My Lobbies (per-user view) — lobbies where the caller is a member
//    Resolves ctx.sender → userId via UserIdentity, then looks up LobbyMember
//    rows by userId index, then fetches each Lobby by PK.
// ---------------------------------------------------------------------------
// Phase 15 D-01/D-02: moved from securityViews.ts
export const view_my_lobbies = spacetimedb.view(
    { name: 'view_my_lobbies', public: true },
    t.array(Lobby.rowType),
    (ctx) => {
        const mapping = ctx.db.UserIdentity.identity.find(ctx.sender);
        if (!mapping) return [];

        // Look up lobby memberships via btree index on userId
        const memberships = [...ctx.db.LobbyMember.user_id.filter(mapping.userId)];

        // Fetch each lobby by PK (users are in at most 1-2 lobbies)
        const lobbies = [];
        for (const membership of memberships) {
            const lobby = ctx.db.Lobby.id.find(membership.lobbyId);
            if (lobby) {
                lobbies.push(lobby);
            }
        }
        return lobbies;
    }
);

// ---------------------------------------------------------------------------
// 3. view_my_lobby_chat (per D-92)
//    Returns ChatMessage rows for lobbies the caller is in.
//    Anonymizes senderUserId (→ 0) and resolves anonymousLabel based on
//    lobby anonymous settings and the caller's team membership.
// ---------------------------------------------------------------------------

const AnonymousChatRow = t.object('AnonymousChatRow', {
    id: t.u32(),
    lobbyId: t.u32(),
    senderUserId: t.u32(),
    senderType: ChatSenderType,
    content: t.string(),
    metadata: t.string().optional(),
    anonymousLabel: t.string().optional(),
    createdDate: t.timestamp(),
});

// Phase 15 D-01/D-02: moved from anonymousViews.ts
export const view_my_lobby_chat = spacetimedb.view(
    { name: 'view_my_lobby_chat', public: true },
    t.array(AnonymousChatRow),
    (ctx) => {
        const mapping = ctx.db.UserIdentity.identity.find(ctx.sender);
        if (!mapping) return [];
        const callerUserId = mapping.userId;

        // Get all lobbies the caller is in via user_id index
        const memberships = [...ctx.db.LobbyMember.user_id.filter(callerUserId)];

        const results: any[] = [];

        for (const membership of memberships) {
            const lobbyId = membership.lobbyId;
            const lobby = ctx.db.Lobby.id.find(lobbyId);

            // Get all ChatMessage rows for this lobby via lobby_id index
            for (const msg of ctx.db.ChatMessage.lobby_id.filter(lobbyId)) {
                // Determine if this sender should be anonymized from the caller's perspective
                const anonymize = msg.senderType.tag !== 'System' &&
                    shouldAnonymize(ctx, lobbyId, msg.senderUserId, lobby ?? undefined);

                results.push({
                    id: msg.id,
                    lobbyId: msg.lobbyId,
                    senderUserId: anonymize ? 0 : msg.senderUserId,
                    senderType: msg.senderType,
                    content: msg.content,
                    metadata: msg.metadata,
                    // Use the pre-computed anonymousLabel stored on the message row
                    anonymousLabel: anonymize ? msg.anonymousLabel : undefined,
                    createdDate: msg.createdDate,
                });
            }
        }

        return results;
    }
);

// ---------------------------------------------------------------------------
// 4. view_my_lobby_members (per D-92)
//    Returns LobbyMember rows for the caller's lobbies with anonymized
//    userId and displayName for opponents when anonymous mode is active.
// ---------------------------------------------------------------------------

const AnonymousLobbyMemberRow = t.object('AnonymousLobbyMemberRow', {
    lobbyId: t.u32(),
    userId: t.u32(),
    isOnline: t.bool(),
    lobbySlot: LobbySlot,
    isReferee: t.bool(),
    isConfirmed: t.bool(),
    isCaptain: t.bool(),
    displayName: t.string(),
    anonymousLabel: t.string().optional(),
});

// Phase 15 D-01/D-02: moved from anonymousViews.ts
export const view_my_lobby_members = spacetimedb.view(
    { name: 'view_my_lobby_members', public: true },
    t.array(AnonymousLobbyMemberRow),
    (ctx) => {
        const mapping = ctx.db.UserIdentity.identity.find(ctx.sender);
        if (!mapping) return [];
        const callerUserId = mapping.userId;

        // Get all lobbies the caller is in
        const memberships = [...ctx.db.LobbyMember.user_id.filter(callerUserId)];

        const results: any[] = [];

        for (const myMembership of memberships) {
            const lobbyId = myMembership.lobbyId;
            const lobby = ctx.db.Lobby.id.find(lobbyId);

            // Get all members in this lobby via lobby_id index
            for (const member of ctx.db.LobbyMember.lobby_id.filter(lobbyId)) {
                const anonymize = shouldAnonymize(ctx, lobbyId, member.userId, lobby ?? undefined);

                // Resolve display name — falls back to DeletedUser archive then 'User #N' (D-12)
                const { displayName: realDisplayName } = resolveUserLabel(ctx, member.userId);

                // Compute anonymous label if anonymizing
                const anonLabel = anonymize
                    ? computeAnonymousLabel(ctx, lobbyId, member.userId)
                    : undefined;

                results.push({
                    lobbyId: member.lobbyId,
                    userId: anonymize ? 0 : member.userId,
                    isOnline: member.isOnline,
                    lobbySlot: member.lobbySlot,
                    isReferee: member.isReferee,
                    isConfirmed: member.isConfirmed,
                    isCaptain: member.isCaptain,
                    displayName: anonymize ? (anonLabel ?? 'Unknown') : realDisplayName,
                    anonymousLabel: anonLabel,
                });
            }
        }

        return results;
    }
);
