/**
 * T-M5b: start then callback with one cookie jar, Discord and the module stubbed (no network):
 * the code sealed at start is the code presented at the callback, and the browser ends with only
 * the confirm token.
 */
import { describe, expect, it } from 'vitest';
import { confirmHashOf, handleCallback, handleStart } from '../../../api/_lib/handlers';
import { CONFIRM_COOKIE, STATE_COOKIE } from '../../../shared/auth-flow';
import { callbackRequest, happyRoutes, LINK_CODE, makeDeps, ORIGIN, scriptedFetch, startRequest } from './auth-fixtures';

/** A minimal browser cookie jar: applies Set-Cookie (Max-Age=0 deletes) and builds the Cookie header. */
class Jar {
    readonly cookies = new Map<string, string>();
    apply(res: Response) {
        for (const line of res.headers.getSetCookie()) {
            const [pair = '', ...attrs] = line.split('; ');
            const eq = pair.indexOf('=');
            const name = pair.slice(0, eq);
            if (attrs.includes('Max-Age=0')) this.cookies.delete(name);
            else this.cookies.set(name, pair.slice(eq + 1));
        }
    }
    header() {
        return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    }
}

describe('login flow, end to end (stubbed)', () => {
    it('start, Discord, callback: the sealed code is presented and the page gets the token', async () => {
        const jar = new Jar();
        const scripted = scriptedFetch(happyRoutes());
        const { deps } = makeDeps({ fetch: scripted.fetch });

        const started = await handleStart(startRequest(), deps);
        expect(started.status).toBe(200);
        jar.apply(started);
        expect([...jar.cookies.keys()]).toEqual([STATE_COOKIE]);
        const { url } = (await started.json()) as { url: string };
        const authorize = new URL(url);

        // Discord sends the browser back with its code and the same state.
        const back = new URL(authorize.searchParams.get('redirect_uri') ?? '');
        expect(back.origin).toBe(ORIGIN);
        const query = `?code=discord-code&state=${authorize.searchParams.get('state')}`;
        const done = await handleCallback(callbackRequest(query, jar.header()), { ...deps, now: () => deps.now() + 90_000 });
        jar.apply(done);

        expect(done.status).toBe(303);
        expect(done.headers.get('Location')).toBe('/?login=1&status=confirm');
        expect([...jar.cookies.keys()]).toEqual([CONFIRM_COOKIE]);
        const presented = JSON.parse(String(scripted.calls[2]?.init.body)) as string[];
        expect(presented[0]).toBe(LINK_CODE);
        expect(presented[4]).toBe(confirmHashOf(jar.cookies.get(CONFIRM_COOKIE) ?? ''));
    });

    it('a second callback with the same jar after success fails: the state cookie is gone', async () => {
        const jar = new Jar();
        const scripted = scriptedFetch(happyRoutes());
        const { deps } = makeDeps({ fetch: scripted.fetch });
        const started = await handleStart(startRequest(), deps);
        jar.apply(started);
        const state = new URL(((await started.json()) as { url: string }).url).searchParams.get('state');
        jar.apply(await handleCallback(callbackRequest(`?code=c&state=${state}`, jar.header()), deps));
        const replay = await handleCallback(callbackRequest(`?code=c&state=${state}`, jar.header()), deps);
        expect(replay.headers.get('Location')).toBe('/?login=1&status=failed');
        expect(scripted.calls).toHaveLength(3);
    });
});
