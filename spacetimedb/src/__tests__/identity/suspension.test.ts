// Identity: account suspension, set and lifted by hand (admin and server reducers), its refusals, the no-write and
//   no-read rules, the sign-in refusal, the lobby side effects and the clean-up paths.
// Decisions: A195, A213, A214, user ruling 2026-11-17 (an Admin is suspended only through the server reducers);
//   A68 (Leave, no automatic forfeit), A163(3) (the maintenance pattern this mirrors)
// Contracts: docs/suspension/contract.md
// From suspension-s1.
//
// T-suspension-s1: everything runs in the SDK's in-memory datastore; nothing reaches maincloud. A suspension row is
// written either through the reducers (the real path, with its side effects) or directly with `suspendRaw` where a
// test isolates one check (the view helper, the cursor drop) from the lobby side effects.
import { describe, expect, it } from 'vitest';
import {
    SUSPENDED_SIGN_IN_TEXT,
    SUSPENDED_TEXT,
} from '@module/helpers/identity/suspension';
import {
    ALREADY_SUSPENDED_TEXT,
    NOT_SUSPENDED_TEXT,
    SUSPEND_ADMIN_FROM_APP_TEXT,
    SUSPEND_NOT_VERIFIED_TEXT,
    SUSPEND_PENDING_DELETION_TEXT,
    SUSPEND_SELF_TEXT,
    SUSPEND_SYSTEM_TEXT,
    SUSPENSION_REASON_TOO_LONG_TEXT,
} from '@module/helpers/identity/suspensionActions';
import { MAINTENANCE_TEXT } from '@module/helpers/identity/ensurePermissions';
import {
    AUDIT,
    DEFAULT_LOBBY_ARGS,
    M,
    TEST_CLIENT_NONCE,
    TEST_CONFIRM_HASH,
    TEST_CONFIRM_TOKEN,
    captainOf,
    connect,
    guest,
    linkerAuth,
    lobbyRow,
    member,
    newHarness,
    refereeIds,
    rejection,
    setupLobby,
    snap,
    tx,
    type Actor,
    type Ctx,
    type Harness,
} from '../fixtures/harness';
import { ADMIN_ONLY, admin, fireDeletionJob, freshAuth, moderator, providerOf, verified } from '../fixtures/identity';
import { at } from '../fixtures/calendar';
import { duel } from '../fixtures/tournament-matches';
import { enrolled, membership, teamRow } from '../fixtures/tournaments';

const NOT_SERVER = 'Forbidden: caller is not a registered server identity.';

const row = (test: Harness, userId: number) => test.db.UserSuspension.userId.find(userId);
const usernameOf = (test: Harness, a: Actor | number) =>
    test.db.User.id.find(typeof a === 'number' ? a : a.userId)!.username;
const systemUserId = (test: Harness) => test.db.User.username.find('SYSTEM')!.id;

const adminSuspend = (test: Harness, by: Actor, target: Actor | number, reason = '') =>
    tx(test, by, (ctx) => M.admin_suspend_user(ctx, { userId: typeof target === 'number' ? target : target.userId, reason }));
const adminLift = (test: Harness, by: Actor, target: Actor) =>
    tx(test, by, (ctx) => M.admin_lift_suspension(ctx, { userId: target.userId }));
const serverSuspend = (test: Harness, username: string, reason = '') =>
    tx(test, 'internal', (ctx) => M.server_suspend_user(ctx, { username, reason }));
const serverLift = (test: Harness, username: string) =>
    tx(test, 'internal', (ctx) => M.server_lift_suspension(ctx, { username }));

/** A suspension row written directly (no side effects), to isolate one check. */
function suspendRaw(test: Harness, userId: number) {
    test.db.UserSuspension.insert({ userId, reason: '', suspendedById: 0, ...AUDIT(test) } as any);
}
const liftRaw = (test: Harness, userId: number) => test.db.UserSuspension.userId.delete(userId);

/** server_nuke_test_data reads ctx.env.STDB_TARGET; the harness has no module env, so the test database is simulated. */
function onTestDatabase(ctx: Ctx): Ctx {
    return new Proxy(ctx as object, {
        get(target, prop) {
            if (prop === 'env') return { STDB_TARGET: 'test' };
            const value = Reflect.get(target, prop, target);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    }) as Ctx;
}

// ─── Suspend and lift ────────────────────────────────────────────────────────

describe('suspend and lift: happy paths', () => {
    it('an Admin suspends a verified user with a reason; the row records the Admin; the Admin lifts it', () => {
        const test = newHarness();
        const boss = admin(test, 'boss');
        const target = verified(test, 'tgt');
        adminSuspend(test, boss, target, 'spam in chat');
        const r = row(test, target.userId)!;
        expect(r.reason).toBe('spam in chat');
        expect(r.suspendedById).toBe(boss.userId);
        expect(r.createdById).toBe(boss.userId);
        adminLift(test, boss, target);
        expect(row(test, target.userId)).toBeNull();
    });

    it('the reason is optional: empty and exactly 500 characters are accepted', () => {
        const test = newHarness();
        const boss = admin(test, 'boss');
        const a = verified(test, 'a1');
        const b = verified(test, 'b1');
        adminSuspend(test, boss, a, '');
        adminSuspend(test, boss, b, 'x'.repeat(500));
        expect(row(test, a.userId)!.reason).toBe('');
        expect(row(test, b.userId)!.reason).toHaveLength(500);
    });

    it('the server suspends and lifts by username; the actor is SYSTEM', () => {
        const test = newHarness();
        const target = verified(test, 'tgt');
        serverSuspend(test, usernameOf(test, target), 'from the script');
        const r = row(test, target.userId)!;
        expect(r.suspendedById).toBe(0);
        expect(r.reason).toBe('from the script');
        serverLift(test, usernameOf(test, target));
        expect(row(test, target.userId)).toBeNull();
    });
});

describe('suspend and lift: refusals', () => {
    it('admin_suspend_user refuses each bad target with its text; nothing is written', () => {
        const test = newHarness();
        const boss = admin(test, 'boss');
        const g = guest(test, 'aguest');
        const gone = verified(test, 'gone');
        test.db.User.id.update({ ...test.db.User.id.find(gone.userId)!, deletedAt: test.clock.now() });
        const target = verified(test, 'tgt');
        adminSuspend(test, boss, target);

        const cases: Array<[string, number, string | RegExp]> = [
            ['unknown user', 999_999, /not found/],
            ['pending deletion', gone.userId, SUSPEND_PENDING_DELETION_TEXT],
            ['SYSTEM', systemUserId(test), SUSPEND_SYSTEM_TEXT],
            ['self', boss.userId, SUSPEND_SELF_TEXT],
            ['guest', g.userId, SUSPEND_NOT_VERIFIED_TEXT],
            ['already suspended', target.userId, ALREADY_SUSPENDED_TEXT],
        ];
        const before = snap([...test.db.UserSuspension.iter()]);
        for (const [name, userId, text] of cases) {
            const msg = rejection(test, boss, (ctx) => M.admin_suspend_user(ctx, { userId, reason: '' }));
            if (typeof text === 'string') expect(msg, name).toBe(text);
            else expect(msg, name).toMatch(text);
        }
        expect(snap([...test.db.UserSuspension.iter()])).toBe(before);
    });

    it('a reason over 500 characters is refused', () => {
        const test = newHarness();
        const boss = admin(test, 'boss');
        const target = verified(test, 'tgt');
        expect(rejection(test, boss, (ctx) => M.admin_suspend_user(ctx, { userId: target.userId, reason: 'x'.repeat(501) })))
            .toBe(SUSPENSION_REASON_TOO_LONG_TEXT);
        const username = usernameOf(test, target); // test.db is read outside a transaction body only
        expect(rejection(test, 'internal', (ctx) => M.server_suspend_user(ctx, { username, reason: 'x'.repeat(501) })))
            .toBe(SUSPENSION_REASON_TOO_LONG_TEXT);
        expect(row(test, target.userId)).toBeNull();
    });

    it('lifting a user who is not suspended is refused (admin and server)', () => {
        const test = newHarness();
        const boss = admin(test, 'boss');
        const target = verified(test, 'tgt');
        const username = usernameOf(test, target);
        expect(rejection(test, boss, (ctx) => M.admin_lift_suspension(ctx, { userId: target.userId }))).toBe(NOT_SUSPENDED_TEXT);
        expect(rejection(test, 'internal', (ctx) => M.server_lift_suspension(ctx, { username }))).toBe(NOT_SUSPENDED_TEXT);
    });

    it('a Moderator or a normal user cannot suspend or lift from the app', () => {
        const test = newHarness();
        const boss = admin(test, 'boss');
        const mod = moderator(test, 'mod');
        const user = verified(test, 'usr');
        const target = verified(test, 'tgt');
        for (const who of [mod, user]) {
            expect(rejection(test, who, (ctx) => M.admin_suspend_user(ctx, { userId: target.userId, reason: '' }))).toBe(ADMIN_ONLY);
        }
        adminSuspend(test, boss, target);
        for (const who of [mod, user]) {
            expect(rejection(test, who, (ctx) => M.admin_lift_suspension(ctx, { userId: target.userId }))).toBe(ADMIN_ONLY);
        }
        expect(row(test, target.userId)).not.toBeNull();
    });

    it('the server variants refuse the Linker and a user', () => {
        const test = newHarness();
        const user = verified(test, 'usr');
        const target = verified(test, 'tgt');
        const username = usernameOf(test, target);
        const linker = linkerAuth(test);
        expect(() => test.withReducerTx(linker, (ctx) => M.server_suspend_user(ctx, { username, reason: '' }))).toThrow(NOT_SERVER);
        expect(rejection(test, user, (ctx) => M.server_suspend_user(ctx, { username, reason: '' }))).toBe(NOT_SERVER);
        serverSuspend(test, username);
        expect(() => test.withReducerTx(linker, (ctx) => M.server_lift_suspension(ctx, { username }))).toThrow(NOT_SERVER);
        expect(rejection(test, user, (ctx) => M.server_lift_suspension(ctx, { username }))).toBe(NOT_SERVER);
        expect(row(test, target.userId)).not.toBeNull();
    });

    it('the server variants refuse SYSTEM, a guest, an unknown username and an already suspended user', () => {
        const test = newHarness();
        const g = guest(test, 'aguest');
        const target = verified(test, 'tgt');
        const targetName = usernameOf(test, target);
        const guestName = usernameOf(test, g);
        serverSuspend(test, targetName);
        expect(rejection(test, 'internal', (ctx) => M.server_suspend_user(ctx, { username: 'SYSTEM', reason: '' }))).toBe(SUSPEND_SYSTEM_TEXT);
        expect(rejection(test, 'internal', (ctx) => M.server_suspend_user(ctx, { username: guestName, reason: '' }))).toBe(SUSPEND_NOT_VERIFIED_TEXT);
        expect(rejection(test, 'internal', (ctx) => M.server_suspend_user(ctx, { username: 'nobody-here', reason: '' }))).toMatch(/not found/);
        expect(rejection(test, 'internal', (ctx) => M.server_suspend_user(ctx, { username: targetName, reason: '' }))).toBe(ALREADY_SUSPENDED_TEXT);
    });
});

describe('an Admin is suspended only through the server (user ruling 2026-11-17)', () => {
    it('admin_suspend_user refuses an Admin target', () => {
        const test = newHarness();
        const boss = admin(test, 'boss');
        const other = admin(test, 'other');
        expect(rejection(test, boss, (ctx) => M.admin_suspend_user(ctx, { userId: other.userId, reason: '' }))).toBe(SUSPEND_ADMIN_FROM_APP_TEXT);
        expect(row(test, other.userId)).toBeNull();
    });

    it('the server suspends an Admin; the Admin is refused; another Admin lifts it from the app; the server path too', () => {
        const test = newHarness();
        const boss = admin(test, 'boss');
        const other = admin(test, 'other');
        serverSuspend(test, usernameOf(test, other));
        expect(row(test, other.userId)).not.toBeNull();
        expect(rejection(test, other, (ctx) => M.admin_suspend_user(ctx, { userId: boss.userId, reason: '' }))).toBe(SUSPENDED_TEXT);
        adminLift(test, boss, other);
        expect(row(test, other.userId)).toBeNull();
        serverSuspend(test, usernameOf(test, other));
        serverLift(test, usernameOf(test, other));
        expect(row(test, other.userId)).toBeNull();
        tx(test, other, (ctx) => M.update_display_name(ctx, { newDisplayName: 'Back again' }));
    });
});

// ─── No writing ──────────────────────────────────────────────────────────────

describe('a suspended account cannot write', () => {
    /** A tournament in progress, a live lobby with the suspended user seated (b1), and an Admin. */
    function world() {
        const f = duel();
        const test = f.test;
        const sus = verified(test, 'sus');
        const s = setupLobby(test, { actors: { b1: sus } });
        const boss = admin(test, 'boss');
        return { f, test, s, sus, boss };
    }

    function samples(w: ReturnType<typeof world>): Array<[string, (ctx: Ctx) => unknown]> {
        const lobbyId = w.s.lobbyId;
        return [
            ['lobby: create_lobby', (ctx) => M.create_lobby(ctx, { ...DEFAULT_LOBBY_ARGS } as any)],
            ['lobby: join_lobby', (ctx) => M.join_lobby(ctx, { lobbyId, joinCode: '', password: '' })],
            ['lobby: send_chat_message', (ctx) => M.send_chat_message(ctx, { lobbyId, content: 'hi', metadata: '' })],
            ['lobby: leave_lobby', (ctx) => M.leave_lobby(ctx, { lobbyId })],
            ['draft: pick_character', (ctx) => M.pick_character(ctx, { lobbyId, characterName: 'Kafka', eidolon: 0 })],
            ['draft: pause_draft', (ctx) => M.pause_draft(ctx, { lobbyId } as any)],
            ['results: concede_match', (ctx) => M.concede_match(ctx, { lobbyId, losingTeamSide: 0 })],
            ['tournament: register_for_tournament', (ctx) => M.register_for_tournament(ctx, { tournamentId: w.f.id } as any)],
            ['tournament: create_tournament_team', (ctx) => M.create_tournament_team(ctx, { tournamentId: w.f.id, teamName: 'Team' } as any)],
            ['calendar: create_availability_slot', (ctx) => M.create_availability_slot(ctx, { startAt: at(w.test, 1), endAt: at(w.test, 2), kind: 'Available' })],
            ['roster: create_hsr_account', (ctx) => M.create_hsr_account(ctx, { uid: '800000001', displayLabel: 'Main' })],
            ['stats: set_displayed_achievement', (ctx) => M.set_displayed_achievement(ctx, { achievementId: undefined } as any)],
            ['identity: update_display_name', (ctx) => M.update_display_name(ctx, { newDisplayName: 'New name' })],
            ['identity: update_username', (ctx) => M.update_username(ctx, { newUsername: 'newname' })],
            ['identity: update_avatar', (ctx) => M.update_avatar(ctx, { characterName: 'Kafka' })],
            ['identity: delete_my_account', (ctx) => M.delete_my_account(ctx, {})],
            ['identity: login_as_guest', (ctx) => M.login_as_guest(ctx, {})],
            ['identity: request_link_code', (ctx) => M.request_link_code(ctx, { clientNonce: TEST_CLIENT_NONCE })],
        ];
    }

    it('a sample of reducers from each domain is refused with one text; nothing changes', () => {
        const w = world();
        adminSuspend(w.test, w.boss, w.sus);
        const before = snap(
            w.test.db.User.id.find(w.sus.userId), member(w.test, w.s.lobbyId, w.sus.userId), lobbyRow(w.test, w.s.lobbyId),
            [...w.test.db.ChatMessage.lobby_id.filter(w.s.lobbyId)].length,
        );
        for (const [name, call] of samples(w)) {
            expect(rejection(w.test, w.sus, call), name).toBe(SUSPENDED_TEXT);
        }
        expect(snap(
            w.test.db.User.id.find(w.sus.userId), member(w.test, w.s.lobbyId, w.sus.userId), lobbyRow(w.test, w.s.lobbyId),
            [...w.test.db.ChatMessage.lobby_id.filter(w.s.lobbyId)].length,
        )).toBe(before);
    });

    it('a suspended Admin is refused on an Admin tool too, and during maintenance with the suspension text', () => {
        const w = world();
        const other = admin(w.test, 'other');
        tx(w.test, w.boss, (ctx) => M.admin_update_abuse_config(ctx, { maintenanceMode: true } as any));
        serverSuspend(w.test, usernameOf(w.test, other));
        expect(rejection(w.test, other, (ctx) => M.admin_gc_lobbies(ctx, {}))).toBe(SUSPENDED_TEXT);
        expect(rejection(w.test, other, (ctx) => M.update_display_name(ctx, { newDisplayName: 'x' }))).toBe(SUSPENDED_TEXT);
    });

    it('confirm_link of a suspended caller is refused with the suspension text', () => {
        const test = newHarness();
        const sus = verified(test, 'sus');
        suspendRaw(test, sus.userId);
        expect(rejection(test, sus, (ctx) => M.confirm_link(ctx, { confirmToken: TEST_CONFIRM_TOKEN }))).toBe(SUSPENDED_TEXT);
    });

    it('broadcast_cursor of a suspended member is dropped silently (no event, no stamp)', () => {
        const w = world();
        suspendRaw(w.test, w.sus.userId); // the row only: the member stays present, so the suspension check is what drops it
        const counts = tx(w.test, w.sus, (ctx) => {
            M.broadcast_cursor(ctx, { lobbyId: w.s.lobbyId, x: 0.5, y: 0.5 });
            return [[...ctx.db.LobbyCursorEvent.iter()].length, [...ctx.db.LobbyCursorStamp.iter()].length];
        });
        expect(counts).toEqual([0, 0]);
        liftRaw(w.test, w.sus.userId);
        const after = tx(w.test, w.sus, (ctx) => {
            M.broadcast_cursor(ctx, { lobbyId: w.s.lobbyId, x: 0.5, y: 0.5 });
            return [...ctx.db.LobbyCursorEvent.iter()].length;
        });
        expect(after).toBe(1);
    });

    it('after a lift the user writes again', () => {
        const w = world();
        adminSuspend(w.test, w.boss, w.sus);
        adminLift(w.test, w.boss, w.sus);
        tx(w.test, w.sus, (ctx) => M.update_display_name(ctx, { newDisplayName: 'Returned' }));
        expect(w.test.db.User.id.find(w.sus.userId)!.displayName).toBe('Returned');
    });
});

// ─── No reading ──────────────────────────────────────────────────────────────

/** Each per-caller view file, one or more views, with the arguments to call it. */
const VIEW_SAMPLES: Array<[string, Record<string, unknown>]> = [
    ['view_my_identity', {}],
    ['view_my_profile', {}],
    ['view_my_link_request', {}],
    ['view_my_lobbies', {}],
    ['view_my_lobby', {}],
    ['view_my_lobby_members', {}],
    ['view_my_lobby_chat', {}],
    ['view_lobby_presets', {}],
    ['view_my_match_session', {}],
    ['view_my_match_participants', {}],
    ['view_my_match_result', {}],
    ['view_my_match_history', { page: 0, gameMode: '', draftMode: '', matchType: '' }],
    ['view_my_match_history_count', { gameMode: '', draftMode: '', matchType: '' }],
    ['view_my_player_stats', {}],
    ['view_my_mmr_ratings', {}],
    ['view_my_relationships', {}],
    ['view_my_roster', {}],
    ['view_my_loadouts', {}],
    ['view_my_cost_sets', {}],
    ['view_my_calendar_events', {}],
    ['view_my_availability', {}],
    ['view_my_tournament_enrollment', {}],
    ['view_my_team_requests', {}],
    ['view_tournament_matches_for_me', {}],
    ['view_tournament_registrant_accounts', {}],
    ['view_my_tournaments', {}],
    ['view_admin_users', {}],
    ['view_admin_stuck_games', {}],
    ['view_admin_ban_records', {}],
];

const readView = (test: Harness, auth: any, name: string, args: Record<string, unknown>) =>
    snap((M as any)[name](test.viewContext(auth), args));

describe('a suspended account cannot read its own data', () => {
    /** An Admin seated in a live lobby of a tournament in progress, so most of the views have rows for them. */
    function world() {
        const f = duel();
        const test = f.test;
        const sus = f.ts[0].captain;
        const s = setupLobby(test, { actors: { b1: sus } });
        const boss = admin(test, 'boss');
        test.db.User.id.update({ ...test.db.User.id.find(sus.userId)!, role: { tag: 'Admin' } as any });
        return { f, test, s, sus, boss };
    }

    it('every sampled per-caller view returns what a visitor gets; after the lift the rows come back', () => {
        const w = world();
        const visitor = freshAuth(w.test, 'visitor').auth;
        const before = new Map(VIEW_SAMPLES.map(([v, args]) => [v, readView(w.test, w.sus.auth, v, args)]));
        // the fixture gives the caller rows in these, so the check below is not trivially true
        for (const v of ['view_my_profile', 'view_my_lobbies', 'view_my_lobby_members', 'view_my_tournament_enrollment', 'view_admin_users']) {
            expect(before.get(v), v).not.toBe(readView(w.test, visitor, v, VIEW_SAMPLES.find(([n]) => n === v)![1]));
        }
        suspendRaw(w.test, w.sus.userId);
        for (const [v, args] of VIEW_SAMPLES) {
            expect(readView(w.test, w.sus.auth, v, args), v).toBe(readView(w.test, visitor, v, args));
        }
        liftRaw(w.test, w.sus.userId);
        for (const [v, args] of VIEW_SAMPLES) {
            expect(readView(w.test, w.sus.auth, v, args), v).toBe(before.get(v));
        }
    });

    it('other callers keep reading their own rows while one account is suspended', () => {
        const w = world();
        const other = w.s.a.r1;
        const before = readView(w.test, other.auth, 'view_my_lobby_members', {});
        suspendRaw(w.test, w.sus.userId);
        expect(readView(w.test, other.auth, 'view_my_lobby_members', {})).toBe(before);
    });
});

describe('view_my_suspension', () => {
    it('one row (the user id only) for the suspended caller; nothing for anyone else; never the reason', () => {
        const test = newHarness();
        const boss = admin(test, 'boss');
        const sus = verified(test, 'sus');
        const other = verified(test, 'other');
        const visitor = freshAuth(test, 'visitor').auth;
        const view = (auth: any) => (M as any).view_my_suspension(test.viewContext(auth), {}) as any[];
        expect(view(sus.auth)).toEqual([]);
        adminSuspend(test, boss, sus, 'secret staff note');
        expect(view(sus.auth)).toEqual([{ userId: sus.userId }]);
        expect(JSON.stringify(view(sus.auth))).not.toContain('secret');
        expect(view(boss.auth)).toEqual([]);
        expect(view(other.auth)).toEqual([]);
        expect(view(visitor)).toEqual([]);
        adminLift(test, boss, sus);
        expect(view(sus.auth)).toEqual([]);
    });
});

// ─── Sign-in ─────────────────────────────────────────────────────────────────

describe('Discord sign-in to a suspended account is refused', () => {
    it('linker_present_code refuses a new browser signing in to the suspended account; the guest stays a guest', () => {
        const test = newHarness();
        const boss = admin(test, 'boss');
        const sus = verified(test, 'sus');
        const providerId = providerOf(test, sus)!;
        adminSuspend(test, boss, sus);
        const g = guest(test, 'newbrowser');
        tx(test, g, (ctx) => M.request_link_code(ctx, { clientNonce: TEST_CLIENT_NONCE }));
        const code = test.db.LinkRequest.identity.find(g.identity)!.code;
        expect(() => test.withReducerTx(linkerAuth(test), (ctx) => M.linker_present_code(ctx, {
            linkCode: code, provider: 'discord', providerId, providerName: 'sus', confirmHash: TEST_CONFIRM_HASH,
        }))).toThrow(SUSPENDED_SIGN_IN_TEXT);
        expect(test.db.UserIdentity.identity.find(g.identity)!.userId).toBe(g.userId);
        expect(test.db.User.id.find(g.userId)!.isGuest).toBe(true);
    });

    it('confirm_link refuses when the account was suspended after the code was presented', () => {
        const test = newHarness();
        const boss = admin(test, 'boss');
        const sus = verified(test, 'sus');
        const providerId = providerOf(test, sus)!;
        const g = guest(test, 'newbrowser');
        tx(test, g, (ctx) => M.request_link_code(ctx, { clientNonce: TEST_CLIENT_NONCE }));
        const code = test.db.LinkRequest.identity.find(g.identity)!.code;
        test.withReducerTx(linkerAuth(test), (ctx) => M.linker_present_code(ctx, {
            linkCode: code, provider: 'discord', providerId, providerName: 'sus', confirmHash: TEST_CONFIRM_HASH,
        }));
        adminSuspend(test, boss, sus);
        expect(rejection(test, g, (ctx) => M.confirm_link(ctx, { confirmToken: TEST_CONFIRM_TOKEN }))).toBe(SUSPENDED_SIGN_IN_TEXT);
        expect(test.db.UserIdentity.identity.find(g.identity)!.userId).toBe(g.userId);
    });

    it('after the lift the sign-in works again', () => {
        const test = newHarness();
        const boss = admin(test, 'boss');
        const sus = verified(test, 'sus');
        const providerId = providerOf(test, sus)!;
        adminSuspend(test, boss, sus);
        adminLift(test, boss, sus);
        const g = guest(test, 'newbrowser');
        tx(test, g, (ctx) => M.request_link_code(ctx, { clientNonce: TEST_CLIENT_NONCE }));
        const code = test.db.LinkRequest.identity.find(g.identity)!.code;
        test.withReducerTx(linkerAuth(test), (ctx) => M.linker_present_code(ctx, {
            linkCode: code, provider: 'discord', providerId, providerName: 'sus', confirmHash: TEST_CONFIRM_HASH,
        }));
        tx(test, g, (ctx) => M.confirm_link(ctx, { confirmToken: TEST_CONFIRM_TOKEN }));
        expect(test.db.UserIdentity.identity.find(g.identity)!.userId).toBe(sus.userId);
    });
});

// ─── Lobbies and matches ─────────────────────────────────────────────────────

describe('a suspended member in a lobby', () => {
    it('Waiting: the row is removed as a Leave, the host and referee flags move, the "left" line is written', () => {
        const test = newHarness();
        const boss = admin(test, 'boss');
        const sus = verified(test, 'sus');
        const s = setupLobby(test, { actors: { host: sus }, noStart: true });
        expect(lobbyRow(test, s.lobbyId).hostUserId).toBe(sus.userId);
        expect(refereeIds(test, s.lobbyId)).toEqual([sus.userId]);
        const count = lobbyRow(test, s.lobbyId).currentPlayerCount;
        adminSuspend(test, boss, sus);
        expect(member(test, s.lobbyId, sus.userId)).toBeUndefined();
        const l = lobbyRow(test, s.lobbyId);
        expect(l.hostUserId).not.toBe(sus.userId);
        expect(refereeIds(test, s.lobbyId)).toHaveLength(1);
        expect(refereeIds(test, s.lobbyId)).not.toContain(sus.userId);
        expect(l.currentPlayerCount).toBe(count - 1);
        const lines = [...test.db.ChatMessage.lobby_id.filter(s.lobbyId)].map((m) => m.metadata ?? '');
        expect(lines.some((m) => m.includes('"left"') && m.includes(`${sus.userId}`))).toBe(true);
    });

    it('a Waiting lobby whose only member is suspended is deleted', () => {
        const test = newHarness();
        const boss = admin(test, 'boss');
        const sus = verified(test, 'sus');
        tx(test, sus, (ctx) => M.create_lobby(ctx, { ...DEFAULT_LOBBY_ARGS } as any));
        const lobbyId = [...test.db.Lobby.host_user_id.filter(sus.userId)][0].id;
        adminSuspend(test, boss, sus);
        expect(test.db.Lobby.id.find(lobbyId)).toBeNull();
    });

    it('live: the player row stays, marked away; host, captain and referee pass on at once; no forfeit; return after the lift', () => {
        const test = newHarness();
        const boss = admin(test, 'boss');
        const sus = verified(test, 'sus');
        const s = setupLobby(test, {
            actors: { host: sus },
            hostSlot: 'BluePlayer',
            seats: [['b2', 'BluePlayer'], ['r1', 'RedPlayer'], ['r2', 'RedPlayer']],
        });
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('Drafting');
        expect(lobbyRow(test, s.lobbyId).hostUserId).toBe(sus.userId);
        expect(refereeIds(test, s.lobbyId)).toEqual([sus.userId]);
        expect(captainOf(test, s.lobbyId, 'BluePlayer')!.userId).toBe(sus.userId);

        adminSuspend(test, boss, sus);

        const m = member(test, s.lobbyId, sus.userId)!;
        expect(m).toBeDefined();
        expect(m.leftAt).toBeDefined();
        expect(m.isOnline).toBe(false);
        expect(m.abandonedAt).toBeUndefined();
        expect(m.disconnectedAt).toBeDefined(); // Standard policy: the forfeit clock runs as for a Leave
        expect(m.isCaptain).toBe(false);
        expect(m.isReferee).toBe(false);
        const l = lobbyRow(test, s.lobbyId);
        expect(l.hostUserId).not.toBe(sus.userId);
        expect(captainOf(test, s.lobbyId, 'BluePlayer')!.userId).toBe(s.a.b2.userId);
        expect(refereeIds(test, s.lobbyId)).toHaveLength(1);
        // no automatic forfeit (A68(3)): the match is still on, no record was conceded
        expect(l.stage.tag).toBe('Drafting');
        const record = [...test.db.MatchResultRecord.lobby_id.filter(s.lobbyId)][0];
        expect(record?.matchEndReason?.tag).not.toBe('Concede');

        adminLift(test, boss, sus);
        tx(test, sus, (ctx) => M.join_lobby(ctx, { lobbyId: s.lobbyId, joinCode: '', password: '' }));
        const back = member(test, s.lobbyId, sus.userId)!;
        expect(back.leftAt).toBeUndefined();
        expect(back.isOnline).toBe(true);
    });

    it('live: a spectator seat is removed', () => {
        const test = newHarness();
        const boss = admin(test, 'boss');
        const sus = verified(test, 'sus');
        const s = setupLobby(test);
        tx(test, sus, (ctx) => M.join_lobby(ctx, { lobbyId: s.lobbyId, joinCode: '', password: '' }));
        expect(member(test, s.lobbyId, sus.userId)).toBeDefined();
        adminSuspend(test, boss, sus);
        expect(member(test, s.lobbyId, sus.userId)).toBeUndefined();
    });

    it('the pending link requests of the user are deleted', () => {
        const test = newHarness();
        const boss = admin(test, 'boss');
        const sus = verified(test, 'sus');
        test.db.LinkRequest.insert({
            code: 'C'.repeat(32), identity: sus.identity, userId: sus.userId, expiresAt: test.clock.now(), usedAt: undefined,
            pendingProvider: undefined, pendingProviderId: undefined, pendingProviderName: undefined, confirmHash: undefined,
            ...AUDIT(test),
        } as any);
        adminSuspend(test, boss, sus);
        expect([...test.db.LinkRequest.user_id.filter(sus.userId)]).toHaveLength(0);
    });
});

// ─── Tournaments ─────────────────────────────────────────────────────────────

describe('tournament ties are untouched', () => {
    it('the entry, the team and the captaincy stay as they were', () => {
        const f = duel();
        const test = f.test;
        const boss = admin(test, 'boss');
        const sus = f.ts[0].captain;
        const before = snap(enrolled(test, f.id, sus.userId), membership(test, f.id, sus.userId), teamRow(test, f.ts[0].teamId));
        adminSuspend(test, boss, sus);
        expect(snap(enrolled(test, f.id, sus.userId), membership(test, f.id, sus.userId), teamRow(test, f.ts[0].teamId))).toBe(before);
    });
});

// ─── Clean-up ────────────────────────────────────────────────────────────────

describe('a ban, a deletion or a test wipe removes the suspension', () => {
    it('a ban of a suspended user removes the row with the deletion', () => {
        const test = newHarness();
        const boss = admin(test, 'boss');
        const sus = verified(test, 'sus');
        adminSuspend(test, boss, sus);
        const providerId = providerOf(test, sus)!;
        tx(test, boss, (ctx) => M.admin_ban_user(ctx, { banTypeTag: 'DiscordId', providerId, reason: 'abuse' }));
        fireDeletionJob(test, sus.userId);
        expect(row(test, sus.userId)).toBeNull();
    });

    it('a server deletion of a suspended user removes the row', () => {
        const test = newHarness();
        const sus = verified(test, 'sus');
        const username = usernameOf(test, sus);
        serverSuspend(test, username);
        tx(test, 'internal', (ctx) => M.server_delete_user(ctx, { username }));
        expect(row(test, sus.userId)).toBeNull();
    });

    it('a user pending deletion cannot be suspended (the ban already set deletedAt)', () => {
        const test = newHarness();
        const boss = admin(test, 'boss');
        const sus = verified(test, 'sus');
        const providerId = providerOf(test, sus)!;
        tx(test, boss, (ctx) => M.admin_ban_user(ctx, { banTypeTag: 'DiscordId', providerId, reason: 'abuse' }));
        expect(rejection(test, boss, (ctx) => M.admin_suspend_user(ctx, { userId: sus.userId, reason: '' }))).toBe(SUSPEND_PENDING_DELETION_TEXT);
    });

    it('server_nuke_test_data clears the table', () => {
        const test = newHarness();
        const a = verified(test, 'a1');
        const b = verified(test, 'b1');
        serverSuspend(test, usernameOf(test, a));
        serverSuspend(test, usernameOf(test, b));
        expect([...test.db.UserSuspension.iter()]).toHaveLength(2);
        tx(test, 'internal', (ctx) => M.server_nuke_test_data(onTestDatabase(ctx), { confirmation: 'NUKE_TEST_DATA' }));
        expect([...test.db.UserSuspension.iter()]).toHaveLength(0);
    });
});

// ─── Fix pass (Phase suspension-s1 execution, review M1, M2, M3, M9 and the listing view) ───────────────────────

const CONNECT_REFUSED = 'Maintenance mode: connections are not accepted right now.';
const setMaintenance = (test: Harness, who: Actor, on: boolean) =>
    tx(test, who, (ctx) => M.admin_update_abuse_config(ctx, { maintenanceMode: on } as any));

describe('review M1: the lobby members never learn which staff user suspended a member', () => {
    /** Every lobby-side row of the lobby that carries the staff user's id in an audit column. */
    function staffTraces(test: Harness, lobbyId: number, staffId: number): string[] {
        const traces: string[] = [];
        const l = test.db.Lobby.id.find(lobbyId);
        if (l && (l.lastModifiedById === staffId || l.createdById === staffId)) traces.push('Lobby');
        for (const m of test.db.LobbyMember.lobby_id.filter(lobbyId)) {
            if (m.lastModifiedById === staffId || m.createdById === staffId) traces.push(`LobbyMember #${m.userId}`);
        }
        for (const c of test.db.ChatMessage.lobby_id.filter(lobbyId)) {
            if (c.lastModifiedById === staffId || c.createdById === staffId) traces.push('ChatMessage');
        }
        return traces;
    }

    for (const stage of ['Drafting', 'Waiting'] as const) {
        it(`${stage}: a non-host player is suspended; the lobby rows carry SYSTEM_USER_ID, the suspension row the Admin`, () => {
            const test = newHarness();
            const boss = admin(test, 'boss');
            const sus = verified(test, 'sus');
            const s = setupLobby(test, { actors: { r1: sus }, noStart: stage === 'Waiting' });
            expect(lobbyRow(test, s.lobbyId).stage.tag).toBe(stage);
            expect(lobbyRow(test, s.lobbyId).hostUserId).not.toBe(sus.userId);
            adminSuspend(test, boss, sus);
            expect(staffTraces(test, s.lobbyId, boss.userId)).toEqual([]);
            expect(lobbyRow(test, s.lobbyId).lastModifiedById).toBe(0);
            expect(row(test, sus.userId)!.suspendedById).toBe(boss.userId);
            expect(row(test, sus.userId)!.createdById).toBe(boss.userId);
        });
    }
});

describe('review M2: request_link_code and confirm_link check the suspension before maintenance', () => {
    it('during maintenance a suspended caller gets the suspension text; a caller who is not suspended the maintenance text', () => {
        const test = newHarness();
        const boss = admin(test, 'boss');
        const sus = verified(test, 'sus');
        const other = verified(test, 'other');
        suspendRaw(test, sus.userId);
        setMaintenance(test, boss, true);
        expect(rejection(test, sus, (ctx) => M.request_link_code(ctx, { clientNonce: TEST_CLIENT_NONCE }))).toBe(SUSPENDED_TEXT);
        expect(rejection(test, sus, (ctx) => M.confirm_link(ctx, { confirmToken: TEST_CONFIRM_TOKEN }))).toBe(SUSPENDED_TEXT);
        expect(rejection(test, other, (ctx) => M.request_link_code(ctx, { clientNonce: TEST_CLIENT_NONCE }))).toBe(MAINTENANCE_TEXT);
        expect(rejection(test, other, (ctx) => M.confirm_link(ctx, { confirmToken: TEST_CONFIRM_TOKEN }))).toBe(MAINTENANCE_TEXT);
    });
});

describe('review M3: client_connected during maintenance refuses a suspended Admin', () => {
    it('a suspended Admin is refused like a non-Admin; an Admin who is not suspended connects', () => {
        const test = newHarness();
        const boss = admin(test, 'boss');
        const other = admin(test, 'other');
        serverSuspend(test, usernameOf(test, other));
        setMaintenance(test, boss, true);
        expect(rejection(test, other, (ctx) => M.client_connected(ctx, {}))).toBe(CONNECT_REFUSED);
        connect(test, boss);
    });

    it('outside maintenance a suspended identity still connects (to read view_my_suspension)', () => {
        const test = newHarness();
        const boss = admin(test, 'boss');
        const sus = verified(test, 'sus');
        adminSuspend(test, boss, sus);
        connect(test, sus);
        expect((M as any).view_my_suspension(test.viewContext(sus.auth), {})).toEqual([{ userId: sus.userId }]);
    });
});

describe('review M9: every holder of the Discord id is tested for a suspension', () => {
    // Two holders of one Discord id should never exist; the order the index returns them in is not fixed, so each
    // holder is suspended in turn and both runs must refuse.
    for (const which of ['first', 'second'] as const) {
        it(`the ${which} holder is suspended: linker_present_code refuses the sign-in`, () => {
            const test = newHarness();
            const a = verified(test, 'holder1');
            const b = verified(test, 'holder2');
            const providerId = providerOf(test, a)!;
            test.db.User.id.update({ ...test.db.User.id.find(b.userId)!, providerId });
            suspendRaw(test, which === 'first' ? a.userId : b.userId);
            const g = guest(test, 'newbrowser');
            tx(test, g, (ctx) => M.request_link_code(ctx, { clientNonce: TEST_CLIENT_NONCE }));
            const code = test.db.LinkRequest.identity.find(g.identity)!.code;
            expect(() => test.withReducerTx(linkerAuth(test), (ctx) => M.linker_present_code(ctx, {
                linkCode: code, provider: 'discord', providerId, providerName: 'holder', confirmHash: TEST_CONFIRM_HASH,
            }))).toThrow(SUSPENDED_SIGN_IN_TEXT);
        });
    }
});

describe('view_admin_suspensions (the suspended list)', () => {
    const list = (test: Harness, auth: any) => (M as any).view_admin_suspensions(test.viewContext(auth), {}) as any[];

    it('an Admin reads every suspension with its reason; Moderator, user, suspended Admin and visitor read nothing', () => {
        const test = newHarness();
        const boss = admin(test, 'boss');
        const otherAdmin = admin(test, 'otheradm');
        const mod = moderator(test, 'mod');
        const user = verified(test, 'usr');
        const sus = verified(test, 'sus');
        const visitor = freshAuth(test, 'visitor').auth;
        adminSuspend(test, boss, sus, 'spam in chat');
        serverSuspend(test, usernameOf(test, otherAdmin), 'from the script');

        const rows = list(test, boss.auth);
        expect(rows).toHaveLength(2);
        const bySus = rows.find((r) => r.userId === sus.userId)!;
        expect(bySus).toMatchObject({
            username: usernameOf(test, sus),
            displayName: test.db.User.id.find(sus.userId)!.displayName,
            reason: 'spam in chat',
            suspendedById: boss.userId,
            suspendedByUsername: usernameOf(test, boss),
        });
        expect(bySus.suspendedAt).toEqual(row(test, sus.userId)!.createdDate);
        const byServer = rows.find((r) => r.userId === otherAdmin.userId)!;
        expect(byServer).toMatchObject({ reason: 'from the script', suspendedById: 0, suspendedByUsername: 'SYSTEM' });

        for (const [name, auth] of [['Moderator', mod.auth], ['user', user.auth], ['suspended Admin', otherAdmin.auth],
            ['suspended user', sus.auth], ['visitor', visitor]] as const) {
            expect(list(test, auth), name).toEqual([]);
        }
    });

    it('a lift removes the row; a user pending deletion gives no row', () => {
        const test = newHarness();
        const boss = admin(test, 'boss');
        const a = verified(test, 'a1');
        const b = verified(test, 'b1');
        adminSuspend(test, boss, a);
        adminSuspend(test, boss, b);
        expect(list(test, boss.auth).map((r) => r.userId).sort()).toEqual([a.userId, b.userId].sort());
        adminLift(test, boss, a);
        expect(list(test, boss.auth).map((r) => r.userId)).toEqual([b.userId]);
        test.db.User.id.update({ ...test.db.User.id.find(b.userId)!, deletedAt: test.clock.now() });
        expect(list(test, boss.auth)).toEqual([]);
    });
});
