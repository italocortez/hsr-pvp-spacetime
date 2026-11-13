import { defineConfig } from 'vitest/config';
import path from 'path';
import { backendEnv } from './shared/env';

// Resolve the backend before anything connects (ACCESS-SECURITY-OPS §C.2): STDB_TARGET must be
// `test` (npm run test:integration sets it) and .env.test.local is loaded into process.env.
// Fails fast instead of guessing a database. Nothing reads .env.local.
backendEnv();

export default defineConfig({
  test: {
    // T-S10: the live residue only (ACCESS-SECURITY-OPS §D.5); everything else runs in memory.
    include: ['test/live/**/*.test.ts'],
    alias: {
      '@bindings': path.resolve(__dirname, '../web/src/module_bindings'),
    },

    // Integration tests need more time (network, SpacetimeDB round-trips).
    // Hooks often create multiple verified harnesses which compound latency
    // against maincloud — 120s gives headroom for up to 6 harnesses + setup.
    testTimeout: 60000,
    hookTimeout: 120000,

    // Run sequentially — tests share SpacetimeDB state and WebSocket connections to maincloud
    // fileParallelism: false prevents parallel file execution (avoids connection saturation)
    sequence: {
      concurrent: false,
    },
    fileParallelism: false,

    // Clear + reseed the maincloud test database once before the suite.
    // Tests leak state that has no auto-cleanup path (AwaitingResult lobbies per
    // D-48, User/UserPrivate rows with no delete reducer). Without this, state
    // accumulates across runs and later tests hit timeout ceilings as tables grow.
    // Opt out per invocation with SKIP_DB_CLEAR=1. See test/global-setup.ts.
    globalSetup: ['./test/global-setup.ts'],
  },
  resolve: {
    alias: {
      '@bindings': path.resolve(__dirname, '../web/src/module_bindings'),
    },
  },
});
