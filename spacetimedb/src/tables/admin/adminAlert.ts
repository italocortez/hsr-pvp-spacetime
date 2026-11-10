import { table, t } from 'spacetimedb/server';

/**
 * A42 (S3): alerts the module raises for the maintainers. PUBLIC on purpose: the GitHub Actions notifier reads
 * it through the HTTP SQL API with a throwaway identity and opens an issue for any unacknowledged alert, so the
 * row must be readable without server rights. It therefore carries counts only and NO user ids: no actor column,
 * and the audit columns are always written with SYSTEM_USER_ID (0) on insert and on acknowledge (S3 review M1:
 * the skill's audit policy exempts only ServerIdentity and event tables). The acknowledgement trace is the
 * timestamp; the admin reducer logs the actor to the module log.
 * `kind` is a string ('guest_lobby_burst', and 'guest_create_burst' since A95(2)) so a new alert kind is a value, not an enum change.
 */
export const adminAlertColumns = {
    id: t.u32().primaryKey().autoInc(),
    kind: t.string(),
    windowStartAt: t.timestamp(),
    windowEndAt: t.timestamp(),
    count: t.u32(),
    threshold: t.u32(),
    isAcknowledged: t.bool(),
    createdAt: t.timestamp(),
    acknowledgedAt: t.timestamp().optional(),
    createdById: t.u32(),
    createdDate: t.timestamp(),
    lastModifiedById: t.u32(),
    lastModifiedDate: t.timestamp(),
};

export const AdminAlert = table({
    name: 'admin_alert',
    public: true,
}, adminAlertColumns);
