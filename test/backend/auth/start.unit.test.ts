/**
 * T-M5b: POST /api/auth/discord/start (api/_lib/handlers.ts handleStart). Stubbed fetch, no network.
 */
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { handleStart } from '../../../api/_lib/handlers';
import { unseal } from '../../../api/_lib/seal';
import { STATE_COOKIE } from '../../../shared/auth-flow';
import { AUTH_SECRET, CLIENT_ID, cookieValue, ENV, LINK_CODE, makeDeps, ORIGIN, setCookies, startRequest } from './auth-fixtures';

describe('start: request checks', () => {
    it.each(['GET', 'PUT', 'DELETE', 'PATCH'])('%s is 405 with Allow: POST and no cookie', async (method) => {
        const { deps } = makeDeps();
        const res = await handleStart(startRequest({ method }), deps);
        expect(res.status).toBe(405);
        expect(res.headers.get('Allow')).toBe('POST');
        expect(setCookies(res)).toEqual([]);
    });

    it.each([
        ['missing', null],
        ['another host', 'https://evil.example'],
        ['another scheme', 'http://app.example'],
        ['another port', 'https://app.example:8443'],
        ['a sub-domain', 'https://x.app.example'],
        ['a trailing slash', 'https://app.example/'],
        ['the string null', 'null'],
    ])('Origin %s is 403', async (_label, origin) => {
        const { deps } = makeDeps();
        const res = await handleStart(startRequest({ origin }), deps);
        expect(res.status).toBe(403);
        expect(setCookies(res)).toEqual([]);
    });

    it('an Origin with an explicit default port is not the same text: 403 (exact match only)', async () => {
        const { deps } = makeDeps();
        const res = await handleStart(startRequest({ origin: 'https://app.example:443' }), deps);
        expect(res.status).toBe(403);
    });

    it.each([
        ['missing', null],
        ['text/plain', 'text/plain'],
        ['form', 'application/x-www-form-urlencoded'],
    ])('Content-Type %s is 415', async (_label, contentType) => {
        const { deps } = makeDeps();
        const res = await handleStart(startRequest({ contentType }), deps);
        expect(res.status).toBe(415);
    });

    it('application/json with a charset parameter is accepted', async () => {
        const { deps } = makeDeps();
        const res = await handleStart(startRequest({ contentType: 'application/json; charset=utf-8' }), deps);
        expect(res.status).toBe(200);
    });

    it.each([
        ['not JSON', 'nope'],
        ['no linkCode', '{}'],
        ['31 characters', JSON.stringify({ linkCode: LINK_CODE.slice(1) })],
        ['33 characters', JSON.stringify({ linkCode: `${LINK_CODE}A` })],
        ['a bad character', JSON.stringify({ linkCode: `${LINK_CODE.slice(1)}+` })],
        ['a number', JSON.stringify({ linkCode: 42 })],
        ['too long a body', JSON.stringify({ linkCode: LINK_CODE, pad: 'x'.repeat(2000) })],
    ])('body %s is 400', async (_label, body) => {
        const { deps } = makeDeps();
        const res = await handleStart(startRequest({ body }), deps);
        expect(res.status).toBe(400);
        expect(setCookies(res)).toEqual([]);
    });
});

describe('start: success', () => {
    it('answers 200 { url } with the authorize parameters and no-store', async () => {
        const { deps, calls } = makeDeps();
        const res = await handleStart(startRequest(), deps);
        expect(res.status).toBe(200);
        expect(res.headers.get('Cache-Control')).toBe('no-store');
        const { url } = (await res.json()) as { url: string };
        const u = new URL(url);
        expect(`${u.origin}${u.pathname}`).toBe('https://discord.test/oauth2/authorize');
        expect(Object.fromEntries(u.searchParams)).toEqual({
            response_type: 'code',
            client_id: CLIENT_ID,
            scope: 'identify',
            state: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
            redirect_uri: `${ORIGIN}/api/auth/discord/callback`,
            prompt: 'consent',
        });
        expect(url).not.toContain(LINK_CODE);
        expect(calls).toEqual([]);
    });

    it('sets the sealed state cookie: __Host-, HttpOnly, Secure, SameSite=Lax, Path=/, Max-Age=600', async () => {
        const { deps } = makeDeps();
        const res = await handleStart(startRequest(), deps);
        const [cookie] = setCookies(res);
        expect(cookie).toMatch(/^__Host-hsr-auth-state=v1\.[A-Za-z0-9_-]+; /);
        const attrs = (cookie ?? '').split('; ').slice(1);
        expect(attrs.sort()).toEqual(['HttpOnly', 'Max-Age=600', 'Path=/', 'SameSite=Lax', 'Secure'].sort());
        expect(cookie).not.toMatch(/Domain=/i);
    });

    it('the cookie holds the state of the URL and the code, unreadable without the secret', async () => {
        const { deps } = makeDeps();
        const res = await handleStart(startRequest(), deps);
        const value = cookieValue(res, STATE_COOKIE) ?? '';
        expect(value).not.toContain(LINK_CODE);
        expect(Buffer.from(value.slice(3), 'base64url').toString('latin1')).not.toContain(LINK_CODE);
        const { url } = (await res.json()) as { url: string };
        const opened = unseal(value, AUTH_SECRET, deps.now(), 600_000);
        expect(opened).toEqual({
            ok: true,
            payload: { state: new URL(url).searchParams.get('state'), linkCode: LINK_CODE, createdAt: deps.now() },
        });
    });

    it('logs one line, with no code, state or secret', async () => {
        const { deps, lines } = makeDeps();
        const res = await handleStart(startRequest(), deps);
        const { url } = (await res.json()) as { url: string };
        expect(lines).toEqual(['[auth] start: ok']);
        const state = new URL(url).searchParams.get('state') ?? '';
        for (const secret of [LINK_CODE, state, AUTH_SECRET, ENV.DISCORD_CLIENT_SECRET]) {
            expect(lines.join('\n')).not.toContain(secret);
        }
    });
});

describe('start: AUTH_ORIGIN, not the request URL', () => {
    const EVIL = 'https://evil.example';

    it('a request on another host with that host as Origin is 403 (no redirect_uri on that host)', async () => {
        const { deps } = makeDeps();
        const res = await handleStart(startRequest({ url: `${EVIL}/api/auth/discord/start`, origin: EVIL }), deps);
        expect(res.status).toBe(403);
        expect(setCookies(res)).toEqual([]);
    });

    it('a request on another host with the real Origin gets a redirect_uri on AUTH_ORIGIN', async () => {
        const { deps } = makeDeps();
        const res = await handleStart(startRequest({ url: `${EVIL}/api/auth/discord/start` }), deps);
        expect(res.status).toBe(200);
        const { url } = (await res.json()) as { url: string };
        expect(new URL(url).searchParams.get('redirect_uri')).toBe(`${ORIGIN}/api/auth/discord/callback`);
        expect(url).not.toContain('evil.example');
    });

    it('the local runner (local: true) uses the request origin instead', async () => {
        const { deps } = makeDeps({ local: true, env: { ...ENV, AUTH_ORIGIN: undefined as unknown as string } });
        const local = 'http://127.0.0.1:5173';
        const res = await handleStart(startRequest({ url: `${local}/api/auth/discord/start`, origin: local }), deps);
        expect(res.status).toBe(200);
        const { url } = (await res.json()) as { url: string };
        expect(new URL(url).searchParams.get('redirect_uri')).toBe(`${local}/api/auth/discord/callback`);
    });
});

describe('start: fresh values per call', () => {
    it('two starts give different states and different sealed cookies (real randomness)', async () => {
        const { deps } = makeDeps({ random: (n) => randomBytes(n) });
        const [a, b] = [await handleStart(startRequest(), deps), await handleStart(startRequest(), deps)];
        const stateOf = async (res: Response) => new URL(((await res.json()) as { url: string }).url).searchParams.get('state');
        const [sa, sb] = [await stateOf(a), await stateOf(b)];
        expect(sa).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(sa).not.toBe(sb);
        const [ca, cb] = [cookieValue(a, STATE_COOKIE), cookieValue(b, STATE_COOKIE)];
        expect(ca).not.toBe(cb);
        // Each cookie opens to its own state.
        expect(unseal(ca ?? '', AUTH_SECRET, deps.now(), 600_000)).toMatchObject({ ok: true, payload: { state: sa } });
        expect(unseal(cb ?? '', AUTH_SECRET, deps.now(), 600_000)).toMatchObject({ ok: true, payload: { state: sb } });
    });

    it('the same state with a fresh IV still seals to a different cookie', async () => {
        // The state draw is fixed; only the IV changes between the two calls.
        let ivCall = 0;
        const random = (n: number) => (n === 32 ? Buffer.alloc(32, 5) : Buffer.alloc(n, ++ivCall));
        const { deps } = makeDeps({ random });
        const a = await handleStart(startRequest(), deps);
        const b = await handleStart(startRequest(), deps);
        expect(cookieValue(a, STATE_COOKIE)).not.toBe(cookieValue(b, STATE_COOKIE));
    });
});

describe('start: missing config', () => {
    it.each([
        ['DISCORD_CLIENT_ID'],
        ['DISCORD_CLIENT_SECRET'],
        ['AUTH_SECRET'],
        ['STDB_LINK_TOKEN'],
        ['STDB_TARGET'],
        ['AUTH_ORIGIN'],
    ])('without %s the deployed function answers 500 with a generic body', async (key) => {
        const env = { ...ENV };
        delete env[key];
        const { deps, lines } = makeDeps({ env });
        const res = await handleStart(startRequest(), deps);
        expect(res.status).toBe(500);
        expect(await res.json()).toEqual({ error: 'server_error' });
        expect(lines).toEqual([`[auth] start: auth is not configured (missing ${key})`]);
    });

    it('an AUTH_SECRET shorter than 32 characters counts as missing', async () => {
        const { deps } = makeDeps({ env: { ...ENV, AUTH_SECRET: 'x'.repeat(31) } });
        expect((await handleStart(startRequest(), deps)).status).toBe(500);
    });

    it('a target that is not test or prod counts as missing', async () => {
        const { deps, lines } = makeDeps({ env: { ...ENV, STDB_TARGET: 'staging' } });
        expect((await handleStart(startRequest(), deps)).status).toBe(500);
        expect(lines[0]).toContain('STDB_TARGET');
    });

    it.each([
        ['DISCORD_CLIENT_ID'],
        ['DISCORD_CLIENT_SECRET'],
        ['AUTH_SECRET'],
        ['STDB_LINK_TOKEN'],
        ['STDB_TARGET'],
        ['AUTH_ORIGIN'],
    ])('a whitespace-only %s counts as missing', async (key) => {
        const { deps, lines } = makeDeps({ env: { ...ENV, [key]: ' \t ' } });
        expect((await handleStart(startRequest(), deps)).status).toBe(500);
        expect(lines).toEqual([`[auth] start: auth is not configured (missing ${key})`]);
    });

    it('values are trimmed: padded values work, and the secret is used trimmed', async () => {
        const padded = Object.fromEntries(Object.entries(ENV).map(([k, v]) => [k, `  ${v}\t`]));
        const { deps } = makeDeps({ env: padded });
        const res = await handleStart(startRequest(), deps);
        expect(res.status).toBe(200);
        const { url } = (await res.json()) as { url: string };
        expect(new URL(url).searchParams.get('client_id')).toBe(CLIENT_ID);
        expect(unseal(cookieValue(res, STATE_COOKIE) ?? '', AUTH_SECRET, deps.now(), 600_000).ok).toBe(true);
    });

    it.each([
        ['31 characters once trimmed', ` ${'x'.repeat(30)}y `],
        ['one repeated character', 'x'.repeat(64)],
        ['one repeated non-ASCII character', '\u{1F600}'.repeat(40)],
    ])('an AUTH_SECRET of %s counts as missing', async (_label, value) => {
        const { deps, lines } = makeDeps({ env: { ...ENV, AUTH_SECRET: value } });
        expect((await handleStart(startRequest(), deps)).status).toBe(500);
        expect(lines[0]).toContain('missing AUTH_SECRET');
    });

    it.each([
        ['a path', `${ORIGIN}/app`],
        ['a trailing slash', `${ORIGIN}/`],
        ['plain http', 'http://app.example'],
        ['no scheme', 'app.example'],
        ['credentials', 'https://user:pw@app.example'],
        ['a query', `${ORIGIN}?x=1`],
    ])('an AUTH_ORIGIN with %s counts as missing', async (_label, value) => {
        const { deps, lines } = makeDeps({ env: { ...ENV, AUTH_ORIGIN: value } });
        expect((await handleStart(startRequest(), deps)).status).toBe(500);
        expect(lines[0]).toContain('missing AUTH_ORIGIN');
    });

    it('a STDB_TARGET other than the caller target counts as missing', async () => {
        const { deps, lines } = makeDeps({ target: 'prod' });
        expect((await handleStart(startRequest(), deps)).status).toBe(500);
        expect(lines[0]).toContain('missing STDB_TARGET');
    });

    it('locally the body names the missing key names, never a value', async () => {
        const env = { ...ENV, DISCORD_CLIENT_ID: '', DISCORD_CLIENT_SECRET: undefined as unknown as string };
        const { deps } = makeDeps({ env, local: true });
        const res = await handleStart(startRequest(), deps);
        expect(res.status).toBe(500);
        const body = (await res.json()) as { error: string; missing: string[]; message: string };
        expect(body.error).toBe('not_configured');
        expect(body.missing).toEqual(['DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET']);
        expect(body.message).toContain('DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET');
        expect(JSON.stringify(body)).not.toContain(AUTH_SECRET);
        expect(JSON.stringify(body)).not.toContain(ENV.STDB_LINK_TOKEN);
    });
});
