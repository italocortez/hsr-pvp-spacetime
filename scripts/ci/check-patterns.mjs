// `npm run check:patterns` (M9): grep gates for rules a typecheck cannot see. Run after
// `npm run build -w web`; plain Node, no dependencies. Prints one line per hit and exits 1 on any.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceToRegExp } from '../preview/vercel-rules.mjs';
import { importSpecifiers } from './import-specifiers.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const DIST = join(ROOT, 'web', 'dist');
const hits = [];

/** Repo-relative path with forward slashes, on every OS. */
const rel = (abs) => relative(ROOT, abs).split(sep).join('/');

/** Every file under `dir`, recursively (absolute paths). */
function walk(dir) {
    const out = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const abs = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(abs));
        else if (entry.isFile()) out.push(abs);
    }
    return out;
}

/** Records a hit for each needle found in `file`. */
function scan(gate, file, needles) {
    const text = readFileSync(file, 'utf8');
    for (const needle of needles) {
        if (text.includes(needle)) hits.push(`[${gate}] ${rel(file)}: contains "${needle}"`);
    }
}

// 1. subscribeToAllTables is banned in the app (CLAUDE.md §4); generated bindings are not app code.
const SRC = join(ROOT, 'web', 'src');
for (const file of walk(SRC)) {
    const path = rel(file);
    if (path.startsWith('web/src/module_bindings/')) continue;
    if (!/\.(ts|tsx|js|jsx|mjs)$/.test(path)) continue;
    scan('subscribeToAllTables', file, ['subscribeToAllTables']);
}

// 6. Module references only a bundled test would carry (bare words like "vitest" could appear in
//    shipped text, so they are not searched).
const TEST_CODE = [
    '@testing-library',
    'vitest/',
    'from"vitest"',
    "from'vitest'",
    'from "vitest"',
    "from 'vitest'",
    'require("vitest")',
    "require('vitest')",
];

// 2 to 4 and 6 read the built site.
if (!existsSync(DIST)) {
    hits.push('[build] web/dist is missing: run `npm run build -w web` first');
} else {
    for (const file of walk(DIST)) {
        const path = rel(file);
        // 2. A module that forgot `@import '@/styles/media.css'` leaves custom media unresolved.
        if (path.endsWith('.css')) scan('custom-media', file, ['(--bp-', '@custom-media']);
        // 3. Dev-only helpers stay out of the production build.
        scan('dev-only', file, [
            '__devAuth',
            '__devConnection',
            '__wireStats',
            'TanStackRouterDevtools',
            // M5b fix pass: the dev-only loopback rule of isFollowable (web/src/auth/signIn.ts),
            // the regex source as the minifier keeps it.
            String.raw`(?:localhost|127\.0\.0\.1)`,
            // M10: the dev server's service worker reset (web/src/dev/devServiceWorkerReset.ts).
            'hsr-dev-sw-reset',
            // S14.3g: the save indicator demo at /teambuilder#save-demo (web/src/dev/SaveIndicatorDemo.tsx).
            'hsr-dev-save-demo',
        ]);
        // 4. Fonts are self-hosted (no Google Fonts requests).
        scan('google-fonts', file, ['fonts.googleapis.com', 'fonts.gstatic.com']);
        // 6. No test code in the built site: test libraries, or a test file.
        scan('test-code', file, TEST_CODE);
        if (path.slice(path.lastIndexOf('/') + 1).includes('.test.')) {
            hits.push(`[test-code] ${path}: a test file name in the build`);
        }
    }
}
scan('google-fonts', join(ROOT, 'web', 'index.html'), [
    'fonts.googleapis.com',
    'fonts.gstatic.com',
]);

// 5. The database wipe flags appear only where the wipe is built, refused or tested. The needles
//    are assembled so this file does not match itself.
const WIPE_FLAGS = [`--${'delete-data'}`, `--${'clear-database'}`];
const WIPE_FILES = /\.(ts|tsx|mts|cts|js|mjs|cjs|json|yml|yaml|sh|ps1)$/;
const WIPE_ALLOWED = new Set([
    'shared/stdb-targets.ts', // builds the test-only wipe args; lists the flags refused for prod
    'shared/stdb-targets.test.ts', // asserts the wipe args and the prod refusal
    'spacetimedb/src/index.ts', // comment: init runs again after a wipe publish
    'spacetimedb/src/schema.ts', // comment: the module env is cleared by a wipe publish
    'spacetimedb/src/tables/identity/serverIdentity.ts', // comment: delegates reset by a wipe
]);
const listed = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: ROOT,
    encoding: 'utf8',
});
if (listed.error || listed.status !== 0) {
    const why = listed.error ? listed.error.message : listed.stderr.trim();
    hits.push(`[wipe-flags] could not list files with git (is git installed and on PATH?): ${why}`);
} else {
    for (const path of listed.stdout.split('\0')) {
        if (!WIPE_FILES.test(path) || WIPE_ALLOWED.has(path)) continue;
        const abs = join(ROOT, path);
        if (existsSync(abs)) scan('wipe-flags', abs, WIPE_FLAGS);
    }
}

// 7. Dev guard present (user decision 2026-11-13): the dev server never runs against prod.
//    main.tsx calls assertDevTarget before the first render and before the dev helpers load;
//    vite.config.ts refuses `serve` (dev) with the prod target, and `vite preview` always (M8).
const DEV_REFUSAL = 'Dev mode cannot run against the prod database. Set VITE_STDB_TARGET=test.';
{
    const mainPath = join(ROOT, 'web', 'src', 'main.tsx');
    const main = existsSync(mainPath) ? readFileSync(mainPath, 'utf8') : '';
    const guard = main.indexOf('assertDevTarget(import.meta.env.DEV');
    const firstRender = main.indexOf('createRoot(');
    const devHelpers = main.indexOf("import('@/dev/");
    if (guard < 0) {
        hits.push('[dev-guard] web/src/main.tsx: no assertDevTarget(import.meta.env.DEV, …) call');
    } else if (
        (firstRender >= 0 && guard > firstRender) ||
        (devHelpers >= 0 && guard > devHelpers)
    ) {
        hits.push(
            '[dev-guard] web/src/main.tsx: assertDevTarget runs after the render or the dev helpers',
        );
    }
    const configPath = join(ROOT, 'web', 'vite.config.ts');
    const config = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
    for (const needle of [
        "command === 'serve' && !isPreview",
        "target === 'prod'",
        'throw new Error(DEV_PROD_REFUSAL)',
        DEV_REFUSAL,
        // M8: `vite preview` is refused for every target; the local preview is npm run preview.
        "if (command === 'serve' && isPreview) throw new Error(VITE_PREVIEW_REFUSAL);",
        'Run `npm run preview` (test database only',
    ]) {
        if (!config.includes(needle)) {
            hits.push(`[dev-guard] web/vite.config.ts: missing "${needle}"`);
        }
    }
}

// 8. No inline script in the built page (M7): the CSP's script-src has no 'unsafe-inline'. Checks
//    <script> tags only (not inline event handlers or javascript: URLs). HTML comments are dropped
//    first; each tag's attributes are parsed (quoted values may hold "src=" or ">"); a script
//    counts as external only with a non-empty src. JSON-LD data blocks are not scripts.
{
    const page = join(DIST, 'index.html');
    if (existsSync(page)) {
        const html = readFileSync(page, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
        const TAG = /<script\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
        const ATTR = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
        for (const [tag, rawAttrs] of html.matchAll(TAG)) {
            const attrs = new Map();
            for (const [, name, dq, sq, bare] of rawAttrs.matchAll(ATTR)) {
                const key = name.toLowerCase();
                if (!attrs.has(key)) attrs.set(key, dq ?? sq ?? bare ?? '');
            }
            const type = (attrs.get('type') ?? '').split(';')[0].trim().toLowerCase();
            if (type === 'application/ld+json') continue;
            if ((attrs.get('src') ?? '').trim() === '') {
                hits.push(`[inline-script] web/dist/index.html: script without src: ${tag}`);
            }
        }
    }
}

// 9. Hosting config (M7): vercel.json is an object; exactly one header rule, the unconditional
//    catch-all `/(.*)`, carries the CSP, with no directive twice, 'unsafe-eval' in script-src (the
//    SDK's codecs) and both maincloud origins in connect-src (socket and token exchange);
//    /status.json is served `no-store`; the rewrite to /index.html behaves as documented (a table
//    of paths below); the built status file ships with maintenance off. Turning maintenance on is
//    therefore a deliberate deploy from a commit this gate marks red (docs/frontend/hosting.md).
//    M10: while web/dist/sw.js is the caching worker, connect-src (its refetch) and img-src (the
//    page's images) allow every host on its allow-list (checked after gate 11 reads the worker).
/** The CSP directives of the one CSP rule (gate 9), for the M10 check after gate 11. */
let cspDirectives;
{
    const hosting = (message) => hits.push(`[hosting] vercel.json: ${message}`);
    const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
    let vercel;
    try {
        vercel = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8'));
        if (!isObject(vercel)) {
            hosting('not a JSON object');
            vercel = undefined;
        }
    } catch (error) {
        hosting(`missing or not JSON (${error.message})`);
    }
    if (vercel) {
        // Header rules: each an object with a string source and an array of {key, value} strings.
        const rules = [];
        if (vercel.headers !== undefined && !Array.isArray(vercel.headers)) {
            hosting('"headers" is not an array');
        }
        for (const [i, rule] of (Array.isArray(vercel.headers) ? vercel.headers : []).entries()) {
            const ok =
                isObject(rule) &&
                typeof rule.source === 'string' &&
                Array.isArray(rule.headers) &&
                rule.headers.every(
                    (h) => isObject(h) && typeof h.key === 'string' && typeof h.value === 'string',
                );
            if (ok) rules.push(rule);
            else hosting(`headers[${i}] is malformed`);
        }
        const headerValues = (rule, key) =>
            rule.headers.filter((h) => h.key.toLowerCase() === key).map((h) => h.value);

        const cspRules = rules.filter(
            (rule) => headerValues(rule, 'content-security-policy').length > 0,
        );
        if (cspRules.length === 0) {
            hosting('no header rule sets a Content-Security-Policy');
        } else if (cspRules.length > 1) {
            hosting(`${cspRules.length} header rules set a CSP (one only)`);
        } else {
            const [rule] = cspRules;
            if (rule.source !== '/(.*)') {
                hosting(`the CSP rule's source is "${rule.source}", not "/(.*)"`);
            }
            if (rule.has !== undefined || rule.missing !== undefined) {
                hosting('the CSP rule has a "has" or "missing" condition');
            }
            const values = headerValues(rule, 'content-security-policy');
            if (values.length > 1) hosting('the CSP rule sets the CSP more than once');
            const directives = new Map();
            for (const part of values[0].split(';')) {
                const [name, ...sources] = part.trim().split(/\s+/);
                if (!name) continue;
                const key = name.toLowerCase();
                if (directives.has(key)) hosting(`the CSP has "${key}" twice`);
                else
                    directives.set(
                        key,
                        sources.map((s) => s.toLowerCase()),
                    );
            }
            cspDirectives = directives;
            if (!(directives.get('script-src') ?? []).includes("'unsafe-eval'")) {
                hosting("script-src lacks 'unsafe-eval' (the SDK needs it)");
            }
            const connectSrc = directives.get('connect-src');
            if (!connectSrc) hosting('the CSP has no connect-src');
            for (const origin of [
                'wss://maincloud.spacetimedb.com',
                'https://maincloud.spacetimedb.com',
            ]) {
                if (connectSrc && !connectSrc.includes(origin)) {
                    hosting(`connect-src lacks ${origin}`);
                }
            }
        }

        const statusRule = rules.find((rule) => rule.source === '/status.json');
        const statusCache = statusRule ? headerValues(statusRule, 'cache-control') : [];
        if (
            !statusCache.some((v) =>
                v
                    .toLowerCase()
                    .split(/\s*,\s*/)
                    .includes('no-store'),
            )
        ) {
            hosting('no rule serves /status.json with Cache-Control: no-store');
        }
        if (statusRule && (statusRule.has !== undefined || statusRule.missing !== undefined)) {
            hosting('the /status.json rule has a "has" or "missing" condition');
        }
        // Legacy `routes` replaces the rewrite and header handling checked here.
        if (vercel.routes !== undefined) hosting('a top-level "routes" key is not allowed');

        // Rewrites: the ones to /index.html must send client routes to the app and leave files,
        // the status file and dot-paths alone. A source is read like path-to-regexp: groups are
        // regex, everything else literal (sourceToRegExp, shared with the local preview, M8).
        if (vercel.rewrites !== undefined && !Array.isArray(vercel.rewrites)) {
            hosting('"rewrites" is not an array');
        }
        const toIndex = [];
        // Rewrites before the first one to /index.html: none may take a client route away.
        const before = [];
        for (const [i, r] of (Array.isArray(vercel.rewrites) ? vercel.rewrites : []).entries()) {
            if (!isObject(r) || typeof r.source !== 'string' || typeof r.destination !== 'string') {
                hosting(`rewrites[${i}] is malformed`);
                continue;
            }
            if (
                r.destination === '/index.html' &&
                (r.has !== undefined || r.missing !== undefined)
            ) {
                hosting(`rewrites[${i}] to /index.html has a "has" or "missing" condition`);
            }
            try {
                const re = sourceToRegExp(r.source);
                if (r.destination === '/index.html') toIndex.push(re);
                else if (toIndex.length === 0) before.push({ i, re });
            } catch (error) {
                hosting(`rewrites[${i}].source is not a valid pattern (${error.message})`);
            }
        }
        if (toIndex.length === 0) {
            hosting('no rewrite to /index.html (deep links would 404)');
        } else {
            for (const path of ['/', '/lobby/123']) {
                if (!toIndex.some((re) => re.test(path))) {
                    hosting(`the rewrite does not send ${path} to /index.html`);
                }
            }
            for (const { i, re } of before) {
                if (re.test('/lobby/123')) {
                    hosting(`rewrites[${i}] comes before the index rewrite and takes /lobby/123`);
                }
            }
            for (const path of [
                '/assets/x.js',
                '/status.json',
                '/foo.png',
                '/.env',
                '/api/x',
                '/sw.js',
                '/favicon.svg',
                '/a/.b/c',
            ]) {
                if (toIndex.some((re) => re.test(path))) {
                    hosting(`the rewrite sends ${path} to /index.html (must stay a file or a 404)`);
                }
            }
        }
    }
    const statusPath = join(DIST, 'status.json');
    if (existsSync(DIST)) {
        let status;
        try {
            status = JSON.parse(readFileSync(statusPath, 'utf8'));
        } catch (error) {
            hits.push(`[hosting] web/dist/status.json: missing or not JSON (${error.message})`);
        }
        if (status !== undefined && status?.maintenance !== false) {
            hits.push('[hosting] web/dist/status.json: "maintenance" is not false');
        }
    }
}

// 10. Secrets stay on the server (M5b). The needles are assembled so this file does not match
//     itself. (a) The built site holds none of the secret key names, nor the local Discord stub's
//     variable. (b) No VITE_-prefixed name containing SECRET or TOKEN anywhere under web/ (built
//     site included) or in a tracked `.env*` file that is not `.local` (Vite would ship its
//     value); `.env*.local` files are never opened. (c) No file under web/src imports from api/
//     or scripts/, and none names the stub variable. (d) No file under api/ imports from web/ or
//     scripts/ (a type-only import from @bindings is allowed) or names the stub variable: the stub
//     lives in scripts/local-auth/ only. (e) Nothing web/vite.config.ts imports, or any file
//     those import in turn, reaches scripts/ (not uploaded to Vercel, .vercelignore; the dev
//     plugin loads the local runner at dev-server start instead). Imports are read by
//     ./import-specifiers.mjs after comments and string contents are masked: static imports,
//     `import()` / `require()` with a string or template literal, and `import.meta.glob`. A
//     specifier points into a folder when it is relative (`./`, `../`), root-resolved (`/…`) or
//     one of the aliases `@/`, `@shared/`, `@bindings/` (resolved first): `some-package/api` is
//     not api/, and `@/lib/api/client` is web/src/lib/api/, not api/.
{
    const SECRET_KEYS = [
        ['DISCORD', 'CLIENT', 'SECRET'],
        ['AUTH', 'SECRET'],
        ['STDB', 'LINK', 'TOKEN'],
        ['STDB', 'SERVER', 'TOKEN'],
    ].map((parts) => parts.join('_'));
    const STUB_KEY = ['HSR', 'LOCAL', 'DISCORD', 'STUB'].join('_');
    const VITE_SECRET = new RegExp(
        `\\b${'VITE'}_[A-Z0-9_]*(?:${'SECRET'}|${'TOKEN'})[A-Z0-9_]*`,
        'g',
    );
    const CODE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
    /** Static, dynamic (literal argument), require and import.meta.glob specifiers, comments dropped. */
    const specifiers = (text) => importSpecifiers(text);
    /** The app's path aliases (web/vite.config.ts, tsconfig.base.json), resolved before the folder test. */
    const ALIASES = [
        ['@/', 'web/src/'],
        ['@shared/', 'shared/'],
        ['@bindings/', 'web/src/module_bindings/'],
    ];
    /** The repo path a specifier names (relative, root-resolved or an alias); undefined for a package. */
    const pointsAt = (fromFile, spec) => {
        if (spec === '@shared') return 'shared';
        if (spec === '@bindings') return 'web/src/module_bindings';
        for (const [alias, dir] of ALIASES) {
            if (spec.startsWith(alias)) return rel(resolve(ROOT, dir + spec.slice(alias.length)));
        }
        if (spec.startsWith('.')) return rel(resolve(dirname(fromFile), spec));
        if (spec.startsWith('/')) return rel(resolve(ROOT, spec.replace(/^\/+/, '')));
        return undefined;
    };
    const under = (path, dir) => path !== undefined && (path === dir || path.startsWith(`${dir}/`));
    /** The file a resolved specifier loads (TypeScript's `.js` to `.ts` mapping included). */
    const fileFor = (abs) => {
        const bases = [abs, abs.replace(/\.(m|c)?js$/, '.$1ts'), abs.replace(/\.js$/, '.tsx')];
        const candidates = [
            ...bases,
            ...['.ts', '.tsx', '.mts', '.js', '.mjs'].map((ext) => abs + ext),
            ...['index.ts', 'index.tsx', 'index.js'].map((name) => join(abs, name)),
        ];
        return candidates.find((c) => existsSync(c) && !statSync(c).isDirectory());
    };
    const viteSecrets = (file) => {
        for (const [name] of readFileSync(file, 'utf8').matchAll(VITE_SECRET)) {
            hits.push(`[secrets] ${rel(file)}: a VITE_ name that looks like a secret ("${name}")`);
        }
    };
    const isEnvFile = (name) => name.startsWith('.env');

    // (a) and (b) on the built site.
    if (existsSync(DIST)) {
        for (const file of walk(DIST)) {
            scan('secrets', file, [...SECRET_KEYS, STUB_KEY]);
            viteSecrets(file);
        }
    } else {
        console.log('[secrets] web/dist is missing: the built-site part of gate 10 did not run');
    }
    // (b) and (c) on the sources under web/. Env files are left to the tracked-file pass below.
    for (const file of walk(join(ROOT, 'web'))) {
        const path = rel(file);
        if (
            path.startsWith('web/node_modules/') ||
            path.startsWith('web/dist/') ||
            path.startsWith('web/src/module_bindings/') ||
            isEnvFile(basename(path))
        ) {
            continue;
        }
        viteSecrets(file);
        if (path.startsWith('web/src/') && CODE.test(path)) {
            const text = readFileSync(file, 'utf8');
            if (text.includes(STUB_KEY))
                hits.push(`[secrets] ${path}: names the local Discord stub`);
            for (const { spec } of specifiers(text)) {
                const to = pointsAt(file, spec);
                if (under(to, 'api')) hits.push(`[secrets] ${path}: imports from api/ ("${spec}")`);
                if (under(to, 'scripts')) {
                    hits.push(`[secrets] ${path}: imports from scripts/ ("${spec}")`);
                }
            }
        }
    }
    // (b) on the tracked env files that are not `.local` (only names that git tracks are opened).
    const tracked = spawnSync('git', ['ls-files', '-z', '--cached'], {
        cwd: ROOT,
        encoding: 'utf8',
    });
    if (tracked.error || tracked.status !== 0) {
        hits.push('[secrets] could not list the tracked files with git');
    } else {
        for (const path of tracked.stdout.split('\0')) {
            const name = basename(path);
            if (!isEnvFile(name) || name.includes('.local')) continue;
            const abs = join(ROOT, path);
            if (existsSync(abs)) viteSecrets(abs);
        }
    }
    // (d) on api/.
    const API = join(ROOT, 'api');
    if (existsSync(API)) {
        for (const file of walk(API)) {
            const path = rel(file);
            if (!CODE.test(path)) continue;
            const text = readFileSync(file, 'utf8');
            if (text.includes(STUB_KEY))
                hits.push(`[secrets] ${path}: names the local Discord stub`);
            for (const { spec, typeOnly } of specifiers(text)) {
                const to = pointsAt(file, spec);
                if (spec === '@bindings' || spec.startsWith('@bindings/')) {
                    // Generated types only: a type-only import is allowed, a value import is not.
                    if (!typeOnly) {
                        hits.push(`[secrets] ${path}: a value import from @bindings ("${spec}")`);
                    }
                } else if (under(to, 'web')) {
                    hits.push(`[secrets] ${path}: imports from web/ ("${spec}")`);
                } else if (under(to, 'scripts')) {
                    hits.push(`[secrets] ${path}: imports from scripts/ ("${spec}")`);
                }
            }
        }
    }
    // (e) the import chain of web/vite.config.ts: static imports, and dynamic imports, require
    //     and import.meta.glob with a literal argument (a bundler follows those too). The dev
    //     plugin's loader passes its path as a plain argument to tsx's tsImport(), which is no
    //     import expression, so it is not followed and stays allowed.
    const queue = [join(ROOT, 'web', 'vite.config.ts')];
    const seen = new Set();
    while (queue.length > 0) {
        const file = queue.pop();
        if (seen.has(file) || !existsSync(file)) continue;
        seen.add(file);
        for (const { spec, kind } of specifiers(readFileSync(file, 'utf8'))) {
            const to = pointsAt(file, spec);
            if (to === undefined) continue;
            if (under(to, 'scripts')) {
                hits.push(
                    `[secrets] ${rel(file)}: an import (${kind}) into scripts/ on the build path of web/vite.config.ts ("${spec}")`,
                );
                continue;
            }
            const next = fileFor(join(ROOT, to));
            if (next && !rel(next).includes('node_modules/')) queue.push(next);
        }
    }
}

// 11. The image cache worker (M10, docs/frontend/hosting.md): the built web/dist/sw.js exists and
//     is one of exactly two shapes. Comments are dropped first (string contents are kept), so a
//     marker only in a comment neither satisfies a rule nor trips one. Both shapes: no other
//     script loaded, no app file named (the app page or the hashed build folder). The caching
//     worker: answers requests (`respondWith(`), keeps the same-origin early return ahead of its
//     first respondWith, reads a non-empty exact host allow-list, and never unregisters itself.
//     The kill worker (web/sw-kill.js copied over it): no `respondWith(`, no fetch listener, and
//     calls `registration.unregister()`. Anything else (a mix, or neither) fails. While it is the
//     caching worker, gate 9's CSP must allow its hosts. The page-side switch
//     (`SERVICE_WORKER_ENABLED` in web/src/lib/serviceWorker.ts) must agree: true exactly for the
//     caching worker. The shape rule and the comment stripper are duplicated in
//     web/src/lib/serviceWorkerScript.test.ts (web/src may not import scripts/, gate 10).
//     Limits (text checks, not a parser): regex literals and nested template expressions are not
//     understood, and a marker inside a string literal counts; the unit tests run the real files.
{
    /** Drops `//` and block comments, keeping string and template literal contents. */
    const stripComments = (src) => {
        let out = '';
        let i = 0;
        while (i < src.length) {
            const c = src[i];
            const n = src[i + 1];
            if (c === '/' && n === '/') {
                while (i < src.length && src[i] !== '\n') i++;
            } else if (c === '/' && n === '*') {
                const end = src.indexOf('*/', i + 2);
                i = end < 0 ? src.length : end + 2;
                out += ' ';
            } else if (c === "'" || c === '"' || c === '`') {
                out += c;
                i++;
                while (i < src.length && src[i] !== c) {
                    if (src[i] === '\\') out += src[i++] ?? '';
                    out += src[i++] ?? '';
                }
                out += src[i++] ?? '';
            } else {
                out += c;
                i++;
            }
        }
        return out;
    };
    const workerPath = join(DIST, 'sw.js');
    const worker = (message) => hits.push(`[service-worker] web/dist/sw.js: ${message}`);
    let shape;
    if (!existsSync(DIST)) {
        // Reported once by the build check above.
    } else if (!existsSync(workerPath)) {
        worker('missing (web/public/sw.js is copied by the build)');
    } else {
        const code = stripComments(readFileSync(workerPath, 'utf8'));
        for (const needle of ['importScripts', 'index.html', '/assets/']) {
            if (code.includes(needle)) worker(`contains "${needle}"`);
        }
        const responds = code.includes('respondWith(');
        const fetchListener = /addEventListener\(\s*['"]fetch['"]/.test(code);
        const unregisters = code.includes('registration.unregister()');
        if (responds && !unregisters) shape = 'caching';
        else if (!responds && !fetchListener && unregisters) shape = 'kill';
        if (responds) {
            // The caching worker.
            const SAME_ORIGIN = 'if (url.origin === self.location.origin) return;';
            const early = code.indexOf(SAME_ORIGIN);
            if (early < 0) worker(`no same-origin early return ("${SAME_ORIGIN}")`);
            else if (code.indexOf('respondWith(') < early) {
                worker('respondWith comes before the same-origin early return');
            }
            if (unregisters) {
                worker('a caching worker that also unregisters itself (a mix of the two shapes)');
            }
            const list = code.match(/const ALLOWED_HOSTS = \[([^\]]*)\];/);
            const hosts = list ? [...list[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]) : [];
            if (hosts.length === 0)
                worker('no "const ALLOWED_HOSTS = [...]" with at least one host');
            // Gate 9, M10 part: the worker's refetch (connect-src) and the page's <img> (img-src).
            if (cspDirectives) {
                const allows = (sources, host) =>
                    sources.some((s) => {
                        if (s === `https://${host}`) return true;
                        const wild = s.match(/^https:\/\/\*\.(.+)$/);
                        return wild !== null && host.endsWith(`.${wild[1]}`);
                    });
                for (const directive of ['connect-src', 'img-src']) {
                    const sources = cspDirectives.get(directive) ?? [];
                    for (const host of hosts) {
                        if (!allows(sources, host.toLowerCase())) {
                            hits.push(
                                `[hosting] vercel.json: ${directive} does not allow https://${host} (the image cache worker's host)`,
                            );
                        }
                    }
                }
            }
        } else if (fetchListener) {
            worker(
                'a fetch listener without respondWith (neither the caching nor the kill worker)',
            );
        } else if (!unregisters) {
            worker('neither the caching worker nor the kill worker (no registration.unregister())');
        }
    }
    // The page-side switch agrees with the worker that ships.
    const switchPath = join(ROOT, 'web', 'src', 'lib', 'serviceWorker.ts');
    const switchCode = existsSync(switchPath)
        ? stripComments(readFileSync(switchPath, 'utf8'))
        : '';
    const flag = switchCode.match(/export const SERVICE_WORKER_ENABLED = (true|false);/);
    if (!flag) {
        hits.push(
            '[service-worker] web/src/lib/serviceWorker.ts: no "export const SERVICE_WORKER_ENABLED = true|false;"',
        );
    } else if (shape === 'kill' && flag[1] === 'true') {
        hits.push(
            '[service-worker] web/dist/sw.js is the kill worker but SERVICE_WORKER_ENABLED is true: set it to false in web/src/lib/serviceWorker.ts (step 2 of "Switching the worker off")',
        );
    } else if (shape === 'caching' && flag[1] === 'false') {
        hits.push(
            '[service-worker] SERVICE_WORKER_ENABLED is false but web/dist/sw.js is the caching worker: copy web/sw-kill.js over web/public/sw.js and build (step 1 of "Switching the worker off")',
        );
    }
}

if (hits.length > 0) {
    console.error(`check:patterns: ${hits.length} hit(s)`);
    for (const hit of hits) console.error(`  ${hit}`);
    process.exit(1);
}
console.log('check:patterns: all eleven gates pass');
