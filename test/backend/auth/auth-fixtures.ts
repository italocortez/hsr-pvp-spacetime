/**
 * T-M5b fixtures for the login function's unit tests: a config record, deterministic randomness,
 * a scripted fetch that records every outbound call, and a log capture. No network.
 */
import type { AuthDeps } from '../../../api/_lib/handlers';
import type { DiscordEndpoints } from '../../../api/_lib/outbound';

export const ORIGIN = 'https://app.example';
export const AUTH_SECRET = 'a-test-auth-secret-that-is-long-enough-0123456789';
export const CLIENT_ID = 'client-id-123';
export const CLIENT_SECRET = 'client-secret-xyz-SECRET';
export const LINK_TOKEN = 'link-token-SECRET-value';
export const LINK_CODE = 'abcdefghijklmnopqrstuvwxyzAB_-12';
export const DISCORD_ID = '123456789012345678';

export const ENV: Record<string, string> = {
    DISCORD_CLIENT_ID: CLIENT_ID,
    DISCORD_CLIENT_SECRET: CLIENT_SECRET,
    AUTH_SECRET,
    STDB_LINK_TOKEN: LINK_TOKEN,
    STDB_TARGET: 'test',
    AUTH_ORIGIN: ORIGIN,
};

export const STUB_ENDPOINTS: DiscordEndpoints = {
    authorize: 'https://discord.test/oauth2/authorize',
    token: 'https://discord.test/api/v10/oauth2/token',
    me: 'https://discord.test/api/v10/users/@me',
};

export type Call = { url: string; init: RequestInit };
export type Route = (call: Call) => Response | Promise<Response>;

/**
 * A fetch that answers from `routes` and records every call. The last matching URL prefix wins,
 * so `{ ...happyRoutes(), [prefix]: override }` overrides.
 */
export function scriptedFetch(routes: Record<string, Route>) {
    const calls: Call[] = [];
    const fetch = async (url: string, init: RequestInit) => {
        const call = { url, init };
        calls.push(call);
        const key = Object.keys(routes)
            .reverse()
            .find((prefix) => url.startsWith(prefix));
        if (!key) throw new Error(`unexpected fetch ${url}`);
        return (routes[key] as Route)(call);
    };
    return { fetch, calls };
}

/** The happy path: Discord token and user, then the module accepts the presentation. */
export function happyRoutes(user: Record<string, unknown> = { id: DISCORD_ID, username: 'kafka_handle', global_name: 'Kafka Display' }): Record<string, Route> {
    return {
        [STUB_ENDPOINTS.token]: () => Response.json({ access_token: 'discord-access-SECRET', token_type: 'Bearer' }),
        [STUB_ENDPOINTS.me]: () => Response.json(user),
        'https://maincloud.spacetimedb.com/v1/database/': () => new Response(null, { status: 200 }),
    };
}

/** Counter-based bytes, so every draw differs and tests are repeatable. */
export function counterRandom() {
    let n = 0;
    return (size: number) => {
        n += 1;
        return Buffer.alloc(size, n);
    };
}

export function makeDeps(overrides: Partial<AuthDeps> = {}) {
    const lines: string[] = [];
    const scripted = scriptedFetch(happyRoutes());
    const deps: AuthDeps = {
        env: ENV,
        fetch: scripted.fetch,
        now: () => 1_800_000_000_000,
        random: counterRandom(),
        log: (line) => lines.push(line),
        discord: STUB_ENDPOINTS,
        // The handlers' rules with the deployed checks (local: false), on the test target so the
        // module URL is test1's; the deployed shells' prod-only rule is tested on the shells.
        target: 'test',
        local: false,
        ...overrides,
    };
    return { deps, lines, calls: scripted.calls };
}

/** All `Set-Cookie` values of a response. */
export function setCookies(res: Response): string[] {
    return res.headers.getSetCookie();
}

/** The `name=value` pair of the first Set-Cookie for `name`. */
export function cookieValue(res: Response, name: string): string | undefined {
    const line = setCookies(res).find((c) => c.startsWith(`${name}=`));
    return line?.slice(name.length + 1).split(';')[0];
}

export function startRequest(init: { method?: string; origin?: string | null; contentType?: string | null; body?: string; url?: string } = {}): Request {
    const headers = new Headers();
    const origin = init.origin === undefined ? ORIGIN : init.origin;
    if (origin !== null) headers.set('Origin', origin);
    const type = init.contentType === undefined ? 'application/json' : init.contentType;
    if (type !== null) headers.set('Content-Type', type);
    const method = init.method ?? 'POST';
    return new Request(init.url ?? `${ORIGIN}/api/auth/discord/start`, {
        method,
        headers,
        ...(method === 'GET' || method === 'HEAD' ? {} : { body: init.body ?? JSON.stringify({ linkCode: LINK_CODE }) }),
    });
}

export function callbackRequest(query: string, cookie?: string, method = 'GET', origin = ORIGIN): Request {
    const headers = new Headers();
    if (cookie !== undefined) headers.set('Cookie', cookie);
    return new Request(`${origin}/api/auth/discord/callback${query}`, { method, headers });
}
