# SpacetimeDB upgrade assessment: v2.6.1 → v2.14.1

**Researched:** 2026-11-05
**Target:** `spacetimedb` npm 2.14.1 (published 2026-11-04) + `spacetime` CLI 2.14.1
**Scope:** Research only. No repo code changed, nothing published, integration suite not run.
**Template:** Phase 16.5 (2.2.0 → 2.6.1): `.planning/phases/16.5-spacetimedb-2-6-1-upgrade-test-suite-validation/`

**Evidence labels**
- **[verified]**: I read the PR, the SDK source or `.d.ts`, the CLI source or `--help`, or reproduced the behaviour in a scratch copy of the repo.
- **[notes]**: taken from release notes only.

---

## 1. Verdict

**Safe, with the changes listed below. Moderate effort, low risk.**

Two hard blockers stop the bump. Both have small, mechanical fixes. A third change should go in the same phase.

| # | Blocker | Effect if ignored | Fix |
|---|---|---|---|
| B1 | `spacetimedb@2.14.1` adds `"engines": {"node": "^22.23.4 \|\| ^24.22.1 \|\| >=26.12.1"}`. The repo's `.npmrc` sets `engine-strict=true`. Local Node is **v26.4.0**. | `npm install` fails with `EBADENGINE`. Vercel builds fail the same way if their Node is below the floor. | Move Node to ≥ 26.12.1 (26.13.0 is current). Check the Vercel project's Node version. **[verified]** |
| B2 | The regenerated `src/module_bindings/index.ts` fails `tsc` with **TS2589** ("Type instantiation is excessively deep and possibly infinite") at line 2117 (`export class DbConnection extends __DbConnectionImpl<typeof REMOTE_MODULE>`). This happens on TypeScript 5.6.3 (our current version), 5.7.3 and 5.8.3. It passes on 5.9.2 and 5.9.3. | `npm run test:typecheck` and `next build` fail. | Bump `typescript` from `~5.6.2` to `~5.9.3` in root `package.json`. Bump `spacetimedb/package.json` too for consistency. The SDK's own devDependency is `^5.9.3`. **[verified]** |
| C1 | `SpacetimeDBProvider`'s `ConnectionManager` now forces `withAutomaticReconnect()`. The `DbConnection` object survives a socket drop and the SDK replays every subscription that was not unsubscribed. Our two manual subscription owners never unsubscribe. They re-subscribe each time `isActive` goes false → true. | Each reconnect adds a duplicate `SELECT * FROM user` and `SELECT * FROM view_my_profile` subscription. That means extra egress and more server-side query sets. | Keep the `SubscriptionHandle` and call `.unsubscribe()` in the effect cleanup in `components/features/auth/components/AuthProvider.tsx:44` and `app/(authed)/layout.tsx:58`. **[verified in SDK source; not live-tested]** |

**Already proven in a scratch copy of HEAD, with no repo changes:**
- The module builds and bindings generate with CLI 2.14.1 and SDK 2.14.1. Module `tsc` is clean on TS 5.6.3 and 5.9.3.
- Full app typecheck has **0 errors** with TS 5.9.3.
- Unit suite: **197/197**.
- `next build` succeeds.
- Old handle names keep working at runtime through deprecated aliases (network-free smoke test). This covers 453 references across 66 files.

**Not yet proven** (needs the real phase):
- The ~60 min live integration suite.
- The size of the maincloud migration delta when republishing. Module source is unchanged since the 2026-07-04 republish, so an identity migration is expected.
- Real browser reconnect behaviour.

**Why this is not "risky":** maincloud already runs the latest server, so every server-side change in 2.7–2.14 has been live against our 2.6.1-built module since it shipped (§5). The bump only changes things that ship with our SDK and CLI: codegen, client reconnect behaviour, and module-library semantics. All three are covered by the scratch verification above.

---

## 2. What was verified and how

All scratch work lives in `C:/Users/Nathyron/AppData/Local/Temp/claude/bf1569215458d3e3/a544ae80-db2d-4960-a17b-66f4bbfc9bf3/scratchpad/upgrade-research/`.

| Check | Method | Result |
|---|---|---|
| Release notes v2.7.0-hotfix3 … v2.14.1 (15 releases; there is no plain v2.7.0 GitHub release) | `gh api repos/clockworklabs/SpacetimeDB/releases` → `notes.md` | Classified in §4 and §8 |
| SDK API surface | `npm pack spacetimedb@2.6.1` and `@2.14.1` → diffed `src/` and `dist/*.d.ts` | Entry-point `.d.ts` files (`index`, `sdk/index`, `react/index`) are byte-identical. Server exports are additive only. `DbConnectionImpl.getTablesMap()` was removed (we don't use it). Callback signatures only gained optional parameters. |
| CLI flags | `--help` diff of the 2.6.1 and 2.14.1 binaries for root, publish, generate, sql, build, call, logs, describe, delete, list (`cli-help/`) | `--yes=migrate` is unchanged. `--clear-database` alias kept (checked in `common_args.rs` at both tags). Additions: env flags, `--import-extension`, `sql --format`, `describe --format`, `lock`/`unlock`/`auth`/`mcp`/`env`. Nothing removed. |
| Baseline codegen | 2.6.1 CLI `generate` on a scratch copy of HEAD | Byte-identical to the committed `src/module_bindings` (ignoring CRLF), so the baseline is clean |
| Target codegen | 2.14.1 CLI `generate` on a scratch copy with the module SDK at 2.14.1 | Build succeeds. **Only `index.ts` changes** (1 of 240 files): +714/−93 lines (`bindings-index.diff`) |
| Client typecheck | `tsc --noEmit` on the scratch copy (823 project files) | Old bindings + SDK 2.14.1: 0 errors. New bindings: TS 5.6.3/5.7.3/5.8.3 give 1 error (TS2589); TS 5.9.2/5.9.3 give 0 errors |
| Unit suite | `vitest run --config test/vitest.config.ts` (local only, mocks `spacetimedb/server`) | 11 files, 197/197 pass |
| Production build | `next build` with SDK 2.14.1, new bindings, TS 5.9.3 | Succeeds; all 11 routes built |
| Alias runtime | Scratch vitest smoke: fake WS factory, no network | `tables.Lobby === tables.lobby`, `conn.db.User === conn.db.user`, `conn.db.view_my_profile === conn.db.viewMyProfile` all pass |
| Safety | `cli.toml` sha256 before and after running the 2.14.1 binary | Unchanged. `bin/current` → 2.6.1. Repo `git status` shows no changes from me. |

---

## 3. Required code changes

| # | File(s) | Change | Why | Status |
|---|---|---|---|---|
| R1 | Dev machine + Vercel project settings | Node ≥ 26.12.1, or 24.22.1+ / 22.23.4+ on those lines | B1: engines floor plus `.npmrc` `engine-strict=true` (PR [#6385](https://github.com/clockworklabs/SpacetimeDB/pull/6385)). The floors are exactly the 2026-10-20/21 Node security releases. | **[verified]** |
| R2 | `package.json` (and optionally `engines`) | `"spacetimedb": "^2.6.1"` → `"^2.14.1"`; `"typescript": "~5.6.2"` → `"~5.9.3"`; consider `"engines": {"node": ">=26.12.1"}` so the repo states its real floor | B2, plus the bump itself | **[verified]** (scratch tsc + next build) |
| R3 | `spacetimedb/package.json` | `"spacetimedb": "^2.14.1"`; `"typescript": "~5.9.3"` (optional: the module typechecks on 5.6.3 too) | The bump. Also updates the **git-tracked vendored tree** `spacetimedb/node_modules/spacetimedb`, which grows about 13 MB → 23 MB `dist` (8.4 MB is `server/test-utils/portable-datastore-wasm/*.wasm`). | **[verified]** |
| R4 | `src/module_bindings/` | `npm run spacetime:generate` with CLI 2.14.1 | Codegen (§4). Only `index.ts` changes. | **[verified]** |
| R5 | `components/features/auth/components/AuthProvider.tsx:44-77`, `app/(authed)/layout.tsx:58-97` | Store `const handle = conn.subscriptionBuilder()...subscribe(...)` and call `handle.unsubscribe()` in the cleanup | C1. `unregisterSubscription` handles the disconnected case locally, with no message sent, so this is safe. | **[verified in source]** (`db_connection_impl.ts` `registerSubscription`/`#replaySubscriptions`/`unregisterSubscription`) |
| R6 (recommended) | `scripts/post-publish.ts`, `seed-data.ts`, `manage-user.ts`, `nuke-test-data.ts`, `register-server.ts` | Add `.onDisconnect((_c, err) => { console.error(...); process.exit(1); })` | PR [#5707](https://github.com/clockworklabs/SpacetimeDB/pull/5707) (2.10.0) now routes mid-session WS errors to `onDisconnect`. Before, they went to `onConnectError`, which these scripts use to exit. They register no `onDisconnect`, so a mid-session drop would now **hang** instead of failing fast. `nuke-test-data.ts` has no timeout at all. `post-publish.ts` runs inside `test/global-setup.ts`. | **[verified in source]** |

Not required, but stale after the bump. These are comment-only:
- The `isInternal` comments in `spacetimedb/src/reducers/identityGc.ts:5-12`, `lobbyGc.ts:11-12` and `userDeletion.ts:12-14` say `isInternal` is always false. That is no longer true once the module is rebuilt with SDK ≥2.14.0 (§4, #5892).
- `docs/FRONTEND-HANDOFF.md` still states SDK 2.6.1.

**Explicitly not required:**
- Migrating the 453 PascalCase/snake_case handle references to camelCase. The deprecated aliases work at runtime and in types. The breakdown is components 29 refs/6 files, app 4/1, scripts 2/2, test 418/56. The aliases are marked "removed in the next major version" (3.0). Changing `test/` needs an explicit task per CLAUDE.md.
- Server-side `ctx.db.Lobby` and similar (1,360 refs in `spacetimedb/src`). Module-side keys did not change.

---

## 4. Changes that land when we bump (SDK / CLI / codegen)

### 4a. Breaking changes that affect us

| Change | Release | Our surface | Impact | Status |
|---|---|---|---|---|
| **Generated TS table/view handles are now camelCase** (`conn.db.lobby`, `tables.viewMyProfile`). The old names become `@deprecated` aliases. | 2.7.0 [#5286](https://github.com/clockworklabs/SpacetimeDB/pull/5286) | All 84 handles. Our schema keys are PascalCase (`Lobby`), so they become `lobby` + alias `Lobby`. Views: `view_my_profile` becomes `viewMyProfile` + alias. | Works unchanged through the aliases. Aliases are **enumerable**, so `Object.keys(tables)` now returns both names; grep found no enumeration in our code. `EventContext`/`ErrorContext` become `Omit<…,"db"> & {db: DbView}`; typechecks clean. The alias layer is the likely source of TS2589 (B2), but I did not bisect. | **[verified]** (generated diff + runtime smoke) |
| **TS2589 in generated bindings under TypeScript < 5.9** | 2.14.1 codegen (introducing version not bisected) | `src/module_bindings/index.ts:2117` | Blocks typecheck and build (B2). I found no upstream issue (searched "excessively deep" and "TS2589"). Our schema is large: 84 client handles (48 public tables + 36 views) and about 156 reducers. | **[verified]** |
| **Node engines floor** | 2.14.1 [#6385](https://github.com/clockworklabs/SpacetimeDB/pull/6385) | `.npmrc` `engine-strict=true`, local Node 26.4.0 | Install fails (B1). 2.6.1 through 2.14.0 have no `engines` field. | **[verified]** |
| **React provider forces automatic reconnect** (the `ConnectionManager` calls `builder.withAutomaticReconnect()`, reuses the latest session token, and keeps the same `DbConnection` across drops) | 2.12.0 [#5927](https://github.com/clockworklabs/SpacetimeDB/pull/5927) (+ `connection_manager.ts`) | `app/providers.tsx` via `SpacetimeDBProvider`; manual subscription owners | Duplicate subscriptions (C1/R5). User `onConnect` is **not** called on auto-reconnects; only `onAutomaticReconnect` is. That is fine for us: `providers.tsx` `onConnect` only stores the token, and the identity is preserved. | **[verified in source]** |

### 4b. Behaviour changes and deprecations (no compile break)

| Change | Release | Our surface | Notes | Status |
|---|---|---|---|---|
| **`isInternal` semantics unified.** In TS, `ctx.senderAuth.isInternal` is now `sender == databaseIdentity`, so it is **true for scheduled reducers**. `init` is no longer internal. `jwt` is null when internal. Modules built with the new library export a new `__call_http_handler__`, which older hosts reject. | 2.14.0 [#5892](https://github.com/clockworklabs/SpacetimeDB/pull/5892) | No code uses `isInternal`; the guards were removed in 16.4 Plan 07 because 2.2.0 always returned false | No break. The behaviour only applies after a rebuild. It makes `isInternal` guards viable again (§6). | **[verified]** (`server/runtime.ts` `AuthCtxImpl.forSender`) |
| Mid-session WS errors now fire `onDisconnect`, not `onConnectError` | 2.10.0 [#5707](https://github.com/clockworklabs/SpacetimeDB/pull/5707) | `lib/spacetimedb-server.ts` singleton; `scripts/*.ts`; `test/shared/connection.ts` (`onDisconnect` is a no-op) | The singleton benefits: `onDisconnect` resets `connectionPromise`, where before a stale connection was kept. Scripts are covered in R6. | **[verified in source]** |
| Reducer and procedure calls made while auto-reconnecting **reject immediately with `DisconnectedError`** | 2.12.0 (`#rejectCallIfDisconnected`) | Every `useReducer` call in the browser | Before, the manager discarded the connection and `useReducer` queued calls while `conn` was null. Now `conn` exists but is inactive, so the call rejects. UI error toasts should handle this; check the gameplay flows (draft, lobby). | **[verified in source]** |
| `useTable` rework: subscription is keyed on the connection object; `isReady` = active and applied for the current `connectionId` | 2.12.0+ (`react/useTable.ts`) | 10 `useTable` call sites incl. `{ enabled }` | API unchanged. It no longer resubscribes on `isActive` flips because the SDK replays. | **[verified]** (source diff) |
| Fresh anonymous identity no longer lost on reconnect. In 2.6.1 the manager rebuilt from the **original** builder, so a first-time guest with no stored token could get a new identity. | 2.9.0 [#5761](https://github.com/clockworklabs/SpacetimeDB/pull/5761) + 2.12.0 manager | Guest flow (`login_as_guest`) | Bug fix that benefits us. | **[verified]** (2.6.1 `#scheduleReconnect` vs 2.14.1 `#buildManagedConnection`) |
| Browser liveness listeners (`visibilitychange`/`focus`/`online`/`pageshow`) rebuild dead sockets | 2.7.1 [#5525](https://github.com/clockworklabs/SpacetimeDB/pull/5525) | Browser only | Active **only with auto-reconnect** (code returns early otherwise), so React yes; server singleton, tests and scripts no. | **[verified in source]** |
| WS decompression: Safari/iOS gzip rejection now closes the socket instead of stalling; frames are decompressed in order | 2.8.1 [#5668](https://github.com/clockworklabs/SpacetimeDB/pull/5668), 2.10.2 [#5845](https://github.com/clockworklabs/SpacetimeDB/pull/5845) | All clients (gzip default) | Bug fixes that benefit us (iOS users). | **[verified]** (`websocket_decompress_adapter.ts`) |
| `WebSocketArgs` gains `connectionId`/`sessionId`; `WebSocketAdapter` gains optional `readyState`; SDK sends `connection_id`/`session_id` query params | 2.10.2–2.12.0 | `tools/capture-ws-frames.ts` (`withWSFn`) | Still type-compatible (tsc clean). The tool's factory rebuilds the URL itself, so it drops `connection_id`. That only matters if the server starts requiring it. `websocket_protocols.ts` and `websocket_v3_frames.ts` are **unchanged**, so `v3.bsatn.spacetimedb` and the 1-byte compression tag are the same. Runtime not tested (needs `CAPTURE_WS_FIXTURE_TOKEN` + maincloud). | **[verified]** (source diff, tsc) |
| `Timestamp`/`Identity` constructors coerce `number`/string to bigint | 2.7.0 [#5041](https://github.com/clockworklabs/SpacetimeDB/pull/5041) | `new Timestamp(...)` in `calendarAvailability.ts` | We always pass bigint, so no effect. | **[verified]** |
| `Uuid`/branded primitives no longer flattened by `Prettify` | 2.14.1 [#5971](https://github.com/clockworklabs/SpacetimeDB/pull/5971) | Types only | tsc clean | **[verified]** (tsc) |
| Generated types compatible with `exactOptionalPropertyTypes` | 2.14.0 [#6096](https://github.com/clockworklabs/SpacetimeDB/pull/6096) | We don't enable it | n/a | **[notes]** |
| TS `Result` builder shape `{ok}\|{err}` corrected | 2.13.0 [#6148](https://github.com/clockworklabs/SpacetimeDB/pull/6148) | No `t.result` usage (grep) | n/a | **[notes]** + grep |
| Module index fixes: one-column prefix scans on multi-column indexes, composite range `filter`/`delete`, enum PK/index columns | 2.7.0 [#5428](https://github.com/clockworklabs/SpacetimeDB/pull/5428)/[#4389](https://github.com/clockworklabs/SpacetimeDB/pull/4389), 2.8.0 [#5479](https://github.com/clockworklabs/SpacetimeDB/pull/5479) | We only do full-tuple `.filter([a,b])` on composite indexes (grep: 13 call sites) | No change for us. Prefix and range scans become usable. | **[notes]** + grep |
| `readUInt8Array` returns an owned copy | 2.8.1 [#5491](https://github.com/clockworklabs/SpacetimeDB/pull/5491) | No `array<u8>` columns found | n/a | **[notes]** |
| ASCII fast path for TS string serialization | 2.10.2 [#5783](https://github.com/clockworklabs/SpacetimeDB/pull/5783) | Module perf | Bytes unchanged | **[notes]** |
| CLI: `spacetime sql` text formatter **unchanged**; only `--format json` added | 2.7.0 [#5459](https://github.com/clockworklabs/SpacetimeDB/pull/5459) | Test parsers `test/shared/connection.ts:239` (`queryPrivateTable`), `test/backend/lobby/account-selection.test.ts:36` | No break. These tests call whatever `spacetime` is on PATH. | **[verified]** (`crates/cli/src/subcommands/sql.rs` diff v2.6.1↔v2.14.1) |
| CLI: `describe` no longer requires `--json`; `list`/`rename`/`mcp` respect `spacetime.json` server; complete error chains; clearer local schema-validation errors | 2.11.0 [#5947](https://github.com/clockworklabs/SpacetimeDB/pull/5947)/[#6046](https://github.com/clockworklabs/SpacetimeDB/pull/6046), 2.10.1 [#5883](https://github.com/clockworklabs/SpacetimeDB/pull/5883), 2.12.0 [#6079](https://github.com/clockworklabs/SpacetimeDB/pull/6079) | Dev workflow | DX only | **[verified]** (help) / **[notes]** |
| CLI publish gains env flags (`--env-only`, `--unset-env`, `--replace-env`); "publishing preserves unspecified environment values" | 2.12.0 [#5887](https://github.com/clockworklabs/SpacetimeDB/pull/5887) | `spacetime:publish*` scripts | Inert. The module declares no env, so nothing is read from the shell. | **[verified]** (help) |
| Codegen prints "Skipping private tables during codegen: …" | 2.14.x | `spacetime:generate` output | Cosmetic | **[verified]** |
| Local `spacetime start` must be ≥ 2.14 to accept a 2.14-built module (new `__call_http_handler__` ABI) and new clients (SubscribeBatch v3 message, [#5877](https://github.com/clockworklabs/SpacetimeDB/pull/5877)) | 2.10.2 / 2.14.0 | `spacetime:publish:local` | Only if anyone uses a local standalone. Maincloud is on latest. | **[notes]** + PR body |

---

## 5. Server-side changes already live on maincloud

Maincloud runs the latest server whatever our SDK version is. These have applied to `hsrpvp-spacetimedb-nextjs-test1` and `-production` since each release.

| Change | Release | Relevance / what to check | Status |
|---|---|---|---|
| **JWT impersonation vulnerability patched.** Someone who knew a token's `sub`+`iss` could impersonate that Identity. Patched 2026-09-04, disclosed in 2.11.0. | 2.10.0 ([#5866](https://github.com/clockworklabs/SpacetimeDB/pull/5866)), notice in 2.11.0 | Our privileged path is `SPACETIMEDB_SERVER_TOKEN` + the `ServerIdentity` row. Upstream reports no known exploitation. **Check:** whether to rotate the server token and review `ServerIdentity`/admin activity before 2026-09-04 (open question). | **[notes]** |
| **HS256 JWTs rejected** | 2.12.0 [#6100](https://github.com/clockworklabs/SpacetimeDB/pull/6100) | Every token we use is SpacetimeDB-issued (`register-server.ts` takes it from `onConnect`; the browser stores the SDK token). next-auth's own JWT never reaches SpacetimeDB, and grep finds no `jose`/`jsonwebtoken`. **No action.** | **[notes]** + grep |
| WS idle timeout: any client data counts as activity; idle sockets get a close handshake with reason "idle timeout" and a 10 s grace period | 2.9.0 [#5517](https://github.com/clockworklabs/SpacetimeDB/pull/5517) | The long-lived server singleton in `lib/spacetimedb-server.ts` may see clean idle closes. Its `onDisconnect` resets the singleton. | **[verified]** (PR) |
| Scheduler: drift fixes (anchor to intended time), concurrent dispatch (**already-expired schedules no longer run in strict `scheduled_at` order**), duplicate pending entries fixed, delay warnings > 50 ms | 2.7.1 [#5574](https://github.com/clockworklabs/SpacetimeDB/pull/5574), 2.8.3 [#5735](https://github.com/clockworklabs/SpacetimeDB/pull/5735), 2.10.1 [#5736](https://github.com/clockworklabs/SpacetimeDB/pull/5736), 2.12.0 [#5951](https://github.com/clockworklabs/SpacetimeDB/pull/5951), 2.8.0 [#5592](https://github.com/clockworklabs/SpacetimeDB/pull/5592) | 3 scheduled jobs: `run_identity_gc`, `run_lobby_gc` (weekly interval) and `run_user_deletion`. **Check:** that `run_user_deletion` doesn't assume ordering across rows that were due at the same moment. | **[notes]** |
| Stricter sequences: non-default sequence parameters fail validation | 2.10.2 [#5880](https://github.com/clockworklabs/SpacetimeDB/pull/5880) | We only use `.autoInc()` defaults. Validation happens server-side at publish; the publish gate (§7 step 8) confirms. | **[notes]** |
| Adding a sequence to an existing column prechecks its full range | 2.7.1 [#5561](https://github.com/clockworklabs/SpacetimeDB/pull/5561) | Future migrations | **[notes]** |
| Add `unique`/`primaryKey` via auto-migration (fails safely on duplicates) | 2.7.0 [#4465](https://github.com/clockworklabs/SpacetimeDB/pull/4465) | Relaxes the skill's "dangerous schema changes" table | **[notes]** |
| Procedural-view backing tables auto-migrated; expired views cleaned up in bounded batches | 2.7.0 [#5441](https://github.com/clockworklabs/SpacetimeDB/pull/5441), [#5503](https://github.com/clockworklabs/SpacetimeDB/pull/5503) | We have 36 procedural views. Transparent. | **[notes]** |
| Accessor-name renames now migrate `st_*_accessor` (previously panicked on the next call) | 2.8.2 [#5544](https://github.com/clockworklabs/SpacetimeDB/pull/5544) | Matters if we ever rename schema keys such as `Lobby` → `lobby` | **[notes]** |
| SQL DML resolves accessor names as well as canonical names | 2.7.0 [#5478](https://github.com/clockworklabs/SpacetimeDB/pull/5478) | `spacetime sql` DML can use `Lobby` or `lobby` | **[notes]** |
| Confirmed **HTTP** reducer calls wait for durability (5 s deadline, then `504`) | 2.13.0 [#6101](https://github.com/clockworklabs/SpacetimeDB/pull/6101) | We make no HTTP reducer calls (grep). WS with `withConfirmedReads(false)` is unchanged. | **[notes]** + grep |
| Quieter server logs: reducer-returned errors go only to the module log | 2.8.0 [#5320](https://github.com/clockworklabs/SpacetimeDB/pull/5320); 2.7.1 [#5473](https://github.com/clockworklabs/SpacetimeDB/pull/5473) | `spacetime logs` debugging | **[notes]** |
| Session takeover for reconnecting clients. Lifecycle reducers run fully for the old connection before the new one is accepted. | 2.10.2 [#5877](https://github.com/clockworklabs/SpacetimeDB/pull/5877) | Our `clientConnected`/`clientDisconnected` (`spacetimedb/src/index.ts:113,154`) still see a full disconnect → connect cycle, so presence and lobby-disconnect semantics are preserved. Only triggered by ≥2.12 clients. | **[verified]** (PR) |
| Publishing to `/v1/database/<identity>` can no longer *create* a database at that identity | 2.14.1 (commit `72c350ead`) | We publish by name | **[verified]** (commit) |
| Lower subscription memory, HTTP/2 ingress, CORS preflight caching, replication durability, commitlog crash-safety, BSATN OOM hardening, v1-WS deadlock fix | 2.7.0–2.13.0 | Transparent. We are on WS v3. | **[notes]** |
| MCP endpoint available on maincloud (`/v1/mcp`) | 2.10.0 [#5849](https://github.com/clockworklabs/SpacetimeDB/pull/5849) | Agent tooling option (§6) | **[notes]** |

Not re-tested: the **2.6.1 SQL constant-projection rejection** (`SELECT 1` → HTTP 400, see commit `24d9f92`). Nothing in 2.7–2.14 mentions it apart from "SQL parser regression coverage" ([#5932](https://github.com/clockworklabs/SpacetimeDB/pull/5932)). Assume it still applies.

---

## 6. Features worth adopting (deferred, not part of the bump)

Ranked by value for this project.

1. **In-memory module unit tests: `spacetimedb/server/test-utils` with Vitest.** 2.12.0 [#5558](https://github.com/clockworklabs/SpacetimeDB/pull/5558), [#6139](https://github.com/clockworklabs/SpacetimeDB/pull/6139); guide in 2.13.0 [#6245](https://github.com/clockworklabs/SpacetimeDB/pull/6245). Real reducer transactions, view contexts, auth and a deterministic clock and RNG, all without publishing. This could replace the `spacetimedb/server` mock in `test/vitest.config.ts` and move much of the ~60 min maincloud suite in-process. Exports verified in the 2.14.1 `package.json` (`./server/test-utils`, `./server/test-utils/vitest`).
2. **`onSchedule` reducer option.** 2.7.0 [#5435](https://github.com/clockworklabs/SpacetimeDB/pull/5435). Lets us delete the mutable `_runXReducer` / `setRunXReducer` circular-import hack in `spacetimedb/src/tables/identityGcJob.ts`, `lobbyGcJob.ts` and `userDeletionJob.ts`. Usage: `spacetimedb.reducer({ onSchedule: IdentityGcJob }, { job: IdentityGcJob.rowType }, fn)`. The `table({ scheduled })` form still works. **[verified]** (`server/reducers.ts`, `schema.test-d.ts`)
3. **Bring back `if (!ctx.senderAuth.isInternal) throw new SenderError('Forbidden')`** on `run_*` scheduled reducers as defense in depth. Only valid after rebuilding with SDK ≥2.14.0 (#5892). The regression sensor `test/backend/scheduled-reducer-isInternal-rejection.test.ts` already accepts `/Forbidden/i`. Gate: integration test.
4. **`spacetime lock` on the production DB.** 2.7.0 [#4888](https://github.com/clockworklabs/SpacetimeDB/pull/4888). It blocks `spacetime delete` only. It does **not** block `publish --delete-data` ("Lock only prevents deletion, not publishing updates", [#4502](https://github.com/clockworklabs/SpacetimeDB/pull/4502)). Never lock `test1`; `test/global-setup.ts` republishes it with `--clear-database`. Maincloud support is not confirmed.
5. **`spacetime sql --format json`** (2.7.0 #5459) instead of hand-parsing the `|` text table in test helpers. It needs a test-file task.
6. **Automatic reconnect + `withTokenProvider()`** for `lib/spacetimedb-server.ts`. The current `onDisconnect` handler nulls `connectionPromise`, which would race the SDK's own reconnect. The singleton logic has to change if this is adopted.
7. **Migrate client code to camelCase handles** before SpacetimeDB 3.0 (non-test code: 35 refs in 9 files).
8. Procedural-view `.primaryKey()` for `onUpdate` (carried over from 16.5 SK-2).
9. MCP on maincloud / `spacetime mcp` / the official Claude plugin (2.8.2 [#5672](https://github.com/clockworklabs/SpacetimeDB/pull/5672)) for agent access to live DBs.
10. Persistent typed module env (2.12.0 #5887); deterministic `shuffle` (2.13.0 [#6040](https://github.com/clockworklabs/SpacetimeDB/pull/6040)) in place of the hand-rolled hash in `bracketGeneration.ts:287`; reusable TS submodules for rate-limit, retry and cron (2.13.0 [#5903](https://github.com/clockworklabs/SpacetimeDB/pull/5903)), e.g. chat or cursor rate limiting.

---

## 7. Upgrade path and validation plan

### Recommendation: jump straight to 2.14.1

- **Staging adds cost without isolating anything.** Server behaviour from every intermediate release is already live. The two hard breaks are deterministic and caught at install and typecheck. Each extra stage would cost another maincloud republish and another ~60 min integration run.
- **Don't stop at 2.14.0 to avoid the Node bump.** The Node floor is the October 2026 Node security releases, which we want anyway. 2.14.1 also refreshes the CLI's TLS trust after the eMudhra/emSign CA compromise ([#6366](https://github.com/clockworklabs/SpacetimeDB/pull/6366)) and includes the Uuid/branded type fix.

### Sequence (modelled on 16.5; one atomic bump commit + bundle in the publish commit)

| Step | Action | Gate |
|---|---|---|
| 0 | Install Node ≥ 26.12.1. Confirm the Vercel project's Node version (Settings → Node.js Version) meets the floor. | `node -v` |
| 1 | `spacetime version use 2.14.1` (already installed; revert with `version use 2.6.1`) | `spacetime --version` → 2.14.1 |
| 2 | Edit both `package.json`s (R2/R3); `cd spacetimedb && npm install` (updates the vendored tree); root `npm install` | Lockfiles resolve `spacetimedb@2.14.1`, `typescript@5.9.3` |
| 3 | `npm run spacetime:generate` (CLI path, not cargo) | Header reads `cli version 2.14.1`; only `index.ts` differs |
| 4 | `npm run test:typecheck` | 0 errors (scratch: 0) |
| 5 | Apply R5 (subscription cleanup) and R6 (script `onDisconnect`) | typecheck green |
| 6 | `npm test` | 197/197 (scratch: 197/197) |
| 7 | `npm run build` | succeeds (scratch: succeeds) |
| 8 | `npm run spacetime:publish:migrate` → test1. **STOP on any non-empty delta.** Module source is unchanged since the 2026-07-04 republish (`git log` shows 0 `spacetimedb/src` commits since), so an identity migration is expected. A delta would mean the 2.14 SDK emits a different ModuleDef; surface it before applying. Don't pipe `y` into prompts (16.5-03 lesson). | migration output |
| 9 | `npm run test:integration`. Run it **once** in the background and wait ~60 min; never restart or parallelize (16.5-03 lesson, memory `reference_integration_suite_run`). It wipes and reseeds test1. Watch `scheduled-reducer-isInternal-rejection.test.ts` and the `queryPrivateTable` users. | 60 files green |
| 10 | Manual browser UAT with Playwright CLI + DevTools. (a) Toggle offline/online and confirm a single subscription per query (console `[AuthProvider] Stage 1 subscribing` once per real mount; WS frames) and that `isActive` recovers. (b) Fresh guest in a private window: drop the connection and confirm the identity is unchanged. (c) Call a reducer while offline and confirm the UI handles `DisconnectedError`. (d) Optional: Safari/iOS. | UAT pass |
| 11 | Commit 1: pins, lockfiles, vendored tree, bindings, TS bump, R5/R6. Commit 2 (publish): `spacetimedb/dist/bundle.js` (16.5 precedent). Then update `docs/FRONTEND-HANDOFF.md` and the stale `isInternal` comments. | `git show --stat` |
| 12 | Production DB: a separate, user-gated `:migrate` publish. Its drift is unknown. | human checkpoint |

**Rollback:**
- `spacetime version use 2.6.1`
- `git revert` the bump commit
- republish with the 2.6.1 CLI

Server state is unaffected because maincloud is already on the latest server.

---

## 8. Version-by-version index

"Us?" codes: **B** = breaking, affects us · **Bh** = behaviour change for us · **L** = server-side, already live · **A** = adopt-worthy · **N** = not applicable.

| Release (date) | Item | Us? |
|---|---|---|
| [v2.7.0-hotfix3](https://github.com/clockworklabs/SpacetimeDB/releases/tag/v2.7.0-hotfix3) (07-22) | TS camelCase handles + deprecated aliases #5286 | **B** (non-breaking via aliases; TS2589 risk) |
| | Svelte `getConnection` no longer generic #5375 | N |
| | `onSchedule` #5435 · unique/PK via migration #4465 · `sql --format json` #5459 · `lock`/`unlock` #4888 · standalone MCP #5489 | A / L |
| | View backing-table migration #5441 · view cleanup #5503 · metrics · BSATN decode safety #5343 · DML accessor names #5478 | L |
| | TS SDK fixes: Uuid literals #5075, enum PK/index #4389, prefix scans #5428, `Random.fill` #5115, Identity coercion #5041 | Bh (inert) |
| | .NET 10, C++ view PKs, Unreal query builder, C#/Unreal `Find()`, Rust capability traits, C# `RemoteTableName` | N |
| [v2.7.1](https://github.com/clockworklabs/SpacetimeDB/releases/tag/v2.7.1) (07-30) | TS reconnect on refocus/online #5525 | Bh (auto-reconnect only) |
| | Scheduled-reducer drift #5574 · sequence precheck #5561 · V10 defaults #5508 · JWT deps restored #5578 · init task leak #5601 · reducer-error logging #5473 · HTTP/2, CORS cache | L |
| [v2.8.0](https://github.com/clockworklabs/SpacetimeDB/releases/tag/v2.8.0) (08-05) | TS submodules #5486 (`ModuleDef.submodule`) | N (unused) |
| | Composite range scan fix #5479 | Bh (inert) |
| | Scheduled delay metric #5592 · quieter logs #5320 | L |
| [v2.8.1](https://github.com/clockworklabs/SpacetimeDB/releases/tag/v2.8.1) (08-12) | `spacetime mcp` + Codex plugin #5582 | A |
| | `readUInt8Array` copy #5491 · WS decompress-failure handling #5668 | Bh (fix) |
| | v1 WS deadlock #5666 · follower resync | L |
| | Rust string defaults, C# 1024-byte rows, Unity domain reload, C# callback IDs | N |
| [v2.8.2](https://github.com/clockworklabs/SpacetimeDB/releases/tag/v2.8.2) (08-18) | Claude plugin #5672 | A |
| | Accessor-name migrations #5544 | L |
| | C# HTTP timeout, C# buffers | N |
| [v2.8.3](https://github.com/clockworklabs/SpacetimeDB/releases/tag/v2.8.3) (08-25) | Scheduler anchors to intended time #5735 | L |
| [v2.9.0](https://github.com/clockworklabs/SpacetimeDB/releases/tag/v2.9.0) (09-01) | TS identity preserved on auto-reconnect #5761 | Bh (fix) |
| | WS liveness/idle timeout #5517 · commitlog durability #5785 · `[module-http] enabled` (standalone) #5774 | L |
| | .NET host handling, C++ index, Unity, C# SDK cleanup | N |
| [v2.10.0](https://github.com/clockworklabs/SpacetimeDB/releases/tag/v2.10.0) (09-04) | TS mid-session WS errors → `onDisconnect` #5707 | **Bh** (R6) |
| | **JWT impersonation patch** #5866 · MCP on maincloud #5849/#5793 | L / A |
| | C# monomorphization, C++ autoinc macro, `spacetime dev` macOS | N |
| [v2.10.1](https://github.com/clockworklabs/SpacetimeDB/releases/tag/v2.10.1) (09-15) | CLI `list`/`rename`/`mcp` respect `spacetime.json` server #5883 | Bh (CLI) |
| | Concurrent scheduled dispatch, no strict order #5736 | L |
| | C# SDK perf | N |
| [v2.10.2](https://github.com/clockworklabs/SpacetimeDB/releases/tag/v2.10.2) (09-29) | Server auto-reconnect groundwork #5877 · stricter sequences #5880 · canonical namespaces #5967 · replication durability | L |
| | TS ASCII string fast path #5783 · ordered WS decompression #5845 | Bh (fix) |
| | Procedure HTTP gzip/brotli #5698 | N (no procedures) |
| [v2.11.0](https://github.com/clockworklabs/SpacetimeDB/releases/tag/v2.11.0) (10-07) | **Security notice** (see 2.10.0) | L |
| | `describe` human-readable #5947 · full error chains #6046 | Bh (CLI DX) |
| | HTTP-handler auth context #5978 | N (no handlers) |
| | react-ts template `.env.local` #5941; C++ JWT; C# subscriptions; `--root-dir` #6008 | N |
| [v2.12.0](https://github.com/clockworklabs/SpacetimeDB/releases/tag/v2.12.0) (10-13) | **TS automatic reconnect `withAutomaticReconnect`/`withTokenProvider` #5927** | **B/Bh** (forced via React manager, C1) |
| | Module unit testing #5558/#6139 · typed env #5887/#5961/#6004 | A |
| | **HS256 rejected #6100** · duplicate interval schedules #5951 · PG wire auth isolation #6134 · rollback-safe system tables #6004 | L |
| | tsc.exe detection on Windows #6024 · local validation diagnostics #6079 | Bh (CLI) |
| | Procedure HTTP/2 #6012, C# reconnect #5956 | N |
| [v2.13.0](https://github.com/clockworklabs/SpacetimeDB/releases/tag/v2.13.0) (10-21) | Reusable TS submodules #5903 · `spacetime auth` #5251 · deterministic shuffle #6040 | A |
| | Confirmed HTTP durability #6101/#6154 · subscription memory #6113 | L |
| | TS `Result` fix #6148 · procedure HTTP headers #6140 | N (unused) |
| | C# submodules, C# BSATN recursion, template paths, .NET crypto | N |
| [v2.14.0](https://github.com/clockworklabs/SpacetimeDB/releases/tag/v2.14.0) (10-30) | **`isInternal` semantics #5892** | **Bh** (inert for us; enables guards) |
| | Async IDC (#6156 et al.) · `--import-extension` #6097 | A / N |
| | `exactOptionalPropertyTypes` fix #6096 | N |
| | Nested C# submodules #6112 | N |
| [v2.14.1](https://github.com/clockworklabs/SpacetimeDB/releases/tag/v2.14.1) (11-04) | **Node engines floor #6385** | **B** |
| | TLS trust refresh #6366 (CLI) · Uuid/branded types #5971 | Bh (fix) |
| | No DB creation at a supplied identity (`72c350ead`) | L |
| | Nix builds #6344 | N |

npm publish dates match the GitHub release dates (`npm view spacetimedb time`). `latest` = 2.14.1.

---

## 9. Skill update candidates (for whoever owns `.claude/skills/spacetimedb/**`; I made no edits)

The other agent is already adding 2.12+ sections (`how-to-guides.md` §§10–12). These are the items that become **wrong** after the bump:

| Location | Stale claim | Correction |
|---|---|---|
| `SKILL.md:409-451` | "Do NOT add `isInternal` guards… always `false`" | True only for modules built with SDK < 2.14.0. From 2.14.0, `isInternal` = sender is the DB identity, so it is true for scheduled reducers (#5892). |
| `SKILL.md:127` and `references/how-to-guides.md:197-209` | "No built-in reconnect; remount provider via key prop" | 2.12+: `SpacetimeDBProvider` reconnects automatically inside the same `DbConnection` and replays subscriptions. Manual `subscriptionBuilder()` owners must `unsubscribe()` on cleanup. Remounting is unnecessary. (Also, 2.6.1's manager already had a rebuild loop, `#scheduleReconnect`.) |
| ~30 `conn.db.Pascal`/`tables.Pascal` examples in `SKILL.md`, 10 in `references/api-guide.md` | PascalCase handles | Deprecated since 2.7.0 (#5286). Prefer camelCase (`conn.db.lobby`, `tables.viewMyProfile`). |
| `SKILL.md:870` | Baseline "v2.6.1" | 2.14.1 after the phase |
| New | n/a | TS ≥ 5.9 is required for large generated bindings (TS2589). Node floor and `engine-strict`. Scheduled-table `onSchedule`. `isLiveChange` also filters reconnect replays (they arrive tagged `SubscribeApplied`). `useReducer` rejects with `DisconnectedError` while reconnecting. |

---

## 10. Open questions

1. **Vercel Node version.** Does the Vercel project's Node meet `^22.23.4 || ^24.22.1 || >=26.12.1`? There is no `.nvmrc` or `engines` pin beyond `>=24.0.0`, and `.npmrc` `engine-strict=true` makes this fatal.
2. **Rotate `SPACETIMEDB_SERVER_TOKEN`** (and review `ServerIdentity`/admin actions) given the JWT impersonation disclosure for versions before 2.10.0?
3. **Production DB drift.** When was `-production` last published, and with which module source? Its `:migrate` delta may not be empty (16.5-03 saw view drift on test1).
4. **Keep vendoring `spacetimedb/node_modules/spacetimedb`?** The tree grows by about 10 MB of new binary (`portable-datastore-wasm`). Consider gitignoring it, which would be a separate decision.
5. **Handle migration timing.** Move non-test code to camelCase now (9 files) or wait? `test/` (56 files) needs an explicit task.
6. **Should R6 (script `onDisconnect`) be in scope**, given 16.5 D-01's "upgrade-only, minimal edits" rule? I'd include it: the behaviour change comes from the upgrade and affects `global-setup`.
7. **Should we report TS2589 upstream?** The trigger is a large schema on TS < 5.9; I found no existing issue.
8. **Should we re-add `isInternal` guards** in the same phase, or defer them per D-01? I recommend deferring to a follow-up with its own integration gate.
