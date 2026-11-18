import { table, t } from 'spacetimedb/server';

/**
 * Account suspension (A195, A213, A214; step suspension-s1). One row per suspended user; the row exists = suspended.
 * Set and lifted by hand only (no end time, no scheduled job, A214(1)): admin_suspend_user / admin_lift_suspension and
 * the server twins (scripts/stdb/manage-user.ts suspend / unsuspend). Lifting deletes the row; there is no history
 * table (the module log keeps one line per suspend and lift, as the ban does).
 * `reason` is optional (0 to 500 UTF-16 units) and for the admins' own record only: no view sends it to the suspended
 * person (A213(5), A214(5)). `suspendedById` is the Admin who set it, or the SYSTEM user's id for a server call.
 * Private: the hot-path check (getAuthenticatedUser, the view caller helper) is one primary-key read (`userId.find`).
 * The suspended person reads only view_my_suspension (no reason, no staff id). A ban or a deletion removes the row
 * (performUserDeletion).
 */
export const userSuspensionColumns = {
    userId: t.u32().primaryKey(),
    reason: t.string(),
    suspendedById: t.u32(),
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

export const UserSuspension = table({
    name: 'user_suspension',
    public: false,
}, userSuspensionColumns);
