<!-- Sources:
  - SpacetimeDB TypeScript SDK docs: https://spacetimedb.com/docs
  - SpacetimeDB v2.1.0 release: https://github.com/clockworklabs/SpacetimeDB/releases/tag/v2.1.0
  - Release notes v2.7.0-hotfix3 .. v2.14.1: https://github.com/clockworklabs/SpacetimeDB/releases
  - Core-concepts docs at v2.14.1 (a0bf6be10a146b03acbe3f4f9ad7fe20f114988d): docs/docs/00200-core-concepts/ (views, indexes, schedule-tables, reducer-context, environment-variables, automatic-migrations, clients/typescript-reference)
  - Official agent skills (Clockwork Labs, Apache-2.0) at master 17a3f3a649a3ad55e1520353a53ec5de8ea97b0a: skills/typescript-server/SKILL.md, skills/typescript-client/SKILL.md, skills/concepts/SKILL.md
  - 2.6.1-correctness of every "current" claim checked against the installed SDK: node_modules/spacetimedb@2.6.1 (dist/*.d.ts + dist/server/index.mjs)
-->

# SpacetimeDB Rules (All Languages)

## Table of Contents

| § | Section | Key content |
|---|---------|-------------|
| — | [Core Concepts](#core-concepts) | 5 fundamental rules |
| — | [Hallucinated APIs](#-hallucinated-apis--do-not-use) | Wrong imports, wrong methods, correct patterns |
| 1 | [Common Mistakes Table](#1-common-mistakes-table) | Server + client errors with fixes |
| 2 | [Table Definition](#2-table-definition-critical) | `table(OPTIONS, COLUMNS)`, column types, schema export, exported columns pattern |
| 3 | [Index Access](#3-index-access) | find vs filter, naming, multi-column indexes, ranged filtering |
| 4 | [Reducers](#4-reducers) | Definition syntax, update/delete patterns, lifecycle hooks (must be exported), `ctx` surface (random, uuid, connectionId) |
| 5 | [Scheduled Tables](#5-scheduled-tables) | Scheduled reducers, ScheduleAt, `onSchedule` (v2.7+), server-side scheduler changes |
| 6 | [Timestamps](#6-timestamps) | Server and client timestamp handling |
| 7 | [Data Visibility & Subscriptions](#7-data-visibility--subscriptions) | Public/private tables, views, query builder, subscription handles, semantics & cache guarantees |
| 8 | [React Integration](#8-react-integration) | Provider, useTable, useReducer, callbacks, event tables |
| 9 | [Procedures](#9-procedures) | HTTP/side effects, ctx.withTx(), timeouts |
| 10 | [Project Structure & Commands](#10-project-structure--commands) | Defers to SKILL.md (always in context) |
| 11 | [Hard Requirements](#11-hard-requirements) | 13 TypeScript-specific rules |
| 12 | [Post-2.6.1 features (version-gated)](#12-post-261-features-version-gated) | Env vars, views with args, submodules, async IDC, unit tests — **not usable until the SDK upgrade lands** |

> **Version tags:** Anything marked `(v2.X+ — project SDK is 2.6.1; don't use until the upgrade lands)` is post-2.6.1 and will not compile or behave as described on this repo's current SDK. Untagged content is valid on 2.6.1.

---

## Core Concepts

1. **Reducers are transactional** — they do not return data to callers
2. **Reducers must be deterministic** — no filesystem, network, timers, or *external* randomness (`Math.random`, `crypto`). Use the context's deterministic sources instead: `ctx.timestamp`, `ctx.random()` (seeded from `ctx.timestamp`), `ctx.newUuidV4()` / `ctx.newUuidV7()` — all present in 2.6.1 (see § 4 "Reducer context")
3. **Read data via tables/subscriptions** — not reducer return values
4. **Auto-increment IDs are not sequential** — gaps are normal, don't use for ordering
5. **`ctx.sender` is the authenticated principal** — never trust identity args

---

## Feature Implementation Checklist

See the checklist in SKILL.md (the canonical version). Summary: tables in `tables/` → reducers in `reducers/` → publish → generate → subscribe → call → render.

---

## Index System

SpacetimeDB automatically creates indexes for:
- Primary key columns
- Columns marked as unique

You can add explicit indexes on non-unique columns for query performance.

**Explicit index `name`s must be unique across your entire module (all tables)** — two tables declaring the same `name` → "name is used for multiple entities". Index **`accessor`s are scoped per table**: when `name` is omitted (this repo's convention) the engine derives a table-qualified canonical name, so the same accessor can repeat across tables (this repo reuses `user_id` in 11 tables).

**Schema ↔ Code coupling:**
- Your query code references indexes by name
- If you add/remove/rename an index in the schema, update all code that uses it
- Removing an index without updating queries causes runtime errors

---

## Commands, Deployment, Debugging

See SKILL.md for CLI commands, deployment rules, and debugging checklist — those are project-specific (this is a **maincloud-only** project, no local server).

## Editing Behavior

- Make the smallest change necessary
- Do NOT touch unrelated files, configs, or dependencies
- Do NOT invent new SpacetimeDB APIs — use only what exists in docs or this repo
- Do NOT add restrictions the prompt didn't ask for — if "users can do X", implement X for all users


# SpacetimeDB TypeScript SDK

## ⛔ HALLUCINATED APIs — DO NOT USE

**These APIs DO NOT EXIST. LLMs frequently hallucinate them.**

```typescript
// ❌ WRONG PACKAGE — does not exist
import { SpacetimeDBClient } from "@clockworklabs/spacetimedb-sdk";

// ❌ WRONG — these methods don't exist
SpacetimeDBClient.connect(...);
SpacetimeDBClient.call("reducer_name", [...]);
connection.call("reducer_name", [arg1, arg2]);

// ❌ WRONG — positional reducer arguments
conn.reducers.doSomething("value");  // WRONG!

// ❌ WRONG — static methods on generated types don't exist
User.filterByName('alice');
Message.findById(123n);
tables.user.filter(u => u.name === 'alice');  // No .filter() on tables object!
```

### ✅ CORRECT PATTERNS:

```typescript
// ✅ CORRECT IMPORTS
import { DbConnection, tables } from './module_bindings';  // Generated!
import { SpacetimeDBProvider, useTable } from 'spacetimedb/react';
import { Identity } from 'spacetimedb';  // NOT from 'spacetimedb/react' — it only exports the provider + hooks

// ✅ CORRECT REDUCER CALLS — object syntax, not positional!
conn.reducers.doSomething({ value: 'test' });
conn.reducers.updateItem({ itemId: 1n, newValue: 42 });

// ✅ CORRECT DATA ACCESS — useTable returns [rows, isReady]
const [items, isReady] = useTable(tables.item);
```

### ⛔ DO NOT:
- **Invent hooks** like `useItems()`, `useData()` — use `useTable(tables.tableName)`
- **Import from fake packages** — only `spacetimedb`, `spacetimedb/react`, `./module_bindings`

---

## 1) Common Mistakes Table

### Top 5 — check these first (reducers & views)

These cause the most wasted time in this project. If you're working with reducers or views (writing, debugging, reviewing, or modifying), scan these before anything else:

1. **`.filter({obj})` silently returns 0 rows** — use `.filter(scalar)` or `.filter([val1, val2])`, never an object arg
2. **`.find()` vs `.filter()` mismatch** — PK/unique columns only have `.find()`, btree indexes only have `.filter()`. Mixing them = TypeError
3. **`.iter()` in views** — causes severe performance issues (view re-evaluates on *any* row change). Always use index lookups in views
4. **Indexes in COLUMNS (2nd arg)** — must go in OPTIONS (1st arg), otherwise `"reading 'tag'"` error
5. **Partial update nulls out fields** — always spread the existing row: `{ ...existing, changedField: newValue }`

### Server-side errors

| Wrong | Right | Error |
|-------|-------|-------|
| Missing `package.json` | Create `package.json` | "could not detect language" |
| Missing `tsconfig.json` | Create `tsconfig.json` | "TsconfigNotFound" |
| Entrypoint not at `src/index.ts` | Use `src/index.ts` | Module won't bundle |
| `indexes` in COLUMNS (2nd arg) | `indexes` in OPTIONS (1st arg) | "reading 'tag'" error |
| Index without `algorithm` | `algorithm: 'btree'` | "reading 'tag'" error |
| Index without `accessor` | Include `accessor` matching `name` (required since 2.0.4) | Throws error |
| `t.bool()` returns `0`/`1` not `true`/`false` | Fixed in 2.0.4 — fast-path now returns proper booleans | Type mismatch (number vs boolean) |
| `filter({ ownerId })` | `filter(ownerId)` | "does not exist in type 'Range'" |
| `.filter()` on unique column | `.find()` on unique column | TypeError |
| `insert({ ...without id })` | `insert({ id: 0n, ... })` | "Property 'id' is missing" |
| `const id = table.insert(...)` | `const row = table.insert(...)` | `.insert()` returns ROW, not ID |
| `.unique()` + explicit index | Just use `.unique()` | "name is used for multiple entities" |
| Index on `.primaryKey()` column | Don't — already indexed | "name is used for multiple entities" |
| Same explicit index `name` in multiple tables | Omit `name` (accessor-only; repo convention) or make it unique | "name is used for multiple entities" |
| Bare `spacetimedb.clientConnected(fn)` / `clientDisconnected` / `init` call | `export const onConnect = spacetimedb.clientConnected(fn)` | **Silent** — hook never registers (no error, no lifecycle reducer in the schema) |
| Non-SpacetimeDB named export from the module entry (`index.ts`) | Keep helpers/constants unexported from the entry | "exporting something that is not a spacetime export" |
| `new Range(new Bound.Inclusive(a), ...)` | `new Range({ tag: 'included', value: a }, { tag: 'included', value: b })` | `Bound` is a type, not a value — TypeError |
| `Math.random()` / `crypto.getRandomValues()` in a reducer | `ctx.random()`, `ctx.random.integerInRange(min, max)`, `ctx.newUuidV4()` | Non-deterministic reducer |
| `.primaryKey()` / `.index()` chained on an object-form enum column (`t.enum('X', { A: t.unit(), ... })`) | Index the column via `indexes: [...]` in table OPTIONS (repo pattern) | TypeError on 2.6.1 (fixed v2.7.0, PR #4389) |
| `.indexName.filter()` after removing index | Use `.iter()` + manual filter | "Cannot read properties of undefined" |
| Import spacetimedb from index.ts | Import from schema.ts | "Cannot access before initialization" |
| Multi-column index `.filter(singleVal)` | `.filter([val1, val2])` — positional array matching columns order | PANIC on 2.6.1 (`serializeTerm is not a function`); one-column prefix scans work from v2.7.0 (PR #5428) |
| `.filter({col1, col2})` (object arg) | `.filter(scalar)` for single-col, `.filter([val1, val2])` for multi-col | Silently returns 0 rows (no error!) |
| `.filter([val1, val2])` on single-col btree | `.filter(scalar)` — only single-element arrays auto-coerce | Silently returns 0 rows (no error!) |
| `ctx.db.Table.btreeIdx.find(val)` | `[...ctx.db.Table.btreeIdx.filter(val)]` | TypeError — btree only has `.filter()` |
| `ctx.db.Table.pkCol.filter(val)` | `ctx.db.Table.pkCol.find(val)` | TypeError — PK/unique only has `.find()` |
| `(ctx.db.Table as any).primaryKey.find({...})` | Define multi-col btree index, then `.filter([val1, val2])` | `.primaryKey` is undefined at runtime — PANIC |
| `JSON.stringify({ id: row.id })` | Convert BigInt first: `{ id: row.id.toString() }` | "Do not know how to serialize a BigInt" |
| `ScheduleAt.Time(timestamp)` | `ScheduleAt.time(timestamp)` (lowercase) | "ScheduleAt.Time is not a function" |
| `{ microsSinceUnixEpoch: BigInt }` in insert/update | `new Timestamp(BigInt)` from `import { Timestamp } from 'spacetimedb'` | PANIC: "Cannot convert undefined to a BigInt" — SDK reads `__timestamp_micros_since_unix_epoch__` internally |
| `null`/`undefined` for optional struct fields | Use sentinel values (e.g. `255` for u8, `new Timestamp(0n)` for timestamp) | PANIC — optional fields inside `t.object()` can't serialize null/undefined |
| `ctx.db.foo.myIndexName.filter()` | Use exact name: `ctx.db.foo.my_index_name.filter()` | "Cannot read properties of undefined" |
| `.iter()` in views | Use index lookups | Severe performance issues (re-evaluates on any change) |
| `ctx.db` in procedures | `ctx.withTx(tx => tx.db...)` | Procedures need explicit transactions |
| `ctx.myTable` in procedure tx | `tx.db.myTable` | Wrong context variable |
| `.iter()` when index exists | Use `.find()` / `.filter()` on index | Unnecessary full table scan |
| `.subscribeToAll()` | `.subscribeToAllTables()` | Method does not exist |
| `snake_case` struct fields | Use `camelCase` for all struct fields | Convention mismatch with table columns |
| Shared audit column import | Define audit columns inline per table | Unwanted coupling between table files |
| Missing `auditInsert`/`auditUpdate` | Every insert/update must set audit fields | Missing audit trail |
| Double `ensureAdmin(ctx)` | Capture once: `const admin = ensureAdmin(ctx)` | Redundant permission check + DB lookup |
| Missing character validation in `update_avatar` | Check `ctx.db.HsrCharacter.name.find(name)` | Invalid avatar reference |
| Insert without `isOnline`/`isPrivate` | Include `isOnline: false, isPrivate: false` | Missing required User fields |

### Client-side errors

| Wrong | Right | Error |
|-------|-------|-------|
| `@spacetimedb/sdk` | `spacetimedb` | 404 / missing subpath |
| `conn.reducers.foo("val")` | `conn.reducers.foo({ param: "val" })` | Wrong reducer syntax |
| Inline `connectionBuilder` | `useMemo(() => ..., [])` | Reconnects every render |
| `const rows = useTable(table)` | `const [rows, isReady] = useTable(table)` | Tuple destructuring |
| Optimistic UI updates | Let subscriptions drive state | Desync issues |
| `<SpacetimeDBProvider builder={...}>` | `connectionBuilder={...}` | Wrong prop name |
| `onUpdate`/`onDelete` on event table | Only `onInsert` exists for event tables | No callback fires (rows never persist) |
| `rows.sort(...)` on `useTable` result | `[...rows].sort(...)` — rows are `readonly T[]` | Type error |
| `{row.id}` in JSX for a `u64`/`i64` column | `{String(row.id)}` or `{Number(row.id)}` | React can't render `bigint` |
| `import { Identity } from 'spacetimedb/react'` | `import { Identity } from 'spacetimedb'` | Not exported |

---

## 2) Table Definition (CRITICAL)

**`table()` takes TWO arguments: `table(OPTIONS, COLUMNS)`**

```typescript
import { schema, table, t } from 'spacetimedb/server';

// ❌ WRONG — indexes in COLUMNS causes "reading 'tag'" error
export const Task = table({ name: 'task' }, {
  id: t.u64().primaryKey().autoInc(),
  ownerId: t.identity(),
  indexes: [{ accessor: 'owner_id', algorithm: 'btree', columns: ['ownerId'] }]  // ❌ WRONG!
});

// ✅ RIGHT — indexes in OPTIONS (first argument)
export const Task = table({ 
  name: 'task',
  public: true,
  indexes: [{ accessor: 'owner_id', algorithm: 'btree', columns: ['ownerId'] }]
}, {
  id: t.u64().primaryKey().autoInc(),
  ownerId: t.identity(),
  title: t.string(),
  createdAt: t.timestamp(),
});
```

### Exported columns pattern — share column definitions across backend

Extract column definitions into a named object so other backend files (reducers, helpers, validators) can import the column shape without exposing data to all clients. This is useful when multiple tables share columns, or when you need type-safe access to column definitions in backend logic.

```typescript
// tables/hsr_character.ts
import { table, t } from 'spacetimedb/server';
import { Path, Element, CharRole } from '../types/enums';

// Export columns separately — other backend code can import this
export const hsrCharacterColumns = {
    name: t.string().primaryKey(),
    displayName: t.string(),
    aliases: t.array(t.string()),
    rarity: t.u8(),
    path: Path,
    element: Element,
    role: CharRole,
    imageUrl: t.string(),
};

// Pass the columns object as the 2nd arg to table()
export const HsrCharacter = table({
    name: 'hsr_character',
    public: true,
    indexes: [
        { accessor: 'by_path', algorithm: 'btree', columns: ['path'] },
        { accessor: 'by_element', algorithm: 'btree', columns: ['element'] },
        { accessor: 'by_role', algorithm: 'btree', columns: ['role'] },
    ]
}, hsrCharacterColumns);
```

Other backend files can then `import { hsrCharacterColumns } from '../tables/hsr_character'` to reference the column types for validation, building related tables, or type-safe helpers — all without making the data public to clients.

### Column types
```typescript
t.identity()           // User identity (primary key for per-user tables)
t.u64()                // Unsigned 64-bit integer (use for IDs)
t.string()             // Text
t.bool()               // Boolean
t.timestamp()          // Timestamp (use ctx.timestamp for current time)
t.scheduleAt()         // For scheduled tables only
t.array(t.string())    // Array of primitives (also works with t.u64(), t.object(), etc.)

// Product types (nested objects) — use t.object, NOT t.struct
const Point = t.object('Point', { x: t.i32(), y: t.i32() });

// Sum types (tagged unions) — use t.enum, NOT t.sum
const Shape = t.enum('Shape', { circle: t.i32(), rectangle: Point });
// Values use { tag: 'circle', value: 10 } or { tag: 'rectangle', value: { x: 1, y: 2 } }

// Row types (e.g. a procedural view's return row) — use t.row, which accepts column modifiers
const MyRow = t.row('MyRow', { id: t.u64().primaryKey(), name: t.string() });  // name arg optional
// t.object REQUIRES the name as 1st arg and is a plain product type (no .primaryKey() on its fields)

// Modifiers
t.string().optional()           // Nullable (same as t.option(t.string()))
t.u64().primaryKey()            // Primary key
t.u64().primaryKey().autoInc()  // Auto-increment primary key
t.u64().index('btree')          // Inline single-column index; accessor = column name. Exists in 2.6.1,
                                // but this repo's convention is explicit `indexes: [...]` with snake_case accessors

// Result type — values are { ok: T } | { err: E }. The TS builder/serializer shapes were inconsistent
// before v2.13.0 (PR #6148) — avoid t.result() on 2.6.1 (repo currently has none)
t.result(t.unit(), t.string())
```

> ⚠️ **BIGINT SYNTAX:** All `u64`, `i64`, and ID fields use JavaScript BigInt.
> - Literals: `0n`, `1n`, `100n` (NOT `0`, `1`, `100`)
> - Comparisons: `row.id === 5n` (NOT `row.id === 5`)
> - Arithmetic: `row.count + 1n` (NOT `row.count + 1`)

### Auto-increment placeholder
```typescript
// ✅ MUST provide 0n placeholder for auto-inc fields
ctx.db.task.insert({ id: 0n, ownerId: ctx.sender, title: 'New', createdAt: ctx.timestamp });
```

### Insert returns ROW, not ID
```typescript
// ❌ WRONG
const id = ctx.db.task.insert({ ... });

// ✅ RIGHT
const row = ctx.db.task.insert({ ... });
const newId = row.id;  // Extract .id from returned row
```

### Schema export (CRITICAL)
```typescript
// At end of schema.ts — schema() takes exactly ONE argument: an object
const spacetimedb = schema({ table1, table2, table3 });
export default spacetimedb;

// ❌ WRONG — never pass tables directly or as multiple args
schema(myTable);      // WRONG!
schema(t1, t2, t3);   // WRONG!
```

---

## 3) Index Access

### TypeScript Query Patterns

```typescript
// 1. PRIMARY KEY — use .pkColumn.find()
const user = ctx.db.user.identity.find(ctx.sender);
const msg = ctx.db.message.id.find(messageId);

// 2. EXPLICIT INDEX — use .indexName.filter(value)
const msgs = [...ctx.db.message.message_room_id.filter(roomId)];

// 3. NO INDEX — use .iter() + manual filter
for (const m of ctx.db.roomMember.iter()) {
  if (m.roomId === roomId) { /* ... */ }
}
```

### Index Definition Syntax

```typescript
// In table OPTIONS (first argument), not columns
export const Message = table({ 
  name: 'message',
  public: true,
  indexes: [{ accessor: 'room_id', algorithm: 'btree', columns: ['roomId'] }]
}, {
  id: t.u64().primaryKey().autoInc(),
  roomId: t.u64(),
  // ...
});
```

### Naming conventions

**Table accessors (server) — the `schema({...})` key, verbatim:**
- `table({ name: 'lobby_member' }, ...)` sets the canonical SQL name only
- `schema({ LobbyMember, ... })` → `ctx.db.LobbyMember` (this repo uses PascalCase keys: `ctx.db.User`, `ctx.db.UserIdentity`)
- The accessor is NOT derived from `name` — `table({ name: 'my_messages' })` does not create `ctx.db.myMessages` unless the schema key is `myMessages`

**Index accessors — NO transformation, use EXACTLY as defined:**
```typescript
// Schema definition (table registered as schema({ canvasMember }))
indexes: [{ accessor: 'canvas_id', algorithm: 'btree', columns: ['canvasId'] }]

// ❌ WRONG — don't assume camelCase or a table prefix
ctx.db.canvasMember.canvasId.filter(...)                // WRONG!
ctx.db.canvasMember.canvas_member_canvas_id.filter(...) // WRONG!

// ✅ RIGHT — the accessor string as declared
ctx.db.canvasMember.canvas_id.filter(...)
```

> ⚠️ **Index accessors are used VERBATIM** — this project uses `snake_case` for all accessors (e.g. `owner_id`, `lobby_id`).

**Index convention — `accessor` only, `name` is auto-generated by SpacetimeDB:**
```typescript
// ✅ GOOD — accessor only, short and descriptive, scoped per-table
indexes: [{ accessor: 'room_id', algorithm: 'btree', columns: ['roomId'] }]
indexes: [{ accessor: 'message_id', algorithm: 'btree', columns: ['messageId'] }]

// ❌ BAD — don't include name (it's auto-generated)
indexes: [{ name: 'message_room_id_idx_btree', accessor: 'room_id', ... }]
```

**Client-side table names:**
- Check generated `module_bindings/index.ts` (`tablesSchema` keys) for exact handle names
- **2.6.1 (current):** handles are the server accessor verbatim — tables PascalCase (`conn.db.User`, `tables.HsrCharacter`), views snake_case (`conn.db.view_my_profile`)
- **v2.7.0+ (PR #5286 — project SDK is 2.6.1; don't use until the upgrade lands):** codegen camelCases handles (`conn.db.user`, `tables.hsrCharacter`, `conn.db.viewMyProfile`) and keeps the old spellings as **deprecated aliases**, so existing call sites keep compiling. Code that enumerates `conn.db` / `tables` (`Object.keys`, `for...in`) will see both names. Canonical SQL names (`'view_my_profile'`) are unchanged.

### Filter vs Find
```typescript
// Filter takes VALUE directly, not object — returns iterator
const rows = [...ctx.db.task.owner_id.filter(ownerId)];

// Unique columns use .find() — returns single row or undefined
const row = ctx.db.player.identity.find(ctx.sender);
```

### Multi-column indexes
Multi-column btree indexes work in SpacetimeDB 2.0+. Pass a **positional array** to `.filter()` — values map to the `columns` array order.

```typescript
// Define a multi-column index — values in .filter() map to columns order
export const TournamentParticipant = table({
  name: 'tournament_participant',
  public: true,
  indexes: [
    { accessor: 'by_tournament_and_user', algorithm: 'btree', columns: ['tournamentId', 'userId'] },
  ]
}, {
  tournamentId: t.u32(),
  userId: t.u32(),
  // ...
});

// ✅ Positional array — maps [val1, val2] to [tournamentId, userId]
const participant = [...ctx.db.TournamentParticipant.by_tournament_and_user.filter([tid, uid])][0];

// ❌ Object arg — silently returns 0 rows (no error!)
ctx.db.TournamentParticipant.by_tournament_and_user.filter({ tournamentId: tid, userId: uid }); // WRONG

// ❌ Single value on multi-column index — PANIC on 2.6.1 ("serializeTerm is not a function")
ctx.db.TournamentParticipant.by_tournament_and_user.filter(tid); // WRONG on 2.6.1
// v2.7.0+ (PR #5428 — project SDK is 2.6.1; don't use until the upgrade lands): a bare leading value
// is a valid one-column PREFIX scan — returns all rows for `tid`. Composite range scans
// (prefix + trailing Range) were also broken until v2.8.0 (PR #5479).

// ❌ DON'T iterate entire table and manually check — O(n) full scan
for (const other of ctx.db.character_position.iter()) {
  if (other.x === x && other.z === z) { /* ... */ } // Slow!
}
```

### Ranged index filtering (since 2.0.5)
`Range` (a class) is exported from `spacetimedb/server`. `Bound` is a **type only** — bounds are plain tagged objects. There is no `Bound.Inclusive(...)` constructor (verified in the 2.6.1 `dist/server/range.d.ts`):

```typescript
import { Range } from 'spacetimedb/server';

// Range filter on a single-column btree index — find scores between 100 and 500
const rows = [...ctx.db.leaderboard.by_score.filter(
  new Range({ tag: 'included', value: 100 }, { tag: 'included', value: 500 })
)];

// Other bound shapes: { tag: 'excluded', value: x } and { tag: 'unbounded' }
const atLeast18 = new Range({ tag: 'included', value: 18 }, { tag: 'unbounded' });
```

Single-column ranges are safe on 2.6.1. Avoid prefix-plus-Range on **multi-column** indexes until v2.8.0 (see above).

---

## 4) Reducers

### Definition syntax (CRITICAL)
**Reducer name comes from the export — NOT from a string argument.** Use `reducer(params, fn)` or `reducer(fn)`.

```typescript
import spacetimedb from './schema';
import { t, SenderError } from 'spacetimedb/server';

// ✅ CORRECT — export const name = spacetimedb.reducer(params, fn)
export const reducer_name = spacetimedb.reducer({ param1: t.string(), param2: t.u64() }, (ctx, { param1, param2 }) => {
  // Validation
  if (!param1) throw new SenderError('param1 required');
  
  // Access tables via ctx.db — use the PK column name, not ".primaryKey"
  const row = ctx.db.myTable.id.find(param2);

  // Mutations
  ctx.db.myTable.insert({ id: 0n, ... });
  ctx.db.myTable.id.update({ ...row, newField: value });
  ctx.db.myTable.id.delete(param2);
});

// No params: export const init = spacetimedb.reducer((ctx) => { ... });
```

```typescript
// ❌ WRONG — reducer('name', params, fn) does NOT exist
spacetimedb.reducer('reducer_name', { param1: t.string() }, (ctx, { param1 }) => { ... });
```

### Update pattern (CRITICAL)
```typescript
// ✅ CORRECT — spread existing row, override specific fields
const existing = ctx.db.task.id.find(taskId);
if (!existing) throw new SenderError('Task not found');
ctx.db.task.id.update({ ...existing, title: newTitle, updatedAt: ctx.timestamp });

// ❌ WRONG — partial update nulls out other fields!
ctx.db.task.id.update({ id: taskId, title: newTitle });
```

### Delete pattern
```typescript
// Delete by primary key VALUE (not row object)
ctx.db.task.id.delete(taskId);          // taskId is the u64 value
ctx.db.player.identity.delete(ctx.sender);  // delete by identity
```

### Lifecycle hooks — MUST be exported
`init`, `clientConnected`, and `clientDisconnected` return a module export, exactly like `reducer()` and `view()`. The runtime registers them only while walking the entry module's exports (`Schema[moduleHooks]` → `moduleExport[registerExport]` in 2.6.1 `dist/server/index.mjs`). A bare call is **silently ignored** — no error, and no lifecycle reducer appears in the published schema.

```typescript
// ✅ CORRECT — exported (from index.ts, or re-exported into it)
export const onConnect = spacetimedb.clientConnected((ctx) => {
  // ctx.sender is the connecting identity
  // Create/update user record, set online status, etc.
});

export const onDisconnect = spacetimedb.clientDisconnected((ctx) => {
  // Clean up: set offline status, remove ephemeral data, etc.
});

export const init = spacetimedb.init((ctx) => { /* runs on first publish / --delete-data */ });

// ❌ WRONG — never registers
spacetimedb.clientConnected((ctx) => { /* ... */ });
```

**Repo status (fixed in source 2026-11-05):** `spacetimedb/src/index.ts` used to declare both hooks as bare calls, and the live maincloud schema (`GET /v1/database/<db>/schema?version=9`) listed 0 lifecycle reducers out of 156. Until then the `isOnline`, disconnect-tracking, and ban-on-reconnect logic never ran. They are now `export const client_connected` / `client_disconnected`, named in snake_case per the reducer convention. Codegen leaves lifecycle reducers out of the client bindings, so the regenerated bindings are unchanged. A database only picks up the hooks once a build containing the fix is published to it (a non-destructive publish). Until then that database still has no lifecycle reducers, so check its schema before debugging presence or disconnect behavior there.

### Reducer context (`ctx`) — 2.6.1 surface
| Member | Notes |
|---|---|
| `ctx.sender` | Caller `Identity` — the only trustworthy identity |
| `ctx.connectionId` | `ConnectionId \| null` — null for scheduled/`init`/some internal calls; null-check before use. One Identity can hold several connections |
| `ctx.timestamp` | Deterministic per call |
| `ctx.databaseIdentity` | The module's identity (`ctx.identity` is the deprecated alias) |
| `ctx.random()` / `.integerInRange(min, max)` / `.bigintInRange(min, max)` / `.uint32()` / `.fill(typedArray)` | Deterministic RNG seeded from `ctx.timestamp` — use instead of `Math.random()` |
| `ctx.newUuidV4()` / `ctx.newUuidV7()` | Deterministic UUIDs |
| `ctx.senderAuth` | `AuthCtx` — see SKILL.md "AuthCtx applicability" (`isInternal` is always `false` on 2.6.1) |

`ctx.random.shuffle(array)` (in-place) is **v2.13.0+ — project SDK is 2.6.1; don't use until the upgrade lands.**

### Snake_case to camelCase conversion
- Server: `export const do_something = spacetimedb.reducer(...)` — name from export
- Client: `conn.reducers.doSomething({ ... })`

### Object syntax required
```typescript
// ❌ WRONG - positional
conn.reducers.doSomething('value');

// ✅ RIGHT - object
conn.reducers.doSomething({ param: 'value' });
```

---

## 5) Scheduled Tables

```typescript
// 1. Define table first (scheduled: () => reducer — pass the exported reducer)
export const CleanupJob = table({ 
  name: 'cleanup_job', 
  scheduled: () => run_cleanup  // reducer defined below
}, {
  scheduledId: t.u64().primaryKey().autoInc(),
  scheduledAt: t.scheduleAt(),
  targetId: t.u64(),  // Your custom data
});

// 2. Define scheduled reducer (receives full row as arg)
export const run_cleanup = spacetimedb.reducer({ arg: CleanupJob.rowType }, (ctx, { arg }) => {
  // arg.scheduledId, arg.targetId available
  // Row is auto-deleted after reducer completes
});

// Schedule a job
import { ScheduleAt } from 'spacetimedb';
const futureTime = ctx.timestamp.microsSinceUnixEpoch + 60_000_000n; // 60 seconds
ctx.db.cleanupJob.insert({ 
  scheduledId: 0n, 
  scheduledAt: ScheduleAt.time(futureTime),
  targetId: someId 
});

// Cancel a job by deleting the row
ctx.db.cleanupJob.scheduledId.delete(jobId);
```

Upstream writes the forward reference as `scheduled: (): any => run_cleanup` — the cast is needed because the forward reference defeats type inference. When the table and reducer live in different files, this repo uses the `export let _reducer: any` + setter pattern (see SKILL.md "TypeScript patterns") to avoid a circular import.

**`onSchedule` (v2.7.0+, PR #5435 — project SDK is 2.6.1; don't use until the upgrade lands):** the binding moves onto the reducer (or a `t.unit()`-returning procedure), so the table no longer references it and table/reducer can sit in separate files without a cycle — this would retire the `export let` workaround:
```typescript
const cleanupJob = table({ name: 'cleanup_job' }, {
  scheduledId: t.u64().primaryKey().autoInc(),
  scheduledAt: t.scheduleAt(),
  targetId: t.u64(),
});

export const run_cleanup = spacetimedb.reducer(
  { onSchedule: cleanupJob },        // 1st arg: options
  { arg: cleanupJob.rowType },       // 2nd arg: params
  (ctx, { arg }) => { /* ... */ }
);
// A schedule table can bind to at most one reducer/procedure. The scheduled reducer must be exported.
```

**Server-side scheduler changes (maincloud's server version governs these, not the project SDK):** interval drift fixed (v2.7.1 #5574, v2.8.3 #5735 — schedules anchor to the intended time, missed ticks are skipped); from v2.10.1 (#5736) scheduled calls dispatch concurrently, so **already-expired** jobs are no longer guaranteed to run in strict `scheduledAt` order (timestamps seen inside reducers stay monotonic); v2.12.0 (#5951) updating an interval row without changing its schedule no longer enqueues a duplicate call.

---

## 6) Timestamps

### Server-side
```typescript
import { Timestamp, ScheduleAt } from 'spacetimedb';

// Current time
ctx.db.item.insert({ id: 0n, createdAt: ctx.timestamp });

// Future time (add microseconds)
const future = ctx.timestamp.microsSinceUnixEpoch + 300_000_000n;  // 5 minutes
```

### Client-side (CRITICAL)
**Timestamps are objects, not numbers:**
```typescript
// ❌ WRONG
const date = new Date(row.createdAt);
const date = new Date(Number(row.createdAt / 1000n));

// ✅ RIGHT
const date = new Date(Number(row.createdAt.microsSinceUnixEpoch / 1000n));
```

### ScheduleAt on client
```typescript
// ScheduleAt is a tagged union
if (scheduleAt.tag === 'Time') {
  const date = new Date(Number(scheduleAt.value.microsSinceUnixEpoch / 1000n));
}
```

---

## 7) Data Visibility & Subscriptions

**`public: true` exposes ALL rows to ALL clients.**

| Scenario | Pattern |
|----------|---------|
| Everyone sees all rows | `public: true` |
| Users see only their data | Private table + filtered subscription |

### Subscription patterns (client-side)
```typescript
// Subscribe to ALL public tables (simplest — not recommended for production)
conn.subscriptionBuilder().subscribeToAllTables();

// Subscribe with raw SQL
conn.subscriptionBuilder().subscribe([
  'SELECT * FROM message',
  'SELECT * FROM room WHERE is_public = true',
]);

// Subscribe with typed query builder (preferred — type-safe)
conn.subscriptionBuilder().subscribe(tables.user);
conn.subscriptionBuilder().subscribe(
  tables.user.where(r => r.online.eq(true))
);
conn.subscriptionBuilder().subscribe([tables.user, tables.message]);

// Query builder filter operators: eq, ne, lt, gt, lte, gte
conn.subscriptionBuilder().subscribe(
  tables.user.where(r => r.level.gte(10).and(r.online.eq(true)))
);

// Composing filters — chainable methods or standalone imports
import { and, or, not } from './module_bindings';
tables.user.where(r => r.age.gte(18).and(r.age.lt(65)))   // chainable
tables.user.where(r => and(r.age.gte(18), r.age.lt(65)))   // standalone
tables.user.where(r => r.online.eq(true).or(r.name.eq('Admin')))
tables.user.where(r => r.online.eq(true).not())

// Semijoins — typed cross-table subscriptions (max 2 tables, join columns must be indexed)
// leftSemijoin: returns rows from the LEFT table matching at least one row on the right
conn.subscriptionBuilder().subscribe(
  tables.player
    .where(p => p.score.gte(1000))                                        // pre-join filter
    .leftSemijoin(tables.playerLevel, (p, pl) => p.id.eq(pl.playerId))   // join predicate
    .where(p => p.online.eq(true))                                        // post-join filter
);
// rightSemijoin: returns rows from the RIGHT table
conn.subscriptionBuilder().subscribe(
  tables.player
    .rightSemijoin(tables.playerLevel, (p, pl) => p.id.eq(pl.playerId))
    .where(pl => pl.level.gte(10))
);
// ⚠ useTable + semijoin TRAP (verified 2.6.1 dist/react/index.mjs:1473,1796; 2.14.1 :1507-1516,1905-1927):
// useTable re-filters the SHARED client cache using only the query's own `whereClause`.
// A semijoin query has none, and a post-join .where is ignored too. So useTable returns EVERY cached
// row of the result table, including rows another subscription brought in. Each useTable call also
// opens its own subscription. If several subscriptions feed one table, filter rows in JS after reading,
// or subscribe the join with subscriptionBuilder and read the cache yourself.

// Handle subscription lifecycle
conn.subscriptionBuilder()
  .onApplied(() => console.log('Initial data loaded'))
  .onError((ctx, e) => console.error('Subscription failed:', e))
  .subscribe(tables.user);
```

### SubscriptionHandle
`subscribe()` returns a handle to manage the subscription:
```typescript
const handle = conn.subscriptionBuilder().subscribe(tables.user);

handle.isActive();       // true if applied and not unsubscribed
handle.isEnded();        // true if terminated
handle.unsubscribe();    // Remove subscription, rows cleared from cache
handle.unsubscribeThen((ctx) => {
  console.log('Unsubscribe confirmed');
});
```

### Subscription semantics (from official docs)

**Ordering guarantees:**
- Responses to client requests are sent back in the **same order** the requests were received
- Each database transaction produces **exactly 0 or 1** update message per client
- Updates reflect the exact committed transaction order

**Atomic subscription initialization:**
- Client receives exactly one `SubscribeApplied` message containing **all** initially matching rows from a consistent database state snapshot taken between two transactions
- SDK locks the cache, inserts all rows atomically, then fires callbacks: `on_insert` per row, then `on_applied`

**Cache consistency during callbacks:**
- Callbacks are **deferred** until cache updates complete — they always observe fully consistent state
- During callback execution, the client cache reflects the database state immediately **after** the triggering transaction
- Cache reads are effectively free (local data)

**Multiple active subscriptions:**
- Updates across all active subscription sets are bundled into a single `TransactionUpdate` message
- No duplicate row deliveries across overlapping subscriptions

### Views have no clock: use a server-maintained flag for time-based visibility
`ViewCtx` is only `{ sender, db, from }`, and `AnonymousViewCtx` is `{ db, from }` (verified: 2.6.1 `dist/server/views.d.ts:13-21`; 2.14.1 `:15-25`). A subscription query is also fixed once it's made. So **neither a view nor a subscription can express "last N minutes", "currently live" or "online recently".**

The pattern that works, on any version:
1. Add a boolean flag column (e.g. `live: t.bool()`) with a **btree index**.
2. Set it in the reducer that writes the row; clear it in a **scheduled reducer** when the row ages out.
3. Clients subscribe with `tables.X.where(r => r.live.eq(true))`. When the flag flips, the row leaves the subscription and arrives as a delete, with no resubscribe.

The same trick covers filters SQL can't express: compute the flag in the reducer that touches the row. Reference: `clockworklabs/spacetimedb-cookbook` `wikiwatch` (the `live` and `in_argument` flags). In this project it fits open lobbies, recent matches and recently online users.

### Private table + view pattern (RECOMMENDED)

**Views are the recommended approach** for controlling data visibility. They provide:
- Server-side filtering (reduces network traffic)
- Real-time updates when underlying data changes
- Full control over what data clients can access

> ⚠️ **Do NOT use Row Level Security (RLS)** — it is deprecated.

> ⚠️ **CRITICAL:** Procedural views (views that compute results in code) can ONLY access data via index lookups, NOT `.iter()`.
> If you need a view that scans/filters across many rows (including the entire table), return a **query** built with the query builder (`ctx.from...`).

```typescript
// Private table with index on ownerId
export const PrivateData = table(
  { name: 'private_data',
    indexes: [{ accessor: 'owner_id', algorithm: 'btree', columns: ['ownerId'] }]
  },
  {
    id: t.u64().primaryKey().autoInc(),
    ownerId: t.identity(),
    secret: t.string()
  }
);

// ❌ BAD — not exported, view never registers (st_view empty, no client bindings)
spacetimedb.view(
  { name: 'my_data', public: true },
  t.array(PrivateData.rowType),
  (ctx) => [...ctx.db.privateData.owner_id.filter(ctx.sender)]
);

// ❌ BAD — .iter() causes performance issues (re-evaluates on ANY row change)
export const my_data_slow = spacetimedb.view(
  { name: 'my_data_slow', public: true },
  t.array(PrivateData.rowType),
  (ctx) => [...ctx.db.privateData.iter()]  // Works but VERY slow at scale
);

// ✅ GOOD — exported + index lookup enables targeted invalidation
export const my_data = spacetimedb.view(
  { name: 'my_data', public: true },
  t.array(PrivateData.rowType),
  (ctx) => [...ctx.db.privateData.owner_id.filter(ctx.sender)]
);

// ✅ GOOD — t.option() for at-most-one row (e.g. "get my player")
export const my_player = spacetimedb.view(
  { name: 'my_player', public: true },
  t.option(Player.rowType),
  (ctx) => {
    const row = ctx.db.player.identity.find(ctx.sender);
    return row ?? undefined;
  }
);
// Then in index.ts: export { my_data, my_player } from './views/myViews';
```

### Query builder view pattern (can scan)

```typescript
// Query-builder views return a query; the SQL engine maintains the result incrementally.
// This can scan the whole table if needed (e.g. leaderboard-style queries).
// MUST be exported — same rule as procedural views.
export const top_players = spacetimedb.anonymousView(
  { name: 'top_players', public: true },
  t.array(Player.rowType),
  (ctx) =>
    ctx.from.player
      .where(p => p.score.gt(1000n))
      .where(p => p.name.ne('BOT'))
);

// Query builder operators:
//   Comparison: eq, ne, lt, lte, gt, gte
//   Boolean:    and(), or(), not()
//   Joins:      leftSemijoin(), rightSemijoin()
```

### ViewContext vs AnonymousViewContext
```typescript
// ViewContext — has ctx.sender, result varies per user (computed separately per subscriber)
// MUST be exported + re-exported from index.ts
export const my_items = spacetimedb.view({ name: 'my_items', public: true }, t.array(Item.rowType), (ctx) => {
  return [...ctx.db.item.owner_id.filter(ctx.sender)];
});

// AnonymousViewContext — no ctx.sender, same result for everyone
// SpacetimeDB materializes the view ONCE and serves that result to all subscribers (much better perf)
export const leaderboard = spacetimedb.anonymousView({ name: 'leaderboard', public: true }, t.array(LeaderboardRow), (ctx) => {
  return [...ctx.db.player.by_score.filter(/* top scores */)];
});
```

**Views require explicit subscription:**
```typescript
conn.subscriptionBuilder().subscribe([
  'SELECT * FROM public_table',
  'SELECT * FROM my_data',  // Views need explicit SQL!
]);
```

### Procedural views + `.primaryKey()` → client `onUpdate` (v2.4.1, finalized v2.6.0)

Procedural views (TypeScript) can now declare a `.primaryKey()` on a column of the return row type. Declare the row with **`t.row(...)`** (it accepts column modifiers); `t.object` requires a name and is a plain product type, so `t.object({ id: t.u64().primaryKey(), ... })` is wrong twice over:
```typescript
const MyPlayerRow = t.row('MyPlayerRow', { id: t.u64().primaryKey(), name: t.string(), score: t.u32() });

export const my_player = spacetimedb.view(
  { name: 'my_player', public: true },
  t.option(MyPlayerRow),
  (ctx) => { /* ... */ }
);
```
Name the row type something other than the view handle's generated PascalCase name (e.g. not `ViewMyProfileRow` for `view_my_profile`) to avoid a binding-name collision.

Per the v2.14.1 views doc, a view that returns `t.array(SomeTable.rowType)` for a table whose column is `.primaryKey()` also gets PK semantics. In this repo's **2.6.1** bindings, views that do this (`view_my_lobbies`, `view_my_cost_sets`) still show `constraints: []` — re-check `src/module_bindings/index.ts` after the upgrade before assuming `onUpdate` fires.
Before this, views only ever fired `onInsert`/`onDelete` on the client — every change looked like a delete-then-insert. With a declared `.primaryKey()`, the client can now fire **`onUpdate`** for views, same shape as regular tables:
```typescript
conn.db.my_player.onUpdate((ctx, oldRow, newRow) => {
  console.log('View row updated:', oldRow, '->', newRow);
});
```
This project's ~35 procedural views do not declare `.primaryKey()` yet and only emit insert/delete — adopting this is a real opportunity, deferred under D-01 (not applied this phase).

---

## 8) React Integration

### Provider setup
```typescript
import { SpacetimeDBProvider } from 'spacetimedb/react';
import { DbConnection } from './module_bindings';

// connectionBuilder prop takes builder WITHOUT calling .build()
const builder = DbConnection.builder()
  .withUri(SPACETIMEDB_URI)
  .withDatabaseName(MODULE_NAME)
  .withToken(localStorage.getItem('auth_token') || undefined)
  .onConnect((conn, identity, token) => {
    localStorage.setItem('auth_token', token);
    conn.subscriptionBuilder().subscribeToAllTables();
  })
  .onConnectError((ctx, err) => console.error(err))
  .onDisconnect((ctx, err) => console.log('Disconnected', err));

// Memoize to prevent reconnects on re-render
const memoized = useMemo(() => builder, []);

<SpacetimeDBProvider connectionBuilder={memoized}>
  {children}
</SpacetimeDBProvider>
```

On 2.6.1 the provider does **not** reconnect on its own — see `references/how-to-guides.md` § Reconnection for the current workaround and the v2.12.0+ built-in replacement (`withAutomaticReconnect()`; the React provider enables it automatically).

### useTable — subscribe and read rows
```typescript
import { useTable } from 'spacetimedb/react';
import { tables } from './module_bindings';

// Basic — subscribe to all rows, returns [rows, isReady]
const [rows, isReady] = useTable(tables.myTable);

// With query builder filter (type-safe)
const [onlineUsers, isReady] = useTable(
  tables.user.where(r => r.online.eq(true))
);

// With inline callbacks for row events
const [users, isReady] = useTable(tables.user, {
  onInsert: (row) => console.log('New user:', row.name),
  onDelete: (row) => console.log('User left:', row.name),
  onUpdate: (oldRow, newRow) => console.log('Updated:', oldRow.name, '->', newRow.name),
});
```

### useReducer — call reducers from React
```typescript
import { useReducer } from 'spacetimedb/react';
import { reducers } from './module_bindings';

const sendMessage = useReducer(reducers.sendMessage);

// Call it — same object syntax as conn.reducers.*
sendMessage({ text: 'Hello!' });

// Zero-param reducers can be called with no args
const login = useReducer(reducers.loginAsGuest);
login();
```

### useSpacetimeDB — connection state
```typescript
import { useSpacetimeDB } from 'spacetimedb/react';

const {
  isActive,         // boolean — connection active
  identity,         // Identity | undefined
  token,            // string | undefined
  connectionId,     // ConnectionId
  connectionError,  // Error | undefined
  getConnection,    // () => DbConnection | null
} = useSpacetimeDB();

const conn = getConnection();
```

### Identity comparison and construction
```typescript
// Compare two Identity objects
const isOwner = row.ownerId.isEqual(myIdentity);

// Construct Identity from hex string (server or client)
import { Identity } from 'spacetimedb';
const identity = Identity.fromString(hexString);  // throws if invalid (not 32 bytes)
const identity2 = new Identity(hexString);         // equivalent

// Use constructed Identity for PK/index lookups instead of iter scanning
const mapping = ctx.db.UserIdentity.identity.find(identity);  // O(1)
```

### Table row callbacks (client-side)

React to individual row changes on regular tables:

```typescript
// Register callbacks after connection is established
conn.db.myTable.onInsert((ctx, row) => {
  console.log('New row:', row);
});

conn.db.myTable.onUpdate((ctx, oldRow, newRow) => {
  console.log('Updated:', oldRow, '->', newRow);
});

conn.db.myTable.onDelete((ctx, row) => {
  console.log('Deleted:', row);
});
```

These fire for ALL changes (yours and others'). Remove callbacks with `conn.db.myTable.removeOnInsert(callback)` (same for `removeOnUpdate`, `removeOnDelete`).

### Per-reducer callbacks
```typescript
// Register a callback for a specific reducer (fires for all callers)
conn.reducers.onUpdateUsername((ctx) => {
  console.log('Status:', ctx.event.status);  // { tag: 'Committed' } | { tag: 'Failed', value: string } | { tag: 'OutOfEnergy' }
  console.log('Caller:', ctx.event.callerIdentity);
  console.log('Energy:', ctx.event.energyConsumed);
});

// For reacting only to YOUR OWN reducer call:
conn.reducers.updateUsername({ newUsername: 'alice' })._then((ctx) => {
  // Fires only for this specific call
});
```

### Client-side cache access
```typescript
// Count rows currently in cache
const count = conn.db.user.count();

// Iterate all cached rows
for (const user of conn.db.user.iter()) {
  console.log(user.name);
}

// Find by unique index (client-side)
const user = conn.db.user.id.find(42);
```

### Event context discriminator
```typescript
// In row callbacks, check ctx.event.tag to distinguish what caused the change
conn.db.user.onInsert((ctx, row) => {
  if (ctx.event.tag === 'Reducer') {
    console.log('Caused by reducer:', ctx.event.value.reducer.name);
  } else if (ctx.event.tag === 'SubscribeApplied') {
    console.log('Initial sync — subscription applied');
  }
});
// Event tags: 'Reducer' | 'SubscribeApplied' | 'UnsubscribeApplied' | 'Error' | 'Transaction'
```

### Event tables

Event tables are transient — rows exist only for the duration of the transaction that created them. They broadcast to subscribed clients on commit, then are automatically deleted. Between transactions, the table is always empty.

```typescript
// Server — define with event: true (cannot be changed after publish)
const DamageEvent = table({
  public: true,
  event: true,
}, {
  entityId: t.identity(),
  damage: t.u32(),
  source: t.string(),
});

// Server — insert like a normal table (inside a reducer)
ctx.db.damageEvent.insert({ entityId: targetId, damage: 50, source: 'melee_attack' });
```

**Client-side differences from regular tables:**
- **Only `onInsert` fires** — no `onUpdate` or `onDelete` (rows never persist client-side)
- **`count()` always returns 0**, `iter()` yields nothing — rows never enter the client cache
- Subscriptions use the same SQL syntax: `SELECT * FROM damage_event`
- Event tables **cannot** be used in subscription joins or inside view functions

```typescript
// Client — only onInsert is available
conn.db.damageEvent.onInsert((ctx, event) => {
  showDamageNumber(event.entityId, event.damage);
});
```

This project uses `LobbyCursorEvent` as an event table for real-time cursor broadcasting.

---

## 9) Procedures

**Procedures are for side effects (HTTP requests, etc.) that reducers can't do.**

**Callbacks are synchronous** — do not mark a procedure `async` or `await` inside it; `ctx.http.fetch(url, options)` returns the response directly (verified 2.6.1). There are no `get()`/`post()` helpers — pass `{ method, headers, body }` in options; the response (`SyncResponse`) exposes `status`, `statusText`, `headers.get(name)`, `text()`, and `json()`. A `t.unit()` procedure returns `{}`. Do network I/O **before** `ctx.withTx(...)`; only database work belongs inside the transaction.

**v2.5.0 — procedures graduated to stable:** procedures no longer require `features: ["unstable"]` in `spacetime.json` to use. Also in v2.5.0, **`ctx.http` (outbound HTTP) was stabilized** — it is the explicit exception to "reducers are deterministic / no network": outbound HTTP is available **in procedures only**, never in reducers. This project still defines zero procedures.

### Defining a procedure
**Procedure name comes from the export — NOT from a string argument.** Use `procedure(params, ret, fn)` or `procedure(ret, fn)`.

```typescript
// ✅ CORRECT — export const name = spacetimedb.procedure(params, ret, fn)
export const fetch_external_data = spacetimedb.procedure(
  { url: t.string() },
  t.string(),  // return type
  (ctx, { url }) => {
    const response = ctx.http.fetch(url);
    return response.text();
  }
);
```

### Database access in procedures

⚠️ **CRITICAL: Procedures don't have `ctx.db`. Use `ctx.withTx()` for database access.**

```typescript
spacetimedb.procedure({ url: t.string() }, t.unit(), (ctx, { url }) => {
  // Fetch external data (outside transaction)
  const response = ctx.http.fetch(url);
  const data = response.text();

  // ❌ WRONG — ctx.db doesn't exist in procedures
  ctx.db.myTable.insert({ ... });

  // ✅ RIGHT — use ctx.withTx() for database access
  ctx.withTx(tx => {
    tx.db.myTable.insert({
      id: 0n,
      content: data,
      fetchedAt: tx.timestamp,
      fetchedBy: tx.sender,
    });
  });

  return {};
});
```

### Procedure timeouts (HTTP calls)
Default timeout: **30s**. Maximum ceiling: **180s** (3 minutes). These limits apply to `ctx.http.fetch()` calls within procedures. Sufficient for LLM API calls and most external services.

**Server-side outbound-HTTP changes (apply on maincloud regardless of SDK):** v2.10.2 (#5698) transparently advertises/decodes gzip + Brotli — don't hand-roll `Accept-Encoding` + decompression; v2.12.0 (#6012) negotiates HTTP/2 when the remote supports it. **v2.13.0 SDK fix (#6140 — project SDK is 2.6.1):** on 2.6.1, TS request/response header values are split at commas (breaks webhook signatures, HTTP dates, cookies with `Expires`) and nonstandard status codes throw — work around or upgrade.

### Key differences from reducers
| Reducers | Procedures |
|----------|------------|
| `ctx.db` available directly | Must use `ctx.withTx(tx => tx.db...)` |
| Automatic transaction | Manual transaction management |
| No HTTP/network | `ctx.http.fetch()` available |
| No return values to caller | Can return data to caller |

---

## 10) Project Structure & Commands

See SKILL.md for project structure, CLI commands, and naming conventions — those are project-specific and always in context.

### Avoiding circular imports
```
schema.ts → defines tables AND exports spacetimedb
index.ts  → imports spacetimedb from ./schema, defines reducers
```

---

## 11) Hard Requirements

**TypeScript-specific:**

1. **`schema({ table })`** — takes exactly one object; never `schema(table)` or `schema(t1, t2, t3)`
2. **Reducer/procedure names from exports** — `export const name = spacetimedb.reducer(params, fn)`; never `reducer('name', ...)`
3. **Reducer calls use object syntax** — `{ param: 'value' }` not positional args
4. **Import `DbConnection` from `./module_bindings`** — not from `spacetimedb`
5. **DO NOT edit generated bindings** — regenerate with `spacetime generate`
6. **Indexes go in OPTIONS (1st arg)** — not in COLUMNS (2nd arg) of `table()`
7. **Use BigInt for u64/i64 fields** — `0n`, `1n`, not `0`, `1`
8. **Reducers are transactional** — they do not return data
9. **Reducers must be deterministic** — no filesystem, network, timers, or external randomness; use `ctx.timestamp` / `ctx.random()` / `ctx.newUuidV4()`
10. **Views should use index lookups** — `.iter()` causes severe performance issues. Return `t.array()` for multiple rows, `t.option()` for at-most-one
11. **Procedures need `ctx.withTx()`** — `ctx.db` doesn't exist in procedures
12. **Sum type values** — use `{ tag: 'variant', value: payload }` not `{ variant: payload }`
13. **Export everything that must register** — reducers, views, procedures, AND lifecycle hooks (`init` / `clientConnected` / `clientDisconnected`) must be named exports of the module entry; bare calls are silently dropped

---

## 12) Post-2.6.1 features (version-gated)

**None of this works on this repo's SDK (2.6.1).** It is here so agents recognise these APIs in upstream docs/examples and don't port them back, and so the post-upgrade work has a starting point. Source: release notes + v2.14.1 docs + official `typescript-server` skill (see header).

| Feature | Since | Shape (TS) | Notes for this repo |
|---|---|---|---|
| Typed database environment variables | v2.12.0 | `schema({ ...tables }, { env: { API_KEY: t.string(), MODE: t.enum('Mode', ['dev','prod']), LOG_LEVEL: t.string().optional() } })` → `ctx.env.API_KEY` (string), optional → `string \| undefined`; `ctx.env.get('KEY')` → `string \| null` | Values are read-only strings supplied at publish time (process env → config `env` map → stored value), preserved across publishes, cleared by `--delete-data`. Never return or log them. CLI: `--env-only`, `--unset-env`, `--replace-env`, `spacetime env list/get`; HTTP: see `references/http-api.md` |
| Views with arguments | v2.13.0 (per official skill; not called out in the 2.13 release notes) | `spacetimedb.view(opts, { level: t.u64() }, t.array(Row), (ctx, { level }) => ...)` | Subscribe via raw SQL only: `SELECT * FROM view_name(42)` (no WHERE/joins); TS query builder can't express them; `subscribeToAllTables` skips them; they cannot have a primary key. Each argument set must be unsubscribed when obsolete |
| Module unit tests (in-memory datastore) | v2.12.0 | `spacetimedb/server/test-utils` + `spacetimedb/server/test-utils/vitest` plugin | See `references/how-to-guides.md` § Module Unit Testing. Does NOT simulate subscriptions, RLS, lifecycle hooks, or the scheduler |
| Submodules (mount another TS module under a namespace) | v2.8.0 (reusable `@spacetimedb/*` packages need 2.12+) | `schema({ ...tables, myAuth: { name: 'auth_data', module: authLib } })` → `ctx.db.myAuth.<table>`, client `conn.db.myAuth.<table>` | Official packages: `@spacetimedb/cron`, `@spacetimedb/retry`, `@spacetimedb/rate-limit`, `@spacetimedb/crypto`, `@spacetimedb/resend` (v2.13.0). Changing a namespace's canonical `name` drops its tables + data |
| Async inter-database calls (outbox tables) | v2.14.0 | `table({ outbox: { receiver: gw.reducers.admitPlayer } }, { msgId: t.u64().primaryKey().autoInc(), world: gw.identity().target(), ...params })`; optional `spacetimedb.reducer({ onResult: outbox }, ...)` | Requires `dependencies` in `spacetime.json` + generated `src/remote_bindings/`; both DBs on the same server. Not relevant until the project splits databases |
| `isInternal` = `sender === databaseIdentity` | v2.14.0 (breaking) | `ctx.senderAuth.isInternal` is **true** for scheduled reducers/procedures; `init` is no longer internal; `jwt` is none when internal | See SKILL.md "AuthCtx applicability" — the 2.6.1 "never guard on isInternal" rule stays until the upgrade, and old behavior persists until the module is rebuilt with the new library |
| HTTP handlers get a real sender | v2.14.0 | `ctx.sender` inside `spacetimedb.httpHandler(...)` (HTTP handlers are still unstable) | Repo defines no HTTP handlers |
| `ctx.random.shuffle(array)` | v2.13.0 | In-place; copy first | — |
| Generated TS bindings `--import-extension none\|js\|ts` | v2.14.0 (CLI) | `spacetime generate --import-extension js` or per-entry in `spacetime.json` | Only needed for `moduleResolution: "nodenext"` / Node-Bun-Deno direct TS execution; Next.js doesn't need it |