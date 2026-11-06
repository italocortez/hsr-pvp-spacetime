import { table, t } from 'spacetimedb/server';

/**
 * Runtime-tunable abuse thresholds (S3; ACCESS-SECURITY-OPS §B.5, A42). Singleton row id = 1, seeded in init
 * with the D-B5 defaults (cursor 50 ms = 20 Hz, chat 700 ms / 30 per minute, 10 lobby creates per hour,
 * 10 presets, 5 cost sets), edited by admin_update_abuse_config (S5), read through view_admin_abuse_config.
 * A42: guestLobbyCreationEnabled is the kill switch; the circuit breaker (scheduled, S5) trips it when more
 * than guestLobbyBurstThreshold guest lobbies were created in the last guestLobbyBurstWindowMinutes and writes
 * an AdminAlert row. B-8: maintenanceMode makes client_connected reject every non-server identity.
 */
export const abuseConfigColumns = {
    id: t.u32().primaryKey(),
    cursorMinIntervalMs: t.u32(),
    chatMinIntervalMs: t.u32(),
    chatPerMinute: t.u32(),
    lineupMinIntervalMs: t.u32(),         // arrange_lineup throttle (fan-out reducer, backlog #3)
    lobbyCreatesPerHour: t.u32(),
    maxPresetsPerUser: t.u32(),
    maxCostSetsPerUser: t.u32(),
    maintenanceMode: t.bool(),
    guestLobbyCreationEnabled: t.bool(),
    guestLobbyBurstThreshold: t.u32(),
    guestLobbyBurstWindowMinutes: t.u32(),
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

export const AbuseConfig = table({
    name: 'abuse_config',
    public: false,
}, abuseConfigColumns);
