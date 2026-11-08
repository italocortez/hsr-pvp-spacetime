import { table, t } from 'spacetimedb/server';
import { DraftMode, BanMode, LobbyStage, DisconnectPolicy, GameMode, RosterVisibility, MatchType, LineupFormat, BanRestriction } from '@module/types/enums';

export const lobbyColumns = {
    id: t.u32().primaryKey().autoInc(),
    joinCode: t.string().unique(),
    name: t.string(),                   // D-A8: the lobbies mockup lists a lobby name
    hostUserId: t.u32(),
    teamBlueAlias: t.string(),
    teamRedAlias: t.string(),

    // Flattened from LobbyConfig:
    teamSize: t.u8(),
    draftMode: DraftMode,
    banMode: BanMode,
    banRestriction: BanRestriction,     // A45(2): per-team ban restriction (free set)
    lineupFormat: LineupFormat,         // A21: halves (8 characters) or thirds (12); integrity set in tournament lobbies (A33)
    standardTurnSeconds: t.u32(),
    reserveBankSeconds: t.u32(),
    // A21 handicaps: fixed-point hundredths of the game mode's unit (cycles or points), never floats.
    // rosterThreshold is a roster cost in hundredths; 0 disables the threshold pair.
    rosterDiffAdvantage: t.i32(),
    rosterThreshold: t.u32(),
    underThresholdAdvantage: t.i32(),
    aboveThresholdPenalty: t.i32(),
    deathPenalty: t.i32(),

    // Match type:
    matchType: MatchType,

    // Player count (denormalized for browser view per D-07):
    currentPlayerCount: t.u8(),
    // A68(8): the spectator count (0-12; 0 = no spectators). New joins into the Spectator slot are capped by it; a
    // free-set setting (create_lobby / update_lobby_settings / presets; tournament lobbies copy it from the preset).
    maxSpectators: t.u8(),

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

    // Referee exclusive concede per D-92 (A45(5): a create_lobby argument, preset-able):
    refereeExclusiveConcede: t.bool(),

    // Tournament linkage:
    tournamentId: t.u32().optional(),
    bracketMatchId: t.u32().optional(),
    isTournamentControlled: t.bool(),

    // Anonymous play:
    isAnonymousPlayers: t.bool(),
    isAnonymousSpectators: t.bool(),
    hideMmr: t.bool(),                  // A40 mitigation (2): seats and cards show the account rating but not MMR

    // Roster:
    rosterVisibility: RosterVisibility,
    requireOwnership: t.bool(),
    costSetId: t.u32(),

    // Visibility:
    isPublic: t.bool(),
    // passwordHash moved to LobbyPassword (private table) — never broadcast to clients

    // A67(2): the series settings are removed; a lobby hosts exactly one game.

    // Disconnect behavior:
    disconnectPolicy: DisconnectPolicy,
    disconnectForfeitSeconds: t.u32().optional(), // Grace period in seconds, default 60

    // Game mode:
    gameMode: GameMode,

    // Lifecycle:
    lastActivityAt: t.timestamp(),
    stage: LobbyStage,

    // A74(3): the last seat number handed out (the host's is 1). nextJoinSeq reads and bumps it, so a seat number
    // names one membership for the lobby's lifetime and is never reused.
    lastJoinSeq: t.u32(),

    // Audit:
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

// S3 (A37, Appendix A): private. Members read it through view_my_lobby, the browser through
// view_lobby_browser, staff through view_admin_lobbies (S9).
export const Lobby = table({
    name: 'lobby',
    public: false,
    indexes: [
        { accessor: 'host_user_id', algorithm: 'btree', columns: ['hostUserId'] },
        { accessor: 'stage', algorithm: 'btree', columns: ['stage'] },
        { accessor: 'tournament_id', algorithm: 'btree', columns: ['tournamentId'] },
        { accessor: 'bracket_match_id', algorithm: 'btree', columns: ['bracketMatchId'] }, // Reverse lookup from BracketMatch to Lobby (cancel_tournament cascade, D-18)
    ]
}, lobbyColumns);
