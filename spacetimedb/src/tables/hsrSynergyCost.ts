import { table, t } from 'spacetimedb/server';
import { GameMode, DraftMode } from '../types/enums';

export const hsrSynergyCostColumns = {
    id: t.u32().primaryKey().autoInc(),
    sourceName: t.string(),
    targetName: t.string(),
    gameMode: GameMode,
    draftMode: DraftMode,
    costModifier: t.f32(),
    costSetId: t.u32(),
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

// Columns expected in upsert payloads (excludes auto-inc id and audit columns)
const AUDIT_KEYS = ['createdById', 'createdDate', 'lastModifiedById', 'lastModifiedDate'];
export const hsrSynergyCostUpsertKeys = Object.keys(hsrSynergyCostColumns).filter(k => k !== 'id' && !AUDIT_KEYS.includes(k));

export const HsrSynergyCost = table({
    name: 'hsr_synergy_cost',
    public: true,
    indexes: [
        { accessor: 'source_mode', algorithm: 'btree', columns: ['sourceName', 'gameMode', 'draftMode'] },
        { accessor: 'target_name', algorithm: 'btree', columns: ['targetName'] },
        { accessor: 'cost_set_id', algorithm: 'btree', columns: ['costSetId'] },
        { accessor: 'by_tuple', algorithm: 'btree', columns: ['sourceName', 'targetName', 'gameMode', 'draftMode', 'costSetId'] },
    ]
}, hsrSynergyCostColumns);
