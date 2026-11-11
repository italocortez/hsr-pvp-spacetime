import { table, t } from 'spacetimedb/server';

export const leaderboardColumns = {
    category: t.string(),
    rank: t.u16(),
    userId: t.u32(),
    // A77(1) (S11a): `User` is private, so the public top 20 carries the player's card (PAGE-MAP §3 Leaderboard, D2):
    // written by rebuildLeaderboard, refreshed by syncLeaderboardCard on a display-name or avatar change.
    displayName: t.string(),
    avatarCharacterName: t.string(),
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
        { accessor: 'by_user', algorithm: 'btree', columns: ['userId'] },
        // S11a (S10j review F3): rebuildLeaderboard deletes one season's rows at every finalization
        { accessor: 'season_id', algorithm: 'btree', columns: ['seasonId'] },
    ],
}, leaderboardColumns);
