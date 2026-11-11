import { table, t } from 'spacetimedb/server';

/**
 * Phase 15.2 D-05: Private archive for users evicted from the live User table.
 *
 * Populated by `performUserDeletion`'s non-guest-with-history branch (D-09):
 * after cascading identities/accounts/calendar, the User row is hard-deleted
 * and its displayName is archived here so `resolveUserLabel` (D-12) can still
 * render past actions.
 *
 * Write-once: no update path, no audit columns.
 * Client never subscribes — server-side helpers, the nuke flow and view_admin_deleted_users (S9b, Moderator+) read it.
 */
export const DeletedUser = table({
    name: 'deleted_user',
    public: false,      // CR-01: MUST be explicit
}, {
    id: t.u32().primaryKey(),
    displayName: t.string(),
    isGuest: t.bool(),
    deletedAt: t.timestamp(),
});
