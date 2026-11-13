// T-M8: scripts/preview/serve.mjs and preview.mjs, the local preview of the built app.
//
// Loopback only: these tests start the real server on 127.0.0.1, port 0 (a free port the OS picks), and send requests
// to it with node:http and node:net from the same process. Nothing leaves the machine, so this is not "the network" of
// the no-network rule of `npm test` (CLAUDE.md §6, test/README.md). No maincloud and no real build: the dist folders
// and the fake build scripts are fixtures written by this file into the OS temp folder and removed after the run.
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    utimesSync,
    writeFileSync,
} from 'node:fs';
import { request, type Server } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
    checkBundleTarget,
    createBundleGuard,
    parseArgs,
    readBundleTarget,
    runPreview,
} from '../../../scripts/preview/preview.mjs';
import {
    API_NOTE,
    createPreviewServer,
    safeFile,
    startPreviewServer,
} from '../../../scripts/preview/serve.mjs';
import { STDB_DATABASES } from '../../../shared/stdb-targets';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const VERCEL_TEXT = readFileSync(join(REPO, 'vercel.json'), 'utf8');
const VERCEL = JSON.parse(VERCEL_TEXT);
const SECRET = 'outside-dist-secret';
const STATUS_ON_DISK = '{ "maintenance": false }\n';

/** A bundle line the way Vite inlines import.meta.env, plus the database map of shared/stdb-targets.ts. */
const bundle = (target: string) =>
    `var a={test:\`${STDB_DATABASES.test}\`,prod:\`${STDB_DATABASES.prod}\`};` +
    `f({BASE_URL:\`/\`,DEV:!1,MODE:\`production\`,PROD:!0,SSR:!1,VITE_STDB_TARGET:\`${target}\`});`;

let tmp: string;

/** A fake repo root: vercel.json, web/dist with one file per served type, a secret just outside dist. */
function makeRoot(
    name: string,
    target: string | null,
    vercel: string = VERCEL_TEXT,
): { root: string; dist: string } {
    const root = join(tmp, name);
    const dist = join(root, 'web', 'dist');
    mkdirSync(join(dist, 'assets'), { recursive: true });
    mkdirSync(join(dist, 'elements'), { recursive: true });
    mkdirSync(join(root, 'outside'), { recursive: true });
    writeFileSync(join(root, 'vercel.json'), vercel);
    writeFileSync(join(root, 'package.json'), SECRET);
    writeFileSync(join(root, 'outside', 'secret.txt'), SECRET);
    writeFileSync(join(root, 'web', 'package.json'), SECRET);
    writeFileSync(join(dist, 'index.html'), '<!doctype html><title>app</title>');
    writeFileSync(join(dist, 'status.json'), STATUS_ON_DISK);
    if (target !== null) writeFileSync(join(dist, 'assets', 'index-abc.js'), bundle(target));
    writeFileSync(join(dist, 'assets', 'index-abc.css'), 'a{}');
    writeFileSync(join(dist, 'assets', 'index-abc.js.map'), '{}');
    writeFileSync(join(dist, 'elements', 'fire.webp'), 'w');
    for (const ext of [
        'woff2',
        'woff',
        'jpg',
        'jpeg',
        'gif',
        'avif',
        'wasm',
        'webmanifest',
        'bin',
    ]) {
        writeFileSync(join(dist, 'assets', `file.${ext}`), 'x');
    }
    writeFileSync(join(dist, 'robots.txt'), 'User-agent: *');
    writeFileSync(join(dist, 'favicon.svg'), '<svg/>');
    writeFileSync(join(dist, 'favicon.ico'), 'i');
    writeFileSync(join(dist, 'standby.webp'), 'w');
    writeFileSync(join(dist, 'logo.png'), 'p');
    writeFileSync(join(dist, 'assets', 'UPPER.PNG'), 'p');
    writeFileSync(join(dist, 'assets', 'Mixed.WebP'), 'w');
    return { root, dist };
}

/** A directory link that needs no privilege: a junction on Windows, a symlink elsewhere. False if refused. */
function linkDir(target: string, path: string): boolean {
    try {
        symlinkSync(target, path, 'junction');
        return true;
    } catch {
        return false;
    }
}

interface Answer {
    status: number;
    headers: Record<string, string | string[] | undefined>;
    body: string;
}

/** One request with the path sent exactly as written (no client-side normalisation of `..`). */
function send(port: number, path: string, method = 'GET'): Promise<Answer> {
    return new Promise((done, fail) => {
        const req = request({ host: '127.0.0.1', port, path, method }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => {
                body += chunk;
            });
            res.on('end', () => done({ status: res.statusCode ?? 0, headers: res.headers, body }));
        });
        req.on('error', fail);
        req.end();
    });
}

/** The raw bytes of one HTTP/1.1 exchange over a socket (no client library in between). */
function raw(port: number, head: string): Promise<string> {
    return new Promise((done, fail) => {
        const socket = connect(port, '127.0.0.1', () => socket.write(head));
        let data = '';
        socket.setEncoding('latin1');
        socket.on('data', (chunk) => {
            data += chunk;
        });
        socket.on('end', () => done(data));
        socket.on('error', fail);
    });
}

const close = (server: Server) =>
    new Promise<void>((done) => {
        server.close(() => done());
        server.closeAllConnections();
    });

/** Starts a server on port 0 for one test and closes it afterwards. */
async function withServer(
    options: Parameters<typeof startPreviewServer>[0],
    body: (port: number) => Promise<void>,
) {
    const { server, port } = await startPreviewServer({ log: () => {}, ...options, port: 0 });
    try {
        await body(port);
    } finally {
        await close(server);
    }
}

beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'hsr-m8-preview-'));
});
afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
});

describe('T-M8 safeFile: a decoded path never leaves dist and must name the file exactly', () => {
    it('finds files inside dist and refuses everything that climbs out', () => {
        const { dist } = makeRoot('safe', 'test');
        expect(safeFile(dist, '/index.html')).toBe(join(dist, 'index.html'));
        expect(safeFile(dist, '/assets/index-abc.js')).toBe(join(dist, 'assets', 'index-abc.js'));
        for (const path of [
            '/../package.json',
            '/../../package.json',
            '/assets/../../package.json',
            '/assets/../../../package.json',
            '/..\\package.json',
            '/assets/..\\..\\package.json',
            '/index.html\0',
            '/',
            '/assets',
            '/missing.txt',
        ]) {
            expect(safeFile(dist, path), path).toBeNull();
        }
    });

    it('exact case on every platform; no ":" (Windows stream names) and no "\\"', () => {
        const { dist } = makeRoot('case', 'test');
        for (const path of [
            '/INDEX.HTML',
            '/Index.html',
            '/Assets/index-abc.js',
            '/assets/INDEX-ABC.JS',
            '/STATUS.JSON',
            '/index.html::$DATA',
            '/index.html:x',
            '/assets/..\\index.html',
            '/assets\\index-abc.js',
        ]) {
            expect(safeFile(dist, path), path).toBeNull();
        }
    });

    it('a symlink or junction inside dist that points outside is refused (the real-path check)', (ctx) => {
        const { root, dist } = makeRoot('link-out', 'test');
        if (!linkDir(join(root, 'outside'), join(dist, 'out'))) ctx.skip();
        // Lexically inside dist; only the real path shows it leaves.
        expect(safeFile(dist, '/out/secret.txt')).toBeNull();
    });

    it('a dist reached through a link: a lexical climb out of the link is refused (the lexical check)', (ctx) => {
        const { root, dist } = makeRoot('link-root', 'test');
        const linked = join(root, 'dist-link');
        if (!linkDir(dist, linked)) ctx.skip();
        expect(safeFile(linked, '/index.html')).toBe(join(linked, 'index.html'));
        // Its real location is inside dist, but the request climbs out of the served folder.
        expect(safeFile(linked, '/../dist/index.html')).toBeNull();
    });

    it('a junction or symlink loop is "not a file" and does not throw', (ctx) => {
        const { dist } = makeRoot('loop', 'test');
        const a = join(dist, 'loopA');
        const b = join(dist, 'loopB');
        if (!linkDir(b, a) || !linkDir(a, b)) ctx.skip();
        expect(() => safeFile(dist, '/loopA/x.txt')).not.toThrow();
        expect(safeFile(dist, '/loopA/x.txt')).toBeNull();
        expect(safeFile(dist, '/loopA')).toBeNull();
    });
});

describe('T-M8 the preview server on 127.0.0.1 (loopback only)', () => {
    let server: Server;
    let port: number;
    let dist: string;
    const lines: string[] = [];

    beforeAll(async () => {
        ({ dist } = makeRoot('serve', 'test'));
        ({ server, port } = await startPreviewServer({
            distDir: dist,
            config: VERCEL,
            port: 0,
            log: (line) => lines.push(line),
        }));
    });
    afterAll(() => close(server));

    it('binds 127.0.0.1 only', () => {
        const address = server.address();
        expect(typeof address === 'object' && address?.address).toBe('127.0.0.1');
    });

    it.each([
        ['/', 200, 'text/html; charset=utf-8', 'public, max-age=0, must-revalidate'],
        ['/lobby/123', 200, 'text/html; charset=utf-8', 'public, max-age=0, must-revalidate'],
        ['/costs', 200, 'text/html; charset=utf-8', 'public, max-age=0, must-revalidate'],
        [
            '/assets/index-abc.js',
            200,
            'text/javascript; charset=utf-8',
            'public, max-age=31536000, immutable',
        ],
        ['/status.json', 200, 'application/json; charset=utf-8', 'no-store'],
        [
            '/assets/missing.js',
            404,
            'text/plain; charset=utf-8',
            'public, max-age=31536000, immutable',
        ],
        ['/foo.png', 404, 'text/plain; charset=utf-8', undefined],
        ['/.env', 404, 'text/plain; charset=utf-8', undefined],
        ['/.well-known/security.txt', 404, 'text/plain; charset=utf-8', undefined],
        ['/a/.b/c', 404, 'text/plain; charset=utf-8', undefined],
    ])('%s answers %i (%s, cache %s), with the CSP', async (path, status, type, cache) => {
        const res = await send(port, path);
        expect(res.status).toBe(status);
        expect(res.headers['content-type']).toBe(type);
        expect(res.headers['cache-control']).toBe(cache);
        expect(res.headers['content-security-policy']).toContain("default-src 'self'");
        expect(res.headers['x-content-type-options']).toBe('nosniff');
    });

    it('a deep link gets the app page itself', async () => {
        expect((await send(port, '/lobby/123')).body).toContain('<title>app</title>');
    });

    it('/status.json without --maintenance is the file on disk', async () => {
        expect((await send(port, '/status.json')).body).toBe(STATUS_ON_DISK);
    });

    it('/api/* is a 404 with a note that functions do not run here; /api itself follows the rules', async () => {
        const res = await send(port, '/api/auth/discord/callback');
        expect(res.status).toBe(404);
        expect(res.body).toBe(API_NOTE);
        // The header rules that match its path still apply (the catch-all security headers).
        expect(res.headers['content-security-policy']).toContain("default-src 'self'");
        expect(res.headers['x-content-type-options']).toBe('nosniff');
        expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
        expect((await send(port, '/api/')).body).toBe(API_NOTE);
        const bare = await send(port, '/api');
        expect(bare.status).toBe(200);
        expect(bare.body).toContain('<title>app</title>');
    });

    it.each([
        ['/assets/index-abc.css', 'text/css; charset=utf-8'],
        ['/assets/index-abc.js.map', 'application/json; charset=utf-8'],
        ['/assets/file.woff2', 'font/woff2'],
        ['/assets/file.woff', 'font/woff'],
        ['/assets/file.jpg', 'image/jpeg'],
        ['/assets/file.jpeg', 'image/jpeg'],
        ['/assets/file.gif', 'image/gif'],
        ['/assets/file.avif', 'image/avif'],
        ['/assets/file.wasm', 'application/wasm'],
        ['/assets/file.webmanifest', 'application/manifest+json; charset=utf-8'],
        ['/assets/file.bin', 'application/octet-stream'],
        ['/robots.txt', 'text/plain; charset=utf-8'],
        ['/favicon.svg', 'image/svg+xml'],
        ['/favicon.ico', 'image/x-icon'],
        ['/standby.webp', 'image/webp'],
        ['/logo.png', 'image/png'],
        ['/assets/UPPER.PNG', 'image/png'],
        ['/assets/Mixed.WebP', 'image/webp'],
    ])('content type of %s (extension looked up in lower case)', async (path, type) => {
        const res = await send(port, path);
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toBe(type);
    });

    it.each([
        '/../package.json',
        '/%2e%2e/package.json',
        '/assets/..%2f..%2fpackage.json',
        '/assets/..%2f..%2f..%2fpackage.json',
        '/assets/..%5c..%5cpackage.json',
        '/%2e%2e/%2e%2e/package.json',
    ])('path traversal stays inside dist: %s', async (path) => {
        const res = await send(port, path);
        expect(res.status).toBe(404);
        expect(res.body).not.toContain(SECRET);
    });

    it.each([
        ['/INDEX.HTML', 404],
        ['/Assets/index-abc.js', 404],
        ['/assets/INDEX-ABC.JS', 404],
        ['/index.html::$DATA', 404],
        ['/assets/..%5cindex.html', 404],
        ['/STATUS.JSON', 404],
        ['/Lobby/123', 200],
    ])(
        'a case variant or a stream name is not the file, it follows the rules: %s is %i',
        async (path, status) => {
            const res = await send(port, path);
            expect(res.status).toBe(status);
            if (status === 200) expect(res.body).toContain('<title>app</title>');
            else expect(res.body).toBe('404 not found\n');
        },
    );

    it('a directory is not a file: /elements and /elements/ load the app, /assets/ is a 404', async () => {
        for (const path of ['/elements', '/elements/']) {
            const res = await send(port, path);
            expect(res.status, path).toBe(200);
            expect(res.body).toContain('<title>app</title>');
        }
        expect((await send(port, '/assets/')).status).toBe(404);
        expect((await send(port, '/elements/fire.webp')).status).toBe(200);
    });

    it('a malformed escape is a 400', async () => {
        expect((await send(port, '/%E0%A4%A')).status).toBe(400);
    });

    it.each([
        '//evil.example/x',
        'http://evil.example/index.html',
        '*',
        '/\\evil.example/index.html',
        '/assets\\index-abc.js',
        '/index.html\\',
    ])('an absolute or protocol-relative request target is a 400: %s', async (target) => {
        const answer = await raw(
            port,
            `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`,
        );
        expect(answer.startsWith('HTTP/1.1 400')).toBe(true);
    });

    it('HEAD sends the headers and no body bytes (raw socket); other methods are 405', async () => {
        const answer = await raw(
            port,
            'HEAD / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n',
        );
        const [head, rest] = answer.split('\r\n\r\n');
        expect(head.startsWith('HTTP/1.1 200')).toBe(true);
        expect(Number(/content-length: (\d+)/i.exec(head)?.[1])).toBeGreaterThan(0);
        expect(rest).toBe('');
        const post = await send(port, '/', 'POST');
        expect(post.status).toBe(405);
        expect(post.headers.allow).toBe('GET, HEAD');
    });

    it('logs one line per request: method, path, status', async () => {
        lines.length = 0;
        await send(port, '/foo.png');
        expect(lines).toEqual(['GET /foo.png 404']);
    });

    it('a taken port is refused with a clear message', async () => {
        await expect(
            startPreviewServer({ distDir: dist, config: VERCEL, port, log: () => {} }),
        ).rejects.toThrow(new RegExp(`Port ${port} on 127\\.0\\.0\\.1 is taken.*--port`));
    });
});

describe('T-M8 a request never kills the server', () => {
    it('a read that fails after the file check answers 500, and the next request is served', async () => {
        const { dist } = makeRoot('read-fails', 'test');
        let failNext = true;
        const readFile = (path: string) => {
            if (failNext) {
                failNext = false;
                throw Object.assign(new Error('ENOENT: gone between the check and the read'), {
                    code: 'ENOENT',
                });
            }
            return readFileSync(path);
        };
        await withServer({ distDir: dist, config: VERCEL, readFile }, async (port) => {
            const first = await send(port, '/robots.txt');
            expect(first.status).toBe(500);
            expect(first.body).toMatch(/gone between the check and the read/);
            const next = await send(port, '/robots.txt');
            expect(next.status).toBe(200);
            expect(next.body).toBe('User-agent: *');
        });
    });

    it('a guard that throws answers 500 and the server lives', async () => {
        const { dist } = makeRoot('guard-throws', 'test');
        let calls = 0;
        const guard = () => {
            calls++;
            if (calls === 1) throw new Error('guard broke');
            return null;
        };
        await withServer({ distDir: dist, config: VERCEL, guard }, async (port) => {
            expect((await send(port, '/')).status).toBe(500);
            expect((await send(port, '/')).status).toBe(200);
        });
    });

    it('a request into a junction or symlink loop is a 404, and the server answers the next request', async (ctx) => {
        const { dist } = makeRoot('loop-server', 'test');
        const a = join(dist, 'loopA');
        const b = join(dist, 'loopB');
        if (!linkDir(b, a) || !linkDir(a, b)) ctx.skip();
        await withServer({ distDir: dist, config: VERCEL }, async (port) => {
            expect((await send(port, '/loopA/x.js')).status).toBe(404);
            expect((await send(port, '/loopA/loopB/loopA/x.js')).status).toBe(404);
            expect((await send(port, '/robots.txt')).status).toBe(200);
        });
    });

    it('createPreviewServer compiles the rules at once (a bad config throws before listening)', () => {
        expect(() =>
            createPreviewServer({ distDir: tmp, config: { routes: [] }, log: () => {} }),
        ).toThrow(/"routes" is not supported/);
    });
});

describe('T-M8 headers come from the request path, not the rewrite destination', () => {
    it('a rewritten route gets the rules of its own path', async () => {
        const config = {
            rewrites: [{ source: '/app/(.*)', destination: '/index.html' }],
            headers: [
                {
                    source: '/index.html',
                    headers: [
                        { key: 'X-Which', value: 'destination' },
                        { key: 'Cache-Control', value: 'no-cache' },
                    ],
                },
                { source: '/app/(.*)', headers: [{ key: 'X-Which', value: 'request' }] },
            ],
        };
        const { dist } = makeRoot('request-path', 'test', JSON.stringify(config));
        await withServer({ distDir: dist, config }, async (port) => {
            const routed = await send(port, '/app/1');
            expect(routed.status).toBe(200);
            expect(routed.body).toContain('<title>app</title>');
            expect(routed.headers['x-which']).toBe('request');
            expect(routed.headers['cache-control']).toBe('public, max-age=0, must-revalidate');
            const direct = await send(port, '/index.html');
            expect(direct.headers['x-which']).toBe('destination');
            expect(direct.headers['cache-control']).toBe('no-cache');
        });
    });
});

describe('T-M8 maintenance rehearsal: /status.json from memory', () => {
    it('answers { "maintenance": true } no-store and leaves the file in dist untouched', async () => {
        const { dist } = makeRoot('maintenance', 'test');
        await withServer({ distDir: dist, config: VERCEL, maintenance: true }, async (port) => {
            const res = await send(port, '/status.json');
            expect(res.status).toBe(200);
            expect(JSON.parse(res.body)).toEqual({ maintenance: true });
            expect(res.headers['cache-control']).toBe('no-store');
            expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
            expect(readFileSync(join(dist, 'status.json'), 'utf8')).toBe(STATUS_ON_DISK);
            // A case variant cannot reach the disk file.
            for (const variant of ['/STATUS.JSON', '/Status.json', '/status.json::$DATA']) {
                const other = await send(port, variant);
                expect(other.status, variant).toBe(404);
                expect(other.body).not.toContain('false');
            }
        });
    });
});

describe('T-M8 the preview is test-only', () => {
    const quiet = () => {
        const err: string[] = [];
        const out: string[] = [];
        return {
            err,
            out,
            io: { out: (line: string) => out.push(line), err: (line: string) => err.push(line) },
        };
    };
    const saved = process.env.VITE_STDB_TARGET;
    afterEach(() => {
        if (saved === undefined) delete process.env.VITE_STDB_TARGET;
        else process.env.VITE_STDB_TARGET = saved;
    });

    /** A fake root whose buildCommand is a tiny node script writing a bundle for the child's target, or `forced`. */
    function fakeBuildRoot(name: string, forced?: string, extra: object = {}) {
        const { root } = makeRoot(name, null, JSON.stringify({ ...VERCEL, ...extra }));
        rmSync(join(root, 'web', 'dist'), { recursive: true, force: true });
        const script = [
            "import { mkdirSync, writeFileSync } from 'node:fs';",
            `const target = ${forced === undefined ? 'process.env.VITE_STDB_TARGET' : JSON.stringify(forced)};`,
            "mkdirSync('web/dist/assets', { recursive: true });",
            "writeFileSync('web/dist/index.html', '<!doctype html><title>built</title>');",
            `writeFileSync('web/dist/assets/index.js', ${JSON.stringify(bundle('@@'))}.replace('@@', target));`,
            "writeFileSync('web/dist/built-target.txt', String(target));",
        ].join('\n');
        writeFileSync(join(root, 'build.mjs'), script);
        const config = { ...VERCEL, buildCommand: 'node build.mjs', ...extra };
        writeFileSync(join(root, 'vercel.json'), JSON.stringify(config));
        return root;
    }

    it('reads the target from the inlined env object; the names alone are in every bundle', () => {
        expect(readBundleTarget([bundle('test')])).toEqual({
            targets: ['test'],
            testNameMapped: true,
        });
        expect(readBundleTarget([bundle('prod')])).toEqual({
            targets: ['prod'],
            testNameMapped: true,
        });
        expect(readBundleTarget([bundle('test'), bundle('prod')]).targets).toEqual([
            'prod',
            'test',
        ]);
        expect(readBundleTarget(['"VITE_STDB_TARGET": "test"']).targets).toEqual(['test']);
        expect(readBundleTarget(['no marker']).targets).toEqual([]);
    });

    it('the build runs with VITE_STDB_TARGET=test in the child even when the parent says prod, then serves', async () => {
        process.env.VITE_STDB_TARGET = 'prod';
        const root = fakeBuildRoot('build-test');
        const { io, err } = quiet();
        const result = await runPreview([], { root, ...io, port: 0 });
        try {
            expect(err).toEqual([]);
            expect(result.code).toBe(0);
            expect(readFileSync(join(root, 'web', 'dist', 'built-target.txt'), 'utf8')).toBe(
                'test',
            );
            const port = result.port as number;
            const page = await send(port, '/');
            expect(page.status).toBe(200);
            expect(page.body).toContain('<title>built</title>');
        } finally {
            if (result.server) await close(result.server);
        }
    });

    it('a build that writes a prod bundle: exit code 1, nothing served', async () => {
        const root = fakeBuildRoot('build-prod', 'prod');
        const { io, err } = quiet();
        const result = await runPreview([], { root, ...io, port: 0 });
        expect(result.code).toBe(1);
        expect(result.server).toBeUndefined();
        expect(err.join('\n')).toMatch(/targets prod \(hsr-spacetimedb-prod\)/);
    });

    it('vercel.json is compiled before the build: unsupported syntax stops it before anything runs', async () => {
        const root = fakeBuildRoot('build-bad-rules', undefined, { redirects: [] });
        const { io, err } = quiet();
        const result = await runPreview([], { root, ...io, port: 0 });
        expect(result.code).toBe(1);
        expect(err.join('\n')).toMatch(/"redirects" is not supported/);
        expect(() => readFileSync(join(root, 'web', 'dist', 'built-target.txt'))).toThrow();
    });

    it('a missing buildCommand is a clear error (and --no-build does not need one)', async () => {
        const noBuild = { ...VERCEL };
        delete noBuild.buildCommand;
        const { root } = makeRoot('no-build-command', 'test', JSON.stringify(noBuild));
        const first = quiet();
        expect((await runPreview([], { root, ...first.io, port: 0 })).code).toBe(1);
        expect(first.err.join('\n')).toMatch(/no "buildCommand"/);
        const second = quiet();
        const served = await runPreview(['--no-build'], { root, ...second.io, port: 0 });
        try {
            expect(served.code).toBe(0);
        } finally {
            if (served.server) await close(served.server);
        }
    });

    it('a bundle marked prod: --no-build exits 1 with the refusal message, no server', async () => {
        const { root, dist } = makeRoot('prod-bundle', 'prod');
        expect(checkBundleTarget(dist)).toMatch(/targets prod \(hsr-spacetimedb-prod\)/);
        const { err, io } = quiet();
        const result = await runPreview(['--no-build'], { root, ...io, port: 0 });
        expect(result.code).toBe(1);
        expect(result.server).toBeUndefined();
        expect(err.join('\n')).toMatch(
            /Refusing to serve: the bundle .* targets prod \(hsr-spacetimedb-prod\)/,
        );
    });

    it('a bundle with both targets, no marker, no bundle, or no test name is refused too (fails closed)', () => {
        const mixed = makeRoot('mixed', 'test');
        writeFileSync(join(mixed.dist, 'assets', 'other.js'), bundle('prod'));
        expect(checkBundleTarget(mixed.dist)).toMatch(/targets prod/);

        const unmarked = makeRoot('unmarked', null);
        writeFileSync(join(unmarked.dist, 'assets', 'index.js'), 'console.log(1)');
        expect(checkBundleTarget(unmarked.dist)).toMatch(/no VITE_STDB_TARGET marker/);

        const empty = makeRoot('empty', null);
        expect(checkBundleTarget(empty.dist)).toMatch(/holds no built bundle/);

        const noName = makeRoot('no-name', null);
        writeFileSync(join(noName.dist, 'assets', 'index.js'), 'f({VITE_STDB_TARGET:`test`})');
        expect(checkBundleTarget(noName.dist)).toMatch(/does not map the test target/);
    });

    it('while running: a bundle swapped to prod makes the app page 503 until the bundle is test again', async () => {
        const { root, dist } = makeRoot('swap', 'test');
        const js = join(dist, 'assets', 'index-abc.js');
        const result = await runPreview(['--no-build'], { root, ...quiet().io, port: 0 });
        expect(result.code).toBe(0);
        const port = result.port as number;
        try {
            expect((await send(port, '/')).status).toBe(200);

            writeFileSync(js, bundle('prod'));
            for (const path of ['/', '/index.html', '/lobby/1']) {
                const res = await send(port, path);
                expect(res.status, path).toBe(503);
                expect(res.body).toMatch(/targets prod \(hsr-spacetimedb-prod\)/);
                expect(res.headers['cache-control']).toBe('no-store');
            }
            expect((await send(port, '/')).status).toBe(503); // keeps refusing

            writeFileSync(js, bundle('test'));
            expect((await send(port, '/')).status).toBe(200);
        } finally {
            if (result.server) await close(result.server);
        }
    });

    it('the guard runs the full check on every call: a change with the same size and mtime is still seen', () => {
        const { dist } = makeRoot('guard-every-call', 'test');
        const js = join(dist, 'assets', 'index-abc.js');
        const fixed = new Date('2026-01-01T00:00:00Z');
        utimesSync(js, fixed, fixed);
        const guard = createBundleGuard(dist);
        expect(guard()).toBeNull();
        writeFileSync(js, bundle('prod')); // same size as the test bundle
        utimesSync(js, fixed, fixed); // and the same mtime
        expect(guard()).toMatch(/targets prod/);
    });

    it('an unreadable or missing dist fails closed, at start and while running', () => {
        const missing = join(tmp, 'no-such-root', 'web', 'dist');
        expect(checkBundleTarget(missing)).toMatch(/cannot be read \(ENOENT\)/);
        expect(createBundleGuard(missing)()).toMatch(/Refusing to serve/);
        const { dist } = makeRoot('vanishing', 'test');
        const guard = createBundleGuard(dist);
        expect(guard()).toBeNull();
        rmSync(dist, { recursive: true, force: true });
        expect(guard()).toMatch(/cannot be read/);
    });

    it.each([
        ['assets/chunk.mjs'],
        ['assets/chunk.cjs'],
        ['assets/CHUNK.JS'],
        ['assets/chunk.MJS'],
        ['index.html'],
        ['other.HTML'],
    ])('a prod marker in %s is found (js, mjs, cjs, html; extension without case)', (file) => {
        const { dist } = makeRoot(
            `marker-${file.replace(/[/.]/g, '-')}-${file === file.toLowerCase() ? 'l' : 'u'}`,
            'test',
        );
        writeFileSync(join(dist, file), `<script>${bundle('prod')}</script>`);
        expect(checkBundleTarget(dist)).toMatch(/targets prod/);
        expect(createBundleGuard(dist)()).toMatch(/targets prod/);
    });

    it('--maintenance is passed through: the served /status.json says true; without it, the disk file', async () => {
        for (const [argv, body] of [
            [['--no-build', '--maintenance'], '{ "maintenance": true }\n'],
            [['--no-build'], STATUS_ON_DISK],
        ] as const) {
            const { root } = makeRoot(`pass-${argv.length}`, 'test');
            const result = await runPreview([...argv], { root, ...quiet().io, port: 0 });
            try {
                expect(result.code).toBe(0);
                expect((await send(result.port as number, '/status.json')).body).toBe(body);
            } finally {
                if (result.server) await close(result.server);
            }
        }
    });

    it('the banner names the test database and says it is not Vercel', async () => {
        const { root } = makeRoot('banner', 'test');
        const q = quiet();
        const result = await runPreview(['--no-build', '--maintenance'], {
            root,
            ...q.io,
            port: 0,
        });
        try {
            const banner = q.out.join('\n');
            expect(banner).toContain(`Database: test (${STDB_DATABASES.test})`);
            expect(banner).toContain("imitates Vercel's rules; it is not Vercel");
            expect(banner).toContain('MAINTENANCE REHEARSAL');
            expect(banner).toMatch(/http:\/\/127\.0\.0\.1:\d+\//);
        } finally {
            if (result.server) await close(result.server);
        }
    });

    it.each([
        ['--target', 'prod'],
        ['--target=prod'],
        ['--target=test'],
        ['--prod'],
        ['--env', 'prod'],
    ])('there is no target flag: %s is refused with exit code 2', async (...argv) => {
        expect(parseArgs(argv)).toEqual({
            error: 'The preview runs against the test database only; there is no target flag.',
        });
        expect((await runPreview(argv, { root: tmp, ...quiet().io })).code).toBe(2);
    });

    it('flags: defaults, --port (plain digits, 1 to 65535), --no-build, --maintenance', () => {
        expect(parseArgs([])).toEqual({ port: 4173, build: true, maintenance: false });
        expect(parseArgs(['--port', '5000', '--no-build', '--maintenance'])).toEqual({
            port: 5000,
            build: false,
            maintenance: true,
        });
        expect(parseArgs(['--port=1'])).toEqual({ port: 1, build: true, maintenance: false });
        expect(parseArgs(['--port=65535'])).toHaveProperty('port', 65535);
        for (const bad of [
            '0',
            '65536',
            '99999',
            'x',
            '',
            '+80',
            '8e1',
            ' 80',
            '80.0',
            '0x50',
            '-1',
        ]) {
            expect(parseArgs(['--port', bad]), bad).toHaveProperty('error');
            expect(parseArgs([`--port=${bad}`]), bad).toHaveProperty('error');
        }
        expect(parseArgs(['--port'])).toHaveProperty('error');
        expect(parseArgs(['prod'])).toEqual({ error: 'Unknown argument "prod".' });
    });
});
