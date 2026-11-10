import spacetimedb from '@module/schema';
import { UserDeletionJob, setRunUserDeletionReducer } from '@module/tables/identity/userDeletionJob';
import { performUserDeletion } from '@module/helpers/identity/userDeletionHelper';

// Scheduled reducer: runs performUserDeletion ~5 seconds after an admin deletion or a ban set deletedAt.
// The User row is hard-deleted; every user but a guest without history references is archived to DeletedUser first,
// which history rows resolve their labels from (helpers/identity/userDeletionHelper.ts).
//
// External-invocation defense: SpacetimeDB v2.2.0 engine returns "no such reducer" for
// external WS callers attempting to invoke scheduled reducers (verified 2026-05-03 in
// 16.4-AUDIT-NOTES.md "v0.6 Update"). Application-level `ctx.senderAuth.isInternal` guards
// were removed by Plan 07 hotfix because the SDK v2.2.0 `senderAuth` factory always set
// `isInternal: false` (see 16.4-AUDIT-NOTES.md for SDK source-level proof). Since SDK 2.14
// (M1), `isInternal` is `sender === databaseIdentity`: true for scheduled reducers, false
// for `init`, and `jwt` is null when internal. The guards are not re-added yet (deferred,
// upgrade report §10 Q8).
export const run_user_deletion = spacetimedb.reducer(
    { arg: UserDeletionJob.rowType },
    (ctx, { arg }) => {
        performUserDeletion(ctx, arg.userId, arg.createdById);
    }
);

// Wire the reducer into the scheduled table's lazy reference
setRunUserDeletionReducer(run_user_deletion);
