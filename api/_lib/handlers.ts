// The two login handlers (M5b), Web-standard: Request in, Response out. The route files under
// api/auth/discord/ are thin shells around them; the local runner (scripts/local-auth/) calls the
// same functions with its own dependencies.
//
// Logs: one line per outcome, `[auth] <route>: <outcome> (<reason>)`. Never a secret, code,
// state, token, hash, cookie or Discord id.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
    AUTH_CALLBACK_PATH,
    CONFIRM_COOKIE,
    capOnCodePoint,
    isLinkCode,
    type LoginStatus,
    READABLE_COOKIE_MAX_AGE_S,
    READABLE_COOKIE_SAMESITE,
    REFUSAL_COOKIE,
    REFUSAL_TEXT_MAX,
    STATE_COOKIE,
    STATE_MAX_AGE_S,
} from '../../shared/auth-flow.js';
import type { Target } from '../../shared/stdb-targets.js';
import { type AuthConfig, readAuthConfig } from './config.js';
import { clearCookie, readCookie, serializeCookie } from './cookies.js';
import {
    authorizeUrl,
    type DiscordEndpoints,
    type FetchLike,
    fetchDiscordUser,
    presentLinkCode,
} from './outbound.js';
import { seal, unseal } from './seal.js';

export interface AuthDeps {
    /** The config record (process.env on Vercel; the local runner's record on localhost). */
    env: Readonly<Record<string, string | undefined>>;
    fetch: FetchLike;
    /** Milliseconds since the epoch. */
    now: () => number;
    /** CSPRNG bytes (node:crypto randomBytes). */
    random: (bytes: number) => Buffer;
    log: (line: string) => void;
    discord: DiscordEndpoints;
    /**
     * The only database target this caller accepts (STDB_TARGET must say the same): `prod` for the
     * deployed shells (A174: Vercel is production only), `test` for the local runner.
     */
    target: Target;
    /**
     * True on the local runner only: a missing config is answered with the missing key names
     * (never values), and the origin is the runner's own address (its Host is checked). The
     * deployed function answers a generic body and takes its origin from AUTH_ORIGIN only.
     */
    local: boolean;
}

/** The deployed function's dependencies: the real Discord endpoints, global fetch, node:crypto, prod. */
export function defaultDeps(
    env: Readonly<Record<string, string | undefined>>,
    discord: DiscordEndpoints,
): AuthDeps {
    return {
        env,
        fetch: (input, init) => fetch(input, init),
        now: () => Date.now(),
        random: (n) => randomBytes(n),
        log: (line) => console.log(line),
        discord,
        target: 'prod',
        local: false,
    };
}

function configFor(deps: AuthDeps) {
    return readAuthConfig(deps.env, { target: deps.target, requireOrigin: !deps.local });
}

/**
 * The app's origin: AUTH_ORIGIN on Vercel (never the request's URL, whose host a proxy or a
 * forged Host could change); the request's own origin on the local runner, which accepts only a
 * loopback Host.
 */
function appOrigin(request: Request, deps: AuthDeps, config: AuthConfig): string {
    if (deps.local) return new URL(request.url).origin;
    // readAuthConfig requires AUTH_ORIGIN whenever `local` is false.
    if (config.origin === undefined) throw new Error('AUTH_ORIGIN was not checked');
    return config.origin;
}

const STATE_COOKIE_OPTS = { httpOnly: true, sameSite: 'Lax' } as const;
const READABLE_COOKIE_OPTS = { httpOnly: false, sameSite: READABLE_COOKIE_SAMESITE } as const;

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            ...extra,
        },
    });
}

/** A 303 to the app's sign-in panel with `status`, setting the given cookies. */
function backToApp(status: LoginStatus, cookies: string[]): Response {
    const headers = new Headers({
        Location: `/?login=1&status=${status}`,
        'Cache-Control': 'no-store',
    });
    for (const cookie of cookies) headers.append('Set-Cookie', cookie);
    return new Response(null, { status: 303, headers });
}

/** The answer to a missing config: key names locally, a generic body on Vercel. */
function notConfigured(deps: AuthDeps, route: string, missing: string[]): Response {
    deps.log(`[auth] ${route}: auth is not configured (missing ${missing.join(', ')})`);
    if (deps.local) {
        return json(500, {
            error: 'not_configured',
            missing,
            message: `Sign-in is not configured on this machine. Missing in .env.test.local: ${missing.join(', ')}.`,
        });
    }
    return json(500, { error: 'server_error' });
}

/** `application/json`, with or without parameters. */
function isJsonContentType(value: string | null): boolean {
    return value !== null && value.split(';')[0]?.trim().toLowerCase() === 'application/json';
}

const MAX_START_BODY = 1024;

/**
 * POST /api/auth/discord/start, body `{ linkCode }`. Same-origin only (exact `Origin`), JSON
 * only. Seals `{ state, linkCode, createdAt }` into the state cookie and answers `{ url }`, the
 * Discord authorize address. The link code never appears in a URL.
 */
export async function handleStart(request: Request, deps: AuthDeps): Promise<Response> {
    if (request.method !== 'POST') {
        deps.log('[auth] start: refused (method)');
        return json(405, { error: 'method_not_allowed' }, { Allow: 'POST' });
    }
    const configured = configFor(deps);
    if (!configured.ok) return notConfigured(deps, 'start', configured.missing);
    const { config } = configured;
    const origin = appOrigin(request, deps, config);
    if (request.headers.get('Origin') !== origin) {
        deps.log('[auth] start: refused (origin)');
        return json(403, { error: 'forbidden' });
    }
    if (!isJsonContentType(request.headers.get('Content-Type'))) {
        deps.log('[auth] start: refused (content_type)');
        return json(415, { error: 'unsupported_media_type' });
    }

    let linkCode: unknown;
    try {
        const text = await request.text();
        if (text.length > MAX_START_BODY) throw new Error('too long');
        linkCode = (JSON.parse(text) as { linkCode?: unknown } | null)?.linkCode;
    } catch {
        linkCode = undefined;
    }
    if (!isLinkCode(linkCode)) {
        deps.log('[auth] start: refused (body)');
        return json(400, { error: 'bad_request' });
    }

    const state = deps.random(32).toString('base64url');
    const sealed = seal(
        { state, linkCode, createdAt: deps.now() },
        config.authSecret,
        deps.random(12),
    );
    const url = authorizeUrl(deps.discord, config.clientId, state, origin + AUTH_CALLBACK_PATH);
    deps.log('[auth] start: ok');
    return json(
        200,
        { url },
        {
            'Set-Cookie': serializeCookie(STATE_COOKIE, sealed, {
                ...STATE_COOKIE_OPTS,
                maxAge: STATE_MAX_AGE_S,
            }),
        },
    );
}

/** Constant-time comparison of two strings (false at once only when the lengths differ). */
function sameString(a: string, b: string): boolean {
    const x = Buffer.from(a, 'utf8');
    const y = Buffer.from(b, 'utf8');
    return x.length === y.length && timingSafeEqual(x, y);
}

/** `confirmHash` exactly as the module checks it: base64url(SHA-256(the token's 32 bytes)). */
export function confirmHashOf(token: string): string {
    return createHash('sha256').update(Buffer.from(token, 'base64url')).digest('base64url');
}

/**
 * GET /api/auth/discord/callback?code&state (or ?error=access_denied). Every failure before the
 * outbound calls ends on `/?login=1&status=failed` with no call to Discord or the database.
 *
 * The state cookie is cleared only when this request may end the flow: its cookie unseals and
 * carries the query's `state`, or the cookie is broken or expired (useless anyway). A request with
 * no cookie, or with a live cookie and a wrong or missing `state`, leaves the cookie alone, so a
 * request made by another site cannot cancel a sign-in in progress. `access_denied` counts as a
 * cancel only with the matching `state`.
 *
 * On success the module holds the pending link and the page gets the confirm token in a
 * short-lived readable cookie (never in a URL, body or log).
 */
export async function handleCallback(request: Request, deps: AuthDeps): Promise<Response> {
    if (request.method !== 'GET') {
        deps.log('[auth] callback: refused (method)');
        return json(405, { error: 'method_not_allowed' }, { Allow: 'GET' });
    }
    const configured = configFor(deps);
    if (!configured.ok) return notConfigured(deps, 'callback', configured.missing);
    const { config } = configured;

    const url = new URL(request.url);
    const state = url.searchParams.get('state');
    const cookie = readCookie(request.headers.get('Cookie'), STATE_COOKIE);
    let check: 'absent' | 'broken' | 'mismatch' | 'match' = 'absent';
    let broken = '';
    let linkCode = '';
    if (cookie !== undefined) {
        const opened = unseal(cookie, config.authSecret, deps.now(), STATE_MAX_AGE_S * 1000);
        if (!opened.ok) {
            check = 'broken';
            broken = `cookie_${opened.reason}`;
        } else if (state === null || !sameString(opened.payload.state, state)) {
            check = 'mismatch';
        } else {
            check = 'match';
            linkCode = opened.payload.linkCode;
        }
    }
    const clearState =
        check === 'match' || check === 'broken'
            ? [clearCookie(STATE_COOKIE, STATE_COOKIE_OPTS)]
            : [];
    const failed = (reason: string) => {
        deps.log(`[auth] callback: failed (${reason})`);
        return backToApp('failed', clearState);
    };

    const discordError = url.searchParams.get('error');
    if (discordError !== null) {
        if (discordError === 'access_denied' && check === 'match') {
            deps.log('[auth] callback: cancelled (access_denied)');
            return backToApp('cancelled', clearState);
        }
        return failed(discordError === 'access_denied' ? 'access_denied_unbound' : 'discord_error');
    }
    if (check === 'absent') return failed('no_cookie');
    if (check === 'broken') return failed(broken);
    if (check === 'mismatch') return failed(state === null ? 'query' : 'state_mismatch');
    const code = url.searchParams.get('code');
    if (!code) return failed('query');

    return finishCallback(
        deps,
        config,
        appOrigin(request, deps, config) + AUTH_CALLBACK_PATH,
        code,
        linkCode,
        clearState,
    );
}

async function finishCallback(
    deps: AuthDeps,
    config: AuthConfig,
    redirectUri: string,
    code: string,
    linkCode: string,
    clearState: string[],
): Promise<Response> {
    const user = await fetchDiscordUser(deps.fetch, deps.discord, config, code, redirectUri);
    if (!user.ok) {
        deps.log(`[auth] callback: failed (${user.reason})`);
        return backToApp('failed', clearState);
    }
    const confirmToken = deps.random(32).toString('base64url');
    const presented = await presentLinkCode(deps.fetch, config, {
        linkCode,
        providerId: user.value.id,
        providerName: user.value.username,
        confirmHash: confirmHashOf(confirmToken),
    });
    if (presented.kind === 'presented') {
        deps.log('[auth] callback: confirm');
        return backToApp('confirm', [
            ...clearState,
            serializeCookie(CONFIRM_COOKIE, confirmToken, {
                ...READABLE_COOKIE_OPTS,
                maxAge: READABLE_COOKIE_MAX_AGE_S,
            }),
        ]);
    }
    if (presented.kind === 'refused') {
        deps.log('[auth] callback: refused (module)');
        const text = encodeURIComponent(capOnCodePoint(presented.text, REFUSAL_TEXT_MAX));
        return backToApp('refused', [
            ...clearState,
            serializeCookie(REFUSAL_COOKIE, text, {
                ...READABLE_COOKIE_OPTS,
                maxAge: READABLE_COOKIE_MAX_AGE_S,
            }),
        ]);
    }
    deps.log(`[auth] callback: failed (${presented.reason})`);
    return backToApp('failed', clearState);
}
