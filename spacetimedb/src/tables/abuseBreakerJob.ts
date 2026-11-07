import { table, t } from 'spacetimedb/server';

/**
 * A42 circuit breaker schedule. `init` seeds one row 5 minutes out; `run_abuse_breaker` (reducers/abuse.ts)
 * consumes it, inserts the next row before doing its work (F14) and then counts the guest-hosted lobbies created
 * inside AbuseConfig.guestLobbyBurstWindowMinutes. Scheduled table: like LobbyGcJob / RefereeTransferCheck it
 * carries no audit columns (transient module-internal rows). Bound through
 * `spacetimedb.reducer({ onSchedule: AbuseBreakerJob }, ...)`, so the table holds no reference to the reducer.
 */
export const abuseBreakerJobColumns = {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
};

export const AbuseBreakerJob = table({
    name: 'abuse_breaker_job',
}, abuseBreakerJobColumns);
