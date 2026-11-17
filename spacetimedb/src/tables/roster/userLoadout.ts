import { table, t } from 'spacetimedb/server';

// S14.3s (A190 items 1, 3, 15): a verified member's saved team builder loadouts, at most 10 (slots 0 to 9). Guests and
// visitors keep theirs in browser storage; this table never holds a guest's row (save_loadout refuses guests).
// `code` is the packed team text of `shared/teambuilder` (team, game mode, draft mode, cost set, Auction budgets).
// Private: clients read only their own rows through view_my_loadouts (no id, no userId, no audit columns on the wire).
// S14.3c-rev (A198): `rev` is the loadout's version, raised by exactly 1 on every save that writes; the view sends it and
// save_loadout / delete_loadout take the version the caller's copy was based on. `firstRev` is the version the loadout
// was created with (private, not in the view): every version the account was given before it is lower, so a base below
// it belongs to a loadout that was deleted, even when the slot has since taken a new one (slot reuse). A new loadout
// starts one above UserLoadoutRate.revFloor, the highest version the account was ever given (1 for its first loadout).
// u32: at most 6 accepted saves a minute, so 2^32 - 1 is over 1,300 years away; at the top a save is refused, never wrapped.
export const userLoadoutColumns = {
    id: t.u32().primaryKey().autoInc(),
    userId: t.u32(),
    slot: t.u8(),
    rev: t.u32(),
    firstRev: t.u32(),
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
