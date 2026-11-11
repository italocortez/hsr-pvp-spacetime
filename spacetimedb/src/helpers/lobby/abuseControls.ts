import { Timestamp } from 'spacetimedb';
import { SenderError } from 'spacetimedb/server';
import { SYSTEM_USER_ID } from '@module/helpers/admin/auditColumns';
import { insertWithAudit, updateWithAudit } from '@module/helpers/admin/auditHelpers';

// ─── Abuse controls (ACCESS-SECURITY-OPS §B.5, B-4, B-7; DECISIONS A42, A43) ─────────────────────────────
// AbuseConfig is a singleton (id 1) seeded by `init`; every throttle reads it at call time, so an admin edit
// (admin_update_abuse_config) takes effect on the next call without a redeploy.

export const ABUSE_CONFIG_ID = 1;

const MINUTE_MICROS = 60_000_000n;
const HOUR_MICROS = 60n * MINUTE_MICROS;

/** D-B5 defaults (A43). lineupMinIntervalMs has no decided value: 250 ms (4 Hz) for a fan-out reducer; arrange_lineup applies it. */
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
    guestCreationEnabled: true,       // A95(2)
    guestCreationBurstThreshold: 300, // A95(2), A109(2): new guest users per window
    guestCreationBurstWindowMinutes: 10,
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

/** A95(2): the AbuseCounter key of the guest creation breaker, and the AdminAlert kind it writes. */
export const GUEST_CREATE_COUNTER_KEY = 'guest_create';
export const GUEST_CREATE_BURST_ALERT = 'guest_create_burst';

/**
 * Bumps the fixed window of AbuseCounter[key] (a new window opens when the previous one is windowMinutes old) and
 * returns the counter row. SYSTEM audit actor: the row aggregates many users and names none.
 */
function bumpWindowCounter(ctx: any, key: string, windowMinutes: number): any {
    const now: bigint = ctx.timestamp.microsSinceUnixEpoch;
    const windowMicros = BigInt(windowMinutes) * MINUTE_MICROS;
    const existing = ctx.db.AbuseCounter.key.find(key);
    if (!existing) {
        return ctx.db.AbuseCounter.insert(insertWithAudit(ctx, { key, windowStart: ctx.timestamp, count: 1 }, SYSTEM_USER_ID));
    }
    if (now - existing.windowStart.microsSinceUnixEpoch >= windowMicros) {
        return ctx.db.AbuseCounter.key.update(updateWithAudit(ctx, existing, { windowStart: ctx.timestamp, count: 1 }, SYSTEM_USER_ID));
    }
    return ctx.db.AbuseCounter.key.update(updateWithAudit(ctx, existing, { count: existing.count + 1 }, SYSTEM_USER_ID));
}

/** Writes one count-only AdminAlert (no user ids, SYSTEM audit actor; tables/admin/adminAlert.ts). */
function writeBurstAlert(ctx: any, kind: string, counter: any, threshold: number): void {
    ctx.db.AdminAlert.insert(insertWithAudit(ctx, {
        id: 0,
        kind,
        windowStartAt: counter.windowStart,
        windowEndAt: ctx.timestamp,
        count: counter.count,
        threshold,
        isAcknowledged: false,
        createdAt: ctx.timestamp,
        acknowledgedAt: undefined,
    }, SYSTEM_USER_ID));
}

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
    const counter = bumpWindowCounter(ctx, GUEST_LOBBY_COUNTER_KEY, cfg.guestLobbyBurstWindowMinutes);
    if (counter.count <= cfg.guestLobbyBurstThreshold || !cfg.guestLobbyCreationEnabled) return;

    ctx.db.AbuseConfig.id.update(updateWithAudit(ctx, cfg, { guestLobbyCreationEnabled: false }, SYSTEM_USER_ID));
    writeBurstAlert(ctx, GUEST_LOBBY_BURST_ALERT, counter, cfg.guestLobbyBurstThreshold);
    console.warn(`[ABUSE] Breaker tripped: ${counter.count} guest lobby creations in ${cfg.guestLobbyBurstWindowMinutes} min (threshold ${cfg.guestLobbyBurstThreshold}); guest lobby creation disabled`);
}

/** A95(2): the rejection of login_as_guest for a new guest while the guest creation switch is off. */
export const GUEST_CREATION_DISABLED_TEXT = 'New guest accounts are temporarily disabled. Please try again later.';

/**
 * A95(2): the guest creation breaker, on the A57 / A58 model. login_as_guest calls it before it creates a **new** guest
 * user (an identity already mapped to a user returns earlier and is never counted or blocked, so a returning guest can
 * always log back in). While AbuseConfig.guestCreationEnabled is off the creation is rejected. Otherwise the creation
 * is counted in AbuseCounter['guest_create']; the creation that pushes the count past guestCreationBurstThreshold inside
 * guestCreationBurstWindowMinutes still succeeds (a throw would roll the trip back), turns the switch off and writes one
 * count-only AdminAlert ('guest_create_burst'), all in the caller's transaction. An admin re-enables it with
 * admin_set_guest_creation(true) or admin_update_abuse_config, a server identity with server_set_guest_creation(true)
 * (A109(3)); each also drops the window.
 */
export function recordGuestCreation(ctx: any): void {
    const cfg = seedAbuseConfigDefaults(ctx);
    if (!cfg.guestCreationEnabled) throw new SenderError(GUEST_CREATION_DISABLED_TEXT);
    const counter = bumpWindowCounter(ctx, GUEST_CREATE_COUNTER_KEY, cfg.guestCreationBurstWindowMinutes);
    if (counter.count <= cfg.guestCreationBurstThreshold) return;

    ctx.db.AbuseConfig.id.update(updateWithAudit(ctx, cfg, { guestCreationEnabled: false }, SYSTEM_USER_ID));
    writeBurstAlert(ctx, GUEST_CREATE_BURST_ALERT, counter, cfg.guestCreationBurstThreshold);
    console.warn(`[ABUSE] Breaker tripped: ${counter.count} new guest users in ${cfg.guestCreationBurstWindowMinutes} min (threshold ${cfg.guestCreationBurstThreshold}); guest creation disabled`);
}

/** A95(2): re-enabling guest creation drops its window, as resetGuestLobbyCounter does for the lobby breaker. */
export function resetGuestCreationCounter(ctx: any): void {
    if (ctx.db.AbuseCounter.key.find(GUEST_CREATE_COUNTER_KEY)) ctx.db.AbuseCounter.key.delete(GUEST_CREATE_COUNTER_KEY);
}

/**
 * A95(2) / A109(3): writes AbuseConfig.guestCreationEnabled with `actorId` in the audit columns; a false -> true change
 * drops the breaker's window (resetGuestCreationCounter). Shared by admin_set_guest_creation (the admin) and
 * server_set_guest_creation (SYSTEM).
 */
export function setGuestCreationEnabled(ctx: any, enabled: boolean, actorId: number): void {
    const existing = seedAbuseConfigDefaults(ctx);
    if (enabled && !existing.guestCreationEnabled) resetGuestCreationCounter(ctx);
    ctx.db.AbuseConfig.id.update(updateWithAudit(ctx, existing, { guestCreationEnabled: enabled }, actorId));
}

/**
 * A42(1) / A109(3): writes AbuseConfig.guestLobbyCreationEnabled with `actorId` in the audit columns; a false -> true
 * change drops the breaker's window (resetGuestLobbyCounter). Shared by admin_set_guest_lobby_creation (the admin) and
 * server_set_guest_lobby_creation (SYSTEM).
 */
export function setGuestLobbyCreationEnabled(ctx: any, enabled: boolean, actorId: number): void {
    const existing = seedAbuseConfigDefaults(ctx);
    if (enabled && !existing.guestLobbyCreationEnabled) resetGuestLobbyCounter(ctx);
    ctx.db.AbuseConfig.id.update(updateWithAudit(ctx, existing, { guestLobbyCreationEnabled: enabled }, actorId));
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
            membershipWindowStart: EPOCH,
            membershipCount: 0,
            resultEntryWindowStart: EPOCH,
            resultEntryCount: 0,
            tournamentWindowStart: EPOCH,
            tournamentCount: 0,
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

/**
 * S10e (lobby audit #6): the per-user rate of membership changes (a new join or a return through join_lobby, a
 * set_team_slot call). Each rewrites the room's member rows and, for joins, the lobby-browser row every lobbies-page
 * subscriber receives. At most MEMBERSHIP_CHANGES_PER_WINDOW changes per fixed MEMBERSHIP_WINDOW_MS window: an average
 * minimum interval of 500 ms that still lets one gesture issue several calls back to back (join then take a seat). A
 * person clicking through seats or rooms does not reach it; a script loop is held to two changes a second. Constants,
 * not AbuseConfig columns (no change to the config row); a plain reconnect (page reload) is not counted. leave_lobby is
 * never counted nor rejected (S10e review N8: a user at the cap can always leave), so a join / leave loop is held by
 * its joins.
 * S10r (A122(4), L17): confirm_ready, unconfirm_ready, shuffle_teams and transfer_host count on the same allowance
 * (each rewrites member or lobby rows every member, and for the lobby row the lobby list, receives).
 * S10s (A122(4), L93): every calendar reducer (events, invites, invite responses, availability slots, saved calendars)
 * and every roster write of reducers/roster/roster.ts count on the same allowance with MEMBERSHIP_ACTION_TEXT (an
 * update_calendar_event loop re-sends the event to every invitee; UserRateState has no other free bucket and no column
 * may be added).
 */
/** S10r review F6: the refusal text of confirm_ready, unconfirm_ready, shuffle_teams and transfer_host on the shared bucket. */
export const MEMBERSHIP_ACTION_TEXT = 'You are doing that too quickly. Please wait a moment.';

export const MEMBERSHIP_WINDOW_MS = 10_000;
export const MEMBERSHIP_CHANGES_PER_WINDOW = 20;

/**
 * Counts one membership change of the user, rejecting it once the current window is full. S10r review F6: `message`
 * overrides the refusal text for the calls that share the bucket without changing seats (MEMBERSHIP_ACTION_TEXT).
 */
export function consumeMembershipAllowance(ctx: any, userId: number, message?: string): void {
    const now: bigint = ctx.timestamp.microsSinceUnixEpoch;
    const state = ctx.db.UserRateState.userId.find(userId);
    const windowOpen = state && now - state.membershipWindowStart.microsSinceUnixEpoch < BigInt(MEMBERSHIP_WINDOW_MS) * 1000n;
    if (windowOpen) {
        if (state.membershipCount >= MEMBERSHIP_CHANGES_PER_WINDOW) {
            throw new SenderError(message ?? 'You are changing lobbies or seats too quickly. Please wait a moment.');
        }
        writeRateState(ctx, userId, state, { membershipCount: state.membershipCount + 1 });
    } else {
        writeRateState(ctx, userId, state, { membershipWindowStart: ctx.timestamp, membershipCount: 1 });
    }
}

/**
 * Results audit #7 (S10f follow-up): the per-user rate of result writes (record_group_scores, set_score_adjustment,
 * confirm_game on the open-game path, for a caller with a LobbyMember row in the lobby). Each rewrites the game rows
 * every lobby member's result view receives. A fixed window instead of a minimum interval, so a referee who saves both
 * teams' scores in one click (two calls back to back) is not rejected: at most RESULT_ENTRIES_PER_WINDOW writes per
 * fixed RESULT_ENTRY_WINDOW_MS window (an average of three a second for a script loop). Constants, not AbuseConfig
 * columns. A rejected call consumes nothing (the reducer rolls back).
 */
export const RESULT_ENTRY_WINDOW_MS = 10_000;
export const RESULT_ENTRIES_PER_WINDOW = 30;

/** Counts one result write of the user, rejecting it once the current window is full. */
export function consumeResultEntryAllowance(ctx: any, userId: number): void {
    const now: bigint = ctx.timestamp.microsSinceUnixEpoch;
    const state = ctx.db.UserRateState.userId.find(userId);
    const windowOpen = state && now - state.resultEntryWindowStart.microsSinceUnixEpoch < BigInt(RESULT_ENTRY_WINDOW_MS) * 1000n;
    if (windowOpen) {
        if (state.resultEntryCount >= RESULT_ENTRIES_PER_WINDOW) {
            throw new SenderError('You are entering results too quickly. Please wait a moment.');
        }
        writeRateState(ctx, userId, state, { resultEntryCount: state.resultEntryCount + 1 });
    } else {
        writeRateState(ctx, userId, state, { resultEntryWindowStart: ctx.timestamp, resultEntryCount: 1 });
    }
}

/**
 * Tournament audit #13 (S10g): the per-user rate of tournament entry writes (register_for_tournament,
 * set_anonymous_alias, rename_tournament_team, lock_tournament_accounts). Each rewrites rows the shared tournament arg
 * views (view_tournament_participants / _teams / _team_members) send to every viewer of the tournament page, and a
 * register / withdraw cycle inserts and deletes the enrolment, the solo team, the membership and the lock rows. At most
 * TOURNAMENT_CHANGES_PER_WINDOW writes per fixed TOURNAMENT_WINDOW_MS window (one minute): registering, setting an
 * alias, renaming the team and adding an account never come close; a script loop is held to ten writes a minute, so a
 * register / withdraw cycle runs at most ten times a minute. withdraw_from_tournament is never counted nor rejected (a
 * user at the cap can always leave, like leave_lobby). Constants, not AbuseConfig columns. A rejected call consumes
 * nothing (the reducer rolls back).
 */
export const TOURNAMENT_WINDOW_MS = 60_000;
export const TOURNAMENT_CHANGES_PER_WINDOW = 10;

/** Counts one tournament entry write of the user, rejecting it once the current window is full. */
export function consumeTournamentAllowance(ctx: any, userId: number): void {
    const now: bigint = ctx.timestamp.microsSinceUnixEpoch;
    const state = ctx.db.UserRateState.userId.find(userId);
    const windowOpen = state && now - state.tournamentWindowStart.microsSinceUnixEpoch < BigInt(TOURNAMENT_WINDOW_MS) * 1000n;
    if (windowOpen) {
        if (state.tournamentCount >= TOURNAMENT_CHANGES_PER_WINDOW) {
            throw new SenderError('You are changing your tournament entries too quickly. Please wait a minute.');
        }
        writeRateState(ctx, userId, state, { tournamentCount: state.tournamentCount + 1 });
    } else {
        writeRateState(ctx, userId, state, { tournamentWindowStart: ctx.timestamp, tournamentCount: 1 });
    }
}

/**
 * B-4 lineup throttle (fan-out): rejects a game-package call that comes faster than AbuseConfig.lineupMinIntervalMs
 * after the member's previous one (LobbyMember.lastLineupAt). Used by arrange_lineup, equip_lightcone,
 * unequip_lightcone and set_eidolon on the open-game path (the result reducers use consumeResultEntryAllowance).
 */
export function ensureLineupThrottle(ctx: any, member: any): void {
    const minIntervalMicros = BigInt(readAbuseConfig(ctx).lineupMinIntervalMs) * 1000n;
    const now = ctx.timestamp.microsSinceUnixEpoch;
    if (member.lastLineupAt && now - member.lastLineupAt.microsSinceUnixEpoch < minIntervalMicros) {
        throw new SenderError('Lineup changes are too frequent. Please wait a moment.');
    }
}

/** Throttle stamp on the private member row (re-read, so no write of the call is lost): no audit bump (§B.5). */
export function stampLineupThrottle(ctx: any, lobbyId: number, member: any): void {
    const fresh = [...ctx.db.LobbyMember.by_lobby_and_user.filter([lobbyId, member.userId])][0];
    if (!fresh) return;
    ctx.db.LobbyMember.by_lobby_and_user.delete([lobbyId, member.userId]);
    ctx.db.LobbyMember.insert({ ...fresh, lastLineupAt: ctx.timestamp });
}

/**
 * Identity / admin audit #6: re-enabling guest lobby creation drops the breaker's fixed window
 * (AbuseCounter['guest_lobby_create']), so the first guest creation after the re-enable opens a new window instead of
 * counting on top of the burst that tripped the switch (and tripping it again at once). Called on a false -> true
 * change of AbuseConfig.guestLobbyCreationEnabled (admin_set_guest_lobby_creation, admin_update_abuse_config).
 */
export function resetGuestLobbyCounter(ctx: any): void {
    if (ctx.db.AbuseCounter.key.find(GUEST_LOBBY_COUNTER_KEY)) ctx.db.AbuseCounter.key.delete(GUEST_LOBBY_COUNTER_KEY);
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
