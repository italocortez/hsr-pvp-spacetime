import { table, t } from 'spacetimedb/server';
import { GameMode, DraftMode } from '../types/enums';
import { EidolonCost } from '../types/structs';

export const costSetDraftCharacterColumns = {
    costSetId: t.u32(),
    characterName: t.string(),
    gameMode: GameMode,
    draftMode: DraftMode,
    costs: EidolonCost,
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

export const CostSetDraftCharacter = table({
    name: 'cost_set_draft_character',
    primaryKey: ['costSetId', 'characterName', 'gameMode', 'draftMode'],
    indexes: [
        { accessor: 'cost_set_id', algorithm: 'btree', columns: ['costSetId'] },
        { accessor: 'by_set_character_and_mode', algorithm: 'btree', columns: ['costSetId', 'characterName', 'gameMode', 'draftMode'] },
    ],
}, costSetDraftCharacterColumns);
