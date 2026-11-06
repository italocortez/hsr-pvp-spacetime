<!-- Sources (v2.14.1 tag commit a0bf6be10a146b03acbe3f4f9ad7fe20f114988d — upstream moved how-to docs from 00300-resources/00100-how-to/ to 00250-how-to/ after 1a1fe78):
  - Logging: https://github.com/clockworklabs/SpacetimeDB/blob/a0bf6be10a146b03acbe3f4f9ad7fe20f114988d/docs/docs/00250-how-to/00300-logging.md
  - Reject connections: https://github.com/clockworklabs/SpacetimeDB/blob/a0bf6be10a146b03acbe3f4f9ad7fe20f114988d/docs/docs/00250-how-to/00500-reject-client-connections.md
  - Migration 2.0: https://github.com/clockworklabs/SpacetimeDB/blob/a0bf6be10a146b03acbe3f4f9ad7fe20f114988d/docs/docs/00250-how-to/00600-migrating-to-2.0.md
  - PG Wire: https://github.com/clockworklabs/SpacetimeDB/blob/a0bf6be10a146b03acbe3f4f9ad7fe20f114988d/docs/docs/00250-how-to/00200-pg-wire.md
  - Maincloud deploy: https://github.com/clockworklabs/SpacetimeDB/blob/a0bf6be10a146b03acbe3f4f9ad7fe20f114988d/docs/docs/00250-how-to/00100-deploy/00100-maincloud.md
  - Row Level Security: https://github.com/clockworklabs/SpacetimeDB/blob/a0bf6be10a146b03acbe3f4f9ad7fe20f114988d/docs/docs/00250-how-to/00400-row-level-security.md
  - Unit testing: https://github.com/clockworklabs/SpacetimeDB/blob/a0bf6be10a146b03acbe3f4f9ad7fe20f114988d/docs/docs/00250-how-to/00900-unit-testing.md
  - MCP: https://github.com/clockworklabs/SpacetimeDB/blob/a0bf6be10a146b03acbe3f4f9ad7fe20f114988d/docs/docs/00300-resources/00150-mcp.md
  - TS client reference (reconnect): https://github.com/clockworklabs/SpacetimeDB/blob/a0bf6be10a146b03acbe3f4f9ad7fe20f114988d/docs/docs/00200-core-concepts/00600-clients/00700-typescript-reference.md
  - Official skills (typescript-client, typescript-server, mcp) at master 17a3f3a649a3ad55e1520353a53ec5de8ea97b0a: https://github.com/clockworklabs/SpacetimeDB/tree/17a3f3a649a3ad55e1520353a53ec5de8ea97b0a/skills

  To update: fetch the raw GitHub URLs above and compare against this file.
-->

# SpacetimeDB How-To Guides (TypeScript focus)

## Table of Contents
1. [Logging](#logging)
2. [Rejecting Client Connections](#rejecting-client-connections)
3. [Event Tables & Per-Call Callbacks (2.0)](#event-tables--per-call-callbacks)
4. [Confirmed Reads](#confirmed-reads)
5. [PostgreSQL Wire Protocol](#postgresql-wire-protocol)
6. [Maincloud Deployment](#maincloud-deployment)
7. [Reconnection](#reconnection)
8. [Row Level Security (deprecated)](#row-level-security)
9. [v2.1.0 Bug Fixes](#v210-bug-fixes-relevant-to-clients)
10. [Known 2.6.1 TS SDK bugs fixed upstream](#known-261-ts-sdk-bugs-fixed-upstream)
11. [MCP (agent access to a live database)](#mcp-agent-access-to-a-live-database)
12. [Module Unit Testing (v2.12+)](#module-unit-testing-v212)

---

## Logging

Log messages are **private to the database owner** and not visible to clients.

### TypeScript — use standard console API
```typescript
console.log('Info message');      // info level
console.warn('Warning message');  // warn level
console.error('Error message');   // error level
console.debug('Debug message');   // debug level
```

These are automatically routed through SpacetimeDB's logging system.

### Viewing logs
```bash
spacetime logs <db-name>                        # View recent logs
spacetime logs --follow <db-name>               # Real-time streaming
spacetime logs <db-name> --level error          # Filter by level (error and above)
spacetime logs <db-name> --level info --level-exact  # Exact level only
spacetime logs <db-name> --since "2023-01-01 00:00:00"  # Filter by time
```

### Best practices
- Match log levels: error for failures, warn for concerns, info for events, debug for diagnostics
- Minimize logging in loops and high-frequency reducers
- Never log credentials or PII
- Include contextual info (user ID, lobby ID, etc.) for debugging

---

## Rejecting Client Connections

Throw an error in the `clientConnected` lifecycle hook to reject a connection. The hook must be **exported** — a bare `spacetimedb.clientConnected(...)` call never registers (see `api-guide.md` § 4):

```typescript
export const onConnect = spacetimedb.clientConnected((ctx) => {
  // Example: reject if server is in maintenance mode
  const config = ctx.db.serverConfig.id.find(0n);
  if (config?.maintenanceMode) {
    throw new Error('Server is in maintenance mode');
  }
  // Normal connection logic...
});
```

**Client behavior:** TypeScript clients receive a connection error with WebSocket close code 1006. The server logs an ERROR entry with the rejection reason.

Note: Client disconnection behavior is currently "undefined" — the client sees `Disconnected abnormally...`. Handle this gracefully in your `onConnectError` callback.

---

## Event Tables & Per-Call Callbacks

SpacetimeDB 2.0 removed global reducer callbacks in favor of two patterns:

### Per-call callbacks (`_then()`)
For observing results of YOUR OWN reducer calls only:
```typescript
conn.reducers.createItem({ title: 'Hello' })._then((ctx) => {
  // Fires only for THIS specific call
});
```

### Event tables (recommended)
For cross-client notifications. Event tables:
- **Are included in blanket subscriptions.** `subscribeToAllTables()` subscribes to every table in the bindings, event tables included (verified: 2.6.1 `dist/index.mjs:5464`; 2.14.1 skips only views that take arguments; the upstream TS reference says "including public event tables"). An earlier version of this skill wrongly said they were excluded. A blanket subscriber receives **every** lobby's events.
- Remain empty outside transactions — never accumulate rows in client caches
- Only `onInsert` callbacks are generated
- Are transactionally consistent with the reducer that wrote them

```typescript
// Subscribe to event tables FILTERED by their addressing column, so each client only gets its own events
conn.subscriptionBuilder().subscribe(
  tables.LobbyCursorEvent.where(r => r.lobbyId.eq(lobbyId))
);
// High-rate events (cursors): prefer a row callback over useTable. useTable re-snapshots
// and re-renders React on every event (2.6.1 dist/react/index.mjs:1827-1835).
conn.db.LobbyCursorEvent.onInsert((ctx, ev) => { /* move the cursor */ });
```

**A filter is not access control.** It cuts egress, but any SDK client can subscribe without it, views can't wrap event tables, and RLS isn't available. Never put data meant only for specific recipients in a public event table; anything in it is readable by every connected client that asks.

This project uses `LobbyCursorEvent` as an event table.

---

## Confirmed Reads

Transactions require durability confirmation before sending updates to clients. This guarantees consistency but adds latency to every reducer round-trip — the client won't see subscription updates until the server has confirmed the write to durable storage.

**v2.1.0 change:** The TypeScript SDK now defaults to confirmed reads **enabled**. In v2.0.x, the server had confirmed reads on by default but the TypeScript connector did not explicitly opt in — so some clients may see a behavioral change after upgrading. If your app felt fast on 2.0.x and slower on 2.1.0, this is likely the cause.

**Impact:** With confirmed reads enabled (the default), round-trip times of 200ms+ have been observed even when both server and client run on the same machine. Disabling confirmed reads can drop this to ~2ms locally. The setting applies to **both local development and maincloud** — it controls server-side behavior regardless of where the module is hosted.

**Trade-off:** Without confirmed reads, the client may briefly see state from a transaction that hasn't been durably committed. In practice, this matters only if the server crashes between processing a transaction and writing it to disk — an extremely rare event. For games and real-time apps, the latency savings far outweigh this risk.

For latency-sensitive applications (games, real-time), disable confirmed reads:
```typescript
const builder = DbConnection.builder()
  .withUri(SPACETIMEDB_URI)
  .withDatabaseName(MODULE_NAME)
  .withConfirmedReads(false)  // Prioritize speed over consistency
  // ...
```

**When to keep confirmed reads enabled:** Apps where data integrity on every transaction is critical (e.g., financial operations, inventory management) and where 100-200ms latency is acceptable.

---

## PostgreSQL Wire Protocol

SpacetimeDB implements PG wire protocol — you can query it with any PostgreSQL client (`psql`, DBeaver, etc.). Useful for debugging and admin tasks.

### Connection details
| Setting | Maincloud | Local |
|---------|-----------|-------|
| Host | `maincloud.spacetimedb.com` | `localhost` |
| Port | `5432` | Custom via `--pg-port` |
| Username | Any string | Any string |
| Password | Auth token | Auth token |
| SSL | `require` | `disable` |

### Get auth token
```bash
spacetime login show --token
```

### Limitations
- Simple Query Protocol only (no parameterized queries)
- SQL limited to SpacetimeDB's subset
- No real-time subscription updates
- No user-defined transactions (each statement independent)
- Enums display as `Enum`, complex types as `JSON`

---

## Maincloud Deployment

### Transport: v3 protocol (v2.3.0)

The WebSocket client transport uses the **v3 protocol**, which **batches and pipelines** responses — significantly reducing per-message overhead under high load compared to sending one message per update. This project already runs on the v3 baseline (adopted Phase 16.4 Plan 04); it's the reason egress dominates the energy budget less per-message than a naive one-frame-per-update transport would, and it matters directly for the maincloud energy/egress budget (see SKILL.md "Energy budget & bandwidth rules").

### Publishing
```bash
spacetime publish <db-name> --server maincloud
```
- `spacetime login` authenticates with GitHub or Google; databases then appear on the dashboard
- Compiles module, uploads, runs `init` reducer
- Subsequent deploys **hot-swap code without disconnecting clients** (some migrations, e.g. removing a table, do disconnect clients so they reconnect against the new schema)
- Reset data: `spacetime publish <db-name> --server maincloud --delete-data` (2.6.1 CLI: `--delete-data[=always|on-conflict|never]`; `on-conflict` wipes only when the schema change is breaking; short form `-c`)

### Dashboard
- URL: `https://spacetimedb.com/<db-name>` or `https://spacetimedb.com/@<username>/<db-name>`
- Shows: energy consumption (bytes scanned/written, index seeks, CPU, bandwidth, storage), real-time logs, SQL query interface

### Database states
- **Running** — actively serving
- **Paused** — free tier auto-suspends after inactivity; paid tiers stay available

### Deletion (irreversible!)
```bash
spacetime delete <db-name> --server maincloud --yes
```

---

## Reconnection

**Current (SDK 2.6.1):** there is no built-in reconnect; the only reliable way is to unmount and remount the `SpacetimeDBProvider` by toggling a key prop:

```typescript
const [connectionKey, setConnectionKey] = useState(0);

// In your onDisconnect callback:
setTimeout(() => setConnectionKey(k => k + 1), 2000);

// This forces React to destroy and recreate the entire provider tree
<SpacetimeDBProvider key={connectionKey} connectionBuilder={builder}>
  {children}
</SpacetimeDBProvider>
```

This is a known rough edge on 2.6.1.

**Post-upgrade (v2.12.0+, PR #5927 — project SDK is 2.6.1; don't use until the upgrade lands):** reconnection is built into `DbConnection`, and the key-remount workaround above should be removed when adopting it.
```typescript
const builder = DbConnection.builder()
  .withUri(SPACETIMEDB_URI)
  .withDatabaseName(MODULE_NAME)
  .withToken(storedToken)
  .withAutomaticReconnect()                  // optional { minDelayMs (≥500, default 1000), maxDelayMs (≥1000, default 30000) }
  .withTokenProvider(() => refreshToken())   // only for expiring credentials; must return a token for the SAME identity
  .onConnect((conn, identity, token) => persistToken(token));
```
- The same connection object, client cache, table handles, subscriptions, and row callbacks survive the outage; each attempt gets a fresh `ConnectionId`; the stored token keeps the `Identity` (including anonymous ones). Exponential backoff with jitter; initial connection failures are **not** retried.
- **React:** the `SpacetimeDBProvider` enables automatic reconnect itself. `useSpacetimeDB().isActive` is `false` during the outage, and `useTable`'s `isReady` stays `false` until its subscription is replayed. Cached rows stay visible but may be stale.
- Register subscriptions and row callbacks **once**, not inside a per-connect callback; the SDK replays subscriptions in one batch and emits only net row changes. `onApplied` fires again after replay.
- `onDisconnect` / `onConnectError` gain `(ctx, error, nextReconnectAttempt?, nextReconnectDelayMs?)` — both `undefined` when no retry is scheduled. Direct connections expose `conn.isReconnecting`.
- While disconnected, reducer/procedure calls fail immediately (`DisconnectedError`); calls in flight when the socket dropped reject with `UnknownCallResultError` — they **may have executed**, so never auto-retry non-idempotent reducers on that error.
- Uncertain: the v2.14.1 TS reference says `onConnect` does not fire on automatic reconnect (use `onAutomaticReconnect(conn, identity, token)` for per-reconnect work), while the official client skill and PR #5927 say `onConnect` re-fires. Verify against the installed version before relying on either.

---

## Row Level Security

**Deprecated.** Use Views instead. See `api-guide.md` section 7 for the recommended view pattern.

RLS is experimental/unstable. Rust/C# need an explicit opt-in; TypeScript needs none — the API (present in 2.6.1) is an exported filter:
```typescript
export const accountFilter = spacetimedb.clientVisibilityFilter.sql(
  'SELECT * FROM account WHERE account.identity = :sender'
);
```
Mutually dependent rules still publish, but client queries on those tables then fail with a cyclic-dependency error. Views are simpler, more performant, and provide full row/column access control — don't introduce RLS in this repo.

---

## v2.1.0 Bug Fixes (relevant to clients)

These fixes landed in v2.1.0 (released 2026-03-24). No client code changes required — all are server-side or SDK-internal fixes.

- **`useTable` isReady regression** (#4580) — The `subscribe` callback captured a stale `computeSnapshot` closure. After `subscribeApplied` flipped to true, subsequent row events reverted `isReady` back to false. Fixed by adding `computeSnapshot` to the dependency array. If you had intermittent issues where table data appeared to "unload" after initial sync, this is the fix.

- **Client disconnect dropping other clients' subscriptions** (#4648) — When a v2 client disconnected, the cleanup logic double-processed query hashes, decrementing a refcounted index twice. This could remove indexes that other active clients still needed, causing them to stop receiving updates. Critical fix for multi-client scenarios.

- **Anonymous view subscription cleanup** (#4646) — Anonymous views with multiple subscribers were being prematurely dropped when one subscriber disconnected. More reliable view subscriptions in multi-client environments.

- **Query column name correctness** (#4627) — `ColumnExpression` now carries both the TS accessor name and the DB column name. SQL generation uses the DB column name. Fixes a correctness issue for projects where TS accessors differ from DB column names (e.g., camelCase TS vs snake_case DB). For this project, no visible impact since the generated bindings handle the mapping.

- **JS reducer execution throughput** (#4663) — JS reducers now execute on a single dedicated FIFO worker per module instead of a thread pool. Performance improvement from ~50K to ~85K TPS. Primarily affects JS modules, but related infrastructure improvements may benefit Rust modules too.

---

## Known 2.6.1 TS SDK bugs fixed upstream

If you hit one of these symptoms on the current SDK, it is a known upstream bug, not app logic. Each fix ships only with the SDK upgrade (module rebuild and/or client bump):

| Symptom on 2.6.1 | Fixed in |
|---|---|
| One-column prefix scan on a multi-column btree index (`idx.filter(firstColValue)`) throws `serializeTerm is not a function` | v2.7.0 (#5428) |
| `.primaryKey()` / `.index()` on an object-form `t.enum('X', {...})` column → `TypeError: ... is not a function` | v2.7.0 (#4389) |
| `Uuid` values rejected as literals in query-builder `.where()` | v2.7.0 (#5075) |
| `ctx.random.fill()` mishandles empty and 32-bit typed arrays | v2.7.0 (#5115) |
| Prefix + `Range` filter/delete on a composite btree index returns wrong rows | v2.8.0 (#5479) |
| A decoded `t.array(t.u8())` value silently changes later (it aliased a reused scan buffer) | v2.8.1 (#5491) |
| Connection silently stalls on WebKit/iOS after a gzip frame fails to decompress | v2.8.1 (#5668) |
| Mid-session WebSocket error fires `onConnectError` instead of `onDisconnect`, disables sends, and never recovers | v2.10.0 (#5707) |
| Burst of compressed messages → client out-of-memory | v2.10.2 (#5845) |
| `procedure` HTTP header values split at commas; nonstandard status codes throw | v2.13.0 (#6140) |
| `t.result()` builder shape doesn't match the serializer | v2.13.0 (#6148) |
| Generated bindings fail to typecheck (`never` reducers) under `exactOptionalPropertyTypes` | v2.14.0 (#6096) |
| `Uuid` / branded primitive columns infer as structural records | v2.14.1 (#5971) |

Also SDK-side: from v2.7.1 (#5525) the browser client listens for `visibilitychange`/`focus`/`online`/`pageshow` to tear down dead sockets and reset stalled reconnect backoff. Server-side fixes (maincloud's server version governs these, not the SDK): WebSocket idle-timeout handling (#5517, v2.9.0), JWT impersonation vulnerability (patched v2.10.0, disclosed v2.11.0), HS256 JWTs rejected (v2.12.0).

---

## MCP (agent access to a live database)

SpacetimeDB speaks the Model Context Protocol. Status for this repo:

| Path | Requires | Available here? |
|---|---|---|
| `POST /v1/mcp` (host-wide) and `POST /v1/database/<name>/mcp` (scoped) over HTTP | Server v2.10.0+ on maincloud (server-side) | Yes on the maincloud side — MCP is **unstable** |
| `spacetime mcp` stdio bridge (what the official Claude Code plugin registers) | CLI v2.8.1+ | **No** — the active CLI is 2.6.1 (`spacetime --version`; do not `spacetime version use` just for MCP) |

Tools: `list_databases` (host-wide only; databases owned by your identity), `get_schema`, `sql` (optional `confirmed`), `call` (`reducer`, `args` as a positional JSON array), `ping`. Errors come back in-band (`isError: true`) — read the text before retrying.
- Host-wide servers need a `database` argument on every data tool; scoped servers reject it. Check `tools/list` first.
- Tools run as the CLI's saved identity — the same caveat as `spacetime call`: that identity is not an app user, so authenticated reducers will reject it (see SKILL.md top note).
- `sql` reads public tables; SQL writes need DB ownership. A `no such table` error usually means the table is private for that identity.
- MCP tool calls are egress-tracked on maincloud (v2.10.0) — they count toward the energy budget like any other query.

---

## Module Unit Testing (v2.12+)

**v2.12.0+ (PRs #5558, #6139) — project SDK is 2.6.1; don't use until the upgrade lands.** Also: this repo's `test/` directory is the verification layer — don't create or change tests without an explicit task (CLAUDE.md).

Tests run module logic against an in-memory datastore, with no publish (unlike `npm run test:integration`, which republishes maincloud). Run from the module project (`spacetimedb/`) with Node 22+, `"type": "module"` in its `package.json`, and `vitest@^3.2.4`:

```typescript
// vitest.config.ts
import { defineConfig, type Plugin } from 'vitest/config';
import { spacetimedbModuleTestPlugin } from 'spacetimedb/server/test-utils/vitest';
export default defineConfig({ plugins: [spacetimedbModuleTestPlugin() as unknown as Plugin], test: { environment: 'node' } });

// src/example.test.ts
import { expect, it } from 'vitest';
import { createModuleTestHarness, TestAuth } from 'spacetimedb/server/test-utils';
import spacetimedb, * as moduleExports from './index';

it('inserts a record', () => {
  const test = createModuleTestHarness(spacetimedb, moduleExports);   // fresh DB per call
  test.withReducerTx(TestAuth.internal(), ctx => {
    moduleExports.add_record(ctx, { value: 1 });                        // exported reducers are callable
  });
  expect(test.db.Record.count()).toBe(1n);
});
```
- `withReducerTx` commits on normal return and rolls back + rethrows on throw — don't catch inside it if you expect rollback. Callbacks must be synchronous.
- `TestAuth.internal()` represents the database itself; use `TestAuth.fromJwtPayload(JSON.stringify({ iss: 'test', sub: 'alice' }), connectionId)` for client callers. The optional third harness argument sets `clock` (`TestClock`), `rngSeed`, and identity.
- It does **not** simulate subscriptions, RLS, lifecycle hooks, or the scheduler — call lifecycle/scheduled reducers explicitly and keep live integration tests for those behaviors.
