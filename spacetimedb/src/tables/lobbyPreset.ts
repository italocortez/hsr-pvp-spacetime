import { table, t } from 'spacetimedb/server';
import { DraftMode, BanMode, GameMode, DisconnectPolicy, RosterVisibility, MatchType } from '../types/enums';

export const lobbyPresetColumns = {
    id: t.u32().primaryKey().autoInc(),
    name: t.string(),
    isSystemPreset: t.bool(),
    creatorUserId: t.u32(),

    // Lobby config fields (mirror lobby.ts config columns):
    teamSize: t.u8(),
    draftMode: DraftMode,
    banMode: BanMode,
    gameMode: GameMode,
    matchType: MatchType,
    standardTurnSeconds: t.u32(),
    reserveBankSeconds: t.u32(),
    characterBudget: t.f32(),
    lightconeBudget: t.f32(),
    minimumBidRaise: t.f32(),
    rosterDiffAdvantage: t.f32(),
    rosterThreshold: t.f32(),
    underThresholdAdvantage: t.f32(),
    aboveThresholdPenalty: t.f32(),
    deathPenalty: t.f32(),
    isPublic: t.bool(),
    isAnonymousPlayers: t.bool(),
    isAnonymousSpectators: t.bool(),
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
    refereeExclusiveConcede: t.bool(),

    // Audit:
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

export const LobbyPreset = table({
    name: 'lobby_preset',
    public: true,
    indexes: [
        { accessor: 'creator_user_id', algorithm: 'btree', columns: ['creatorUserId'] },
    ],
}, lobbyPresetColumns);
