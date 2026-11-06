# Test Suite

Automated tests for the HSRPVP SpacetimeDB project. 47 integration files + 11 unit files = **58 files / 728 tests**, zero failures, zero skips on the current baseline.

## Structure

```
test/
├── vitest.config.ts                  # Unit test config (no SpacetimeDB needed)
├── vitest.integration.config.ts      # Integration test config — wires globalSetup
├── tsconfig.json                     # TypeScript config for test files
├── global-setup.ts                   # Vitest globalSetup: stdb publish --clear + bootstrap (test only)
├── shared/
│   ├── env.ts                        # backendEnv(): STDB_TARGET=test + .env.test.local via shared/stdb-targets.ts
│   ├── load-env.ts                   # Same, for standalone tmp/uat-*.ts scripts
│   ├── connection.ts                 # SpacetimeDB WebSocket test harness (createTestHarness)
│   ├── fixtures.ts                   # Test data factories and constants
│   ├── helpers/                      # Cross-suite helpers (import from here, don't duplicate)
│   │   ├── drafts.ts · hsrAccounts.ts · lobbies.ts · promoteUser.ts
│   │   ├── queries.ts · scores.ts · seed.ts · tournaments.ts · users.ts
│   └── mocks/
│       └── spacetimedb-server.ts     # Mock for spacetimedb/server (unit tests only)
│                                     # (game seed data lives in data/seed/, seeded by scripts/stdb/bootstrap.ts)
├── data-templates/                   # Canonical templates + default configs
│   ├── characters_template.json · lightcones_template.json · pairing_template.json
│   ├── account-rating-config-defaults.json · elo-config-defaults.json
├── backend/                          # 47 integration files + 11 unit files
│   ├── achievements/                 # auto-award, management (+ checker unit)
│   ├── anonymous-play/               # labels
│   ├── auth/                         # views, security, ban-admin, server-link-provider
│   ├── brackets/                     # advancement, group→elim (+ generation unit)
│   ├── calendar/                     # events, availability, saved
│   ├── chat/                         # messages
│   ├── cost-sets/                    # lifecycle
│   ├── garbage-collector/            # identity-gc
│   ├── lobby/                        # lifecycle, settings, presets, tournament, account-selection,
│   │                                 # disconnect {concede, gc, leave, admin-tools}
│   │                                 # (+ disconnect/slot/flag/ownership unit helpers)
│   ├── match-results/                # lifecycle, score-entry, mmr-stats, rating-admin, referee-coach
│   │                                 # (+ account-rating, elo-calculation unit)
│   ├── match-session/                # draft {classic, auction, control}, post-draft
│   ├── roster/                       # accounts, characters, archetypes, migration, deletion-guard
│   │                                 # (+ helpers unit)
│   ├── season/                       # admin, tournament-player-account
│   └── tournaments/                  # admin, registration, stages, teams, mmr,
│                                     # management, cancel-cleanup
│                                     # (+ helpers, stage-validation unit)
└── frontend/                         # UI component tests (to be added in frontend phases)
```

## Commands

| Command | What it runs |
|---------|-------------|
| `npm test` | Unit tests only (fast, no deps, ~0.5s) |
| `npm run test:watch` | Unit tests in watch mode |
| `npm run test:integration` | Integration tests against test1 (sets `STDB_TARGET=test`, triggers globalSetup; refuses prod) |

Single file: `npm run test:integration -- <path>`

## Prerequisites

### Unit tests
None. `npm test` runs pure-function tests with a mocked `spacetimedb/server`.

### Integration tests
1. `spacetime login` as the account that owns `hsr-spacetimedb-test1` (the publisher becomes the Owner in `init`).
2. Env scheme (ACCESS-SECURITY-OPS §C.2): the database name and host are committed constants in
   `shared/stdb-targets.ts`; the target comes from `STDB_TARGET` (`npm run test:integration` sets `test`;
   anything else is refused). Nothing reads `.env.local` or the legacy `SPACETIMEDB_*` keys.
3. `.env.test.local` holds `STDB_SERVER_TOKEN` + `STDB_SERVER_IDENTITY`, written by
   `npm run stdb:bootstrap:test` (globalSetup runs it, so the file appears after the first run).

## globalSetup behavior

`test/vitest.integration.config.ts` wires `test/global-setup.ts` as Vitest `globalSetup`. It runs **once per suite invocation** before any test file:

1. Requires `STDB_TARGET=test`; `assertNameMatchesTarget` + `assertWipeAllowed` refuse anything but the committed "-test" database.
2. Runs `npx tsx scripts/stdb/publish.ts --target test --clear` (typecheck, then `--delete-data=always --yes=delete-data`, `STDB_TARGET=test` in the CLI environment).
3. Runs `npx tsx scripts/stdb/bootstrap.ts --target test` (registers a fresh delegate, writes `STDB_SERVER_TOKEN` to `.env.test.local`, reseeds data/seed/, achievements, configs, GC jobs).
4. Re-reads `.env.test.local` through `backendEnv()`. The harness reads the token lazily through the same function, so the rotated token is used. **This step is load-bearing** — a stale token fails every server-token call with `Forbidden: caller is not a registered server identity` (Phase 14 Round 9 debug session).

Cost: **~11.5s per suite invocation** (<1% of a 48 min run).

### Skipping globalSetup for single-file iteration

Set `SKIP_DB_CLEAR=1` to bypass the clear+reseed when you're iterating on a single test file and know the DB is already in a clean state:

```bash
SKIP_DB_CLEAR=1 npm run test:integration -- test/backend/chat/chat-messages.test.ts
```

## Adding tests for new features

1. Create a directory under `test/backend/{feature}/`
2. Add `*.test.ts` for integration tests, `*.unit.test.ts` for pure-function tests with no DB
3. Connect via `createTestHarness()` / `createVerifiedTestHarness()` from `test/shared/connection.ts`
4. Use `test/shared/fixtures.ts` for shared constants
5. **Reuse helpers from `test/shared/helpers/`** rather than duplicating query/setup logic — see `queries.ts`, `lobbies.ts`, `tournaments.ts`, etc.

## Suite Runtime Baseline

Historical measurements. The Phase 14 Round 9 entry is the current baseline — any future regression should be measured against it.

| Baseline | Date | Wall-Clock | Files / Tests | Notes |
|----------|------|-----------:|---------------|-------|
| Phase 10.5 | 2026-04-05 | 54m38s | 41 int (486) + 11 unit (187) | SDK 2.0.3, pre-stabilization audit complete |
| Phase 14 interim | 2026-04-09 | 56m57s | 47 int (531) + 11 unit (197) | onApplied + withConfirmedReads(false) + view refactor |
| **Phase 14 Round 9 (current)** | **2026-04-10** | **48m31s** | **47 int (531) + 11 unit (197)** | **globalSetup clears+reseeds before every run; 728/728 pass, 0 skip. Faster than Phase 10.5 — clean DB keeps indexes small.** |

Integration suite: **47 files / 531 tests**. Unit suite: **11 files / 197 tests**. Combined: **728 tests**.

### Hotspot files (≥20 tests — 8 files / 202 tests / 38% of integration suite)

`match-results/mmr-stats` (31), `brackets/bracket-advancement` (28), `lobby/lobby-lifecycle` (28), `achievements/achievement-management` (24), `match-results/match-lifecycle` (24), `match-session/post-draft` (24), `chat/chat-messages` (22), `lobby/lobby-settings` (21).

### Intra-suite state accumulation

Even with globalSetup starting from a clean DB, a single suite run leaks rows into tables that have no cleanup path. Measured on the Round 9 clean-baseline run (531 tests):

| Category | Tables affected | Rate |
|----------|-----------------|-----:|
| Permanent identity leak (no delete on disconnect) | User, UserPrivate, UserIdentity | ~0.59 User/test |
| `AwaitingResult` lobbies (D-48 skips GC) | Lobby, LobbyMember, MatchSession(+Step), MatchResultRecord(+Participant) | ~0.05 Lobby/test |
| Cancelled tournaments (historical records, by design) | Tournament, TournamentEnrolled | ~0.07 Tournament/test |

These are **rooted in backend design choices**, not test bugs. The suite passes cleanly at current scale. If test count doubles (or intra-suite flakes return), options are:
1. Add `afterAll` cleanup hooks to rejection tests (blocked by test-file edit policy — needs explicit task)
2. Call `server_nuke_test_data` reducer through a delegate connection from a periodic mid-suite hook (the old nuke script was removed in M2) (~500ms wipe, 23× faster than the globalSetup path)
3. Move integration tests off maincloud to a local/staging instance

Full root-cause investigation and per-table leak counts: `.planning/phases/14-test-harness-modern/14-DEBUG-SESSION.md`.

## Reset sequence

Normally unnecessary — `globalSetup` handles clear+reseed automatically. Only run manually if globalSetup itself is failing or you need a bare-metal reset outside of vitest:

1. `npm run stdb:publish:test:clear` (test only; add `-- --dry-run` to print the command)
2. `npm run stdb:bootstrap:test` (delegate + seed in one step, also rotates the server token)
3. `npm run stdb:generate` if the schema changed, then review `git diff --stat web/src/module_bindings`
4. `SKIP_DB_CLEAR=1 npm run test:integration`

Fast wipe of non-seed state (keeps characters/lightcones/configs intact):
call the `server_nuke_test_data` reducer (`confirmation: 'NUKE_TEST_DATA'`) through a delegate connection;
it rejects on any database whose `STDB_TARGET` is not `test`.
