# Test Suite

Four layers (CLAUDE.md §6). Counts measured at M9 (2026-11-13):

| Layer | Where | Runs against | Files / tests |
|---|---|---|---|
| Unit | `test/backend/**/*.unit.test.ts`, `shared/**/*.test.ts` | nothing (pure functions; `spacetimedb/server` mocked) | 21 / 432 |
| In-memory module tests (the default verification layer) | `spacetimedb/src/__tests__/*.test.ts` | the module in-process, no network | 108 / 2173 (2157 pass, 1 skipped placeholder, 15 todo) |
| Web (M9) | `web/src/**/*.test.{ts,tsx}` | jsdom, no network | 7 / 125 |
| Live residue | `test/live/*.test.ts` | `hsr-spacetimedb-test1` only, once per release | 7 / 40 (+ 3 todo) |

`npm test` runs the first two, then the frontend tests (below), and never touches maincloud. The old live suite (61 integration files under `test/backend/`) was ported to the in-memory harness in S10 and deleted; see `docs/log/2026-11-09-s10.md` for the file-by-file map.

## Structure

```
test/
├── vitest.config.ts                  # unit config: test/backend/**/*.unit.test.ts + shared/**/*.test.ts; spacetimedb/server → shared/mocks
├── vitest.integration.config.ts      # live residue config: test/live/**/*.test.ts; wires globalSetup (test1 wipe + bootstrap)
├── tsconfig.json                     # mirrors the @module/<kind>/<domain> aliases of tsconfig.base.json (A72)
├── global-setup.ts                   # vitest globalSetup: stdb publish --clear + bootstrap, test target only
├── shared/
│   ├── env.ts                        # backendEnv(): STDB_TARGET=test + .env.test.local through shared/stdb-targets.ts
│   ├── load-env.ts                   # same, for standalone tmp/uat-*.ts scripts
│   ├── connection.ts                 # WebSocket harness for the residue: createTestHarness, expectReducerError, queryPrivateTable, hasServerToken
│   ├── two-identity-harness.ts       # two connections in one test (lifecycle, smoke)
│   ├── fixtures.ts                   # constants shared by the unit tests
│   └── mocks/spacetimedb-server.ts   # mock of spacetimedb/server (unit tests only)
├── data-templates/                   # canonical templates + default configs (verification never reads gitignored data)
├── backend/<feature>/                # 11 *.unit.test.ts: achievements, lobby helpers (4), match-results (2), roster, seed round trip, tournaments (2)
├── live/                             # the residue, 7 files + _helpers.ts (below)
└── frontend/                         # screenshots per page (CLAUDE.md §4)

spacetimedb/vitest.config.mts         # in-memory config (single '@module' alias, real spacetimedb/server)
spacetimedb/src/__tests__/            # one folder per subject (lobby, match-session, tournaments, views, ...), harness/smoke, shared builders in fixtures/; old step-named files: docs/log/2026-11-10-t-reorg.md
```

## Commands

| Command | What it runs | Cost |
|---|---|---|
| `npm test` | unit, in-memory, then web, in that order | ≈ 35 s, no network |
| `npm run test:web` | the frontend tests alone | ≈ 3 s, no network |
| `npm run test:watch` | unit tests in watch mode | — |
| `npx vitest run --config spacetimedb/vitest.config.mts <name filter>` | one in-memory suite, e.g. `s10-lobby` | seconds |
| `npm run test:integration` | the live residue on test1; **globalSetup wipes and re-bootstraps test1 first** | ≈ 5 min nominal, ≤ 7 min worst, cap 15 min (§D.5) |

`npm run test:integration` is a release step, never run unasked: it is a `spacetime publish --clear` of test1 (a user gate), it costs maincloud energy, and the residue's first run is S11 (test1 is stale until that clear-publish). Single residue file: `npm run test:integration -- test/live/smoke.test.ts`; `SKIP_DB_CLEAR=1` skips the wipe when test1 is known clean.

## Frontend tests (M9)

- **Where:** next to the code in `web/src/` as `*.test.ts` / `*.test.tsx`: pure helpers next to the helper, route behaviour in `web/src/routes/routes.test.tsx`, page rendering in `web/src/pages/splash.test.tsx`. Config `web/vitest.config.ts`: jsdom, the `@` / `@shared` / `@bindings` aliases of `vite.config.ts`, CSS Modules as stable class-name proxies, setup `web/src/test/setup.ts` (jest-dom matchers, cleanup, `VITE_STDB_TARGET=test`).
- **Run:** `npm run test:web` from the repo root (it is also the third suite of `npm test`).
- **Helper:** `renderWithRouter(path, auth)` in `web/src/test/renderWithRouter.tsx` renders the real `App` (`web/src/App.tsx`, which takes an optional `router`) and route tree with a memory history and a given auth snapshot (`AUTH.visitor`, `guest`, `member`, `tournamentHost`, `moderator`, `admin`, `notReady`) and, after each test, unmounts, resets the auth store and blanks `document.title`. Change auth mid-test with `setAuthSnapshot` inside `act`.
- **No network:** no `DbConnection`, no maincloud, no fetch; a connection mock comes with M6. The router plugin is not loaded, so a test run never rewrites `routeTree.gen.ts`; test files under `web/src/routes/` stay out of the route tree through `routeFileIgnorePattern` in `vite.config.ts`.
- **CI:** `.github/workflows/ci.yml` runs typecheck, `lint:ci`, `npm test`, the web build and `check:patterns` on every push to `main` and every pull request. Signal only, no secrets.

## In-memory harness (how the s*-suites work)

`createModuleTestHarness()` loads the module in-process. Facts that bite (full list: `docs/log/2026-11-06-s4.md`, helpers: `spacetimedb/src/__tests__/fixtures/harness.ts`):

- Call reducers inside `withReducerTx(auth, ctx => M.reducer(ctx, args))`; read `test.db` only **outside** a transaction (reading inside crashes the datastore).
- Views are functions: `(M as any).view_x(test.viewContext(auth), {})`.
- `ctx.env` throws (`env_get` stub), so `server_set_datetime` / `_online` / `_mmr` / `_nuke_test_data` (gated by `requireTestDatabase`) cannot run in memory; that is the one skipped test in `harness/smoke`. `server_link_provider`, `server_delete_user`, `server_set_role` and `seed_identity_gc_job` run as `'internal'`.
- Roles are set through `test.db` (`setUserRole` / `setRole`), never `server_set_role`; `'internal'` is Owner and passes the admin gates.
- Scheduled reducers are fired by hand; the clock moves with `advance(test, ms)` (timers validate elapsed time; chat throttle = 2.1 s per send).
- Seats, not user ids: `seatOf(src, lobbyId, userId)` for every `targetJoinSeq` / `bannedJoinSeq` (A74).
- Two `Range` classes exist: never `new Range()`. A missing row's `find()` returns `null`.
- Every `it` cites its contract clause or decision id. Failures are diagnostic: report them, the user triages (architecture bug vs direction change).

## Live residue (`test/live/`)

What the in-memory harness cannot drive (ACCESS-SECURITY-OPS §D.5): subscriptions and their isolation, lifecycle hooks over the wire, scheduler timers actually firing, the module environment, the engine-level rejection of external calls to scheduled reducers.

| File | Covers |
|---|---|
| `isinternal-rejection` | the five `run_*` scheduled reducers reject an external low-level `callReducer` (guest harness): an empty argument buffer (engine "no such reducer") and a correctly encoded job row (engine or the module's `ensureScheduler` "Forbidden"; the log names the layer; S11a M2) |
| `auth-subscriptions` | anonymous `view_my_profile` = 0 rows, own row after `login_as_guest`; SEC-01b (private tables have no client accessor, raw subscriptions refused, the refusal about the table, not a syntax error); own `User` row refused (A77, S11a) |
| `lifecycle-grace` | A22a / A68: refresh inside the 15 s grace moves nothing; a drop past it moves referee and host; `leave_lobby` in Drafting = away |
| `scheduler-chains` | `admin_delete_row('User')` → `run_user_deletion` fires on its own (D-17); one `identity_gc_job` and one `lobby_gc_job` row after bootstrap; finalize chain todo |
| `server-reducers` | the four env-gated `server_*` reducers accepted with the server token, rejected for a plain client; nuke and prod-side rejection as todo |
| `smoke` | bootstrap invariants (cost set 0, characters, achievements), a two-identity lobby with seats [1, 2], a cursor broadcast in a started 1v1 draft reaching the other member (a cursor in Waiting is dropped, S11a L19) |
| `outsider-isolation` | one Ranked anonymous 1v1 with a spectator, conceded in Drafting (triage L110): per-sender lobby, match and history views empty for an outsider over a real subscription, views with arguments subscribed by name, an unmapped identity sees nothing, anonymized seats carry `userId 0` on the wire |

Prerequisites: `spacetime login` as the owner of test1; `.env.test.local` with `STDB_SERVER_TOKEN` (written by `npm run stdb:bootstrap:test`, which globalSetup runs). Key names only: never read or commit `.env*.local`. `it.skipIf(!hasServerToken())` guards the token-dependent tests.

globalSetup (`test/global-setup.ts`): requires `STDB_TARGET=test`, refuses anything but the committed "-test" database, runs `scripts/stdb/publish.ts --target test --clear` then `scripts/stdb/bootstrap.ts --target test`, re-reads the rotated token through `backendEnv()`. ≈ 12 s.

## Adding tests

Test files change only under an explicit T-task of a step (CLAUDE.md §6).

1. Default: an in-memory suite `spacetimedb/src/__tests__/<step>-<topic>.test.ts`; import helpers from the existing fixtures files instead of copying them.
2. Pure helpers: `test/backend/<feature>/<name>.unit.test.ts` or next to the code under `shared/`.
3. Live only for the §D.5 categories, under `test/live/`, with a runtime estimate in the header; the residue stays ≤ 10 files / ≤ 15 min.
4. Verification needs no gitignored data; use `test/data-templates/` or `data/seed/` (A18).

## Reset sequence (manual; each publish is a user gate)

1. `npm run stdb:publish:test:clear` (test only; `-- --dry-run` prints the command)
2. `npm run stdb:bootstrap:test` (delegate + seed, rotates the server token)
3. `npm run stdb:generate` if the schema changed, then review `git diff --stat web/src/module_bindings`
4. `SKIP_DB_CLEAR=1 npm run test:integration`

Fast wipe of non-seed state: the `server_nuke_test_data` reducer (`confirmation: 'NUKE_TEST_DATA'`) through a delegate connection; it rejects on any database whose `STDB_TARGET` is not `test`.

## Live layer notes (carried from the retired `uat` skill, 2026-11-11)

- **After a wipe publish** (`npm run stdb:publish:test:clear`, user gate): run `npm run stdb:bootstrap:test`. `init` has registered the publisher as Owner and created SYSTEM; bootstrap mints a server identity, registers it as delegate, writes `STDB_SERVER_TOKEN` / `STDB_SERVER_IDENTITY` to `.env.test.local`, then seeds `data/seed/`, achievements, configs and the scheduled jobs. Re-seed alone: `npm run stdb:seed:test`.
- **Smoke check after a publish**: the module log (`spacetime logs <db> --server maincloud --no-config`) shows no error, and one count query answers.
- **`sync()` in the live harness is a fixed sleep** (500 ms by default), not a subscription acknowledgement. A live test that passes on retry is a timing problem of the test, not of the module.
- **Disconnect detection is slow on maincloud**: after `conn.disconnect()` the server may take 30 to 60 s to fire `clientDisconnected`. Tests that need a user offline at once set it through a server-token connection (`server_set_online`).

## Guided walk-through with the user (S11b)

Used only when the user asks to watch a flow on the live test database. One step at a time:

- State who does what to whom, call the reducer, then show the affected rows as a markdown table with changed values in bold.
- One short sentence under the table: who called which reducer and which field changed from what to what.
- The same coloured marker per user or team across all tables of the session.
- Refusals: one summary table (caller, action, error text) and one final snapshot showing nothing changed.
- Stop after each step and wait for the user.
- Every query costs energy and `User` is private from S11a: read through views or the server-token connection, and keep the number of queries small.
