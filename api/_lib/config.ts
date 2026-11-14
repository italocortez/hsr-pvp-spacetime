// The login function's configuration, read from one plain record (process.env on Vercel, the
// local runner's record on localhost). Values are never logged; only key names are reported.
import { ENV_KEYS, STDB_DATABASES, STDB_HOST, type Target } from '../../shared/stdb-targets.js';

export const AUTH_KEYS = {
    clientId: 'DISCORD_CLIENT_ID',
    clientSecret: 'DISCORD_CLIENT_SECRET',
    authSecret: 'AUTH_SECRET',
    linkToken: ENV_KEYS.linkToken,
    /** The database target of the function: `test` | `prod` (the Node-side key of CLAUDE.md §5). */
    target: ENV_KEYS.target,
    /**
     * The deployed function's public origin (`https://<host>`, no path): the only `Origin` start
     * accepts and the base of `redirect_uri`. The request's own URL is never trusted for either.
     */
    origin: 'AUTH_ORIGIN',
} as const;

export const AUTH_SECRET_MIN_LENGTH = 32;

/** What the caller accepts. */
export interface ConfigRules {
    /** The only target allowed: the deployed shells pass `prod` (A174), the local runner `test`. */
    target: Target;
    /** The deployed function needs AUTH_ORIGIN; the local runner takes the origin from its address. */
    requireOrigin: boolean;
}

export interface AuthConfig {
    clientId: string;
    clientSecret: string;
    authSecret: string;
    linkToken: string;
    target: Target;
    /** AUTH_ORIGIN when required; undefined on the local runner. */
    origin: string | undefined;
    /** From `shared/stdb-targets.ts`, never typed by hand. */
    dbName: string;
    /** `https://maincloud.spacetimedb.com`, from STDB_HOST. */
    stdbHttpHost: string;
}

export type ConfigResult = { ok: true; config: AuthConfig } | { ok: false; missing: string[] };

/** The HTTP origin of the SpacetimeDB host (`wss://x` becomes `https://x`). */
export function stdbHttpHost(): string {
    return STDB_HOST.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:');
}

/** `https://host[:port]` exactly as the URL parser writes it back: no path, query, user or slash. */
export function isHttpsOrigin(value: string): boolean {
    try {
        const url = new URL(value);
        return (
            url.protocol === 'https:' &&
            url.origin === value &&
            url.username === '' &&
            url.password === ''
        );
    } catch {
        return false;
    }
}

/** A secret made of one character repeated (`aaaa…`) is not a secret. */
function isRepeatedChar(value: string): boolean {
    const chars = Array.from(value);
    return chars.every((c) => c === chars[0]);
}

/**
 * Reads the config. Every value is trimmed; an absent or whitespace-only value is missing.
 * `missing` lists key names only: those keys, an AUTH_SECRET shorter than 32 characters or made
 * of one repeated character, a target other than `rules.target`, and (when required) an
 * AUTH_ORIGIN that is not a bare `https://` origin.
 */
export function readAuthConfig(
    env: Readonly<Record<string, string | undefined>>,
    rules: ConfigRules,
): ConfigResult {
    const missing: string[] = [];
    const value = (key: string) => (env[key] ?? '').trim();
    const get = (key: string) => {
        const v = value(key);
        if (v === '') missing.push(key);
        return v;
    };
    const clientId = get(AUTH_KEYS.clientId);
    const clientSecret = get(AUTH_KEYS.clientSecret);
    const authSecret = value(AUTH_KEYS.authSecret);
    if (authSecret.length < AUTH_SECRET_MIN_LENGTH || isRepeatedChar(authSecret)) {
        missing.push(AUTH_KEYS.authSecret);
    }
    const linkToken = get(AUTH_KEYS.linkToken);
    if (value(AUTH_KEYS.target) !== rules.target) missing.push(AUTH_KEYS.target);
    let origin: string | undefined;
    if (rules.requireOrigin) {
        origin = value(AUTH_KEYS.origin);
        if (!isHttpsOrigin(origin)) missing.push(AUTH_KEYS.origin);
    }
    if (missing.length > 0) return { ok: false, missing };
    return {
        ok: true,
        config: {
            clientId,
            clientSecret,
            authSecret,
            linkToken,
            target: rules.target,
            origin,
            dbName: STDB_DATABASES[rules.target],
            stdbHttpHost: stdbHttpHost(),
        },
    };
}
