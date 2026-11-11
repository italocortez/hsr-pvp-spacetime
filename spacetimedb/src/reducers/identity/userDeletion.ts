import spacetimedb from '@module/schema';
import { UserDeletionJob, setRunUserDeletionReducer } from '@module/tables/identity/userDeletionJob';
import { performUserDeletion } from '@module/helpers/identity/userDeletionHelper';
import { ensureScheduler } from '@module/helpers/admin/schedulerGuard';

// Scheduled reducer: runs performUserDeletion ~5 seconds after an admin deletion or a ban set deletedAt.
// The User row is hard-deleted; every user but a guest without history references is archived to DeletedUser first,
// which history rows resolve their labels from (helpers/identity/userDeletionHelper.ts).
//
// S11a (L11): refused unless the scheduler calls it (ensureScheduler, helpers/admin/schedulerGuard.ts).
export const run_user_deletion = spacetimedb.reducer(
    { arg: UserDeletionJob.rowType },
    (ctx, { arg }) => {
        ensureScheduler(ctx, 'run_user_deletion');
        // S10s fix pass (A124): the job's creator is the requester. Only admin_ban_user and admin_delete_row('User')
        // write a job naming an actor other than the user (client_connected's reconnect ban names the banned user), and
        // they act as the SYSTEM user exactly when the caller is a server identity (Owner or Delegate map to SYSTEM). That
        // job is a server deletion: the user's unfinished tournaments are cancelled. A staff Admin's job hands them over
        // (A121). The flag is set at three sites: here, in server_delete_user, and in admin_delete_row('UserIdentity')
        // when it is sent as the SYSTEM user and removes a guest's last identity (admin.ts); identity GC and
        // server_link_provider never set it.
        const systemUserId = ctx.db.User.username.find('SYSTEM')?.id;
        const serverDeletion = systemUserId !== undefined && arg.createdById === systemUserId;
        performUserDeletion(ctx, arg.userId, arg.createdById, { serverDeletion });
    }
);

// Wire the reducer into the scheduled table's lazy reference
setRunUserDeletionReducer(run_user_deletion);
