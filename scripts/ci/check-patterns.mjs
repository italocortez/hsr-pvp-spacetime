// `npm run check:patterns` (M9): grep gates for rules a typecheck cannot see. Run after
// `npm run build -w web`; plain Node, no dependencies. Prints one line per hit and exits 1 on any.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

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

// 1. subscribeToAllTables is banned in the app (CLAUDE.md §4); generated bindings and the legacy
//    reference copy are not app code.
const SRC = join(ROOT, 'web', 'src');
for (const file of walk(SRC)) {
    const path = rel(file);
    if (path.startsWith('web/src/module_bindings/') || path.startsWith('web/src/lib/legacy/')) {
        continue;
    }
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
//    vite.config.ts refuses `serve` (not preview) with the prod target.
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
        // regex, everything else literal.
        const sourceToRegExp = (source) => {
            let out = '';
            for (let i = 0; i < source.length; i++) {
                if (source[i] !== '(') {
                    out += source[i].replace(/[.*+?^${}|[\]\\]/g, '\\$&');
                    continue;
                }
                let depth = 0;
                let j = i;
                for (; j < source.length; j++) {
                    if (source[j] === '\\') j++;
                    else if (source[j] === '(') depth++;
                    else if (source[j] === ')' && --depth === 0) break;
                }
                out += source.slice(i, j + 1);
                i = j;
            }
            return new RegExp(`^${out}$`);
        };
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

if (hits.length > 0) {
    console.error(`check:patterns: ${hits.length} hit(s)`);
    for (const hit of hits) console.error(`  ${hit}`);
    process.exit(1);
}
console.log('check:patterns: all nine gates pass');
