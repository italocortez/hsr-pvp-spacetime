import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/*
 * Frontend tests (T-M9): jsdom, no network, no database. Run from the repo root with
 * `npm run test:web` (or as the third suite of `npm test`).
 *
 * The TanStack router plugin is left out on purpose: tests import the committed
 * `src/routeTree.gen.ts` as is, so a test run never rewrites it.
 */

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
    root: r('.'),
    plugins: [react()],
    resolve: {
        // Same aliases as vite.config.ts.
        alias: {
            '@': r('./src'),
            '@shared': r('../shared'),
            '@bindings': r('./src/module_bindings'),
        },
    },
    define: {
        __BUILD_ID__: JSON.stringify('test'),
    },
    test: {
        environment: 'jsdom',
        include: ['src/**/*.test.{ts,tsx}'],
        exclude: ['src/lib/legacy/**', 'src/module_bindings/**'],
        setupFiles: ['src/test/setup.ts'],
        // CSS is not processed: a CSS Module import is a proxy that returns a stable class name
        // for every key, so `styles.x` is always a non-empty string. Global CSS is never imported
        // by the tested code (main.tsx is not loaded).
        css: { modules: { classNameStrategy: 'stable' } },
        testTimeout: 5000,
    },
});
