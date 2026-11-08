import { table, t } from 'spacetimedb/server';
import { GameMode, DraftMode } from '@module/types/enums';

// A21 (S3): mirrors HsrSynergyCost (publish_cost_set copies draft rows into it column for column), so the
// pair columns were renamed to characterA/characterB here too, canonical order included.
export const costSetDraftSynergyColumns = {
    costSetId: t.u32(),
    characterA: t.string(),
    characterB: t.string(),
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
    primaryKey: ['costSetId', 'characterA', 'characterB', 'gameMode', 'draftMode'],
    indexes: [
        { accessor: 'cost_set_id', algorithm: 'btree', columns: ['costSetId'] },
        { accessor: 'by_tuple', algorithm: 'btree', columns: ['costSetId', 'characterA', 'characterB', 'gameMode', 'draftMode'] },
    ],
}, costSetDraftSynergyColumns);
