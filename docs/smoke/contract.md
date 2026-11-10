# Smoke Tests & Bootstrap Infrastructure

**Architecture:** [architecture.md](architecture.md)

## Feature Overview

Bootstrap infrastructure handles the setup of a freshly published SpacetimeDB database: the module's `init` registers the publisher as the **Owner** server identity and creates the SYSTEM user; the bootstrap script registers a **Delegate** server identity, persists its token per target, and seeds game data. The test harness provides reusable connection patterns for integration tests: guest harnesses for permission guard testing and verified harnesses for feature CRUD testing. This contract covers the bootstrap lifecycle and test infrastructure only; individual reducer behaviors are documented in [admin/contract.md](../admin/contract.md) and [auth/contract.md](../auth/contract.md).

## Environment Scheme (Phase M2)

One vocabulary in every layer (ACCESS-SECURITY-OPS §C.2), implemented by `shared/stdb-targets.ts`:

| Concept | Name | Notes |
|---------|------|-------|
| Target | `test` \| `prod` | The only two values that parse; a missing target throws (no fallback) |
| Databases | `hsr-spacetimedb-test1` / `hsr-spacetimedb-prod` | Committed constants (`STDB_DATABASES`), not env vars |
| Node-side target | `--target <t>` flag or `STDB_TARGET` env | The flag wins |
| Browser target | `VITE_STDB_TARGET` | `web/.env.development` = `test`; Vercel Preview = `test`, Production = `prod` |
| Server token | `STDB_SERVER_TOKEN` (+ `STDB_SERVER_IDENTITY`) | Same keys, one file per target: `.env.test.local` / `.env.prod.local` |
| Module env | `STDB_TARGET` declared in `schema(..., { env })` | Supplied from the publisher's process environment by `publish.ts` |

Every CLI call names the database explicitly and passes `--server maincloud --no-config`. `spacetime.json` keeps `hsr-spacetimedb-test1` only as the safe interactive default. Nothing reads `.env.local` or the legacy Next.js keys.

## Bootstrap Scripts

All scripts live in `scripts/stdb/`, run with `tsx`, take `--target test|prod`, and exit 1 on any unexpected disconnect (`onDisconnect`, upgrade report R6).

### `scripts/stdb/publish.ts` (`npm run stdb:publish:<t>`)

**Flow:**
1. Arguments come only from `publishArgs(target, …)`: explicit name, `--server maincloud --no-config --module-path spacetimedb`, and `STDB_TARGET=<target>` in the child environment
2. `--clear` (test only, `npm run stdb:publish:test:clear`) adds `--delete-data=always --yes=delete-data`; `assertWipeAllowed` refuses it for prod
3. Prod adds `--yes=migrate` and nothing else; `assertNoForbiddenProdFlags` re-checks; a dirty `git status` is refused
4. Runs `npm run typecheck` first and aborts on errors (`spacetime build` cannot find `tsc` in the workspace layout)

**Dry run** (prints the command and the child environment keys, contacts nothing):
```text
$ npx tsx scripts/stdb/publish.ts --target prod --dry-run
[dry-run] pre-flight: npm run typecheck; git status --porcelain must be empty
[dry-run] STDB_TARGET=prod spacetime publish hsr-spacetimedb-prod --server maincloud --no-config --module-path spacetimedb --yes=migrate
[dry-run] child environment keys: STDB_TARGET

$ npx tsx scripts/stdb/publish.ts --target test --clear --dry-run
[dry-run] pre-flight: npm run typecheck
[dry-run] STDB_TARGET=test spacetime publish hsr-spacetimedb-test1 --server maincloud --no-config --module-path spacetimedb --delete-data=always --yes=delete-data
[dry-run] child environment keys: STDB_TARGET

$ npx tsx scripts/stdb/describe.ts --target test --dry-run
[dry-run] STDB_TARGET=test spacetime describe hsr-spacetimedb-test1 --server maincloud --no-config --json
[dry-run] child environment keys: STDB_TARGET
```

### `init` (module, on first publish and every `--delete-data` republish)

When `ServerIdentity` is empty: inserts `ctx.sender` (the publisher) as `kind = Owner`, `label = 'owner'`; creates the SYSTEM user (`username = 'SYSTEM'`, role Admin, `id` from autoInc, audit actor `SYSTEM_USER_ID = 0`); links the owner identity to SYSTEM through `UserIdentity`. A plain republish does not run `init`.

### `scripts/stdb/bootstrap.ts` (`npm run stdb:bootstrap:<t>`)

**Flow:**
1. Reads the owner token from `spacetime login show --token` (stdout only; never written or logged)
2. Opens a token-less connection to mint a fresh identity + token
3. As owner: best-effort `server_revoke_delegate` of the `STDB_SERVER_IDENTITY` recorded in `.env.<t>.local`, then `server_register_delegate(freshHex, 'vercel-auth-<t>')`
4. Writes `STDB_SERVER_TOKEN` and `STDB_SERVER_IDENTITY` into `.env.<t>.local` (other lines kept)
5. As the delegate: seeds `data/seed/{characters,lightcones,synergies}.json` through `admin_bulk_upsert` (plus archetypes and junction rows), the starter achievements from `data/seed/achievements.json`, `admin_seed_elo_config`, `admin_seed_rating_config`, `seed_identity_gc_job`, `seed_lobby_gc_job`
6. Subscribes only to `achievement` and `archetype` (to read back auto-increment ids)

**Preconditions:**
- The module was published by the CLI login running the script (that identity is the Owner)
- Run from anywhere: paths resolve from the repository root

**Postconditions:**
- One new Delegate row in `ServerIdentity`, linked to the SYSTEM user; the previous delegate revoked when it still existed
- `.env.<t>.local` holds the new token and identity
- Game data, starter achievements, config singletons and GC jobs present

**Idempotency:** re-running is safe. Game data is upserted; achievements are skipped by name (their criteria are left as they are); EloConfig / AccountRatingConfig report "exists"; the GC seeds are no-ops when a job exists. Each run rotates the delegate.

### `scripts/stdb/seed.ts` (`npm run stdb:seed:<t>`)

Bootstrap step 5 alone, as the delegate whose token is in `.env.<t>.local`.

### Other scripts

| Script | npm | Purpose |
|--------|-----|---------|
| `describe.ts` | `stdb:describe:<t>` | `spacetime describe <db> --server maincloud --no-config --json` (schema-delta gate) |
| `generate.ts` | `stdb:generate` | Local `spacetime generate` into `web/src/module_bindings` (no target) |
| `manage-user.ts` | `stdb:manage-user -- --target <t> set-role <user> <role>` / `delete <user>` | `server_set_role` / `server_delete_user` as the delegate |
| `test-integration.ts` | `test:integration` | Runs the live suite with `STDB_TARGET=test`; refuses prod |

## Test Harness

### `createTestHarness()` (Guest Harness)

**Purpose:** Create a connected guest user for permission guard tests

**Flow:**
1. `DbConnection.builder()` connects to the test DB resolved by `backendEnv()` (`test/shared/env.ts`: `STDB_TARGET=test` + `.env.test.local`)
2. Subscribes to all tables
3. Calls `loginAsGuest` — creates User + UserIdentity
4. Resolves `userId` from subscription cache by matching `Guest_{hex8}` username pattern
5. Returns `TestHarness` object

**Preconditions:**
- Database must be bootstrapped (ServerIdentity + SYSTEM user exist)
- No `STDB_SERVER_TOKEN` required

### `createVerifiedTestHarness()` (Verified Harness)

**Purpose:** Create a connected verified (non-guest) user for feature CRUD tests

**Flow:**
1. Same as guest harness steps 1-3
2. Opens a **second** connection using the delegate `STDB_SERVER_TOKEN`
3. Server connection calls `serverLinkProvider` with test Discord ID (`test_{timestamp}_{random}`) and name (`TestUser_{suffix}`)
4. Re-calls `loginAsGuest` on the original connection to refresh subscription cache
5. Resolves `userId` by matching `TestUser_*` username pattern
6. Returns `TestHarness` object

**Preconditions:**
- Database must be bootstrapped
- `STDB_SERVER_TOKEN` must be in `.env.test.local` (written by bootstrap)

**Error Cases:**
| Condition | Behavior |
|-----------|----------|
| `STDB_SERVER_TOKEN` missing | Throws immediately with descriptive error |
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
| `hasServerToken()` | Returns `true` if `STDB_SERVER_TOKEN` is available (`.env.test.local`) |
| `sleep(ms)` | Fixed-duration wait (use sparingly; prefer `sync()`) |

## Acceptance Scenarios

### Init Registers the Owner (Clean Database)
**Given:** Database freshly published (first publish or `--delete-data`), `ServerIdentity` empty
**When:** `init` runs
**Then:** One `ServerIdentity` row: the publisher, `kind=Owner`, `label='owner'`. SYSTEM user created (username `SYSTEM`, role Admin). `UserIdentity` links the owner identity to SYSTEM.

### Full Bootstrap
**Given:** `init` has run; the CLI login is the publisher
**When:** `npm run stdb:bootstrap:test` is run
**Then:** A fresh identity is registered as `kind=Delegate`, `label='vercel-auth-test'`, linked to SYSTEM. `.env.test.local` holds its `STDB_SERVER_TOKEN` + `STDB_SERVER_IDENTITY`. Game data, starter achievements, config singletons and GC jobs seeded.

### Bootstrap Re-run (Delegate Rotation)
**Given:** A previous bootstrap wrote `STDB_SERVER_IDENTITY` and that delegate is still registered
**When:** Bootstrap runs again
**Then:** The previous delegate is revoked (its `ServerIdentity` and `UserIdentity` rows deleted), a new delegate is registered, seeding is a no-op apart from upserts.

### Delegate Management Is Owner-Only
**Given:** Caller is a Delegate (or any non-owner)
**When:** `server_register_delegate` or `server_revoke_delegate` is called
**Then:** Rejected with "Forbidden: only the owner server identity may do this." (non-server callers: "Forbidden: caller is not a registered server identity.")

### Test-Only Reducers Are Default-Deny
**Given:** A database published with `STDB_TARGET=prod` (or without the value)
**When:** `server_set_datetime`, `server_set_online`, `server_set_mmr` or `server_nuke_test_data` is called, by anyone
**Then:** Rejected with "Not a test database." before any other check.

### Prod Wipe Refused
**Given:** `--target prod`
**When:** `scripts/stdb/publish.ts --target prod --clear` is run (dry run or not)
**Then:** Exits 1 with "refusing a destructive operation on target \"prod\"; only \"test\" may be wiped." Nothing is spawned.

### Guest Harness Connection
**Given:** Database is bootstrapped (ServerIdentity + SYSTEM user exist)
**When:** `createTestHarness()` is called
**Then:** Resolves with a `TestHarness` where `userId` > 0, User row has `isGuest=true`, `username=Guest_{hex8}`.

### Verified Harness Connection
**Given:** Database is bootstrapped, `STDB_SERVER_TOKEN` is in `.env.test.local`
**When:** `createVerifiedTestHarness()` is called
**Then:** Resolves with a `TestHarness` where `userId` > 0, User row has `isGuest=false`, `hasDiscordLinked=true`, `username=TestUser_{suffix}`.

### Verified Harness Without Token
**Given:** `.env.test.local` has no `STDB_SERVER_TOKEN`
**When:** `createVerifiedTestHarness()` is called
**Then:** Throws immediately: "STDB_SERVER_TOKEN required for verified test harness. It lives in .env.test.local (written by npm run stdb:bootstrap:test)"

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

### GC Guard: Skip Guests (D-06) _Superseded in Phase S10h execution (DECISIONS.md A95)._
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
| Two bootstrap runs without clearing | Second run revokes the first delegate and registers a new one | The first run's token stops working; `.env.<t>.local` holds the new one |
| Bootstrap run by a CLI login that did not publish | `server_register_delegate` rejects (caller is not the owner) | Only the publisher is registered as Owner by `init` |
| `STDB_TARGET` / `--target` missing or unknown | Script exits 1 before connecting | No fallback database |
| Guest harness userId resolution fallback | Falls back to most recently inserted non-SYSTEM user | Handles edge cases where username pattern match fails |
| Verified harness re-login after link | Calls `loginAsGuest` again to refresh subscription cache | Without re-login, cached User row still shows `isGuest=true` |
| `queryPrivateTable` on empty result | Returns empty array `[]` | Parser handles < 2 output lines gracefully |
| `queryPrivateTable` with WARNING lines | Filters out lines starting with "WARNING" | SpacetimeDB CLI sometimes emits warnings before table output |
| Harness run without `STDB_TARGET=test` | `backendEnv()` throws | The database name comes from `shared/stdb-targets.ts`, never from env |
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
| `init` | `ServerIdentity`, `User`, `UserIdentity` | Registers the Owner + SYSTEM user on a fresh database | writes |
| `bootstrap.ts` | `server_register_delegate` / `server_revoke_delegate` | Rotates the delegate (as Owner) | writes |
| `bootstrap.ts` / `seed.ts` | `admin_bulk_upsert`, `admin_assign_character_archetypes` | Seeds `data/seed/` game data | writes |
| `bootstrap.ts` / `seed.ts` | Achievement reducers | Creates starter achievements + criteria (skipped by name) | writes |
| `bootstrap.ts` / `seed.ts` | Config reducers (`adminSeedEloConfig`, `adminSeedRatingConfig`) | Seeds default config rows | writes |
| `bootstrap.ts` | `.env.<t>.local` | Writes `STDB_SERVER_TOKEN`, `STDB_SERVER_IDENTITY` | writes |
| `createVerifiedTestHarness` | `server_link_provider` reducer | Upgrades guest to verified via server connection | writes |
| `createTestHarness` | `login_as_guest` reducer | Creates guest User + UserIdentity | writes |
| `queryPrivateTable` | SpacetimeDB CLI (`spacetime sql`) | Reads private tables not in client subscriptions | reads |
| `vitest.integration.config.ts` | `test/shared/env.ts` | Resolves the backend (`STDB_TARGET=test` + `.env.test.local`) at config time | reads |
| `test/shared/load-env.ts` | `test/shared/env.ts` | Same, for standalone scripts outside vitest | reads |
| All scripts | `shared/stdb-targets.ts` | Database names, host, CLI argument builders (single source of truth) | reads |
| `run_identity_gc` | `UserIdentity` table | Scans all rows, deletes stale/orphaned | reads/writes |
| `run_identity_gc` | `User` table | Checks isGuest, isOnline, existence (orphan detection) | reads |
| `run_identity_gc` | `GcResult` table | Writes audit row when identities deleted | writes |
| `run_identity_gc` | `IdentityGcJob` table | Self-requeues 7 days out | writes |
| `admin_gc_identities` | Same as `run_identity_gc` | Same GC logic, always writes GcResult, no self-requeue | reads/writes |
| `admin_gc_lobbies` | `performLobbyGc` helper | On-demand lobby GC trigger | reads/writes |
| `seed_identity_gc_job` | `IdentityGcJob` table | Idempotent bootstrap insert | writes |
| `clientConnected` | `UserIdentity.lastSeenAt` | Bumps timestamp on WebSocket connect | writes |
| `bootstrap.ts` / `seed.ts` | `seed_identity_gc_job` | Seeds weekly identity GC schedule | writes |
| `bootstrap.ts` / `seed.ts` | `seed_lobby_gc_job` | Seeds lobby GC schedule | writes |

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
| First-come-first-served server registration with SYSTEM user bootstrap (removed in M2) | Phase 1 execution | 2026-03-16 |
| `post-publish.ts` as single bootstrap entry point (replaced by `scripts/stdb/bootstrap.ts` in M2) | Quick task 260318-2ci | 2026-03-18 |
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
| Env scheme (`shared/stdb-targets.ts`, `STDB_TARGET` / `VITE_STDB_TARGET`, `.env.<t>.local`); `init` registers the Owner + SYSTEM; owner-only `server_register_delegate` / `server_revoke_delegate`; `scripts/stdb/*` with `--target` and `--dry-run`; test-only reducers gated by module env `STDB_TARGET` | Phase M2 execution | 2026-11-06 |
| Identity clean-up and guests: the weekly run also deletes a guest user that has been idle for 30 days (no live presence, every identity last seen 30 days ago or more), holds no lobby membership, is not enrolled in an unfinished tournament and has no match history at all (no participant, history, stat, rating, relationship, leaderboard, enrolment or achievement row). At most 500 guests per run; when the cap is reached the next run is one hour later instead of seven days. `GcResult.details` carries a `guests` count | Phase S10h execution (DECISIONS.md A95) | 2026-11-10 |
