import { table, t } from 'spacetimedb/server';

export const leaderboardColumns = {
    category: t.string(),
    rank: t.u16(),
    userId: t.u32(),
    rating: t.u32(),
    matchesPlayed: t.u32(),
    wins: t.u32(),
    seasonId: t.u32(),
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

export const Leaderboard = table({
    name: 'leaderboard',
    public: true,
    primaryKey: ['category', 'rank', 'seasonId'],
    indexes: [
        { accessor: 'by_category_rank_season', algorithm: 'btree', columns: ['category', 'rank', 'seasonId'] },
        { accessor: 'by_user', algorithm: 'btree', columns: ['userId'] },
    ],
}, leaderboardColumns);
