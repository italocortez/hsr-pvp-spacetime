import { table, t } from 'spacetimedb/server';
import { GameMode, DraftMode } from '../types/enums';
import { EidolonCost } from '../types/structs';

export const hsrCharacterCostColumns = {
    characterName: t.string(),
    gameMode: GameMode,
    draftMode: DraftMode,
    costs: EidolonCost,
    costSetId: t.u32(),
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

export const HsrCharacterCost = table({
    name: 'hsr_character_cost',
    public: true,
    primaryKey: ['characterName', 'gameMode', 'draftMode', 'costSetId'],
    indexes: [
        { accessor: 'cost_set_id', algorithm: 'btree', columns: ['costSetId'] },
        { accessor: 'by_character_mode_and_set', algorithm: 'btree', columns: ['characterName', 'gameMode', 'draftMode', 'costSetId'] },
    ],
}, hsrCharacterCostColumns);
