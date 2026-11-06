import { table, t } from 'spacetimedb/server';
import { GameMode, DraftMode, MatchType } from '../types/enums';

export const playerStatColumns = {
    userId: t.u32(),
    gameMode: GameMode,
    draftMode: DraftMode,
    matchesPlayed: t.u32(),
    wins: t.u32(),
    losses: t.u32(),
    draws: t.u32(),
    matchesSpectated: t.u32(),
    seasonId: t.u32(),
    matchType: MatchType,
    teamSize: t.u8(),
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

export const PlayerStat = table({
    name: 'player_stat',
    public: false,
    primaryKey: ['userId', 'gameMode', 'draftMode', 'seasonId', 'matchType', 'teamSize'],
    indexes: [
        { accessor: 'by_user', algorithm: 'btree', columns: ['userId'] },
        { accessor: 'by_user_mode_draft_season_type_size', algorithm: 'btree', columns: ['userId', 'gameMode', 'draftMode', 'seasonId', 'matchType', 'teamSize'] },
    ],
}, playerStatColumns);
