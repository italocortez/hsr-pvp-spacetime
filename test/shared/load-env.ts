/**
 * Environment loader for standalone test/UAT scripts (tmp/uat-*.ts).
 *
 * Parses .env.local and populates process.env BEFORE connection.ts reads it.
 * connection.ts uses lazy getters, so env vars just need to be set before
 * the first harness creation — not before import time.
 *
 * Usage in standalone scripts:
 *
 *   import '../test/shared/load-env';
 *   import { createVerifiedTestHarness } from '../test/shared/connection';
 *
 *   async function main() {
 *     const h = await createVerifiedTestHarness();
 *     // ... env vars are available, connection works
 *   }
 *
 * For vitest tests: NOT needed — vitest.integration.config.ts handles .env.local.
 * Why not dotenv? It's not a project dependency and we don't want to add one for this.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const envPath = resolve(process.cwd(), '.env.local');

try {
  const content = readFileSync(envPath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      // Don't overwrite existing env vars (CLI-set values take priority)
      if (!(key in process.env)) {
        process.env[key] = val;
      }
    }
  }
} catch {
  console.warn(`[load-env] Could not read ${envPath} — env vars may be missing`);
}
