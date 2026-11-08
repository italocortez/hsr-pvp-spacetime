import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    // Default: run unit tests only (fast, no dependencies)
    include: ['test/backend/**/*.unit.test.ts', 'shared/**/*.test.ts'],
    testTimeout: 5000,
    hookTimeout: 10000,
  },
  resolve: {
    alias: {
      '@/src/module_bindings': path.resolve(__dirname, '../web/src/module_bindings'),
      '@/': path.resolve(__dirname, '../') + '/',
      // tsconfig.base.json paths: module helpers reached by the unit suites import the shared barrels (S7).
      '@shared': path.resolve(__dirname, '../shared'),
      // spacetimedb/tsconfig.json @module/*: module helpers import each other through the alias (S8h).
      '@module': path.resolve(__dirname, '../spacetimedb/src'),
      // Mock SpacetimeDB server module for unit tests
      'spacetimedb/server': path.resolve(__dirname, 'shared/mocks/spacetimedb-server.ts'),
    },
  },
});
