import { table, t } from 'spacetimedb/server';
import { AchievementRarity } from '../types/enums';

export const achievementColumns = {
    id: t.u32().primaryKey().autoInc(),
    name: t.string().unique(),
    description: t.string(),
    rarity: AchievementRarity,
    isManualOnly: t.bool(),
    maxAwards: t.u32().optional(),
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

export const Achievement = table({
    name: 'achievement',
    public: true,
    indexes: [
        { accessor: 'by_rarity', algorithm: 'btree', columns: ['rarity'] },
    ],
}, achievementColumns);
