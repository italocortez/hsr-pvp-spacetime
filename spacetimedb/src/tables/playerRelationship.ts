import { table, t } from 'spacetimedb/server';
import { GameMode, DraftMode, MatchType } from '../types/enums';

export const playerRelationshipColumns = {
    userId: t.u32(),
    otherUserId: t.u32(),
    gameMode: GameMode,
    draftMode: DraftMode,
    matchesAsAlly: t.u32(),
    winsAsAlly: t.u32(),
    matchesAsOpponent: t.u32(),
    winsAsOpponent: t.u32(),
    seasonId: t.u32(),
    matchType: MatchType,
    teamSize: t.u8(),
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

export const PlayerRelationship = table({
    name: 'player_relationship',
    public: false,
    primaryKey: ['userId', 'otherUserId', 'gameMode', 'draftMode', 'seasonId', 'matchType', 'teamSize'],
    indexes: [
        { accessor: 'by_user', algorithm: 'btree', columns: ['userId'] },
        { accessor: 'by_user_other_mode_draft_season_type_size', algorithm: 'btree', columns: ['userId', 'otherUserId', 'gameMode', 'draftMode', 'seasonId', 'matchType', 'teamSize'] },
    ],
}, playerRelationshipColumns);
