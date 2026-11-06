import { table, t } from 'spacetimedb/server';
import { GameMode, DraftMode } from '../types/enums';
import { SuperimpositionCost } from '../types/structs';

export const costSetDraftLightconeColumns = {
    costSetId: t.u32(),
    lightconeName: t.string(),
    gameMode: GameMode,
    draftMode: DraftMode,
    costs: SuperimpositionCost,
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

export const CostSetDraftLightcone = table({
    name: 'cost_set_draft_lightcone',
    primaryKey: ['costSetId', 'lightconeName', 'gameMode', 'draftMode'],
    indexes: [
        { accessor: 'cost_set_id', algorithm: 'btree', columns: ['costSetId'] },
        { accessor: 'by_set_lightcone_and_mode', algorithm: 'btree', columns: ['costSetId', 'lightconeName', 'gameMode', 'draftMode'] },
    ],
}, costSetDraftLightconeColumns);
