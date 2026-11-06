import { table, t } from 'spacetimedb/server';
import { GameMode, DraftMode } from '../types/enums';
import { SuperimpositionCost } from '../types/structs';

export const hsrLightconeCostColumns = {
    lightconeName: t.string(),
    gameMode: GameMode,
    draftMode: DraftMode,
    costs: SuperimpositionCost,
    costSetId: t.u32(),
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

export const HsrLightconeCost = table({
    name: 'hsr_lightcone_cost',
    public: true,
    primaryKey: ['lightconeName', 'gameMode', 'draftMode', 'costSetId'],
    indexes: [
        { accessor: 'cost_set_id', algorithm: 'btree', columns: ['costSetId'] },
        { accessor: 'by_lightcone_mode_and_set', algorithm: 'btree', columns: ['lightconeName', 'gameMode', 'draftMode', 'costSetId'] },
    ],
}, hsrLightconeCostColumns);
