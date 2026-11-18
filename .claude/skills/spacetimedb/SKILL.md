---
name: spacetimedb
description: "Build and debug SpacetimeDB TypeScript modules and React clients (this repo: the `spacetimedb/` module and the Vite + React SPA in `web/`), including multiplayer sync patterns. Use this skill whenever the user is working with SpacetimeDB — adding tables, writing reducers, creating views, setting up React subscriptions, publishing modules, debugging connection or query issues, implementing multiplayer features (movement sync, projectiles, combat, client-side prediction, interpolation), or any feature that touches the SpacetimeDB backend or client bindings. Also trigger when the user mentions spacetimedb, reducers, module_bindings, spacetime publish, spacetime generate, ctx.db, multiplayer sync, real-time multiplayer, table schema, subscription, BigInt, SenderError, useTable, or DbConnection."
---

# SpacetimeDB TypeScript Development

This skill guides you through building correct SpacetimeDB applications. SpacetimeDB has many API pitfalls that LLMs commonly hallucinate — this skill exists to prevent those mistakes and keep you on the correct APIs.

## This is a maincloud SpacetimeDB project. Connection: `wss://maincloud.spacetimedb.com` / database names in `shared/stdb-targets.ts` (`test` = `hsr-spacetimedb-test1`, `prod` = `hsr-spacetimedb-prod`). No local server — do not use `spacetime start`. `spacetime call` uses the CLI identity (not an app user) so avoid it for testing authenticated reducers. Prod is not published yet; step status lives in `ROADMAP.md`, rulings in `DECISIONS.md` (append-only). Where this skill and `CLAUDE.md` disagree, `CLAUDE.md` wins.

**Maintaining this skill:** When updating any pattern or API behavior in this file: (1) check whether the content already exists before adding — grep SKILL.md and references to avoid duplication, (2) check whether the same topic appears in the reference files (especially `references/api-guide.md` — see its table of contents) and update those too. Stale or duplicated references are worse than none — they teach agents the wrong pattern or waste context.

## When to load references

Read `references/api-guide.md` when you need detailed syntax for any of:
- Table definitions, column types, index configuration
- Reducer/procedure definitions and patterns
- Client-side React integration (the SDK's useTable, subscriptions, provider setup; generic: this repo's pages use `web/src/stdb/`, see "The client layer")
- Subscription semantics, cache guarantees, query builder operators (eq/ne/lt/gt/lte/gte, and/or/not), semijoins
- Views (procedural and query-builder)
- Scheduled tables and timestamps
- Common mistakes table (server-side and client-side)
- Reducer context surface (`ctx.random`, `ctx.newUuidV4/V7`, nullable `ctx.connectionId`)
- § 12 features added after 2.6.1 (env vars, views with arguments, submodules, async IDC, in-memory module tests). All exist in this repo's SDK 2.15.0; the repo already uses module env vars, views with arguments and `spacetimedb/server/test-utils`

**Module bindings** — read the generated files directly (always up-to-date, never stale):

| What you need | Read this file |
|---|---|
| Table schemas, indexes, constraints, reducer list | `web/src/module_bindings/index.ts` |
| Type definitions (enums, structs, tagged unions) | `web/src/module_bindings/types.ts` |
| Reducer parameter names for a specific reducer | `web/src/module_bindings/<reducer_name>_reducer.ts` |

`web/src/module_bindings/` is the one committed bindings copy (CLAUDE.md §1); `npm run stdb:generate` rewrites it from the local module source.

Read `references/spacetime-json.md` when editing `spacetime.json` or `spacetime.local.json` — covers all config fields, generate targets, environment overrides, `spacetime dev` setup, and child database inheritance.

Read `references/http-api.md` when working with:
- Server-side SpacetimeDB access outside the WebSocket SDK (this repo's `scripts/stdb/*.ts` use the WebSocket SDK; the login function, `api/_lib/handlers.ts` behind `api/auth/discord/`, calls `linker_present_code` over HTTP `/call` with `STDB_LINK_TOKEN`)
- Calling reducers or running SQL via HTTP (not WebSocket)
- Identity/token management, database publishing via API
- Any scenario where the WebSocket SDK isn't available

Read `references/how-to-guides.md` for operational topics:
- Logging (console API, `spacetime logs --follow`, level filtering)
- Rejecting client connections in `clientConnected`
- Event tables
- Confirmed reads toggle for latency-sensitive apps
- PostgreSQL wire protocol for admin/debugging queries
- Maincloud deployment (hot-swap, dashboard, database states)
- Known 2.6.1 TS SDK bugs fixed upstream (history; all fixed on this repo's 2.15.0)
- MCP access to a live database (server-side on maincloud; `spacetime mcp` needs CLI 2.8.1+, the active CLI is 2.15.0)
- Module unit testing (v2.12+; in use here under `spacetimedb/src/__tests__/`)

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

// Client (web/) — ONLY these packages exist
import { DbConnection, tables } from '@bindings/index';     // Generated: web/src/module_bindings
import type { MyLoadoutRow } from '@bindings/types';
import { Identity, SenderError, toSql } from 'spacetimedb';
// Pages: the repo's hooks, never 'spacetimedb/react' (only web/src/stdb/StdbProvider.tsx imports it)
import { useStdbConnection } from '@/stdb/connectionContext';
import { useRouteSubscriptions } from '@/stdb/useRouteSubscriptions';
import { useRows } from '@/stdb/useRows';
import { useReducerCall } from '@/stdb/useReducerCall';
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
Every reducer here (CLAUDE.md §3): is one transaction and returns nothing (read results through views and subscriptions); is deterministic (no filesystem, network, timers or `Math.random`; `ctx.timestamp`, `ctx.newUuidV4()` are fine, draws go through the fair draw, see the `ctx.random` guardrail); takes the caller only from `ctx.sender`, never from an identity argument. Auto-increment ids have gaps: never order by them.

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
This is a type-widening, not a required refactor — existing call sites that pass `undefined` explicitly keep compiling. (The real `create_season` also takes `startDate`; trimmed here.)

### The SpacetimeDB mindset: fire-and-forget, react to events
SpacetimeDB is event-driven (CQRS-style), not request-response like REST. The biggest habit to break coming from web dev: **don't try to get a reference back from a reducer call.** Instead, fire the reducer and handle the result in a subscription/onInsert callback elsewhere.

```typescript
// ❌ REST mindset — expecting a reference back
const newElement = await createItem({ title: 'Hello' });  // undefined: no row comes back!

// ✅ SpacetimeDB mindset — fire and forget
conn.reducers.createItem({ title: 'Hello' });

// ...elsewhere in your app, react to the insert
conn.db.item.onInsert((ctx, row) => {
  console.log('New item:', row);
});
// In this repo's pages: rows come from a subscribed view through useRows (see "The client layer")
```

On 2.15.0 a reducer call returns `Promise<void>`: it resolves when the call committed and rejects with the refusal (see "Reducer calls and errors on the client"). It carries no data about what was created; you can't tell YOUR insert from another user's by the row event alone.

If you genuinely need immediate response data (rare once you adopt the pattern), two alternatives:
1. **Procedures** — can return data directly to the caller. See `references/api-guide.md` section 9.
2. **Event tables** — reducer inserts into an event table, client gets it via onInsert. Event tables auto-delete after delivery (insert + delete), acting as ephemeral response channels. This project's one event table, `LobbyCursorEvent`, is a broadcast (cursor positions to a lobby), not a response channel.

**Why reducers can't do this (v2.4.0):** reducers run on a dedicated **synchronous WASM runtime** — a single OS thread that never yields — while procedures run on a separate async runtime. This is the engine-level reason reducers are deterministic with no async/network: the runtime they execute on is physically incapable of yielding mid-call. Procedures get the async runtime, which is why `ctx.http` (outbound HTTP) lives there instead.

### High latency? Disable confirmed reads
If reducer round-trips feel slow (200ms+ even locally), the likely cause is confirmed reads. As of v2.1.0, the TypeScript SDK defaults to confirmed reads enabled (previously opt-in on the client side). Add `.withConfirmedReads(false)` to the connection builder for games and real-time apps. This applies to both local dev and maincloud. The web app already does (`createConnectionBuilder` in `web/src/stdb/connection.ts`). See `references/how-to-guides.md` § Confirmed Reads for the full trade-off.

### Reconnection (built in since v2.12.0)
On this repo's SDK (2.15.0) the React provider turns on `withAutomaticReconnect()` itself: it reuses the session token, keeps the same `DbConnection`, cache and callbacks across outages, and **replays every registered subscription** after a reconnect. Code that subscribes manually must keep the handle (`const handle = conn.subscriptionBuilder()...subscribe(...)`) and call `handle.unsubscribe()` on cleanup, or each remount adds a duplicate that is replayed forever; in `web/` `useRouteSubscriptions` does this for you. The SDK reports `connected` before the replay lands and keeps the old rows until then: a page that writes on the strength of what it reads waits for `fresh` from `useFreshRouteSubscriptions` (the team builder's loadout sync). The 2.6.1 unmount/remount-the-provider (key prop) workaround is obsolete; don't add it. Outside React, `DbConnection.builder().withAutomaticReconnect()` (+ `withTokenProvider()`) does the same. Details: `references/how-to-guides.md` § Reconnection.

### Data access in React
The SDK's `useTable(query, { onInsert, onDelete, onUpdate, enabled })` returns `[rows, isReady]` (a tuple), but this repo's pages don't use it (A173, see "The client layer"). In `web/` the pattern is:
```typescript
const { ready, error } = useRouteSubscriptions([LOADOUTS_QUERY]);   // SQL strings, e.g. toSql(tables.viewMyProfile)
const rows = useRows((conn) => conn.db.viewMyLoadouts, ready);      // cache rows, re-read on row events
```
Query-builder filters (`tables.x.where(r => r.col.eq(v))`, operators eq, ne, lt, gt, lte, gte, and/or/not) turn into SQL with `toSql(...)`.

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

The TypeScript SDK has no `awaitNextUpdate()` API. Awaiting the reducer call's Promise is the one wait you get: on 2.15.0 the client applies that transaction's updates to its cache before it resolves the call (`dist/sdk/index.mjs`, the `ReducerResult` branch). Rows other clients write arrive on their own schedule. In this repo only the live residue sleeps: the WebSocket harness in `test/shared/connection.ts` resolves on `onApplied` and exposes `h.sync(ms = 500)` as a plain wait. The in-memory module tests (`spacetimedb/src/__tests__/`, the default layer, `test/README.md`) run reducers synchronously inside `withReducerTx` and never sleep.

In production, prefer reactive patterns (row callbacks, `useRows`) over sleeping.

### Subscription swap best practice

When changing subscriptions (e.g. user navigates to a different view), **subscribe to the new set first, then unsubscribe from the old**. This avoids unnecessary deserialization/reserialization of rows that appear in both the old and new query sets.

**Exception, views with arguments:** every argument set of one view lands in the same client table, so rows of the old and new set would mix. Keep one argument set per view subscribed at a time: unsubscribe the old set, then subscribe the next (e.g. the A115 match-history pages and their filters). `useRouteSubscriptions` always works this way: a changed query list unsubscribes the old set before subscribing the new one (effect cleanup order). The same holds for two filters of one table (a custom cost set beside the default one): keep the queries disjoint and filter cached rows by the key, since one client table holds both (`rowsOfSet` in `web/src/stdb/costLookup.ts`).

### Subscription pitfalls

**Combined `subscribe([...])` vs separate subscriptions:** When subscribing to multiple queries, `subscribe(['SELECT * FROM a', 'SELECT * FROM b'])` fires `onApplied` when the subscription message is acknowledged — NOT when all table data has arrived. If your `onApplied` callback reads from table B, the data may not be there yet. (Note: official docs state `on_applied` fires after all rows are cached atomically — see api-guide.md § 7 "Subscription semantics"; this repo's live harness (`test/shared/connection.ts`) reads the cache inside the `onApplied` of a single `subscribeToAllTables()` call. Whether combined multi-query subscriptions differ in practice is not verified on 2.15.0.)

Use separate subscriptions with individual `onApplied` callbacks when you need to read from specific tables (`useRouteSubscriptions` and the reference set make one subscription per query):
```typescript
// ✅ CORRECT — each table has its own onApplied
conn.subscriptionBuilder()
    .onApplied(() => { /* view_my_profile data is ready */ })
    .subscribe('SELECT * FROM view_my_profile');

conn.subscriptionBuilder()
    .onApplied(() => { /* character data is ready — safe to read conn.db.hsrCharacter */ })
    .subscribe('SELECT * FROM hsr_character');

// ❌ WRONG — onApplied fires but conn.db.hsrCharacter may be empty
conn.subscriptionBuilder()
    .onApplied(() => { const chars = [...conn.db.hsrCharacter.iter()]; /* may be 0! */ })
    .subscribe(['SELECT * FROM view_my_profile', 'SELECT * FROM hsr_character']);
```
(No page subscribes the `user` table: it is private (A77; CLAUDE.md §4).)

**Overlapping queries hurt performance:** Subscribing to datasets that overlap (e.g. `tables.user` AND `tables.user.where(r => r.id.ne(5))`) forces the server to serialize nearly all rows twice. Keep subscription queries disjoint. Subscribing to the *same* query more than once is fine — it's zero-copy with no additional processing overhead.

**Views require export to register (CRITICAL):** Views must be **exported** from the module entry point — just like reducers. `spacetimedb.view()` returns a function with a `[registerExport]` symbol; the runtime only calls it when walking module exports. A side-effect import (`import '@module/views/myViews'`) executes the code but discards the return value — the view never registers, `st_view` stays empty, and `spacetime generate` produces no bindings.

```typescript
// ❌ WRONG — view defined but never exported, [registerExport] never fires
spacetimedb.view({ name: 'view_my_profile', public: true }, ret, fn);

// ✅ CORRECT — exported, runtime finds and registers it
export const view_my_profile = spacetimedb.view({ name: 'view_my_profile', public: true }, ret, fn);
// Then in index.ts: export { view_my_profile } from '@module/views/identityViews';
```

Once exported, `spacetime generate` creates typed view bindings (e.g. `view_my_profile_table.ts`). Views appear in `tablesSchema` alongside tables, accessible via `conn.db.view_my_profile` with `.count()`, `.iter()`, and row callbacks. View accessors use snake_case (matching the view name), not PascalCase like tables. **v2.7.0+ (PR #5286):** generated client handles become camelCase (`conn.db.viewMyProfile`, `conn.db.user`). The old spellings stay available as deprecated aliases, so existing code keeps compiling. Prefer the camelCase form in new code.

**Lifecycle hooks follow the same rule (CRITICAL, verified on 2.6.1).** `spacetimedb.init(...)`, `clientConnected(...)`, and `clientDisconnected(...)` return a module export that registers only when exported. A bare call is silently dropped: no error, and no lifecycle reducer in the schema.
```typescript
// ❌ WRONG — never runs
spacetimedb.clientConnected((ctx) => { /* ... */ });
// ✅ CORRECT
export const onConnect = spacetimedb.clientConnected((ctx) => { /* ... */ });
```
**This repo:** the hooks are `export const init` / `client_connected` / `client_disconnected` in `spacetimedb/src/index.ts`, and test1 runs them. (In the old repo they were bare calls, so presence, ban-on-reconnect and lobby-disconnect logic never ran.) Conversely, every *named* export of the module entry must be a SpacetimeDB export; a plain helper exported from `index.ts` throws "exporting something that is not a spacetime export".

**v2.4.1 + v2.6.0 — procedural views can declare `.primaryKey()`:** column-level `.primaryKey()` on a procedural view's return row type unlocks client-side `onUpdate` (previously views only fired `onInsert`/`onDelete`). In this repo some view row types declare `.primaryKey()` (e.g. in `views/adminViews.ts`, `lobbyViews.ts`, `calendarViews.ts`, and `MyLoadoutRow.slot` in `loadoutViews.ts`); the other views emit insert/delete only, and views with arguments cannot have a primary key. The key shows on the generated row type (`<view>_table.ts`), while the view's `constraints` list in `web/src/module_bindings/index.ts` stays empty even with a key, so read the row type before relying on `onUpdate`. A keyless view whose row is replaced fires an insert and a delete in one transaction: `useRows` coalesces them into one read. Declare the return row with `t.row('Name', { id: t.u64().primaryKey(), ... })`, not `t.object(...)`. See `references/api-guide.md` § 7 Views for the full note.

### The client layer (`web/src/stdb/`, CLAUDE.md §4, binding)

Pages reach the database only through `useStdbConnection` and the hooks in `web/src/stdb/` (A173), never through the SDK's `useTable` / `useReducer` / `useSpacetimeDB`:
- **Loading.** `LazyStdbProvider` (in `main.tsx`) renders the app at once and loads the SDK, the bindings and `StdbProvider.tsx` in their own chunk after the first render; the entry chunk holds no SDK code (pinned by `entryChunk.test.ts`). `StdbProvider` is the only importer of `spacetimedb/react`: `MaintenanceGate` reads `web/public/status.json` and, only while it says "not in maintenance", renders the SDK's `SpacetimeDBProvider` *beside* the app, which hands its connection up. So the SDK's React hooks have no provider above a page.
- **Layer 0** (`layer0.ts`, every route, whole session): `view_my_profile` (feeds the auth store and the router guards) and `view_my_lobbies`. Nothing else is global.
- **Reference set** (`referenceSet.ts`, `useReferenceSet()`): `hsr_character`, `hsr_lightcone`, `archetype`, `hsr_character_archetype`, `view_published_cost_sets`; with `{ costs: true }` also the default cost set (the three cost tables filtered on `cost_set_id = 0`). Started by the first route that needs it, kept for the session, never gated; `/` and `/profile` never start it. A custom cost set is a route subscription (`useCustomCostSet.ts`). Sizes: `docs/frontend/subscriptions.md` Decision 1.
- **Route subscriptions:** `useRouteSubscriptions(queries)` (or `useFreshRouteSubscriptions`, which adds `fresh`): one subscription per query, handles kept, all unsubscribed on unmount or when the list changes. Queries are SQL strings: `toSql(tables.x)`, or `SELECT * FROM view_x(42)` for a view with arguments. To gate a subscription, pass an empty or shorter list (the team builder subscribes `view_my_loadouts` only for a verified member). Read rows with `useRows((conn) => conn.db.x, ready)`.
- **Rules:** subscribe only **views and the public reference set**; `subscribeToAllTables` is banned in `web/` (`npm run check:patterns`; the live harness under `test/` may use it). No page subscribes the `User` table (private, A77): names and avatars are denormalized into the views that need them, and the admin Users tab reads `view_admin_users`. One subscription per table per route, dropped on route leave. Match views and cursor events subscribe only once the lobby stage is past Waiting; cursor events (`LobbyCursorEvent`, an event table) are consumed via `onInsert`. Views with arguments: one argument set per view at a time.

### Reducer calls and errors on the client

On 2.15.0 `conn.reducers.x(params)` returns `Promise<void>`: it resolves when the call committed and rejects with an error whose class name tells what happened (`dist/lib/errors.d.ts`, all exported from `spacetimedb`):

| `error.name` | Meaning |
|---|---|
| `SenderError` | The module refused the call; `message` is the module's `SenderError` text |
| `InternalError` | "An internal reducer error returned by the server runtime" (SDK doc), not module refusal text |
| `DisconnectedError` | Not sent: the connection was not established |
| `UnknownCallResultError` | The connection dropped before the answer: the call may have run |
| `NotConnectedError` (repo, `useReducerCall.ts`) | Not sent: the app had no open connection |

There is no `_then()` and no per-reducer `conn.reducers.onX(...)` listener in 2.15.0 (not in the typings or `dist/sdk/index.mjs`); use the Promise.

In pages, `useReducerCall((r, args) => r.saveLoadout(args))` wraps the call: it rejects at once with `NotConnectedError` when the connection is not open (the SDK's `useReducer` would queue silently). Classify refusals by `error.name` first, then by the module's exact sentence, kept as one shared constant per case (`outcomeOf` in `shared/loadouts/sync.ts`; the texts are the contract in `docs/loadout/architecture.md`). On `conn.reducers`, an empty-parameter reducer takes `{}` (`r.loginAsGuest({})`); only the SDK's `useReducer` collapses it to `()`. Optional parameters may be omitted (v2.6.1+). Non-React callers (`scripts/stdb/*.ts` through `_connection.ts`, the live harness) call `conn.reducers.x(...)` on their own `DbConnection`. The module defines no procedures, so `useProcedure` does not apply.

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

Predicate filters (e.g. preserving the `username='SYSTEM'` row) MUST keep iter+filter+delete — `clear()` cannot skip rows. `clear()` is typed `bigint` (`dist/lib/table.d.ts`, 2.14.1 and 2.15.0): the TS runtime returns the table's row count read just before the clear. This repo uses it as a statement only; `server_nuke_test_data`'s `totalDeleted` counts the filtered blocks, not the `clear()` calls.

Reference: `spacetimedb/src/reducers/identity/server.ts → server_nuke_test_data` (test-only, gated by `requireTestDatabase`) uses both patterns: whole-table `clear()` calls plus SYSTEM-preserving filter blocks.

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

**Version notes:** since v2.7.0 (PR #5428) a bare scalar on a **multi-column** index (`by_tournament_and_user.filter(tid)`) is a valid one-column prefix scan, and prefix+`Range` composite scans work since v2.8.0 (PR #5479); both are usable on this repo's 2.15.0. (History: on 2.6.1 the bare scalar threw `serializeTerm is not a function`.) Also on 2.6.1, chaining `.primaryKey()` / `.index()` directly on an object-form `t.enum(...)` column throws a TypeError (fixed v2.7.0). Index enum columns through `indexes: [...]` in table options, as this repo already does.

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

**How to verify in future:** Grep `web/src/module_bindings/index.ts` for the `constraints: [...]` array on any table. If empty, tuple uniqueness is not engine-enforced regardless of what `table()` options declared. The `primaryKey: [...]` option on `table()` is **documentation-only** — it can stay in source as a reader hint, but the real guarantee is in reducer code + the matching btree index.

**Multi-column btree index definition and usage** (`TournamentParticipant` is an illustrative old-repo table; this repo's live instance of the pattern is `LobbyMember.by_lobby_and_user`, used e.g. in `reducers/lobby/cursor.ts`):
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

### AuthCtx, scheduled reducers and the project's auth gates

**`isInternal` (v2.14.0+, PR #5892; unchanged in 2.15.0):** `ctx.senderAuth.isInternal` means `ctx.sender === ctx.databaseIdentity`. It is **true for scheduled reducers and procedures**, `init` is **not** internal (its sender is the database owner), and `senderAuth.jwt` is null whenever `isInternal` is true. (On SDK 2.2.0 it was always `false`, so a guard on it broke every scheduled job; a database keeps a module's old behaviour until a build against the newer library is published.)

**Scheduled reducers.** This repo has five: `run_user_deletion`, `run_lobby_gc`, `run_identity_gc`, `run_referee_transfer_check`, `run_tournament_finalize`. They are absent from the generated client bindings, and each calls `ensureScheduler(ctx, name)` (`helpers/admin/schedulerGuard.ts`) as its first statement ("Forbidden: <name> is a scheduled reducer and runs only from the scheduler."). Two layers, both confirmed live on test1 (S11a log): the engine refuses an outside caller before the module runs ("External attempt to call nonexistent reducer", with empty and with correctly encoded arguments), and the live scheduler's own calls pass the guard. The sensor is `test/live/isinternal-rejection.test.ts`, which builds the raw `callReducer(name, argsBuffer)` call an attacker would.

**`AuthCtx` is NOT a substitute for the project's auth gates:**

| Project gate | Concept | Replace with `AuthCtx`? |
|---|---|---|
| `requireServer(ctx)` (local to `reducers/identity/server.ts`) | "Caller has an Owner (from `init`) or Delegate `ServerIdentity` row" (`trustedServerRow`; a Linker row is refused) | NO — `scripts/stdb/bootstrap.ts` and the other scripts are external WebSocket clients holding `STDB_SERVER_TOKEN`; `isInternal` is `false` for them. |
| `requireLinker(ctx)` (`helpers/identity/serverIdentities.ts`) | "Caller has a Linker `ServerIdentity` row" (the login function, `STDB_LINK_TOKEN`); guards `linker_present_code` only | NO — the login function is an external client too. |
| `getAuthenticatedUser(ctx)` | "Resolve `ctx.sender → UserIdentity → User → role.tag`" (refuses no user, a deleted account, maintenance mode) | NO — the project's auth model is not JWT-claims-based; `AuthCtx.jwt` is for native OIDC, which the project does not use (sign-in is the Discord link-code flow, `docs/auth/architecture.md`; SpacetimeAuth is deferred, A46). |
| `ensureVerifiedUser` / `ensureModerator` / `ensureAdmin` (`helpers/identity/ensurePermissions.ts`) | Discord-linked (not a guest), role-tag gates | NO — same reason as above. |

Use these gates for ALL application-level gating; `isInternal` is used only by `ensureScheduler`.

**Sign-in, in one paragraph** (details: `docs/auth/architecture.md`): every browser gets a SpacetimeDB identity; `login_as_guest` maps it to a guest `User`. To link Discord, the guest calls `request_link_code(clientNonce)`; the login function (`api/auth/discord/`, logic in `api/_lib/`) runs the OAuth exchange and presents the code over HTTP with `linker_present_code` as the narrow Linker identity; the browser then calls `confirm_link(confirmToken)`, the only reducer that links (merge in `helpers/identity/providerLink.ts`). The old direct link `server_link_provider` is removed (A177). A Linker can call nothing else, but its token is enough to sign in as any Discord-linked account: treat `STDB_LINK_TOKEN` as top secret.

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

**Reducer timestamp param pattern** (this project, most reducers; `create_season` takes `t.timestamp()`): Timestamps are passed as `t.string()` params (BigInt micros serialized as string) to avoid u64 encoding issues. Convert in the reducer body:
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
- **Adding a new table** (and a new view or reducer) to a published database is additive.
- **Adding a column at the end** of a table — but it **must have a default value**, otherwise the publish will fail for existing rows.

**This repo's practice:** "published" means test1 today (prod is not published yet). Changing the shape of an existing table on test1 can force a migration or a wipe, so prefer a new private table over new columns on a live one: the loadout save limit got its own `UserLoadoutRate` table instead of columns on the live `UserRateState`, and its limits are constants rather than `AbuseConfig` columns (`docs/loadout/architecture.md`). A table that was never published can still change freely (A198 changed `user_loadout` before its first publish).

Migration rules are enforced by the **server** (maincloud's version), not the project SDK. **Adding `.unique()` / `.primaryKey()` to an existing column:** the v2.14.1 automatic-migrations doc still lists it as forbidden. The v2.7.0 release notes (PR #4465) say it is allowed when existing rows have no duplicates, and that it fails safely while naming the duplicates otherwise. Treat it as unsupported until a reviewed publish proves otherwise. **Renaming a schema key (accessor) while keeping `name:`** is allowed by current servers but breaks code that uses the old accessor. Renaming a table accessor panicked at runtime before server v2.8.2 (#5544).

Before making any of these dangerous changes, always confirm with the user that a full database reset is acceptable (this does not apply to the event-table exception above).

## Critical "do nots"

These are APIs that don't exist — LLMs hallucinate them frequently:

| Hallucinated API | What to use instead |
|---|---|
| `import { SpacetimeDBClient } from "@clockworklabs/spacetimedb-sdk"` | `import { DbConnection } from '@bindings/index'` |
| `SpacetimeDBClient.connect(...)` | `DbConnection.builder().withUri(...).build()` (in `web/` only `createConnectionBuilder` builds one) |
| `conn.reducers.foo("val")` (positional) | `conn.reducers.foo({ param: "val" })` (object) |
| `reducer('name', params, fn)` | `export const name = spacetimedb.reducer(params, fn)` |
| `Thing.filterByName(...)` / `tables.thing.filter(t => ...)` | Subscribe the view, read rows (`useRows`), filter the array in JS |
| `const rows = useTable(table)` | SDK form is `const [rows, isReady] = useTable(...)`; pages use `useRouteSubscriptions` + `useRows` instead |
| `conn.reducers.foo(args)._then(...)` / `conn.reducers.onFoo(...)` | Not in 2.15.0: `await conn.reducers.foo(args)` and catch by `error.name` (see "Reducer calls and errors on the client") |
| `useTable` / `useReducer` / `useSpacetimeDB` in a page | The hooks in `web/src/stdb/` (A173); the SDK's hooks have no provider above a page |
| `.subscribeToAll()` | `.subscribeToAllTables()` — method name changed (and banned in `web/`) |
| `throw new Error('msg')` in reducers | `throw new SenderError('msg')` — surfaces message to the calling client |
| `(ctx.db.Table as any).primaryKey.find({...})` | Define a multi-column btree index and use `.filter([val1, val2])` — `.primaryKey` is undefined at runtime, causes PANIC |
| `ctx.db.Table.index.filter({col1, col2})` (object arg) | `.filter(scalar)` for single-col, `.filter([val1, val2])` for multi-col btree — object arg silently returns 0 rows |
| `ctx.db.Table.singleColIdx.filter([val1, val2])` (array on single-col) | `.filter(scalar)` — passing an array to a single-column btree index silently returns 0 rows |
| `ctx.db.Table.btreeIdx.find(val)` | `[...ctx.db.Table.btreeIdx.filter(val)]` — btree indexes only have `.filter()`, not `.find()` (TypeError) |
| `ctx.db.Table.pkCol.filter(val)` | `ctx.db.Table.pkCol.find(val)` — PK/unique columns only have `.find()`, not `.filter()` (TypeError) |
| `{ microsSinceUnixEpoch: BigInt }` in server insert/update | `new Timestamp(BigInt)` — plain objects lack the internal `__timestamp_micros_since_unix_epoch__` property, causing PANIC |
| `null` / `undefined` for optional struct fields | Use sentinel values (e.g. `255` for u8, `new Timestamp(0n)` for timestamp) — optional inside `t.object()` can't serialize null/undefined |
| `conn.db.ViewMyProfile.iter()` (PascalCase view accessor) | On this repo's 2.15.0 bindings view handles are camelCase: `conn.db.viewMyProfile.iter()`; the snake_case `conn.db.view_my_profile` is a deprecated alias (it was the only form on 2.6.1). Views must be exported from the module for bindings to generate |
| `subscribe([...]).onApplied(() => read all tables)` | Combined array subscribe fires `onApplied` before all table data arrives — use separate subscriptions with individual `onApplied` callbacks per table |
| Bare `spacetimedb.clientConnected(...)` / `clientDisconnected(...)` / `init(...)` | `export const onConnect = spacetimedb.clientConnected(...)` — unexported hooks never register (silent) |
| `new Range(new Bound.Inclusive(a), new Bound.Inclusive(b))` | `new Range({ tag: 'included', value: a }, { tag: 'included', value: b })` — `Bound` is a type, not a class |
| `Math.random()` / `crypto.randomUUID()` in a reducer | IDs: `ctx.newUuidV4()` (deterministic, fine). Draws and shuffles: the fair draw in `shared/lobby-rules/timerDraw.ts` (`fairShuffle`, timer draw), **not** `ctx.random` — see the guardrail below |
| Treating `spacetimedb.reducer({ onSchedule: table }, ...)` / `.withAutomaticReconnect()` / `ctx.env.X` / `spacetimedb/server/test-utils` as nonexistent | Real APIs added after 2.6.1 (v2.7 / v2.12 / v2.12 / v2.12), all present in this repo's SDK 2.15.0; the repo uses `onSchedule` (two job tables), `ctx.env.STDB_TARGET` and test-utils. See api-guide § 12 |

**`ctx.random` guardrail (S10o review F1, A117, A120):** `ctx.random` is deterministic, but its host seed (the transaction timestamp through a sign-filled 32-bit value) skews the first outputs: one position of 80 came up 4.1% of the time against an ideal 1.25%. This repo does not draw with `ctx.random`. Fair draws and shuffles go through `shared/lobby-rules/timerDraw.ts`, a MurmurHash3 mix of the transaction timestamp and state values (lobby or tournament id, turn, a per-position counter). Bracket seeding, `shuffle_teams` RandomSwap and A36a team formation use `fairShuffle` too (A120); don't add new `ctx.random` draws.

## Feature implementation checklist

When implementing a feature that spans backend and client:

1. **Backend:** Define table(s) in `tables/<domain>/` (one file per table), then import in `schema.ts`
2. **Backend:** Define reducer(s) in `reducers/<domain>/`, then re-export in `index.ts`
3. **Backend:** In-memory module tests under `spacetimedb/src/__tests__/<subject>/` (only under an explicit test task, CLAUDE.md §6), `npm test`
4. **Backend:** Generate bindings — `npm run stdb:generate` (local `spacetime generate` into `web/src/module_bindings`, no database contact), then review `git diff --stat web/src/module_bindings`. Never hand-edit the bindings.
5. **Backend:** Publish module to test (`npm run stdb:publish:test`; prod only via the §C.5 checklist)
6. **Client:** Subscribe to the view(s) that serve the data (or the public reference set) with `useRouteSubscriptions`, per "The client layer" (CLAUDE.md §4)
7. **Client:** Read rows with `useRows`; call the reducer(s) with `useReducerCall` and handle refusals by error name and text
8. **Docs:** update `docs/<feature>/architecture.md` with every backend change (CLAUDE.md §7)

Step 5 is a user gate (CLAUDE.md §8, ROADMAP hard gates); generate and the web build work without it.

Common mistake: building backend tables/reducers but forgetting to wire up the client to call them.

## CLI commands

### Connecting to the database (env scheme, CLAUDE.md §5)

Two targets, one vocabulary, implemented by `shared/stdb-targets.ts`:
- Database names are committed constants: `STDB_DATABASES.test = hsr-spacetimedb-test1`, `.prod = hsr-spacetimedb-prod`. Never type them by hand in code or scripts; use `publishArgs` / `readArgs` (Node) or `resolveBrowserEnv` (web).
- Node-side target: `--target test|prod` on every `scripts/stdb/*.ts` call, or `STDB_TARGET` (the flag wins; neither → fail fast). Browser: `VITE_STDB_TARGET` (Vercel = `prod` only; `npm run dev` and `npm run preview` = `test`).
- Secrets, one file per target (`.env.test.local` / `.env.prod.local`; never read their values, key names only; nothing reads `.env.local`): `STDB_SERVER_TOKEN` (+ `STDB_SERVER_IDENTITY`), the Admin-level delegate for the scripts, rotated by every bootstrap; `STDB_LINK_TOKEN` (+ `STDB_LINK_IDENTITY`), the login function's Linker, kept across bootstrap runs.
- **Every CLI call names the database and passes `--server maincloud --no-config`.** `spacetime.json` keeps `hsr-spacetimedb-test1` only as the safe interactive default; `call` / `describe` / `subscribe` refuse a database that is not the config's one without `--no-config` (see `references/spacetime-json.md`).
- Module env: `schema({...}, { env: { STDB_TARGET: t.enum('StdbTarget', ['test', 'prod']) } })`; `publish.ts` spawns the CLI with `STDB_TARGET=<target>` in the **process environment** (the CLI's `--env <name>` selects a `spacetime.<name>.json` file, it does not set a value). On SDK 2.14.1 and 2.15.0 + TS 7.1 beta `ctx.env.STDB_TARGET` is typed `string`, not the literal union.

```bash
npm run stdb:publish:test            # publish to test1 with --yes=remote --yes=break-clients (runs npm run typecheck first)
npm run stdb:publish:test:clear      # wipe test1: adds --delete-data=always --yes=delete-data (test only)
npm run stdb:publish:prod            # --yes=migrate only; refuses a dirty tree and any wipe flag
npm run stdb:bootstrap:test          # delegate token -> .env.test.local, linker kept (-- --rotate-linker mints a new one), seed data/seed/, GC jobs
npm run stdb:seed:test               # bootstrap's seed step alone, as the delegate
npm run stdb:describe:test           # describe <db> --server maincloud --no-config --json
npm run stdb:generate                # local bindings regeneration (no database, no target)
npm run stdb:manage-user -- --target prod set-role <username> Admin   # or: delete <username>
npm run stdb:guest-switch -- --target test lobbies on                 # guest accounts|lobbies on|off
npm run test:integration             # the live residue: wipes, publishes and bootstraps test1 first
# Every one is a maincloud contact (generate excepted): a user gate (CLAUDE.md §8). The live suite runs on test1
# only, once per release, on the user's word. Append -- --dry-run to print the exact command without running it.
```

### Common commands

Prefer the `stdb:*` scripts; a raw call must carry the explicit database name and `--server maincloud --no-config`.
```bash
spacetime logs <name> --server maincloud --no-config                 # View logs
spacetime sql <name> "SELECT * FROM table_name" --server maincloud --no-config
spacetime call <name> <reducer_name> [args...] --server maincloud --no-config  # CLI identity = the Owner
```

**v2.5.0 CLI changes:** `spacetime publish --delete-data` no longer forces a positional db name — it falls back to the name in `spacetime.json` if omitted. `spacetime call` now accepts **hex strings for `Identity` params** (e.g. `spacetime call <name> <reducer> <hex-identity>`) — no more manual byte-array construction for identity args.

**CLI is 2.15.0** (`spacetime --version` → `spacetimedb tool version 2.15.0`, commit `07efb0c`; 2.14.1 stays installed). The `--help` of `publish`, `generate`, `describe`, `login show`, `sql`, `logs` and `build` is identical to 2.14.1. Commands added after 2.6.1, all present in this CLI's `--help`: `spacetime sql --format`, `spacetime lock` / `unlock` (v2.7.0, guards against accidental `delete`), `spacetime mcp` (v2.8.1), human-readable `spacetime describe` (v2.11.0), `spacetime env` + `publish --env-only/--unset-env/--replace-env` (v2.12.0), `spacetime auth` for SpacetimeAuth management (v2.13.0), `generate --import-extension` (v2.14.0). From v2.11.0 failed publishes print the full error chain, and from v2.12.0 local schema-validation errors are spelled out. (History: the 2.6.1 CLI gave terse failures.)

**SQL parser — no constant projections (verified live on 2.6.1, 2026-07-04; not re-verified on 2.14.1):** the `spacetime sql` parser rejects literal/constant SELECT projections — `SELECT 1 AS ok` fails with `Error: Unsupported projection expression: 1` (HTTP 400). A connectivity smoke-test must project a real column from a real table, e.g. `spacetime sql <name> "SELECT COUNT(*) AS n FROM hsr_character"` (a public table; `user` is private, A77), not `SELECT 1`. (Behavior change in the 2.3–2.6 line; caught during the old repo's 2.6 upgrade.)

### Publishing: `--yes=migrate` only for reviewed schema deltas

`npm run stdb:publish:test` keeps the destructive-migration confirm dialog (a safety feature, not friction); it pre-answers only `--yes=remote` and `--yes=break-clients` (A178: a test publish may disconnect connected clients). `npm run stdb:publish:prod` always passes `--yes=migrate` (v2.2.0+, PR #4885) and nothing else, so it runs only after the §C.5 schema-delta gate (`stdb:describe:prod` vs `stdb:describe:test`).

The `--yes=migrate` value must attach with `=` (per `spacetime publish --help`). Other `--yes` values (`break-clients`, `delete-data`, `remote`, `skip-login`) are never passed for prod; `assertNoForbiddenProdFlags` refuses them.

Related v2.2.0 informational notes:
- `.withCompression('brotli')` exists on `DbConnection.builder()` as an alternative to gzip; project has not adopted it (browser-support floor too high for current users; realistic ratio gain on BSATN binary frames is 5-15% — not worth the failure mode on older browsers).
- v2.2.0 also allows dropping empty tables during auto-migration (PR #4593) — relevant when refactoring schemas; no project-side action needed.

Reference: `scripts/stdb/publish.ts`, `publishArgs` in `shared/stdb-targets.ts`; `docs/smoke/contract.md` operational note.

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
tables/<domain>/       -> One file per table (e.g. identity/user.ts, lobby/lobby.ts, roster/hsrCharacter.ts)
  └── Each exports column definitions + table() call
reducers/<domain>/     -> Reducer files of that feature (e.g. identity/auth.ts, admin/admin.ts, roster/rosterAdmin.ts)
  └── Each imports spacetimedb from '@module/schema'
helpers/<domain>/      -> Shared utilities (identity/ensurePermissions.ts, admin/auditColumns.ts, roster/rosterHelpers.ts)
views/                 -> Flat, one file per area (e.g. identityViews.ts, lobbyViews.ts, loadoutViews.ts); views limiting client data access
types/                 -> Flat
  ├── enums.ts         -> All enum definitions (Path, Element, CharRole, GameMode, etc.)
  └── structs.ts       -> All struct/object type definitions (EidolonCost, LobbyConfig, etc.)
__tests__/<subject>/   -> In-memory module tests (lobby, identity, roster, tournaments, views, ...), shared builders in __tests__/fixtures/, harness/smoke; config spacetimedb/vitest.config.mts
```

### Around the module (repo root)
```
shared/                -> Pure TS used by module and web: stdb-targets.ts, auth-flow.ts, scoring/, bracket/, lobby-rules/, teambuilder/, loadouts/ (barrels; no runtime import of spacetimedb or react)
scripts/stdb/          -> publish, bootstrap, seed, describe, generate, manage-user, guest-switch, test-integration (+ _args/_connection/_delegate/_env/_seed/_spawn helpers); all target-bound ones take --target test|prod
api/                   -> the login function: auth/discord/{start,callback}.ts route shells, logic in _lib/ (calls the module over HTTP)
web/src/module_bindings/ -> Generated client bindings, the one committed copy (never hand-edit; npm run stdb:generate)
test/                  -> Unit tests (backend/**/*.unit.test.ts), live residue (live/, test1 only), harness (shared/), data-templates/; see test/README.md
data/seed/             -> Public reference data that bootstrap/seed load
docs/                  -> docs/<feature>/{architecture,contract}.md, ERD.md, frontend/, log/<date>-<step>.md
```

**Tests (CLAUDE.md §6):** `npm test` runs unit, in-memory module and web tests and never touches the network; the in-memory module tests are the default verification layer (they do not simulate subscriptions, lifecycle hooks or the scheduler, and `ctx.env` reads throw there). The live residue (`test/live/`, through `npm run test:integration`) runs on test1 only, once per release, on the user's word. Test files change only under an explicit test task.

**Domain folders (A72):** `tables/`, `reducers/` and `helpers/` share the same nine `<domain>` folders, mirroring `docs/<feature>/`: `identity`, `lobby`, `draft`, `results`, `tournament`, `stats`, `roster`, `calendar`, `admin`. `views/` and `types/` stay flat; `index.ts` and `schema.ts` stay at the root.

**Imports (A72):** every cross-folder import inside `spacetimedb/src` (module files and `src/__tests__/`) uses the `@module` alias, never `../`:
```typescript
import spacetimedb from '@module/schema';
import { Path } from '@module/types/enums';
import { User } from '@module/tables/identity/user';
import { ensureAdmin } from '@module/helpers/identity/ensurePermissions';
import { view_my_lobbies } from '@module/views/lobbyViews';
import * as moduleExports from '@module/index';   // tests / fixtures
```
Same-folder imports may stay `./x` (e.g. `index.ts` imports `./schema`). Code outside the module (`test/`, `scripts/`) keeps relative or `@shared` imports. The CLI bundler (Rolldown) matches a tsconfig `paths` wildcard against **one path segment only**, so `@module/*` cannot be a single entry: the alias is declared **per folder** in `tsconfig.base.json` (`"@module/<kind>/<domain>/*": ["./spacetimedb/src/<kind>/<domain>/*"]`, plus `@module/views/*`, `@module/types/*`, `@module/index`, `@module/schema`) and mirrored relative to `test/` in `test/tsconfig.json`; each vitest config has a single `'@module'` alias. **A new domain folder needs its entries in both tsconfigs**: a missing entry fails `npm run typecheck` and `spacetime build` (UNRESOLVED_IMPORT); vitest alone would not notice.

### Frontend (`web/`, Vite + React 18 + TanStack Router)
```
web/src/module_bindings/ -> Generated client bindings (imported as @bindings/...; never hand-edit)
web/src/stdb/            -> The database layer: LazyStdbProvider, StdbProvider, MaintenanceGate, connection, layer0,
                            referenceSet, useStdbConnection, useRouteSubscriptions, useRows, useReducerCall, cost queries
web/src/routes/          -> TanStack Router file routes (guards: _authed, _admin)
web/src/pages/<page>/    -> One folder per ported page (costs, teambuilder, sign-in, splash pages)
web/src/shell/           -> App shell (bar, account area, reconnecting banner, phone menu)
web/src/auth/            -> Auth store fed by view_my_profile; sign-in helpers
web/src/dev/             -> Dev-only tools: the egress meter (wireStats.ts), loaded behind import.meta.env.DEV
web/src/components/, lib/, styles/ -> Shared controls, utilities, tokens.css
```
Pages are ported one by one (`ROADMAP.md` S14.x); don't assume the old repo's `app/` or `components/features/` tree. Styling: CSS Modules + `web/src/styles/tokens.css`, no Tailwind (CLAUDE.md §4).

### Key conventions
- **New tables** go in `spacetimedb/src/tables/<domain>/` as individual files, then import in `schema.ts`
- **New reducers** go in `spacetimedb/src/reducers/<domain>/`, then import in `index.ts`
- **New helpers** go in `spacetimedb/src/helpers/<domain>/`
- A new file goes into the folder of the feature whose contract describes it; a **new domain** gets a folder in `tables/`, `reducers/` and `helpers/` plus its `@module` entries in `tsconfig.base.json` and `test/tsconfig.json`
- **New enums/structs** go in `spacetimedb/src/types/enums.ts` or `structs.ts`
- **New views** go in `spacetimedb/src/views/`, then import in `index.ts`
- **New pure logic shared by module and web** goes in `shared/<area>/`, exported through the folder's barrel `index.ts` (nested `@shared` paths do not bundle, ROADMAP S7/S8)
- **New frontend database code** goes through `web/src/stdb/` (a page's queries live with the page, e.g. `LOADOUTS_QUERY` in `pages/teambuilder/useLoadouts.ts`); follow CLAUDE.md §4
- **Scheduled tables**: two bind with `spacetimedb.reducer({ onSchedule: Table }, ...)` (`refereeTransferCheck`, `tournamentFinalizeJob`), three older ones with the `export let` setter (see "TypeScript patterns"); either way the reducer calls `ensureScheduler` first
- **Private tables** (e.g. `LobbyPassword`) use `public: false` to keep sensitive data off the wire — see pattern below

## Naming conventions (this repo — ENFORCED)

| Layer | Convention | Examples |
|-------|-----------|----------|
| Table columns | `camelCase` | `hostUserId`, `avatarCharacterName`, `createdById` |
| Struct/object fields | `camelCase` | `teamSize`, `characterName`, `isPaused` |
| Enum variants | `PascalCase` | `MemoryOfChaos`, `BlueWins`, `TournamentHost` |
| Reducer export names | `snake_case` | `login_as_guest`, `linker_present_code` |
| Index accessors (code-facing) | `snake_case` | `host_user_id`, `discord_id`, `user_id` |
| Table names (in `table()`) | `snake_case` | `'user'`, `'hsr_character'`, `'lobby_member'` |
| Helper functions | `camelCase` | `getAuthenticatedUser`, `ensureAdmin`, `auditInsert` |
| Constants | `UPPER_SNAKE_CASE` | `SYSTEM_USER_ID`, `ABUSE_CONFIG_ID` |

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
- **event tables** (`event: true`, e.g. `LobbyCursorEvent`, which carries lobby id, seat, x, y, timestamp). Their rows are delivered once and never persist, so audit columns are pure per-event egress (A19).
- **scheduled job tables** `IdentityGcJob`, `LobbyGcJob`, `RefereeTransferCheck`, `TournamentFinalizeJob` (`UserDeletionJob` carries them).

```typescript
createdById: t.u32(),
createdDate: t.timestamp(),
lastModifiedById: t.u32(),
lastModifiedDate: t.timestamp(),
```

**Rules:**
- Each table defines its own audit columns inline — do NOT import/spread a shared object. SpacetimeDB's `table()` resolves column types at call time, so if tables share a column definition object, a change to that object silently alters every table that uses it — causing unintended schema migrations or `--clear-database` requirements.
- Inserting: `ctx.db.X.insert(insertWithAudit(ctx, row, userId))`; updating: `ctx.db.X.id.update(updateWithAudit(ctx, existing, { ...changes }, userId))`, which keeps the original `createdById`/`createdDate` (both in `helpers/admin/auditHelpers.ts`, the common form). The primitives `auditInsert(ctx, userId)` / `auditUpdate(ctx, existingRow, userId)` (`helpers/admin/auditColumns.ts`) return the four fields alone, for sites that build the full row themselves
- `SYSTEM_USER_ID = 0` is the audit sentinel for bootstrap operations (e.g. `init` creating the SYSTEM user) and scheduled reducers; it is NOT the SYSTEM row's id (User.id is autoInc; find the row by `username = 'SYSTEM'`)
- The SYSTEM user (role = Admin) is created by `init` as the first user; the Owner and every Delegate server identity are linked to it through `UserIdentity`
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

*Upstream note (not a rule change):* the official Clockwork `typescript-server` skill now recommends `type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>` for helpers and warns that `any` erases row types and can let `bigint` math infer as `number`. Both `ReducerCtx` and `InferSchema` are exported from `spacetimedb/server` (since 2.6.1; still in 2.15.0), and a type-only import of `typeof spacetimedb` adds no runtime cycle. Switching is planned as its own step after the page ports (`ROADMAP.md` S15). Keep `ctx: any` until then.

**`as any` on enum values** — When constructing enum values from runtime strings (e.g. `{ tag: roleTag, value: {} } as any`), the `as any` cast is necessary because TypeScript can't narrow a `string` variable to the specific literal union the enum type expects. This is expected.

**`export let` for scheduled table reducers** — The `tables/identity/userDeletionJob.ts` pattern (`export let _runUserDeletionReducer: any` + setter function; same in `identityGcJob.ts` and `lobby/lobbyGcJob.ts`) is the older way to avoid circular dependencies between scheduled tables and their reducers. Do not refactor it as a drive-by. The reducer-side `spacetimedb.reducer({ onSchedule: table }, params, fn)` option (v2.7.0+, PR #5435) removes the cycle at its source; the SDK 2.15.0 types mark the table-side `scheduled` option `@deprecated` in its favor, and `refereeTransferCheck` / `tournamentFinalizeJob` already use it. See api-guide § 5.

## User table special fields

- Presence is **not** on `User`: `isOnline` / `lastLoginAt` / `lastSeenAt` live on the private `UserPresence` table (one row per identity, A48), written by `client_connected` / `client_disconnected`; a user is online when any of their rows is. `LobbyMember.isOnline` follows the user.
- `deletedAt: t.timestamp().optional()` — soft-delete pattern; an admin deletion or a ban sets it and the scheduled `run_user_deletion` hard-deletes after 5 s (`delete_my_account` and `server_delete_user` delete at once).
- `User` is `public: false` (A77) and holds the provider link (`loginMethod`, `providerId`, `providerUsername`, `linkedAt`); whether an account is Discord-linked is derived in the views. The user reads their own row through `view_my_profile`, staff through `view_admin_users`. Read the current `tables/identity/user.ts` before relying on its columns.

## Private tables — keeping sensitive data off the wire

When a table has columns that should never reach the client (passwords, tokens, secrets), extract those columns into a separate `public: false` table linked by FK. This project uses `LobbyPassword` as the canonical example:

```typescript
// lobbyPassword.ts — private table, never broadcast to clients
export const LobbyPassword = table({
  name: 'lobby_password',
  public: false, // the default, but explicit is better
}, {
  lobbyId: t.u32().primaryKey(),  // FK to Lobby.id, 1:1; the PK is already indexed (.find())
  passwordHash: t.string(),
  // audit columns...
});
```

Reducers can still read/write private tables — only client subscriptions are blocked.

**Bindings for private tables:** `spacetime generate` always includes type definitions for private tables (so views can reference them in return types). It does NOT generate subscription/query code for private tables by default. To include subscription code (for admin tools or testing), add `--include-private`:
```bash
spacetime generate --lang typescript --out-dir web/src/module_bindings --module-path spacetimedb --include-private
```
This repo's `npm run stdb:generate` (`scripts/stdb/generate.ts`) does **not** pass `--include-private`: the committed bindings carry subscription code for public tables and views only, and private data reaches clients through views.

**Own-rows views:** user-scoped data sits in a private table and reaches its owner through a per-caller view with no arguments: resolve `ctx.sender` through `UserIdentity`, then read by index only (e.g. `view_my_loadouts` over the private `user_loadout`: `UserLoadout.user_id.filter(userId)`, a guest gets `[]`). Project only what the page needs (no `id`, `userId` or audit columns on the wire), and list the view in `test/live/outsider-isolation.test.ts`'s per-sender checks.

## Optimistic concurrency: a version column

For data one person edits from several devices or tabs, the database decides which copy is current, not the page (A198; `docs/loadout/architecture.md`):
- The row carries `rev: u32`, raised by one on every save that writes; the view sends it.
- A save states the version it is based on (`save_loadout(slot, baseRev, ...)`; `baseRev` 0 = create). The reducer refuses a stale base with one exact sentence per case (slot taken, deleted elsewhere, changed elsewhere), checked before the content checks; an unchanged save writes nothing.
- A slot reused after a delete must not match an old base: new rows start above a per-account floor that only grows (`UserLoadoutRate.revFloor`), and the row keeps its first version (`firstRev`); a base below it means "deleted".
- The client keeps the draft, waits for `fresh` subscriptions before writing, and resolves a refusal by the module's text (`shared/loadouts/sync.ts`). Deletes take `baseRev` too.

## Rate limits: private per-user rows

A per-user limit is a private table keyed by `userId` (one primary-key read and one write per accepted call), never a column clients can see. `UserRateState` holds the fixed windows for chat, lobby creation, membership, result entry and tournament actions (`consume*Allowance` in `helpers/lobby/abuseControls.ts`, thresholds in the `AbuseConfig` singleton); `UserLoadoutRate` holds the loadout save window (6 per 60 s, constants in `helpers/roster/loadoutRules.ts`); `LobbyCursorStamp` holds the cursor throttle stamp. A refused call rolls back and writes nothing; `save_loadout` puts its limit check last, so a save refused for another reason counts nothing. Before adding one, estimate a scripted account at the limit against the energy budget (the loadout doc's "Abuse estimate" is the model).

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

See `reducers/roster/rosterAdmin.ts` for the full example (9 admin proxy reducers mirroring `roster.ts`).

## Foreign keys

SpacetimeDB does NOT support FK constraints. Referential integrity must be enforced in reducer code. This is by design — SpacetimeDB's distributed architecture prioritizes write throughput over relational constraints. Check for the existence of referenced rows in reducers before inserting, and cascade-delete related rows manually when removing parents.

## Energy budget & bandwidth rules (ENFORCED)

This project runs on SpacetimeDB maincloud with a **100,000 energy/month budget**: Free tier with a permanent referral bonus, a hard cap with no pay-as-you-go (CLAUDE.md §2, A16, A41; `tools/energy-model.js` `MONTHLY_BUDGET: 100000`). "Energy" here is maincloud's TeV: the 200-per-GB egress rate below matches the pricing page. Egress is the dominant cost driver (~99% of energy in growth scenarios). Every table and reducer decision must consider bandwidth impact.

**Energy rates:**
- 1M reducer calls = 840 energy
- 10GB egress = 2,000 energy
- 1GB storage = 2,592 energy

**The #1 cost driver is initial subscription load** — every user connection downloads all subscribed public table data. At scale, this dwarfs real-time broadcasts.

### Subscription strategy (MUST follow)

- **Never subscribe to all tables** (`subscribeToAllTables` is banned in `web/`). Clients subscribe to **views and the public reference set** only (CLAUDE.md §4); see "The client layer" above. Every subscription is a bandwidth decision.
- **Match history is paginated and on-demand** — the history tables (`match_session_history`, `match_session_step_history`, …) are private; pages read them through `view_my_match_history(page, filters)`, `view_my_match_history_count` and the per-match detail views (A115), one argument set at a time.
- **Reference set** (characters, light cones, archetypes and their links, published cost sets, and on request the default cost set's three cost tables: `docs/frontend/subscriptions.md` Decision 1; a cold visit to `/costs` measured about 41 kB on the wire): small, rarely updated; mounted on first need and kept for the session.
- **Tournament data**: through the tournament views with arguments (`view_tournament_*(id)`), only for the tournament being viewed.
- **Lobby and match data** (lobby, members, match session, chat): through the per-viewer `view_my_*` views, only while in a lobby; match views and cursor events only past the Waiting stage.

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
- **A per-identity rate limit.** Store the last-accepted time per user and drop calls that come too fast. A manual throttle works on any version. **(v2.13+)** the reusable `@spacetimedb/rate-limit` submodule is an option; it is a separate package, not installed in this repo.
- **Input bounds:** clamp or reject out-of-range values and cap payload sizes.
- **Membership and state checks** before inserting.

Example: `broadcast_cursor` (`reducers/lobby/cursor.ts`) has all three: membership and seat checks (spectators and away members are dropped silently), live stages only, x/y outside [0, 1] dropped, and a per-member throttle read from `AbuseConfig.cursorMinIntervalMs` (20 Hz) against the private `LobbyCursorStamp` row, which no view reads (so an accepted cursor rewrites no subscribed row). Put tunable thresholds (cursor Hz, spam limits) in a config singleton row the reducers read, like `AbuseConfig` (`helpers/lobby/abuseControls.ts`) or `elo_config`, so they change without a redeploy; adding a column to a live singleton is a shape change, so a new limit may use constants instead (see "Rate limits"). `AbuseConfig` is seeded idempotently by `init`, which only runs on first publish or a wipe; `scripts/stdb/bootstrap.ts` is the other place to seed.

### Measuring egress in the app (dev-only)

This repo's dev egress meter is `web/src/dev/wireStats.ts` (`npm run dev` only: `window.__wireStats()` and a panel; loaded by dynamic import behind `import.meta.env.DEV`, and `check:patterns` gate 3 keeps it out of `web/dist`). Page PRs report its numbers (CLAUDE.md §2); `tools/capture-ws-frames.ts` also exists. How it works:
- **Bytes on the wire:** wrap `globalThis.WebSocket` **before** the connection is built, and count message bytes to the SpacetimeDB host. These are mostly compressed bytes; handshake, frame headers and TLS are not counted, so treat them as a lower bound of the bill.
- **Cache size per table:** serialize each cached row with `AlgebraicType.makeSerializer(Row.algebraicType)` into a `BinaryWriter` and read `.offset`.

Both APIs exist on 2.15.0 (`dist/index.d.ts`, `lib/algebraic_type.d.ts`, `lib/binary_writer.d.ts`).

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

The skill references are synced to **SpacetimeDB v2.14.1** (released 2026-11-04). Upstream docs are pinned at tag commit `a0bf6be10a146b03acbe3f4f9ad7fe20f114988d`, and the official agent skills at master `17a3f3a649a3ad55e1520353a53ec5de8ea97b0a`. **The project's SDK and CLI are 2.15.0** (`spacetimedb/package.json` `spacetimedb: 2.15.0`, `node_modules/spacetimedb` 2.15.0, `spacetime --version` 2.15.0; the 2.6.1 baseline is history). The upstream docs pin stays at v2.14.1 until the next docs sync. Inline `(v2.X+ …)` tags record when an API arrived; every tag up to v2.15.0 is available here.

**2.15.0 for this repo (upgrade 2026-11-12):** module-side TypeScript is unchanged apart from `.ts` import extensions in the package (`moduleResolution: "nodenext"` fix; this repo uses `bundler`, so `generate --import-extension` stays unset); `isInternal`, views with arguments, `clear()` and the `spacetimedb/server/test-utils` API are unchanged, and the in-memory datastore wasm was rebuilt. Client side: the table cache builds map indexes, so `conn.db.X.idx.find/filter` no longer scans; codegen dropped the hand-written `DbView` alias type, and the `@deprecated` marks on the PascalCase/snake_case accessor aliases now reach `conn.db` itself. Use the camelCase accessors (`conn.db.archetype`, `conn.db.viewMyIdentity`). The host fix to `clear()` (count only newly deleted rows) does not change the TS module: its `clear()` returns the row count read before the clear. CLI: yes/no prompts take their default on EOF again, and a `--yes` that used to auto-accept a server-issued login now warns and asks. The opt-in module packages (Agents, Auth, Files, PostHog) are not adopted. Notes marked "on 2.6.1" describe the old baseline. Server-side behavior (migration rules, HTTP API, scheduler, MCP endpoint) follows maincloud's server version, so those notes may apply already. Last upstream audit: 2026-11-05, items SK-10..SK-29; last pass against the repo: 2026-11-17 (`docs/log/2026-11-17-skill-refresh.md`).

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

**Official plugin vs this skill:** `claude plugin install spacetimedb@spacetimedb-plugins` (marketplace `clockworklabs/SpacetimeDB`, shipped v2.8.2) bundles the generic skills plus a `spacetime mcp` server entry. That server needs CLI 2.8.1+; the active CLI here is 2.15.0, so it would run. Its skills target the latest SDK, use different conventions (camelCase index accessors, inline `.index('btree')`, typed `ctx`, the SDK's React hooks in pages). If both are loaded, **this skill wins** for anything project-specific or version-sensitive.
