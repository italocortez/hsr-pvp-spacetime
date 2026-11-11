import { table, t } from 'spacetimedb/server';
import { GameMode } from '@module/types/enums';

export const mmrRatingColumns = {
    userId: t.u32(),
    gameMode: GameMode,
    rating: t.u32(),
    matchesPlayed: t.u32(),
    globalCompositeRating: t.u32().optional(),
    seasonId: t.u32(),
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

export const MmrRating = table({
    name: 'mmr_rating',
    public: false, // S3 (A40/A45): private; MMR shown only where the UI names a player (views, S9), the top-20 Leaderboard stays public
    primaryKey: ['userId', 'gameMode', 'seasonId'],
    indexes: [
        { accessor: 'user_id', algorithm: 'btree', columns: ['userId'] },
        { accessor: 'by_user_mode_season', algorithm: 'btree', columns: ['userId', 'gameMode', 'seasonId'] },
        // S11a (S10j review F3): rebuildLeaderboard reads one season's ratings at every finalization
        { accessor: 'season_id', algorithm: 'btree', columns: ['seasonId'] },
    ],
}, mmrRatingColumns);
