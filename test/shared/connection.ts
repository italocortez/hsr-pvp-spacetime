/**
 * SpacetimeDB integration test connection helper.
 *
 * Two harness types:
 *   - createTestHarness(): Guest user — for permission guard tests
 *   - createVerifiedTestHarness(): Verified user — for roster CRUD tests
 *     (requires SPACETIMEDB_SERVER_TOKEN env var)
 *
 * Reducer calls return Promises:
 *   - Resolves on success (committed)
 *   - Rejects with SenderError on reducer error (validation, permissions)
 */

import { DbConnection } from '@/src/module_bindings';

// Default to maincloud, overridable via env.
// Read lazily via getters so standalone scripts can parse .env.local
// before first use (static imports evaluate before top-level side effects).
function getUri() { return process.env.SPACETIMEDB_URI || 'wss://maincloud.spacetimedb.com'; }
function getDb() { return process.env.SPACETIMEDB_DB || process.env.SPACETIMEDB_DB_NAME || process.env.PUBLIC_SPACETIMEDB_DB_NAME || 'hsrpvp-spacetimedb-nextjs-test1'; }
function getServerToken() { return process.env.SPACETIMEDB_SERVER_TOKEN || ''; }

export interface TestHarness {
  conn: DbConnection;
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
 * Requires SPACETIMEDB_SERVER_TOKEN env var.
 * Calls server_link_provider to upgrade the guest to a verified user.
 */
export async function createVerifiedTestHarness(): Promise<TestHarness> {
  if (!hasServerToken()) {
    throw new Error(
      'SPACETIMEDB_SERVER_TOKEN required for verified test harness. ' +
      'Set it in .env.local (written by scripts/post-publish.ts)'
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

        // Login as guest first
        await connInner.reducers.loginAsGuest({});

        if (opts.verify && getServerToken()) {
          // Create a second connection with the server token to call server_link_provider
          await verifyUserViaServerConnection(identityHex);
          // Re-login to refresh the user data in subscription cache
          await connInner.reducers.loginAsGuest({});
        }

        clearTimeout(timeout);

        // Subscribe with onApplied — resolves when initial data is in client cache
        connInner.subscriptionBuilder()
          .onApplied(async () => {
            let userId = 0;

            if (opts.verify) {
              // Read from view_my_identity — returns caller's UserIdentity row.
              // No spacetime sql CLI roundtrip — the view is subscribed via
              // subscribeToAllTables() and cached in the client.
              const idRows = [...connInner.db.view_my_identity.iter()];
              userId = idRows.length > 0 ? (idRows[0] as any).userId : 0;
            } else {
              // Guest path: match Guest_<shortId> in subscription cache
              const shortId = identityHex.slice(0, 8);
              const guestUsername = `Guest_${shortId}`;
              const allUsers = [...connInner.db.User.iter()];
              const myUser = allUsers.find((u: any) => u.username === guestUsername);
              if (myUser) {
                userId = (myUser as any).id;
              }
            }

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
 * Uses a server-token connection to call server_link_provider,
 * which upgrades a guest user to verified.
 */
function verifyUserViaServerConnection(targetIdentityHex: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server connection timeout')), 10000);

    // Generate a unique fake Discord ID for test users
    const testDiscordId = `test_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    DbConnection.builder()
      .withUri(getUri())
      .withDatabaseName(getDb())
      .withToken(getServerToken())
      .withConfirmedReads(false)
      .onConnect(async (serverConn) => {
        try {
          await serverConn.reducers.serverLinkProvider({
            callerIdentityHex: targetIdentityHex,
            provider: 'discord',
            providerId: testDiscordId,
            providerName: `TestUser_${testDiscordId.slice(-6)}`,
          });
          clearTimeout(timeout);
          serverConn.disconnect();
          // Give time for the update to propagate
          setTimeout(resolve, 500);
        } catch (err) {
          clearTimeout(timeout);
          serverConn.disconnect();
          reject(err);
        }
      })
      .onConnectError((_ctx, err) => {
        clearTimeout(timeout);
        reject(new Error(`Server connection failed: ${err}`));
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
 * Returns it by querying UserPrivate via SQL (private table, not in client subscription).
 */
export async function getTestDiscordId(userId: number): Promise<string> {
  const rows = await queryPrivateTable(
    `SELECT discord_id FROM user_private WHERE user_id = ${userId}`
  );
  if (rows.length === 0) throw new Error(`No UserPrivate found for userId ${userId}`);
  return unwrapSqlOptional(rows[0].discord_id);
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
 * Use this for tables with `public: false` (UserPrivate, BanRecord, UserIdentity,
 * PlayerStat, PlayerCharacterStat, PlayerRelationship) that aren't accessible
 * via WebSocket subscriptions.
 */
export async function queryPrivateTable(sql: string): Promise<Record<string, string>[]> {
  const { execFileSync } = await import('child_process');
  const db = getDb();
  const raw = execFileSync('spacetime', ['sql', db, sql], {
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
