import { table, t } from 'spacetimedb/server';
import { DraftMode, BanMode, GameMode, DisconnectPolicy, RosterVisibility, MatchType, LineupFormat, BanRestriction } from '../types/enums';

export const lobbyPresetColumns = {
    id: t.u32().primaryKey().autoInc(),
    name: t.string(),
    isSystemPreset: t.bool(),           // A33a: the built-in default preset, owned by SYSTEM, seeded in init (helpers/systemPreset.ts), not deletable
    creatorUserId: t.u32(),

    // Lobby config fields (mirror lobby.ts config columns):
    teamSize: t.u8(),
    draftMode: DraftMode,
    banMode: BanMode,
    banRestriction: BanRestriction,     // A45(2)
    lineupFormat: LineupFormat,         // A21 (backlog #6)
    gameMode: GameMode,
    matchType: MatchType,
    standardTurnSeconds: t.u32(),
    reserveBankSeconds: t.u32(),
    characterBudget: t.f32(),
    lightconeBudget: t.f32(),
    minimumBidRaise: t.f32(),
    // A21 handicaps: fixed-point hundredths, per draft mode scale (backlog #6)
    rosterDiffAdvantage: t.i32(),
    rosterThreshold: t.u32(),
    underThresholdAdvantage: t.i32(),
    aboveThresholdPenalty: t.i32(),
    deathPenalty: t.i32(),
    isPublic: t.bool(),
    isAnonymousPlayers: t.bool(),
    isAnonymousSpectators: t.bool(),
    hideMmr: t.bool(),                  // A40 mitigation (2)
    rosterVisibility: RosterVisibility,
    requireOwnership: t.bool(),
    costSetId: t.u32(),
    disconnectPolicy: DisconnectPolicy,
    disconnectForfeitSeconds: t.u32().optional(),
    allowMirrorPicks: t.bool(),
    autoRandomPick: t.bool(),
    refereeCanUndo: t.bool(),
    refereeCanPause: t.bool(),
    refereeCanSetCaptain: t.bool(),
    refereeCanKick: t.bool(),
    allowPlayerPause: t.bool(),
    refereeExclusiveConcede: t.bool(),  // A45(5)
    // A67(2): the series fields are gone (one game per lobby).

    // Audit:
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

// S3 (Appendix A): private; view_lobby_presets returns the system preset plus the caller's own (S9).
export const LobbyPreset = table({
    name: 'lobby_preset',
    public: false,
    indexes: [
        { accessor: 'creator_user_id', algorithm: 'btree', columns: ['creatorUserId'] },
    ],
}, lobbyPresetColumns);
