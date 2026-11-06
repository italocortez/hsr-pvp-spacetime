import { table, t } from 'spacetimedb/server';
import { GameMode } from '../types/enums';

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
    public: true,
    primaryKey: ['userId', 'gameMode', 'seasonId'],
    indexes: [
        { accessor: 'user_id', algorithm: 'btree', columns: ['userId'] },
        { accessor: 'rating', algorithm: 'btree', columns: ['rating'] },
        { accessor: 'by_user_mode_season', algorithm: 'btree', columns: ['userId', 'gameMode', 'seasonId'] },
    ],
}, mmrRatingColumns);
