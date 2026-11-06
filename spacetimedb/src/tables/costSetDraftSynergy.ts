import { table, t } from 'spacetimedb/server';
import { GameMode, DraftMode } from '../types/enums';

export const costSetDraftSynergyColumns = {
    costSetId: t.u32(),
    sourceName: t.string(),
    targetName: t.string(),
    gameMode: GameMode,
    draftMode: DraftMode,
    costModifier: t.f32(),
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

export const CostSetDraftSynergy = table({
    name: 'cost_set_draft_synergy',
    primaryKey: ['costSetId', 'sourceName', 'targetName', 'gameMode', 'draftMode'],
    indexes: [
        { accessor: 'cost_set_id', algorithm: 'btree', columns: ['costSetId'] },
        { accessor: 'by_tuple', algorithm: 'btree', columns: ['costSetId', 'sourceName', 'targetName', 'gameMode', 'draftMode'] },
    ],
}, costSetDraftSynergyColumns);
