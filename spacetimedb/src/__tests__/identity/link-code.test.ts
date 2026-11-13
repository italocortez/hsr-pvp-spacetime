// Identity: the one-time link codes of the Discord sign-in (M5a) and the second lock (M5a2): request_link_code,
// view_my_link_request, server_link_by_code (presentation), confirm_link, the clean-up of stale rows.
// Decisions: A44(3), A46, A77, A94, A113(4)
// Contracts: docs/auth/contract.md (entries proposed in the M5a hand-back)
// T-M5a (new file), T-M5a2 (presentation and confirmation; the M5a direct-merge-by-code tests adapted).
//
// Everything runs in the SDK's in-memory datastore; server reducers run as the owner identity ('internal', registered by
// init). `test.db` is read only outside `tx` bodies. Nothing reaches maincloud.
import { describe, expect, it } from 'vitest';
import { ScheduleAt, Timestamp } from 'spacetimedb';
import {
    ACCOUNT_CHANGED_TEXT,
    CLIENT_NONCE_INVALID_TEXT,
    CLIENT_NONCE_LENGTH,
    CONFIRM_HASH_INVALID_TEXT,
    CONFIRM_REFUSED_TEXT,
    CONFIRM_TOKEN_INVALID_TEXT,
    LINK_CODE_LENGTH,
    LINK_CODE_REFUSED_TEXT,
    LINK_SWEEP_SCAN_LIMIT,
    NO_PENDING_LINK_TEXT,
    NOT_A_DISCORD_ID_TEXT,
    confirmHashOf,
    decodeBase64Url32,
    encodeBase64Url,
    generateLinkCode,
    sha256,
} from '@module/helpers/identity/linkCode';
import { capOnCodePoint, FINISH_GAME_BEFORE_SIGN_IN_TEXT } from '@module/helpers/identity/providerLink';
import { MAINTENANCE_TEXT } from '@module/helpers/identity/ensurePermissions';
import { ABUSE_CONFIG_ID } from '@module/helpers/lobby/abuseControls';
import {
    AUDIT,
    M,
    SYSTEM_USER_ID,
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
const BANNED_TEXT = 'This discord account is banned and cannot be linked.';
const TWO_MINUTES_MICROS = 2n * 60n * 1_000_000n;
/** The view's columns: never confirmHash, never pendingProviderId. */
const VIEW_KEYS = ['awaitingConfirm', 'code', 'expiresAt', 'pendingProviderName'];
/** A guest 'g' seated as a Blue player; setupLobby starts the draft (Drafting). */
const SEATED_G: Array<[string, 'BluePlayer' | 'RedPlayer']> = [['g', 'BluePlayer'], ['b2', 'BluePlayer'], ['r1', 'RedPlayer'], ['r2', 'RedPlayer']];

/** Confirm tokens: 32 bytes in canonical base64url (what the auth function hands to the browser). */
const tokenOf = (seed: number) => encodeBase64Url(new Uint8Array(32).map((_, i) => (seed * 31 + i * 7) & 0xff));
const TOKEN_A = tokenOf(1);
const TOKEN_B = tokenOf(2);
const ZERO_TOKEN = encodeBase64Url(new Uint8Array(32));
const jsonOf = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));

let nonceCounter = 0;
/** A well-formed client nonce (43 base64url characters), different on every call. */
const nextNonce = () => `nonce${nonceCounter++}_`.padEnd(43, 'Q');

const requestCode = (test: Harness, a: Actor) => tx(test, a, (ctx) => M.request_link_code(ctx, { clientNonce: nextNonce() }));
type ViewRow = { code?: string; expiresAt: Timestamp; awaitingConfirm: boolean; pendingProviderName?: string };
const myRequest = (test: Harness, a: Actor) => view<ViewRow>(test, 'view_my_link_request', a);
/** The caller's live code, read through the view (only before the presentation). */
const codeOf = (test: Harness, a: Actor): string => {
    const rows = myRequest(test, a);
    expect(rows).toHaveLength(1);
    expect(rows[0].code).toBeDefined();
    return rows[0].code!;
};
const presentArgs = (linkCode: string, providerId: string, providerName: string, token: string, provider = 'discord') =>
    ({ linkCode, provider, providerId, providerName, confirmHash: confirmHashOf(token) });
/** The auth function's call: presents the code with the Discord account and the hash of the confirm token. */
const present = (test: Harness, linkCode: string, providerId: string, providerName: string, token: string) =>
    tx(test, 'internal', (ctx) => M.server_link_by_code(ctx, presentArgs(linkCode, providerId, providerName, token)));
/** The requesting browser's call with the confirm token. */
const confirm = (test: Harness, a: Actor, confirmToken: string) => tx(test, a, (ctx) => M.confirm_link(ctx, { confirmToken }));
/** The whole sign-in: request, present, confirm. */
let tokenSeed = 100;
function fullLink(test: Harness, a: Actor, providerId: string, providerName: string) {
    const token = tokenOf(tokenSeed++);
    requestCode(test, a);
    present(test, codeOf(test, a), providerId, providerName, token);
    confirm(test, a, token);
}
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
        pendingProvider: undefined,
        pendingProviderId: undefined,
        pendingProviderName: undefined,
        confirmHash: undefined,
    } as any);
    return code;
}

// ════════════════════════════════════════════════════════════════════════════
// request_link_code and view_my_link_request
// ════════════════════════════════════════════════════════════════════════════

describe('request_link_code and view_my_link_request (M5a)', () => {
    it('a guest gets a code it reads in view_my_link_request (5 minutes out, not awaiting confirmation); another identity sees nothing', () => {
        const test = newHarness();
        const g = guest(test, 'asker');
        const other = guest(test, 'other');
        requestCode(test, g);

        const rows = myRequest(test, g);
        expect(rows).toHaveLength(1);
        expect(Object.keys(rows[0]).sort()).toEqual(VIEW_KEYS);
        expect(rows[0]).toMatchObject({ awaitingConfirm: false, pendingProviderName: undefined });
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
        const msg = rejection(test, 'internal', (ctx) => M.server_link_by_code(ctx, presentArgs(first, '100000000000000001', 'Twice', TOKEN_A)));
        expect(userRow(test, g.userId)).toMatchObject({ isGuest: true, loginMethod: undefined });
        expect(msg).toBe(LINK_CODE_REFUSED_TEXT);
        present(test, second, '100000000000000001', 'Twice', TOKEN_A);
        confirm(test, g, TOKEN_A);
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
// server_link_by_code: the presentation (M5a2: it no longer links)
// ════════════════════════════════════════════════════════════════════════════

describe('server_link_by_code: presentation (M5a2)', () => {
    it('a caller that is not a registered server identity is refused, even an Admin; the code stays live', () => {
        const test = newHarness();
        const boss = admin(test);
        const g = guest(test, 'victim');
        requestCode(test, g);
        const code = codeOf(test, g);
        for (const who of [boss, g]) {
            const msg = rejection(test, who, (ctx) => M.server_link_by_code(ctx, presentArgs(code, '100000000000000002', 'Steal', TOKEN_A)));
            expect(msg).toBe(FORBIDDEN);
        }
        expect(userRow(test, g.userId)!.isGuest).toBe(true);
        expect(codeOf(test, g)).toBe(code);
    });

    it('a presentation records the pending account and nothing else: usedAt now, a 2-minute window, the cleaned name, the hash; User unchanged', () => {
        const test = newHarness();
        const g = guest(test, 'presented');
        requestCode(test, g);
        const code = codeOf(test, g);
        const userBefore = userRow(test, g.userId);
        present(test, code, '100000000000000003', '  Fresh\u0007Name ', TOKEN_A);

        const [row] = linkRows(test);
        expect(row).toMatchObject({ code, identity: g.identity, userId: g.userId, pendingProvider: 'discord',
            pendingProviderId: '100000000000000003', pendingProviderName: 'FreshName', confirmHash: confirmHashOf(TOKEN_A),
            lastModifiedById: SYSTEM_USER_ID });
        expect(row.usedAt?.microsSinceUnixEpoch).toBe(now(test));
        expect(row.expiresAt.microsSinceUnixEpoch).toBe(now(test) + TWO_MINUTES_MICROS);
        expect(userRow(test, g.userId)).toEqual(userBefore);

        const [v] = myRequest(test, g);
        expect(Object.keys(v).sort()).toEqual(VIEW_KEYS);
        expect(v).toMatchObject({ code: undefined, awaitingConfirm: true, pendingProviderName: 'FreshName' });
        expect(v.expiresAt.microsSinceUnixEpoch).toBe(now(test) + TWO_MINUTES_MICROS);
        expect(jsonOf(v)).not.toContain('100000000000000003');
        expect(jsonOf(v)).not.toContain(confirmHashOf(TOKEN_A));
    });

    it('one presentation per code: a second presentation is refused with the common text and the first stays', () => {
        const test = newHarness();
        const g = guest(test, 'twice-presented');
        requestCode(test, g);
        const code = codeOf(test, g);
        present(test, code, '100000000000000004', 'First', TOKEN_A);
        const before = jsonOf(linkRows(test));
        const msg = rejection(test, 'internal', (ctx) => M.server_link_by_code(ctx, presentArgs(code, '100000000000000005', 'Second', TOKEN_B)));
        expect(jsonOf(linkRows(test))).toBe(before);
        expect(msg).toBe(LINK_CODE_REFUSED_TEXT);
    });

    it('an expired code is refused (5 minutes after the request); one millisecond earlier it is presented', () => {
        const test = newHarness();
        const late = guest(test, 'late');
        const onTime = guest(test, 'on-time');
        requestCode(test, late);
        requestCode(test, onTime);
        const lateCode = codeOf(test, late);
        const onTimeCode = codeOf(test, onTime);

        advance(test, FIVE_MINUTES_MS - 1);
        present(test, onTimeCode, '100000000000000006', 'OnTime', TOKEN_A);
        expect(myRequest(test, onTime)[0].awaitingConfirm).toBe(true);

        advance(test, 1);
        const msg = rejection(test, 'internal', (ctx) => M.server_link_by_code(ctx, presentArgs(lateCode, '100000000000000007', 'Late', TOKEN_A)));
        expect(myRequest(test, late)[0].awaitingConfirm).toBe(false);
        expect(msg).toBe(LINK_CODE_REFUSED_TEXT);
    });

    it('an unknown code and an empty code are refused with the same text as an expired or presented one', () => {
        const test = newHarness();
        const g = guest(test, 'bystander');
        requestCode(test, g);
        for (const linkCode of ['no-such-code', '', 'x'.repeat(LINK_CODE_LENGTH)]) {
            const msg = rejection(test, 'internal', (ctx) => M.server_link_by_code(ctx, presentArgs(linkCode, '100000000000000008', 'X', TOKEN_A)));
            expect(msg).toBe(LINK_CODE_REFUSED_TEXT);
        }
        expect(myRequest(test, g)[0].awaitingConfirm).toBe(false);
    });

    it.each([
        ['too short (16 digits)', '1'.repeat(16)],
        ['too long (21 digits)', '1'.repeat(21)],
        ['a letter', '1234567890123456a'],
        ['a leading space', ' 12345678901234567'],
        ['a test-style id', 'pid-someone'],
        ['empty', ''],
    ])('a Discord providerId that is %s is refused before the code is looked at; the code stays live', (_label, providerId) => {
        const test = newHarness();
        const g = guest(test, 'id-shape');
        requestCode(test, g);
        const code = codeOf(test, g);
        const msg = rejection(test, 'internal', (ctx) => M.server_link_by_code(ctx, presentArgs(code, providerId, 'Shape', TOKEN_A)));
        expect(myRequest(test, g)[0]).toMatchObject({ code, awaitingConfirm: false });
        expect(msg).toBe(NOT_A_DISCORD_ID_TEXT);
        const unknown = rejection(test, 'internal', (ctx) => M.server_link_by_code(ctx, presentArgs('no-such-code', providerId, 'Shape', TOKEN_A)));
        expect(unknown).toBe(NOT_A_DISCORD_ID_TEXT);
    });

    it('Discord ids of 17 and 20 digits are accepted and link through confirm_link', () => {
        const test = newHarness();
        for (const providerId of ['1'.repeat(17), '9'.repeat(20)]) {
            const g = guest(test, `id-${providerId.length}`);
            fullLink(test, g, providerId, `Len${providerId.length}`);
            expect(userRow(test, g.userId)).toMatchObject({ isGuest: false, providerId });
        }
    });

    it.each([
        ['empty', ''],
        ['42 characters', 'A'.repeat(42)],
        ['44 characters', 'A'.repeat(44)],
        ['a non-canonical last character', 'A'.repeat(42) + 'B'],
        ['a standard base64 character', 'A'.repeat(41) + '+A'],
        ['padding', 'A'.repeat(42) + '='],
    ])('a confirmHash that is %s is refused before the code is looked at; the code stays live', (_label, confirmHash) => {
        const test = newHarness();
        const g = guest(test, 'hash-shape');
        requestCode(test, g);
        const code = codeOf(test, g);
        const msg = rejection(test, 'internal', (ctx) => M.server_link_by_code(ctx, { linkCode: code, provider: 'discord', providerId: '100000000000000009', providerName: 'H', confirmHash }));
        expect(myRequest(test, g)[0]).toMatchObject({ code, awaitingConfirm: false });
        expect(msg).toBe(CONFIRM_HASH_INVALID_TEXT);
    });

    it('a banned Discord id is refused at presentation with the ban text; the code stays live; after the unban it is presented and links', () => {
        const test = newHarness();
        const boss = admin(test);
        const pid = '100000000000000010';
        tx(test, boss, (ctx) => M.admin_ban_user(ctx, { banTypeTag: 'DiscordId', providerId: pid, reason: 'abuse' }));
        const g = guest(test, 'wannabe');
        requestCode(test, g);
        const code = codeOf(test, g);

        const msg = rejection(test, 'internal', (ctx) => M.server_link_by_code(ctx, presentArgs(code, pid, 'Wannabe', TOKEN_A)));
        expect(myRequest(test, g)[0]).toMatchObject({ code, awaitingConfirm: false });
        expect(msg).toBe(BANNED_TEXT);

        const banId = [...test.db.BanRecord.iter()][0].id;
        tx(test, boss, (ctx) => M.admin_unban_user(ctx, { banRecordId: banId }));
        present(test, code, pid, 'Wannabe', TOKEN_A);
        confirm(test, g, TOKEN_A);
        expect(userRow(test, g.userId)).toMatchObject({ isGuest: false, providerId: pid });
    });

    it.each([
        ['a blank providerName', { providerName: ' \u0001\u009F ' }, 'providerName is required'],
        ['an unknown provider', { provider: 'facebook' }, 'Invalid provider "facebook". Must be one of: discord'],
    ])('input validation at presentation: %s is refused with its own text; the code stays live', (_label, over, text) => {
        const test = newHarness();
        const g = guest(test, 'val');
        requestCode(test, g);
        const code = codeOf(test, g);
        const msg = rejection(test, 'internal', (ctx) => M.server_link_by_code(ctx, { ...presentArgs(code, '100000000000000011', 'Val', TOKEN_A), ...over }));
        expect(myRequest(test, g)[0]).toMatchObject({ code, awaitingConfirm: false });
        expect(msg).toBe(text);
    });

    it('A113(4) at presentation: a guest seated as a player in a Drafting lobby is refused with the live-game text; the code stays live', () => {
        const test = newHarness();
        const { providerId } = existingDiscordUser(test, 'owner');
        const g = guest(test, 'g');
        const s = setupLobby(test, { seats: SEATED_G, actors: { g } });
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('Drafting');
        requestCode(test, g);
        const code = codeOf(test, g);

        const msg = rejection(test, 'internal', (ctx) => M.server_link_by_code(ctx, presentArgs(code, providerId, 'ignored', TOKEN_A)));
        expect(test.db.UserIdentity.identity.find(g.identity)!.userId).toBe(g.userId);
        expect(myRequest(test, g)[0]).toMatchObject({ code, awaitingConfirm: false });
        expect(msg).toBe(FINISH_GAME_BEFORE_SIGN_IN_TEXT);
    });

    it('account changed at presentation: linked another way since the request', () => {
        const test = newHarness();
        const g = guest(test, 'raced');
        requestCode(test, g);
        const code = codeOf(test, g);
        linkDiscord(test, g, 'pid-first', 'First'); // server_link_provider by identity hex, after the code was issued
        const msg = rejection(test, 'internal', (ctx) => M.server_link_by_code(ctx, presentArgs(code, '100000000000000012', 'Second', TOKEN_A)));
        expect(userRow(test, g.userId)).toMatchObject({ isGuest: false, providerId: 'pid-first' });
        expect(linkRows(test).map((r) => r.code)).toEqual([code]);
        expect(msg).toBe(ACCOUNT_CHANGED_TEXT);
    });

    it('account changed at presentation: the identity was re-pointed to another user while the old guest lives on through a second identity', () => {
        const test = newHarness();
        const { providerId } = existingDiscordUser(test, 'owner');
        const g = guest(test, 'two-devices');
        const guestId = g.userId;
        addSecondIdentity(test, guestId, 'two-devices-b');
        requestCode(test, g);
        const code = codeOf(test, g);
        linkDiscord(test, g, providerId, 'ignored'); // server_link_provider Case 1b: re-pointed, the guest is kept
        expect(userRow(test, guestId)).toBeTruthy();

        const msg = rejection(test, 'internal', (ctx) => M.server_link_by_code(ctx, presentArgs(code, '100000000000000013', 'Other', TOKEN_A)));
        expect(userRow(test, guestId)).toMatchObject({ isGuest: true, loginMethod: undefined });
        expect(linkRows(test).map((r) => r.code)).toEqual([code]);
        expect(msg).toBe(ACCOUNT_CHANGED_TEXT);
    });

    it('account changed at presentation: the requester was soft-deleted after the request (deletedAt set, the cascade pending)', () => {
        const test = newHarness();
        const boss = admin(test);
        const g = guest(test, 'leaving-later');
        requestCode(test, g);
        const code = codeOf(test, g);
        tx(test, boss, (ctx) => M.admin_delete_row(ctx, { tableName: 'User', primaryKeyJson: String(g.userId) }));
        const msg = rejection(test, 'internal', (ctx) => M.server_link_by_code(ctx, presentArgs(code, '100000000000000014', 'Late', TOKEN_A)));
        expect(userRow(test, g.userId)!.deletedAt).toBeDefined();
        expect(msg).toBe(ACCOUNT_CHANGED_TEXT);
    });

    it('the stored name is cut on a code point boundary', () => {
        const test = newHarness();
        const g = guest(test, 'emoji');
        requestCode(test, g);
        present(test, codeOf(test, g), '100000000000000015', 'a'.repeat(31) + '\u{1F600}', TOKEN_A);
        expect(myRequest(test, g)[0].pendingProviderName).toBe('a'.repeat(31));
        expect(capOnCodePoint('ab\u{1F600}', 3)).toBe('ab');
        expect(capOnCodePoint('ab\u{1F600}', 4)).toBe('ab\u{1F600}');
        expect(capOnCodePoint('abcd', 3)).toBe('abc');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// confirm_link (M5a2)
// ════════════════════════════════════════════════════════════════════════════

describe('confirm_link (M5a2)', () => {
    it('full happy path: request, present, the view shows the pending name, confirm upgrades the guest (Case 1a), the row is gone', () => {
        const test = newHarness();
        const g = guest(test, 'fresh');
        requestCode(test, g);
        present(test, codeOf(test, g), '100000000000000020', 'FreshName', TOKEN_A);
        expect(myRequest(test, g)[0]).toMatchObject({ awaitingConfirm: true, pendingProviderName: 'FreshName' });
        expect(userRow(test, g.userId)!.isGuest).toBe(true);

        confirm(test, g, TOKEN_A);
        expect(userRow(test, g.userId)).toMatchObject({ isGuest: false, username: 'FreshName', displayName: 'FreshName',
            loginMethod: 'discord', providerId: '100000000000000020', providerUsername: 'FreshName' });
        expect(userRow(test, g.userId)!.linkedAt?.microsSinceUnixEpoch).toBe(now(test));
        expect(linkRows(test)).toHaveLength(0);
        expect(myRequest(test, g)).toEqual([]);
        const again = rejection(test, g, (ctx) => M.confirm_link(ctx, { confirmToken: TOKEN_A }));
        expect(again).toBe(NO_PENDING_LINK_TEXT);
    });

    it('another identity holding the right token is refused (no row, or its own row with another hash); the requester\'s row is untouched and still confirms', () => {
        const test = newHarness();
        const g = guest(test, 'requester');
        const thief = guest(test, 'thief');
        const thiefWithRow = guest(test, 'thief-with-row');
        requestCode(test, g);
        present(test, codeOf(test, g), '100000000000000021', 'Victim', TOKEN_A);
        requestCode(test, thiefWithRow);
        present(test, codeOf(test, thiefWithRow), '100000000000000022', 'Thief', TOKEN_B);
        const before = jsonOf(test.db.LinkRequest.identity.find(g.identity));

        expect(rejection(test, thief, (ctx) => M.confirm_link(ctx, { confirmToken: TOKEN_A }))).toBe(NO_PENDING_LINK_TEXT);
        expect(rejection(test, thiefWithRow, (ctx) => M.confirm_link(ctx, { confirmToken: TOKEN_A }))).toBe(CONFIRM_REFUSED_TEXT);
        expect(userRow(test, thief.userId)!.isGuest).toBe(true);
        expect(userRow(test, thiefWithRow.userId)!.isGuest).toBe(true);
        expect(jsonOf(test.db.LinkRequest.identity.find(g.identity))).toBe(before);

        confirm(test, g, TOKEN_A);
        expect(userRow(test, g.userId)).toMatchObject({ isGuest: false, providerId: '100000000000000021' });
    });

    it('a wrong token is refused and burns nothing: the right token still works afterwards', () => {
        const test = newHarness();
        const g = guest(test, 'fumble');
        requestCode(test, g);
        present(test, codeOf(test, g), '100000000000000023', 'Fumble', TOKEN_A);
        for (let i = 0; i < 3; i++) {
            expect(rejection(test, g, (ctx) => M.confirm_link(ctx, { confirmToken: TOKEN_B }))).toBe(CONFIRM_REFUSED_TEXT);
        }
        expect(myRequest(test, g)[0].awaitingConfirm).toBe(true);
        confirm(test, g, TOKEN_A);
        expect(userRow(test, g.userId)!.isGuest).toBe(false);
    });

    it('confirm before the presentation is refused; the code stays live', () => {
        const test = newHarness();
        const g = guest(test, 'early');
        requestCode(test, g);
        const code = codeOf(test, g);
        expect(rejection(test, g, (ctx) => M.confirm_link(ctx, { confirmToken: TOKEN_A }))).toBe(NO_PENDING_LINK_TEXT);
        expect(myRequest(test, g)[0]).toMatchObject({ code, awaitingConfirm: false });
    });

    it('confirm after the 2-minute window is refused; one millisecond earlier it links', () => {
        const test = newHarness();
        const slow = guest(test, 'slow');
        const quick = guest(test, 'quick');
        requestCode(test, slow);
        requestCode(test, quick);
        present(test, codeOf(test, slow), '100000000000000024', 'Slow', TOKEN_A);
        present(test, codeOf(test, quick), '100000000000000025', 'Quick', TOKEN_B);
        advance(test, 2 * 60_000 - 1);
        confirm(test, quick, TOKEN_B);
        expect(userRow(test, quick.userId)!.isGuest).toBe(false);
        advance(test, 1);
        expect(rejection(test, slow, (ctx) => M.confirm_link(ctx, { confirmToken: TOKEN_A }))).toBe(NO_PENDING_LINK_TEXT);
        expect(userRow(test, slow.userId)!.isGuest).toBe(true);
    });

    it.each([
        ['empty', ''],
        ['42 characters', 'A'.repeat(42)],
        ['44 characters', 'A'.repeat(44)],
        ['a non-canonical last character', 'A'.repeat(42) + 'B'],
        ['a standard base64 character', '/' + 'A'.repeat(42)],
    ])('a confirmToken that is %s is refused', (_label, confirmToken) => {
        const test = newHarness();
        const g = guest(test, 'token-shape');
        requestCode(test, g);
        present(test, codeOf(test, g), '100000000000000026', 'Shape', TOKEN_A);
        expect(rejection(test, g, (ctx) => M.confirm_link(ctx, { confirmToken }))).toBe(CONFIRM_TOKEN_INVALID_TEXT);
        expect(myRequest(test, g)[0].awaitingConfirm).toBe(true);
    });

    it('a ban between presentation and confirm: confirm is refused with the ban text and the row stays', () => {
        const test = newHarness();
        const boss = admin(test);
        const pid = '100000000000000027';
        const g = guest(test, 'banned-late');
        requestCode(test, g);
        present(test, codeOf(test, g), pid, 'Late', TOKEN_A);
        tx(test, boss, (ctx) => M.admin_ban_user(ctx, { banTypeTag: 'DiscordId', providerId: pid, reason: 'abuse' }));
        expect(rejection(test, g, (ctx) => M.confirm_link(ctx, { confirmToken: TOKEN_A }))).toBe(BANNED_TEXT);
        expect(userRow(test, g.userId)!.isGuest).toBe(true);
        expect(myRequest(test, g)[0].awaitingConfirm).toBe(true);
    });

    it('A113(4) between presentation and confirm: a guest seated in a live game since is refused with the live-game text', () => {
        const test = newHarness();
        const { providerId } = existingDiscordUser(test, 'owner');
        const g = guest(test, 'g');
        requestCode(test, g);
        present(test, codeOf(test, g), providerId, 'ignored', TOKEN_A);
        setupLobby(test, { seats: SEATED_G, actors: { g } });
        expect(rejection(test, g, (ctx) => M.confirm_link(ctx, { confirmToken: TOKEN_A }))).toBe(FINISH_GAME_BEFORE_SIGN_IN_TEXT);
        expect(test.db.UserIdentity.identity.find(g.identity)!.userId).toBe(g.userId);
        expect(myRequest(test, g)[0].awaitingConfirm).toBe(true);
    });

    it('account changed between presentation and confirm: linked another way since, confirm is refused', () => {
        const test = newHarness();
        const g = guest(test, 'raced-late');
        requestCode(test, g);
        present(test, codeOf(test, g), '100000000000000028', 'Second', TOKEN_A);
        linkDiscord(test, g, 'pid-first', 'First');
        expect(rejection(test, g, (ctx) => M.confirm_link(ctx, { confirmToken: TOKEN_A }))).toBe(ACCOUNT_CHANGED_TEXT);
        expect(userRow(test, g.userId)).toMatchObject({ providerId: 'pid-first' });
    });

    it('a caller soft-deleted between presentation and confirm is refused with the deleted-account text', () => {
        const test = newHarness();
        const boss = admin(test);
        const g = guest(test, 'deleted-late');
        requestCode(test, g);
        present(test, codeOf(test, g), '100000000000000029', 'Gone', TOKEN_A);
        tx(test, boss, (ctx) => M.admin_delete_row(ctx, { tableName: 'User', primaryKeyJson: String(g.userId) }));
        expect(rejection(test, g, (ctx) => M.confirm_link(ctx, { confirmToken: TOKEN_A }))).toBe(DELETED);
    });

    it('maintenance mode refuses confirm for a guest; an identity with no user is refused', () => {
        const test = newHarness();
        const g = guest(test, 'maint');
        requestCode(test, g);
        present(test, codeOf(test, g), '100000000000000030', 'Maint', TOKEN_A);
        const config = test.db.AbuseConfig.id.find(ABUSE_CONFIG_ID)!;
        test.db.AbuseConfig.id.update({ ...config, maintenanceMode: true });
        expect(rejection(test, g, (ctx) => M.confirm_link(ctx, { confirmToken: TOKEN_A }))).toBe(MAINTENANCE_TEXT);
        test.db.AbuseConfig.id.update({ ...config, maintenanceMode: false });
        const { auth } = freshAuth(test, 'nobody');
        expect(rejection(test, { auth } as Actor, (ctx) => M.confirm_link(ctx, { confirmToken: TOKEN_A }))).toBe(NO_ACCOUNT);
        confirm(test, g, TOKEN_A);
        expect(userRow(test, g.userId)!.isGuest).toBe(false);
    });

    it('re-point through confirm: the Discord user already exists, the identity is re-pointed and the orphan guest deleted', () => {
        const test = newHarness();
        const { a: owner, providerId } = existingDiscordUser(test, 'owner');
        const g = guest(test, 'second-device');
        const guestId = g.userId;
        fullLink(test, g, providerId, 'ignored');
        expect(test.db.UserIdentity.identity.find(g.identity)!.userId).toBe(owner.userId);
        expect(test.db.UserPresence.identity.find(g.identity)?.userId).toBe(owner.userId);
        expect(userRow(test, guestId)).toBeFalsy();
        expect(identitiesOf(test, owner.userId)).toHaveLength(2);
        expect(linkRows(test)).toHaveLength(0);
    });

    it('a new request_link_code drops a pending row: the old token no longer works and the new row is not pending', () => {
        const test = newHarness();
        const g = guest(test, 'restart');
        requestCode(test, g);
        present(test, codeOf(test, g), '100000000000000031', 'Old', TOKEN_A);
        requestCode(test, g);
        const [row] = linkRows(test);
        expect(row).toMatchObject({ usedAt: undefined, pendingProvider: undefined, pendingProviderId: undefined,
            pendingProviderName: undefined, confirmHash: undefined });
        expect(myRequest(test, g)[0]).toMatchObject({ awaitingConfirm: false, pendingProviderName: undefined });
        expect(rejection(test, g, (ctx) => M.confirm_link(ctx, { confirmToken: TOKEN_A }))).toBe(NO_PENDING_LINK_TEXT);
    });

    it('the confirm hash is SHA-256 over the token\'s 32 decoded bytes in base64url: the documented vector, and Web Crypto agrees', async () => {
        expect(ZERO_TOKEN).toBe('A'.repeat(43));
        expect(confirmHashOf(ZERO_TOKEN)).toBe('Zmh6rfhivXdsj8GLjp-OIAiXFIVu4jOzkCpZHQ1fKSU');
        const platform = (globalThis as any).crypto.subtle;
        const toBase64Url = (bytes: Uint8Array) => (globalThis as any).btoa(String.fromCharCode(...bytes))
            .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        for (const fill of [0, 1, 0x7f, 0xff]) {
            const bytes = new Uint8Array(32).map((_, i) => (fill + i * 37) & 0xff);
            const token = toBase64Url(bytes);
            expect(token).toHaveLength(43);
            expect(decodeBase64Url32(token)).toEqual(bytes);
            expect(encodeBase64Url(bytes)).toBe(token);
            const digest = new Uint8Array(await platform.digest('SHA-256', bytes));
            expect(confirmHashOf(token)).toBe(toBase64Url(digest));
        }
    });

    it('server_link_provider (identity argument) still merges directly, with no row and no confirm', () => {
        const test = newHarness();
        const g = guest(test, 'direct');
        linkDiscord(test, g, 'pid-direct', 'Direct');
        expect(userRow(test, g.userId)).toMatchObject({ isGuest: false, providerId: 'pid-direct' });
        expect(linkRows(test)).toHaveLength(0);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Clean-up of stale codes
// ════════════════════════════════════════════════════════════════════════════

describe('link code clean-up (M5a, M5a2)', () => {
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

    it('a pending row is stale once its 2-minute window passes; before that the sweep keeps it', () => {
        const test = newHarness();
        const g = guest(test, 'pending');
        requestCode(test, g);
        present(test, codeOf(test, g), '100000000000000040', 'Pending', TOKEN_A);
        advance(test, 2 * 60_000 - 1);
        requestCode(test, guest(test, 'sweeper-1'));
        expect(test.db.LinkRequest.identity.find(g.identity)).toBeTruthy();
        advance(test, 1);
        requestCode(test, guest(test, 'sweeper-2'));
        expect(test.db.LinkRequest.identity.find(g.identity)).toBeFalsy();
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

    it('the scheduled identity GC sweeps the stale rows the inline sweep did not reach (pending ones included) and keeps live ones', () => {
        const test = newHarness();
        for (let i = 0; i < LINK_SWEEP_SCAN_LIMIT * 2; i++) insertRequest(test, `old-${i}`, -1_000);
        const keep = insertRequest(test, 'still-live', 60_000);
        const g = guest(test, 'pending-gc');
        requestCode(test, g);
        present(test, codeOf(test, g), '100000000000000041', 'Gc', TOKEN_A);
        const keepPending = test.db.LinkRequest.identity.find(g.identity)!.code;
        advance(test, 2 * 60_000);
        insertRequest(test, 'fresh-after', 60_000);
        tx(test, 'internal', (ctx) => M.run_identity_gc(ctx, { arg: { scheduledId: 1n, scheduledAt: ScheduleAt.time(now(test)) } }));
        const codes = linkRows(test).map((r) => r.code);
        expect(codes).toEqual(['direct-fresh-after']);
        expect(codes).not.toContain(keep);
        expect(codes).not.toContain(keepPending);
    });

    it('a user deletion removes the user\'s row, pending or not (delete_my_account, guest; and the admin deletion job)', () => {
        const test = newHarness();
        const self = guest(test, 'self-delete');
        requestCode(test, self);
        present(test, codeOf(test, self), '100000000000000042', 'Self', TOKEN_A);
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

    it('server_nuke_test_data clears every link row, pending or not', () => {
        const test = newHarness();
        const g = guest(test, 'nuked');
        requestCode(test, g);
        present(test, codeOf(test, g), '100000000000000043', 'Nuked', TOKEN_A);
        insertRequest(test, 'other', 60_000);
        expect(linkRows(test)).toHaveLength(2);
        tx(test, 'internal', (ctx) => M.server_nuke_test_data(onTestDatabase(ctx), { confirmation: 'NUKE_TEST_DATA' }));
        expect(linkRows(test)).toHaveLength(0);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// The code's byte layout (M5a review pass)
// ════════════════════════════════════════════════════════════════════════════

describe('generateLinkCode layout (M5a)', () => {
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

// ════════════════════════════════════════════════════════════════════════════
// M5a2 review fix pass
// ════════════════════════════════════════════════════════════════════════════

describe('M5a2 review fix pass', () => {
    /** A row written straight into the table for `a` (partly filled pending stage). */
    function insertPartialRow(test: Harness, a: Actor, code: string, fields: Record<string, unknown>) {
        test.db.LinkRequest.insert({
            code,
            identity: a.identity,
            userId: a.userId,
            expiresAt: new Timestamp(now(test) + 60_000_000n),
            usedAt: undefined,
            ...AUDIT(test),
            pendingProvider: undefined,
            pendingProviderId: undefined,
            pendingProviderName: undefined,
            confirmHash: undefined,
            ...fields,
        } as any);
    }

    it('a wrong token that differs from the right one only in its last byte (a 41-character common prefix) is refused', () => {
        const test = newHarness();
        const g = guest(test, 'prefix');
        requestCode(test, g);
        present(test, codeOf(test, g), '100000000000000050', 'Prefix', TOKEN_A);
        const bytes = decodeBase64Url32(TOKEN_A);
        bytes[31] ^= 0x01;
        const near = encodeBase64Url(bytes);
        expect(near).not.toBe(TOKEN_A);
        expect(near.slice(0, 41)).toBe(TOKEN_A.slice(0, 41));
        expect(rejection(test, g, (ctx) => M.confirm_link(ctx, { confirmToken: near }))).toBe(CONFIRM_REFUSED_TEXT);
        expect(userRow(test, g.userId)!.isGuest).toBe(true);
        confirm(test, g, TOKEN_A);
        expect(userRow(test, g.userId)!.isGuest).toBe(false);
    });

    it('an identity whose mapping was removed and which became a different guest (login_as_guest again) gets the account-changed text at confirm', () => {
        const test = newHarness();
        const g = guest(test, 'reborn');
        const oldUserId = g.userId;
        requestCode(test, g);
        present(test, codeOf(test, g), '100000000000000051', 'Reborn', TOKEN_A);
        test.db.UserIdentity.identity.delete(g.identity);
        tx(test, g, (ctx) => M.login_as_guest(ctx, {}));
        const newUserId = test.db.UserIdentity.identity.find(g.identity)!.userId;
        expect(newUserId).not.toBe(oldUserId);
        expect(rejection(test, g, (ctx) => M.confirm_link(ctx, { confirmToken: TOKEN_A }))).toBe(ACCOUNT_CHANGED_TEXT);
        expect(userRow(test, newUserId)!.isGuest).toBe(true);
    });

    it.each([
        ['hash and pending fields but no usedAt', { pendingProvider: 'discord', pendingProviderId: '100000000000000052', pendingProviderName: 'P', confirmHash: 'HASH' }],
        ['usedAt and pending fields but no confirmHash', { usedAt: 'NOW', pendingProvider: 'discord', pendingProviderId: '100000000000000052', pendingProviderName: 'P' }],
        ['usedAt only', { usedAt: 'NOW' }],
        ['usedAt and confirmHash but no provider id', { usedAt: 'NOW', confirmHash: 'HASH', pendingProvider: 'discord', pendingProviderName: 'P' }],
    ])('a partly filled row (%s) never reads as awaiting and never confirms', (_label, raw) => {
        const test = newHarness();
        const g = guest(test, 'partial');
        const fields: Record<string, unknown> = { ...raw };
        if (fields.usedAt === 'NOW') fields.usedAt = test.clock.now();
        if (fields.confirmHash === 'HASH') fields.confirmHash = confirmHashOf(TOKEN_A);
        insertPartialRow(test, g, 'partial-code', fields);
        expect(myRequest(test, g)[0]).toMatchObject({ awaitingConfirm: false, pendingProviderName: undefined });
        expect(rejection(test, g, (ctx) => M.confirm_link(ctx, { confirmToken: TOKEN_A }))).toBe(NO_PENDING_LINK_TEXT);
        expect(userRow(test, g.userId)!.isGuest).toBe(true);
        expect(linkRows(test)).toHaveLength(1);
    });

    it('a second identity of the same user holding the token is refused; the requesting identity\'s row is untouched and still confirms', () => {
        const test = newHarness();
        const g = guest(test, 'two-tabs');
        const other = addSecondIdentity(test, g.userId, 'two-tabs-b');
        requestCode(test, g);
        present(test, codeOf(test, g), '100000000000000053', 'Tabs', TOKEN_A);
        const before = jsonOf(test.db.LinkRequest.identity.find(g.identity));
        const msg = rejection(test, { auth: other.auth } as Actor, (ctx) => M.confirm_link(ctx, { confirmToken: TOKEN_A }));
        expect(msg).toBe(NO_PENDING_LINK_TEXT);
        expect(jsonOf(test.db.LinkRequest.identity.find(g.identity))).toBe(before);
        expect(userRow(test, g.userId)!.isGuest).toBe(true);
        confirm(test, g, TOKEN_A);
        expect(userRow(test, g.userId)!.isGuest).toBe(false);
    });

    it('the Discord account gaining an owner between presentation and confirm: confirm re-points to that owner and deletes the orphan guest', () => {
        const test = newHarness();
        const pid = '100000000000000054';
        const g = guest(test, 'late-owner');
        const guestId = g.userId;
        requestCode(test, g);
        present(test, codeOf(test, g), pid, 'Late', TOKEN_A);
        const owner = guest(test, 'owner-elsewhere');
        linkDiscord(test, owner, pid, 'Owner'); // the account is linked on another device meanwhile
        confirm(test, g, TOKEN_A);
        expect(test.db.UserIdentity.identity.find(g.identity)!.userId).toBe(owner.userId);
        expect(userRow(test, guestId)).toBeFalsy();
        expect(userRow(test, owner.userId)).toMatchObject({ isGuest: false, providerId: pid });
        expect(identitiesOf(test, owner.userId)).toHaveLength(2);
        expect(linkRows(test)).toHaveLength(0);
    });

    it.each([
        ['bidi embedding and override (U+202A-U+202E)', 'Na‪me‮'],
        ['zero-width space, joiners and marks (U+200B-U+200F)', '​N‌a‍m‎e‏'],
        ['word joiner and invisible operators (U+2060-U+2064)', 'N⁠a⁡m⁢e⁣⁤'],
        ['bidi isolates (U+2066-U+2069)', '⁦Na⁧m⁨e⁩'],
        ['BOM, Arabic letter mark, Mongolian vowel separator', '﻿Na؜me᠎'],
    ])('the provider name loses %s', (_label, raw) => {
        const test = newHarness();
        const g = guest(test, 'bidi');
        requestCode(test, g);
        present(test, codeOf(test, g), '100000000000000055', raw, TOKEN_A);
        expect(myRequest(test, g)[0].pendingProviderName).toBe('Name');
        confirm(test, g, TOKEN_A);
        expect(userRow(test, g.userId)).toMatchObject({ displayName: 'Name', providerUsername: 'Name' });
    });

    it('a name made only of format characters is refused as empty; visible non-Latin text is kept', () => {
        const test = newHarness();
        const blank = guest(test, 'only-format');
        requestCode(test, blank);
        const code = codeOf(test, blank);
        const msg = rejection(test, 'internal', (ctx) => M.server_link_by_code(ctx, presentArgs(code, '100000000000000056', ' ​‮﻿ ', TOKEN_A)));
        expect(msg).toBe('providerName is required');

        const kept = guest(test, 'kept');
        requestCode(test, kept);
        present(test, codeOf(test, kept), '100000000000000057', 'مرحبا 你好', TOKEN_B);
        expect(myRequest(test, kept)[0].pendingProviderName).toBe('مرحبا 你好');
    });

    it('view_my_link_request returns no row once the caller\'s user is linked or soft-deleted (the row itself stays for the sweep)', () => {
        const test = newHarness();
        const boss = admin(test);
        const linkedLater = guest(test, 'linked-later');
        requestCode(test, linkedLater);
        present(test, codeOf(test, linkedLater), '100000000000000058', 'Later', TOKEN_A);
        linkDiscord(test, linkedLater, 'pid-other-way', 'Other');
        expect(myRequest(test, linkedLater)).toEqual([]);
        expect(test.db.LinkRequest.identity.find(linkedLater.identity)).toBeTruthy();

        const deleted = guest(test, 'deleted-later');
        requestCode(test, deleted);
        tx(test, boss, (ctx) => M.admin_delete_row(ctx, { tableName: 'User', primaryKeyJson: String(deleted.userId) }));
        expect(myRequest(test, deleted)).toEqual([]);
        expect(test.db.LinkRequest.identity.find(deleted.identity)).toBeTruthy();
    });

    // Not covered: the module log over a full flow and refusals. The in-memory harness (spacetimedb/server/test-utils)
    // has no log capture API, so the "no code, nonce, token, hash or provider id in the log" check is not automated.
});
