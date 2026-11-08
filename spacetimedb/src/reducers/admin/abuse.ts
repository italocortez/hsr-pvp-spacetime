import spacetimedb from '@module/schema';
import { t, SenderError } from 'spacetimedb/server';
import { SYSTEM_USER_ID } from '@module/helpers/admin/auditColumns';
import { updateWithAudit } from '@module/helpers/admin/auditHelpers';
import { ensureAdmin } from '@module/helpers/identity/ensurePermissions';
import { seedAbuseConfigDefaults } from '@module/helpers/lobby/abuseControls';

// ─── Abuse controls: admin reducers (DECISIONS A42; ACCESS-SECURITY-OPS §B.5) ──────────────────────────────
// The guest-lobby circuit breaker runs inline in create_lobby (A57): helpers/abuseControls.ts
// recordGuestLobbyCreation. There is no scheduled breaker any more.

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
