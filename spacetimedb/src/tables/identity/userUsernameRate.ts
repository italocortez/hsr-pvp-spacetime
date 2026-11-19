import { table, t } from 'spacetimedb/server';

// S14.5s (A226 item 2), reshaped by the fix pass (A228 item 8, before its first publish): the time of a verified user's
// last accepted username change, one row per user, created on the first accepted update_username
// (consumeUsernameChangeAllowance, helpers/identity/usernames.ts; once per hour, USERNAME_CHANGE_INTERVAL_MS in
// @shared/identity). A table of its own instead of a column on UserRateState, so the change stays additive on a live
// database (the UserLoadoutRate precedent). Private, no view reads it; deleted with the user (performUserDeletion) and
// cleared by server_nuke_test_data. Staff renames (admin_update_user) and the one-time lowercasing do not count.
export const userUsernameRateColumns = {
    userId: t.u32().primaryKey(),
    lastChangeAt: t.timestamp(),
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

export const UserUsernameRate = table({
    name: 'user_username_rate',
    public: false,
}, userUsernameRateColumns);
