import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    // Default: run unit tests only (fast, no dependencies)
    include: ['test/backend/**/*.unit.test.ts'],
    testTimeout: 5000,
    hookTimeout: 10000,
  },
  resolve: {
    alias: {
      '@/': path.resolve(__dirname, '../') + '/',
      // Mock SpacetimeDB server module for unit tests
      'spacetimedb/server': path.resolve(__dirname, 'shared/mocks/spacetimedb-server.ts'),
    },
  },
});
