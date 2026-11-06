/**
 * Environment loader for standalone test/UAT scripts (tmp/uat-*.ts).
 *
 * Resolves the backend through test/shared/env.ts (the shared/stdb-targets.ts resolver):
 * requires STDB_TARGET=test and loads `.env.test.local` (written by `npm run stdb:bootstrap:test`)
 * into process.env before connection.ts reads it. connection.ts reads lazily, so this only has
 * to run before the first harness is created.
 *
 * Usage in standalone scripts (run with STDB_TARGET=test in the environment):
 *
 *   import '../test/shared/load-env';
 *   import { createVerifiedTestHarness } from '../test/shared/connection';
 *
 * For vitest tests: NOT needed — vitest.integration.config.ts does the same.
 */

import { backendEnv } from './env';

backendEnv();
