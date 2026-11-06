# Test Writing Guide

Reference for writing vitest integration tests and UAT harness scripts. Read this when you have a task to create or modify test files.

## Table of Contents

1. [Harness API](#harness-api)
2. [Role Promotion](#role-promotion)
3. [UAT Test Scripts](#uat-test-scripts)
4. [Shared Helpers](#shared-helpers)
5. [afterAll Cleanup Contract](#afterall-cleanup-contract)
6. [TypeScript Correctness](#typescript-correctness)
7. [View-Accurate Filtering](#view-accurate-filtering)
8. [Environment](#environment)

## Harness API

```typescript
import { createTestHarness, createVerifiedTestHarness, expectReducerError } from 'test/shared/connection';
```

| Function | User type | Use for |
|---|---|---|
| `createTestHarness()` | Guest | Permission guard tests (expect rejection) |
| `createVerifiedTestHarness()` | Verified (discord-linked) | Most feature tests -- requires `SPACETIMEDB_SERVER_TOKEN` in `.env.local` |

Use `test/shared/fixtures.ts` for data factories.

## Role Promotion

The harness creates Guest or Verified (User-role) users. For tests requiring TournamentHost, Admin, or Moderator roles, promote after creation:

```bash
SPACETIMEDB_DB_NAME=<db-name> npx tsx scripts/manage-user.ts set-role <username> <role>
```

To promote within a script, create a server-token connection (same pattern as `verifyUserViaServerConnection` in `test/shared/connection.ts` -- connect with `.withToken(SERVER_TOKEN)`, then call `serverConn.reducers.serverSetRole({...})`).

## UAT Test Scripts

Write standalone `.ts` scripts (NOT vitest test files) in `tmp/` for UAT verification. These are disposable -- they exist to exercise reducers step-by-step and produce snapshots.

```typescript
// tmp/uat-test-X.ts
import { loadEnvFile } from 'node:process';
loadEnvFile('.env.local');

import { createVerifiedTestHarness, expectReducerError } from '../test/shared/connection';

async function main() {
  // Each harness = independent user with WebSocket connection
  const userA = await createVerifiedTestHarness();
  console.log(`User A: id=${userA.userId}`);

  // Promote role if needed (via manage-user.ts or inline server connection)

  // Step 1: Call a reducer
  await userA.call.someReducer({ param: 'value' });
  await userA.sync();

  // Read from subscription cache (filter to simulate real client view)
  const rows = [...userA.conn.db.SomeTable.iter()].filter(r => r.userId === userA.userId);
  console.log('Rows:', rows);

  // Step 2: Expect a rejection
  const err = await expectReducerError(userA.call.someReducer({ param: 'invalid' }));
  console.log('Expected error:', err);

  // Multi-user: create additional harnesses as needed
  const userB = await createVerifiedTestHarness();
  await userB.call.anotherReducer({ id: 1 });
  await userB.sync();

  await userA.disconnect();
  await userB.disconnect();
}

main().catch(console.error);
```

Run with: `npx tsx tmp/uat-test-X.ts`

## Shared Helpers

Always import from `test/shared/helpers/` instead of writing inline copies. Phase 10.5 extracted these to eliminate 70+ duplicated helpers that caused typecheck drift.

| Helper | File | What it provides |
|--------|------|-----------------|
| `promoteUser`, `promoteToRole` | `promoteUser.ts` | Promote a user to a role via server connection |
| `defaultLobbyArgs` | `lobbies.ts` | Union-superset defaults for `create_lobby` (includes all required fields) |
| `defaultSettingsArgs` | `lobbies.ts` | Union-superset defaults for `update_lobby_settings` |
| `cleanupLobby` | `lobbies.ts` | Leave all members + close lobby (swallows errors) |
| `gameScoreArgs` | `scores.ts` | Defaults for `record_game_scores` with all optional fields as `undefined` |
| `createTournamentArgs` | `tournaments.ts` | Union-superset defaults for `create_tournament` (includes `maxAccountsPerPlayer`) |
| `setupRegistrationTournament` | `tournaments.ts` | Create tournament -> Registration -> register players |
| `advanceToInProgress` | `tournaments.ts` | Registration -> Seeding -> seed -> generate -> InProgress |
| `cleanupTournament` | `tournaments.ts` | Cancel tournament (swallows errors) |
| `completeDraft`, `advanceToScoring` | `drafts.ts` | Run a full draft sequence to completion |
| `ensureHsrAccount` | `hsrAccounts.ts` | Idempotent HSR account creation per user |
| `ensureEloConfig` | `seed.ts` | Idempotent Elo config seeding |
| `getUsername` | `users.ts` | Get username from harness user ID |
| `myLobbies`, `lobbyMembers` | `queries.ts` | Common query shortcuts |

When a new reducer adds a required field, update the shared helper -- all callers inherit the fix.

## afterAll Cleanup Contract

Every test file that creates lobbies, tournaments, achievements, or calendar events MUST clean up in `afterAll`. This prevents cross-file state pollution when `npm run test:all` runs files sequentially on the same DB.

```typescript
const createdLobbyIds: number[] = [];
const createdTournamentIds: number[] = [];

// In tests -- track every created resource
createdLobbyIds.push(lobbyId);

// afterAll -- unconditional cleanup
afterAll(async () => {
    for (const id of createdTournamentIds) {
        await cleanupTournament(toUser, id);
    }
    for (const id of createdLobbyIds) {
        await cleanupLobby(host, members, id);
    }
});
```

**Why:** Phase 10.4 exposed that tests pass in isolation but fail in suite due to leftover rows from earlier files (orphaned lobbies, tournaments, achievements). Phase 10.5 added this contract to all 13 affected files and verified the full suite runs green on both fresh and populated DBs.

## TypeScript Correctness

Match the generated bindings exactly in reducer calls:

1. **Unit enums** -- `{ tag: 'BluePlayer' }`, NOT `{ tag: 'BluePlayer', value: {} }`. The SDK tolerates the extra property at runtime but TypeScript flags it.
2. **Optional fields** -- pass `undefined` for optional reducer params you don't need (e.g. `teamBlueScore: undefined`). Don't omit them -- the generated type requires all keys.
3. **All required fields** -- include every field the reducer expects. When new fields are added to reducers, update the shared helpers first, then callers inherit.

## Filtering Convention

The harness uses `subscribeToAllTables()` internally, but all existing tests already use `.find()` or `.filter()` on every `iter()` call to scope data the way a real client would. Follow the same pattern -- always filter by userId, lobbyId, tournamentId, etc. rather than iterating unfiltered. The filter should correspond to the production subscription boundary, not be invented just to make a test pass.

## Environment

Integration tests connect to a live SpacetimeDB instance. Configuration:

| Env var | Default | Purpose |
|---------|---------|---------|
| `SPACETIMEDB_URI` | `wss://maincloud.spacetimedb.com` | WebSocket endpoint |
| `SPACETIMEDB_DB` | `hsrpvp-spacetimedb-nextjs-test1` | Database name |
| `SPACETIMEDB_SERVER_TOKEN` | -- | Required for verified user tests |

Set these in `.env.local` (written by `post-publish.ts`). The integration test runner (`vitest.integration.config.ts`) loads `.env.local` only -- do NOT use `.env.test`.
