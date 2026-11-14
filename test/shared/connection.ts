/**
 * SpacetimeDB integration test connection helper.
 *
 * Two harness types:
 *   - createTestHarness(): Guest user — for permission guard tests
 *   - createVerifiedTestHarness(): Verified user — for roster CRUD tests
 *     (requires STDB_SERVER_TOKEN in .env.test.local)
 *
 * Reducer calls return Promises:
 *   - Resolves on success (committed)
 *   - Rejects with SenderError on reducer error (validation, permissions)
 */

import { DbConnection } from '@bindings/index';
import { readArgs } from '../../shared/stdb-targets';
import { backendEnv, serverToken } from './env';
import { hasLinkToken, signInLive } from './sign-in';

// Resolved lazily through the shared/stdb-targets.ts resolver (STDB_TARGET=test + .env.test.local),
// so the token rotated by globalSetup's bootstrap is picked up on the next call.
function getUri() { return backendEnv().host; }
function getDb() { return backendEnv().dbName; }
function getServerToken() { return serverToken(); }

/**
 * T-S3 compile-only fix: S3 made 27 tables private (A37, Appendix A), so their accessors left the generated
 * bindings and the live suite's raw-table reads (`h.conn.db.Lobby`, ...) no longer type-check. The suite is
 * rewritten in-memory in S10 (D-D2); until then `db` is untyped on the harness connection so the files
 * compile unchanged. Reducers stay fully typed.
 */
export type LiveConnection = Omit<DbConnection, 'db'> & { readonly db: any };

export interface TestHarness {
  conn: LiveConnection;
  identity: string;
  /** Numeric user ID from the User table — use to filter iter() results to this test's user */
  userId: number;
  /** Typed reducer calls — each returns Promise<void>, rejects with SenderError on failure */
  call: DbConnection['reducers'];
  /** Wait for subscription cache to sync after reducer calls */
  sync: (ms?: number) => Promise<void>;
  disconnect: () => Promise<void>;
}

/** Check if a server token is available for verified user tests */
export function hasServerToken(): boolean {
  return getServerToken().length > 0;
}

/**
 * Creates a connected test harness with subscriptions to all tables.
 * Logs in as guest — good for permission guard tests.
 */
export async function createTestHarness(): Promise<TestHarness> {
  return createHarnessInternal({ verify: false });
}

/**
 * Creates a connected test harness with a verified (non-guest) user.
 * Requires STDB_LINK_TOKEN in .env.test.local (T-M5a3).
 * Signs the guest in the real way (request, present as the linker, confirm; test/shared/sign-in.ts).
 */
export async function createVerifiedTestHarness(): Promise<TestHarness> {
  if (!hasLinkToken()) {
    throw new Error(
      'STDB_LINK_TOKEN required for verified test harness. ' +
      'It lives in .env.test.local (written by npm run stdb:bootstrap:test since M5a3)'
    );
  }
  return createHarnessInternal({ verify: true });
}

function createHarnessInternal(opts: { verify: boolean }): Promise<TestHarness> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Connection timeout (30s)')), 30000);

    const builder = DbConnection.builder()
      .withUri(getUri())
      .withDatabaseName(getDb())
      .withConfirmedReads(false);

    builder
      .onConnect(async (connInner, identity, _token) => {
        const identityHex = identity.toHexString();

        // T-M5a3-fix: a rejection here (login or sign-in) must reach the caller with its own message, not as the 30 s
        // timeout: an async onConnect's rejection is not seen by the SDK.
        try {
          // Login as guest first
          await connInner.reducers.loginAsGuest({});

          if (opts.verify) {
            // T-M5a3: the real sign-in (request, present on a linker-token connection, confirm on this connection)
            await signInLive(connInner as any, `TestUser_${Math.random().toString(36).slice(2, 8)}`);
            // Re-login to refresh the user data in subscription cache
            await connInner.reducers.loginAsGuest({});
          }
        } catch (err) {
          clearTimeout(timeout);
          connInner.disconnect();
          reject(new Error(`${opts.verify ? 'Sign-in' : 'Guest login'} failed: ${err instanceof Error ? err.message : String(err)}`));
          return;
        }

        clearTimeout(timeout);

        // Subscribe with onApplied — resolves when initial data is in client cache
        connInner.subscriptionBuilder()
          .onApplied(async () => {
            // Read from view_my_identity — returns caller's UserIdentity row, for guests and verified users alike.
            // No spacetime sql CLI roundtrip — the view is subscribed via subscribeToAllTables() and cached in the
            // client. A77(3) (S11a): the guest path no longer scans the User table, which is private.
            const idRows = [...connInner.db.viewMyIdentity.iter()];
            const userId: number = idRows.length > 0 ? (idRows[0] as any).userId : 0;

            const harness: TestHarness = {
              conn: connInner,
              identity: identityHex,
              userId,
              call: connInner.reducers,

              sync(ms = 500): Promise<void> {
                return new Promise((res) => setTimeout(res, ms));
              },

              async disconnect(): Promise<void> {
                connInner.disconnect();
              },
            };

            resolve(harness);
          })
          .subscribeToAllTables();
      })
      .onConnectError((_ctx, err) => {
        clearTimeout(timeout);
        reject(new Error(`SpacetimeDB connection failed: ${err}`));
      })
      .onDisconnect(() => {})
      .build();
  });
}


/**
 * Unwrap SpacetimeDB SQL optional value format.
 * SQL returns `(some = "value")` for Some and `(none = ())` for None.
 * Strips the wrapper and quotes, returning the raw value or empty string.
 */
export function unwrapSqlOptional(raw: string): string {
  if (!raw) return '';
  const someMatch = raw.match(/^\(some\s*=\s*"(.*)"\)$/);
  if (someMatch) return someMatch[1];
  if (raw.match(/^\(none\s*=\s*\(\)\)$/)) return '';
  // Already a plain value (non-optional column) — strip quotes if present
  return raw.replace(/^"|"$/g, '');
}

/**
 * Get the test Discord provider ID for a verified harness user.
 * The test harness uses `test_<timestamp>_<random>` as the Discord provider ID.
 * Returns it by querying the private User table via SQL (A77: the provider columns moved there from UserPrivate).
 */
export async function getTestDiscordId(userId: number): Promise<string> {
  const rows = await queryPrivateTable(
    `SELECT provider_id FROM user WHERE id = ${userId}`
  );
  if (rows.length === 0) throw new Error(`No User found for userId ${userId}`);
  return unwrapSqlOptional(rows[0].provider_id);
}

/**
 * Helper: call a reducer expecting it to fail, return the error message.
 * If it doesn't fail, throws an assertion error.
 */
export async function expectReducerError(
  promise: Promise<void>
): Promise<string> {
  try {
    await promise;
    throw new Error('Expected reducer to fail, but it succeeded');
  } catch (err: any) {
    if (err.message === 'Expected reducer to fail, but it succeeded') throw err;
    return err.message || String(err);
  }
}

/**
 * Utility: wait for a fixed duration (use sparingly — prefer sync()).
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Query private tables via `spacetime sql` CLI.
 * Returns parsed rows as key-value objects (snake_case column names).
 *
 * Use this for tables with `public: false` (User (A77), BanRecord, UserIdentity,
 * PlayerStat, PlayerCharacterStat, PlayerRelationship) that aren't accessible
 * via WebSocket subscriptions.
 */
export async function queryPrivateTable(sql: string): Promise<Record<string, string>[]> {
  const { execFileSync } = await import('child_process');
  // Explicit name + --server maincloud --no-config (never the spacetime.json default).
  const raw = execFileSync('spacetime', readArgs(backendEnv().target, 'sql', [sql]), {
    encoding: 'utf-8',
    timeout: 15000,
  });

  // Parse text table: header row, separator row, then data rows
  const lines = raw.split('\n').filter(l => l.trim().length > 0 && !l.startsWith('WARNING'));
  if (lines.length < 2) return [];

  const headers = lines[0].split('|').map(h => h.trim());
  // Skip separator line (dashes)
  const rows: Record<string, string>[] = [];
  for (let i = 2; i < lines.length; i++) {
    const vals = lines[i].split('|').map(v => v.trim());
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => { if (h) row[h] = vals[idx] ?? ''; });
    rows.push(row);
  }
  return rows;
}
