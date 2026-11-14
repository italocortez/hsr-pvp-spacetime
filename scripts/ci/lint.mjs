// `npm run lint:ci`: Biome on the tracked and new (not ignored) files of web/, shared/,
// scripts/ci/, scripts/preview/, scripts/local-auth/ and api/ (M9; the last two since M5b; user decision 2026-11-13: the frontend and shared code are
// linted now, older findings elsewhere are cleaned later; scripts/preview/ added at M8). biome.json ignores still apply (module_bindings,
// lib/legacy, routeTree.gen.ts, dist).
//
// Left out: web/public/**/*.svg. noSvgWithoutTitle on standalone SVG assets; their accessibility
// is handled where they are used (user, 2026-11-13).
//
// Files are passed in batches so the command line stays under the Windows length limit.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const DIRS = ['web', 'shared', 'scripts/ci', 'scripts/preview', 'scripts/local-auth', 'api'];
const LEFT_OUT = [/^web\/public\/.*\.svg$/];
const BATCH = 100;

const listed = spawnSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...DIRS],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
);
if (listed.error || listed.status !== 0) {
    const why = listed.error ? listed.error.message : listed.stderr.trim();
    console.error(`lint:ci: could not list files with git: ${why}`);
    process.exit(1);
}
const files = listed.stdout
    .split('\0')
    .filter((f) => f !== '' && !LEFT_OUT.some((re) => re.test(f)));

const biome = createRequire(import.meta.url).resolve('@biomejs/biome/bin/biome');
let failed = false;
for (let i = 0; i < files.length; i += BATCH) {
    const run = spawnSync(
        process.execPath,
        [
            biome,
            'check',
            '--files-ignore-unknown=true',
            '--no-errors-on-unmatched',
            ...files.slice(i, i + BATCH),
        ],
        { stdio: 'inherit' },
    );
    if (run.status !== 0) failed = true;
}
process.exit(failed ? 1 : 0);
