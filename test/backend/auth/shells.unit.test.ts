/**
 * T-M5b: the deployed route shells (api/auth/discord/start.ts and callback.ts) with process.env
 * stubbed. They accept the prod target only (A174) and need AUTH_ORIGIN. No outbound call is
 * reached: start makes none, and the callback stops before Discord (no cookie).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as callbackGet } from '../../../api/auth/discord/callback';
import { GET as startGet, POST as startPost } from '../../../api/auth/discord/start';
import { AUTH_SECRET, CLIENT_ID, CLIENT_SECRET, LINK_TOKEN, ORIGIN, startRequest } from './auth-fixtures';

const PROD_ENV = {
    DISCORD_CLIENT_ID: CLIENT_ID,
    DISCORD_CLIENT_SECRET: CLIENT_SECRET,
    AUTH_SECRET,
    STDB_LINK_TOKEN: LINK_TOKEN,
    STDB_TARGET: 'prod',
    AUTH_ORIGIN: ORIGIN,
};

const lines: string[] = [];
beforeEach(() => {
    lines.length = 0;
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(' '));
    });
    for (const [key, value] of Object.entries(PROD_ENV)) vi.stubEnv(key, value);
});
afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
});

describe('deployed shells', () => {
    it('start answers with Discord\'s real authorize address and a redirect_uri on AUTH_ORIGIN', async () => {
        const res = await startPost(startRequest());
        expect(res.status).toBe(200);
        const url = new URL(((await res.json()) as { url: string }).url);
        expect(`${url.origin}${url.pathname}`).toBe('https://discord.com/oauth2/authorize');
        expect(url.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/api/auth/discord/callback`);
        expect(lines).toEqual(['[auth] start: ok']);
    });

    it('the test target is refused (Vercel is production only): 500, generic body', async () => {
        vi.stubEnv('STDB_TARGET', 'test');
        const res = await startPost(startRequest());
        expect(res.status).toBe(500);
        expect(await res.json()).toEqual({ error: 'server_error' });
        expect(lines).toEqual(['[auth] start: auth is not configured (missing STDB_TARGET)']);
        const cb = await callbackGet(new Request(`${ORIGIN}/api/auth/discord/callback?code=x&state=y`));
        expect(cb.status).toBe(500);
    });

    it('without AUTH_ORIGIN both shells answer 500', async () => {
        vi.stubEnv('AUTH_ORIGIN', '');
        expect((await startPost(startRequest())).status).toBe(500);
        expect((await callbackGet(new Request(`${ORIGIN}/api/auth/discord/callback`))).status).toBe(500);
        expect(lines.every((l) => l.includes('missing AUTH_ORIGIN'))).toBe(true);
    });

    it('a request on another host cannot get a redirect_uri on that host', async () => {
        const evil = 'https://evil.example';
        const res = await startPost(startRequest({ url: `${evil}/api/auth/discord/start`, origin: evil }));
        expect(res.status).toBe(403);
    });

    it('the callback without a cookie redirects to failed without clearing anything', async () => {
        const res = await callbackGet(new Request(`${ORIGIN}/api/auth/discord/callback?code=x&state=y`));
        expect(res.status).toBe(303);
        expect(res.headers.get('Location')).toBe('/?login=1&status=failed');
        expect(res.headers.getSetCookie()).toEqual([]);
    });

    it('every other method is the handler\'s 405', async () => {
        expect((await startGet(new Request(`${ORIGIN}/api/auth/discord/start`))).status).toBe(405);
    });
});
