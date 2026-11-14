/**
 * T-M5b: GET /api/auth/discord/callback (api/_lib/handlers.ts handleCallback). Stubbed fetch, no
 * network; console captured to prove no secret reaches a log line.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { confirmHashOf, handleCallback } from '../../../api/_lib/handlers';
import { seal } from '../../../api/_lib/seal';
import { CONFIRM_COOKIE, REFUSAL_COOKIE, STATE_COOKIE } from '../../../shared/auth-flow';
import {
    AUTH_SECRET,
    CLIENT_ID,
    CLIENT_SECRET,
    callbackRequest,
    cookieValue,
    DISCORD_ID,
    happyRoutes,
    LINK_CODE,
    LINK_TOKEN,
    makeDeps,
    ORIGIN,
    type Route,
    STUB_ENDPOINTS,
    scriptedFetch,
    setCookies,
} from './auth-fixtures';

const NOW = 1_800_000_000_000;
const STATE = 'S'.repeat(42) + 'A';
const sealed = (overrides: Partial<{ state: string; linkCode: string; createdAt: number }> = {}) =>
    seal({ state: STATE, linkCode: LINK_CODE, createdAt: NOW - 60_000, ...overrides }, AUTH_SECRET);
const cookieHeader = (value = sealed()) => `other=1; ${STATE_COOKIE}=${value}`;
const OK_QUERY = `?code=discord-code-SECRET&state=${STATE}`;
const STDB_URL =
    'https://maincloud.spacetimedb.com/v1/database/hsr-spacetimedb-test1/call/linker_present_code';

const CLEARED_STATE = `${STATE_COOKIE}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`;

function withRoutes(routes: Record<string, Route>) {
    const scripted = scriptedFetch(routes);
    const made = makeDeps({ fetch: scripted.fetch });
    return { ...made, calls: scripted.calls };
}

// Every console line any code under test writes (the handlers log through deps.log; this proves
// nothing else prints either).
const consoleLines: string[] = [];
beforeEach(() => {
    consoleLines.length = 0;
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
        vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
            consoleLines.push(args.map(String).join(' '));
        });
    }
});
afterEach(() => vi.restoreAllMocks());

function expectRedirect(res: Response, status: string, cleared = true) {
    expect(res.status).toBe(303);
    expect(res.headers.get('Location')).toBe(`/?login=1&status=${status}`);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    if (cleared) expect(setCookies(res)).toContain(CLEARED_STATE);
    else expect(setCookies(res)).toEqual([]);
}

describe('callback: failures before any outbound call', () => {
    // `cleared`: the state cookie is cleared only when the request's cookie is broken or expired,
    // or unseals and matches the query's state; a third party cannot cancel a flow in progress.
    it.each([
        ['no code (cookie and state match)', `?state=${STATE}`, cookieHeader(), true],
        ['no state', '?code=x', cookieHeader(), false],
        ['no cookie', OK_QUERY, undefined, false],
        ['an empty cookie', OK_QUERY, `${STATE_COOKIE}=`, true],
        ['a malformed cookie', OK_QUERY, cookieHeader('garbage'), true],
        ['a tampered cookie', OK_QUERY, cookieHeader(`${sealed().slice(0, -2)}AA`), true],
        [
            'a cookie sealed with another key',
            OK_QUERY,
            cookieHeader(
                seal({ state: STATE, linkCode: LINK_CODE, createdAt: NOW }, `${AUTH_SECRET}-x`),
            ),
            true,
        ],
        [
            'an expired cookie (older than 10 minutes)',
            OK_QUERY,
            cookieHeader(sealed({ createdAt: NOW - 600_001 })),
            true,
        ],
        ['a state mismatch', `?code=x&state=${'T'.repeat(43)}`, cookieHeader(), false],
        ['a state of another length', '?code=x&state=short', cookieHeader(), false],
        ['an empty state', '?code=x&state=', cookieHeader(), false],
        ['an unknown Discord error without state', '?error=server_error', cookieHeader(), false],
        [
            'an unknown Discord error with the matching state',
            `?error=server_error&state=${STATE}`,
            cookieHeader(),
            true,
        ],
        ['access_denied with another state', '?error=access_denied&state=x', cookieHeader(), false],
        ['access_denied without state', '?error=access_denied', cookieHeader(), false],
        ['access_denied without a cookie', `?error=access_denied&state=${STATE}`, undefined, false],
    ])(
        '%s: status=failed, no fetch (cookie cleared: %s)',
        async (_label, query, cookie, cleared) => {
            const { deps, calls, lines } = makeDeps();
            const res = await handleCallback(callbackRequest(query, cookie), deps);
            expectRedirect(res, 'failed', cleared);
            expect(setCookies(res)).toEqual(cleared ? [CLEARED_STATE] : []);
            expect(calls).toEqual([]);
            expect(lines).toHaveLength(1);
            expect(lines[0]).toMatch(/^\[auth\] callback: failed \(/);
        },
    );

    it('a request from another site (live cookie, wrong state) leaves the flow intact: the real return still works', async () => {
        const { deps, calls } = withRoutes(happyRoutes());
        const forged = await handleCallback(
            callbackRequest(`?code=x&state=${'T'.repeat(43)}`, cookieHeader()),
            deps,
        );
        expectRedirect(forged, 'failed', false);
        const forgedCancel = await handleCallback(
            callbackRequest('?error=access_denied', cookieHeader()),
            deps,
        );
        expectRedirect(forgedCancel, 'failed', false);
        expect(calls).toEqual([]);
        // The browser still holds the cookie; Discord's real return completes.
        const real = await handleCallback(callbackRequest(OK_QUERY, cookieHeader()), deps);
        expectRedirect(real, 'confirm');
    });

    it('access_denied with the matching state: status=cancelled, cookie cleared, no fetch', async () => {
        const { deps, calls, lines } = makeDeps();
        const res = await handleCallback(
            callbackRequest(`?error=access_denied&state=${STATE}`, cookieHeader()),
            deps,
        );
        expectRedirect(res, 'cancelled');
        expect(setCookies(res)).toEqual([CLEARED_STATE]);
        expect(calls).toEqual([]);
        expect(lines).toEqual(['[auth] callback: cancelled (access_denied)']);
    });

    it('the token exchange uses AUTH_ORIGIN, not the host of the request URL', async () => {
        const { deps, calls } = withRoutes(happyRoutes());
        const res = await handleCallback(
            callbackRequest(OK_QUERY, cookieHeader(), 'GET', 'https://evil.example'),
            deps,
        );
        expectRedirect(res, 'confirm');
        expect(new URLSearchParams(String(calls[0]?.init.body)).get('redirect_uri')).toBe(
            `${ORIGIN}/api/auth/discord/callback`,
        );
        expect(res.headers.get('Location')).toBe('/?login=1&status=confirm');
    });

    it('a method other than GET is 405', async () => {
        const { deps, calls } = makeDeps();
        const res = await handleCallback(callbackRequest(OK_QUERY, cookieHeader(), 'POST'), deps);
        expect(res.status).toBe(405);
        expect(res.headers.get('Allow')).toBe('GET');
        expect(calls).toEqual([]);
    });

    it('a missing config is 500 with a generic body and no fetch', async () => {
        const { deps, calls } = makeDeps({ env: { STDB_TARGET: 'test' } });
        const res = await handleCallback(callbackRequest(OK_QUERY, cookieHeader()), deps);
        expect(res.status).toBe(500);
        expect(await res.json()).toEqual({ error: 'server_error' });
        expect(calls).toEqual([]);
    });
});

describe('callback: Discord', () => {
    it('exchanges the code (form body, the same redirect_uri) and reads users/@me with the access token', async () => {
        const { deps, calls } = withRoutes(happyRoutes());
        await handleCallback(callbackRequest(OK_QUERY, cookieHeader()), deps);
        const [token, me] = calls;
        expect(token?.url).toBe(STUB_ENDPOINTS.token);
        expect(token?.init.method).toBe('POST');
        expect(new Headers(token?.init.headers).get('Content-Type')).toBe(
            'application/x-www-form-urlencoded',
        );
        expect(Object.fromEntries(new URLSearchParams(String(token?.init.body)))).toEqual({
            grant_type: 'authorization_code',
            code: 'discord-code-SECRET',
            redirect_uri: `${ORIGIN}/api/auth/discord/callback`,
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
        });
        expect(token?.init.signal).toBeInstanceOf(AbortSignal);
        expect(me?.url).toBe(STUB_ENDPOINTS.me);
        expect(new Headers(me?.init.headers).get('Authorization')).toBe(
            'Bearer discord-access-SECRET',
        );
        expect(me?.init.signal).toBeInstanceOf(AbortSignal);
    });

    it.each([
        [
            'token endpoint 400',
            {
                [STUB_ENDPOINTS.token]: () =>
                    Response.json({ error: 'invalid_grant' }, { status: 400 }),
            },
            'discord_token_status',
        ],
        [
            'token without access_token',
            { [STUB_ENDPOINTS.token]: () => Response.json({}) },
            'discord_token_body',
        ],
        [
            'token endpoint unreachable',
            {
                [STUB_ENDPOINTS.token]: () => {
                    throw new TypeError('fetch failed');
                },
            },
            'discord_token_unreachable',
        ],
        [
            'token endpoint timeout',
            {
                [STUB_ENDPOINTS.token]: () => {
                    throw Object.assign(new Error('t'), { name: 'TimeoutError' });
                },
            },
            'discord_token_timeout',
        ],
        [
            'user endpoint 401',
            { [STUB_ENDPOINTS.me]: () => new Response('no', { status: 401 }) },
            'discord_user_status',
        ],
        [
            'user without an id',
            { [STUB_ENDPOINTS.me]: () => Response.json({ username: 'x' }) },
            'discord_user_body',
        ],
        [
            'user with a short id',
            { [STUB_ENDPOINTS.me]: () => Response.json({ id: '1234', username: 'x' }) },
            'discord_user_body',
        ],
        [
            'user without a handle',
            {
                [STUB_ENDPOINTS.me]: () =>
                    Response.json({ id: DISCORD_ID, global_name: 'Only Display' }),
            },
            'discord_user_body',
        ],
    ])('%s: status=failed, no module call', async (_label, override, reason) => {
        const { deps, calls, lines } = withRoutes({ ...happyRoutes(), ...override });
        const res = await handleCallback(callbackRequest(OK_QUERY, cookieHeader()), deps);
        expectRedirect(res, 'failed');
        expect(setCookies(res)).toEqual([CLEARED_STATE]);
        expect(calls.some((c) => c.url.startsWith('https://maincloud'))).toBe(false);
        expect(lines).toEqual([`[auth] callback: failed (${reason})`]);
    });
});

describe('callback: the presentation', () => {
    it('POSTs linker_present_code on the target database with the link token and the five arguments', async () => {
        const { deps, calls } = withRoutes(happyRoutes());
        await handleCallback(callbackRequest(OK_QUERY, cookieHeader()), deps);
        const call = calls[2];
        expect(call?.url).toBe(STDB_URL);
        expect(call?.init.method).toBe('POST');
        const headers = new Headers(call?.init.headers);
        expect(headers.get('Authorization')).toBe(`Bearer ${LINK_TOKEN}`);
        expect(headers.get('Content-Type')).toBe('application/json');
        const args = JSON.parse(String(call?.init.body)) as string[];
        expect(args.slice(0, 4)).toEqual([LINK_CODE, 'discord', DISCORD_ID, 'kafka_handle']);
        expect(args[4]).toMatch(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
        expect(call?.init.signal).toBeInstanceOf(AbortSignal);
        expect(calls).toHaveLength(3);
    });

    it('the provider name is the handle (username), never the display name', async () => {
        const { deps, calls } = withRoutes(
            happyRoutes({ id: DISCORD_ID, username: 'the_handle', global_name: 'The Display' }),
        );
        await handleCallback(callbackRequest(OK_QUERY, cookieHeader()), deps);
        expect(JSON.parse(String(calls[2]?.init.body))[3]).toBe('the_handle');
    });

    it('prod target calls the prod database (resolved through shared/stdb-targets.ts)', async () => {
        const scripted = scriptedFetch(happyRoutes());
        const { deps } = makeDeps({
            fetch: scripted.fetch,
            target: 'prod',
            env: { ...makeDeps().deps.env, STDB_TARGET: 'prod' },
        });
        await handleCallback(callbackRequest(OK_QUERY, cookieHeader()), deps);
        expect(scripted.calls[2]?.url).toBe(
            'https://maincloud.spacetimedb.com/v1/database/hsr-spacetimedb-prod/call/linker_present_code',
        );
    });

    it('success: status=confirm, the state cookie cleared, the confirm token in a readable 2-minute cookie', async () => {
        const { deps, calls, lines } = withRoutes(happyRoutes());
        const res = await handleCallback(callbackRequest(OK_QUERY, cookieHeader()), deps);
        expectRedirect(res, 'confirm');
        const confirm = setCookies(res).find((c) => c.startsWith(`${CONFIRM_COOKIE}=`)) ?? '';
        const attrs = confirm.split('; ').slice(1).sort();
        expect(attrs).toEqual(['Max-Age=120', 'Path=/', 'SameSite=Strict', 'Secure'].sort());
        const token = cookieValue(res, CONFIRM_COOKIE) ?? '';
        expect(token).toMatch(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/);
        // The hash presented is the hash of exactly this token.
        expect(JSON.parse(String(calls[2]?.init.body))[4]).toBe(confirmHashOf(token));
        // The token is in no URL, body or log.
        expect(res.headers.get('Location')).not.toContain(token);
        expect(await res.text()).toBe('');
        expect(lines).toEqual(['[auth] callback: confirm']);
    });

    it('a fresh token for every presentation', async () => {
        const a = withRoutes(happyRoutes());
        const b = withRoutes(happyRoutes());
        const ra = await handleCallback(callbackRequest(OK_QUERY, cookieHeader()), {
            ...a.deps,
            random: (n) => Buffer.alloc(n, 7),
        });
        const rb = await handleCallback(callbackRequest(OK_QUERY, cookieHeader()), {
            ...b.deps,
            random: (n) => Buffer.alloc(n, 9),
        });
        expect(cookieValue(ra, CONFIRM_COOKIE)).not.toBe(cookieValue(rb, CONFIRM_COOKIE));
    });

    it('a module refusal (530): status=refused, the text percent-encoded in a readable cookie', async () => {
        const text = 'You are banned: reason & more; "quoted" <b>html</b>';
        const { deps, lines } = withRoutes({
            ...happyRoutes(),
            'https://maincloud.spacetimedb.com/': () => new Response(text, { status: 530 }),
        });
        const res = await handleCallback(callbackRequest(OK_QUERY, cookieHeader()), deps);
        expectRedirect(res, 'refused');
        expect(setCookies(res).some((c) => c.startsWith(`${CONFIRM_COOKIE}=`))).toBe(false);
        const refusal = setCookies(res).find((c) => c.startsWith(`${REFUSAL_COOKIE}=`)) ?? '';
        expect(refusal.split('; ').slice(1).sort()).toEqual(
            ['Max-Age=120', 'Path=/', 'SameSite=Strict', 'Secure'].sort(),
        );
        const value = cookieValue(res, REFUSAL_COOKIE) ?? '';
        expect(value).toMatch(/^[A-Za-z0-9%\-_.!~*'()]+$/);
        expect(decodeURIComponent(value)).toBe(text);
        expect(lines).toEqual(['[auth] callback: refused (module)']);
    });

    it('a refusal of exactly 200 characters (after trimming) is shown in full', async () => {
        const text = `  ${'a'.repeat(198)}\u{1F600}  `;
        const { deps } = withRoutes({
            ...happyRoutes(),
            'https://maincloud.spacetimedb.com/': () => new Response(text, { status: 530 }),
        });
        const res = await handleCallback(callbackRequest(OK_QUERY, cookieHeader()), deps);
        expectRedirect(res, 'refused');
        expect(decodeURIComponent(cookieValue(res, REFUSAL_COOKIE) ?? '')).toBe(text.trim());
    });

    it.each([
        [
            'longer than 200 characters',
            () => new Response(`${'a'.repeat(199)}\u{1F600}tail`, { status: 530 }),
        ],
        ['multi-line (LF)', () => new Response('first line\nsecond line', { status: 530 })],
        ['multi-line (CR)', () => new Response('first line\rsecond line', { status: 530 })],
        ['with a tab', () => new Response('first\tsecond', { status: 530 })],
        ['with NUL', () => new Response('first\u0000second', { status: 530 })],
        ['with ESC', () => new Response('first\u001B[31msecond', { status: 530 })],
        ['with DEL', () => new Response('first\u007Fsecond', { status: 530 })],
        ['with a C1 control (U+0085)', () => new Response('first\u0085second', { status: 530 })],
        ['with U+009F', () => new Response('first\u009Fsecond', { status: 530 })],
        ['with U+2028', () => new Response('first\u2028second', { status: 530 })],
        ['with U+2029', () => new Response('first\u2029second', { status: 530 })],
        [
            'HTML',
            () =>
                new Response('<html><body>Bad gateway</body></html>', {
                    status: 530,
                    headers: { 'Content-Type': 'text/html' },
                }),
        ],
        ['JSON', () => Response.json({ error: 'x' }, { status: 530 })],
        ['without a Content-Type', () => new Response(new Blob(['one line']), { status: 530 })],
        [
            'text/plain-ish (text/plainx)',
            () =>
                new Response('one line', {
                    status: 530,
                    headers: { 'Content-Type': 'text/plainx' },
                }),
        ],
    ])('a 530 body %s: status=failed with no refusal cookie', async (_label, route) => {
        const { deps, lines } = withRoutes({
            ...happyRoutes(),
            'https://maincloud.spacetimedb.com/': route as Route,
        });
        const res = await handleCallback(callbackRequest(OK_QUERY, cookieHeader()), deps);
        expectRedirect(res, 'failed');
        expect(setCookies(res)).toEqual([CLEARED_STATE]);
        expect(lines).toEqual(['[auth] callback: failed (stdb_body)']);
    });

    it.each([
        ['lower case', 'forbidden: caller is not the registered linker identity.'],
        ['upper case', 'FORBIDDEN: no'],
        ['leading spaces', '   Forbidden: no'],
        ['a leading zero-width space', '\u200BForbidden: no'],
        ['a leading BOM and word joiner', '\uFEFF\u2060Forbidden: no'],
        ['a leading ZWJ', '\u200DForbidden: no'],
    ])('a guard refusal with %s is failed (stdb_forbidden), never shown', async (_label, body) => {
        const { deps, lines } = withRoutes({
            ...happyRoutes(),
            'https://maincloud.spacetimedb.com/': () => new Response(body, { status: 530 }),
        });
        const res = await handleCallback(callbackRequest(OK_QUERY, cookieHeader()), deps);
        expectRedirect(res, 'failed');
        expect(setCookies(res)).toEqual([CLEARED_STATE]);
        expect(lines).toEqual(['[auth] callback: failed (stdb_forbidden)']);
    });

    it('a text that only contains the word later is a refusal', async () => {
        const { deps } = withRoutes({
            ...happyRoutes(),
            'https://maincloud.spacetimedb.com/': () =>
                new Response('Linking is forbidden while you are banned.', { status: 530 }),
        });
        const res = await handleCallback(callbackRequest(OK_QUERY, cookieHeader()), deps);
        expectRedirect(res, 'refused');
    });

    it('a 530 text/plain with a charset parameter is a refusal', async () => {
        const { deps } = withRoutes({
            ...happyRoutes(),
            'https://maincloud.spacetimedb.com/': () =>
                new Response('This link code is invalid or has expired.', {
                    status: 530,
                    headers: { 'Content-Type': 'Text/Plain; charset=utf-8' },
                }),
        });
        const res = await handleCallback(callbackRequest(OK_QUERY, cookieHeader()), deps);
        expectRedirect(res, 'refused');
        expect(decodeURIComponent(cookieValue(res, REFUSAL_COOKIE) ?? '')).toBe(
            'This link code is invalid or has expired.',
        );
    });

    it.each([
        [
            'a guard refusal (Forbidden: …)',
            () =>
                new Response('Forbidden: caller is not the registered linker identity.', {
                    status: 530,
                }),
            'stdb_forbidden',
        ],
        ['a bad token (401)', () => new Response('Invalid token', { status: 401 }), 'stdb_auth'],
        [
            'bad arguments (400)',
            () => new Response('invalid arguments', { status: 400 }),
            'stdb_status',
        ],
        ['a durability timeout (504)', () => new Response('', { status: 504 }), 'stdb_status'],
        [
            'unreachable',
            () => {
                throw new TypeError('fetch failed');
            },
            'stdb_unreachable',
        ],
        [
            'a timeout',
            () => {
                throw Object.assign(new Error('t'), { name: 'TimeoutError' });
            },
            'stdb_timeout',
        ],
    ])('%s: status=failed with nothing else, one attempt', async (_label, route, reason) => {
        const { deps, calls, lines } = withRoutes({
            ...happyRoutes(),
            'https://maincloud.spacetimedb.com/': route as Route,
        });
        const res = await handleCallback(callbackRequest(OK_QUERY, cookieHeader()), deps);
        expectRedirect(res, 'failed');
        expect(setCookies(res)).toEqual([CLEARED_STATE]);
        expect(calls.filter((c) => c.url.startsWith('https://maincloud'))).toHaveLength(1);
        expect(lines).toEqual([`[auth] callback: failed (${reason})`]);
    });
});

describe('callback: logs', () => {
    it('no secret, code, state, token, hash, cookie or Discord id in any log or console line', async () => {
        const outcomes: Array<Record<string, Route>> = [
            happyRoutes(),
            {
                ...happyRoutes(),
                'https://maincloud.spacetimedb.com/': () =>
                    new Response('refused text', { status: 530 }),
            },
            { ...happyRoutes(), [STUB_ENDPOINTS.me]: () => new Response('', { status: 500 }) },
        ];
        const all: string[] = [];
        const secrets: string[] = [
            AUTH_SECRET,
            CLIENT_SECRET,
            LINK_TOKEN,
            LINK_CODE,
            STATE,
            DISCORD_ID,
            'discord-code-SECRET',
            'discord-access-SECRET',
            sealed(),
        ];
        for (const routes of outcomes) {
            const { deps, lines, calls } = withRoutes(routes);
            const res = await handleCallback(callbackRequest(OK_QUERY, cookieHeader()), deps);
            all.push(...lines);
            const token = cookieValue(res, CONFIRM_COOKIE);
            if (token) secrets.push(token, confirmHashOf(token));
            const body = calls[2]?.init.body;
            if (body) secrets.push(JSON.parse(String(body))[4]);
        }
        all.push(...consoleLines);
        const text = all.join('\n');
        expect(all.length).toBeGreaterThanOrEqual(3);
        for (const secret of secrets) expect(text).not.toContain(secret);
        expect(text).not.toContain('SECRET');
    });
});

describe('confirm hash', () => {
    it('matches the vector of docs/auth/architecture.md (32 zero bytes)', () => {
        expect(confirmHashOf('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')).toBe(
            'Zmh6rfhivXdsj8GLjp-OIAiXFIVu4jOzkCpZHQ1fKSU',
        );
        expect(
            Buffer.from('Zmh6rfhivXdsj8GLjp-OIAiXFIVu4jOzkCpZHQ1fKSU', 'base64url').toString('hex'),
        ).toBe('66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925');
    });
});
