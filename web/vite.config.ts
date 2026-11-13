import { fileURLToPath } from 'node:url';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/** Same text as DEV_PROD_REFUSAL in src/stdb/assertDevTarget.ts (user decision 2026-11-13). */
const DEV_PROD_REFUSAL =
    'Dev mode cannot run against the prod database. Set VITE_STDB_TARGET=test.';

export default defineConfig(({ command, mode, isPreview }) => {
    if (command === 'serve' && !isPreview) {
        // The dev server never serves the prod target (preview of a prod build is not dev).
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
