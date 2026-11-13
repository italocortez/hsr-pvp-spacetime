// Identity: the one-time link codes of the Discord sign-in (M5a): request_link_code, view_my_link_request,
// server_link_by_code, the clean-up of stale codes.
// Decisions: A44(3), A46, A77, A94, A113(4)
// Contracts: docs/auth/contract.md (entries proposed in the M5a hand-back)
// T-M5a (new file).
//
// Everything runs in the SDK's in-memory datastore; server reducers run as the owner identity ('internal', registered by
// init). `test.db` is read only outside `tx` bodies. Nothing reaches maincloud.
import { describe, expect, it } from 'vitest';
import { ScheduleAt, Timestamp } from 'spacetimedb';
import { sha256, generateLinkCode, CLIENT_NONCE_INVALID_TEXT, CLIENT_NONCE_LENGTH, LINK_CODE_LENGTH, LINK_CODE_REFUSED_TEXT, LINK_SWEEP_SCAN_LIMIT } from '@module/helpers/identity/linkCode';
import { capOnCodePoint, FINISH_GAME_BEFORE_SIGN_IN_TEXT } from '@module/helpers/identity/providerLink';
import { ACCOUNT_CHANGED_TEXT, NOT_A_DISCORD_ID_TEXT } from '@module/reducers/identity/server';
import { MAINTENANCE_TEXT } from '@module/helpers/identity/ensurePermissions';
import { ABUSE_CONFIG_ID } from '@module/helpers/lobby/abuseControls';
import {
    AUDIT,
    M,
    advance,
    guest,
    linkDiscord,
    lobbyRow,
    newHarness,
    now,
    rejection,
    setupLobby,
    tx,
    type Actor,
    type Ctx,
    type Harness,
} from '../fixtures/harness';
import { addSecondIdentity, admin, fireDeletionJob, freshAuth, identitiesOf, linked, verified } from '../fixtures/identity';
import { view } from '../fixtures/views';

const FIVE_MINUTES_MS = 5 * 60_000;
const FORBIDDEN = 'Forbidden: caller is not a registered server identity.';
const NO_ACCOUNT = 'No account for this identity. Call login_as_guest first.';
const ALREADY_LINKED = 'This account is already linked.';
const DELETED = 'Unauthorized: This account has been deleted.';
const CODE_ALPHABET = /^[A-Za-z0-9_-]+$/;

let nonceCounter = 0;
/** A well-formed client nonce (43 base64url characters), different on every call. */
const nextNonce = () => `nonce${nonceCounter++}_`.padEnd(43, 'Q');

const requestCode = (test: Harness, a: Actor) => tx(test, a, (ctx) => M.request_link_code(ctx, { clientNonce: nextNonce() }));
const myRequest = (test: Harness, a: Actor) => view<{ code: string; expiresAt: Timestamp }>(test, 'view_my_link_request', a);
/** The caller's live code, read through the view. */
const codeOf = (test: Harness, a: Actor): string => {
    const rows = myRequest(test, a);
    expect(rows).toHaveLength(1);
    return rows[0].code;
};
const linkByCode = (test: Harness, linkCode: string, providerId: string, providerName: string, provider = 'discord') =>
    tx(test, 'internal', (ctx) => M.server_link_by_code(ctx, { linkCode, provider, providerId, providerName }));
const userRow = (test: Harness, userId: number) => test.db.User.id.find(userId);
const linkRows = (test: Harness) => [...test.db.LinkRequest.iter()];

/**
 * The reducer context with `env.STDB_TARGET = 'test'` (requireTestDatabase passes; the harness cannot set module env,
 * harness smoke (f)); everything else is the real ctx. As in stats/server-set-mmr-season.test.ts.
 */
function onTestDatabase(ctx: Ctx): Ctx {
    return new Proxy(ctx as object, {
        get(target, prop) {
            if (prop === 'env') return { STDB_TARGET: 'test' };
            const value = Reflect.get(target, prop, target);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    }) as Ctx;
}

let nextSnowflake = 400_000_000_000_000_001n;
/** A verified user whose provider id is Discord-shaped (server_link_by_code checks the shape; existingUser uses pid-...). */
function existingDiscordUser(test: Harness, sub: string): { a: Actor; providerId: string } {
    const providerId = String(nextSnowflake++);
    return { a: linked(test, sub, providerId, sub), providerId };
}

/** A LinkRequest row written directly (another identity's request), expiring `expiresInMs` from now (negative: past). */
function insertRequest(test: Harness, sub: string, expiresInMs: number) {
    const { identity } = freshAuth(test, sub);
    const code = `direct-${sub}`;
    test.db.LinkRequest.insert({
        code,
        identity,
        userId: 9_000,
        expiresAt: new Timestamp(now(test) + BigInt(expiresInMs) * 1000n),
        usedAt: undefined,
        ...AUDIT(test),
    } as any);
    return code;
}

// ════════════════════════════════════════════════════════════════════════════
// request_link_code and view_my_link_request
// ════════════════════════════════════════════════════════════════════════════

describe('request_link_code and view_my_link_request (M5a)', () => {
    it('a guest gets a code it reads in view_my_link_request (code and expiresAt only, 5 minutes out); another identity sees nothing', () => {
        const test = newHarness();
        const g = guest(test, 'asker');
        const other = guest(test, 'other');
        requestCode(test, g);

        const rows = myRequest(test, g);
        expect(rows).toHaveLength(1);
        expect(Object.keys(rows[0]).sort()).toEqual(['code', 'expiresAt']);
        expect(rows[0].expiresAt.microsSinceUnixEpoch).toBe(now(test) + BigInt(FIVE_MINUTES_MS) * 1000n);
        expect(myRequest(test, other)).toEqual([]);
        expect(view(test, 'view_my_link_request', freshAuth(test, 'stranger').auth)).toEqual([]);

        const [row] = linkRows(test);
        expect(row).toMatchObject({ code: rows[0].code, identity: g.identity, userId: g.userId, usedAt: undefined,
            createdById: g.userId, lastModifiedById: g.userId });
        expect(row.createdDate.microsSinceUnixEpoch).toBe(now(test));
    });

    it('a second request replaces the first: one row for the identity, the old code is refused', () => {
        const test = newHarness();
        const g = guest(test, 'twice');
        requestCode(test, g);
        const first = codeOf(test, g);
        requestCode(test, g); // same microsecond (the TestClock does not move): the code still differs
        const second = codeOf(test, g);

        expect(second).not.toBe(first);
        expect(linkRows(test).map((r) => r.code)).toEqual([second]);
        const msg = rejection(test, 'internal', (ctx) => M.server_link_by_code(ctx, { linkCode: first, provider: 'discord', providerId: '100000000000000001', providerName: 'Twice' }));
        expect(userRow(test, g.userId)).toMatchObject({ isGuest: true, loginMethod: undefined });
        expect(msg).toBe(LINK_CODE_REFUSED_TEXT);
        linkByCode(test, second, '100000000000000001', 'Twice');
        expect(userRow(test, g.userId)).toMatchObject({ isGuest: false, providerId: '100000000000000001' });
    });

    it('an identity with no user is refused and nothing is written', () => {
        const test = newHarness();
        const { auth } = freshAuth(test, 'never-logged-in');
        const msg = rejection(test, { auth } as Actor, (ctx) => M.request_link_code(ctx, { clientNonce: nextNonce() }));
        expect(linkRows(test)).toHaveLength(0);
        expect(msg).toBe(NO_ACCOUNT);
    });

    it('a user who already has Discord linked is refused', () => {
        const test = newHarness();
        const v = verified(test, 'linked');
        const msg = rejection(test, v, (ctx) => M.request_link_code(ctx, { clientNonce: nextNonce() }));
        expect(linkRows(test)).toHaveLength(0);
        expect(msg).toBe(ALREADY_LINKED);
    });

    it('a deleted user (deletedAt set, the cascade pending) and a banned user are refused', () => {
        const test = newHarness();
        const boss = admin(test);
        const g = guest(test, 'leaving');
        tx(test, boss, (ctx) => M.admin_delete_row(ctx, { tableName: 'User', primaryKeyJson: String(g.userId) }));
        const target = verified(test, 'banned');
        const targetProviderId = userRow(test, target.userId)!.providerId!; // read outside the tx body (S5 log note 6)
        tx(test, boss, (ctx) => M.admin_ban_user(ctx, { banTypeTag: 'DiscordId', providerId: targetProviderId, reason: 'abuse' }));

        const deletedMsg = rejection(test, g, (ctx) => M.request_link_code(ctx, { clientNonce: nextNonce() }));
        const bannedMsg = rejection(test, target, (ctx) => M.request_link_code(ctx, { clientNonce: nextNonce() }));
        expect(linkRows(test)).toHaveLength(0);
        expect(deletedMsg).toBe(DELETED);
        expect(bannedMsg).toBe(DELETED);
    });

    it('maintenance mode refuses a guest, as login_as_guest does', () => {
        const test = newHarness();
        const g = guest(test, 'during-maintenance');
        const config = test.db.AbuseConfig.id.find(ABUSE_CONFIG_ID)!;
        test.db.AbuseConfig.id.update({ ...config, maintenanceMode: true });
        const msg = rejection(test, g, (ctx) => M.request_link_code(ctx, { clientNonce: nextNonce() }));
        expect(linkRows(test)).toHaveLength(0);
        expect(msg).toBe(MAINTENANCE_TEXT);
    });

    it(`codes are ${LINK_CODE_LENGTH} base64url characters and differ across calls and identities`, () => {
        const test = newHarness();
        const seen = new Set<string>();
        const guests = ['a', 'b', 'c', 'd'].map((s) => guest(test, `code-${s}`));
        for (const g of guests) {
            for (let i = 0; i < 3; i++) {
                requestCode(test, g);
                const code = codeOf(test, g);
                expect(code).toHaveLength(LINK_CODE_LENGTH);
                expect(code).toMatch(CODE_ALPHABET);
                seen.add(code);
                if (i === 1) advance(test, 1);
            }
        }
        expect(seen.size).toBe(12);
        expect(linkRows(test)).toHaveLength(4);
    });

    it.each([
        ['empty', ''],
        ['42 characters', 'A'.repeat(42)],
        ['44 characters', 'A'.repeat(44)],
        ['a padding character', 'A'.repeat(42) + '='],
        ['a standard base64 character', 'A'.repeat(42) + '+'],
        ['a space', 'A'.repeat(42) + ' '],
    ])('a client nonce that is %s is refused and nothing is written', (_label, clientNonce) => {
        const test = newHarness();
        const g = guest(test, 'bad-nonce');
        const msg = rejection(test, g, (ctx) => M.request_link_code(ctx, { clientNonce }));
        expect(linkRows(test)).toHaveLength(0);
        expect(msg).toBe(CLIENT_NONCE_INVALID_TEXT);
    });

    it('the nonce changes the code: through the reducer (same identity, connection, clock, no previous code), and in generateLinkCode with every other input fixed; it is in neither the row nor the view', () => {
        const nonceA = 'a'.repeat(CLIENT_NONCE_LENGTH);
        const nonceB = 'b'.repeat(CLIENT_NONCE_LENGTH);
        const test = newHarness();
        const g = guest(test, 'same-asker');
        // The TestClock stands still and the row is removed between calls, so there is no previous code: this half shows
        // the codes differ and the nonce is not stored; the helper half below pins every other input explicitly.
        const codeWith = (nonce: string) => {
            tx(test, g, (ctx) => M.request_link_code(ctx, { clientNonce: nonce }));
            const json = JSON.stringify([linkRows(test), myRequest(test, g)], (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
            expect(json).not.toContain(nonce);
            const code = codeOf(test, g);
            test.db.LinkRequest.code.delete(code);
            return code;
        };
        expect(codeWith(nonceB)).not.toBe(codeWith(nonceA));

        // generateLinkCode with a fixed context: one identity, one connection id, one timestamp.
        const fixed = {
            sender: g.identity,
            connectionId: { toUint8Array: () => new Uint8Array(16).fill(7) },
            timestamp: test.clock.now(),
            db: { LinkRequest: { code: { find: () => undefined } } },
        };
        const a1 = generateLinkCode(fixed, undefined, nonceA);
        expect(generateLinkCode(fixed, undefined, nonceA)).toBe(a1);
        expect(generateLinkCode(fixed, undefined, nonceB)).not.toBe(a1);
    });

    it('sha256 matches the FIPS 180-4 test vectors (the digest the codes are cut from)', () => {
        const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
        const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
        expect(hex(sha256(ascii('')))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
        expect(hex(sha256(ascii('abc')))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
        expect(hex(sha256(ascii('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))))
            .toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
        expect(hex(sha256(ascii('a'.repeat(1000))))).toBe('41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// server_link_by_code
// ════════════════════════════════════════════════════════════════════════════

describe('server_link_by_code (M5a)', () => {
    it('a caller that is not a registered server identity is refused, even an Admin; the code stays live', () => {
        const test = newHarness();
        const boss = admin(test);
        const g = guest(test, 'victim');
        requestCode(test, g);
        const code = codeOf(test, g);
        for (const who of [boss, g]) {
            const msg = rejection(test, who, (ctx) => M.server_link_by_code(ctx, { linkCode: code, provider: 'discord', providerId: '100000000000000002', providerName: 'Steal' }));
            expect(msg).toBe(FORBIDDEN);
        }
        expect(userRow(test, g.userId)!.isGuest).toBe(true);
        expect(codeOf(test, g)).toBe(code);
    });

    it('happy path: the guest is upgraded as by server_link_provider Case 1a; the code is spent and cannot be used twice', () => {
        const test = newHarness();
        const g = guest(test, 'fresh');
        requestCode(test, g);
        const code = codeOf(test, g);
        linkByCode(test, code, '100000000000000003', 'FreshName');

        expect(userRow(test, g.userId)).toMatchObject({ isGuest: false, username: 'FreshName', displayName: 'FreshName',
            loginMethod: 'discord', providerId: '100000000000000003', providerUsername: 'FreshName' });
        expect(userRow(test, g.userId)!.linkedAt?.microsSinceUnixEpoch).toBe(now(test));
        expect(linkRows(test)).toHaveLength(0);
        expect(myRequest(test, g)).toEqual([]);

        const before = userRow(test, g.userId);
        const msg = rejection(test, 'internal', (ctx) => M.server_link_by_code(ctx, { linkCode: code, provider: 'discord', providerId: '100000000000000004', providerName: 'Other' }));
        expect(userRow(test, g.userId)).toEqual(before);
        expect(msg).toBe(LINK_CODE_REFUSED_TEXT);
    });

    it('an expired code is refused (5 minutes after the request); one millisecond earlier it works', () => {
        const test = newHarness();
        const late = guest(test, 'late');
        const onTime = guest(test, 'on-time');
        requestCode(test, late);
        requestCode(test, onTime);
        const lateCode = codeOf(test, late);
        const onTimeCode = codeOf(test, onTime);

        advance(test, FIVE_MINUTES_MS - 1);
        linkByCode(test, onTimeCode, '100000000000000005', 'OnTime');
        expect(userRow(test, onTime.userId)!.isGuest).toBe(false);

        advance(test, 1);
        const msg = rejection(test, 'internal', (ctx) => M.server_link_by_code(ctx, { linkCode: lateCode, provider: 'discord', providerId: '100000000000000006', providerName: 'Late' }));
        expect(userRow(test, late.userId)).toMatchObject({ isGuest: true, loginMethod: undefined });
        expect(msg).toBe(LINK_CODE_REFUSED_TEXT);
    });

    it('an unknown code and an empty code are refused with the same text as an expired or used one', () => {
        const test = newHarness();
        const g = guest(test, 'bystander');
        requestCode(test, g);
        for (const linkCode of ['no-such-code', '', 'x'.repeat(LINK_CODE_LENGTH)]) {
            const msg = rejection(test, 'internal', (ctx) => M.server_link_by_code(ctx, { linkCode, provider: 'discord', providerId: '100000000000000007', providerName: 'X' }));
            expect(msg).toBe(LINK_CODE_REFUSED_TEXT);
        }
        // a row marked used (no writer sets usedAt today; the check guards a restored row) is refused the same way
        const code = codeOf(test, g);
        test.db.LinkRequest.code.update({ ...test.db.LinkRequest.code.find(code)!, usedAt: test.clock.now() });
        const msg = rejection(test, 'internal', (ctx) => M.server_link_by_code(ctx, { linkCode: code, provider: 'discord', providerId: '100000000000000007', providerName: 'X' }));
        expect(msg).toBe(LINK_CODE_REFUSED_TEXT);
        expect(myRequest(test, g)).toEqual([]);
        expect(userRow(test, g.userId)!.isGuest).toBe(true);
    });

    it('a banned Discord id is refused with the ban text; nothing changes and the code stays live; after the unban the same code links once', () => {
        const test = newHarness();
        const boss = admin(test);
        tx(test, boss, (ctx) => M.admin_ban_user(ctx, { banTypeTag: 'DiscordId', providerId: '100000000000000008', reason: 'abuse' }));
        const g = guest(test, 'wannabe');
        requestCode(test, g);
        const code = codeOf(test, g);

        const msg = rejection(test, 'internal', (ctx) => M.server_link_by_code(ctx, { linkCode: code, provider: 'discord', providerId: '100000000000000008', providerName: 'Wannabe' }));
        expect(userRow(test, g.userId)).toMatchObject({ isGuest: true, loginMethod: undefined, providerId: undefined });
        expect(codeOf(test, g)).toBe(code);
        expect(msg).toBe('This discord account is banned and cannot be linked.');

        const banId = [...test.db.BanRecord.iter()][0].id;
        tx(test, boss, (ctx) => M.admin_unban_user(ctx, { banRecordId: banId }));
        linkByCode(test, code, '100000000000000008', 'Wannabe');
        expect(userRow(test, g.userId)).toMatchObject({ isGuest: false, providerId: '100000000000000008' });
        expect(linkRows(test)).toHaveLength(0);
        const again = rejection(test, 'internal', (ctx) => M.server_link_by_code(ctx, { linkCode: code, provider: 'discord', providerId: '100000000000000008', providerName: 'Wannabe' }));
        expect(again).toBe(LINK_CODE_REFUSED_TEXT);
    });

    it.each([
        ['an empty providerId', { providerId: '' }, 'providerId is not a Discord id.'],
        ['a blank providerName', { providerName: '   ' }, 'providerName is required'],
        ['an unknown provider', { provider: 'facebook' }, 'Invalid provider "facebook". Must be one of: discord'],
    ])('input validation: %s is refused with its own text; nothing changes and the code stays live', (_label, over, text) => {
        const test = newHarness();
        const g = guest(test, 'val');
        requestCode(test, g);
        const code = codeOf(test, g);
        const args = { linkCode: code, provider: 'discord', providerId: '100000000000000009', providerName: 'Val', ...over };
        const msg = rejection(test, 'internal', (ctx) => M.server_link_by_code(ctx, args));
        expect(userRow(test, g.userId)).toMatchObject({ isGuest: true, loginMethod: undefined });
        expect(codeOf(test, g)).toBe(code);
        expect(msg).toBe(text);
    });

    it('A113(4) by code: a guest seated as a player in a Drafting lobby is refused with the live-game text and stays a guest; the code stays live', () => {
        const test = newHarness();
        const { providerId } = existingDiscordUser(test, 'owner');
        const g = guest(test, 'g');
        const s = setupLobby(test, { seats: [['g', 'BluePlayer'], ['b2', 'BluePlayer'], ['r1', 'RedPlayer'], ['r2', 'RedPlayer']], actors: { g } });
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('Drafting');
        requestCode(test, g);
        const code = codeOf(test, g);

        const msg = rejection(test, 'internal', (ctx) => M.server_link_by_code(ctx, { linkCode: code, provider: 'discord', providerId, providerName: 'ignored' }));
        expect(test.db.UserIdentity.identity.find(g.identity)!.userId).toBe(g.userId);
        expect(userRow(test, g.userId)).toMatchObject({ isGuest: true, loginMethod: undefined });
        expect(codeOf(test, g)).toBe(code);
        expect(msg).toBe(FINISH_GAME_BEFORE_SIGN_IN_TEXT);
    });

    it('re-point by code: the Discord user already exists, the identity is re-pointed to it and the orphan guest deleted', () => {
        const test = newHarness();
        const { a: owner, providerId } = existingDiscordUser(test, 'owner');
        const g = guest(test, 'second-device');
        const guestId = g.userId;
        requestCode(test, g);
        linkByCode(test, codeOf(test, g), providerId, 'ignored');

        expect(test.db.UserIdentity.identity.find(g.identity)!.userId).toBe(owner.userId);
        expect(test.db.UserPresence.identity.find(g.identity)?.userId).toBe(owner.userId);
        expect(userRow(test, guestId)).toBeFalsy();
        expect(identitiesOf(test, owner.userId)).toHaveLength(2);
        expect(userRow(test, owner.userId)).toMatchObject({ isGuest: false, providerId });
        expect(linkRows(test)).toHaveLength(0);
    });

    it('a code whose guest was linked another way since is refused (account changed); the account is unchanged', () => {
        const test = newHarness();
        const g = guest(test, 'raced');
        requestCode(test, g);
        const code = codeOf(test, g);
        linkDiscord(test, g, 'pid-first', 'First'); // server_link_provider by identity hex, after the code was issued
        const msg = rejection(test, 'internal', (ctx) => M.server_link_by_code(ctx, { linkCode: code, provider: 'discord', providerId: '100000000000000010', providerName: 'Second' }));
        expect(userRow(test, g.userId)).toMatchObject({ isGuest: false, providerId: 'pid-first', providerUsername: 'First' });
        expect(linkRows(test).map((r) => r.code)).toEqual([code]);
        expect(msg).toBe(ACCOUNT_CHANGED_TEXT);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Clean-up of stale codes
// ════════════════════════════════════════════════════════════════════════════

describe('link code clean-up (M5a)', () => {
    it('request_link_code deletes expired rows among the rows it examines, and leaves live rows', () => {
        const test = newHarness();
        const live = [1, 2, 3].map((i) => insertRequest(test, `live-${i}`, 60_000));
        const expired = [1, 2, 3].map((i) => insertRequest(test, `expired-${i}`, -1));
        const g = guest(test, 'sweeper');
        requestCode(test, g);
        const codes = linkRows(test).map((r) => r.code);
        expect(codes).toEqual(expect.arrayContaining([...live, codeOf(test, g)]));
        for (const c of expired) expect(codes).not.toContain(c);
        expect(codes).toHaveLength(4);
    });

    it(`the inline sweep examines at most ${LINK_SWEEP_SCAN_LIMIT} rows per call; the next calls take the rest`, () => {
        const test = newHarness();
        const total = LINK_SWEEP_SCAN_LIMIT + 36;
        for (let i = 0; i < total; i++) insertRequest(test, `stale-${i}`, -1_000);
        const first = guest(test, 'first');
        requestCode(test, first);
        expect(linkRows(test).filter((r) => r.code.startsWith('direct-'))).toHaveLength(total - LINK_SWEEP_SCAN_LIMIT);
        const second = guest(test, 'second');
        requestCode(test, second);
        expect(linkRows(test).filter((r) => r.code.startsWith('direct-'))).toHaveLength(0);
        expect(linkRows(test)).toHaveLength(2);
    });

    it('the scheduled identity GC sweeps the stale rows the inline sweep did not reach and keeps live ones', () => {
        const test = newHarness();
        for (let i = 0; i < LINK_SWEEP_SCAN_LIMIT * 2; i++) insertRequest(test, `old-${i}`, -1_000);
        const keep = insertRequest(test, 'still-live', 60_000);
        tx(test, 'internal', (ctx) => M.run_identity_gc(ctx, { arg: { scheduledId: 1n, scheduledAt: ScheduleAt.time(now(test)) } }));
        expect(linkRows(test).map((r) => r.code)).toEqual([keep]);
    });

    it('a user deletion removes the user\'s code (delete_my_account, guest; and the admin deletion job)', () => {
        const test = newHarness();
        const self = guest(test, 'self-delete');
        requestCode(test, self);
        tx(test, self, (ctx) => M.delete_my_account(ctx, {}));
        expect(linkRows(test)).toHaveLength(0);

        const boss = admin(test);
        const g = guest(test, 'admin-deleted');
        requestCode(test, g);
        tx(test, boss, (ctx) => M.admin_delete_row(ctx, { tableName: 'User', primaryKeyJson: String(g.userId) }));
        expect(linkRows(test)).toHaveLength(1);
        fireDeletionJob(test, g.userId);
        expect(linkRows(test)).toHaveLength(0);
    });

    it('server_nuke_test_data clears every link code', () => {
        const test = newHarness();
        requestCode(test, guest(test, 'nuked'));
        insertRequest(test, 'other', 60_000);
        expect(linkRows(test)).toHaveLength(2);
        tx(test, 'internal', (ctx) => M.server_nuke_test_data(onTestDatabase(ctx), { confirmation: 'NUKE_TEST_DATA' }));
        expect(linkRows(test)).toHaveLength(0);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Review fix pass (M5a): account-changed branches, the Discord id rule, the provider name clean-up, the code layout
// ════════════════════════════════════════════════════════════════════════════

describe('M5a review fix pass', () => {
    it('account changed: the identity was re-pointed to another user while the old guest lives on through a second identity', () => {
        const test = newHarness();
        const { providerId } = existingDiscordUser(test, 'owner');
        const g = guest(test, 'two-devices');
        const guestId = g.userId;
        addSecondIdentity(test, guestId, 'two-devices-b');
        requestCode(test, g);
        const code = codeOf(test, g);
        linkDiscord(test, g, providerId, 'ignored'); // server_link_provider Case 1b: re-pointed, the guest is kept
        expect(userRow(test, guestId)).toBeTruthy();

        const msg = rejection(test, 'internal', (ctx) => M.server_link_by_code(ctx, { linkCode: code, provider: 'discord', providerId: '200000000000000001', providerName: 'Other' }));
        expect(userRow(test, guestId)).toMatchObject({ isGuest: true, loginMethod: undefined });
        expect(linkRows(test).map((r) => r.code)).toEqual([code]);
        expect(msg).toBe(ACCOUNT_CHANGED_TEXT);
    });

    it('account changed: the requester was soft-deleted after the request (deletedAt set, the cascade pending)', () => {
        const test = newHarness();
        const boss = admin(test);
        const g = guest(test, 'leaving-later');
        requestCode(test, g);
        const code = codeOf(test, g);
        tx(test, boss, (ctx) => M.admin_delete_row(ctx, { tableName: 'User', primaryKeyJson: String(g.userId) }));

        const msg = rejection(test, 'internal', (ctx) => M.server_link_by_code(ctx, { linkCode: code, provider: 'discord', providerId: '200000000000000002', providerName: 'Late' }));
        expect(userRow(test, g.userId)).toMatchObject({ isGuest: true, loginMethod: undefined });
        expect(userRow(test, g.userId)!.deletedAt).toBeDefined();
        expect(msg).toBe(ACCOUNT_CHANGED_TEXT);
    });

    it.each([
        ['too short (16 digits)', '1'.repeat(16)],
        ['too long (21 digits)', '1'.repeat(21)],
        ['a letter', '1234567890123456a'],
        ['a leading space', ' 12345678901234567'],
        ['a test-style id', 'pid-someone'],
    ])('server_link_by_code refuses a Discord providerId that is %s; nothing changes and the code stays live', (_label, providerId) => {
        const test = newHarness();
        const g = guest(test, 'id-shape');
        requestCode(test, g);
        const code = codeOf(test, g);
        const msg = rejection(test, 'internal', (ctx) => M.server_link_by_code(ctx, { linkCode: code, provider: 'discord', providerId, providerName: 'Shape' }));
        expect(userRow(test, g.userId)!.isGuest).toBe(true);
        expect(codeOf(test, g)).toBe(code);
        expect(msg).toBe(NOT_A_DISCORD_ID_TEXT);
    });

    it('server_link_by_code accepts Discord ids of 17 and 20 digits; the id rule runs before the code lookup', () => {
        const test = newHarness();
        for (const providerId of ['1'.repeat(17), '9'.repeat(20)]) {
            const g = guest(test, `id-${providerId.length}`);
            requestCode(test, g);
            linkByCode(test, codeOf(test, g), providerId, `Len${providerId.length}`);
            expect(userRow(test, g.userId)).toMatchObject({ isGuest: false, providerId });
        }
        const msg = rejection(test, 'internal', (ctx) => M.server_link_by_code(ctx, { linkCode: 'no-such-code', provider: 'discord', providerId: 'bad', providerName: 'X' }));
        expect(msg).toBe(NOT_A_DISCORD_ID_TEXT);
    });

    it('the provider name loses C0 / C1 control characters before the trim and the empty check, and is cut on a code point boundary', () => {
        const test = newHarness();
        const g = guest(test, 'controls');
        requestCode(test, g);
        linkByCode(test, codeOf(test, g), '300000000000000001', ' \u0007Na\u0000me\u0085\u001F\u007F ');
        expect(userRow(test, g.userId)).toMatchObject({ displayName: 'Name', providerUsername: 'Name' });

        const blank = guest(test, 'only-controls');
        requestCode(test, blank);
        const code = codeOf(test, blank);
        const msg = rejection(test, 'internal', (ctx) => M.server_link_by_code(ctx, { linkCode: code, provider: 'discord', providerId: '300000000000000002', providerName: ' \u0001\u009F ' }));
        expect(msg).toBe('providerName is required');

        const emoji = guest(test, 'emoji');
        requestCode(test, emoji);
        const name = 'a'.repeat(31) + '\u{1F600}'; // the pair sits at units 31-32: a 32-unit cut would split it
        linkByCode(test, codeOf(test, emoji), '300000000000000003', name);
        expect(userRow(test, emoji.userId)!.providerUsername).toBe('a'.repeat(31));
        expect(capOnCodePoint('ab\u{1F600}', 3)).toBe('ab');
        expect(capOnCodePoint('ab\u{1F600}', 4)).toBe('ab\u{1F600}');
        expect(capOnCodePoint('abcd', 3)).toBe('abc');
    });

    const nonceOf = (c: string) => c.repeat(CLIENT_NONCE_LENGTH);
    const fixedCtx = (o: { sender: any; conn?: number; micros?: bigint; taken?: Set<string> }) => ({
        sender: o.sender,
        connectionId: o.conn === undefined ? null : { toUint8Array: () => new Uint8Array(16).fill(o.conn!) },
        timestamp: new Timestamp(o.micros ?? 1_700_000_000_000_000n),
        db: { LinkRequest: { code: { find: (code: string) => (o.taken?.has(code) ? { code } : undefined) } } },
    });

    it('generateLinkCode: changing one input at a time (identity, connection id, timestamp, previous code, attempt) changes the code', () => {
        const test = newHarness();
        const a = guest(test, 'layout-a').identity;
        const b = guest(test, 'layout-b').identity;
        const base = generateLinkCode(fixedCtx({ sender: a, conn: 1 }), undefined, nonceOf('n'));
        const variants = [
            generateLinkCode(fixedCtx({ sender: b, conn: 1 }), undefined, nonceOf('n')),
            generateLinkCode(fixedCtx({ sender: a, conn: 2 }), undefined, nonceOf('n')),
            generateLinkCode(fixedCtx({ sender: a, conn: 1, micros: 1_700_000_000_000_001n }), undefined, nonceOf('n')),
            generateLinkCode(fixedCtx({ sender: a, conn: 1 }), 'P'.repeat(LINK_CODE_LENGTH), nonceOf('n')),
            generateLinkCode(fixedCtx({ sender: a, conn: 1, taken: new Set([base]) }), undefined, nonceOf('n')), // attempt 1
        ];
        expect(generateLinkCode(fixedCtx({ sender: a, conn: 1 }), undefined, nonceOf('n'))).toBe(base);
        expect(new Set([base, ...variants]).size).toBe(6);
    });

    it('generateLinkCode matches a digest recomputed with the runtime\'s own SHA-256 (Web Crypto) from the documented byte layout', async () => {
        // The module tsconfig has no Node types, so the platform digest is reached through globalThis (Node's Web Crypto).
        const platform = (globalThis as any).crypto.subtle;
        const toBase64Url = (bytes: Uint8Array) => (globalThis as any).btoa(String.fromCharCode(...bytes))
            .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        const ascii = (str: string) => Uint8Array.from(str, (c) => c.charCodeAt(0));
        const join = (parts: Uint8Array[]) => {
            const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
            let off = 0;
            for (const x of parts) { out.set(x, off); off += x.length; }
            return out;
        };

        const test = newHarness();
        const sender = guest(test, 'layout').identity;
        const micros = 1_700_000_000_123_456n;
        const previous = 'Q'.repeat(LINK_CODE_LENGTH);
        const ts = new Uint8Array(8);
        new DataView(ts.buffer).setBigUint64(0, micros, true); // little-endian
        const expected = async (attempt: number, conn: Uint8Array) => {
            const input = join([ascii('hsr-link-code/v1'), ascii(nonceOf('z')), sender.toUint8Array(), conn, ts, ascii(previous), new Uint8Array([attempt])]);
            expect(input.length).toBe(16 + 43 + 32 + 16 + 8 + 32 + 1); // 148 bytes with a previous code
            const digest = new Uint8Array(await platform.digest('SHA-256', input));
            return toBase64Url(digest.subarray(0, 24));
        };

        const withConn = generateLinkCode(fixedCtx({ sender, conn: 5, micros }), previous, nonceOf('z'));
        expect(withConn).toBe(await expected(0, new Uint8Array(16).fill(5)));
        expect(withConn).toHaveLength(LINK_CODE_LENGTH);
        const noConn = generateLinkCode(fixedCtx({ sender, micros }), previous, nonceOf('z'));
        expect(noConn).toBe(await expected(0, new Uint8Array(16)));
        const retried = generateLinkCode(fixedCtx({ sender, conn: 5, micros, taken: new Set([withConn]) }), previous, nonceOf('z'));
        expect(retried).toBe(await expected(1, new Uint8Array(16).fill(5)));
    });
});
