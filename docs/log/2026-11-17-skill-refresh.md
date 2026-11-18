# spacetimedb skill brought up to date (2026-11-17)

## Goal

Bring `.claude/skills/spacetimedb/` (SKILL.md and its five reference files) in line with the repository at `f320fc8`: correct what is false, add what an agent needs today, remove what no longer exists. Documentation only; no code, test or config change.

User: "lets cleanup the spacetimedb skill" (A212 item 3).

## What was wrong and what it says now

SKILL.md:

| Section | Was | Now |
|---|---|---|
| Header | no pointer to status or rulings | prod not published yet; status in `ROADMAP.md`, rulings in `DECISIONS.md`; `CLAUDE.md` wins on a conflict |
| When to load references | the auth function "planned, M5"; `_then()` listed | the login function calls `linker_present_code` over HTTP `/call` with `STDB_LINK_TOKEN`; `_then()` removed |
| Imports | client imports from `./module_bindings` and `spacetimedb/react` | `@bindings/...`, `spacetimedb` (`SenderError`, `toSql`), and the hooks in `web/src/stdb/`; only `StdbProvider.tsx` imports `spacetimedb/react` |
| Reducers | (missing) | one line with the CLAUDE.md §3 rules: transactional, no return, deterministic, `ctx.sender`, id gaps |
| Mindset, post-reducer sync | `_then()` "confirms commit"; no way to wait for the cache | a call returns `Promise<void>`; on 2.15.0 the caller's cache has applied the transaction before it resolves |
| Reconnection | manual handles only | `useRouteSubscriptions` keeps handles; `useFreshRouteSubscriptions` `fresh` for pages that write on what they read |
| Data access in React | `useTable` examples as the pattern | `useRouteSubscriptions` + `useRows`; `useTable` named as the SDK form pages don't use (A173) |
| Subscription swap | subscribe new first, always | `useRouteSubscriptions` always unsubscribes first; disjoint filters of one table read through `rowsOfSet` |
| Lifecycle hooks | "test1 still holds the pre-migration module until the S11 wipe" | test1 runs the exported hooks |
| View primary keys | "72 view functions across 11 files"; check `constraints` | the key shows on the generated row type; `constraints` is empty for every view; `useRows` coalesces insert + delete |
| React subscription rules | "The frontend is planned, not built: `web/src/` holds only `module_bindings/` and `lib/legacy/`" | new section "The client layer": `LazyStdbProvider`, `MaintenanceGate`, Layer 0, the reference set (actual queries), route subscriptions, gating by the query list, the CLAUDE.md §4 rules |
| Subscription gating | `useTable(..., { enabled })` | folded into "The client layer" (pass an empty or shorter query list) |
| Reducer calls in React | `useReducer(reducers.X)`; empty-param reducers called as `callX()` | `useReducerCall`; `NotConnectedError`; on `conn.reducers` an empty-param reducer takes `{}` |
| Handling reducer errors | `_then()`, `conn.reducers.onX`, `ctx.event.status` tags | the Promise rejects with `SenderError` / `InternalError` / `DisconnectedError` / `UnknownCallResultError`; classify by `error.name`, then by the module's exact sentence (`outcomeOf`, `shared/loadouts/sync.ts`) |
| AuthCtx | about 50 lines of 2.2.0 history; "live check pending on test1" | present tense: `isInternal` meaning, the five scheduled reducers, `ensureScheduler` and the engine both confirmed live (S11a log); gate table with `ensureVerifiedUser`; a one-paragraph sign-in flow (link code, Linker, `confirm_link`, `server_link_provider` removed) |
| Timestamps | string params for every reducer | most reducers; `create_season` takes `t.timestamp()` |
| Dangerous schema changes | (missing) | adding a table is additive; changing a live table's shape can force a migration; prefer a new private table (`UserLoadoutRate`); unpublished tables can still change |
| Do-nots | `useTable` / `User.filterByName` as the fix | rows for `_then()` / `onX`, SDK hooks in pages, the view + `useRows` fix; `onSchedule` noted as used |
| Feature checklist | `useReducer` / `useTable`; "steps 5 to 7 apply once the frontend exists" | tests, generate (never hand-edit), publish (user gate), `useRouteSubscriptions` / `useRows` / `useReducerCall` |
| CLI | no link token; no seed, guest-switch or integration commands; break-clients only in a later paragraph | both secrets with their roles; `--yes=remote --yes=break-clients` on the test publish line; `stdb:seed`, `stdb:guest-switch`, `test:integration`; every one a user gate |
| Project structure | tests "s4…s10* suites + *-fixtures.ts"; `shared/` without teambuilder, loadouts, auth-flow; no `api/`; frontend tree = bindings + `lib/legacy/`, "everything else is planned" | subject folders and `fixtures/`; current `shared/` and `scripts/stdb/` lists; `api/`; the real `web/src/` tree; a Tests paragraph (CLAUDE.md §6) |
| Key conventions | "no folder convention yet (set from M3)" | database code through `web/src/stdb/`; scheduled tables: two use `onSchedule`, three the `export let` setter |
| Audit columns | "test1 gets it with the S11 clear-publish"; only `auditInsert` / `auditUpdate` | scheduled job tables listed as exceptions (`UserDeletionJob` keeps them); `insertWithAudit` / `updateWithAudit` as the common form |
| TypeScript patterns | `onSchedule` "a refactor for the user to decide"; `ctx: any` "a decision for the user" | two tables already use `onSchedule`; the typing pass is ROADMAP S15 |
| User table | "Since S11a ..." | present tense, plus `view_my_profile` / `view_admin_users` |
| Private tables | (missing) | own-rows views (`view_my_loadouts` as the example) |
| Optimistic concurrency | (missing) | new section: version column, `baseRev`, refusal sentences, `revFloor` / `firstRev`, client side (A198) |
| Rate limits | "store the last-accepted time per user" only | new section: private per-user tables (`UserRateState`, `UserLoadoutRate`, `LobbyCursorStamp`), helpers, abuse estimate |
| Fan-out example | throttle against `LobbyMember.lastCursorAt` | the private `LobbyCursorStamp` row; live stages only |
| Egress meter | "planned at M6" | `web/src/dev/wireStats.ts`, dev only, gate 3 |
| Reference set (energy) | "characters, light cones, cost tables, cost sets" | the actual five queries plus the default cost set; measured about 41 kB on the wire |
| Updating docs / official plugin | "project-layout pass 2026-11-10"; `onSchedule` "not used yet" | last repo pass 2026-11-17 (this log); plugin differences restated |

References:

| File | Was | Now |
|---|---|---|
| `how-to-guides.md` | `_then()` per-call callbacks; A111 test "at S11"; bugs fixed "in 2.14.1"; `*-fixtures.ts` | the call's Promise and its error classes; A111 test not run yet; 2.15.0 and test1 builds since M5; `__tests__/<subject>/` + `fixtures/` |
| `api-guide.md` | per-reducer callbacks with `ctx.event.status`; `_then()`; `onSchedule` adoption "a user decision"; A111 "S11"; isInternal "live check pending"; "Vite (`web/`, M3)"; view keys checked through `constraints` | no per-reducer callbacks on 2.15.0, the Promise; a repo note on the React section; `onSchedule` used by two tables; A111 not run; confirmed live; M3 tag dropped; keys read from the row type |
| `http-api.md` | the auth function "planned, M5", on a WebSocket connection, with `STDB_SERVER_TOKEN` | the login function's real HTTP call (`/call/linker_present_code`, `STDB_LINK_TOKEN`, 530 for a refusal, one attempt, 5 s) |
| `spacetime-json.md`, `multiplayer-sync-patterns.md` | checked | no change |

## Removed

- The "planned frontend" paragraph and the `web/src/lib/legacy/` tree line.
- The 2.2.0 `isInternal` history (the guard pattern, the diagnostic, the hotfix): about 35 lines, kept as one sentence.
- The `useTable` `enabled` gating section (folded into "The client layer").
- The `_then()` / `conn.reducers.onX` / `ctx.event.status` examples in SKILL.md and both references.
- Stale step tags and "planned" wording for built work (M3, M5, M6, M10, S11).

Counts: about 40 statements corrected, 12 added (sections or paragraphs), 9 removed.

## Not verified

- Combined multi-query `subscribe([...])` firing `onApplied` before all rows arrive (kept, marked not verified on 2.15.0).
- That `onUpdate` fires for every view whose row type has a key (the loadout docs say rows arrive as updates; not checked in the SDK source).
- "Adding a column at the end must have a default value" and the `.unique()` migration note (server-side rules, not in the SDK typings).
- The subscription SQL restrictions table and the `spacetime sql` gotchas (server-side).
- The 2.6.1-era runtime notes (accessor TypeErrors, struct optional fields, timestamp serializer), kept as written.

## Checks

- No code, test or config file touched; `git status` shows only the skill folder and this log.
- `npm run lint:ci` does not cover markdown or `.claude/` (Biome ignores `**/*.md`; the script lists `web`, `shared`, `scripts/ci`, `scripts/preview`, `scripts/local-auth`, `api`). `npm run check:patterns` walks `web/src`, `web/dist` and `api/`. Neither was run.
- The final SKILL.md was re-read start to end against `CLAUDE.md`; no contradiction left.

Length: SKILL.md 962 lines / 84,003 bytes before, 905 lines / 87,942 bytes after.

## Doc checklist

| Folder | Answer |
|---|---|
| feature `architecture.md` / `contract.md` | skip: no backend or behaviour change |
| `docs/frontend/` | skip; noted for the orchestrator: `subscriptions.md` Decisions 9 and 10 still prescribe `useTable` `enabled` and `useReducer`, which A173 replaced |

## Usage (harness figures)

| Phase | Agent | Tokens | Tool calls | Time |
|---|---|---|---|---|
| Refresh | Opus | 325,234 | 160 | 12 min |

Documentation only; no code, test or config changed, so no test run. The orchestrator checked that only the skill folder and this log changed. Decision: A212 item 3.
