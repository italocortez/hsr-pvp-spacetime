import { table, t } from 'spacetimedb/server';

export const identityGcJobColumns = {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
};

// The scheduled reducer is defined in reducers/identityGc.ts.
// We use a mutable binding so the reducer file can assign it after import,
// avoiding circular dependency (schema → this file, reducer file → schema).
export let _runIdentityGcReducer: any;
export function setRunIdentityGcReducer(reducer: any) {
    _runIdentityGcReducer = reducer;
}

export const IdentityGcJob = table({
    name: 'identity_gc_job',
    scheduled: () => _runIdentityGcReducer,
}, identityGcJobColumns);
