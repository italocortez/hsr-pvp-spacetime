import { table, t } from 'spacetimedb/server';

export const userAchievementColumns = {
    id: t.u32().primaryKey().autoInc(),
    userId: t.u32(),
    achievementId: t.u32(),
    awardedById: t.u32(),
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

export const UserAchievement = table({
    name: 'user_achievement',
    public: true,
    indexes: [
        { accessor: 'by_user', algorithm: 'btree', columns: ['userId'] },
        { accessor: 'by_achievement', algorithm: 'btree', columns: ['achievementId'] },
        { accessor: 'by_user_achievement', algorithm: 'btree', columns: ['userId', 'achievementId'] },
    ],
}, userAchievementColumns);
