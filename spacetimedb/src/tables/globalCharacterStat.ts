import { table, t } from 'spacetimedb/server';
import { GameMode, DraftMode, MatchType } from '../types/enums';

export const globalCharacterStatColumns = {
    characterName: t.string(),
    gameMode: GameMode,
    draftMode: DraftMode,
    seasonId: t.u32(),
    matchType: MatchType,
    teamSize: t.u8(),
    timesPicked: t.u32(),
    timesBanned: t.u32(),
    wins: t.u32(),
    losses: t.u32(),
    matchesPlayed: t.u32(),
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

export const GlobalCharacterStat = table({
    name: 'global_character_stat',
    public: true,
    primaryKey: ['characterName', 'gameMode', 'draftMode', 'seasonId', 'matchType', 'teamSize'],
    indexes: [
        { accessor: 'by_char_mode', algorithm: 'btree', columns: ['characterName', 'gameMode'] },
        { accessor: 'by_season', algorithm: 'btree', columns: ['seasonId'] },
    ],
}, globalCharacterStatColumns);
