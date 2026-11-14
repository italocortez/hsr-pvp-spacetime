import { fileURLToPath } from 'node:url';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';
import { localAuthPlugin } from './vite-plugin-local-auth';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/** Same text as DEV_PROD_REFUSAL in src/stdb/assertDevTarget.ts (user decision 2026-11-13). */
const DEV_PROD_REFUSAL =
    'Dev mode cannot run against the prod database. Set VITE_STDB_TARGET=test.';

/** M8: `vite preview` reads no vercel.json and serves any target; the repo's preview is test-only. */
const VITE_PREVIEW_REFUSAL =
    '`vite preview` is not used in this repo: it would serve any build, prod included, on localhost. Run `npm run preview` (test database only, vercel.json rules).';

export default defineConfig(({ command, mode, isPreview }) => {
    if (command === 'serve' && isPreview) throw new Error(VITE_PREVIEW_REFUSAL);
    if (command === 'serve' && !isPreview) {
        // The dev server never serves the prod target (`vite preview` is refused above).
        const target =
            process.env.VITE_STDB_TARGET ?? loadEnv(mode, r('.'), 'VITE_').VITE_STDB_TARGET;
        if (target === 'prod') throw new Error(DEV_PROD_REFUSAL);
    }
    if (command === 'build') {
        // main.tsx throws at start on a missing or unknown target: refuse to build such a page.
        const target =
            process.env.VITE_STDB_TARGET ?? loadEnv(mode, r('.'), 'VITE_').VITE_STDB_TARGET;
        if (target !== 'test' && target !== 'prod') {
            throw new Error(
                `VITE_STDB_TARGET must be "test" or "prod" for a build (got ${target === undefined ? 'nothing' : `"${target}"`}). Set it in the build environment (Vercel: Preview = test, Production = prod).`,
            );
        }
    }

    return {
        plugins: [
            // Must come before the React plugin.
            tanstackRouter({
                target: 'react',
                autoCodeSplitting: true,
                routesDirectory: 'src/routes',
                generatedRouteTree: 'src/routeTree.gen.ts',
                // Test files next to the routes (routes.test.tsx) are not routes.
                routeFileIgnorePattern: '\\.test\\.tsx?$',
            }),
            react(),
            // M5b: the login routes on `npm run dev` only (test database only; not in the bundle).
            // A build never adds it, and the plugin loads scripts/ lazily (not uploaded to Vercel).
            ...(command === 'serve' && !isPreview ? [localAuthPlugin(r('..'))] : []),
        ],
        resolve: {
            alias: {
                '@': r('./src'),
                '@shared': r('../shared'),
                '@bindings': r('./src/module_bindings'),
            },
        },
        // Lets Vite read ../shared (and the hoisted node_modules) from the repo root.
        server: { fs: { allow: [r('..')] } },
        css: {
            transformer: 'lightningcss',
            lightningcss: { drafts: { customMedia: true } },
        },
        build: {
            target: 'es2022',
            cssMinify: 'lightningcss',
        },
        define: {
            __BUILD_ID__: JSON.stringify(process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 8) ?? 'dev'),
        },
        envPrefix: 'VITE_',
    };
});
