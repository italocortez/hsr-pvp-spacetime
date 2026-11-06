import { table, t } from 'spacetimedb/server';
import { DraftMode, BanMode, LobbyStage, DisconnectPolicy, GameMode, RosterVisibility, MatchType } from '../types/enums';

export const lobbyColumns = {
    id: t.u32().primaryKey().autoInc(),
    joinCode: t.string().unique(),
    hostUserId: t.u32(),
    teamBlueAlias: t.string(),
    teamRedAlias: t.string(),

    // Flattened from LobbyConfig:
    teamSize: t.u8(),
    draftMode: DraftMode,
    banMode: BanMode,
    standardTurnSeconds: t.u32(),
    reserveBankSeconds: t.u32(),
    rosterDiffAdvantage: t.f32(),
    rosterThreshold: t.f32(),
    underThresholdAdvantage: t.f32(),
    aboveThresholdPenalty: t.f32(),
    deathPenalty: t.f32(),

    // Match type:
    matchType: MatchType,

    // Player count (denormalized for browser view per D-07):
    currentPlayerCount: t.u8(),

    // Budget (dual budgets per D-49, replaces auctionBudget):
    characterBudget: t.f32(),
    lightconeBudget: t.f32(),
    minimumBidRaise: t.f32(),

    // Draft options:
    allowMirrorPicks: t.bool(),
    autoRandomPick: t.bool(),

    // Referee power configuration per D-32:
    refereeCanUndo: t.bool(),
    refereeCanPause: t.bool(),
    refereeCanSetCaptain: t.bool(),
    refereeCanKick: t.bool(),

    // Player pause per D-33:
    allowPlayerPause: t.bool(),

    // Referee exclusive concede per D-92:
    refereeExclusiveConcede: t.bool(),

    // Tournament linkage:
    tournamentId: t.u32().optional(),
    bracketMatchId: t.u32().optional(),
    isTournamentControlled: t.bool(),

    // Anonymous play:
    isAnonymousPlayers: t.bool(),
    isAnonymousSpectators: t.bool(),

    // Roster:
    rosterVisibility: RosterVisibility,
    requireOwnership: t.bool(),
    costSetId: t.u32(),

    // Visibility:
    isPublic: t.bool(),
    // passwordHash moved to LobbyPassword (private table) — never broadcast to clients

    // Best-of-N series (per D-11):
    bestOf: t.u8(),                    // Default 1 (set in reducer). 1 = single game, 3/5/7 = series.
    refereeControlsShelving: t.bool(), // Default true (set in reducer). When true + 3rd party referee present, only referee controls shelve/continue in BetweenGames.

    // Disconnect behavior:
    disconnectPolicy: DisconnectPolicy,
    disconnectForfeitSeconds: t.u32().optional(), // Grace period in seconds, default 60

    // Game mode:
    gameMode: GameMode,

    // Lifecycle:
    lastActivityAt: t.timestamp(),
    stage: LobbyStage,

    // Audit:
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

export const Lobby = table({
    name: 'lobby',
    public: true,
    indexes: [
        { accessor: 'host_user_id', algorithm: 'btree', columns: ['hostUserId'] },
        { accessor: 'stage', algorithm: 'btree', columns: ['stage'] },
        { accessor: 'tournament_id', algorithm: 'btree', columns: ['tournamentId'] },
        { accessor: 'bracket_match_id', algorithm: 'btree', columns: ['bracketMatchId'] }, // Reverse lookup from BracketMatch to Lobby (cancel_tournament cascade, D-18)
    ]
}, lobbyColumns);
