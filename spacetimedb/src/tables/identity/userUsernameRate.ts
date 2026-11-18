import { table, t } from 'spacetimedb/server';

// S14.5s (A226 item 2): the fixed window of a verified user's own username changes, one row per user, created on the
// first accepted update_username (consumeUsernameChangeAllowance, helpers/identity/usernames.ts; 3 per hour, constants
// in @shared/identity). A table of its own instead of two more columns on UserRateState, so the change stays additive
// on a live database (the UserLoadoutRate precedent). Private, no view reads it; deleted with the user
// (performUserDeletion) and cleared by server_nuke_test_data. Staff renames (admin_update_user) do not count.
export const userUsernameRateColumns = {
    userId: t.u32().primaryKey(),
    windowStart: t.timestamp(),
    changeCount: t.u32(),
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

export const UserUsernameRate = table({
    name: 'user_username_rate',
    public: false,
}, userUsernameRateColumns);
