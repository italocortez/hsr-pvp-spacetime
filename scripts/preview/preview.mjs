// M8: `npm run preview`. Builds the web app for the TEST database, checks the bundle, then serves
// web/dist on 127.0.0.1 through the vercel.json rules (serve.mjs). Test only: there is no flag
// that selects another target, and a bundle built for prod is refused.
//
// Flags: --port <n> (default 4173), --no-build (serve the existing web/dist after the target
// check), --maintenance (serve /status.json as { "maintenance": true } from memory).
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { STDB_DATABASES } from '../../shared/stdb-targets.ts';
import { DEFAULT_PORT, loadVercelConfig, startPreviewServer } from './serve.mjs';
import { compileRules } from './vercel-rules.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** The one target the preview runs against. */
export const PREVIEW_TARGET = 'test';

const USAGE =
    'Usage: npm run preview [-- --port <n>] [-- --no-build] [-- --maintenance]\n' +
    'The preview always targets the test database; there is no target flag.';

/**
 * @param {readonly string[]} argv
 * @returns {{ port: number, build: boolean, maintenance: boolean } | { error: string }}
 */
export function parseArgs(argv) {
    const out = { port: DEFAULT_PORT, build: true, maintenance: false };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--no-build') out.build = false;
        else if (arg === '--maintenance') out.maintenance = true;
        else if (arg === '--port' || arg.startsWith('--port=')) {
            const raw = arg === '--port' ? argv[++i] : arg.slice('--port='.length);
            const port = /^[0-9]{1,5}$/.test(raw ?? '') ? Number(raw) : Number.NaN;
            if (!(port >= 1 && port <= 65535)) {
                return {
                    error: `--port needs a whole number from 1 to 65535 (got ${raw ?? 'nothing'}).`,
                };
            }
            out.port = port;
        } else if (/^--(target|prod|env)\b/.test(arg)) {
            return {
                error: 'The preview runs against the test database only; there is no target flag.',
            };
        } else {
            return { error: `Unknown argument "${arg}".` };
        }
    }
    return out;
}

/** The files the target check reads: .js, .mjs, .cjs and .html, extension matched without case. */
const CHECKED = /\.(js|mjs|cjs|html)$/i;

/** Every checked file under `dir`. Throws when `dir` cannot be read. */
function bundleFiles(dir) {
    const out = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const abs = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...bundleFiles(abs));
        else if (entry.isFile() && CHECKED.test(entry.name)) out.push(abs);
    }
    return out;
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Reads the build target out of bundle text. Vite inlines `import.meta.env` as an object literal
 * wherever the app passes the whole object (main.tsx and StdbProvider.tsx call
 * `resolveBrowserEnv(import.meta.env)`), so the bundle holds `VITE_STDB_TARGET:"<target>"`. Both
 * database names are in every bundle (the STDB_DATABASES map), so the names alone cannot tell the
 * target; they only prove the test entry of the map is the committed one.
 * @param {readonly string[]} texts
 * @returns {{ targets: string[], testNameMapped: boolean }}
 */
export function readBundleTarget(texts) {
    const marker = /["'`]?VITE_STDB_TARGET["'`]?\s*:\s*(["'`])([^"'`]*)\1/g;
    const testEntry = new RegExp(
        `["'\`]?test["'\`]?\\s*:\\s*(["'\`])${escapeRegExp(STDB_DATABASES.test)}\\1`,
    );
    const targets = new Set();
    let testNameMapped = false;
    for (const text of texts) {
        for (const match of text.matchAll(marker)) targets.add(match[2]);
        if (testEntry.test(text)) testNameMapped = true;
    }
    return { targets: [...targets].sort(), testNameMapped };
}

/**
 * Refuses a web/dist that is not a test build. Fails closed: no marker, no bundle, or any target
 * other than test is a refusal.
 * @param {string} distDir
 * @returns {string | null} the refusal message, or null when the bundle targets test
 */
export function checkBundleTarget(distDir) {
    let files;
    let texts;
    try {
        files = bundleFiles(distDir);
        texts = files.map((f) => readFileSync(f, 'utf8'));
    } catch (error) {
        return `Refusing to serve: ${distDir} cannot be read (${error?.code ?? error?.message}). Run \`npm run preview\` without --no-build.`;
    }
    if (!files.some((f) => /\.(js|mjs|cjs)$/i.test(f))) {
        return `Refusing to serve: ${distDir} holds no built bundle. Run \`npm run preview\` without --no-build.`;
    }
    const { targets, testNameMapped } = readBundleTarget(texts);
    if (targets.length === 0) {
        return 'Refusing to serve: no VITE_STDB_TARGET marker found in the bundle, so its database is unknown. Run `npm run preview` without --no-build.';
    }
    const others = targets.filter((t) => t !== PREVIEW_TARGET);
    if (others.length > 0) {
        const names = others.map((t) =>
            t === 'prod' ? `prod (${STDB_DATABASES.prod})` : `"${t}"`,
        );
        return `Refusing to serve: the bundle in ${distDir} targets ${names.join(', ')}. The preview serves test builds only. Run \`npm run preview\` without --no-build.`;
    }
    if (!testNameMapped) {
        return `Refusing to serve: the bundle does not map the test target to ${STDB_DATABASES.test}. Run \`npm run preview\` without --no-build.`;
    }
    return null;
}

/**
 * The bundle check while the server runs: the full check on every app page answer, no cache
 * (about 5 ms on the real dist). An unreadable dist is a refusal (fails closed).
 * @param {string} distDir
 * @returns {() => string | null}
 */
export function createBundleGuard(distDir) {
    return () => checkBundleTarget(distDir);
}

/**
 * The whole command. Returns `{ code }` on a refusal or failure, or the running server.
 * @param {readonly string[]} argv
 * @param {{ root?: string, out?: (line: string) => void, err?: (line: string) => void, port?: number }} [io]
 *   `port` overrides the flag (tests listen on port 0; the command line cannot pass 0).
 */
export async function runPreview(
    argv,
    { root = ROOT, out = console.log, err = console.error, port } = {},
) {
    const args = parseArgs(argv);
    if ('error' in args) {
        err(`${args.error}\n${USAGE}`);
        return { code: 2 };
    }
    let config;
    try {
        config = loadVercelConfig(root);
    } catch (error) {
        err(`Cannot read vercel.json: ${error.message}`);
        return { code: 1 };
    }
    // The rules are compiled before the build, so unsupported syntax fails at once.
    try {
        compileRules(config);
    } catch (error) {
        err(error.message);
        return { code: 1 };
    }
    const distDir = resolve(root, config.outputDirectory ?? 'web/dist');

    if (args.build) {
        if (typeof config.buildCommand !== 'string' || config.buildCommand.trim() === '') {
            err(
                'vercel.json has no "buildCommand": the preview cannot build. Add it, or pass --no-build.',
            );
            return { code: 1 };
        }
        out(
            `Building for the ${PREVIEW_TARGET} database: ${config.buildCommand} (VITE_STDB_TARGET=${PREVIEW_TARGET})`,
        );
        // The build command of vercel.json, run as Vercel would run it; the target is set in the
        // child's environment, so no shell-specific syntax is needed.
        const build = spawnSync(config.buildCommand, {
            cwd: root,
            shell: true,
            stdio: 'inherit',
            env: { ...process.env, VITE_STDB_TARGET: PREVIEW_TARGET },
        });
        if (build.status !== 0) {
            err(`The build failed (exit ${build.status ?? build.signal ?? build.error?.message}).`);
            return { code: 1 };
        }
    }

    const refusal = checkBundleTarget(distDir);
    if (refusal) {
        err(refusal);
        return { code: 1 };
    }

    try {
        const started = await startPreviewServer({
            distDir,
            config,
            port: port ?? args.port,
            maintenance: args.maintenance,
            log: out,
            guard: createBundleGuard(distDir),
        });
        out('');
        out(`Local preview: ${started.url}`);
        out(`Serving ${distDir}`);
        out(`Database: ${PREVIEW_TARGET} (${STDB_DATABASES[PREVIEW_TARGET]}) on maincloud`);
        out(
            "This server imitates Vercel's rules; it is not Vercel. vercel.json was read at start.",
        );
        out('/api/* answers 404: functions do not run in the local preview.');
        if (args.maintenance) {
            out(
                'MAINTENANCE REHEARSAL: /status.json answers { "maintenance": true } from memory (web/public and web/dist untouched).',
            );
        }
        out('Ctrl+C stops it.');
        out('');
        return { code: 0, ...started };
    } catch (error) {
        err(error.message);
        return { code: 1 };
    }
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
    const result = await runPreview(process.argv.slice(2));
    if (result.code !== 0) process.exit(result.code);
    const stop = () => {
        result.server.close(() => process.exit(0));
        result.server.closeAllConnections();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
}
