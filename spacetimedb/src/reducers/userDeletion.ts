import spacetimedb from '../schema';
import { UserDeletionJob, setRunUserDeletionReducer } from '../tables/userDeletionJob';
import { performUserDeletion } from '../helpers/userDeletionHelper';

// Scheduled reducer: cascades active-state data + soft-deletes (or hard-deletes guest) User.
// Fires ~5 seconds after admin initiates deletion.
// Guest users with no history references are hard-deleted; all others are soft-deleted
// with username='deleted_<id>', displayName preserved for history table FK integrity.
//
// External-invocation defense: SpacetimeDB v2.2.0 engine returns "no such reducer" for
// external WS callers attempting to invoke scheduled reducers (verified 2026-05-03 in
// 16.4-AUDIT-NOTES.md "v0.6 Update"). Application-level `ctx.senderAuth.isInternal` guards
// were removed by Plan 07 hotfix because the SDK v2.2.0 `senderAuth` factory always sets
// `isInternal: false` (see 16.4-AUDIT-NOTES.md for SDK source-level proof).
export const run_user_deletion = spacetimedb.reducer(
    { arg: UserDeletionJob.rowType },
    (ctx, { arg }) => {
        performUserDeletion(ctx, arg.userId, arg.createdById);
    }
);

// Wire the reducer into the scheduled table's lazy reference
setRunUserDeletionReducer(run_user_deletion);
