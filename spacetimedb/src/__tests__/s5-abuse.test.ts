// T-S5: in-memory tests for the abuse controls (ACCESS-SECURITY-OPS §B.5 B-4 / B-7; DECISIONS A42, A43).
// Reuses the S4 builders; everything runs in the SDK's in-memory datastore on the TestClock (no real waiting).
// Admin calls run as the owner identity (TestAuth.internal()), which init links to the SYSTEM user (role Admin).
import { describe, expect, it } from 'vitest';
import {
    DEFAULT_LOBBY_ARGS,
    M,
    advance,
    expectReject,
    guest,
    linkDiscord,
    member,
    newHarness,
    setupLobby,
    tx,
    type Actor,
    type Harness,
} from './s4-fixtures';

// LobbyCursorEvent is an event table: its rows exist only inside the writing transaction, so each call counts the
// rows it inserted there and the running total stands for the events delivered to subscribers.
const emitted = new WeakMap<Harness, number>();
const cursorRows = (test: Harness) => emitted.get(test) ?? 0;
function cursor(test: Harness, who: Actor, lobbyId: number, x = 0.5, y = 0.5) {
    const n = tx(test, who, (ctx) => {
        M.broadcast_cursor(ctx, { lobbyId, x, y });
        return [...ctx.db.LobbyCursorEvent.iter()].length;
    });
    emitted.set(test, cursorRows(test) + n);
}
const chat = (test: Harness, who: Actor, lobbyId: number, content = 'hi') =>
    tx(test, who, (ctx) => M.send_chat_message(ctx, { lobbyId, content, metadata: '' }));
const createLobby = (test: Harness, who: Actor) =>
    tx(test, who, (ctx) => M.create_lobby(ctx, { ...DEFAULT_LOBBY_ARGS } as any));
const hostedLobbyId = (test: Harness, who: Actor) => [...test.db.Lobby.host_user_id.filter(who.userId)][0]?.id;
const config = (test: Harness) => test.db.AbuseConfig.id.find(1)!;
const alerts = (test: Harness) => [...test.db.AdminAlert.iter()];

/** Fires the scheduled breaker by hand, as the scheduler would (the pending row is consumed first). */
function fireBreaker(test: Harness) {
    const rows = [...test.db.AbuseBreakerJob.iter()];
    expect(rows).toHaveLength(1);
    test.db.AbuseBreakerJob.scheduledId.delete(rows[0].scheduledId);
    tx(test, 'internal', (ctx) => M.run_abuse_breaker(ctx, { arg: rows[0] }));
}

function guestLobbies(test: Harness, n: number, prefix = 'burst') {
    for (let i = 0; i < n; i++) createLobby(test, guest(test, `${prefix}${i}`));
}

const PRESET_ARGS = {
    teamSize: 2,
    draftMode: { tag: 'Classic' },
    banMode: { tag: 'None' },
    gameMode: { tag: 'MemoryOfChaos' },
    matchType: { tag: 'Casual' },
    standardTurnSeconds: 30,
    reserveBankSeconds: 60,
    characterBudget: 100,
    lightconeBudget: 50,
    minimumBidRaise: 1,
    rosterDiffAdvantage: 0,
    rosterThreshold: 0,
    underThresholdAdvantage: 0,
    aboveThresholdPenalty: 0,
    deathPenalty: 0,
    isPublic: true,
    isAnonymousPlayers: false,
    isAnonymousSpectators: false,
    rosterVisibility: { tag: 'OpenRoster' },
    requireOwnership: false,
    costSetId: 0,
    disconnectPolicy: { tag: 'Standard' },
    disconnectForfeitSeconds: 60,
    allowMirrorPicks: false,
    autoRandomPick: false,
    refereeCanUndo: true,
    refereeCanPause: true,
    refereeCanSetCaptain: true,
    refereeCanKick: true,
    allowPlayerPause: true,
    refereeExclusiveConcede: true,
};

describe('init seeds the abuse controls', () => {
    it('AbuseConfig holds the D-B5 defaults (SYSTEM actor) and one breaker job is pending', () => {
        const test = newHarness();
        expect(config(test)).toMatchObject({
            cursorMinIntervalMs: 50,
            chatMinIntervalMs: 700,
            chatPerMinute: 30,
            lineupMinIntervalMs: 250,
            lobbyCreatesPerHour: 10,
            maxPresetsPerUser: 10,
            maxCostSetsPerUser: 5,
            maintenanceMode: false,
            guestLobbyCreationEnabled: true,
            guestLobbyBurstThreshold: 20,
            guestLobbyBurstWindowMinutes: 10,
            createdById: 0,
        });
        expect([...test.db.AbuseBreakerJob.iter()]).toHaveLength(1);
    });
});

describe('B-4: broadcast_cursor bounds and throttle', () => {
    it('two calls inside 50 ms emit one event; a third after 60 ms emits the second', () => {
        const test = newHarness();
        const s = setupLobby(test);
        const b1 = s.a.b1;
        const before = member(test, s.lobbyId, b1.userId);

        cursor(test, b1, s.lobbyId);
        advance(test, 20);
        cursor(test, b1, s.lobbyId);
        expect(cursorRows(test)).toBe(1);

        advance(test, 60);
        cursor(test, b1, s.lobbyId);
        expect(cursorRows(test)).toBe(2);

        // The throttle stamp is not an audit bump (§B.5).
        const after = member(test, s.lobbyId, b1.userId);
        expect(after.lastCursorAt).toBeDefined();
        expect(after.lastModifiedDate).toEqual(before.lastModifiedDate);
        expect(after.lastModifiedById).toBe(before.lastModifiedById);
    });

    it('out-of-range coordinates emit nothing and do not stamp the throttle', () => {
        const test = newHarness();
        const s = setupLobby(test);
        const b1 = s.a.b1;
        cursor(test, b1, s.lobbyId, 1.5, 0.5);
        cursor(test, b1, s.lobbyId, 0.5, -0.1);
        cursor(test, b1, s.lobbyId, Number.NaN, 0.5);
        expect(cursorRows(test)).toBe(0);
        expect(member(test, s.lobbyId, b1.userId).lastCursorAt).toBeUndefined();

        cursor(test, b1, s.lobbyId, 0, 1);
        expect(cursorRows(test)).toBe(1);
    });
});

describe('B-4: send_chat_message rate limit', () => {
    it('rejects a message inside chatMinIntervalMs', () => {
        const test = newHarness();
        const s = setupLobby(test, { noStart: true });
        chat(test, s.a.b1, s.lobbyId);
        advance(test, 300);
        expectReject(test, s.a.b1, (ctx) => M.send_chat_message(ctx, { lobbyId: s.lobbyId, content: 'x', metadata: '' }), /too quickly/);
        advance(test, 400);
        chat(test, s.a.b1, s.lobbyId);
    });

    it('the 31st message inside a minute is rejected; allowed once the window has passed', () => {
        const test = newHarness();
        const s = setupLobby(test, { noStart: true });
        for (let i = 0; i < 30; i++) {
            chat(test, s.a.b1, s.lobbyId, `m${i}`);
            advance(test, 700);
        }
        expectReject(test, s.a.b1, (ctx) => M.send_chat_message(ctx, { lobbyId: s.lobbyId, content: 'm30', metadata: '' }), /at most 30 messages per minute/);

        advance(test, 60_000 - 30 * 700);
        chat(test, s.a.b1, s.lobbyId, 'next window');
        expect(test.db.UserRateState.userId.find(s.a.b1.userId)!.chatCount).toBe(1);
    });
});

describe('B-7: create_lobby hourly cap', () => {
    it('the 11th create inside an hour is rejected (guests included); allowed after the hour', () => {
        const test = newHarness();
        const g = guest(test, 'churner');
        for (let i = 0; i < 10; i++) {
            createLobby(test, g);
            // Read test.db outside the transaction: the harness datastore is not re-entrant.
            const lobbyId = hostedLobbyId(test, g)!;
            tx(test, g, (ctx) => M.close_lobby(ctx, { lobbyId }));
            advance(test, 1_000);
        }
        expectReject(test, g, (ctx) => M.create_lobby(ctx, { ...DEFAULT_LOBBY_ARGS } as any), /at most 10 lobbies per hour/);

        advance(test, 60 * 60 * 1_000);
        createLobby(test, g);
        expect(hostedLobbyId(test, g)).toBeDefined();
    });
});

describe('A42: guest kill switch', () => {
    it('off: a guest create is rejected; a verified user and guests already in lobbies are unaffected; on: allowed', () => {
        const test = newHarness();
        const seated = guest(test, 'seated');
        createLobby(test, seated);
        const g = guest(test, 'late');
        const verified = guest(test, 'verified');
        linkDiscord(test, verified, 'discord-1', 'Verified');

        tx(test, 'internal', (ctx) => M.admin_set_guest_lobby_creation(ctx, { enabled: false }));
        expect(config(test).guestLobbyCreationEnabled).toBe(false);
        expectReject(test, g, (ctx) => M.create_lobby(ctx, { ...DEFAULT_LOBBY_ARGS } as any), 'Guest lobby creation is temporarily disabled');
        createLobby(test, verified);
        expect(hostedLobbyId(test, verified)).toBeDefined();
        expect(hostedLobbyId(test, seated)).toBeDefined();
        const seatedLobbyId = hostedLobbyId(test, seated)!;
        tx(test, g, (ctx) => M.join_lobby(ctx, { lobbyId: seatedLobbyId, joinCode: '', password: '' }));
        tx(test, g, (ctx) => M.leave_lobby(ctx, { lobbyId: seatedLobbyId }));

        tx(test, 'internal', (ctx) => M.admin_set_guest_lobby_creation(ctx, { enabled: true }));
        createLobby(test, g);
        expect(hostedLobbyId(test, g)).toBeDefined();
    });

    it('non-admins cannot flip the switch', () => {
        const test = newHarness();
        const g = guest(test, 'g');
        expectReject(test, g, (ctx) => M.admin_set_guest_lobby_creation(ctx, { enabled: false }), /Admin/);
    });
});

describe('A42: circuit breaker', () => {
    it('trips above the threshold: switch off, one counts-only alert, no duplicate on the next run', () => {
        const test = newHarness();
        guestLobbies(test, 21);
        fireBreaker(test);

        expect(config(test).guestLobbyCreationEnabled).toBe(false);
        expect(alerts(test)).toHaveLength(1);
        const alert = alerts(test)[0];
        expect(alert).toMatchObject({
            kind: 'guest_lobby_burst',
            count: 21,
            threshold: 20,
            isAcknowledged: false,
            acknowledgedAt: undefined,
            createdById: 0,
            lastModifiedById: 0,
        });
        expect(alert.windowEndAt.microsSinceUnixEpoch - alert.windowStartAt.microsSinceUnixEpoch).toBe(10n * 60_000_000n);

        // Rescheduled (one pending row) and no second alert while the switch is off.
        advance(test, 5 * 60_000);
        fireBreaker(test);
        expect(alerts(test)).toHaveLength(1);
        expect([...test.db.AbuseBreakerJob.iter()]).toHaveLength(1);
    });

    it('does not trip at exactly the threshold, nor on lobbies older than the window', () => {
        const test = newHarness();
        guestLobbies(test, 20);
        fireBreaker(test);
        expect(config(test).guestLobbyCreationEnabled).toBe(true);
        expect(alerts(test)).toHaveLength(0);

        advance(test, 11 * 60_000);
        guestLobbies(test, 1, 'fresh');
        fireBreaker(test);
        expect(config(test).guestLobbyCreationEnabled).toBe(true);
        expect(alerts(test)).toHaveLength(0);
    });

    it('admin_acknowledge_alert marks the alert acknowledged with SYSTEM audit columns', () => {
        const test = newHarness();
        guestLobbies(test, 21);
        fireBreaker(test);
        const alertId = alerts(test)[0].id;

        const g = guest(test, 'nosy');
        expectReject(test, g, (ctx) => M.admin_acknowledge_alert(ctx, { alertId }), /Admin/);

        advance(test, 1_000);
        tx(test, 'internal', (ctx) => M.admin_acknowledge_alert(ctx, { alertId }));
        const acked = test.db.AdminAlert.id.find(alertId)!;
        expect(acked.isAcknowledged).toBe(true);
        expect(acked.acknowledgedAt).toBeDefined();
        expect(acked.lastModifiedById).toBe(0);
        expectReject(test, 'internal', (ctx) => M.admin_acknowledge_alert(ctx, { alertId: alertId + 999 }), /not found/);
    });
});

describe('B-7: per-user preset and cost-set caps', () => {
    it('the 11th preset is rejected', () => {
        const test = newHarness();
        for (let i = 0; i < 10; i++) {
            tx(test, 'internal', (ctx) => M.create_lobby_preset(ctx, { ...PRESET_ARGS, name: `p${i}` } as any));
        }
        expectReject(test, 'internal', (ctx) => M.create_lobby_preset(ctx, { ...PRESET_ARGS, name: 'p10' } as any), /Preset limit reached/);
    });

    it('the 6th cost set is rejected', () => {
        const test = newHarness();
        for (let i = 0; i < 5; i++) {
            tx(test, 'internal', (ctx) => M.create_cost_set(ctx, { name: `c${i}`, sourceSetId: 0, gameModeTag: 'MemoryOfChaos' }));
        }
        expectReject(test, 'internal', (ctx) => M.create_cost_set(ctx, { name: 'c5', sourceSetId: 0, gameModeTag: 'MemoryOfChaos' }), /Cost set limit reached/);
    });
});

describe('admin_update_abuse_config', () => {
    it('a changed value is honoured by the next throttle check; 0 is rejected where it disables a guard', () => {
        const test = newHarness();
        const s = setupLobby(test);
        const b1 = s.a.b1;

        tx(test, 'internal', (ctx) => M.admin_update_abuse_config(ctx, { cursorMinIntervalMs: 200 }));
        expect(config(test).cursorMinIntervalMs).toBe(200);
        expect(config(test).chatMinIntervalMs).toBe(700);

        cursor(test, b1, s.lobbyId);
        advance(test, 60);
        cursor(test, b1, s.lobbyId);
        expect(cursorRows(test)).toBe(1);
        advance(test, 150);
        cursor(test, b1, s.lobbyId);
        expect(cursorRows(test)).toBe(2);

        expectReject(test, 'internal', (ctx) => M.admin_update_abuse_config(ctx, { chatMinIntervalMs: 0 }), /greater than 0/);
        const g = guest(test, 'g');
        expectReject(test, g, (ctx) => M.admin_update_abuse_config(ctx, { chatPerMinute: 1 }), /Admin/);
    });
});
