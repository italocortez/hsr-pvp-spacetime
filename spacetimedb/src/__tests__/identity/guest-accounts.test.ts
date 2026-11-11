// Identity: idle guest clean-up, the guest creation counter and switches, guest login usernames.
// Decisions: A95, A109
// Contracts: docs/auth/contract.md
// From S10h (s10h-lobby-rulings.test.ts).
import { describe, expect, it } from 'vitest';
import { ScheduleAt } from 'spacetimedb';
import { ABUSE_CONFIG_DEFAULTS } from '@module/helpers/lobby/abuseControls';
import {
    DEFAULT_LOBBY_ARGS,
    M,
    advance,
    disconnect,
    guest,
    newHarness,
    now,
    tx,
    type Actor,
    type Harness,
    AUDIT,
    rejection,
    snap,
    type Ctx,
} from '../fixtures/harness';
import { host as tournamentHost, moderator, verified, freshAuth, identitiesOf, ADMIN_ONLY } from '../fixtures/identity';
import { DAY_MS } from '../fixtures/calendar';
import { setRole } from '../fixtures/draft-and-scoring';
import { join, lobbyOfHost } from '../fixtures/lobby';
import { openTournament } from '../fixtures/tournaments';

const GUEST_CREATION_OFF = 'New guest accounts are temporarily disabled. Please try again later.'; // A95(2)

// ─── Shared helpers ──────────────────────────────────────────────────────────

const MINUTE_MS = 60_000;

/** A caller that is only a client identity (no UserIdentity mapping yet). */
const asAuth = (a: ReturnType<typeof freshAuth>): Actor => ({ sub: 'fresh', auth: a.auth, identity: a.identity, userId: 0 });

// ════════════════════════════════════════════════════════════════════════════
// 1. A95(1): guest retention in the identity clean-up
// ════════════════════════════════════════════════════════════════════════════

describe('A95(1): the identity clean-up deletes an idle guest with no match history', () => {
    const gcRows = (test: Harness) => [...test.db.GcResult.iter()].filter((r) => r.gcType === 'identity');
    const gcAs = (test: Harness, who: Actor) => tx(test, who, (ctx) => M.admin_gc_identities(ctx, {}));
    /** Fires the scheduled run by hand, as the scheduler would (any queued job is consumed first). */
    const fireScheduled = (test: Harness) => {
        const jobs = [...test.db.IdentityGcJob.iter()];
        for (const j of jobs) test.db.IdentityGcJob.scheduledId.delete(j.scheduledId);
        const arg = jobs[0] ?? { scheduledId: 1n, scheduledAt: ScheduleAt.time(now(test)) };
        tx(test, 'internal', (ctx) => M.run_identity_gc(ctx, { arg }));
    };
    /** A guest who logged in and closed the tab (presence offline). */
    const idleGuest = (test: Harness, name: string) => {
        const g = guest(test, name);
        disconnect(test, g);
        return g;
    };
    const userGone = (test: Harness, g: Actor) => {
        expect(test.db.User.id.find(g.userId), `${g.sub}: user row`).toBeFalsy();
        expect(identitiesOf(test, g.userId), `${g.sub}: identities`).toHaveLength(0);
        expect(test.db.UserPresence.identity.find(g.identity), `${g.sub}: presence`).toBeFalsy();
    };
    const userKept = (test: Harness, g: Actor) => {
        expect(test.db.User.id.find(g.userId), `${g.sub}: user row`).toBeTruthy();
        expect(identitiesOf(test, g.userId).length, `${g.sub}: identities`).toBeGreaterThan(0);
    };

    it('A95(1) the Moderator run deletes a guest idle 30 days (user, identities, presence gone) and keeps one idle 29 days; the GcResult counts it under guests with the Moderator as actor', () => {
        const test = newHarness();
        const mod = moderator(test);
        const old = idleGuest(test, 'old');
        const extra = freshAuth(test, 'old-second-device'); // a second identity of the same guest goes with it
        test.db.UserIdentity.insert({ identity: extra.identity, userId: old.userId, lastSeenAt: test.clock.now(), ...AUDIT(test) });
        advance(test, DAY_MS);
        const young = idleGuest(test, 'young');
        advance(test, 29 * DAY_MS); // old: 30 days idle; young: 29

        gcAs(test, mod);
        userGone(test, old);
        expect(test.db.UserIdentity.identity.find(extra.identity)).toBeFalsy();
        userKept(test, young);
        const [row] = gcRows(test);
        expect(row.createdById).toBe(mod.userId);
        expect(JSON.parse(row.details)).toMatchObject({ guests: 1, triggeredBy: 'admin' });
        expect(row.itemsDeleted).toBeGreaterThanOrEqual(1);

        advance(test, DAY_MS); // young reaches 30 days
        gcAs(test, mod);
        userGone(test, young);
    });

    it('A95(1) the scheduled run deletes it too, with the SYSTEM actor, and counts it under guests', () => {
        const test = newHarness();
        const g = idleGuest(test, 'sched');
        advance(test, 30 * DAY_MS);
        fireScheduled(test);
        userGone(test, g);
        const [row] = gcRows(test);
        expect(row.createdById).toBe(0);
        expect(JSON.parse(row.details)).toMatchObject({ guests: 1 });
    });

    it('A95(1) an idle guest is kept with a MatchResultParticipant row, with only a MatchParticipantHistory row, as a lobby member, or enrolled in an unfinished tournament; a verified user is never deleted by this rule', () => {
        const test = newHarness();
        const mod = moderator(test);

        const live = idleGuest(test, 'live-history');
        test.db.MatchResultParticipant.insert({
            matchResultId: 9_001, userId: live.userId, teamSide: { tag: 'Blue' } as any, isCaptain: false, accountRatingSnapshot: 0, ...AUDIT(test),
        });
        const archived = idleGuest(test, 'archived-history');
        test.db.MatchParticipantHistory.insert({
            userId: archived.userId, matchHistoryId: 9_002, teamSide: { tag: 'Red' } as any, displayName: 'archived',
            isReferee: false, isCoach: false, isCaptain: false, ...AUDIT(test),
        });
        const lobbyHost = verified(test, 'lobby-host');
        tx(test, lobbyHost, (ctx) => M.create_lobby(ctx, { ...DEFAULT_LOBBY_ARGS } as any));
        const seated = guest(test, 'seated');
        join(test, seated, lobbyOfHost(test, lobbyHost)!);
        disconnect(test, seated);
        const org = tournamentHost(test, 'org');
        const tournamentId = openTournament(test, org);
        const enrolled = idleGuest(test, 'enrolled');
        test.db.TournamentEnrolled.insert({
            tournamentId, userId: enrolled.userId, status: { tag: 'Registered' } as any, anonymousAlias: undefined,
            isWaitlisted: false, allowRandomTeamAssignment: false, approvedByToAt: undefined, ...AUDIT(test),
        });
        const plainVerified = verified(test, 'plain-verified');
        disconnect(test, plainVerified);
        const control = idleGuest(test, 'control'); // the run is not vacuous: this one goes

        advance(test, 120 * DAY_MS);
        gcAs(test, mod);

        for (const g of [live, archived, seated, enrolled, plainVerified]) userKept(test, g);
        expect([...test.db.LobbyMember.user_id.filter(seated.userId)]).toHaveLength(1);
        userGone(test, control);
        expect(JSON.parse(gcRows(test)[0].details)).toMatchObject({ guests: 1 });
    });

    // S10h review F1: a casual concede or forfeit archives no participant row but writes PlayerStat (doWinLoss), so a
    // guest whose matches all ended that way has only stat rows; A95(1) "a guest with any match history is kept".
    it('A95(1) / review F1: an idle guest whose only trace is a PlayerStat row (a casual concede or forfeit) is kept; the control guest goes', () => {
        const test = newHarness();
        const mod = moderator(test);
        const conceded = idleGuest(test, 'conceded-only');
        test.db.PlayerStat.insert({
            userId: conceded.userId, gameMode: { tag: 'MemoryOfChaos' }, draftMode: { tag: 'Classic' }, matchesPlayed: 10,
            wins: 6, losses: 4, matchesSpectated: 0, seasonId: 0, matchType: { tag: 'Casual' }, teamSize: 2, ...AUDIT(test),
        } as any);
        expect([...test.db.MatchResultParticipant.user_id.filter(conceded.userId)]).toHaveLength(0);
        expect([...test.db.MatchParticipantHistory.by_user.filter(conceded.userId)]).toHaveLength(0);
        const control = idleGuest(test, 'control');

        advance(test, 30 * DAY_MS);
        gcAs(test, mod);

        userKept(test, conceded);
        expect([...test.db.PlayerStat.by_user.filter(conceded.userId)]).toHaveLength(1);
        userGone(test, control);
        expect(JSON.parse(gcRows(test)[0].details)).toMatchObject({ guests: 1 });
    });

    // The 501 guests are inserted as rows (User + UserIdentity, no presence row = offline): faster than 501 logins
    // (before S10h login_as_guest named a guest from the first 8 hex characters, which collided; see item 7 below).
    it('A95(1) the per-run bound: of 501 idle guests one run deletes 500 and the next run the last one', () => {
        const test = newHarness();
        const mod = moderator(test);
        const ids: number[] = [];
        for (let i = 0; i < 501; i++) {
            const u = test.db.User.insert({
                id: 0, username: `bulk_${i}`, displayName: `bulk_${i}`, isGuest: true, role: { tag: 'User' } as any,
                avatarCharacterName: 'march7th', displayedAchievementId: undefined, deletedAt: undefined,
                ...AUDIT(test),
            } as any);
            test.db.UserIdentity.insert({ identity: freshAuth(test, `bulk-${i}`).identity, userId: u.id, lastSeenAt: test.clock.now(), ...AUDIT(test) });
            ids.push(u.id);
        }
        advance(test, 30 * DAY_MS);
        const left = () => ids.filter((id) => test.db.User.id.find(id));

        gcAs(test, mod);
        expect(left()).toHaveLength(1);
        expect(JSON.parse(gcRows(test)[0].details)).toMatchObject({ guests: 500 });

        gcAs(test, mod);
        expect(left()).toHaveLength(0);
        expect(JSON.parse(gcRows(test)[1].details)).toMatchObject({ guests: 1 });
    }, 120_000);
});

// ════════════════════════════════════════════════════════════════════════════
// 2. A95(2): the guest creation breaker
// ════════════════════════════════════════════════════════════════════════════

const config = (test: Harness) => test.db.AbuseConfig.id.find(1)!;

describe('A95(2): guest creation counter, threshold, switch and admin alert', () => {
    const counter = (test: Harness) => test.db.AbuseCounter.key.find('guest_create');
    const alerts = (test: Harness) => [...test.db.AdminAlert.iter()].filter((a) => a.kind === 'guest_create_burst');
    const userCount = (test: Harness) => [...test.db.User.iter()].length;
    const setThreshold = (test: Harness, n: number) =>
        tx(test, 'internal', (ctx) => M.admin_update_abuse_config(ctx, { guestCreationBurstThreshold: n }));

    it('A95(2) under the threshold passes; the creation that crosses it succeeds, turns the switch off and writes exactly one alert; the next new guest is refused; a returning guest still logs in', () => {
        const test = newHarness();
        // T-S10i fix pass (A109(2)): the default threshold is 300 (was 100 under A95(2)).
        expect(config(test)).toMatchObject({ guestCreationEnabled: true, guestCreationBurstThreshold: 300, guestCreationBurstWindowMinutes: 10 });
        setThreshold(test, 3);

        const first = [guest(test, 'g1'), guest(test, 'g2'), guest(test, 'g3')];
        expect(config(test).guestCreationEnabled).toBe(true);
        expect(alerts(test)).toHaveLength(0);
        expect(counter(test)!.count).toBe(3);

        const crossing = guest(test, 'g4'); // the 4th > 3: still created
        expect(test.db.User.id.find(crossing.userId)!.isGuest).toBe(true);
        expect(config(test).guestCreationEnabled).toBe(false);
        expect(alerts(test)).toHaveLength(1);
        expect(alerts(test)[0]).toMatchObject({ count: 4, threshold: 3, isAcknowledged: false, createdById: 0 });

        const users = userCount(test);
        const fresh = freshAuth(test, 'g5');
        const msg = rejection(test, asAuth(fresh), (ctx) => M.login_as_guest(ctx, {}));
        expect(test.db.UserIdentity.identity.find(fresh.identity)).toBeFalsy();
        expect(userCount(test)).toBe(users);
        expect(alerts(test)).toHaveLength(1);
        expect(counter(test)!.count).toBe(4);
        expect(msg).toBe(GUEST_CREATION_OFF);

        // a returning guest (identity already mapped) logs in while the switch is off, and is not counted
        advance(test, MINUTE_MS);
        tx(test, first[0], (ctx) => M.login_as_guest(ctx, {}));
        expect(test.db.UserIdentity.identity.find(first[0].identity)!.userId).toBe(first[0].userId);
        expect(test.db.UserIdentity.identity.find(first[0].identity)!.lastSeenAt).toEqual(test.clock.now());
        expect(userCount(test)).toBe(users);
        expect(counter(test)!.count).toBe(4);
    });

    it('A95(2) admin_set_guest_creation(true) re-enables and resets the counter: the next creation does not trip again', () => {
        const test = newHarness();
        setThreshold(test, 2);
        for (const n of ['a', 'b', 'c']) guest(test, n);
        expect(config(test).guestCreationEnabled).toBe(false);
        expect(alerts(test)).toHaveLength(1);

        tx(test, 'internal', (ctx) => M.admin_set_guest_creation(ctx, { enabled: true }));
        expect(config(test).guestCreationEnabled).toBe(true);
        expect(counter(test)).toBeFalsy();

        const next = guest(test, 'after'); // same clock instant as the burst: a new window opens
        expect(test.db.User.id.find(next.userId)).toBeTruthy();
        expect(counter(test)!.count).toBe(1);
        expect(config(test).guestCreationEnabled).toBe(true);
        expect(alerts(test)).toHaveLength(1);
    });

    it('A95(2) admin_update_abuse_config changes the thresholds (honoured by the next creation; a new window restarts the count) and rejects a window of 0', () => {
        const test = newHarness();
        tx(test, 'internal', (ctx) => M.admin_update_abuse_config(ctx, { guestCreationBurstThreshold: 2, guestCreationBurstWindowMinutes: 5 }));
        expect(config(test)).toMatchObject({ guestCreationBurstThreshold: 2, guestCreationBurstWindowMinutes: 5 });
        guest(test, 'w1');
        guest(test, 'w2');
        advance(test, 5 * MINUTE_MS); // the 5-minute window is over
        guest(test, 'w3');
        expect(counter(test)!.count).toBe(1);
        expect(config(test).guestCreationEnabled).toBe(true);

        const before = snap(config(test));
        const msg = rejection(test, 'internal', (ctx) => M.admin_update_abuse_config(ctx, { guestCreationBurstWindowMinutes: 0 }));
        expect(snap(config(test))).toBe(before);
        expect(msg).toBe('guestCreationBurstWindowMinutes must be greater than 0.');

        // the switch is also an admin_update_abuse_config field: off, then on (the re-enable drops the window)
        tx(test, 'internal', (ctx) => M.admin_update_abuse_config(ctx, { guestCreationEnabled: false }));
        expect(rejection(test, asAuth(freshAuth(test, 'blocked')), (ctx) => M.login_as_guest(ctx, {}))).toBe(GUEST_CREATION_OFF);
        tx(test, 'internal', (ctx) => M.admin_update_abuse_config(ctx, { guestCreationEnabled: true }));
        expect(counter(test)).toBeFalsy();
        guest(test, 'w4');
    });

    it('A95(2) a non-admin (a guest, a Moderator) cannot call admin_set_guest_creation or change the guest creation fields', () => {
        const test = newHarness();
        const g = guest(test, 'plain');
        const mod = moderator(test);
        for (const who of [g, mod]) {
            const before = snap(config(test));
            const a = rejection(test, who, (ctx) => M.admin_set_guest_creation(ctx, { enabled: false }));
            const b = rejection(test, who, (ctx) => M.admin_update_abuse_config(ctx, { guestCreationBurstThreshold: 1 }));
            expect(snap(config(test))).toBe(before);
            expect([a, b]).toEqual([ADMIN_ONLY, ADMIN_ONLY]);
        }
    });
});

// ─── T-S10i fix pass: A109(2)(3), the default threshold and the server-side switches ─────────────────────────────
// The server reducers run as 'internal' (the Owner server identity), as the other server_* tests do.

describe('A109: default threshold 300; server_set_guest_creation and server_set_guest_lobby_creation', () => {
    const counter = (test: Harness, key: string) => test.db.AbuseCounter.key.find(key);
    const NOT_SERVER = 'Forbidden: caller is not a registered server identity.';
    const GUEST_LOBBY_OFF = 'Guest lobby creation is temporarily disabled';
    const serverGuestCreation = (enabled: boolean) => (ctx: Ctx) => M.server_set_guest_creation(ctx, { enabled });
    const serverGuestLobby = (enabled: boolean) => (ctx: Ctx) => M.server_set_guest_lobby_creation(ctx, { enabled });
    const admin = (test: Harness) => {
        const a = verified(test, 'admin');
        setRole(test, a.userId, 'Admin');
        return a;
    };

    it('A109(2) the AbuseConfig row written at init and the read-path default both carry guestCreationBurstThreshold 300 with the 10-minute window', () => {
        const test = newHarness();
        expect(config(test)).toMatchObject({ guestCreationBurstThreshold: 300, guestCreationBurstWindowMinutes: 10 });
        expect(ABUSE_CONFIG_DEFAULTS).toMatchObject({ guestCreationBurstThreshold: 300, guestCreationBurstWindowMinutes: 10 });
    });

    it('A109(3) server_set_guest_creation turns the switch off and on with SYSTEM in the audit columns; the re-enable drops the counter; off keeps it', () => {
        const test = newHarness();
        const adm = admin(test);
        guest(test, 'before');
        expect(counter(test, 'guest_create')!.count).toBeGreaterThan(0);
        const countBefore = counter(test, 'guest_create')!.count;
        tx(test, adm, (ctx) => M.admin_set_guest_creation(ctx, { enabled: true })); // stamps the admin as last modifier
        expect(config(test).lastModifiedById).toBe(adm.userId);

        tx(test, 'internal', serverGuestCreation(false));
        expect(config(test)).toMatchObject({ guestCreationEnabled: false, lastModifiedById: 0 });
        expect(counter(test, 'guest_create')!.count).toBe(countBefore); // turning it off does not reset the window
        expect(rejection(test, asAuth(freshAuth(test, 'blocked')), (ctx) => M.login_as_guest(ctx, {}))).toBe(GUEST_CREATION_OFF);

        tx(test, 'internal', serverGuestCreation(true));
        expect(config(test)).toMatchObject({ guestCreationEnabled: true, lastModifiedById: 0 });
        expect(counter(test, 'guest_create')).toBeFalsy();
        guest(test, 'after');
        expect(counter(test, 'guest_create')!.count).toBe(1);
    });

    it('A109(3) server_set_guest_lobby_creation turns the switch off and on with SYSTEM in the audit columns; the re-enable drops the counter; off keeps it', () => {
        const test = newHarness();
        const adm = admin(test);
        const g1 = guest(test, 'g1');
        tx(test, g1, (ctx) => M.create_lobby(ctx, { ...DEFAULT_LOBBY_ARGS } as any));
        expect(counter(test, 'guest_lobby_create')!.count).toBe(1);
        tx(test, adm, (ctx) => M.admin_set_guest_lobby_creation(ctx, { enabled: true }));
        expect(config(test).lastModifiedById).toBe(adm.userId);

        tx(test, 'internal', serverGuestLobby(false));
        expect(config(test)).toMatchObject({ guestLobbyCreationEnabled: false, lastModifiedById: 0 });
        expect(counter(test, 'guest_lobby_create')!.count).toBe(1);
        const g2 = guest(test, 'g2');
        expect(rejection(test, g2, (ctx) => M.create_lobby(ctx, { ...DEFAULT_LOBBY_ARGS } as any))).toBe(GUEST_LOBBY_OFF);

        tx(test, 'internal', serverGuestLobby(true));
        expect(config(test)).toMatchObject({ guestLobbyCreationEnabled: true, lastModifiedById: 0 });
        expect(counter(test, 'guest_lobby_create')).toBeFalsy();
        tx(test, g2, (ctx) => M.create_lobby(ctx, { ...DEFAULT_LOBBY_ARGS } as any));
        expect(counter(test, 'guest_lobby_create')!.count).toBe(1);
    });

    it('A109(3) an Admin, a Moderator and a guest client are rejected by both server reducers with the server-identity text; nothing changes', () => {
        const test = newHarness();
        const callers = [admin(test), moderator(test), guest(test, 'plain')];
        for (const who of callers) {
            for (const body of [serverGuestCreation(false), serverGuestCreation(true), serverGuestLobby(false), serverGuestLobby(true)]) {
                const before = snap([config(test), [...test.db.AbuseCounter.iter()]]);
                expect(rejection(test, who, body)).toBe(NOT_SERVER);
                expect(snap([config(test), [...test.db.AbuseCounter.iter()]])).toBe(before);
            }
        }
    });
});

describe('S10h fix pass: a guest login never fails on the unique username', () => {
    const usernameOf = (test: Harness, a: Actor) => test.db.User.id.find(test.db.UserIdentity.identity.find(a.identity)!.userId)!.username;
    const login = (test: Harness, a: Actor) => tx(test, a, (ctx) => M.login_as_guest(ctx, {}));

    it('two guests whose identities share the first 8 hex characters both log in and get distinct usernames ("Guest_" + the last 8 hex characters)', () => {
        const test = newHarness();
        // Every identity starts with the same fixed tag, so the first 8 hex characters vary over only 4 characters:
        // a pair that shares them is found quickly.
        const seen = new Map<string, Actor>();
        let pair: [Actor, Actor] | undefined;
        const hexes: string[] = [];
        for (let i = 0; i < 20_000 && !pair; i++) {
            const a = asAuth(freshAuth(test, `prefix-probe-${i}`));
            const hex = a.identity.toHexString();
            hexes.push(hex);
            const prior = seen.get(hex.slice(0, 8));
            if (prior) pair = [prior, a];
            else seen.set(hex.slice(0, 8), a);
        }
        expect(pair, 'no two identities share their first 8 hex characters').toBeDefined();
        expect(new Set(hexes.map((h) => h.slice(0, 4))).size).toBe(1); // the fixed tag

        const [a, b] = pair!;
        login(test, a);
        login(test, b);
        const names = [usernameOf(test, a), usernameOf(test, b)];
        expect(names[0]).not.toBe(names[1]);
        expect(names).toEqual([`Guest_${a.identity.toHexString().slice(-8)}`, `Guest_${b.identity.toHexString().slice(-8)}`]);
        for (const who of [a, b]) expect(test.db.User.id.find(test.db.UserIdentity.identity.find(who.identity)!.userId)!.isGuest).toBe(true);
    });

    it('a guest whose base name is already taken logs in with the first free "_n" variant', () => {
        const test = newHarness();
        const holder = guest(test, 'holder');
        const late = asAuth(freshAuth(test, 'late-comer'));
        const base = `Guest_${late.identity.toHexString().slice(-8)}`;
        // the base name and "_2" are taken by other users (patched straight in the datastore)
        test.db.User.id.update({ ...test.db.User.id.find(holder.userId)!, username: base });
        const other = guest(test, 'other');
        test.db.User.id.update({ ...test.db.User.id.find(other.userId)!, username: `${base}_2` });

        login(test, late);
        expect(usernameOf(test, late)).toBe(`${base}_3`);
    });
});
