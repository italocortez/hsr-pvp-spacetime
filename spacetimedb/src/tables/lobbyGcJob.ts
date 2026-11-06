import { table, t } from 'spacetimedb/server';

export const lobbyGcJobColumns = {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
};

// The scheduled reducer is defined in reducers/lobbyGc.ts.
// We use a mutable binding so the reducer file can assign it after import,
// avoiding circular dependency (schema → this file, reducer file → schema).
export let _runLobbyGcReducer: any;
export function setRunLobbyGcReducer(reducer: any) {
    _runLobbyGcReducer = reducer;
}

export const LobbyGcJob = table({
    name: 'lobby_gc_job',
    scheduled: () => _runLobbyGcReducer,
}, lobbyGcJobColumns);
