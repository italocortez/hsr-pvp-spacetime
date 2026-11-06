---
name: spacetimedb
description: "Build and debug SpacetimeDB TypeScript modules and React clients, including multiplayer sync patterns. Use this skill whenever the user is working with SpacetimeDB — adding tables, writing reducers, creating views, setting up React subscriptions, publishing modules, debugging connection or query issues, implementing multiplayer features (movement sync, projectiles, combat, client-side prediction, interpolation), or any feature that touches the SpacetimeDB backend or client bindings. Also trigger when the user mentions spacetimedb, reducers, module_bindings, spacetime publish, spacetime generate, ctx.db, multiplayer sync, real-time multiplayer, table schema, subscription, BigInt, SenderError, useTable, or DbConnection."
---

# SpacetimeDB TypeScript Development

This skill guides you through building correct SpacetimeDB applications. SpacetimeDB has many API pitfalls that LLMs commonly hallucinate — this skill exists to prevent those mistakes and keep you on the correct APIs.

## This is a maincloud SpacetimeDB project. Connection: `wss://maincloud.spacetimedb.com` / database name in `spacetime.json`. No local server — do not use `spacetime start`. `spacetime call` uses the CLI identity (not an app user) so avoid it for testing authenticated reducers.

**Maintaining this skill:** When updating any pattern or API behavior in this file: (1) check whether the content already exists before adding — grep SKILL.md and references to avoid duplication, (2) check whether the same topic appears in the reference files (especially `references/api-guide.md` — see its table of contents) and update those too. Stale or duplicated references are worse than none — they teach agents the wrong pattern or waste context.

## When to load references

Read `references/api-guide.md` when you need detailed syntax for any of:
- Table definitions, column types, index configuration
- Reducer/procedure definitions and patterns
- Client-side React integration (useTable, subscriptions, provider setup)
- Subscription semantics, cache guarantees, query builder operators (eq/ne/lt/gt/lte/gte, and/or/not), semijoins
- Views (procedural and query-builder)
- Scheduled tables and timestamps
- Common mistakes table (server-side and client-side)
- Reducer context surface (`ctx.random`, `ctx.newUuidV4/V7`, nullable `ctx.connectionId`)
- § 12 post-2.6.1 features (env vars, views with arguments, submodules, async IDC). Recognise them in upstream examples, but don't use them until the SDK upgrade lands

**Module bindings** — read the generated files directly (always up-to-date, never stale):

| What you need | Read this file |
|---|---|
| Table schemas, indexes, constraints, reducer list | `src/module_bindings/index.ts` |
| Type definitions (enums, structs, tagged unions) | `src/module_bindings/types.ts` |
| Reducer parameter names for a specific reducer | `src/module_bindings/<reducer_name>_reducer.ts` |

Read `references/spacetime-json.md` when editing `spacetime.json` or `spacetime.local.json` — covers all config fields, generate targets, environment overrides, `spacetime dev` setup, and child database inheritance.

Read `references/http-api.md` when working with:
- Server-side SpacetimeDB access from Next.js API routes
- Calling reducers or running SQL via HTTP (not WebSocket)
- Identity/token management, database publishing via API
- Any scenario where the WebSocket SDK isn't available

Read `references/how-to-guides.md` for operational topics:
- Logging (console API, `spacetime logs --follow`, level filtering)
- Rejecting client connections in `clientConnected`
- Event tables and per-call callbacks (`_then()`)
- Confirmed reads toggle for latency-sensitive apps
- PostgreSQL wire protocol for admin/debugging queries
- Maincloud deployment (hot-swap, dashboard, database states)
- Known 2.6.1 TS SDK bugs fixed upstream (check here before debugging an odd SDK symptom)
- MCP access to a live database (server-side on maincloud; `spacetime mcp` needs CLI 2.8.1+)
- Module unit testing (v2.12+, post-upgrade)

Read `references/multiplayer-sync-patterns.md` when implementing:
- Real-time multiplayer features (movement, projectiles, combat)
- Client-side prediction and server reconciliation
- Entity interpolation for remote players
- Any feature where multiple clients need to see the same game state

For quick tasks where you already know the pattern, the cheat sheet below may suffice.

## Quick cheat sheet

### Imports
```typescript
// Server
import { schema, table, t, SenderError } from 'spacetimedb/server';
import { Timestamp, ScheduleAt } from 'spacetimedb';

// Client — ONLY these packages exist
import { DbConnection, tables, reducers } from './module_bindings';  // Generated!
import { SpacetimeDBProvider, useTable, useReducer, useSpacetimeDB } from 'spacetimedb/react';
import { Identity } from 'spacetimedb';
```

### Table definition & schema export
`table(OPTIONS, COLUMNS)` — indexes go in OPTIONS (1st arg), never COLUMNS (2nd arg causes `"reading 'tag'"` error). `schema()` takes exactly one object arg. See `references/api-guide.md` § 2 for full syntax, column types, exported columns pattern, and examples.

### Reducers — name from export, object params, no return values
The SDK derives the reducer name from the `export const` binding. There is no string-based registration — `reducer('name', ...)` doesn't exist. Parameters must be an object because the SDK generates typed destructuring from the schema; positional args would lose parameter names.
```typescript
export const create_item = spacetimedb.reducer(
  { title: t.string() },
  (ctx, { title }) => {
    ctx.db.myTable.insert({ id: 0n, ownerId: ctx.sender, title });
  }
);
```

### Client reducer calls — object syntax, never positional
```typescript
conn.reducers.createItem({ title: 'Hello' });  // camelCase on client
```

**v2.6.1 — optional args are truly optional keys (PR #4940):** generated types for `Option<T>` params changed from a required key (`{ foo: T | undefined }`) to an optional key (`{ foo?: T | undefined }`). Callers may now **omit** an optional reducer/procedure arg entirely — not just pass `undefined` or a value:
```typescript
// create_season has optional endDate. All three compile after 2.6.1:
conn.reducers.createSeason({ name: 'S1', endDate: micros });    // provided
conn.reducers.createSeason({ name: 'S1', endDate: undefined }); // explicit undefined (still legal)
conn.reducers.createSeason({ name: 'S1' });                     // omitted — NEW: allowed by optional key
```
This is a type-widening, not a required refactor — existing call sites that pass `undefined` explicitly keep compiling.

### The SpacetimeDB mindset: fire-and-forget, react to events
SpacetimeDB is event-driven (CQRS-style), not request-response like REST. The biggest habit to break coming from web dev: **don't try to get a reference back from a reducer call.** Instead, fire the reducer and handle the result in a subscription/onInsert callback elsewhere.

```typescript
// ❌ REST mindset — expecting a reference back
const newElement = await createItem({ title: 'Hello' });  // This doesn't work!

// ✅ SpacetimeDB mindset — fire and forget
conn.reducers.createItem({ title: 'Hello' });

// ...elsewhere in your app, react to the insert
conn.db.item.onInsert((ctx, row) => {
  console.log('New item:', row);
});
// Or in React: const [items, isReady] = useTable(tables.item);
```

Reducer callbacks exist in 2.0+ but don't return data about what was created. When the callback fires, rows are in the local cache — but you can't distinguish YOUR insert from another user's.

If you genuinely need immediate response data (rare once you adopt the pattern), two alternatives:
1. **Procedures** — can return data directly to the caller. See `references/api-guide.md` section 9.
2. **Event tables** — reducer inserts into an event table, client gets it via onInsert. Event tables auto-delete after delivery (insert + delete), acting as ephemeral response channels. This project uses this pattern with `LobbyCursorEvent`.

**Why reducers can't do this (v2.4.0):** reducers run on a dedicated **synchronous WASM runtime** — a single OS thread that never yields — while procedures run on a separate async runtime. This is the engine-level reason reducers are deterministic with no async/network: the runtime they execute on is physically incapable of yielding mid-call. Procedures get the async runtime, which is why `ctx.http` (outbound HTTP) lives there instead.

### High latency? Disable confirmed reads
If reducer round-trips feel slow (200ms+ even locally), the likely cause is confirmed reads. As of v2.1.0, the TypeScript SDK defaults to confirmed reads enabled (previously opt-in on the client side). Add `.withConfirmedReads(false)` to the connection builder for games and real-time apps. This applies to both local dev and maincloud. See `references/how-to-guides.md` § Confirmed Reads for the full trade-off.

### Reconnection workaround (temporary)
SDK 2.6.1 has no built-in reconnect. For the current workaround (unmount/remount provider via key prop), see `references/how-to-guides.md` § Reconnection. **v2.12.0+ (project SDK is 2.6.1; don't use until the upgrade lands):** `DbConnection.builder().withAutomaticReconnect()` (+ `withTokenProvider()`) keeps the connection, cache, subscriptions, and callbacks alive across outages, and the React provider turns it on automatically. Remove the key-remount workaround when adopting it. Same section has the details.

### Data access in React
**v2.1.0 fix:** `useTable`'s `isReady` previously could revert to `false` after initial sync due to a stale closure in `useSyncExternalStore`. Fixed in v2.1.0 — no code changes needed on your side.
```typescript
const [rows, isReady] = useTable(tables.myTable);  // Tuple!

// With query builder filter (operators: eq, ne, lt, gt, lte, gte)
const [online, isReady] = useTable(tables.user.where(r => r.online.eq(true)));
const [highLevel, isReady] = useTable(tables.user.where(r => r.level.gte(10).and(r.online.eq(true))));

// With callbacks
const [users, isReady] = useTable(tables.user, {
  onInsert: (row) => toast(`${row.name} joined`),
});
```

**Client-side index-first rule:** The same index-first principle from the server applies on the client. Use `conn.db.Table.pk.find()` / `conn.db.Table.idx.filter()` before falling back to `[...table.iter()].filter()`. Test files use `iter().filter()` as a convenience on small datasets — don't copy that pattern into production code.

### Subscription SQL restrictions

Subscription queries are a **strict subset** of SpacetimeDB SQL. Because they're evaluated in real-time on every transaction, additional restrictions apply:

| Rule | Detail |
|------|--------|
| **`SELECT *` only** | No individual column projections (`SELECT name FROM ...` is invalid) |
| **Max 2 tables** | JOINs support at most 2 tables — no 3+ table joins |
| **JOIN columns must be qualified** | `ON o.product_id = product.id`, not `ON product_id = id` |
| **Both JOIN columns need indexes** | Define btree indexes on both sides of the ON clause |
| **No arithmetic** | `WHERE price * 2 > 100` is invalid |
| **No aggregation** | COUNT, SUM, etc. are not supported in subscriptions |
| **No subqueries** | Only simple SELECT...FROM...WHERE...JOIN |
| **Supported WHERE ops** | `=`, `<`, `>`, `<=`, `>=`, `!=`, `<>`, `AND`, `OR` |
| **Supported literals** | INTEGER, STRING, HEX, TRUE, FALSE |

The ad-hoc query language (`spacetime sql`, HTTP API) is a strict superset — it allows column projections, `COUNT(*)`, unlimited joins, and `LIMIT`.

### No event-driven post-reducer sync

The TypeScript SDK has no `awaitNextUpdate()` API. After calling a reducer, there's no way to wait for the corresponding subscription update to arrive — you either use `_then()` for the reducer callback (confirms commit, but cache may still be updating) or sleep. This project's test harness uses tiered sleep values:

| Operation type | Sleep (ms) | Example |
|---|---|---|
| Simple action (pick, ban, leave) | 300 | `await h.sync(300)` |
| Default / single reducer | 500 | `await h.sync()` |
| State transition (start_draft, advance_stage) | 1500 | `await h.sync(1500)` |
| Initial connection (subscribeToAllTables) | 2000 | `setTimeout(resolve, 2000)` |

In production, prefer reactive patterns (`useTable`, `onInsert`, `onUpdate`) over sleeping.

### Subscription swap best practice

When changing subscriptions (e.g. user navigates to a different view), **subscribe to the new set first, then unsubscribe from the old**. This avoids unnecessary deserialization/reserialization of rows that appear in both the old and new query sets.

### Subscription pitfalls

**Combined `subscribe([...])` vs separate subscriptions:** When subscribing to multiple queries, `subscribe(['SELECT * FROM a', 'SELECT * FROM b'])` fires `onApplied` when the subscription message is acknowledged — NOT when all table data has arrived. If your `onApplied` callback reads from table B, the data may not be there yet. (Note: official docs state `on_applied` fires after all rows are cached atomically — see api-guide.md § 7 "Subscription semantics". This project's test harness uses a 2s sleep instead of `onApplied`, suggesting the behavior may differ in practice with combined multi-query subscriptions.)

Use separate subscriptions with individual `onApplied` callbacks when you need to read from specific tables:
```typescript
// ✅ CORRECT — each table has its own onApplied
conn.subscriptionBuilder()
    .onApplied(() => { /* view_my_profile data is ready */ })
    .subscribe('SELECT * FROM view_my_profile');

conn.subscriptionBuilder()
    .onApplied(() => { /* user data is ready — safe to read conn.db.User */ })
    .subscribe('SELECT * FROM user');

// ❌ WRONG — onApplied fires but conn.db.User may be empty
conn.subscriptionBuilder()
    .onApplied(() => { const users = [...conn.db.User.iter()]; /* may be 0! */ })
    .subscribe(['SELECT * FROM view_my_profile', 'SELECT * FROM user']);
```

**Overlapping queries hurt performance:** Subscribing to datasets that overlap (e.g. `tables.user` AND `tables.user.where(r => r.id.ne(5))`) forces the server to serialize nearly all rows twice. Keep subscription queries disjoint. Subscribing to the *same* query more than once is fine — it's zero-copy with no additional processing overhead.

**Views require export to register (CRITICAL):** Views must be **exported** from the module entry point — just like reducers. `spacetimedb.view()` returns a function with a `[registerExport]` symbol; the runtime only calls it when walking module exports. A side-effect import (`import './views/myViews'`) executes the code but discards the return value — the view never registers, `st_view` stays empty, and `spacetime generate` produces no bindings.

```typescript
// ❌ WRONG — view defined but never exported, [registerExport] never fires
spacetimedb.view({ name: 'view_my_profile', public: true }, ret, fn);

// ✅ CORRECT — exported, runtime finds and registers it
export const view_my_profile = spacetimedb.view({ name: 'view_my_profile', public: true }, ret, fn);
// Then in index.ts: export { view_my_profile } from './views/securityViews';
```

Once exported, `spacetime generate` creates typed view bindings (e.g. `view_my_profile_table.ts`). Views appear in `tablesSchema` alongside tables, accessible via `conn.db.view_my_profile` with `.count()`, `.iter()`, and row callbacks. View accessors use snake_case (matching the view name), not PascalCase like tables. **v2.7.0+ (PR #5286; the project's codegen/SDK is 2.6.1):** generated client handles become camelCase (`conn.db.viewMyProfile`, `conn.db.user`). The current spellings stay available as deprecated aliases, so existing code keeps compiling. Prefer the camelCase form only after the upgrade.

**Lifecycle hooks follow the same rule (CRITICAL, verified on 2.6.1).** `spacetimedb.init(...)`, `clientConnected(...)`, and `clientDisconnected(...)` return a module export that registers only when exported. A bare call is silently dropped: no error, and no lifecycle reducer in the schema.
```typescript
// ❌ WRONG — never runs
spacetimedb.clientConnected((ctx) => { /* ... */ });
// ✅ CORRECT
export const onConnect = spacetimedb.clientConnected((ctx) => { /* ... */ });
```
**This repo:** the hooks were bare calls until 2026-11-05, so the live maincloud schema listed **0 lifecycle reducers** out of 156 and the `isOnline`, `lastSeenAt`, ban-on-reconnect, and lobby-disconnect logic never ran. They are now `export const client_connected` / `client_disconnected` in `spacetimedb/src/index.ts`. A database only gets them once a build with the fix is published to it. Until then, don't assume those side effects happen there when debugging presence or disconnect features. Conversely, every *named* export of the module entry must be a SpacetimeDB export; a plain helper exported from `index.ts` throws "exporting something that is not a spacetime export".

**v2.4.1 + v2.6.0 — procedural views can declare `.primaryKey()`:** column-level `.primaryKey()` on a procedural view's return row type unlocks client-side `onUpdate` (previously views only fired `onInsert`/`onDelete`). This project's ~35 procedural views currently emit insert/delete only — adopting view PKs for `onUpdate` is a real opportunity but is **deferred under D-01** (not applied this phase). Declare the return row with `t.row('Name', { id: t.u64().primaryKey(), ... })`, not `t.object(...)`. See `references/api-guide.md` § 7 Views for the full note.

### Subscription gating: layer-0 always-on, gated panels use useTable enabled

`useTable(tables.X, { enabled: <boolean> })` (v2.2.0+, PR #4721) skips establishing the subscription while `enabled === false`. The SDK tears down the sub on `true → false` and re-establishes on `false → true` — no consumer remount needed.

```typescript
// GOOD — gated panel
function AdminPanel({ isActive }: { isActive: boolean }) {
    const [rows] = useTable(tables.User, { enabled: isActive });
    // ...
}

// GOOD — layer-0 reference data: ALWAYS-ON, no enabled prop
const [characters] = useTable(tables.HsrCharacter);

// BAD — never gate layer-0 reference data
const [characters] = useTable(tables.HsrCharacter, { enabled: someCondition });
// ↑ would reintroduce "first frame missing portraits" hydration bug
```

`enabled` lives in the 2nd-arg callback object alongside `onInsert/onDelete/onUpdate` — NOT a third arg, NOT a separate options bag.

**Layer-0 vs gated:**
- **Layer-0** (GameDataProvider's 7 reference-data subs): always-on, no `enabled`. Service worker prefetch + anonymous-page hydration depend on this.
- **Gated panels** (admin tabs, modals, conditionally-visible panels): `enabled` derived from the visibility/active-state. Recovers egress when the panel isn't visible.

Reference: Phase 16.4 Plan 05; `notes/v09-frontend-subscription-strategy.md` Decision 9.

### Reducer calls in React: useReducer(reducers.X), not getConnection()

Inside React components or hooks, use `const callX = useReducer(reducers.X)` and call `callX(args)`. The hook (v2.2.0+, PR #4752) returns a stable typed Promise-returning callback that queues internally until the connection is ready — eliminates the per-site `getConnection()` null-check.

```typescript
import { useReducer } from 'spacetimedb/react';
import { reducers } from '@/src/module_bindings';

function MyComponent() {
    const updateUsername = useReducer(reducers.updateUsername);
    // ...
    const onClick = () => {
        updateUsername({ newUsername: 'foo' })
            .catch((err: any) => setMessage({ type: 'error', text: err.message }));
    };
}
```

Empty-param reducers (no schema params) are called as `callX()`, not `callX({})` — the SDK's `ParamsType` collapses to `[]` when the reducer schema is empty (verified at `spacetimedb/node_modules/spacetimedb/dist/sdk/type_utils.d.ts:7`). Passing `{}` is a TypeScript error.

Reducers with **optional** params: as of v2.6.1 those keys are optional (`foo?:`), so `callX({ requiredArg })` — omitting the optional key entirely — is also legal. See "Client reducer calls" above for the full omit/optional/2.6.1 note.

Server-side Route Handlers (`getServerConnection()`) do NOT qualify — they continue calling `connection.reducers.X(...)` directly. React hooks only apply in React component / hook contexts.

Use `.catch()` for errors (matches project STATE.md "v0.5 Conventions"). For try/finally lifecycle (e.g. `setIsSubmitting`), use `.then()/.catch()/.finally()` chains — the boolean toggle becomes async.

The corresponding `useProcedure(procedures.X)` hook is for SpacetimeDB *procedures*; project defines zero procedures (`__procedures()` is called with no args at `src/module_bindings/index.ts:2037`), so `useProcedure` currently does not apply.

Reference: Phase 16.4 Plan 06 (v2.2.0+, PR #4752) — 5 adopted sites; `notes/v09-frontend-subscription-strategy.md` Decision 10.

### Handling reducer errors on the client
Reducers don't return data, so errors surface via callbacks. Use `_then()` to detect failures from a specific call, and `ctx.event.status` to read the `SenderError` message:
```typescript
// Per-call error handling — fires only for THIS call
conn.reducers.updateUsername({ newUsername: 'alice' })._then((ctx) => {
  if (ctx.event.status.tag === 'Failed') {
    toast.error(ctx.event.status.value);  // SenderError message string
  }
});

// Global reducer listener — fires for ALL calls to this reducer
conn.reducers.onUpdateUsername((ctx) => {
  if (ctx.event.status.tag === 'Failed') {
    console.error('updateUsername failed:', ctx.event.status.value);
  }
});
// Status tags: 'Committed' | 'Failed' (value = error message) | 'OutOfEnergy'
```

### CRUD operations (server)
```typescript
// Create — 0n placeholder for autoInc
const row = ctx.db.myTable.insert({ id: 0n, ... });

// Read — accessor API depends on how the column was declared:
//   .primaryKey()  → has .find() only (returns row or null)
//   .unique()      → has .find() only (returns row or null)
//   btree index    → has .filter() only (returns iterator)
const item = ctx.db.myTable.id.find(itemId);                   // PK → single row or null
const user = ctx.db.User.username.find('alice');                // unique → single row or null
const items = [...ctx.db.myTable.owner_id.filter(ownerId)];    // btree → iterator (spread to array)

// Multi-column btree index — .filter([val1, val2]) maps positionally to columns array
const row = [...ctx.db.MyJoinTable.by_col1_and_col2.filter([val1, val2])][0];

// Update — spread existing row (SpacetimeDB replaces the full row, so omitted fields become defaults/zero)
ctx.db.myTable.id.update({ ...existing, title: newTitle });

// Delete — by PK value
ctx.db.myTable.id.delete(itemId);

// Composite PK lookup — BEST: define a multi-column btree index, then .filter([val1, val2])
// See "Accessor types" section below for the 3 declaration types and their APIs
```

### Whole-table wipes — use Table.clear()

For unfiltered "delete everything in this table" operations, call `ctx.db.X.clear()` instead of iter+delete. Single ABI call (v2.2.0+, PR #4729) — faster than the iter+delete round-trip and uses fewer lines.

```typescript
// GOOD — whole-table wipe
ctx.db.LobbyMember.clear();

// BAD — iter+delete loop for an unfiltered wipe
for (const m of [...ctx.db.LobbyMember.iter()]) ctx.db.LobbyMember.delete(m);
```

Predicate filters (e.g. preserving the `username='SYSTEM'` row) MUST keep iter+filter+delete — `clear()` cannot skip rows. TS declarations do NOT surface a row count from `clear()`; use it as a statement, not as `const n = ctx.db.X.clear()` (n would be untyped).

Reference: `spacetimedb/src/reducers/server.ts → server_nuke_test_data` (Phase 16.4 Plan 01) — 42 cleared sites + 3 SYSTEM-preserving filter blocks demonstrate both patterns.

### Accessor types — verified runtime behavior (2026-03-18)

Each column declaration type produces a different accessor with a different API. Mixing them up causes TypeErrors or silent data loss. A column can be functionally unique (e.g., `discordId`) but declared as a btree index — in that case it only has `.filter()`, not `.find()`.

| Declaration | Example | Has `.find()` | Has `.filter()` |
|---|---|---|---|
| `t.xxx().primaryKey()` | `id: t.u32().primaryKey().autoInc()` | YES (row or null) | NO (TypeError) |
| `t.xxx().unique()` | `username: t.string().unique()` | YES (row or null) | NO (TypeError) |
| btree index (`indexes: [...]`) | `{ accessor: 'owner_id', algorithm: 'btree', columns: ['ownerId'] }` | NO (TypeError) | YES (iterator) |

**`.filter()` argument rules for btree indexes:**

| Index type | Correct usage | Silent failures (0 rows, no error) |
|---|---|---|
| Single-column btree | `.filter(scalar)` | `.filter({obj})`, `.filter([val1, val2])` |
| Multi-column btree | `.filter([val1, val2])` (positional to columns array) | `.filter({obj})` |

Single-column btree with `.filter([val])` (one-element array) auto-coerces to scalar and works, but prefer `.filter(scalar)` for clarity.

**Version notes:** on 2.6.1 a bare scalar on a **multi-column** index (`by_tournament_and_user.filter(tid)`) throws `serializeTerm is not a function`. From v2.7.0 (PR #5428) it becomes a valid one-column prefix scan, and prefix+`Range` composite scans are fixed from v2.8.0 (PR #5479). Until the upgrade, keep using the full-tuple array or the single-column-index fallback. Also on 2.6.1, chaining `.primaryKey()` / `.index()` directly on an object-form `t.enum(...)` column throws a TypeError (fixed v2.7.0). Index enum columns through `indexes: [...]` in table options, as this repo already does.

**Multi-column `primaryKey: [...]` declarations are a no-op (verified 2026-04-14, v2.1.0):**

Declaring composite PK at the `table()` options level produces **no engine enforcement and no accessor**:
```typescript
// ❌ Decorative only — NOT engine-enforced
table({ name: 't', primaryKey: ['a', 'b'] }, { a: t.string(), b: t.string(), v: t.u32() });
```
Live probe: published such a table, inserted `(x,y,1)` then `(x,y,2)` — both rows persisted. Generated bindings showed `indexes: [ ]` and `constraints: [ ]`. No `.pk` accessor (calling it at runtime panics).

**Real engine-enforced uniqueness requires single-column declarations:**
- `t.xxx().primaryKey()` on one column → generates `constraint: 'unique'` in bindings
- `t.xxx().unique()` on one column → generates `constraint: 'unique'` in bindings

**For tuple uniqueness across multiple columns:**
1. Add a multi-column btree index for fast O(log n) lookup via `.filter([val1, val2, ...])`.
2. Enforce uniqueness in the reducer itself (tuple-match-before-insert pattern) — the engine will not do it.
3. Optionally keep an autoInc `id: t.u32().primaryKey().autoInc()` as a real unique cursor for `.id.find/update/delete`, separate from the logical tuple key.

**How to verify in future:** Grep `src/module_bindings/index.ts` for the `constraints: [...]` array on any table. If empty, tuple uniqueness is not engine-enforced regardless of what `table()` options declared. The `primaryKey: [...]` option on `table()` is **documentation-only** — it can stay in source as a reader hint, but the real guarantee is in reducer code + the matching btree index.

**Multi-column btree index definition and usage:**
```typescript
// Table definition with multi-column btree index
export const TournamentParticipant = table({
  name: 'tournament_participant',
  public: true,
  indexes: [
    { accessor: 'by_tournament_and_user', algorithm: 'btree', columns: ['tournamentId', 'userId'] },
  ]
}, {
  tournamentId: t.u32(),
  userId: t.u32(),
  // ... other columns
});

// Usage — values map positionally to the columns array
const participant = [...ctx.db.TournamentParticipant.by_tournament_and_user.filter([tid, uid])][0];

// Fallback if no multi-column index exists: filter on one column, find on the other
const fallback = [...ctx.db.TournamentParticipant.tournament_id.filter(tid)].find(r => r.userId === uid);
```

### Errors in reducers — use `SenderError`
A plain `throw new Error()` logs to the server but the client only sees a generic failure. `SenderError` serializes the message into the reducer response so the calling client can display it.
```typescript
import { SenderError } from 'spacetimedb/server';

if (!item) throw new SenderError('Item not found.');
```

### AuthCtx applicability + scheduled-reducer external-invocation defense (v2.2.0)

**TL;DR:** Do NOT add `if (!ctx.senderAuth.isInternal) throw` guards to scheduled reducers on SpacetimeDB v2.2.0. The SDK's `senderAuth` accessor ALWAYS returns `isInternal: false`, including for engine-dispatched scheduler invocations — the guard rejects legitimate dispatch and breaks the reducer. The actual external-invocation defense is engine-level: SpacetimeDB v2.2.0 returns `"no such reducer"` for external WS callers attempting to invoke scheduled reducer names BEFORE any application code runs.

#### Why the guard pattern doesn't work in v2.2.0

Plan 02 (Phase 16.4) initially added the guard pattern below to 3 scheduled reducers (`run_user_deletion`, `run_lobby_gc`, `run_identity_gc`) as defense-in-depth:

```typescript
// ❌ DO NOT ADD THIS — rejects legitimate engine dispatch in v2.2.0
if (!ctx.senderAuth.isInternal) {
    throw new SenderError(
        'Forbidden: scheduled reducer; cannot be invoked externally.'
    );
}
```

Plan 07's diagnostic (2026-05-03) proved this assumption wrong via SDK source-level analysis (`spacetimedb/node_modules/spacetimedb/dist/server/index.mjs:6383-6442`):

- `AuthCtxImpl.internal()` is the only constructor that sets `isInternal: true` — and it is **unreachable** from any path that produces `ctx.senderAuth`.
- `ReducerCtxImpl.senderAuth` (the only path that populates the field) calls `AuthCtxImpl.fromSystemTables(...)`, which always sets `isInternal: false`.
- Therefore `ctx.senderAuth.isInternal` is always `false` in v2.2.0 — the guard rejects 100% of invocations including legitimate engine-dispatched scheduler calls.

The guards were removed in Plan 07 hotfix; see `.planning/phases/16.4-spacetimedb-v2-2-0-refactor-pass/16.4-AUDIT-NOTES.md` (the "v0.6 Update — Plan 07 Diagnostic Reversal" section) for the full diagnostic and reversal record.

#### What IS the external-invocation defense

The SpacetimeDB v2.2.0 engine itself rejects external WebSocket calls to scheduled-reducer names with `"no such reducer"` BEFORE any application code runs. Verified:

- The 3 scheduled reducers (`run_user_deletion`, `run_lobby_gc`, `run_identity_gc`) are intentionally absent from the generated client bindings (`src/module_bindings/index.ts`).
- The regression sensor at `test/backend/scheduled-reducer-isInternal-rejection.test.ts` constructs a low-level `connection.callReducer(name, argsBuffer)` call — exactly what an attacker would do — and confirms the engine returns `"no such reducer"` for all 3 names.

**Therefore: do NOT add application-level guards to scheduled reducers in v2.2.0.** The engine is the correct defense layer. If a future SDK version exposes scheduled-reducer names to external callers, revisit this rule and find a working internal-dispatch signal before re-adding any guard.

**Still true on 2.6.1** (re-verified 2026-11-05: `AuthCtxImpl.fromSystemTables` is the only producer of `ctx.senderAuth`). **v2.14.0 changes this (PR #5892, breaking; project SDK is 2.6.1, so don't act on it until the upgrade lands):** `isInternal` becomes `ctx.sender === ctx.databaseIdentity` in every module language. In TypeScript it is then **true for scheduled reducers and procedures**, `init` is **no longer** internal (its sender is the database owner), and `senderAuth.jwt` is none whenever `isInternal` is true. A module keeps the old behavior until it is rebuilt against the new library. After the upgrade, an `isInternal` guard on scheduled reducers becomes a working defense-in-depth option, but re-verify with the regression sensor before adding one. The project gates in the table below still don't change.

#### `AuthCtx` is still NOT a substitute for project auth gates

| Project gate | Concept | Replace with `AuthCtx`? |
|---|---|---|
| `requireServer(ctx)` | "Identity matches registered SERVER_TOKEN row" | NO — `post-publish.ts` is an external WebSocket client; `AuthCtx.isInternal` would always be `false` for it (and is broken in v2.2.0 anyway). The SERVER_TOKEN/`ServerIdentity` row check is orthogonal. |
| `getAuthenticatedUser(ctx)` | "Resolve `ctx.sender → UserIdentity → User → role.tag`" | NO — project auth model is not JWT-claims-based; `AuthCtx.jwt` is for native OIDC, which the project intentionally does not use (guest-play UX, see `notes/v09-frontend-subscription-strategy.md`). |
| `ensureModerator/Admin(ctx)` | Role-tag-based admin gates | NO — same reason as above. |

Use `requireServer` / `getAuthenticatedUser` / `ensureXxx` for ALL application-level gating. Do not use `ctx.senderAuth.isInternal` until/unless a future SDK release fixes the unreachable-factory bug; the engine's "no such reducer" rejection is the operational defense for scheduled reducers in the meantime.

Reference: Phase 16.4 Plan 02 + Plan 07 hotfix — `.planning/phases/16.4-spacetimedb-v2-2-0-refactor-pass/16.4-AUDIT-NOTES.md` (audit + v0.6 reversal record); regression sensor at `test/backend/scheduled-reducer-isInternal-rejection.test.ts`.

### BigInt — all u64/i64 fields
Use `0n`, `1n`, `100n` — never plain numbers for ID/u64 fields. JavaScript `number` loses precision above 2^53, so SpacetimeDB maps 64-bit integers to BigInt. Mixing `number` and `BigInt` (e.g. `row.id === 5`) silently returns `false` — no error, just wrong behavior.

### Timestamps — server-side construction (CRITICAL)
**Never construct timestamps as plain objects on the server.** The SDK serializer reads the internal `__timestamp_micros_since_unix_epoch__` property, not `microsSinceUnixEpoch`. A plain object `{ microsSinceUnixEpoch: BigInt }` causes a PANIC: "Cannot convert undefined to a BigInt".
```typescript
// ❌ WRONG — causes PANIC during insert/update serialization
startAt: { microsSinceUnixEpoch: BigInt(param) }

// ✅ CORRECT — use the Timestamp constructor
import { Timestamp } from 'spacetimedb';
startAt: new Timestamp(BigInt(param))

// ✅ CORRECT — ctx.timestamp is already a proper Timestamp object
createdDate: ctx.timestamp
```

**Reducer timestamp param pattern** (this project): Timestamps are passed as `t.string()` params (BigInt micros serialized as string) to avoid u64 encoding issues. Convert in the reducer body:
```typescript
const startMicros = BigInt(startAt);  // string → BigInt
new Timestamp(startMicros)            // BigInt → Timestamp
```

**Optional timestamps:** For optional table columns, `undefined` writes `none` — this works. For optional fields **inside structs** (`t.u8().optional()`, `t.timestamp().optional()` in a `t.object()`), `null`/`undefined`/omission all PANIC during serialization. Use sentinel values instead:
```typescript
// ❌ PANIC — SDK can't serialize null/undefined for optional struct fields
recurrenceRule = { ..., dayOfWeek: null, endDate: undefined };

// ✅ Use sentinels for optional struct fields
recurrenceRule = { ..., dayOfWeek: 255, endDate: new Timestamp(0n) };
```

### Timestamps on client (reading)
```typescript
const date = new Date(Number(row.createdAt.microsSinceUnixEpoch / 1000n));
```

### Timestamps — full flow
```
Frontend:  new Date() → BigInt(date.getTime()) * 1000n → .toString() → reducer string param
Backend:   BigInt(param) → new Timestamp(BigInt(param)) → insert into t.timestamp() column
Client:    row.field.microsSinceUnixEpoch → new Date(Number(micros / 1000n)) → display in local TZ
```
All timestamps are stored as UTC microseconds. Frontend converts to/from local timezone for display only.

## Multiplayer sync patterns (summary)

**Don't sync positions. Sync time.** Two patterns cover all multiplayer entities:

| Pattern | When to use | Network cost | Examples |
|---------|------------|--------------|----------|
| **Write once, compute anywhere** | Behavior expressible as a formula | 1 insert + 1 delete per entity lifetime | Bullets, grenades, AoE, cooldowns, patrol routes |
| **Stream and interpolate** | Unpredictable input every frame | ~20 writes/sec per entity | Player movement, aiming, vehicle steering |

**Write once:** Store origin + direction + speed + timestamp. All clients compute `pos(t) = origin + direction * speed * (t - fired_at)` locally. Remote clients do time catchup at spawn. Client predicts before server confirms.

**Stream:** Owner sends position at fixed rate. Server validates each update. Remote clients lerp between received positions.

**They combine:** Streamed player positions mean write-once projectiles can do local collision checks against reasonably current positions. Two patterns, zero coupling.

**Validation:** Start with ownership checks (`bullet.owner === ctx.sender`) and basic state (`player.health > 0`). Add server recomputation only when cheating is observed. Full simulation is rarely worth it.

See `references/multiplayer-sync-patterns.md` for full implementation details, code examples, and the complete fire/hit/kill/respawn lifecycle.

## Dangerous schema changes (require user confirmation)

These operations **destroy all existing data** and require `--clear-database` to republish:

- **Renaming a column** on a published table
- **Dropping a column** from a published table
- **Adding a column in the middle** of an existing table (not at the end)

**Exception — event tables (v2.5.0, broadened further in v2.6.0):** the above list applies to regular tables only. Event tables (`event: true`, e.g. this project's `LobbyCursorEvent`) get broadened automigration support and permit column drop / reorder / type-change without requiring `--clear-database` — because event-table rows never persist past delivery, there is no existing data for the migration to destroy.

Safe schema changes (no data loss):
- **Adding a column at the end** of a table — but it **must have a default value**, otherwise the publish will fail for existing rows.

Migration rules are enforced by the **server** (maincloud's version), not the project SDK. **Adding `.unique()` / `.primaryKey()` to an existing column:** the v2.14.1 automatic-migrations doc still lists it as forbidden. The v2.7.0 release notes (PR #4465) say it is allowed when existing rows have no duplicates, and that it fails safely while naming the duplicates otherwise. Treat it as unsupported until a reviewed publish proves otherwise. **Renaming a schema key (accessor) while keeping `name:`** is allowed by current servers but breaks code that uses the old accessor. Renaming a table accessor panicked at runtime before server v2.8.2 (#5544).

Before making any of these dangerous changes, always confirm with the user that a full database reset is acceptable (this does not apply to the event-table exception above).

## Critical "do nots"

These are APIs that don't exist — LLMs hallucinate them frequently:

| Hallucinated API | What to use instead |
|---|---|
| `import { SpacetimeDBClient } from "@clockworklabs/spacetimedb-sdk"` | `import { DbConnection } from './module_bindings'` |
| `SpacetimeDBClient.connect(...)` | `DbConnection.builder().withUri(...).build()` |
| `conn.reducers.foo("val")` (positional) | `conn.reducers.foo({ param: "val" })` (object) |
| `reducer('name', params, fn)` | `export const name = spacetimedb.reducer(params, fn)` |
| `User.filterByName(...)` | `useTable(tables.user)` + filter in JS |
| `tables.user.filter(u => ...)` | `useTable(tables.user)` returns array, filter that |
| `const rows = useTable(table)` | `const [rows, isReady] = useTable(tables.user)` |
| `.subscribeToAll()` | `.subscribeToAllTables()` — method name changed |
| `throw new Error('msg')` in reducers | `throw new SenderError('msg')` — surfaces message to the calling client |
| `(ctx.db.Table as any).primaryKey.find({...})` | Define a multi-column btree index and use `.filter([val1, val2])` — `.primaryKey` is undefined at runtime, causes PANIC |
| `ctx.db.Table.index.filter({col1, col2})` (object arg) | `.filter(scalar)` for single-col, `.filter([val1, val2])` for multi-col btree — object arg silently returns 0 rows |
| `ctx.db.Table.singleColIdx.filter([val1, val2])` (array on single-col) | `.filter(scalar)` — passing an array to a single-column btree index silently returns 0 rows |
| `ctx.db.Table.btreeIdx.find(val)` | `[...ctx.db.Table.btreeIdx.filter(val)]` — btree indexes only have `.filter()`, not `.find()` (TypeError) |
| `ctx.db.Table.pkCol.filter(val)` | `ctx.db.Table.pkCol.find(val)` — PK/unique columns only have `.find()`, not `.filter()` (TypeError) |
| `{ microsSinceUnixEpoch: BigInt }` in server insert/update | `new Timestamp(BigInt)` — plain objects lack the internal `__timestamp_micros_since_unix_epoch__` property, causing PANIC |
| `null` / `undefined` for optional struct fields | Use sentinel values (e.g. `255` for u8, `new Timestamp(0n)` for timestamp) — optional inside `t.object()` can't serialize null/undefined |
| `conn.db.ViewMyProfile.iter()` (PascalCase view accessor) | View accessors use snake_case matching the view name: `conn.db.view_my_profile.iter()`. Views must be exported from the module for bindings to generate. (v2.7.0+ adds camelCase `conn.db.viewMyProfile`; snake_case stays as a deprecated alias) |
| `subscribe([...]).onApplied(() => read all tables)` | Combined array subscribe fires `onApplied` before all table data arrives — use separate subscriptions with individual `onApplied` callbacks per table |
| Bare `spacetimedb.clientConnected(...)` / `clientDisconnected(...)` / `init(...)` | `export const onConnect = spacetimedb.clientConnected(...)` — unexported hooks never register (silent) |
| `new Range(new Bound.Inclusive(a), new Bound.Inclusive(b))` | `new Range({ tag: 'included', value: a }, { tag: 'included', value: b })` — `Bound` is a type, not a class |
| `Math.random()` / `crypto.randomUUID()` in a reducer | `ctx.random()`, `ctx.random.integerInRange(min, max)`, `ctx.newUuidV4()` — deterministic, available on 2.6.1 |
| `spacetimedb.reducer({ onSchedule: table }, ...)` / `.withAutomaticReconnect()` / `ctx.env.X` / `spacetimedb/server/test-utils` on this repo | Real APIs, but post-2.6.1 (v2.7 / v2.12 / v2.12 / v2.12) — they don't exist in the installed SDK. See api-guide § 12 |

## Feature implementation checklist

When implementing a feature that spans backend and client:

1. **Backend:** Define table(s) in `tables/` folder (one file per table), then import in `schema.ts`
2. **Backend:** Define reducer(s) in `reducers/` folder (grouped by domain), then re-export in `index.ts`
3. **Backend:** Publish module (`spacetime publish`)
4. **Backend:** Generate bindings — use the CLI path, `npm run spacetime:generate` (this repo has **no local Cargo workspace / `gen-bindings` crate**, so the cargo-based `npm run generate` script fails or is stale; `spacetime:generate` always uses the currently-installed `spacetime` CLI version)
5. **Client:** Subscribe to the table(s)
6. **Client:** Call the reducer(s) from UI
7. **Client:** Render data from `useTable(tables.tableName)`

Common mistake: building backend tables/reducers but forgetting to wire up the client to call them.

## CLI commands

### Connecting to the database

The database name and server are configured in `spacetime.json` at the project root:
- `database` — the published database name (use this as `<name>` in all CLI commands)
- `server` — the target server nickname (e.g. `maincloud`)

**When running CLI commands from the project root**, `spacetime.json` is auto-detected — so you can omit `-s <server>` and sometimes even `<name>`. But always prefer being explicit to avoid confusion.

```bash
# Read the database name from spacetime.json before running any CLI command:
#   "database": "hsrpvp-spacetimedb-nextjs-test1"
#   "server": "maincloud"
```

### Common commands

```bash
spacetime publish <name> --module-path <dir>       # Publish module
spacetime publish <name> --clear-database -y --module-path <dir>  # Clear & republish
spacetime generate --lang typescript --out-dir <client>/src/module_bindings --module-path <dir>
spacetime logs <name>                              # View logs
spacetime logs <name> --level warn                 # Filter by log level (warn and above)
spacetime sql <name> "SELECT * FROM table_name"    # Query tables via SQL
spacetime call <name> <reducer_name> [args...]     # Call a reducer
```

**v2.5.0 CLI changes:** `spacetime publish --delete-data` no longer forces a positional db name — it falls back to the name in `spacetime.json` if omitted. `spacetime call` now accepts **hex strings for `Identity` params** (e.g. `spacetime call <name> <reducer> <hex-identity>`) — no more manual byte-array construction for identity args.

**CLI is 2.6.1 too** (`spacetime --version` → `spacetimedb tool version 2.6.1`; a 2.14.1 toolchain is installed side-by-side but not active, and switching is part of the upgrade, not ad-hoc). Commands added after 2.6.1, which won't exist until the CLI is upgraded: `spacetime sql --format json`, `spacetime lock` / `unlock` (v2.7.0, guards against accidental `delete`), `spacetime mcp` (v2.8.1), human-readable `spacetime describe` (v2.11.0), `spacetime env list/get` + `publish --env-only/--unset-env/--replace-env` (v2.12.0), `spacetime auth` for SpacetimeAuth management (v2.13.0), `generate --import-extension` (v2.14.0). From v2.11.0 failed publishes print the full error chain, and from v2.12.0 local schema-validation errors are spelled out. On 2.6.1, expect terse failures.

**v2.6.1 SQL parser — no constant projections (verified live 2026-07-04):** the `spacetime sql` parser rejects literal/constant SELECT projections — `SELECT 1 AS ok` fails with `Error: Unsupported projection expression: 1` (HTTP 400). A connectivity smoke-test must project a real column from a real table, e.g. `spacetime sql <name> "SELECT COUNT(*) AS n FROM user"`, not `SELECT 1`. (Behavior change in the 2.3–2.6 line; caught during the Phase 16.5 upgrade.)

### Publishing: use :migrate for reviewed schema deltas

`npm run spacetime:publish` stays interactive — the destructive-migration confirm dialog is a safety feature, not friction. Use `npm run spacetime:publish:migrate` (v2.2.0+, PR #4885) when you have already reviewed the schema delta in a prior diff.

```bash
npm run spacetime:publish           # Interactive: confirms destructive migrations.
npm run spacetime:publish:migrate   # Auto-confirms ONLY the migration prompt (--yes=migrate).
```

The `--yes=migrate` value must attach with `=` (per `spacetime publish --help`). Other `--yes` values (`break-clients`, `delete-data`, `remote`, `skip-login`) remain interactive in this script — opt them in explicitly only when the situation warrants.

Related v2.2.0 informational notes:
- `.withCompression('brotli')` exists on `DbConnection.builder()` as an alternative to gzip; project has not adopted it (browser-support floor too high for current users; realistic ratio gain on BSATN binary frames is 5-15% — not worth the failure mode on older browsers).
- v2.2.0 also allows dropping empty tables during auto-migration (PR #4593) — relevant when refactoring schemas; no project-side action needed.

Reference: Phase 16.4 Plan 03; `package.json` script line; `docs/smoke/contract.md` operational note.

### `spacetime sql` column name gotcha

`spacetime sql` auto-converts camelCase column definitions to snake_case, but the conversion splits at every case boundary including before digits. This produces non-obvious names:

| Column definition (camelCase) | SQL column name (snake_case) |
|------|------|
| `groupSize` | `group_size` |
| `autoAdvanceBracket` | `auto_advance_bracket` |
| `has3rdPlaceMatch` | `has_3_rd_place_match` (not `has_3rd_place_match`) |
| `teamId` | `team_id` |

**When in doubt, use `SELECT * FROM table LIMIT 1`** to see the actual column names before writing filtered queries.

### `spacetime sql` string comparison gotcha

The CLI displays string values with double quotes (e.g., `"identity"`), but SQL WHERE clauses must use **single quotes only**: `WHERE gc_type = 'identity'`. Using `WHERE gc_type = '"identity"'` matches nothing — it looks for a string literally containing double quotes.

## Project structure (this repo)

### Backend (`spacetimedb/src/`)
```
schema.ts              -> Imports all tables, exports spacetimedb via schema({...})
index.ts               -> Imports all reducers, views, lifecycle hooks (clientConnected/Disconnected)
tables/                -> One file per table (e.g. user.ts, lobby.ts, hsrCharacter.ts)
  └── Each exports column definitions + table() call
reducers/              -> One file per domain (e.g. auth.ts, admin.ts, roster.ts, rosterAdmin.ts)
  └── Each imports spacetimedb from ../schema
views/                 -> Security views limiting client data access (e.g. securityViews.ts)
helpers/               -> Shared utilities (ensurePermissions.ts, auditColumns.ts, rosterHelpers.ts)
types/
  ├── enums.ts         -> All enum definitions (Path, Element, CharRole, GameMode, etc.)
  └── structs.ts       -> All struct/object type definitions (EidolonCost, LobbyConfig, etc.)
docs/ (project root)   -> Feature architecture docs (one folder per domain with architecture.md and contract.md)
```

### Frontend
```
src/module_bindings/    -> Generated client bindings (don't edit! Regenerate with spacetime generate)
app/                    -> Next.js App Router pages
  ├── (authenticated)/  -> Protected routes (admin-view, lobby, profile)
  ├── (game)/           -> Game routes (draft/[matchId])
  ├── (landing-page)/   -> Public routes (costs, teambuilder)
  └── api/              -> API routes (auth, discord linking)
components/features/    -> Feature-based component organization
  ├── admin-view/       -> Admin panel components
  ├── auth/             -> Authentication components + hooks
  ├── costs/            -> Cost display components + hooks
  ├── drafting/         -> Draft UI (classic + auction modes)
  ├── game-data/        -> Game data display components
  └── landing/          -> Landing page components
lib/                    -> Shared utilities and configuration
```

### Key conventions
- **New tables** go in `spacetimedb/src/tables/` as individual files, then import in `schema.ts`
- **New reducers** go in `spacetimedb/src/reducers/` grouped by domain, then import in `index.ts`
- **New enums/structs** go in `spacetimedb/src/types/enums.ts` or `structs.ts`
- **New views** go in `spacetimedb/src/views/`, then import in `index.ts`
- **New frontend features** go in `components/features/<feature-name>/` with `components/` and `hooks/` subdirs
- **Private tables** (e.g. `LobbyPassword`) use `public: false` to keep sensitive data off the wire — see pattern below

## Naming conventions (this repo — ENFORCED)

| Layer | Convention | Examples |
|-------|-----------|----------|
| Table columns | `camelCase` | `hostUserId`, `avatarCharacterName`, `createdById` |
| Struct/object fields | `camelCase` | `teamSize`, `characterName`, `isPaused` |
| Enum variants | `PascalCase` | `MemoryOfChaos`, `BlueWins`, `TournamentHost` |
| Reducer export names | `snake_case` | `login_as_guest`, `server_link_discord` |
| Index accessors (code-facing) | `snake_case` | `host_user_id`, `discord_id`, `user_id` |
| Table names (in `table()`) | `snake_case` | `'user'`, `'hsr_character'`, `'lobby_member'` |
| Helper functions | `camelCase` | `getAuthenticatedUser`, `ensureAdmin`, `auditInsert` |
| Constants | `UPPER_SNAKE_CASE` | `SYSTEM_USER_ID`, `DISCORD_INTENT_KEY` |

**Never mix conventions within a layer.** All struct fields and table columns MUST be camelCase. Enum variants MUST be PascalCase (standard TypeScript enum convention).

**Index definitions only need `accessor`** — SpacetimeDB auto-generates the DB catalog `name`, so omit it. The `accessor` is the code-facing handle used in `ctx.db.Table.accessor.find/filter()`. Keep it short — accessors are scoped per-table, so no table prefix needed.

```typescript
// ✅ Clean — single-column, accessor only, name auto-generated
indexes: [{ accessor: 'owner_id', algorithm: 'btree', columns: ['ownerId'] }]

// ✅ Multi-column btree — use for composite PK lookups; .filter([val1, val2]) maps positionally
indexes: [{ accessor: 'by_tournament_and_user', algorithm: 'btree', columns: ['tournamentId', 'userId'] }]

// ❌ Never omit accessor
indexes: [{ algorithm: 'btree', columns: ['ownerId'] }]

// ❌ Unnecessary — name is auto-generated, don't declare it
indexes: [{ name: 'my_table_owner_id_idx_btree', accessor: 'owner_id', algorithm: 'btree', columns: ['ownerId'] }]
```

## Audit columns policy (this repo — ENFORCED)

Every table MUST have these 4 columns at the end of its column definition. Exceptions:
- `ServerIdentity`
- **event tables** (`event: true`, e.g. `LobbyCursorEvent`). Their rows are delivered once and never persist, so audit columns are pure per-event egress. User decision, 2026-11-06; the `LobbyCursorEvent` cleanup lands in the new repo's backend reset.

```typescript
createdById: t.u32(),
createdDate: t.timestamp(),
lastModifiedById: t.u32(),
lastModifiedDate: t.timestamp(),
```

**Rules:**
- Each table defines its own audit columns inline — do NOT import/spread a shared object. SpacetimeDB's `table()` resolves column types at call time, so if tables share a column definition object, a change to that object silently alters every table that uses it — causing unintended schema migrations or `--clear-database` requirements.
- Use `auditInsert(ctx, userId)` from `helpers/auditColumns.ts` when inserting a new row
- Use `auditUpdate(ctx, existingRow, userId)` from `helpers/auditColumns.ts` when updating a row — this preserves original `createdById`/`createdDate`
- `SYSTEM_USER_ID = 0` is used for bootstrap operations (e.g. `register_server` creating the SYSTEM user) and scheduled reducers
- The SYSTEM user (discordId = `"1"`, role = Admin) is created during `register_server` as the first user
- When upserting (delete + re-insert for composite PK tables), preserve audit fields from the deleted row: `...(existing ? auditUpdate(ctx, existing, userId) : auditInsert(ctx, userId))`
- Admin reducers should capture `const admin = ensureAdmin(ctx)` once at the top and use `admin.id` for all audit fields

## Data access best practices (this repo — ENFORCED)

**Always prefer indexed lookups over `.iter()`** — `.iter()` performs a full table scan (O(n)), while `.find()` and `.filter()` on indexes are O(log n). In views, `.iter()` is especially dangerous: the view re-evaluates on *any* row change in the source table, so an iter-based view touching a 10k-row table fires 10k scans per write.

| Scenario | Use | NOT |
|----------|-----|-----|
| Lookup by PK (`.primaryKey()`) | `ctx.db.Table.pkCol.find(value)` | `.pkCol.filter()` (TypeError — PK only has `.find()`) |
| Lookup by unique col (`.unique()`) | `ctx.db.Table.uniqueCol.find(value)` | `.uniqueCol.filter()` (TypeError — unique only has `.find()`) |
| Lookup by btree index (`indexes: [...]`) | `[...ctx.db.Table.idx.filter(value)]` | `.idx.find()` (TypeError — btree only has `.filter()`) |
| Multi-column lookup (multi-col btree) | `[...ctx.db.Table.by_col1_and_col2.filter([val1, val2])]` | `.filter({col1, col2})` (object arg silently returns 0 rows!) |
| Multi-column lookup (single-col btree fallback) | `[...ctx.db.Table.idx.filter(col1Val)].find(r => r.col2 === col2Val)` | `.filter([val1, val2])` on single-col index (silently returns 0 rows!) |
| Composite PK lookup | Define multi-col btree index, then `[...ctx.db.Table.by_col1_and_col2.filter([val1, val2])]` | `.primaryKey.find()` (undefined at runtime — PANIC!) |
| Identity from hex string | `Identity.fromString(hex)` then `.find()` on PK/index | `.iter()` + `.toHexString()` comparison (O(n) scan) |
| Composite key upsert (no PK accessor) | `.iter()` + match | N/A — iter is the only option |

**`Identity` construction from hex strings:** The `Identity` class accepts hex strings directly — `new Identity(hexString)` or `Identity.fromString(hexString)`. Both throw if the input is not a valid 32-byte hex string. Use this to convert hex strings for PK/index lookups instead of iterating:
```typescript
import { Identity } from 'spacetimedb';
const identity = Identity.fromString(callerIdentityHex);  // throws on invalid input
const row = ctx.db.UserIdentity.identity.find(identity);  // O(1) PK lookup
```

**When `.iter()` is unavoidable**, add a comment explaining why (e.g. "composite key with no multi-column index defined").

## TypeScript patterns in SpacetimeDB (SDK limitations)

**`ctx: any` in helper functions** — The SpacetimeDB SDK exports `ReducerCtx` but it's generic and requires the full schema type parameter. Using `any` for `ctx` in standalone helper functions (`ensureAdmin`, `getAuthenticatedUser`, `auditInsert`) is the accepted pattern. Do NOT try to import or construct the generic context type.

*Upstream note (not a rule change):* the official Clockwork `typescript-server` skill now recommends `type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>` for helpers and warns that `any` erases row types and can let `bigint` math infer as `number`. Both `ReducerCtx` and `InferSchema` are exported from `spacetimedb/server` in **2.6.1**, and a type-only import of `typeof spacetimedb` adds no runtime cycle. Switching is a repo-wide convention decision for the user. Keep `ctx: any` unless that decision is made.

**`as any` on enum values** — When constructing enum values from runtime strings (e.g. `{ tag: roleTag, value: {} } as any`), the `as any` cast is necessary because TypeScript can't narrow a `string` variable to the specific literal union the enum type expects. This is expected.

**`export let` for scheduled table reducers** — The `userDeletionJob.ts` pattern (`export let _reducer: any` + setter function) is the documented way to avoid circular dependencies between scheduled tables and their reducers. Do not refactor this. (v2.7.0+, PR #5435: the reducer-side `spacetimedb.reducer({ onSchedule: table }, params, fn)` option removes the cycle at its source and is upstream's recommended form. It is the natural replacement **after** the SDK upgrade. See api-guide § 5.)

## User table special fields

- `isOnline: t.bool()` — set `true` in `clientConnected`, `false` in `clientDisconnected`
- `isPrivate: t.bool()` — defaults to `false`, for future privacy features
- `deletedAt: t.timestamp().optional()` — soft-delete pattern, triggers scheduled hard-delete after 5s

## Private tables — keeping sensitive data off the wire

When a table has columns that should never reach the client (passwords, tokens, secrets), extract those columns into a separate `public: false` table linked by FK. This project uses `LobbyPassword` as the canonical example:

```typescript
// lobbyPassword.ts — private table, never broadcast to clients
export const LobbyPassword = table({
  name: 'lobby_password',
  // public: false is the default, but explicit is better
  indexes: [{ accessor: 'lobby_id', algorithm: 'btree', columns: ['lobbyId'] }]
}, {
  lobbyId: t.u64().primaryKey(),  // FK to Lobby.id
  passwordHash: t.string(),
  // audit columns...
});
```

Reducers can still read/write private tables — only client subscriptions are blocked.

**Bindings for private tables:** `spacetime generate` always includes type definitions for private tables (so views can reference them in return types). It does NOT generate subscription/query code for private tables by default. To include subscription code (for admin tools or testing), add `--include-private`:
```bash
spacetime generate --lang typescript --out-dir src/module_bindings --module-path spacetimedb --include-private
```

## Admin proxy reducer pattern

For features where users have self-service reducers, create a parallel set of `admin_*` reducers that mirror the user operations but act on behalf of any user. The pattern:

```typescript
export const admin_create_thing = spacetimedb.reducer(
  { targetUserId: t.u32(), /* same params as user reducer */ },
  (ctx, { targetUserId, ...params }) => {
    const admin = ensureAdmin(ctx);
    // Same logic as user reducer, but use targetUserId instead of ctx.sender
  }
);
```

See `reducers/rosterAdmin.ts` for the full example (9 admin proxy reducers mirroring `roster.ts`).

## Foreign keys

SpacetimeDB does NOT support FK constraints. Referential integrity must be enforced in reducer code. This is by design — SpacetimeDB's distributed architecture prioritizes write throughput over relational constraints. Check for the existence of referenced rows in reducers before inserting, and cascade-delete related rows manually when removing parents.

## Energy budget & bandwidth rules (ENFORCED)

This project runs on SpacetimeDB maincloud with a **100,000 energy/month budget** (the user's plan maximum, confirmed 2026-11-06; earlier text said 40,000, and `tools/energy-model.js:19` still says 90,000). "Energy" here is maincloud's TeV: the 200-per-GB egress rate below matches the pricing page. Egress is the dominant cost driver (~99% of energy in growth scenarios). Every table and reducer decision must consider bandwidth impact.

**Energy rates:**
- 1M reducer calls = 840 energy
- 10GB egress = 2,000 energy
- 1GB storage = 2,592 energy

**The #1 cost driver is initial subscription load** — every user connection downloads all subscribed public table data. At scale, this dwarfs real-time broadcasts.

### Subscription strategy (MUST follow)

- **Never subscribe to all tables.** Users subscribe only to tables relevant to their current view.
- **Match history tables are on-demand** — `match_session_history`, `match_session_step_history` are NOT in default subscriptions. Load only when user views match history.
- **Cost tables**: Subscribe only to the active `costSetId`, not all cost sets.
- **Tournament data**: Subscribe only for tournaments the user is viewing/participating in.
- **Static data** (characters, lightcones, archetypes): Safe to subscribe globally — small and rarely updated.
- **Transient tables** (lobby, match_session, chat): Subscribe only when in a lobby.

### Table design rules for bandwidth

| Rule | Why |
|------|-----|
| Prefer `public: false` + views over `public: true` for user-scoped data | Prevents broadcasting to all subscribers |
| Prefer computed values on frontend over stored columns | Saves writes, storage, AND egress (e.g., `winRate = wins / matchesPlayed`) |
| Use transactional tables (row exists = pending, delete = resolved) | Fewer rows = less storage and egress |
| Minimize string columns on high-row-count tables | Strings have 4-byte overhead + content; use enums or u8 codes where possible |
| Split large tables by access pattern | History/audit data separate from live data users always subscribe to |
| Keep audit columns (24 bytes/row) — they're tiny vs string columns | Don't remove audit for "savings" — the overhead is negligible. Exception: event tables, where they're paid on every delivery (see Audit columns policy) |

### Fan-out reducers are egress amplifiers (ENFORCED)

A reducer whose writes reach many subscribers costs **writes × subscribers** in egress. Any client can call it in a loop with the SDK; there's no website in between. Every such reducer needs:
- **A per-identity rate limit.** Store the last-accepted time per user and drop calls that come too fast. A manual throttle works on any version. **(v2.13+, post-upgrade)** the reusable `@spacetimedb/rate-limit` submodule is an option.
- **Input bounds:** clamp or reject out-of-range values and cap payload sizes.
- **Membership and state checks** before inserting.

Example: `broadcast_cursor` (`reducers/cursor.ts`) checks lobby membership but has **no rate limit and no x/y bounds**, as of 2026-11-06. Put tunable thresholds (cursor Hz, spam limits) in a config singleton row the reducers read, like `elo_config`, so they change without a redeploy. Seed that row in the post-publish bootstrap, not in `init`, which only runs on first publish or a wipe.

### Measuring egress in the app (dev-only)

To see which subscription costs what:
- **Bytes on the wire:** subclass or wrap `globalThis.WebSocket` **before** `DbConnection.builder()...build()` runs, and count received bytes. These are compressed bytes, as billed.
- **Cache size per table:** serialize each cached row with `AlgebraicType.makeSerializer(Row.algebraicType)` into a `BinaryWriter` and read `.offset`.

Both APIs exist on 2.6.1 and 2.14.1 (`dist/index.d.ts`, `lib/algebraic_type.d.ts`, `lib/binary_writer.d.ts`). Reference implementation: `clockworklabs/spacetimedb-cookbook` `wikiwatch/src/debug/wireStats.ts`. Keep it out of production bundles.

### When to run the energy model

Run `node tools/energy-model.js` to check energy impact:
- Before adding new public tables (especially unbounded-growth ones)
- When changing subscription strategy
- During phase discussions to compare design options
- Use `--scenario growth --months 12` for forward-looking analysis

```bash
node tools/energy-model.js                                    # Current baseline
node tools/energy-model.js --scenario growth --months 12      # Growth projection
node tools/energy-model.js --users 300 --matches-per-day 40   # Custom scenario
node tools/energy-model.js --all                              # Compare all scenarios
```

### Tradeoff reporting

When proposing any design that adds tables, columns, or changes visibility:
1. State the bandwidth impact (rough: "adds ~X MB to initial subscription load per user")
2. State the storage growth rate ("~X rows/month at Y bytes/row = Z MB/year")
3. Compare alternatives if they exist
4. Flag if the change moves the growth scenario closer to budget limits

## Updating docs from SpacetimeDB GitHub

The skill references are synced to **SpacetimeDB v2.14.1** (released 2026-11-04). Upstream docs are pinned at tag commit `a0bf6be10a146b03acbe3f4f9ad7fe20f114988d`, and the official agent skills at master `17a3f3a649a3ad55e1520353a53ec5de8ea97b0a`. **The project's SDK and CLI are still 2.6.1** (`package.json` `spacetimedb: ^2.6.1`, `spacetime --version` 2.6.1). Untagged guidance is valid on 2.6.1. Anything newer carries an inline `(v2.X+ …)` tag and must not be used until the upgrade lands. Server-side behavior (migration rules, HTTP API, scheduler, MCP endpoint) follows maincloud's server version, so those notes may apply already. Last audit: 2026-11-05, items SK-10..SK-29 (previous: Phase 16.5 SK-1..SK-9).

When the user asks to update the skill docs (e.g. "update spacetimedb docs", "check for new SpacetimeDB changes", "sync with upstream"), or when you notice `spacetimedb` in `package.json` has been bumped:

1. **Check the latest release:** `gh api "repos/clockworklabs/SpacetimeDB/releases?per_page=30"` (gh CLI: `"/c/Program Files/GitHub CLI/gh.exe"`). Read every release body after the synced version; TS-relevant items live under TypeScript/SDK, Breaking Changes, and Bug Fixes.
2. **Fetch upstream docs:** each reference file has `<!-- Sources: ... -->` comments at the top with the exact GitHub URLs. Fetch the raw versions of those URLs (swap `github.com/.../blob/` to `raw.githubusercontent.com/.../`), at both the old and new commit, and diff them. Paths move between releases (see below). If a URL 404s, list `git/trees/<tag-commit>?recursive=1`.
3. **Diff the official agent skills:** Clockwork publishes generic skills in `skills/` (`typescript-server`, `typescript-client`, `concepts`, `cli`, `mcp`). Diff them between the pinned commit and current master, and pull in anything more current or more correct, with attribution. Our skill stays the project skill. The official one has no project rules, and it targets the latest SDK.
4. **Verify against the installed SDK before writing "current" guidance:** check `node_modules/spacetimedb/dist/**/*.d.ts` and `dist/server/index.mjs`. Upstream examples target the newest release. The 2026-11-05 audit also used this check to find several long-standing claims in this skill that were wrong even for the installed SDK (SK-10..SK-17).
5. **Update reference files**, keeping the TypeScript focus and the version-tag convention. Update the source comment URLs to the new commit hash.
6. **Update SKILL.md** if new patterns, APIs, or breaking changes affect the cheat sheet. Move the baseline line above.

Key upstream doc paths (as of v2.14.1):
- How-to guides: `docs/docs/00250-how-to/` (was `docs/docs/00300-resources/00100-how-to/` at 1a1fe78)
- CLI reference + spacetime.json: `docs/docs/00300-resources/00100-cli-reference/` (was `00300-resources/01000-reference/...` / `00200-reference/...`)
- HTTP API: `docs/docs/00300-resources/00200-http-api/`; MCP: `docs/docs/00300-resources/00150-mcp.md`
- Core concepts (views, indexes, schedule tables, env vars, TS client reference): `docs/docs/00200-core-concepts/`
- Official agent skills: `skills/` (Claude plugin manifest: `.claude-plugin/marketplace.json`; agent setup: `https://spacetimedb.com/agent-setup.md`; `https://spacetimedb.com/llms.txt`)
- Releases: `https://github.com/clockworklabs/SpacetimeDB/releases`

**Official plugin vs this skill:** `claude plugin install spacetimedb@spacetimedb-plugins` (marketplace `clockworklabs/SpacetimeDB`, shipped v2.8.2) bundles the generic skills plus a `spacetime mcp` server entry. That server needs CLI 2.8.1+, and the active CLI here is 2.6.1. Its skills target the latest SDK, use different conventions (camelCase index accessors, inline `.index('btree')`, typed `ctx`), and teach post-2.6.1 APIs (`onSchedule`, `withAutomaticReconnect`). If both are loaded, **this skill wins** for anything project-specific or version-sensitive.
