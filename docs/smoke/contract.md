# Smoke Tests & Bootstrap Infrastructure

**Architecture:** [architecture.md](architecture.md)

## Feature Overview

Bootstrap infrastructure handles the one-time setup of a freshly published SpacetimeDB database — registering the trusted server identity, creating the SYSTEM user, persisting the server token, and seeding game data. The test harness provides reusable connection patterns for integration tests: guest harnesses for permission guard testing and verified harnesses for feature CRUD testing. This contract covers the bootstrap lifecycle and test infrastructure only; individual reducer behaviors are documented in [admin/contract.md](../admin/contract.md) and [auth/contract.md](../auth/contract.md).

## Bootstrap Scripts

### `scripts/post-publish.ts` (Full Bootstrap)

**Purpose:** End-to-end database initialization after `spacetime publish --clear-database`

For re-publishes that include schema deltas already reviewed in a prior diff, use `npm run spacetime:publish:migrate` (appends `--yes=migrate`, skips ONLY the destructive-migration confirm prompt). Default `npm run spacetime:publish` stays interactive.

**Run:** `npx tsx scripts/post-publish.ts`

**Flow:**
1. Reads `spacetime.json` for database name and server
2. Connects to SpacetimeDB with **no token** (receives a fresh identity)
3. Calls `registerServer` — inserts ServerIdentity, creates SYSTEM user (id=0, role=Admin), links identity via UserIdentity
4. Writes the connection token to `.env.local` as `SPACETIMEDB_SERVER_TOKEN`
5. Calls `seedAll()` — upserts HsrCharacter, HsrLightcone, costs, archetypes, synergies
6. Seeds 3 starter achievements (MMR Elite, Veteran, Solar First Tournament Winner)
7. Seeds config tables (EloConfig, AccountRatingConfig) with defaults

**Preconditions:**
- Database must be freshly cleared (no ServerIdentity row exists)
- Must run from project root (reads `spacetime.json`)
- `.env.local` may or may not exist (creates/appends as needed)

**Postconditions:**
- `SPACETIMEDB_SERVER_TOKEN` written to `.env.local`
- SYSTEM user exists with id=0, role=Admin
- All game data tables populated
- Config tables seeded with defaults

**Error Cases:**
| Condition | Behavior |
|-----------|----------|
| ServerIdentity already exists | `registerServer` throws; script exits with error |
| `spacetime.json` not found | Script exits with "run from project root" error |
| Seed data fails | Token is still written; script advises manual `seed-data.ts` retry |

### `scripts/register-server.ts` (Lightweight Registration)

**Purpose:** Register server identity only — no seeding, no `.env.local` write

**Run:** `npx tsx scripts/register-server.ts`

**Flow:**
1. Reads `spacetime.json` for database name
2. Connects with no token (fresh identity)
3. Calls `registerServer`
4. Prints token to stdout — user must manually add to `.env.local`

**Use case:** When you only need the server token (e.g., re-registering on a test database without re-seeding).

### `test/shared/bootstrap.ts` (Test Database Bootstrap)

**Purpose:** Re-register server identity on a test database using an **existing** token

**Run:** `npx tsx test/shared/bootstrap.ts`

**Flow:**
1. Reads `SPACETIMEDB_SERVER_TOKEN`, `SPACETIMEDB_URI`, `SPACETIMEDB_DB` from `.env.local`
2. Connects **with** the existing token
3. Calls `registerServer`

**Preconditions:**
- `SPACETIMEDB_SERVER_TOKEN` must exist in `.env.local`
- Database must be freshly cleared

**Use case:** After `--clear-database` on the test DB, when the token is already known.

## Test Harness

### `createTestHarness()` (Guest Harness)

**Purpose:** Create a connected guest user for permission guard tests

**Flow:**
1. `DbConnection.builder()` connects to test DB (defaults: `wss://maincloud.spacetimedb.com`, `hsrpvp-spacetimedb-nextjs-test1`)
2. Subscribes to all tables
3. Calls `loginAsGuest` — creates User + UserIdentity
4. Resolves `userId` from subscription cache by matching `Guest_{hex8}` username pattern
5. Returns `TestHarness` object

**Preconditions:**
- Database must be bootstrapped (ServerIdentity + SYSTEM user exist)
- No `SPACETIMEDB_SERVER_TOKEN` required

### `createVerifiedTestHarness()` (Verified Harness)

**Purpose:** Create a connected verified (non-guest) user for feature CRUD tests

**Flow:**
1. Same as guest harness steps 1-3
2. Opens a **second** connection using `SPACETIMEDB_SERVER_TOKEN`
3. Server connection calls `serverLinkProvider` with test Discord ID (`test_{timestamp}_{random}`) and name (`TestUser_{suffix}`)
4. Re-calls `loginAsGuest` on the original connection to refresh subscription cache
5. Resolves `userId` by matching `TestUser_*` username pattern
6. Returns `TestHarness` object

**Preconditions:**
- Database must be bootstrapped
- `SPACETIMEDB_SERVER_TOKEN` must be set in environment (from `.env.local`)

**Error Cases:**
| Condition | Behavior |
|-----------|----------|
| `SPACETIMEDB_SERVER_TOKEN` missing | Throws immediately with descriptive error |
| Connection timeout (15s) | Rejects with "Connection timeout (15s)" |
| Server connection timeout (10s) | Rejects with "Server connection timeout" |

### TestHarness Interface

```typescript
interface TestHarness {
  conn: DbConnection;        // Active WebSocket connection
  identity: string;          // Identity hex string
  userId: number;            // Resolved User.id
  call: DbConnection['reducers'];  // Typed reducer calls (Promise-based)
  sync: (ms?) => Promise<void>;    // Wait for subscription cache sync (default 500ms)
  disconnect: () => Promise<void>;
}
```

### Test Utilities

| Function | Purpose |
|----------|---------|
| `expectReducerError(promise)` | Asserts a reducer call fails; returns the error message string |
| `queryPrivateTable(sql)` | Runs `spacetime sql` CLI to read private tables (UserPrivate, BanRecord, UserIdentity, etc.) |
| `getTestDiscordId(userId)` | Queries UserPrivate via SQL for the test Discord provider ID |
| `hasServerToken()` | Returns `true` if `SPACETIMEDB_SERVER_TOKEN` is available in environment |
| `sleep(ms)` | Fixed-duration wait (use sparingly; prefer `sync()`) |

## Acceptance Scenarios

### Full Bootstrap (Clean Database)
**Given:** Database freshly published with `--clear-database`, no ServerIdentity exists
**When:** `npx tsx scripts/post-publish.ts` is run from project root
**Then:** ServerIdentity row inserted. SYSTEM user created (id=0, username=`SYSTEM`, role=Admin). UserIdentity links server identity to SYSTEM user. Token written to `.env.local`. Game data tables seeded. Config tables seeded.

### Bootstrap Rejection (Already Registered)
**Given:** ServerIdentity row already exists (database not cleared)
**When:** `npx tsx scripts/post-publish.ts` is run
**Then:** `registerServer` throws "Server identity already registered. To re-register, clear the database first." Script exits with error.

### Guest Harness Connection
**Given:** Database is bootstrapped (ServerIdentity + SYSTEM user exist)
**When:** `createTestHarness()` is called
**Then:** Resolves with a `TestHarness` where `userId` > 0, User row has `isGuest=true`, `username=Guest_{hex8}`.

### Verified Harness Connection
**Given:** Database is bootstrapped, `SPACETIMEDB_SERVER_TOKEN` is set
**When:** `createVerifiedTestHarness()` is called
**Then:** Resolves with a `TestHarness` where `userId` > 0, User row has `isGuest=false`, `hasDiscordLinked=true`, `username=TestUser_{suffix}`.

### Verified Harness Without Token
**Given:** `SPACETIMEDB_SERVER_TOKEN` is not set in environment
**When:** `createVerifiedTestHarness()` is called
**Then:** Throws immediately: "SPACETIMEDB_SERVER_TOKEN required for verified test harness. Set it in .env.local (written by scripts/post-publish.ts)"

### Connection Timeout
**Given:** SpacetimeDB host is unreachable or database does not exist
**When:** `createTestHarness()` is called
**Then:** Rejects after 15 seconds with "Connection timeout (15s)".

### Private Table Query
**Given:** A verified test user exists with a UserPrivate row
**When:** `queryPrivateTable('SELECT * FROM user_private WHERE user_id = N')` is called
**Then:** Returns parsed row objects with snake_case column names (e.g., `discord_id`, `discord_username`). UserPrivate is `public: false` and not accessible via WebSocket subscriptions.

### Dual-Connection Verification Pattern
**Given:** Guest user connected, server token available
**When:** `verifyUserViaServerConnection(identityHex)` is called internally
**Then:** Second connection opens with server token. Calls `serverLinkProvider` with test Discord ID. Disconnects server connection. Original user is upgraded to verified in the database.

## Identity Garbage Collection (Phase 12.1)

### Scheduled Identity GC Run
**Given:** `IdentityGcJob` row exists with a past `scheduledAt`
**When:** `run_identity_gc` fires (scheduled reducer)
**Then:** Scans all UserIdentity rows, applies guard logic (skip guests, skip online, preserve newest, delete orphans), deletes qualifying rows, writes `GcResult` (gcType='identity') only when items deleted, self-requeues 7 days out via new `IdentityGcJob` row.

### GC Guard: Skip Guests (D-06)
**Given:** A guest user (isGuest=true) with an identity whose `lastSeenAt` is older than 90 days
**When:** Identity GC runs
**Then:** Guest's identity is NOT deleted — guest users are excluded from GC regardless of staleness.

### GC Guard: Skip Online Users (D-08)
**Given:** An online user (isOnline=true) with an identity whose `lastSeenAt` is older than 90 days
**When:** Identity GC runs
**Then:** Online user's identity is NOT deleted — actively connected identities are never collected.

### GC Guard: Preserve Newest (D-07)
**Given:** A user with 2+ identities, all past the 90-day TTL
**When:** Identity GC runs
**Then:** The newest identity (by `lastSeenAt`) is preserved; remaining stale identities are deleted.

### GC Guard: Orphan Cleanup (D-12)
**Given:** A UserIdentity row exists with no matching User row (orphaned)
**When:** Identity GC runs
**Then:** Orphaned identity deleted immediately regardless of age — no TTL check needed.

### Admin GC Trigger
**Given:** Caller has Moderator or Admin role
**When:** `admin_gc_identities` is called
**Then:** Runs same GC logic as scheduled. Writes `GcResult` unconditionally (even if zero items deleted). Does NOT self-requeue a new `IdentityGcJob`.

### Admin GC Auth Guard
**Given:** Caller has role=User (not Moderator or Admin)
**When:** `admin_gc_identities` or `admin_gc_lobbies` is called
**Then:** Rejected with "Requires Moderator or Admin privileges".

### Seed Identity GC Job Idempotency
**Given:** `IdentityGcJob` table already has a row
**When:** `seed_identity_gc_job` is called
**Then:** No-op — no duplicate row created. Existing schedule preserved.

### lastSeenAt Bump on Connect
**Given:** A user connects via WebSocket, UserIdentity exists for `ctx.sender`
**When:** `clientConnected` lifecycle hook fires
**Then:** `UserIdentity.lastSeenAt` updated to `ctx.timestamp`. This keeps active users' identities fresh for GC TTL calculation.

## Edge Cases

| Case | Expected Behavior | Notes |
|------|-------------------|-------|
| Two `post-publish.ts` runs without clearing | Second run fails on `registerServer` | First-come-first-served; token from first run is valid |
| Guest harness userId resolution fallback | Falls back to most recently inserted non-SYSTEM user | Handles edge cases where username pattern match fails |
| Verified harness re-login after link | Calls `loginAsGuest` again to refresh subscription cache | Without re-login, cached User row still shows `isGuest=true` |
| `queryPrivateTable` on empty result | Returns empty array `[]` | Parser handles < 2 output lines gracefully |
| `queryPrivateTable` with WARNING lines | Filters out lines starting with "WARNING" | SpacetimeDB CLI sometimes emits warnings before table output |
| Connection to wrong database name | `onConnectError` fires; harness rejects | Database name comes from `SPACETIMEDB_DB` env var or default |
| Multiple harnesses in one test file | Each gets a unique identity and userId | `afterAll` should disconnect all harnesses to avoid connection leaks |
| `sync()` timing insufficient | Subscription cache may not reflect reducer changes | Increase `sync(ms)` parameter for slow operations; default is 500ms |
| Identity GC with only one identity per user | That identity is preserved even if past TTL | D-07: preserve-newest guard keeps at least one identity per user |
| Identity GC on user with no identities | No-op for that user — nothing to scan | Shouldn't happen (User always has ≥1 UserIdentity) |
| Orphaned UserIdentity with valid lastSeenAt | Deleted immediately — orphan guard ignores TTL | D-12: no matching User row = unconditional delete |
| Admin GC on empty database | GcResult written with identitiesDeleted=0 | Admin always writes audit row, even for no-op runs |
| Scheduled GC on empty database | No GcResult written; silently self-requeues | Scheduled writes GcResult only when items were actually deleted |
| Two seed_identity_gc_job calls | Second call is no-op | Idempotent — checks for existing row before insert |
| clientConnected for unknown identity | lastSeenAt NOT updated (no UserIdentity row) | No-op path in clientConnected; user must call login_as_guest first |

## Integration Points

| This Feature | Connects To | How | Direction |
|-------------|------------|-----|-----------|
| `post-publish.ts` | `register_server` reducer | Calls reducer to bootstrap ServerIdentity + SYSTEM user | writes |
| `post-publish.ts` | `seedAll()` in `scripts/seed-data.ts` | Seeds HsrCharacter, HsrLightcone, costs, archetypes, synergies | writes |
| `post-publish.ts` | Achievement reducers | Creates starter achievements + criteria | writes |
| `post-publish.ts` | Config reducers (`adminSeedEloConfig`, `adminSeedRatingConfig`) | Seeds default config rows | writes |
| `post-publish.ts` | `.env.local` | Writes `SPACETIMEDB_SERVER_TOKEN` | writes |
| `createVerifiedTestHarness` | `server_link_provider` reducer | Upgrades guest to verified via server connection | writes |
| `createTestHarness` | `login_as_guest` reducer | Creates guest User + UserIdentity | writes |
| `queryPrivateTable` | SpacetimeDB CLI (`spacetime sql`) | Reads private tables not in client subscriptions | reads |
| `vitest.integration.config.ts` | `.env.local` | Loads `SPACETIMEDB_*` env vars at config time | reads |
| `test/shared/load-env.ts` | `.env.local` | Parses env vars for standalone scripts outside vitest | reads |
| All scripts | `spacetime.json` | Database name + server (single source of truth) | reads |
| `run_identity_gc` | `UserIdentity` table | Scans all rows, deletes stale/orphaned | reads/writes |
| `run_identity_gc` | `User` table | Checks isGuest, isOnline, existence (orphan detection) | reads |
| `run_identity_gc` | `GcResult` table | Writes audit row when identities deleted | writes |
| `run_identity_gc` | `IdentityGcJob` table | Self-requeues 7 days out | writes |
| `admin_gc_identities` | Same as `run_identity_gc` | Same GC logic, always writes GcResult, no self-requeue | reads/writes |
| `admin_gc_lobbies` | `performLobbyGc` helper | On-demand lobby GC trigger | reads/writes |
| `seed_identity_gc_job` | `IdentityGcJob` table | Idempotent bootstrap insert | writes |
| `clientConnected` | `UserIdentity.lastSeenAt` | Bumps timestamp on WebSocket connect | writes |
| `post-publish.ts` | `seed_identity_gc_job` | Seeds weekly identity GC schedule | writes |
| `post-publish.ts` | `seed_lobby_gc_job` | Seeds lobby GC schedule | writes |

## Integration Test Configuration

| Setting | Value | Reason |
|---------|-------|--------|
| Include pattern | `test/backend/**/*.test.ts` (excludes `*.unit.test.ts`) | Separates integration from unit tests |
| Test timeout | 30,000ms | Network round-trips to maincloud |
| Hook timeout | 30,000ms | `beforeAll` creates harnesses with WebSocket connections |
| File parallelism | `false` | Tests share SpacetimeDB state; parallel execution causes race conditions |
| Sequence concurrent | `false` | Tests within a file run sequentially |
| Path alias | `@/` -> project root | Matches Next.js path alias for module imports |

## Phase History

| Decision | Source | Date |
|----------|--------|------|
| First-come-first-served `register_server` with SYSTEM user bootstrap | Phase 1 execution | 2026-03-16 |
| `post-publish.ts` as single bootstrap entry point (replaces manual steps) | Quick task 260318-2ci | 2026-03-18 |
| Test harness dual-connection pattern for verified user creation | Quick task 260318-2ci | 2026-03-18 |
| `queryPrivateTable` for private table assertions via `spacetime sql` CLI | Phase 10.5 execution | 2026-04-03 |
| Sequential test execution (`fileParallelism: false`) to avoid shared-state races | Phase 10.5 execution | 2026-04-03 |
| `server_link_provider` replaces `server_link_discord` in test harness | Phase 12 execution | 2026-04-08 |
| UserIdentity made private; harness resolves userId from User table patterns | Phase 12 execution | 2026-04-08 |
| `getTestDiscordId` uses `queryPrivateTable` (UserPrivate is private) | Phase 12 execution | 2026-04-08 |
| Identity GC: 90-day TTL with guards (skip guests, skip online, preserve newest, orphan cleanup) | Phase 12.1 execution | 2026-04-08 |
| GcResult audit table for identity and lobby GC runs | Phase 12.1 execution | 2026-04-08 |
| IdentityGcJob scheduled table with 7-day self-requeue | Phase 12.1 execution | 2026-04-08 |
| admin_gc_identities / admin_gc_lobbies: Moderator+ on-demand GC with unconditional audit | Phase 12.1 execution | 2026-04-08 |
| seed_identity_gc_job / seed_lobby_gc_job: idempotent bootstrap in post-publish | Phase 12.1 execution | 2026-04-08 |
| clientConnected bumps UserIdentity.lastSeenAt for GC freshness | Phase 12.1 execution | 2026-04-08 |
| Full hydration from codebase | Phase 13 normalization | 2026-04-09 |

---

*Last updated: 2026-04-09*
