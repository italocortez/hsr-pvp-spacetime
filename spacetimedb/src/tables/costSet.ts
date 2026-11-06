import { table, t } from 'spacetimedb/server';
import { GameMode } from '../types/enums';

export const costSetColumns = {
    id: t.u32().primaryKey().autoInc(),
    name: t.string(),
    creatorId: t.u32(),
    gameMode: GameMode,
    isPublished: t.bool(),
    isDraft: t.bool(),
    isLocked: t.bool(),
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

export const CostSet = table({
    name: 'cost_set',
    public: true,
    indexes: [
        { accessor: 'creator_id', algorithm: 'btree', columns: ['creatorId'] },
    ],
}, costSetColumns);
