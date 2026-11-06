/**
 * Vitest globalSetup for integration suite.
 *
 * Runs ONCE before the entire suite (not per-file) and wipes the maincloud
 * test database + runs the bootstrap so every `npm run test:integration`
 * invocation starts from a clean slate.
 *
 * Why: tests leak state that has no auto-cleanup path —
 *   - AwaitingResult lobbies are intentionally never GC'd (D-48, admin-only
 *     resolution) so tests that verify rejection/error paths permanently
 *     leak Lobby + MatchResultRecord rows.
 *   - User/UserPrivate/UserIdentity have no deletion path on disconnect, so
 *     createVerifiedTestHarness() monotonically grows the identity tables.
 *   - Cancelled Tournament rows persist by design (historical record).
 * Without this setup the DB accumulates state across runs; later tests scan
 * larger tables and hit timeout ceilings non-deterministically (Phase 14
 * flakiness investigation, Rounds 1-8).
 *
 * Safety:
 *   - STDB_TARGET must be `test` (set by `npm run test:integration`); the
 *     database name comes from shared/stdb-targets.ts and must pass
 *     assertNameMatchesTarget (carries "-test") and assertWipeAllowed.
 *   - Opt out per invocation with `SKIP_DB_CLEAR=1` (useful when iterating
 *     on a single failing file and you want to preserve DB state).
 *
 * Cost: ~60-90s per suite invocation (publish + seed). Amortized over a
 * ~57min full run this is <3% overhead for dramatically more deterministic
 * behavior.
 */

import { execSync } from 'child_process';
import {
    STDB_DATABASES,
    assertNameMatchesTarget,
    assertWipeAllowed,
    parseTarget,
} from '../shared/stdb-targets';
import { backendEnv } from './shared/env';

export default async function setup() {
    if (process.env.SKIP_DB_CLEAR === '1') {
        console.log('[global-setup] SKIP_DB_CLEAR=1 — skipping database reset');
        return;
    }

    const target = parseTarget(process.env.STDB_TARGET);
    const dbName = STDB_DATABASES[target];
    // Safety: refuse to wipe anything that is not the committed "-test" database.
    assertNameMatchesTarget(target, dbName);
    assertWipeAllowed(target);

    console.log(`[global-setup] Clearing database "${dbName}" before suite...`);
    const t0 = Date.now();

    try {
        execSync('npx tsx scripts/stdb/publish.ts --target test --clear', {
            stdio: 'inherit',
            cwd: process.cwd(),
        });
    } catch (err) {
        throw new Error(
            `[global-setup] scripts/stdb/publish.ts --target test --clear failed. ` +
            `Check typecheck, spacetime CLI, network, and maincloud login. Original: ${(err as Error).message}`
        );
    }

    console.log('[global-setup] Running bootstrap (delegate + seed data)...');
    try {
        execSync('npx tsx scripts/stdb/bootstrap.ts --target test', {
            stdio: 'inherit',
            cwd: process.cwd(),
        });
    } catch (err) {
        throw new Error(
            `[global-setup] scripts/stdb/bootstrap.ts failed after a successful wipe. ` +
            `Database is now empty and unseeded — rerun manually before next test invocation. ` +
            `Original: ${(err as Error).message}`
        );
    }

    // bootstrap ROTATES the delegate token and writes it to .env.test.local.
    // backendEnv() re-reads the file into process.env, so subsequent harness
    // connections use the fresh token, not a stale one from before the wipe.
    if (!backendEnv().serverToken) {
        throw new Error(
            '[global-setup] bootstrap completed but STDB_SERVER_TOKEN is missing from .env.test.local. ' +
            'Something went wrong during bootstrap.'
        );
    }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[global-setup] Database reset complete in ${elapsed}s. Suite starting on clean state.`);
}
