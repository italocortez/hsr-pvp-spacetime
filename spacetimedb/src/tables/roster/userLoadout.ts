import { table, t } from 'spacetimedb/server';

// S14.3s (A190 items 1, 3, 15): a verified member's saved team builder loadouts, at most 10 (slots 0 to 9). Guests and
// visitors keep theirs in browser storage; this table never holds a guest's row (save_loadout refuses guests).
// `code` is the packed team text of `shared/teambuilder` (team, game mode, draft mode, cost set, Auction budgets).
// Private: clients read only their own rows through view_my_loadouts (no id, no userId, no audit columns on the wire).
export const userLoadoutColumns = {
    id: t.u32().primaryKey().autoInc(),
    userId: t.u32(),
    slot: t.u8(),
    name: t.string(),
    note: t.string(),
    code: t.string(),
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

export const UserLoadout = table({
    name: 'user_loadout',
    public: false,
    indexes: [
        { accessor: 'user_id', algorithm: 'btree', columns: ['userId'] }, // the view, the deletion cascade
        // (userId, slot) is unique by the reducer's check, not the engine (a multi-column key is not enforced).
        { accessor: 'by_user_and_slot', algorithm: 'btree', columns: ['userId', 'slot'] },
    ],
}, userLoadoutColumns);
