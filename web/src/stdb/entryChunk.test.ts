import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import { build, loadConfigFromFile, type Plugin } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/*
 * T-SHELL item 7 (S14.1, A171 item 2): the entry chunk does not carry the SpacetimeDB SDK or the
 * generated bindings; they load in a chunk of their own after the first render. Proven on a real
 * production build of web/ made in memory (`write: false`) with the app's own Vite config. One
 * change: the router plugins are rebuilt with the same options but write their generated route
 * tree to a temporary folder (under web/node_modules/.cache, removed after), so a test never rewrites the committed `src/routeTree.gen.ts` (the
 * app still imports the committed one; the code splitter needs the generator plugin beside it).
 * No network: Vite builds from local files only.
 */

// jsdom gives this file a non-file import.meta.url, so the web folder is found from the cwd
// (as in devGuard.config.test.ts).
const ROOT = [join(process.cwd(), 'web'), process.cwd()].find((d) =>
    existsSync(join(d, 'vite.config.ts')),
) as string;

/** Same options as web/vite.config.ts, except where the generated tree is written. */
const routerPlugins = (generatedRouteTree: string) =>
    tanstackRouter({
        target: 'react',
        autoCodeSplitting: true,
        routesDirectory: 'src/routes',
        generatedRouteTree,
        routeFileIgnorePattern: '\\.test\\.tsx?$',
    });

type Chunk = {
    type: 'chunk';
    fileName: string;
    isEntry: boolean;
    imports: string[];
    dynamicImports: string[];
    moduleIds: string[];
};

const norm = (id: string) => id.replace(/\\/g, '/');
const isSdk = (id: string) => /\/node_modules\/spacetimedb\//.test(norm(id));
const isBindings = (id: string) => /\/src\/module_bindings\//.test(norm(id));

let chunks: Map<string, Chunk>;
let entry: Chunk;
const saved = process.env.VITE_STDB_TARGET;

beforeAll(async () => {
    // As the real build: the router plugins resolve `src/routes` against the working directory
    // (`npm run build -w web` runs in web/), and Vite reads `import.meta.env.DEV` from NODE_ENV
    // (vitest sets `test`, which would bundle the dev helpers).
    const cwd = process.cwd();
    const nodeEnv = process.env.NODE_ENV;
    // On the same drive as web/ (the generator renames its output into place), gitignored.
    const cache = join(ROOT, 'node_modules', '.cache');
    mkdirSync(cache, { recursive: true });
    const tmp = mkdtempSync(join(cache, 'hsr-entry-chunk-'));
    process.env.VITE_STDB_TARGET = 'test';
    process.env.NODE_ENV = 'production';
    process.chdir(ROOT);
    try {
        await buildInMemory(join(tmp, 'routeTree.gen.ts'));
    } finally {
        process.chdir(cwd);
        process.env.NODE_ENV = nodeEnv;
        rmSync(tmp, { recursive: true, force: true });
    }
}, 120_000);

afterAll(() => {
    if (saved === undefined) delete process.env.VITE_STDB_TARGET;
    else process.env.VITE_STDB_TARGET = saved;
});

async function buildInMemory(generatedRouteTree: string) {
    const loaded = await loadConfigFromFile(
        { command: 'build', mode: 'production', isPreview: false },
        join(ROOT, 'vite.config.ts'),
        ROOT,
        'silent',
    );
    if (!loaded) throw new Error('vite.config.ts did not load');
    const isRouter = (p: Plugin) => /tanstack/i.test(p.name);
    const own = (loaded.config.plugins ?? []).flat(Number.POSITIVE_INFINITY as 1) as Plugin[];
    const others = own.filter((p) => p && typeof p === 'object' && 'name' in p && !isRouter(p));
    // The config lists the router plugins first ("must come before the React plugin").
    expect(own.some((p) => p && isRouter(p))).toBe(true);
    const output = await build({
        ...loaded.config,
        configFile: false,
        mode: 'production',
        root: ROOT,
        plugins: [routerPlugins(generatedRouteTree), ...others],
        logLevel: 'silent',
        build: { ...loaded.config.build, write: false, emptyOutDir: false },
    });
    const outputs = (Array.isArray(output) ? output : [output]) as { output: unknown[] }[];
    chunks = new Map();
    for (const item of outputs.flatMap((o) => o.output) as Chunk[]) {
        if (item.type === 'chunk') chunks.set(item.fileName, item);
    }
    const entries = [...chunks.values()].filter((c) => c.isEntry);
    expect(entries).toHaveLength(1);
    entry = entries[0] as Chunk;
}

/** The entry and every chunk it imports statically, transitively. */
function staticClosure(start: Chunk): Chunk[] {
    const seen = new Map<string, Chunk>();
    const queue = [start];
    while (queue.length) {
        const chunk = queue.shift() as Chunk;
        if (seen.has(chunk.fileName)) continue;
        seen.set(chunk.fileName, chunk);
        for (const name of chunk.imports) {
            const next = chunks.get(name);
            if (next) queue.push(next);
        }
    }
    return [...seen.values()];
}

describe('the entry chunk (first paint)', () => {
    it('the build splits routes and keeps the dev helpers out (the setup is the real one)', () => {
        const names = [...chunks.keys()];
        expect(names.some((n) => /\/costs-/.test(n))).toBe(true);
        expect(names.some((n) => /wireStats|devAuth|devConnection/.test(n))).toBe(false);
    });

    it('neither the entry nor its static imports hold a spacetimedb or bindings module', () => {
        const offending = staticClosure(entry).flatMap((c) =>
            c.moduleIds
                .filter((id) => isSdk(id) || isBindings(id))
                .map((id) => `${c.fileName}: ${norm(id)}`),
        );
        expect(offending).toEqual([]);
    });

    it.each(['index', 'costs', 'teambuilder', 'lobbies', 'standby'])(
        'the split component chunk of the public route "%s" reaches no SDK module statically',
        (route) => {
            const file = new RegExp(`/src/routes/${route}\\.tsx\\?tsr-split=`);
            const own = [...chunks.values()].filter(
                (c) => !c.isEntry && c.moduleIds.some((id) => file.test(norm(id))),
            );
            expect(own.length).toBeGreaterThan(0);
            for (const c of own) {
                const sdk = staticClosure(c).flatMap((x) => x.moduleIds.filter(isSdk));
                expect(sdk).toEqual([]);
            }
        },
    );

    it('sign-out and the token helpers are in the entry graph (a click fetches no chunk)', () => {
        const ids = staticClosure(entry).flatMap((c) => c.moduleIds.map(norm));
        expect(ids.some((id) => id.endsWith('/src/auth/signOut.ts'))).toBe(true);
        expect(ids.some((id) => id.endsWith('/src/stdb/tokenStorage.ts'))).toBe(true);
        expect(ids.some((id) => id.endsWith('/src/stdb/connection.ts'))).toBe(false);
    });

    it('the sign-in panel stays out of the entry graph (its frame alone is in it)', () => {
        const ids = staticClosure(entry).flatMap((c) => c.moduleIds.map(norm));
        // The pending and error screens render without a chunk (the error one while offline).
        expect(ids.some((id) => id.endsWith('/src/pages/sign-in/SignInFrame.tsx'))).toBe(true);
        expect(ids.some((id) => id.endsWith('/src/pages/connection/LoadFailedPage.tsx'))).toBe(
            true,
        );
        expect(ids.some((id) => id.endsWith('/src/pages/sign-in/SignInPage.tsx'))).toBe(false);
        expect(ids.some((id) => id.endsWith('/src/pages/sign-in/useSignIn.ts'))).toBe(false);
    });

    it('the SDK is still built, reached from the entry graph only through dynamic imports', () => {
        const sdkChunks = [...chunks.values()].filter((c) => c.moduleIds.some(isSdk));
        expect(sdkChunks.length).toBeGreaterThan(0);
        const closure = staticClosure(entry);
        const reachable = new Set(closure.map((c) => c.fileName));
        for (const c of sdkChunks) expect(reachable.has(c.fileName)).toBe(false);
        const providerChunk = [...chunks.values()].find((c) =>
            c.moduleIds.some((id) => norm(id).endsWith('/src/stdb/StdbProvider.tsx')),
        );
        expect(providerChunk).toBeDefined();
        expect(closure.flatMap((c) => c.dynamicImports)).toContain(providerChunk?.fileName);
    });
});
