import spacetimedb from '../schema';
import { t, SenderError } from 'spacetimedb/server';
import { ScheduleAt, Timestamp } from 'spacetimedb';
import { AbuseBreakerJob } from '../tables/abuseBreakerJob';
import { SYSTEM_USER_ID } from '../helpers/auditColumns';
import { insertWithAudit, updateWithAudit } from '../helpers/auditHelpers';
import { ensureAdmin } from '../helpers/ensurePermissions';
import { ABUSE_BREAKER_INTERVAL_MICROS, seedAbuseConfigDefaults } from '../helpers/abuseControls';

// ─── Abuse controls: admin reducers + circuit breaker (DECISIONS A42; ACCESS-SECURITY-OPS §B.5) ──────────

const GUEST_LOBBY_BURST_ALERT = 'guest_lobby_burst';

// Tunables where 0 would switch a guard off (no throttle interval, an empty breaker window) must stay > 0.
const POSITIVE_FIELDS = ['cursorMinIntervalMs', 'chatMinIntervalMs', 'lineupMinIntervalMs', 'guestLobbyBurstWindowMinutes'] as const;

// ─── admin_update_abuse_config ────────────────────────────────────────────────
// Edits any AbuseConfig column; omitted fields keep their value. Admin only. Audit actor: the admin.
export const admin_update_abuse_config = spacetimedb.reducer(
    {
        cursorMinIntervalMs: t.u32().optional(),
        chatMinIntervalMs: t.u32().optional(),
        chatPerMinute: t.u32().optional(),
        lineupMinIntervalMs: t.u32().optional(),
        lobbyCreatesPerHour: t.u32().optional(),
        maxPresetsPerUser: t.u32().optional(),
        maxCostSetsPerUser: t.u32().optional(),
        maintenanceMode: t.bool().optional(),
        guestLobbyCreationEnabled: t.bool().optional(),
        guestLobbyBurstThreshold: t.u32().optional(),
        guestLobbyBurstWindowMinutes: t.u32().optional(),
    },
    (ctx, args) => {
        const admin = ensureAdmin(ctx);

        for (const field of POSITIVE_FIELDS) {
            if (args[field] === 0) throw new SenderError(`${field} must be greater than 0.`);
        }

        const changes: Record<string, number | boolean> = {};
        for (const [key, value] of Object.entries(args)) {
            if (value !== undefined) changes[key] = value as number | boolean;
        }
        if (Object.keys(changes).length === 0) throw new SenderError('No abuse config fields provided.');

        const existing = seedAbuseConfigDefaults(ctx);
        ctx.db.AbuseConfig.id.update(updateWithAudit(ctx, existing, changes, admin.id));
        console.log(`[ABUSE] AbuseConfig updated by admin #${admin.id}: ${Object.keys(changes).join(', ')}`);
    }
);

// ─── admin_set_guest_lobby_creation ───────────────────────────────────────────
// A42(1): the admin-panel kill switch. Re-enabling after a breaker trip is the same call with `true`.
export const admin_set_guest_lobby_creation = spacetimedb.reducer(
    { enabled: t.bool() },
    (ctx, { enabled }) => {
        const admin = ensureAdmin(ctx);
        const existing = seedAbuseConfigDefaults(ctx);
        ctx.db.AbuseConfig.id.update(updateWithAudit(ctx, existing, { guestLobbyCreationEnabled: enabled }, admin.id));
        console.log(`[ABUSE] Guest lobby creation ${enabled ? 'enabled' : 'disabled'} by admin #${admin.id}`);
    }
);

// ─── admin_acknowledge_alert ──────────────────────────────────────────────────
// A42(3): stops the notifier from opening further issues for this alert. AdminAlert is public and carries no
// user ids, so the audit columns stay SYSTEM (tables/adminAlert.ts); the admin's id goes to the module log only.
// Acknowledging an already acknowledged alert is a no-op.
export const admin_acknowledge_alert = spacetimedb.reducer(
    { alertId: t.u32() },
    (ctx, { alertId }) => {
        const admin = ensureAdmin(ctx);
        const alert = ctx.db.AdminAlert.id.find(alertId);
        if (!alert) throw new SenderError(`Alert ${alertId} not found.`);
        if (alert.isAcknowledged) return;
        ctx.db.AdminAlert.id.update(updateWithAudit(ctx, alert, {
            isAcknowledged: true,
            acknowledgedAt: ctx.timestamp,
        }, SYSTEM_USER_ID));
        console.log(`[ABUSE] Alert #${alertId} (${alert.kind}) acknowledged by admin #${admin.id}`);
    }
);

// ─── run_abuse_breaker ────────────────────────────────────────────────────────
// A42(2) circuit breaker, bound to AbuseBreakerJob through `onSchedule`; init seeds the first row. Every 5 minutes:
// reschedule first (F14: a throw below can never break the chain), then, while the switch is on, count the lobbies
// created inside the last guestLobbyBurstWindowMinutes whose host is a guest. Above guestLobbyBurstThreshold the
// switch goes off and one AdminAlert (counts only) is written. While the switch is off nothing is counted, so a
// tripped breaker never writes a duplicate alert. Cost per run: one Lobby scan (Lobby has no createdDate index;
// the table holds live lobbies only, GC'd after 30 min idle) plus one User.id.find per lobby inside the window.
export const run_abuse_breaker = spacetimedb.reducer(
    { onSchedule: AbuseBreakerJob },
    { arg: AbuseBreakerJob.rowType },
    (ctx, _args) => {
        const now: bigint = ctx.timestamp.microsSinceUnixEpoch;
        ctx.db.AbuseBreakerJob.insert({
            scheduledId: 0n,
            scheduledAt: ScheduleAt.time(now + ABUSE_BREAKER_INTERVAL_MICROS),
        });

        const cfg = seedAbuseConfigDefaults(ctx);
        if (!cfg.guestLobbyCreationEnabled) return;

        const windowStart = now - BigInt(cfg.guestLobbyBurstWindowMinutes) * 60_000_000n;
        let count = 0;
        // iter() required: no createdDate index on Lobby (see the cost note above).
        for (const lobby of ctx.db.Lobby.iter()) {
            if (lobby.createdDate.microsSinceUnixEpoch < windowStart) continue;
            if (ctx.db.User.id.find(lobby.hostUserId)?.isGuest) count++;
        }
        if (count <= cfg.guestLobbyBurstThreshold) return;

        ctx.db.AbuseConfig.id.update(updateWithAudit(ctx, cfg, { guestLobbyCreationEnabled: false }, SYSTEM_USER_ID));
        ctx.db.AdminAlert.insert(insertWithAudit(ctx, {
            id: 0,
            kind: GUEST_LOBBY_BURST_ALERT,
            windowStartAt: new Timestamp(windowStart),
            windowEndAt: ctx.timestamp,
            count,
            threshold: cfg.guestLobbyBurstThreshold,
            isAcknowledged: false,
            createdAt: ctx.timestamp,
            acknowledgedAt: undefined,
        }, SYSTEM_USER_ID));
        console.warn(`[ABUSE] Breaker tripped: ${count} guest lobbies in ${cfg.guestLobbyBurstWindowMinutes} min (threshold ${cfg.guestLobbyBurstThreshold}); guest lobby creation disabled`);
    }
);
