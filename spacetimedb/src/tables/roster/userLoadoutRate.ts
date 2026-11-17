import { table, t } from 'spacetimedb/server';

// S14.3s-limit (A194 item 6, closing A193 item 8; user ruling 2026-11-17): the fixed window of a verified member's loadout saves, one row per user,
// created on the first accepted save_loadout (consumeLoadoutSaveAllowance, helpers/roster/loadoutRules.ts). A table of
// its own instead of two more columns on UserRateState, so the change stays additive on a live database. Private, no
// view reads it; deleted with the user (performUserDeletion) and cleared by server_nuke_test_data.
export const userLoadoutRateColumns = {
    userId: t.u32().primaryKey(),
    windowStart: t.timestamp(),
    saveCount: t.u32(),
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

export const UserLoadoutRate = table({
    name: 'user_loadout_rate',
    public: false,
}, userLoadoutRateColumns);
