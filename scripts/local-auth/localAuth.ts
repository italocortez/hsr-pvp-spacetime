// M5b: the login function on localhost, without Vercel. Used by the dev server (web/
// vite-plugin-local-auth.ts) and the local preview (scripts/preview/preview.mjs). It mounts
// exactly the two routes, runs the same handlers as the deployed function (api/_lib/handlers.ts)
// and loads their config from `.env.test.local` (never into the browser). Test database only.
//
// Dev-only stub (the M5b browser check): HSR_LOCAL_DISCORD_STUB=<http://127.0.0.1:port or
// http://localhost:port> in the shell points the Discord endpoints at a local stand-in and fills
// missing Discord keys and AUTH_SECRET with throwaway values. Only this file reads that variable;
// it lives under scripts/ (not uploaded to Vercel, not in the web bundle), and check:patterns
// gate 10 refuses the name anywhere under api/, web/src or web/dist.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { AUTH_KEYS, readAuthConfig } from '../../api/_lib/config.js';
import {
    type AuthDeps,
    defaultDeps,
    handleCallback,
    handleStart,
} from '../../api/_lib/handlers.js';
import { DISCORD_ENDPOINTS, type DiscordEndpoints } from '../../api/_lib/outbound.js';
import { AUTH_CALLBACK_PATH, AUTH_START_PATH } from '../../shared/auth-flow.js';
import { envFileFor, type Target } from '../../shared/stdb-targets.js';

export const STUB_ENV_KEY = 'HSR_LOCAL_DISCORD_STUB';
export const LOCAL_TARGET: Target = 'test';
const ROUTES = new Set([AUTH_START_PATH, AUTH_CALLBACK_PATH]);
const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1)(:[0-9]{1,5})?$/;
const LOOPBACK_ORIGIN = /^http:\/\/(localhost|127\.0\.0\.1):[0-9]{1,5}$/;

/** KEY=VALUE lines of a dotenv file (`#` comments; a missing file is empty). Values stay in memory. */
export function readEnvFileRecord(path: string): Record<string, string> {
    const out: Record<string, string> = {};
    if (!existsSync(path)) return out;
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed === '' || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq <= 0) continue;
        out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
    return out;
}

export interface LocalAuthOptions {
    /** Repository root: `.env.test.local` is read from here. */
    root: string;
    /** The app's database target (VITE_STDB_TARGET); anything but `test` refuses the routes. */
    target: string | undefined;
    /** The shell environment (only HSR_LOCAL_DISCORD_STUB is read from it). */
    shellEnv?: Readonly<Record<string, string | undefined>>;
    log?: (line: string) => void;
    /** Tests inject fetch; the default is the global one. */
    fetch?: AuthDeps['fetch'];
}

export interface LocalAuth {
    /** Lines to print at start: what runs, against which database, which key names are missing. */
    banner: string[];
    /** True when the request was one of the two routes (and is being answered). */
    handle(
        req: IncomingMessage,
        res: ServerResponse,
        extraHeaders?: Record<string, string>,
    ): boolean;
}

/** Builds the local mount. Never throws for a bad config: the routes answer the problem instead. */
export function createLocalAuth(options: LocalAuthOptions): LocalAuth {
    const log = options.log ?? ((line: string) => console.log(line));
    if (options.target !== LOCAL_TARGET) {
        const text = `Local sign-in runs against the test database only; the app's target is ${options.target === undefined ? 'unset' : `"${options.target}"`}. The routes are refused.`;
        return {
            banner: [text],
            handle(req, res) {
                if (!ROUTES.has(pathOf(req))) return false;
                log(`[auth] local: refused (target)`);
                res.writeHead(503, {
                    'Content-Type': 'text/plain; charset=utf-8',
                    'Cache-Control': 'no-store',
                });
                res.end(`${text}\n`);
                return true;
            },
        };
    }

    const fileEnv = readEnvFileRecord(join(options.root, envFileFor(LOCAL_TARGET)));
    const env: Record<string, string | undefined> = {
        [AUTH_KEYS.clientId]: fileEnv[AUTH_KEYS.clientId],
        [AUTH_KEYS.clientSecret]: fileEnv[AUTH_KEYS.clientSecret],
        [AUTH_KEYS.authSecret]: fileEnv[AUTH_KEYS.authSecret],
        [AUTH_KEYS.linkToken]: fileEnv[AUTH_KEYS.linkToken],
        [AUTH_KEYS.target]: LOCAL_TARGET,
    };
    const banner: string[] = [
        `Local sign-in: ${AUTH_START_PATH} and ${AUTH_CALLBACK_PATH} run the login function against the test database (config from ${envFileFor(LOCAL_TARGET)}).`,
    ];

    let discord: DiscordEndpoints = DISCORD_ENDPOINTS;
    const stub = options.shellEnv?.[STUB_ENV_KEY];
    if (stub !== undefined && stub !== '') {
        if (!LOOPBACK_ORIGIN.test(stub)) {
            banner.push(
                `${STUB_ENV_KEY} ignored: it must be http://127.0.0.1:<port> or http://localhost:<port>.`,
            );
        } else {
            discord = {
                authorize: `${stub}/oauth2/authorize`,
                token: `${stub}/api/v10/oauth2/token`,
                me: `${stub}/api/v10/users/@me`,
            };
            if (!env[AUTH_KEYS.clientId]?.trim()) env[AUTH_KEYS.clientId] = 'stub-client-id';
            if (!env[AUTH_KEYS.clientSecret]?.trim()) {
                env[AUTH_KEYS.clientSecret] = 'stub-client-secret';
            }
            const secret = (env[AUTH_KEYS.authSecret] ?? '').trim();
            if (secret.length < 32 || new Set(secret).size === 1) {
                env[AUTH_KEYS.authSecret] = randomBytes(32).toString('base64url');
            }
            banner.push(
                `DISCORD STUB: Discord is replaced by ${stub} (local check only; the module call is real).`,
            );
        }
    }

    const configured = readAuthConfig(env, { target: LOCAL_TARGET, requireOrigin: false });
    if (!configured.ok) {
        banner.push(
            `Local sign-in is not configured: missing ${configured.missing.join(', ')} in ${envFileFor(LOCAL_TARGET)}.`,
        );
    }

    const deps: AuthDeps = {
        ...defaultDeps(env, discord),
        log,
        target: LOCAL_TARGET,
        local: true,
        ...(options.fetch ? { fetch: options.fetch } : {}),
    };

    return {
        banner,
        handle(req, res, extraHeaders = {}) {
            const path = pathOf(req);
            if (!ROUTES.has(path)) return false;
            void answer(req, res, path, deps, extraHeaders, log);
            return true;
        },
    };
}

function pathOf(req: IncomingMessage): string {
    const raw = req.url ?? '';
    const q = raw.indexOf('?');
    return q < 0 ? raw : raw.slice(0, q);
}

async function answer(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    deps: AuthDeps,
    extraHeaders: Record<string, string>,
    log: (line: string) => void,
): Promise<void> {
    try {
        const host = req.headers.host ?? '';
        if (!LOOPBACK_HOST.test(host)) {
            res.writeHead(400, {
                'Content-Type': 'text/plain; charset=utf-8',
                'Cache-Control': 'no-store',
            });
            res.end('The local sign-in answers on localhost or 127.0.0.1 only.\n');
            return;
        }
        const request = await toRequest(req, `http://${host}`);
        const response =
            path === AUTH_START_PATH
                ? await handleStart(request, deps)
                : await handleCallback(request, deps);
        await send(res, response, extraHeaders);
    } catch {
        log('[auth] local: failed (internal)');
        if (!res.headersSent) {
            res.writeHead(500, {
                'Content-Type': 'text/plain; charset=utf-8',
                'Cache-Control': 'no-store',
            });
        }
        res.end('Internal error.\n');
    }
}

const MAX_BODY = 16 * 1024;

async function toRequest(req: IncomingMessage, origin: string): Promise<Request> {
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) for (const v of value) headers.append(key, v);
        else headers.set(key, value);
    }
    const method = req.method ?? 'GET';
    let body: Buffer | undefined;
    if (method !== 'GET' && method !== 'HEAD') {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
            const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
            size += buf.length;
            if (size > MAX_BODY) break;
            chunks.push(buf);
        }
        body = Buffer.concat(chunks);
    }
    return new Request(new URL(req.url ?? '/', origin), {
        method,
        headers,
        ...(body !== undefined ? { body: new Uint8Array(body) } : {}),
    });
}

async function send(
    res: ServerResponse,
    response: Response,
    extraHeaders: Record<string, string>,
): Promise<void> {
    const headers: Record<string, string | string[]> = { ...extraHeaders };
    response.headers.forEach((value, key) => {
        if (key !== 'set-cookie') headers[key] = value;
    });
    const cookies = response.headers.getSetCookie();
    if (cookies.length > 0) headers['set-cookie'] = cookies;
    const buffer = Buffer.from(await response.arrayBuffer());
    headers['content-length'] = String(buffer.length);
    res.writeHead(response.status, headers);
    res.end(buffer);
}
