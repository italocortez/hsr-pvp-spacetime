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

if (hits.length > 0) {
    console.error(`check:patterns: ${hits.length} hit(s)`);
    for (const hit of hits) console.error(`  ${hit}`);
    process.exit(1);
}
console.log('check:patterns: all seven gates pass');
