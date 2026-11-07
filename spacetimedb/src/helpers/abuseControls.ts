import { Timestamp } from 'spacetimedb';
import { SenderError } from 'spacetimedb/server';
import { SYSTEM_USER_ID } from './auditColumns';
import { insertWithAudit, updateWithAudit } from './auditHelpers';

// ─── Abuse controls (ACCESS-SECURITY-OPS §B.5, B-4, B-7; DECISIONS A42, A43) ─────────────────────────────
// AbuseConfig is a singleton (id 1) seeded by `init`; every throttle reads it at call time, so an admin edit
// (admin_update_abuse_config) takes effect on the next call without a redeploy.

export const ABUSE_CONFIG_ID = 1;

const MINUTE_MICROS = 60_000_000n;
const HOUR_MICROS = 60n * MINUTE_MICROS;

/** D-B5 defaults (A43). lineupMinIntervalMs has no decided value: 250 ms (4 Hz) for a fan-out reducer, S7 applies it. */
export const ABUSE_CONFIG_DEFAULTS = {
    cursorMinIntervalMs: 50,          // 20 Hz
    chatMinIntervalMs: 700,
    chatPerMinute: 30,
    lineupMinIntervalMs: 250,
    lobbyCreatesPerHour: 10,
    maxPresetsPerUser: 10,
    maxCostSetsPerUser: 5,
    maintenanceMode: false,
    guestLobbyCreationEnabled: true,
    guestLobbyBurstThreshold: 50,     // A58 (A42 example was 20)
    guestLobbyBurstWindowMinutes: 10,
};

export type AbuseConfigValues = typeof ABUSE_CONFIG_DEFAULTS;

/** Read path: the singleton row, or the defaults while it is absent (no write). */
export function readAbuseConfig(ctx: any): AbuseConfigValues {
    return ctx.db.AbuseConfig.id.find(ABUSE_CONFIG_ID) ?? ABUSE_CONFIG_DEFAULTS;
}

/** Idempotent seed (init, and the write paths): inserts the defaults with a SYSTEM actor when the row is absent. */
export function seedAbuseConfigDefaults(ctx: any) {
    const existing = ctx.db.AbuseConfig.id.find(ABUSE_CONFIG_ID);
    if (existing) return existing;
    return ctx.db.AbuseConfig.insert(insertWithAudit(ctx, {
        id: ABUSE_CONFIG_ID,
        ...ABUSE_CONFIG_DEFAULTS,
    }, SYSTEM_USER_ID));
}

/** A57: the AbuseCounter key of the guest-lobby circuit breaker, and the AdminAlert kind it writes. */
export const GUEST_LOBBY_COUNTER_KEY = 'guest_lobby_create';
export const GUEST_LOBBY_BURST_ALERT = 'guest_lobby_burst';

/**
 * A57 / A58 inline circuit breaker. create_lobby calls it for a **guest** caller once the kill-switch check has
 * passed. It bumps the fixed window in AbuseCounter['guest_lobby_create'] (a new window opens when the previous one
 * is guestLobbyBurstWindowMinutes old). When the new count exceeds guestLobbyBurstThreshold while the switch is on,
 * this creation still succeeds (a throw would roll the trip back), the switch goes off and one count-only AdminAlert
 * is written, all in the caller's transaction. Every later guest creation is then rejected by the kill-switch check
 * until an admin re-enables it, so the alert is written once per trip. SYSTEM audit actor throughout.
 */
export function recordGuestLobbyCreation(ctx: any): void {
    const cfg = seedAbuseConfigDefaults(ctx);
    const now: bigint = ctx.timestamp.microsSinceUnixEpoch;
    const windowMicros = BigInt(cfg.guestLobbyBurstWindowMinutes) * MINUTE_MICROS;

    const existing = ctx.db.AbuseCounter.key.find(GUEST_LOBBY_COUNTER_KEY);
    let counter: any;
    if (!existing) {
        counter = ctx.db.AbuseCounter.insert(insertWithAudit(ctx, {
            key: GUEST_LOBBY_COUNTER_KEY,
            windowStart: ctx.timestamp,
            count: 1,
        }, SYSTEM_USER_ID));
    } else if (now - existing.windowStart.microsSinceUnixEpoch >= windowMicros) {
        counter = ctx.db.AbuseCounter.key.update(updateWithAudit(ctx, existing, {
            windowStart: ctx.timestamp,
            count: 1,
        }, SYSTEM_USER_ID));
    } else {
        counter = ctx.db.AbuseCounter.key.update(updateWithAudit(ctx, existing, {
            count: existing.count + 1,
        }, SYSTEM_USER_ID));
    }

    if (counter.count <= cfg.guestLobbyBurstThreshold || !cfg.guestLobbyCreationEnabled) return;

    ctx.db.AbuseConfig.id.update(updateWithAudit(ctx, cfg, { guestLobbyCreationEnabled: false }, SYSTEM_USER_ID));
    ctx.db.AdminAlert.insert(insertWithAudit(ctx, {
        id: 0,
        kind: GUEST_LOBBY_BURST_ALERT,
        windowStartAt: counter.windowStart,
        windowEndAt: ctx.timestamp,
        count: counter.count,
        threshold: cfg.guestLobbyBurstThreshold,
        isAcknowledged: false,
        createdAt: ctx.timestamp,
        acknowledgedAt: undefined,
    }, SYSTEM_USER_ID));
    console.warn(`[ABUSE] Breaker tripped: ${counter.count} guest lobby creations in ${cfg.guestLobbyBurstWindowMinutes} min (threshold ${cfg.guestLobbyBurstThreshold}); guest lobby creation disabled`);
}

const EPOCH = new Timestamp(0n);

/** Updates the user's UserRateState row, or creates it (windows start at the epoch, so the first check opens one). */
function writeRateState(ctx: any, userId: number, existing: any, changes: Record<string, unknown>): void {
    if (existing) {
        ctx.db.UserRateState.userId.update(updateWithAudit(ctx, existing, changes, userId));
    } else {
        ctx.db.UserRateState.insert(insertWithAudit(ctx, {
            userId,
            chatWindowStart: EPOCH,
            chatCount: 0,
            lobbyWindowStart: EPOCH,
            lobbyCreates: 0,
            ...changes,
        }, userId));
    }
}

/**
 * B-4 chat cap (D-B5): rejects when the sender's previous message is younger than chatMinIntervalMs, or when
 * chatPerMinute messages already fell in the current fixed one-minute window (UserRateState.chatWindowStart /
 * chatCount). `lastMessageMicros` is the sender's newest message in the lobby (a user is in one lobby at a time).
 * Counts the accepted message on success. No role exemption (docs/chat/contract.md has none).
 */
export function consumeChatAllowance(ctx: any, userId: number, lastMessageMicros: bigint | undefined): void {
    const cfg = readAbuseConfig(ctx);
    const now: bigint = ctx.timestamp.microsSinceUnixEpoch;

    if (lastMessageMicros !== undefined && now - lastMessageMicros < BigInt(cfg.chatMinIntervalMs) * 1000n) {
        throw new SenderError('You are sending messages too quickly. Please wait a moment.');
    }

    const state = ctx.db.UserRateState.userId.find(userId);
    const windowOpen = state && now - state.chatWindowStart.microsSinceUnixEpoch < MINUTE_MICROS;
    if (windowOpen) {
        if (state.chatCount >= cfg.chatPerMinute) {
            throw new SenderError(`Chat limit reached: at most ${cfg.chatPerMinute} messages per minute.`);
        }
        writeRateState(ctx, userId, state, { chatCount: state.chatCount + 1 });
    } else {
        writeRateState(ctx, userId, state, { chatWindowStart: ctx.timestamp, chatCount: 1 });
    }
}

/** B-7 lobby-creation cap (D-B5, guests included per A43): lobbyCreatesPerHour per fixed one-hour window. */
export function consumeLobbyCreateAllowance(ctx: any, userId: number): void {
    const cfg = readAbuseConfig(ctx);
    const now: bigint = ctx.timestamp.microsSinceUnixEpoch;
    const state = ctx.db.UserRateState.userId.find(userId);
    const windowOpen = state && now - state.lobbyWindowStart.microsSinceUnixEpoch < HOUR_MICROS;
    if (windowOpen) {
        if (state.lobbyCreates >= cfg.lobbyCreatesPerHour) {
            throw new SenderError(`Lobby creation limit reached: at most ${cfg.lobbyCreatesPerHour} lobbies per hour.`);
        }
        writeRateState(ctx, userId, state, { lobbyCreates: state.lobbyCreates + 1 });
    } else {
        writeRateState(ctx, userId, state, { lobbyWindowStart: ctx.timestamp, lobbyCreates: 1 });
    }
}
