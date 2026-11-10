import { table, t } from 'spacetimedb/server';

/**
 * A57: fixed-window abuse counters, evaluated inline by the reducers that bump them. Private. One row per key:
 * 'guest_lobby_create' (create_lobby, guest callers), which counts guest lobby **creations** inside
 * AbuseConfig.guestLobbyBurstWindowMinutes and trips the guest kill switch above guestLobbyBurstThreshold; and, since
 * A95(2) (S10h), 'guest_create' (login_as_guest, a new guest user), against the guestCreation* columns.
 * Audit columns are always SYSTEM_USER_ID (0): the row aggregates many users and names none.
 */
export const abuseCounterColumns = {
    key: t.string().primaryKey(),
    windowStart: t.timestamp(),
    count: t.u32(),
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

export const AbuseCounter = table({
    name: 'abuse_counter',
    public: false,
}, abuseCounterColumns);
