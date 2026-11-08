// In-memory module tests (SpacetimeDB 2.12+ test-utils; D.7(2) spike, task T-S4(c)).
// Separate from test/vitest.config.ts on purpose: that config aliases `spacetimedb/server` to a mock,
// this one runs the real SDK against the in-memory datastore. No maincloud contact.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { spacetimedbModuleTestPlugin } from 'spacetimedb/server/test-utils/vitest';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const moduleRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
    root: moduleRoot,
    plugins: [spacetimedbModuleTestPlugin()],
    test: {
        environment: 'node',
        include: ['src/**/*.test.ts'],
        testTimeout: 10000,
    },
    resolve: {
        // Mirrors tsconfig.base.json `paths` (@shared/*, @bindings/*) and spacetimedb/tsconfig.json `@module/*`.
        alias: {
            '@shared': `${repoRoot}shared`,
            '@bindings': `${repoRoot}web/src/module_bindings`,
            '@module': `${moduleRoot}src`,
        },
    },
});
