/**
 * T-M5b: the local runner (scripts/local-auth/localAuth.ts), the dev plugin
 * (web/vite-plugin-local-auth.ts) and the preview server mount (scripts/preview/serve.mjs). Real
 * sockets on 127.0.0.1 port 0; the env file is a fixture written to a temporary folder; every
 * outbound fetch is stubbed.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, request, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createLocalAuth, STUB_ENV_KEY } from '../../../scripts/local-auth/localAuth';
import { createPreviewServer, loadVercelConfig } from '../../../scripts/preview/serve.mjs';
import { type LocalAuthRunner, localAuthPlugin } from '../../../web/vite-plugin-local-auth';

const REPO = fileURLToPath(new URL('../../..', import.meta.url));
const SECRET_VALUES = ['client-id-value', 'client-secret-value', 'xy'.repeat(20), 'link-token-value'];

const dirs: string[] = [];
function root(lines: string[] | null): string {
    const dir = mkdtempSync(join(tmpdir(), 'm5b-local-'));
    dirs.push(dir);
    if (lines) writeFileSync(join(dir, '.env.test.local'), `${lines.join('\n')}\n`);
    return dir;
}
const FULL = [
    `DISCORD_CLIENT_ID=${SECRET_VALUES[0]}`,
    `DISCORD_CLIENT_SECRET=${SECRET_VALUES[1]}`,
    `AUTH_SECRET=${SECRET_VALUES[2]}`,
    `STDB_LINK_TOKEN=${SECRET_VALUES[3]}`,
];
afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const servers: Server[] = [];
afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))));
});

function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<number> {
    const server = createServer(handler);
    servers.push(server);
    return new Promise((done) => server.listen(0, '127.0.0.1', () => done((server.address() as { port: number }).port)));
}

function send(port: number, path: string, init: { method?: string; headers?: Record<string, string>; body?: string; host?: string } = {}) {
    return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((done, fail) => {
        const req = request(
            { host: '127.0.0.1', port, path, method: init.method ?? 'GET', headers: { Host: init.host ?? `127.0.0.1:${port}`, ...init.headers } },
            (res) => {
                let body = '';
                res.on('data', (c) => (body += c));
                res.on('end', () => done({ status: res.statusCode ?? 0, headers: res.headers, body }));
            },
        );
        req.on('error', fail);
        if (init.body) req.write(init.body);
        req.end();
    });
}

const startInit = (port: number) => ({
    method: 'POST',
    headers: { Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ linkCode: 'A'.repeat(32) }),
});

function mount(auth: ReturnType<typeof createLocalAuth>) {
    return listen((req, res) => {
        if (!auth.handle(req, res)) {
            res.writeHead(418);
            res.end('not mine');
        }
    });
}

describe('local runner', () => {
    it('refuses the routes (503) when the target is not test, and leaves other paths alone', async () => {
        for (const target of ['prod', undefined, 'staging']) {
            const auth = createLocalAuth({ root: root(FULL), target, log: () => {} });
            expect(auth.banner.join(' ')).toMatch(/test database only/);
            const port = await mount(auth);
            const res = await send(port, '/api/auth/discord/start', startInit(port));
            expect(res.status).toBe(503);
            expect((await send(port, '/api/auth/discord/callback?code=x')).status).toBe(503);
            expect((await send(port, '/api/other')).status).toBe(418);
        }
    });

    it('names the missing keys (banner and start answer), never a value', async () => {
        const lines: string[] = [];
        const auth = createLocalAuth({ root: root([`AUTH_SECRET=${SECRET_VALUES[2]}`]), target: 'test', log: (l) => lines.push(l) });
        expect(auth.banner.join('\n')).toContain('missing DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, STDB_LINK_TOKEN');
        const port = await mount(auth);
        const res = await send(port, '/api/auth/discord/start', startInit(port));
        expect(res.status).toBe(500);
        const body = JSON.parse(res.body) as { error: string; missing: string[] };
        expect(body.error).toBe('not_configured');
        expect(body.missing).toEqual(['DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'STDB_LINK_TOKEN']);
        const all = [...auth.banner, ...lines, res.body].join('\n');
        expect(all).not.toContain(SECRET_VALUES[2]);
    });

    it('a missing .env.test.local is the same as every key missing', () => {
        const auth = createLocalAuth({ root: root(null), target: 'test', log: () => {} });
        expect(auth.banner.join('\n')).toContain('missing DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, AUTH_SECRET, STDB_LINK_TOKEN');
    });

    it('mounts start and callback with the file config, on the test database; other paths pass through', async () => {
        const auth = createLocalAuth({ root: root(FULL), target: 'test', log: () => {} });
        expect(auth.banner.some((l) => l.includes('missing'))).toBe(false);
        const port = await mount(auth);
        const res = await send(port, '/api/auth/discord/start', startInit(port));
        expect(res.status).toBe(200);
        const url = new URL((JSON.parse(res.body) as { url: string }).url);
        expect(url.origin).toBe('https://discord.com');
        expect(url.searchParams.get('client_id')).toBe(SECRET_VALUES[0]);
        expect(url.searchParams.get('redirect_uri')).toBe(`http://127.0.0.1:${port}/api/auth/discord/callback`);
        expect(String(res.headers['set-cookie'])).toMatch(/^__Host-hsr-auth-state=/);
        const cb = await send(port, '/api/auth/discord/callback');
        expect(cb.status).toBe(303);
        expect(cb.headers.location).toBe('/?login=1&status=failed');
        expect((await send(port, '/api/auth/discord/startx')).status).toBe(418);
        expect((await send(port, '/')).status).toBe(418);
    });

    it('answers only on a loopback Host', async () => {
        const auth = createLocalAuth({ root: root(FULL), target: 'test', log: () => {} });
        const port = await mount(auth);
        const res = await send(port, '/api/auth/discord/start', { ...startInit(port), host: 'evil.example' });
        expect(res.status).toBe(400);
    });

    it('the Discord stub is used only for a loopback http origin', async () => {
        const ignored = createLocalAuth({ root: root(FULL), target: 'test', shellEnv: { [STUB_ENV_KEY]: 'https://evil.example' }, log: () => {} });
        expect(ignored.banner.join('\n')).toContain('ignored');
        const used = createLocalAuth({ root: root(null), target: 'test', shellEnv: { [STUB_ENV_KEY]: 'http://127.0.0.1:4599' }, log: () => {} });
        // The stub fills throwaway Discord keys and AUTH_SECRET; only the link token is still missing.
        expect(used.banner.join('\n')).toContain('missing STDB_LINK_TOKEN');
        const auth = createLocalAuth({ root: root(FULL), target: 'test', shellEnv: { [STUB_ENV_KEY]: 'http://127.0.0.1:4599' }, log: () => {} });
        const port = await mount(auth);
        const res = await send(port, '/api/auth/discord/start', startInit(port));
        expect(new URL((JSON.parse(res.body) as { url: string }).url).origin).toBe('http://127.0.0.1:4599');
    });
});

describe('dev plugin (vite-plugin-local-auth)', () => {
    type Middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void;
    /** `load` undefined: the plugin's own loader (tsx's tsImport of scripts/local-auth/localAuth.ts). */
    async function setUp(env: Record<string, string>, dir: string, load?: () => Promise<LocalAuthRunner>) {
        const plugin = localAuthPlugin(dir, load);
        const logs: string[] = [];
        let middleware: Middleware | undefined;
        (plugin.configResolved as (c: unknown) => void)({ env });
        await (plugin.configureServer as (s: unknown) => Promise<void>)({
            config: { logger: { info: (l: string) => logs.push(l) } },
            middlewares: { use: (m: Middleware) => (middleware = m) },
        });
        return { plugin, logs, middleware: middleware as Middleware };
    }
    const injected = async () => ({ createLocalAuth }) as LocalAuthRunner;

    it('loads the runner only when the dev server starts (the plugin file imports nothing from scripts/)', async () => {
        let loads = 0;
        const plugin = localAuthPlugin(root(FULL), async () => {
            loads += 1;
            return { createLocalAuth } as LocalAuthRunner;
        });
        (plugin.configResolved as (c: unknown) => void)({ env: { VITE_STDB_TARGET: 'test' } });
        expect(loads).toBe(0);
        await (plugin.configureServer as (s: unknown) => Promise<void>)({
            config: { logger: { info: () => {} } },
            middlewares: { use: () => {} },
        });
        expect(loads).toBe(1);
        const source = readFileSync(join(REPO, 'web', 'vite-plugin-local-auth.ts'), 'utf8');
        const specifiers = [...source.matchAll(/\bfrom\s*['"]([^'"\n]+)['"]|\bimport\s*\(?\s*['"]([^'"\n]+)['"]/g)].map(
            ([, a, b]) => a ?? b,
        );
        expect(specifiers).toEqual(['node:http', 'vite', 'tsx/esm/api']);
    });
    const saved = process.env.VITE_STDB_TARGET;
    afterEach(() => {
        if (saved === undefined) delete process.env.VITE_STDB_TARGET;
        else process.env.VITE_STDB_TARGET = saved;
    });

    it('applies to the dev server only and mounts the routes for the test target', async () => {
        delete process.env.VITE_STDB_TARGET;
        // The plugin's own loader: the real runner through tsx.
        const { plugin, logs, middleware } = await setUp({ VITE_STDB_TARGET: 'test' }, root(FULL));
        expect(plugin.apply).toBe('serve');
        expect(logs.join('\n')).toContain('run the login function against the test database');
        const port = await listen((req, res) =>
            middleware(req, res, () => {
                res.writeHead(418);
                res.end();
            }),
        );
        expect((await send(port, '/api/auth/discord/start', startInit(port))).status).toBe(200);
        expect((await send(port, '/index.html')).status).toBe(418);
    });

    it('refuses the routes for another target and reports missing key names without values', async () => {
        delete process.env.VITE_STDB_TARGET;
        const refused = await setUp({ VITE_STDB_TARGET: 'prod' }, root(FULL), injected);
        const port = await listen((req, res) => refused.middleware(req, res, () => res.end()));
        expect((await send(port, '/api/auth/discord/start', startInit(port))).status).toBe(503);
        const missing = await setUp({ VITE_STDB_TARGET: 'test' }, root([`STDB_LINK_TOKEN=${SECRET_VALUES[3]}`]), injected);
        const text = missing.logs.join('\n');
        expect(text).toContain('missing DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, AUTH_SECRET');
        expect(text).not.toContain(SECRET_VALUES[3]);
    });
});

describe('preview server mount', () => {
    it('serves the two routes through the mount, with vercel.json headers; other /api paths stay 404', async () => {
        const auth = createLocalAuth({ root: root([`AUTH_SECRET=${SECRET_VALUES[2]}`]), target: 'test', log: () => {} });
        const server = createPreviewServer({ distDir: root(null), config: loadVercelConfig(REPO), log: () => {}, auth });
        servers.push(server);
        const port = await new Promise<number>((done) =>
            server.listen(0, '127.0.0.1', () => done((server.address() as { port: number }).port)),
        );
        const res = await send(port, '/api/auth/discord/start', startInit(port));
        expect(res.status).toBe(500);
        expect((JSON.parse(res.body) as { error: string }).error).toBe('not_configured');
        expect(res.headers['content-security-policy']).toContain("default-src 'self'");
        expect(res.headers['cache-control']).toBe('no-store');
        expect((await send(port, '/api/auth/discord/start')).status).toBe(405);
        expect((await send(port, '/api/other')).status).toBe(404);
    });
});
