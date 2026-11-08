import { table, t } from 'spacetimedb/server';

export const seasonColumns = {
    id: t.u32().primaryKey().autoInc(),
    name: t.string(),
    startDate: t.timestamp(),
    endDate: t.timestamp().optional(),
    isActive: t.bool(),
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

export const Season = table({
    name: 'season',
    public: true,
    indexes: [
        { accessor: 'is_active', algorithm: 'btree', columns: ['isActive'] },
    ],
}, seasonColumns);
