import { table, t } from 'spacetimedb/server';
import { GameMode } from '@module/types/enums';

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

// S11a (triage L91): private. Owners read view_my_cost_sets; everyone reads the published sets through
// view_published_cost_sets (is_published index).
export const CostSet = table({
    name: 'cost_set',
    public: false,
    indexes: [
        { accessor: 'creator_id', algorithm: 'btree', columns: ['creatorId'] },
        { accessor: 'is_published', algorithm: 'btree', columns: ['isPublished'] },
    ],
}, costSetColumns);
