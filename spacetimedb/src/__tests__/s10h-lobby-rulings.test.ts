// T-S10h: in-memory tests for the S10h lobby and identity rulings (DECISIONS A95, A96, A97, A98, A99; T-S10i fix pass: A109). SpacetimeDB
// test-utils only; nothing reaches maincloud. State is built through the module's reducers; where a decision names a
// state the reducers cannot reach in the needed shape, the row is patched straight in the in-memory datastore and the
// test says so (A98: a Waiting-stage Leave deletes the row, A68(5), so an away row in Waiting is patched; an away
// member keeps no flag after its Leave, A22(5), so the flags are put back on its row to prove that the A98 check, not
// the permission check, rejects the call). The decision rows are the spec: a disagreement stays a failing test.
import { describe, expect, it } from 'vitest';
import { ScheduleAt } from 'spacetimedb';
import type { AnonymousChatRow, AnonymousMatchParticipantRow, AnonymousMatchStepRow, LobbyMemberViewRow } from '@bindings/types';
import {
    DEFAULT_LOBBY_ARGS,
    M,
    advance,
    disconnect,
    fireCheck,
    guest,
    joinAsSpectator,
    lobbyRow,
    member,
    newHarness,
    now,
    pendingCheck,
    refereeIds,
    seatOf,
    setupLobby,
    tx,
    type Actor,
    type Harness,
    type Lobby,
} from './s4-fixtures';
import { AUDIT, host as tournamentHost, moderator, openTournament, verified } from './s8-fixtures';
import { H, captain, playToScoring, recordScores, setRole, side } from './s7-fixtures';
import { freshAuth, identitiesOf } from './s10-c1-fixtures';
import { rejection } from './s10-c2-fixtures';
import { parkedLobby, settingsFrom } from './s10-a2-fixtures';
import { seedElo } from './s8d-fixtures';
import { seatLabel } from './s10h-fixtures';
import { ABUSE_CONFIG_DEFAULTS } from '@module/helpers/lobby/abuseControls';

// ─── Texts ───────────────────────────────────────────────────────────────────

const AWAY = 'You are away from this lobby. Return to it before acting.'; // A98
const ABANDONED = 'You left this match for another lobby and can no longer act in it.'; // A98
const A92_AWAY = 'You are away from this match. Return to it first.'; // A92(4), kept by A98
const A92_ABANDONED = 'You left this match for another lobby and cannot act on it.'; // A92(4), kept by A98
const NO_RETURN = 'You left this match for another lobby and cannot return.'; // A68(4)
const PRIVATE_NEEDS_PASSWORD = 'A private lobby needs a password.'; // A99
const BAD_PASSWORD = 'Incorrect lobby password.';
const GUEST_CREATION_OFF = 'New guest accounts are temporarily disabled. Please try again later.'; // A95(2)
const ADMIN_ONLY = 'Forbidden: Requires Admin privileges.';

// ─── Shared helpers ──────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
type Ctx = Parameters<Parameters<Harness['withReducerTx']>[1]>[0];

/** A JSON snapshot (bigint-safe), to prove "nothing changed" across a rejected call. */
const snap = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));

/** Every table a lobby action can write, as one snapshot. */
const LOBBY_TABLES = ['Lobby', 'LobbyMember', 'LobbyBan', 'LobbyPassword', 'LobbyMemberAccount', 'ChatMessage', 'MatchSession',
    'MatchSessionStep', 'MatchLineup', 'MatchResultRecord', 'MatchResultGame', 'MatchResultGroupScore', 'MatchResultAdjustment',
    'MatchResultParticipant', 'RefereeTransferCheck', 'UserRateState'] as const;
const worldSnap = (test: Harness) => snap(LOBBY_TABLES.map((t) => [...(test.db as any)[t].iter()]));

function view<T = any>(test: Harness, name: string, who: Actor): T[] {
    return (M as any)[name](test.viewContext(who.auth), {}) as T[];
}
const displayName = (test: Harness, who: Actor) => test.db.User.id.find(who.userId)!.displayName;
const lobbyOfHost = (test: Harness, who: Actor) => [...test.db.Lobby.iter()].find((l) => l.hostUserId === who.userId)?.id;
const join = (test: Harness, who: Actor, lobbyId: number, password = '') =>
    tx(test, who, (ctx) => M.join_lobby(ctx, { lobbyId, joinCode: '', password }));
const leave = (test: Harness, who: Actor, lobbyId: number) => tx(test, who, (ctx) => M.leave_lobby(ctx, { lobbyId }));
const chat = (test: Harness, who: Actor, lobbyId: number, content: string) =>
    tx(test, who, (ctx) => M.send_chat_message(ctx, { lobbyId, content, metadata: '' }));
const abandon = (test: Harness, who: Actor) =>
    tx(test, who, (ctx) => M.create_lobby(ctx, { ...DEFAULT_LOBBY_ARGS, abandonCurrentMatch: true } as any));

/** Sets LobbyMember fields directly (the table has no primary key: delete + insert the same row). */
function patchMember(test: Harness, lobbyId: number, userId: number, patch: Record<string, unknown>) {
    const row = member(test, lobbyId, userId);
    test.db.LobbyMember.delete(row);
    test.db.LobbyMember.insert({ ...row, ...patch } as any);
}

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
                hasDiscordLinked: false, avatarCharacterName: 'march7th', displayedAchievementId: undefined, deletedAt: undefined,
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

describe('A95(2): guest creation counter, threshold, switch and admin alert', () => {
    const config = (test: Harness) => test.db.AbuseConfig.id.find(1)!;
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
    const config = (test: Harness) => test.db.AbuseConfig.id.find(1)!;
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

// ════════════════════════════════════════════════════════════════════════════
// 3. A96: cursor events carry the seat
// ════════════════════════════════════════════════════════════════════════════

/** broadcast_cursor as `who`; returns the LobbyCursorEvent rows the call inserted (event rows live only in the transaction). */
function cursorEvents(test: Harness, who: Actor, lobbyId: number): any[] {
    return tx(test, who, (ctx) => {
        M.broadcast_cursor(ctx, { lobbyId, x: 0.5, y: 0.5 });
        return [...ctx.db.LobbyCursorEvent.iter()].map((r: any) => ({ ...r }));
    });
}

describe('A96: a cursor event names the sender by seat, never by user id', () => {
    for (const [kind, lobby] of [['identified', {}], ['anonymous', { isAnonymousPlayers: true, isAnonymousSpectators: true }]] as const) {
        it(`A96 ${kind} lobby: the event carries senderJoinSeq = the sender's seat and no user id field; spectators and non-members produce no event`, () => {
            const test = newHarness();
            const s = setupLobby(test, { lobby });
            const spec = joinAsSpectator(s, 'spec');
            for (const who of [s.a.b1, s.a.r2]) {
                const events = cursorEvents(test, who, s.lobbyId);
                expect(events, who.sub).toHaveLength(1);
                expect(Object.keys(events[0]).sort()).toEqual(['lobbyId', 'senderJoinSeq', 'timestamp', 'x', 'y']);
                expect(events[0].senderJoinSeq).toBe(seatOf(test, s.lobbyId, who.userId));
                expect(events[0].lobbyId).toBe(s.lobbyId);
                expect(Object.keys(events[0]).filter((k) => /user|label/i.test(k))).toEqual([]);
            }
            const outsider = guest(test, 'outsider');
            for (const who of [spec, s.host, outsider]) {
                expect(cursorEvents(test, who, s.lobbyId), who.sub).toEqual([]);
            }
        });
    }

    it('A96 / A98: an away member\'s cursor call produces no event and no error; back through join_lobby it emits again with the same seat; an abandoned member\'s produces none', () => {
        const test = newHarness();
        const s = setupLobby(test);
        const seat = seatOf(test, s.lobbyId, s.a.b1.userId);
        leave(test, s.a.b1, s.lobbyId);
        expect(cursorEvents(test, s.a.b1, s.lobbyId)).toEqual([]);
        join(test, s.a.b1, s.lobbyId);
        expect(cursorEvents(test, s.a.b1, s.lobbyId).map((e) => e.senderJoinSeq)).toEqual([seat]);

        leave(test, s.a.b2, s.lobbyId);
        abandon(test, s.a.b2);
        expect(member(test, s.lobbyId, s.a.b2.userId).abandonedAt).toBeDefined();
        expect(cursorEvents(test, s.a.b2, s.lobbyId)).toEqual([]);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. A97: anonymous labels from the seat number
// ════════════════════════════════════════════════════════════════════════════

const FULL_ANON = { isAnonymousPlayers: true, isAnonymousSpectators: true };
const SEAT_LABEL = /^(?:(?:Blue|Red) (?:Player|Coach)|Spectator) #(\d+)$/;
const labelsBySeat = (test: Harness, reader: Actor) =>
    new Map(view<LobbyMemberViewRow>(test, 'view_my_lobby_members', reader).map((r) => [r.joinSeq, r.label]));

describe('A97: an anonymized member\'s label is "<seat kind> #<joinSeq>"', () => {
    it('A97 every seat kind: "Blue Player #n", "Red Player #n", "Blue Coach #n", "Red Coach #n", "Spectator #n"', () => {
        const test = newHarness();
        const s = setupLobby(test, {
            lobby: FULL_ANON,
            noStart: true,
            seats: [['b1', 'BluePlayer'], ['r1', 'RedPlayer'], ['bc', 'BlueCoach'], ['rc', 'RedCoach'], ['s1', 'Spectator']],
        });
        const seat = (who: Actor) => seatOf(test, s.lobbyId, who.userId);
        expect([s.host, s.a.b1, s.a.r1, s.a.bc, s.a.rc, s.a.s1].map(seat)).toEqual([1, 2, 3, 4, 5, 6]);

        const fromRed = view<LobbyMemberViewRow>(test, 'view_my_lobby_members', s.a.r1);
        const fromBlue = view<LobbyMemberViewRow>(test, 'view_my_lobby_members', s.a.b1);
        const at = (rows: LobbyMemberViewRow[], n: number) => rows.find((r) => r.joinSeq === n)!;
        expect(at(fromRed, 2)).toMatchObject({ userId: 0, label: 'Blue Player #2' });
        expect(at(fromRed, 4)).toMatchObject({ userId: 0, label: 'Blue Coach #4' });
        expect(at(fromRed, 6)).toMatchObject({ userId: 0, label: 'Spectator #6' });
        expect(at(fromRed, 1)).toMatchObject({ userId: 0, label: 'Spectator #1' }); // the spectator host
        expect(at(fromBlue, 3)).toMatchObject({ userId: 0, label: 'Red Player #3' });
        expect(at(fromBlue, 5)).toMatchObject({ userId: 0, label: 'Red Coach #5' });
    });

    it('A97 a member\'s label does not change when an earlier peer changes seat or leaves', () => {
        const test = newHarness();
        const s = setupLobby(test, { lobby: FULL_ANON, noStart: true, seats: [['b1', 'BluePlayer'], ['b2', 'BluePlayer'], ['r1', 'RedPlayer'], ['r2', 'RedPlayer'], ['s1', 'Spectator'], ['s2', 'Spectator']] });
        const b1Seat = seatOf(test, s.lobbyId, s.a.b1.userId);
        const before = labelsBySeat(test, s.a.r1);
        expect(before.get(seatOf(test, s.lobbyId, s.a.b2.userId))).toBe(`Blue Player #${seatOf(test, s.lobbyId, s.a.b2.userId)}`);

        // the earlier Blue player and the earlier spectator change seat kind
        tx(test, s.a.b1, (ctx) => M.unconfirm_ready(ctx, { lobbyId: s.lobbyId }));
        tx(test, s.a.b1, (ctx) => M.set_team_slot(ctx, { lobbyId: s.lobbyId, lobbySlot: { tag: 'Spectator' } as any }));
        tx(test, s.host, (ctx) => M.set_team_slot(ctx, { lobbyId: s.lobbyId, targetJoinSeq: seatOf(ctx, s.lobbyId, s.a.s1.userId), lobbySlot: { tag: 'BlueCoach' } as any }));
        const moved = labelsBySeat(test, s.a.r1);
        const s1Seat = seatOf(test, s.lobbyId, s.a.s1.userId);
        expect(moved.get(b1Seat)).toBe(`Spectator #${b1Seat}`); // its own label follows its own seat kind
        expect(moved.get(s1Seat)).toBe(`Blue Coach #${s1Seat}`);
        for (const [joinSeq, label] of before) {
            if (joinSeq === b1Seat || joinSeq === s1Seat) continue;
            expect(moved.get(joinSeq), `seat ${joinSeq} after the moves`).toBe(label);
        }

        // the earlier peers leave (Waiting: the rows are deleted, A68(5))
        leave(test, s.a.b1, s.lobbyId);
        leave(test, s.a.s1, s.lobbyId);
        const after = labelsBySeat(test, s.a.r1);
        expect(after.has(b1Seat)).toBe(false);
        for (const [joinSeq, label] of before) {
            if (joinSeq === b1Seat || joinSeq === s1Seat) continue;
            expect(after.get(joinSeq), `seat ${joinSeq} after the departures`).toBe(label);
        }
    });

    it('A97 a chat line stored before its sender left keeps that sender\'s label after they are gone; no remaining member inherits it', () => {
        const test = newHarness();
        const s = setupLobby(test, { lobby: FULL_ANON, noStart: true });
        const b1Label = seatLabel(test, s.lobbyId, s.a.b1.userId);
        chat(test, s.a.b1, s.lobbyId, 'from b1');
        const stored = [...test.db.ChatMessage.lobby_id.filter(s.lobbyId)].find((m) => m.content === 'from b1')!;
        expect(stored.anonymousLabel).toBe(b1Label);

        leave(test, s.a.b1, s.lobbyId); // Waiting: the row is deleted
        expect(member(test, s.lobbyId, s.a.b1.userId)).toBeUndefined();
        const late = guest(test, 'late');
        join(test, late, s.lobbyId);
        tx(test, late, (ctx) => M.set_team_slot(ctx, { lobbyId: s.lobbyId, lobbySlot: { tag: 'BluePlayer' } as any }));
        const lateLabel = seatLabel(test, s.lobbyId, late.userId);
        expect(lateLabel).not.toBe(b1Label);

        for (const reader of [s.a.r1, late]) {
            const row = view<AnonymousChatRow>(test, 'view_my_lobby_chat', reader).find((c) => c.content === 'from b1')!;
            expect(row.senderUserId, reader.sub).toBe(0);
            expect(row.anonymousLabel, reader.sub).toBe(b1Label);
        }
        const labels = [...labelsBySeat(test, s.a.r1).values()];
        expect(labels).not.toContain(b1Label);
    });

    /** A fully anonymous Classic lobby played to Scoring, a chat line from each Blue player and a spectator who joined late. */
    function anonScoring() {
        const test = newHarness();
        const s = playToScoring(test, { lobby: FULL_ANON });
        chat(test, s.a.b1, s.lobbyId, 'b1 here');
        chat(test, s.a.b2, s.lobbyId, 'b2 here');
        const spec = joinAsSpectator(s, 'spec');
        chat(test, spec, s.lobbyId, 'spec here');
        return { test, s, spec };
    }

    it('A97 / A37: in an anonymous lobby no view row of an opponent carries a user id or display name of an anonymized member (members, chat, steps, participants, member-event lines); every label is a seat label', () => {
        const { test, s, spec } = anonScoring();
        const hidden = [s.a.b1, s.a.b2, s.host, spec];
        const hiddenIds = new Set(hidden.map((h) => h.userId));
        const hiddenNames = hidden.map((h) => displayName(test, h));
        const seats = new Set([...test.db.LobbyMember.lobby_id.filter(s.lobbyId)].map((m) => m.joinSeq));
        const reader = s.a.r1;

        const problems: string[] = [];
        const walk = (where: string, v: unknown, key = '') => {
            if (typeof v === 'number' && /userid$|byid$/i.test(key) && hiddenIds.has(v)) problems.push(`${where}.${key} = hidden id ${v}`);
            if (typeof v === 'string') {
                for (const n of hiddenNames) if (v.includes(n)) problems.push(`${where}.${key} names ${n}`);
                if (/label$/i.test(key) && v !== '' && !SEAT_LABEL.test(v) && !v.includes(displayName(test, s.a.r2)) && !v.includes(displayName(test, reader))) {
                    problems.push(`${where}.${key} = "${v}" is not a seat label`);
                }
                // a seat label's number is a seat of this lobby (labels come from joinSeq, never from an id; nobody left)
                const m = /label$/i.test(key) ? SEAT_LABEL.exec(v) : null;
                if (m && !seats.has(Number(m[1]))) problems.push(`${where}.${key} = "${v}" names no seat`);
                if (key === 'metadata' && v.startsWith('{')) {
                    try { walk(`${where}.metadata`, JSON.parse(v)); } catch { /* not JSON */ }
                }
            }
            if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(where, x, k);
        };
        for (const name of ['view_my_lobby_members', 'view_my_lobby_chat', 'view_my_match_steps', 'view_my_match_participants', 'view_my_lobby']) {
            const rows = view(test, name, reader);
            expect(rows.length, name).toBeGreaterThan(0);
            rows.forEach((r, i) => walk(`${name}[${i}]`, r));
        }
        expect(problems).toEqual([]);
    });

    it('A97 the same member carries the same label in every view: members, chat, steps, participants; the member-event line carries the same seat number with the seat kind it was written under (review F6)', () => {
        const { test, s } = anonScoring();
        const reader = s.a.r1;
        const subject = captain(s, 'Blue'); // the Blue captain picked, so it has step rows
        const label = seatLabel(test, s.lobbyId, subject.userId);
        expect(label).toMatch(SEAT_LABEL);

        const memberRow = view<LobbyMemberViewRow>(test, 'view_my_lobby_members', reader).find((r) => r.joinSeq === seatOf(test, s.lobbyId, subject.userId))!;
        expect(memberRow.label).toBe(label);

        const chatRows = view<AnonymousChatRow>(test, 'view_my_lobby_chat', reader);
        const own = subject === s.a.b1 ? 'b1 here' : 'b2 here';
        expect(chatRows.find((c) => c.content === own)!.anonymousLabel).toBe(label);
        // S10h review F6: the joined line keeps the label stored when it was written (the member joined as a spectator
        // and then took a player seat): the same seat number, the seat kind of that moment
        const joinedAs = `Spectator #${seatOf(test, s.lobbyId, subject.userId)}`;
        expect(chatRows.find((c) => c.content === `${joinedAs} joined the lobby.`), 'joined line').toBeDefined();

        const stepIds = new Set([...test.db.MatchSessionStep.lobby_id.filter(s.lobbyId)].filter((st) => st.actorUserId === subject.userId).map((st) => st.id));
        expect(stepIds.size).toBeGreaterThan(0);
        const stepRows = view<AnonymousMatchStepRow>(test, 'view_my_match_steps', reader).filter((r) => stepIds.has(r.id));
        expect(stepRows).toHaveLength(stepIds.size);
        for (const r of stepRows) expect(r.anonymousLabel).toBe(label);

        const blueParticipants = view<AnonymousMatchParticipantRow>(test, 'view_my_match_participants', reader).filter((r) => r.teamSide.tag === 'Blue');
        expect(blueParticipants.map((r) => r.anonymousLabel).sort())
            .toEqual([s.a.b1, s.a.b2].map((w) => seatLabel(test, s.lobbyId, w.userId)).sort());
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 5. A98: away and abandoned members cannot act
// ════════════════════════════════════════════════════════════════════════════

type Call = [name: string, body: (ctx: Ctx) => unknown];

/**
 * A Classic 2v2 draft (host = spectator referee): a spectator `spec`, a banned spectator, a chat line from r1. b1 leaves
 * (away, A68(2)); the 15 s check fires and auto-pauses the draft; for 'abandoned' b1 then takes another lobby
 * (A68(4)). The Leave moved b1's flags (A22(5)), so the referee and captain flags and the host role are put back on b1
 * directly: every power-gated reducer then reaches its A98 check instead of its permission check.
 */
function a98World(state: 'away' | 'abandoned') {
    const test = newHarness();
    const s = setupLobby(test);
    const L = s.lobbyId;
    const spec = joinAsSpectator(s, 'spec');
    const banned = joinAsSpectator(s, 'banned');
    const bannedSeat = seatOf(test, L, banned.userId);
    tx(test, s.host, (ctx) => M.ban_member(ctx, { lobbyId: L, targetJoinSeq: bannedSeat }));
    chat(test, s.a.r1, L, 'from r1');
    const messageId = [...test.db.ChatMessage.lobby_id.filter(L)].find((m) => m.content === 'from r1')!.id;

    const x = s.a.b1;
    leave(test, x, L);
    const check = pendingCheck(test, L, x.userId);
    advance(test, 15_000);
    fireCheck(test, check);
    expect(test.db.MatchSession.lobbyId.find(L)!.timerState.isPaused).toBe(true);
    if (state === 'abandoned') abandon(test, x);
    const row = member(test, L, x.userId);
    expect(row.leftAt).toBeDefined();
    expect(row.abandonedAt === undefined).toBe(state === 'away');

    patchMember(test, L, x.userId, { isReferee: true, isCaptain: true });
    test.db.Lobby.id.update({ ...lobbyRow(test, L), hostUserId: x.userId });
    advance(test, 3_000); // past the chat / lineup throttles
    return { test, s, L, x, spec, bannedSeat, messageId };
}

/** Every guarded reducer family (docs/lobby/architecture.md "Phase S10h execution"), called by the away / abandoned member. */
function guardedCalls(w: ReturnType<typeof a98World>): Call[] {
    const { test, s, L, spec, bannedSeat, messageId } = w;
    const specSeat = seatOf(test, L, spec.userId);
    const r1Seat = seatOf(test, L, s.a.r1.userId);
    const b2Seat = seatOf(test, L, s.a.b2.userId);
    const settings = settingsFrom(test, L, { standardTurnSeconds: 90 });
    const blue = side('Blue');
    return [
        ['select_match_account', (ctx) => M.select_match_account(ctx, { lobbyId: L, hsrAccountId: 1 })],
        ['deselect_match_account', (ctx) => M.deselect_match_account(ctx, { lobbyId: L, hsrAccountId: 1 })],
        ['send_chat_message', (ctx) => M.send_chat_message(ctx, { lobbyId: L, content: 'still here?', metadata: '' })],
        ['delete_chat_message', (ctx) => M.delete_chat_message(ctx, { messageId })],
        ['set_team_slot (a seat)', (ctx) => M.set_team_slot(ctx, { lobbyId: L, targetJoinSeq: specSeat, lobbySlot: { tag: 'Spectator' } as any })],
        ['set_captain', (ctx) => M.set_captain(ctx, { lobbyId: L, targetJoinSeq: b2Seat })],
        ['kick_member', (ctx) => M.kick_member(ctx, { lobbyId: L, targetJoinSeq: specSeat })],
        ['ban_member', (ctx) => M.ban_member(ctx, { lobbyId: L, targetJoinSeq: specSeat })],
        ['unban_member', (ctx) => M.unban_member(ctx, { lobbyId: L, bannedJoinSeq: bannedSeat })],
        ['transfer_referee', (ctx) => M.transfer_referee(ctx, { lobbyId: L, targetJoinSeq: r1Seat })],
        ['reclaim_referee', (ctx) => M.reclaim_referee(ctx, { lobbyId: L })],
        ['transfer_host', (ctx) => M.transfer_host(ctx, { lobbyId: L, targetJoinSeq: r1Seat })],
        ['update_lobby_settings', (ctx) => M.update_lobby_settings(ctx, settings)],
        ['close_lobby', (ctx) => M.close_lobby(ctx, { lobbyId: L })],
        ['shuffle_teams', (ctx) => M.shuffle_teams(ctx, { lobbyId: L, mode: { tag: 'TeamSwap' } as any })],
        ['start_draft', (ctx) => M.start_draft(ctx, { lobbyId: L })],
        ['advance_stage', (ctx) => M.advance_stage(ctx, { lobbyId: L })],
        ['pick_character', (ctx) => M.pick_character(ctx, { lobbyId: L, characterName: 'nobody', eidolon: 0 })],
        ['ban_character', (ctx) => M.ban_character(ctx, { lobbyId: L, characterName: 'nobody' })],
        ['nominate_character', (ctx) => M.nominate_character(ctx, { lobbyId: L, characterName: 'nobody' })],
        ['place_bid', (ctx) => M.place_bid(ctx, { lobbyId: L, bidAmount: 1 })],
        ['pass_bid', (ctx) => M.pass_bid(ctx, { lobbyId: L })],
        ['timer_expiry_classic', (ctx) => M.timer_expiry_classic(ctx, { lobbyId: L })],
        ['timer_expiry_auction', (ctx) => M.timer_expiry_auction(ctx, { lobbyId: L })],
        ['undo_last_step', (ctx) => M.undo_last_step(ctx, { lobbyId: L })],
        ['pause_draft', (ctx) => M.pause_draft(ctx, { lobbyId: L })],
        ['resume_draft', (ctx) => M.resume_draft(ctx, { lobbyId: L })],
        ['equip_lightcone', (ctx) => M.equip_lightcone(ctx, { lobbyId: L, teamSide: blue, characterName: 'nobody', lightconeName: 'none', superimposition: 1 })],
        ['unequip_lightcone', (ctx) => M.unequip_lightcone(ctx, { lobbyId: L, teamSide: blue, characterName: 'nobody' })],
        ['arrange_lineup', (ctx) => M.arrange_lineup(ctx, { lobbyId: L, teamSide: blue, groups: '[]' })],
        ['set_eidolon', (ctx) => M.set_eidolon(ctx, { lobbyId: L, teamSide: blue, characterName: 'nobody', eidolon: 1 })],
        ['record_group_scores', (ctx) => M.record_group_scores(ctx, { lobbyId: L, teamSide: blue, values: [H(10), H(10)], deaths: 0 })],
        ['set_score_adjustment', (ctx) => M.set_score_adjustment(ctx, { lobbyId: L, teamSide: blue, value: H(1) })],
        ['confirm_game', (ctx) => M.confirm_game(ctx, { lobbyId: L, teamSide: blue })],
        ['close_game', (ctx) => M.close_game(ctx, { lobbyId: L })],
    ];
}

/** Runs each call as `who`; each must be rejected and leave the lobby tables untouched. Returns [name, message] pairs. */
function rejectionsOf(test: Harness, who: Actor, calls: Call[]): Array<[string, string]> {
    return calls.map(([name, body]) => {
        const before = worldSnap(test);
        const msg = rejection(test, who, body);
        expect(worldSnap(test), `${name} changed state`).toBe(before);
        return [name, msg];
    });
}

describe('A98: an away or abandoned member is rejected by every lobby action reducer', () => {
    for (const state of ['away', 'abandoned'] as const) {
        const text = state === 'away' ? AWAY : ABANDONED;

        it(`A98 ${state}: every guarded reducer (account selection, chat send / delete, seat, captain, kick / ban / unban, referee and host transfer, settings / close / shuffle, start / advance, draft and Auction actions, both expiries, undo / pause / resume, the four package edits, score entry, adjustment, confirm, close) is rejected with the A98 text and changes nothing`, () => {
            const w = a98World(state);
            const calls = guardedCalls(w);
            const got = rejectionsOf(w.test, w.x, calls);
            expect(got).toEqual(calls.map(([name]) => [name, text]));
        });

        it(`A98 / A92(4) ${state}: concede, claim and defer keep the A92(4) texts, now for a referee row too`, () => {
            const w = a98World(state);
            const calls: Call[] = [
                ['concede_match (referee path)', (ctx) => M.concede_match(ctx, { lobbyId: w.L, losingTeamSide: 1 })],
                ['claim_forfeit', (ctx) => M.claim_forfeit(ctx, { lobbyId: w.L, forfeitingTeamSide: 2 })],
                ['defer_match', (ctx) => M.defer_match(ctx, { lobbyId: w.L })],
            ];
            const got = rejectionsOf(w.test, w.x, calls);
            const a92 = state === 'away' ? A92_AWAY : A92_ABANDONED;
            expect(got).toEqual(calls.map(([name]) => [name, a92]));
        });

        it(`A98 ${state}: the Waiting-stage reducers (self-move, ready, unready, account selection, settings, close, shuffle, start) reject a ${state} row (patched: a Waiting Leave deletes the row, A68(5))`, () => {
            const test = newHarness();
            const s = setupLobby(test, { noStart: true });
            const L = s.lobbyId;
            const x = s.a.b1;
            const stamp = test.clock.now();
            patchMember(test, L, x.userId, { leftAt: stamp, ...(state === 'abandoned' ? { abandonedAt: stamp } : {}), isReferee: true });
            test.db.Lobby.id.update({ ...lobbyRow(test, L), hostUserId: x.userId });
            const settings = settingsFrom(test, L, { standardTurnSeconds: 90 });
            const calls: Call[] = [
                ['set_team_slot (self)', (ctx) => M.set_team_slot(ctx, { lobbyId: L, lobbySlot: { tag: 'Spectator' } as any })],
                ['confirm_ready', (ctx) => M.confirm_ready(ctx, { lobbyId: L })],
                ['unconfirm_ready', (ctx) => M.unconfirm_ready(ctx, { lobbyId: L })],
                ['select_match_account', (ctx) => M.select_match_account(ctx, { lobbyId: L, hsrAccountId: 1 })],
                ['update_lobby_settings', (ctx) => M.update_lobby_settings(ctx, settings)],
                ['close_lobby', (ctx) => M.close_lobby(ctx, { lobbyId: L })],
                ['shuffle_teams', (ctx) => M.shuffle_teams(ctx, { lobbyId: L, mode: { tag: 'TeamSwap' } as any })],
                ['start_draft', (ctx) => M.start_draft(ctx, { lobbyId: L })],
            ];
            const got = rejectionsOf(test, x, calls);
            expect(got).toEqual(calls.map(([name]) => [name, text]));
        });
    }

    it('A98 the away member returns through join_lobby and can act again (chat, captain, cursor); a second leave_lobby while away is accepted and changes nothing', () => {
        const w = a98World('away');
        const { test, L, x, s } = w;
        const stamp = member(test, L, x.userId).leftAt;
        leave(test, x, L); // leave_lobby is unaffected (A98): accepted, nothing moves
        expect(member(test, L, x.userId).leftAt).toEqual(stamp);

        join(test, x, L);
        expect(member(test, L, x.userId).leftAt).toBeUndefined();
        chat(test, x, L, 'back');
        expect([...test.db.ChatMessage.lobby_id.filter(L)].some((m) => m.content === 'back' && m.senderUserId === x.userId)).toBe(true);
        tx(test, x, (ctx) => M.set_captain(ctx, { lobbyId: L, targetJoinSeq: seatOf(ctx, L, s.a.b2.userId) }));
        expect(member(test, L, s.a.b2.userId).isCaptain).toBe(true);
        expect(cursorEvents(test, x, L)).toHaveLength(1);
    });

    it('A98 / A68(4) the abandoned member never can: join_lobby is refused with the A68(4) text and every action stays rejected; leave_lobby is accepted', () => {
        const w = a98World('abandoned');
        const { test, L, x } = w;
        leave(test, x, L);
        const msg = rejection(test, x, (ctx) => M.join_lobby(ctx, { lobbyId: L, joinCode: '', password: '' }));
        expect(member(test, L, x.userId).abandonedAt).toBeDefined();
        expect(msg).toBe(NO_RETURN);
        expect(rejection(test, x, (ctx) => M.send_chat_message(ctx, { lobbyId: L, content: 'let me in', metadata: '' }))).toBe(ABANDONED);
        expect(rejection(test, x, (ctx) => M.pause_draft(ctx, { lobbyId: L }))).toBe(ABANDONED);
    });

    it('A98 a Moderator who is not a member keeps the staff paths: transfer_host, the result authority (adjustment, close) and the Admin edit of the closed game', () => {
        const test = newHarness();
        const s = playToScoring(test, {
            beforeStart: (l: Lobby) => {
                // Ranked (direct row edit, as s9a makeRanked) so the close parks the record (Submitted) instead of finalizing it
                test.db.Lobby.id.update({ ...lobbyRow(test, l.lobbyId), matchType: { tag: 'Ranked' } as any });
                let accountId = 700;
                for (const m of test.db.LobbyMember.lobby_id.filter(l.lobbyId)) {
                    if (m.lobbySlot.tag === 'BluePlayer' || m.lobbySlot.tag === 'RedPlayer') {
                        test.db.LobbyMemberAccount.insert({ lobbyId: l.lobbyId, userId: m.userId, hsrAccountId: accountId++ });
                    }
                }
            },
        });
        const L = s.lobbyId;
        leave(test, s.a.b1, L); // an away member in the lobby; the staff never needed a row
        const mod = moderator(test, 'mod');
        expect(member(test, L, mod.userId)).toBeUndefined();

        tx(test, mod, (ctx) => M.transfer_host(ctx, { lobbyId: L, targetJoinSeq: seatOf(ctx, L, s.a.r1.userId) }));
        expect(lobbyRow(test, L).hostUserId).toBe(s.a.r1.userId);

        tx(test, mod, (ctx) => M.set_score_adjustment(ctx, { lobbyId: L, teamSide: side('Red'), value: H(1), reason: 'staff' }));
        expect([...test.db.MatchResultAdjustment.iter()].some((a) => a.setById === mod.userId)).toBe(true);

        recordScores(s, s.host, 'Blue', [H(10), H(10)]);
        recordScores(s, s.host, 'Red', [H(20), H(20)]);
        tx(test, mod, (ctx) => M.close_game(ctx, { lobbyId: L }));
        const record = [...test.db.MatchResultRecord.lobby_id.filter(L)][0];
        expect(record.status.tag).toBe('Submitted');
        const gameOf = () => [...test.db.MatchResultGame.match_result_id.filter(record.id)][0];
        expect(gameOf().closedById).toBe(mod.userId);

        const admin = guest(test, 'admin');
        setRole(test, admin.userId, 'Admin');
        tx(test, admin, (ctx) => M.record_group_scores(ctx, { lobbyId: L, teamSide: side('Blue'), values: [H(30), H(30)], deaths: 0 }));
        expect(gameOf().winnerTeamSide.tag).toBe('Red');
        expect(gameOf().closedAt).toBeDefined();
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 6. A99: a private lobby needs a password
// ════════════════════════════════════════════════════════════════════════════

describe('A99: a private lobby needs a password', () => {
    const create = (test: Harness, who: Actor, over: Record<string, unknown>) =>
        tx(test, who, (ctx) => M.create_lobby(ctx, { ...DEFAULT_LOBBY_ARGS, ...over } as any));
    const passwordOf = (test: Harness, lobbyId: number) => test.db.LobbyPassword.lobbyId.find(lobbyId)?.passwordHash;

    it('A99 create_lobby: private with an empty password is rejected and creates nothing; with a password it is created and joinable only with it', () => {
        const test = newHarness();
        const h = guest(test, 'host');
        const lobbies = [...test.db.Lobby.iter()].length;
        const msg = rejection(test, h, (ctx) => M.create_lobby(ctx, { ...DEFAULT_LOBBY_ARGS, isPublic: false, password: '' } as any));
        expect([...test.db.Lobby.iter()]).toHaveLength(lobbies);
        expect([...test.db.LobbyMember.user_id.filter(h.userId)]).toHaveLength(0);
        expect(msg).toBe(PRIVATE_NEEDS_PASSWORD);

        create(test, h, { isPublic: false, password: 'pw' });
        const L = lobbyOfHost(test, h)!;
        expect(lobbyRow(test, L).isPublic).toBe(false);
        const j = guest(test, 'joiner');
        expect(rejection(test, j, (ctx) => M.join_lobby(ctx, { lobbyId: L, joinCode: '', password: '' }))).toBe(BAD_PASSWORD);
        expect(rejection(test, j, (ctx) => M.join_lobby(ctx, { lobbyId: L, joinCode: '', password: 'nope' }))).toBe(BAD_PASSWORD);
        join(test, j, L, 'pw');
        expect(member(test, L, j.userId)).toBeDefined();
    });

    it('A99 update_lobby_settings: a public lobby switched to private with an empty password is rejected and stays public', () => {
        const test = newHarness();
        const h = guest(test, 'host');
        create(test, h, {});
        const L = lobbyOfHost(test, h)!;
        const args = settingsFrom(test, L, { isPublic: false, password: '' });
        const before = snap([lobbyRow(test, L), passwordOf(test, L)]);
        const msg = rejection(test, h, (ctx) => M.update_lobby_settings(ctx, args));
        expect(snap([lobbyRow(test, L), passwordOf(test, L)])).toBe(before);
        expect(lobbyRow(test, L).isPublic).toBe(true);
        expect(msg).toBe(PRIVATE_NEEDS_PASSWORD);
    });

    it('A99 a private lobby that already has a password, updated with an empty password argument, keeps its password and stays joinable with it', () => {
        const test = newHarness();
        const h = guest(test, 'host');
        create(test, h, { isPublic: false, password: 'pw' });
        const L = lobbyOfHost(test, h)!;
        const args = settingsFrom(test, L, { isPublic: false, password: '', standardTurnSeconds: 90 });
        tx(test, h, (ctx) => M.update_lobby_settings(ctx, args));
        expect(lobbyRow(test, L).standardTurnSeconds).toBe(90);
        expect(lobbyRow(test, L).isPublic).toBe(false);
        expect(passwordOf(test, L)).toBe('pw');
        const j = guest(test, 'joiner');
        expect(rejection(test, j, (ctx) => M.join_lobby(ctx, { lobbyId: L, joinCode: '', password: '' }))).toBe(BAD_PASSWORD);
        join(test, j, L, 'pw');
        expect(member(test, L, j.userId)).toBeDefined();
    });

    // The brief's "switched public and back to private with an empty argument keeps its password" cannot hold together
    // with the private -> public flow step 9 (the switch to public deletes the LobbyPassword row; s10-lobby.test.ts),
    // so the lobby has no password when it goes back: A99 rejects that switch. Reported in the T-S10h report.
    it('A99 a lobby switched from private to public (its password row deleted, flow step 9) cannot go back to private with an empty password; with a new one it can', () => {
        const test = newHarness();
        const h = guest(test, 'host');
        create(test, h, { isPublic: false, password: 'pw' });
        const L = lobbyOfHost(test, h)!;
        const toPublic = settingsFrom(test, L, { isPublic: true, password: '' });
        tx(test, h, (ctx) => M.update_lobby_settings(ctx, toPublic));
        expect(passwordOf(test, L)).toBeUndefined();
        const back = settingsFrom(test, L, { isPublic: false, password: '' });
        const msg = rejection(test, h, (ctx) => M.update_lobby_settings(ctx, back));
        expect(lobbyRow(test, L).isPublic).toBe(true);
        expect(msg).toBe(PRIVATE_NEEDS_PASSWORD);
        const withNew = settingsFrom(test, L, { isPublic: false, password: 'pw2' });
        tx(test, h, (ctx) => M.update_lobby_settings(ctx, withNew));
        expect(passwordOf(test, L)).toBe('pw2');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// 7. S10h review fixes (F5 to F9) and the guest username (fix pass)
// ════════════════════════════════════════════════════════════════════════════

const isEvent = (event: string) => (m: { metadata?: string }) => {
    try { return JSON.parse(m.metadata ?? '').event === event; } catch { return false; }
};

describe('review F5 (A98): an away or abandoned member cannot receive the referee or the captain flag', () => {
    /** A Classic 2v2 draft (host = spectator referee); b1 leaves (away) and, for 'abandoned', then takes another lobby. */
    function awayTarget(state: 'away' | 'abandoned') {
        const test = newHarness();
        const s = setupLobby(test);
        const L = s.lobbyId;
        const x = s.a.b1;
        leave(test, x, L);
        const check = pendingCheck(test, L, x.userId);
        advance(test, 15_000);
        fireCheck(test, check);
        if (state === 'abandoned') abandon(test, x);
        expect(member(test, L, x.userId).abandonedAt === undefined).toBe(state === 'away');
        return { test, s, L, x };
    }

    for (const state of ['away', 'abandoned'] as const) {
        it(`review F5 ${state}: transfer_referee and set_captain to the ${state} seat are refused with the transfer_host text shape and change nothing`, () => {
            const { test, s, L, x } = awayTarget(state);
            const seat = seatOf(test, L, x.userId);
            const actors = [s.host, ...Object.values(s.a)];
            const referee = actors.find((a) => a.userId === refereeIds(test, L)[0])!;
            expect(lobbyRow(test, L).hostUserId).toBe(s.host.userId);
            const got = rejectionsOf(test, referee, [
                ['transfer_referee', (ctx) => M.transfer_referee(ctx, { lobbyId: L, targetJoinSeq: seat })],
            ]).concat(rejectionsOf(test, s.host, [
                ['set_captain', (ctx) => M.set_captain(ctx, { lobbyId: L, targetJoinSeq: seat })],
            ]));
            expect(got).toEqual([
                ['transfer_referee', `The member at seat ${seat} has left the match and cannot become the referee.`],
                ['set_captain', `The member at seat ${seat} has left the match and cannot become a captain.`],
            ]);
            expect(member(test, L, x.userId)).toMatchObject({ isReferee: false, isCaptain: false });
        });
    }
});

describe('review F6 / F7 (A97): a stored chat line keeps the label of the membership it was written under', () => {
    it('review F6: a member who left and rejoined: old lines (chat, the "left" line) keep the old label, new lines (chat, the "joined" line) carry the new one', () => {
        const test = newHarness();
        const s = setupLobby(test, { lobby: FULL_ANON, noStart: true });
        const L = s.lobbyId;
        const x = s.a.b1;
        const oldLabel = seatLabel(test, L, x.userId);
        chat(test, x, L, 'first membership');
        advance(test, 3_000);
        leave(test, x, L); // Waiting: the row is deleted (A68(5))
        advance(test, 3_000);
        join(test, x, L); // a new seat (A74: never reused)
        const newLabel = seatLabel(test, L, x.userId);
        expect(newLabel).not.toBe(oldLabel);
        advance(test, 3_000);
        chat(test, x, L, 'second membership');

        const rows = view<AnonymousChatRow>(test, 'view_my_lobby_chat', s.a.r1);
        expect(rows.find((c) => c.content === 'first membership')).toMatchObject({ senderUserId: 0, anonymousLabel: oldLabel });
        expect(rows.find((c) => c.content === 'second membership')).toMatchObject({ senderUserId: 0, anonymousLabel: newLabel });
        expect(rows.some((c) => c.content === `${oldLabel} left the lobby.`), 'left line').toBe(true);
        expect(rows.some((c) => c.content === `${newLabel} joined the lobby.`), 'joined line').toBe(true);
        expect(rows.some((c) => c.content === `${newLabel} left the lobby.`), 'no relabelled left line').toBe(false);
    });

    it('review F7: a member-event line written in an identified lobby stores the subject\'s seat label; after the lobby turns anonymous in Waiting an opponent reads that label, not "A player"', () => {
        const test = newHarness();
        const s = setupLobby(test, { noStart: true });
        const L = s.lobbyId;
        expect(lobbyRow(test, L).isAnonymousPlayers).toBe(false);
        const b2Label = seatLabel(test, L, s.a.b2.userId);
        tx(test, s.host, (ctx) => M.kick_member(ctx, { lobbyId: L, targetJoinSeq: seatOf(ctx, L, s.a.b2.userId) }));
        const raw = [...test.db.ChatMessage.lobby_id.filter(L)].find(isEvent('kicked'))!;
        expect(raw.anonymousLabel).toBe(b2Label);

        const anon = settingsFrom(test, L, { isAnonymousPlayers: true, isAnonymousSpectators: true }); // read outside the tx
        tx(test, s.host, (ctx) => M.update_lobby_settings(ctx, anon));
        expect(lobbyRow(test, L).isAnonymousPlayers).toBe(true);
        const row = view<AnonymousChatRow>(test, 'view_my_lobby_chat', s.a.r1).find((c) => c.id === raw.id)!;
        expect(row.content).toBe(`${b2Label} was kicked from the lobby.`);
        expect(JSON.parse(row.metadata!)).toEqual({ event: 'kicked', subjectUserId: 0 });
    });
});

describe('review F8 (A98): Moderator and Admin powers never depend on presence', () => {
    for (const state of ['away', 'abandoned'] as const) {
        // A spectator's Leave deletes its row in every stage (A68(5)), so the staff member's away / abandoned row is
        // patched in. set_captain admits the host, an authorized referee or an Admin (D-30): a Moderator has no
        // captain power to keep, so the captain call is made by an Admin.
        it(`review F8 ${state}: a Moderator holding a ${state} row still kicks and bans; an Admin holding one still sets a captain`, () => {
            const test = newHarness();
            const s = setupLobby(test);
            const L = s.lobbyId;
            const kickMe = joinAsSpectator(s, 'kick-me');
            const banMe = joinAsSpectator(s, 'ban-me');
            const staff = joinAsSpectator(s, 'staff');
            setRole(test, staff.userId, 'Moderator');
            const stamp = test.clock.now();
            patchMember(test, L, staff.userId, { leftAt: stamp, ...(state === 'abandoned' ? { abandonedAt: stamp } : {}) });

            tx(test, staff, (ctx) => M.kick_member(ctx, { lobbyId: L, targetJoinSeq: seatOf(ctx, L, kickMe.userId) }));
            expect(member(test, L, kickMe.userId)).toBeUndefined();
            const banSeat = seatOf(test, L, banMe.userId);
            tx(test, staff, (ctx) => M.ban_member(ctx, { lobbyId: L, targetJoinSeq: banSeat }));
            expect(member(test, L, banMe.userId)).toBeUndefined();
            expect([...test.db.LobbyBan.lobby_id.filter(L)].some((b) => b.bannedUserId === banMe.userId && b.bannedByUserId === staff.userId)).toBe(true);

            setRole(test, staff.userId, 'Admin');
            const blue = [s.a.b1, s.a.b2].find((p) => !member(test, L, p.userId).isCaptain)!;
            tx(test, staff, (ctx) => M.set_captain(ctx, { lobbyId: L, targetJoinSeq: seatOf(ctx, L, blue.userId) }));
            expect(member(test, L, blue.userId).isCaptain).toBe(true);
            expect(member(test, L, staff.userId).leftAt).toBeDefined(); // still away: the staff power did not need a return
        });
    }

    it('review F8: a User-role host holding an away row is still refused kick, ban and set_captain with the A98 text (the exemption is for staff only)', () => {
        const w = a98World('away');
        const specSeat = seatOf(w.test, w.L, w.spec.userId);
        const b2Seat = seatOf(w.test, w.L, w.s.a.b2.userId);
        const got = rejectionsOf(w.test, w.x, [
            ['kick_member', (ctx) => M.kick_member(ctx, { lobbyId: w.L, targetJoinSeq: specSeat })],
            ['ban_member', (ctx) => M.ban_member(ctx, { lobbyId: w.L, targetJoinSeq: specSeat })],
            ['set_captain', (ctx) => M.set_captain(ctx, { lobbyId: w.L, targetJoinSeq: b2Seat })],
        ]);
        expect(got.map(([, msg]) => msg)).toEqual([AWAY, AWAY, AWAY]);
    });
});

describe('review F9 (A98): finalize_match_result by a referee whose row is away or abandoned', () => {
    /** A standalone Ranked lobby parked in AwaitingResult (host = spectator referee = the record's refereeUserId), Validated by a Moderator. */
    function validated() {
        const test = newHarness();
        seedElo(test);
        const s = parkedLobby(test);
        const mod = moderator(test, 'mod');
        const record = [...test.db.MatchResultRecord.lobby_id.filter(s.lobbyId)][0];
        expect(record.refereeUserId).toBe(s.host.userId);
        tx(test, mod, (ctx) => M.override_match_result(ctx, { matchResultId: record.id, newStatusTag: 'Validated', winnerTeamSideTag: 'Blue', reason: 'reviewed' }));
        return { test, s, mod, recId: record.id };
    }

    for (const state of ['away', 'abandoned'] as const) {
        // An AwaitingResult Leave deletes the row (A68(5)), so the referee's away / abandoned row is patched in.
        it(`review F9 ${state}: the referee (not staff) is refused with the A98 text and nothing changes; a Moderator then finalizes`, () => {
            const { test, s, mod, recId } = validated();
            const stamp = test.clock.now();
            patchMember(test, s.lobbyId, s.host.userId, { leftAt: stamp, ...(state === 'abandoned' ? { abandonedAt: stamp } : {}) });
            const got = rejectionsOf(test, s.host, [['finalize_match_result', (ctx) => M.finalize_match_result(ctx, { matchResultId: recId })]]);
            expect(got).toEqual([['finalize_match_result', state === 'away' ? AWAY : ABANDONED]]);
            expect(test.db.MatchResultRecord.id.find(recId)!.status.tag).toBe('Validated');

            tx(test, mod, (ctx) => M.finalize_match_result(ctx, { matchResultId: recId }));
            expect(test.db.MatchResultRecord.id.find(recId)).toBeFalsy();
        });
    }

    it('review F9: a present referee still finalizes (control)', () => {
        const { test, s, recId } = validated();
        tx(test, s.host, (ctx) => M.finalize_match_result(ctx, { matchResultId: recId }));
        expect(test.db.MatchResultRecord.id.find(recId)).toBeFalsy();
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
