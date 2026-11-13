// M8: the local preview server. Plain Node, no dependency. It serves a built `web/dist` through
// the root vercel.json (read at start, never retyped) with the rules of vercel-rules.mjs. It
// imitates Vercel's rules; it is not Vercel (docs/frontend/hosting.md, "Local preview").
//
// A library: the only entry is preview.mjs, which checks that the bundle targets the test
// database before it starts this server, and hands it a guard that repeats the check whenever
// the app page is served.
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { compileRules } from './vercel-rules.mjs';

export const HOST = '127.0.0.1';
export const DEFAULT_PORT = 4173;

/** Content types for the file kinds a Vite build can hold. */
export const CONTENT_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.avif': 'image/avif',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.wasm': 'application/wasm',
};

export const API_NOTE =
    'Functions do not run in the local preview: /api/* is always 404 here (M5 decides how the login function runs locally).\n';

/** The maintenance rehearsal's status file, served from memory. */
export const MAINTENANCE_BODY = '{ "maintenance": true }\n';

/** The app page: serving it (directly or through a rewrite) re-runs the bundle guard. */
const APP_PAGE = '/index.html';

/** Reads and parses `<root>/vercel.json`. */
export function loadVercelConfig(root) {
    return JSON.parse(readFileSync(join(root, 'vercel.json'), 'utf8'));
}

/** True when `p` lies strictly inside `base` (lexically). */
function inside(base, p) {
    const rel = relative(base, p);
    return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * The absolute path of a site path (`/assets/x.js`) inside `distDir`, or null when it is not a
 * regular file reached exactly by that path. Refused: `\0`, `:` and `\` anywhere (Windows stream
 * names and separators), a path that leaves `distDir` lexically, a path whose real location is
 * outside `distDir` or differs from the request (other case, a symlink or junction, `..`). Any
 * stat or realpath failure (missing, a loop, no access) is "not a file".
 * @param {string} distDir
 * @param {string} sitePath  decoded, starting with "/"
 * @returns {string | null}
 */
export function safeFile(distDir, sitePath) {
    if (/[\0:\\]/.test(sitePath)) return null;
    const root = resolve(distDir);
    const abs = resolve(root, `.${sitePath}`);
    if (!inside(root, abs)) return null;
    try {
        if (!statSync(abs).isFile()) return null;
        const realRoot = realpathSync.native(root);
        const realAbs = realpathSync.native(abs);
        if (!inside(realRoot, realAbs)) return null;
        // Exact case and no indirection: the real path must spell the request.
        const realRel = relative(realRoot, realAbs).split(sep).join('/');
        return realRel === sitePath.slice(1) ? abs : null;
    } catch {
        return null;
    }
}

/**
 * The request handler as an http.Server (not listening yet).
 * @param {{
 *   distDir: string,
 *   config: unknown,
 *   maintenance?: boolean,
 *   log?: (line: string) => void,
 *   guard?: () => string | null,
 *   readFile?: (path: string) => Buffer,
 * }} options
 *   `guard` returns a refusal text when the bundle no longer targets test (answered 503 for the
 *   app page); `readFile` is injectable for tests.
 */
export function createPreviewServer({
    distDir,
    config,
    maintenance = false,
    log = console.log,
    guard = () => null,
    readFile = readFileSync,
}) {
    const rules = compileRules(config);
    const text = 'text/plain; charset=utf-8';

    function handle(req, send) {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            send(405, { Allow: 'GET, HEAD', 'Content-Type': text }, 'Only GET and HEAD.\n');
            return;
        }
        const target = req.url ?? '';
        // An absolute-form target, a `//host` path, or any raw backslash (URL parsing reads
        // `/\host` as a host) is not a site path. An encoded `%5c` is handled by safeFile.
        if (!target.startsWith('/') || target.startsWith('//') || target.includes('\\')) {
            send(400, { 'Content-Type': text }, 'Bad request target.\n');
            return;
        }
        let pathname;
        try {
            pathname = decodeURIComponent(new URL(target, `http://${HOST}`).pathname);
        } catch {
            send(400, { 'Content-Type': text }, 'Bad request path.\n');
            return;
        }
        if (pathname.includes('\0')) {
            send(400, { 'Content-Type': text }, 'Bad request path.\n');
            return;
        }

        if (pathname.startsWith('/api/')) {
            const headers = rules.headersFor(pathname, { staticFile: false });
            send(404, { ...headers, 'Content-Type': text }, API_NOTE);
            return;
        }
        if (maintenance && pathname === '/status.json') {
            const headers = rules.headersFor(pathname);
            send(200, { ...headers, 'Content-Type': CONTENT_TYPES['.json'] }, MAINTENANCE_BODY);
            return;
        }

        const found = rules.resolve(pathname, (p) => safeFile(distDir, p) !== null);
        const file = found.kind === 'notFound' ? null : safeFile(distDir, found.file);
        if (!file) {
            const headers = rules.headersFor(pathname, { staticFile: false });
            send(404, { ...headers, 'Content-Type': text }, '404 not found\n');
            return;
        }
        if (found.file === APP_PAGE) {
            const refusal = guard();
            if (refusal) {
                const headers = rules.headersFor(pathname, { staticFile: false });
                send(
                    503,
                    { ...headers, 'Cache-Control': 'no-store', 'Content-Type': text },
                    `${refusal}\n`,
                );
                return;
            }
        }
        const type = CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
        send(200, { ...rules.headersFor(pathname), 'Content-Type': type }, readFile(file));
    }

    return createServer((req, res) => {
        const send = (status, headers, body) => {
            const buffer = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
            res.writeHead(status, { ...headers, 'Content-Length': String(buffer.length) });
            res.end(req.method === 'HEAD' ? undefined : buffer);
            log(`${req.method} ${req.url} ${status}`);
        };
        try {
            handle(req, send);
        } catch (error) {
            // A request never stops the server: answer 500 if nothing was sent yet.
            if (!res.headersSent) {
                send(500, { 'Content-Type': text }, `Internal error: ${error?.message ?? error}\n`);
            } else {
                res.destroy();
                log(`${req.method} ${req.url} 500 (after headers)`);
            }
        }
    });
}

/**
 * Starts the server on 127.0.0.1. Resolves with the bound port (port 0 picks a free one);
 * rejects with a clear message when the port is taken.
 * @param {Parameters<typeof createPreviewServer>[0] & { port?: number }} options
 * @returns {Promise<{ server: import('node:http').Server, port: number, url: string }>}
 */
export function startPreviewServer({ port = DEFAULT_PORT, ...options }) {
    const server = createPreviewServer(options);
    return new Promise((done, fail) => {
        server.once('error', (error) => {
            if (error.code === 'EADDRINUSE') {
                fail(
                    new Error(
                        `Port ${port} on ${HOST} is taken. Stop the other server or pass --port <n>.`,
                    ),
                );
            } else fail(error);
        });
        server.listen(port, HOST, () => {
            const address = server.address();
            const bound = typeof address === 'object' && address ? address.port : port;
            done({ server, port: bound, url: `http://${HOST}:${bound}/` });
        });
    });
}
