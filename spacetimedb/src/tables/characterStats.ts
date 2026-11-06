import { table, t } from 'spacetimedb/server';
import { GameMode, DraftMode, MatchType } from '../types/enums';

export const playerCharacterStatColumns = {
    userId: t.u32(),
    characterName: t.string(),
    gameMode: GameMode,
    draftMode: DraftMode,
    wins: t.u32(),
    losses: t.u32(),
    matchesPlayed: t.u32(),
    seasonId: t.u32(),
    matchType: MatchType,
    teamSize: t.u8(),
    timesBannedInMatch: t.u32(),
    timesFaced: t.u32(),
    winsAgainst: t.u32(),
    lossesAgainst: t.u32(),
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

export const PlayerCharacterStat = table({
    name: 'player_character_stat',
    public: false,
    primaryKey: ['userId', 'characterName', 'gameMode', 'draftMode', 'seasonId', 'matchType', 'teamSize'],
    indexes: [
        { accessor: 'by_user', algorithm: 'btree', columns: ['userId'] },
        { accessor: 'by_user_char_mode_draft_season_type_size', algorithm: 'btree', columns: ['userId', 'characterName', 'gameMode', 'draftMode', 'seasonId', 'matchType', 'teamSize'] },
    ],
}, playerCharacterStatColumns);
