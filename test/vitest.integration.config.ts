import { defineConfig } from 'vitest/config';
import path from 'path';
import { readFileSync } from 'fs';

// Load .env.local into process.env for integration tests
// Vite's envDir only exposes VITE_* prefixed vars, but our tests use SPACETIMEDB_* directly
function loadEnvLocal() {
  try {
    const content = readFileSync(path.resolve(__dirname, '../.env.local'), 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      if (!process.env[key]) process.env[key] = value;
    }
  } catch { /* .env.local doesn't exist — tests will skip verified-user suites */ }
}

loadEnvLocal();

export default defineConfig({
  test: {
    include: ['test/backend/**/*.test.ts', '!test/backend/**/*.unit.test.ts'],
    alias: {
      '@/': path.resolve(__dirname, '../') + '/',
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
      '@/': path.resolve(__dirname, '../') + '/',
    },
  },
});
