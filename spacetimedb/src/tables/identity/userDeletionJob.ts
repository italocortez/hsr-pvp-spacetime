import { table, t } from 'spacetimedb/server';

export const userDeletionJobColumns = {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    userId: t.u32(),
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

// The scheduled reducer is defined in reducers/userDeletion.ts.
// We use a mutable binding so the reducer file can assign it after import,
// avoiding circular dependency (schema → this file, reducer file → schema).
export let _runUserDeletionReducer: any;
export function setRunUserDeletionReducer(reducer: any) {
    _runUserDeletionReducer = reducer;
}

export const UserDeletionJob = table({
    name: 'user_deletion_job',
    scheduled: () => _runUserDeletionReducer,
}, userDeletionJobColumns);
