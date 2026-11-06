import { table, t } from 'spacetimedb/server';
import { ComparisonOperator } from '../types/enums';

export const achievementCriteriaColumns = {
    id: t.u32().primaryKey().autoInc(),
    achievementId: t.u32(),
    statTable: t.string(),
    statField: t.string(),
    operator: ComparisonOperator,
    thresholdValue: t.u32(),
    filterGameMode: t.string().optional(),
    filterCharacterName: t.string().optional(),
    filterMatchType: t.string().optional(),
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

export const AchievementCriteria = table({
    name: 'achievement_criteria',
    public: true,
    indexes: [
        { accessor: 'by_achievement', algorithm: 'btree', columns: ['achievementId'] },
        { accessor: 'by_stat_table', algorithm: 'btree', columns: ['statTable'] },
    ],
}, achievementCriteriaColumns);
