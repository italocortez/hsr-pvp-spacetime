import { CONFIRM_COOKIE, REFUSAL_COOKIE } from '@shared/auth-flow';
import { InternalError, SenderError, UnknownCallResultError } from 'spacetimedb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { linkRow, memoryJar, memoryStorage } from '@/test/mockSignIn';
import {
    base64Url,
    discardConfirmToken,
    FLOW_KEY,
    forgetFlow,
    isFollowable,
    isSenderError,
    liveCode,
    makeNonce,
    pendingConfirm,
    pendingRow,
    postStart,
    readFlow,
    refusalText,
    rememberFlow,
    samePending,
    takeConfirmToken,
    takeRefusalText,
} from './signIn';

/* T-M5b: the sign-in logic without React (web/src/auth/signIn.ts). */

const TOKEN = `${'A'.repeat(42)}A`;
const NOW = 1_800_000_000_000;

describe('nonce', () => {
    it('is 43 base64url characters (32 bytes) and differs each time', () => {
        const a = makeNonce();
        expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(makeNonce()).not.toBe(a);
    });

    it('comes from crypto.getRandomValues', () => {
        const spy = vi.spyOn(crypto, 'getRandomValues');
        makeNonce();
        expect(spy).toHaveBeenCalledWith(expect.any(Uint8Array));
        const bytes = spy.mock.calls[0]?.[0] as Uint8Array | undefined;
        expect(bytes?.length).toBe(32);
        spy.mockRestore();
    });

    it('base64Url matches Node: no padding, - and _', () => {
        const bytes = new Uint8Array([251, 255, 191, 0, 1]);
        expect(base64Url(bytes)).toBe('-_-_AAE');
    });
});

describe('flow marker (sessionStorage)', () => {
    it('remember, read, forget', () => {
        const storage = memoryStorage();
        expect(rememberFlow('/profile', storage)).toBe(true);
        const flow = readFlow(storage);
        expect(flow?.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
        expect(flow?.next).toBe('/profile');
        forgetFlow(storage);
        expect(readFlow(storage)).toBeUndefined();
    });

    it('an unsafe next is not remembered, and is dropped again on read', () => {
        const storage = memoryStorage();
        rememberFlow('//evil.example', storage);
        expect(readFlow(storage)?.next).toBeUndefined();
        storage.map.set(FLOW_KEY, JSON.stringify({ id: 'x', next: '/\\evil.example' }));
        expect(readFlow(storage)).toEqual({ id: 'x' });
    });

    it('garbage in storage is no marker', () => {
        const storage = memoryStorage();
        storage.map.set(FLOW_KEY, 'not json');
        expect(readFlow(storage)).toBeUndefined();
        storage.map.set(FLOW_KEY, JSON.stringify({ id: '' }));
        expect(readFlow(storage)).toBeUndefined();
    });

    it('blocked storage: remember reports false, read and forget do not throw', () => {
        const storage = memoryStorage(true);
        expect(rememberFlow('/x', storage)).toBe(false);
        expect(readFlow(storage)).toBeUndefined();
        expect(() => forgetFlow(storage)).not.toThrow();
    });
});

describe('cookies', () => {
    it('takeConfirmToken reads and deletes the cookie before returning (one attempt)', () => {
        const { jar, events, cookies } = memoryJar({ [CONFIRM_COOKIE]: TOKEN });
        expect(takeConfirmToken(jar)).toBe(TOKEN);
        expect(events).toEqual([`read ${CONFIRM_COOKIE}`, `remove ${CONFIRM_COOKIE}`]);
        expect(cookies.has(CONFIRM_COOKIE)).toBe(false);
        expect(takeConfirmToken(jar)).toBeUndefined();
    });

    it('a malformed token is deleted and not used', () => {
        const { jar, cookies } = memoryJar({ [CONFIRM_COOKIE]: 'short' });
        expect(takeConfirmToken(jar)).toBeUndefined();
        expect(cookies.has(CONFIRM_COOKIE)).toBe(false);
    });

    it('discardConfirmToken deletes only when present', () => {
        const empty = memoryJar();
        discardConfirmToken(empty.jar);
        expect(empty.events).toEqual([`read ${CONFIRM_COOKIE}`]);
        const full = memoryJar({ [CONFIRM_COOKIE]: TOKEN });
        discardConfirmToken(full.jar);
        expect(full.cookies.size).toBe(0);
    });

    it('takeRefusalText decodes the text and deletes the cookie; it stays plain text', () => {
        const text = 'Banned: <b>no</b> & "more"';
        const { jar, cookies } = memoryJar({ [REFUSAL_COOKIE]: encodeURIComponent(text) });
        expect(takeRefusalText(jar)).toBe(text);
        expect(cookies.size).toBe(0);
    });

    it('a broken encoding gives no text but still deletes the cookie', () => {
        const { jar, cookies } = memoryJar({ [REFUSAL_COOKIE]: '%E0%A4%A' });
        expect(takeRefusalText(jar)).toBeUndefined();
        expect(cookies.size).toBe(0);
    });
});

describe('view_my_link_request rows', () => {
    const code = 'c'.repeat(32);

    it('liveCode: the newest unexpired, unpresented row with a well-formed code', () => {
        expect(liveCode([linkRow({ code, nowMs: NOW })], NOW)).toBe(code);
        expect(liveCode([linkRow({ code, nowMs: NOW, inMs: 0 })], NOW)).toBeUndefined();
        expect(liveCode([linkRow({ code: 'bad', nowMs: NOW })], NOW)).toBeUndefined();
        expect(
            liveCode([linkRow({ code, nowMs: NOW, awaitingConfirm: true })], NOW),
        ).toBeUndefined();
        const older = linkRow({ code: 'o'.repeat(32), nowMs: NOW, inMs: 10_000 });
        expect(liveCode([older, linkRow({ code, nowMs: NOW, inMs: 300_000 })], NOW)).toBe(code);
    });

    it('pendingConfirm: the awaiting row, unexpired by the browser clock, with its handle', () => {
        const row = linkRow({
            awaitingConfirm: true,
            pendingProviderName: 'kafka',
            nowMs: NOW,
            inMs: 120_000,
        });
        expect(pendingConfirm([row], NOW)).toEqual({ handle: 'kafka', expiresAt: NOW + 120_000 });
        expect(pendingConfirm([row], NOW + 120_000)).toBeUndefined();
        expect(pendingConfirm([linkRow({ code, nowMs: NOW })], NOW)).toBeUndefined();
        expect(
            pendingConfirm([linkRow({ awaitingConfirm: true, nowMs: NOW })], NOW),
        ).toBeUndefined();
    });

    it('pendingConfirm tolerates two rows (a replaced keyless row): the awaiting one wins', () => {
        const old = linkRow({ code, nowMs: NOW, inMs: 200_000 });
        const pending = linkRow({
            awaitingConfirm: true,
            pendingProviderName: 'kafka',
            nowMs: NOW,
            inMs: 120_000,
        });
        expect(pendingConfirm([old, pending], NOW)?.handle).toBe('kafka');
    });
});

describe('postStart', () => {
    const code = 'c'.repeat(32);

    it('POSTs JSON { linkCode } to the start route, same origin, and follows an https url', async () => {
        const fetchImpl = vi.fn(async () =>
            Response.json({ url: 'https://discord.com/oauth2/authorize?x=1' }),
        );
        await expect(postStart(code, fetchImpl)).resolves.toEqual({
            kind: 'redirect',
            url: 'https://discord.com/oauth2/authorize?x=1',
        });
        const [path, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
        expect(path).toBe('/api/auth/discord/start');
        expect(init.method).toBe('POST');
        expect(init.credentials).toBe('same-origin');
        expect(new Headers(init.headers).get('Content-Type')).toBe('application/json');
        expect(JSON.parse(String(init.body))).toEqual({ linkCode: code });
    });

    it('a hung function: failed after 10 s, the request aborted', async () => {
        vi.useFakeTimers();
        try {
            let signal: AbortSignal | undefined;
            const fetchImpl = (_: unknown, init?: RequestInit) => {
                signal = init?.signal ?? undefined;
                return new Promise<Response>(() => {});
            };
            const answer = postStart(code, fetchImpl as typeof fetch);
            let settled = false;
            void answer.then(() => (settled = true));
            await vi.advanceTimersByTimeAsync(9_999);
            expect(settled).toBe(false);
            await vi.advanceTimersByTimeAsync(1);
            await expect(answer).resolves.toEqual({ kind: 'failed' });
            expect(signal?.aborted).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it('a body that never ends counts against the same 10 s', async () => {
        vi.useFakeTimers();
        try {
            const res = new Response(new ReadableStream({ start() {} }), { status: 200 });
            const answer = postStart(code, (async () => res) as typeof fetch);
            await vi.advanceTimersByTimeAsync(10_000);
            await expect(answer).resolves.toEqual({ kind: 'failed' });
        } finally {
            vi.useRealTimers();
        }
    });

    it('a not-configured answer', async () => {
        const fetchImpl = async () =>
            Response.json({ error: 'not_configured', missing: ['X'] }, { status: 500 });
        await expect(postStart(code, fetchImpl)).resolves.toEqual({ kind: 'notConfigured' });
    });

    it.each([
        ['a generic 500', async () => Response.json({ error: 'server_error' }, { status: 500 })],
        ['a 403', async () => Response.json({ error: 'forbidden' }, { status: 403 })],
        ['a javascript: url', async () => Response.json({ url: 'javascript:alert(1)' })],
        ['a relative url', async () => Response.json({ url: '/x' })],
        ['no JSON', async () => new Response('oops', { status: 200 })],
        [
            'a network error',
            async () => {
                throw new TypeError('offline');
            },
        ],
    ])('%s is failed', async (_l, fetchImpl) => {
        await expect(postStart(code, fetchImpl as typeof fetch)).resolves.toEqual({
            kind: 'failed',
        });
    });
});

describe('isFollowable (the address start may send the browser to)', () => {
    afterEach(() => vi.unstubAllEnvs());

    it.each([
        'https://discord.com/oauth2/authorize?x=1',
        'https://discord.com:443/oauth2/authorize',
        'https://DISCORD.com/oauth2/authorize',
    ])('production and dev follow %s', (url) => {
        expect(isFollowable(url)).toBe(true);
        vi.stubEnv('DEV', false);
        expect(isFollowable(url)).toBe(true);
    });

    it.each([
        'http://discord.com/oauth2/authorize',
        'https://discord.com.evil.example/oauth2/authorize',
        'https://evil.example/https://discord.com/',
        'https://user:pw@discord.com/oauth2/authorize',
        'https://discord.com:8443/oauth2/authorize',
        'https://ptb.discord.com/oauth2/authorize',
        'blob:https://discord.com/0b6c7d1e-1111-4222-8333-944445555666',
        'blob:http://127.0.0.1:4599/0b6c7d1e-1111-4222-8333-944445555666',
        'blob:http://localhost:4599/0b6c7d1e-1111-4222-8333-944445555666',
        'javascript:alert(1)',
        '/relative',
        'not a url',
    ])('nobody follows %s', (url) => {
        expect(isFollowable(url)).toBe(false);
        vi.stubEnv('DEV', false);
        expect(isFollowable(url)).toBe(false);
    });

    it.each(['http://127.0.0.1:4599/oauth2/authorize', 'http://localhost:4599/oauth2/authorize'])(
        'only a dev build follows the loopback stand-in %s',
        (url) => {
            expect(isFollowable(url)).toBe(true);
            vi.stubEnv('DEV', false);
            expect(isFollowable(url)).toBe(false);
        },
    );

    it.each([
        'http://127.0.0.1/oauth2/authorize',
        'https://127.0.0.1:4599/oauth2/authorize',
        'http://127.0.0.2:4599/',
        'http://localhost.evil.example:4599/',
    ])('dev does not follow %s either', (url) => {
        expect(isFollowable(url)).toBe(false);
    });

    it('postStart in production refuses a loopback url', async () => {
        vi.stubEnv('DEV', false);
        const fetchImpl = async () =>
            Response.json({ url: 'http://127.0.0.1:4599/oauth2/authorize' });
        await expect(postStart('c'.repeat(32), fetchImpl)).resolves.toEqual({ kind: 'failed' });
    });
});

describe('isSenderError', () => {
    it('is true for the SDK SenderError only', () => {
        expect(isSenderError(new SenderError('Banned.'))).toBe(true);
        expect(isSenderError(new Error('Banned.'))).toBe(false);
        expect(isSenderError(new UnknownCallResultError())).toBe(false);
        expect(isSenderError(new InternalError('x'))).toBe(false);
        expect(isSenderError('Banned.')).toBe(false);
    });
});

describe('pendingRow and samePending', () => {
    it('pendingRow ignores expiry; samePending compares handle and expiry', () => {
        const row = linkRow({
            awaitingConfirm: true,
            pendingProviderName: 'kafka',
            inMs: -1,
            nowMs: NOW,
        });
        const pending = pendingRow([row]);
        expect(pending).toEqual({ handle: 'kafka', expiresAt: NOW - 1 });
        expect(samePending(pending, { handle: 'kafka', expiresAt: NOW - 1 })).toBe(true);
        expect(samePending(pending, { handle: 'kafka', expiresAt: NOW })).toBe(false);
        expect(samePending(pending, { handle: 'other', expiresAt: NOW - 1 })).toBe(false);
        expect(samePending(undefined, pending)).toBe(false);
    });
});

describe('refusalText', () => {
    it('takes the message of an Error or a string, trimmed and capped', () => {
        expect(refusalText(new Error(' Banned. '))).toBe('Banned.');
        expect(refusalText('text')).toBe('text');
        expect(refusalText(42)).toBe('');
        expect(refusalText(new Error('x'.repeat(300)))).toHaveLength(200);
    });
});
