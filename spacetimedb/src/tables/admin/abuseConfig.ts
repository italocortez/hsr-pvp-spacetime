import { table, t } from 'spacetimedb/server';

/**
 * Runtime-tunable abuse thresholds (S3; ACCESS-SECURITY-OPS §B.5, A42). Singleton row id = 1, seeded in init
 * with the D-B5 defaults (cursor 50 ms = 20 Hz, chat 700 ms / 30 per minute, 10 lobby creates per hour,
 * 10 presets, 5 cost sets), edited by admin_update_abuse_config (reducers/abuse.ts), read through view_admin_abuse_config.
 * A42: guestLobbyCreationEnabled is the kill switch; the inline circuit breaker (A57: create_lobby, AbuseCounter) trips it when more
 * than guestLobbyBurstThreshold guest lobby creations fall in one guestLobbyBurstWindowMinutes window and writes
 * an AdminAlert row. B-8: maintenanceMode makes client_connected reject every non-server identity.
 * A95(2) (S10h): the guest creation breaker, the same model for login_as_guest: guestCreationEnabled is its switch,
 * tripped when more than guestCreationBurstThreshold new guest users are created in one guestCreationBurstWindowMinutes
 * window (AbuseCounter 'guest_create'). A returning guest (an identity already mapped to a user) is never counted or
 * blocked.
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
    guestCreationEnabled: t.bool(),           // A95(2)
    guestCreationBurstThreshold: t.u32(),     // A95(2)
    guestCreationBurstWindowMinutes: t.u32(), // A95(2)
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

export const AbuseConfig = table({
    name: 'abuse_config',
    public: false,
}, abuseConfigColumns);
