---
name: uat
description: "Verification layer for the 3-layer development process (contract -> architecture -> verify). Governs behavior specs, test integrity, and failure diagnostics. Use whenever working with behavior specs, writing or running tests, bootstrapping after a database reset, or when an agent needs the intended behavior for a feature. Also trigger when the user mentions contract.md, architecture.md, docs/{feature}, vitest, test:integration, test:phase, UAT session, writing tests, post-publish bootstrap, or test failure diagnosis. Trigger keywords: uat, behavior spec, acceptance scenario, test, smoke test, integration test, test coverage, post-publish, npm test, npm run test:integration, vitest, Given/When/Then, contract.md, UAT session."
---

# UAT -- Verification Layer

This skill governs the verification layer of the project's 3-layer development process:

| Layer | Location | Defines |
|-------|----------|---------|
| **Contract** | `docs/{feature}/contract.md` | WHAT should happen -- acceptance scenarios, edge cases, error messages |
| **Architecture** | Code + `docs/{feature}/architecture.md` | HOW it's built -- tables, reducers, data patterns |
| **Verification** | `test/**/*.test.ts` | COMPARE -- does the architecture match the contract? |

Tests are the comparison mechanism. When a test fails, it reveals a gap between what was agreed upon (contract) and what was built (architecture). The user triages each gap: fix the architecture (bug) or update the contract (direction change).

## Reference Files

Read the appropriate reference when doing specific tasks:

| Task | Read this |
|------|-----------|
| Writing vitest tests or UAT harness scripts | `references/test-writing-guide.md` |
| Running a UAT session (manual, step by step) | `references/uat-verification-guide.md` |
| Looking up feature specs, test files, or coverage | `references/test-index.md` |
| Creating or updating a `contract.md` | `references/workflow-doc-template.md` |

---

## Process Integrity

CLAUDE.md defines the core guardrails (test code is user-controlled, never modify specs during execution, failures are diagnostic). This section explains the reasoning and edge cases that make those rules work.

### Why Test Code Is User-Controlled

The 3-layer process depends on tests being an independent verification of contract vs. architecture. If the agent writing the code also writes or fixes the tests, both sides of the comparison are controlled by the same entity -- failures can be silently papered over. That's why test code requires an explicit user task.

**What you CAN do without approval:** Read any test file, research how a test could be written, suggest changes with code snippets, identify coverage gaps, propose new test scenarios.

**What you CANNOT do without explicit user instruction:** Write, modify, delete, or rename any file under `test/`.

**Generation exception:** A test-writing task the user explicitly asked for (a named T-task of a step) is an explicit user task -- the user has approved test creation by assigning it. During generation, fixing your own syntax mistakes before the test is accepted doesn't violate verification integrity. Once tests exist in the repo and you're running them to compare contract vs. architecture, these rules fully apply.

### Why Failures Are Diagnostic

A test failure means the architecture doesn't match the contract. That gap IS the information. The user triages each failure:
- **Architecture bug** -- the code doesn't do what the spec says -> fix the code
- **Direction change** -- the spec needs updating to reflect new intent -> update the contract

On any test failure, you must:
1. Report the full failure output (test name, assertion message, expected vs actual)
2. Identify which behavior spec scenario the failing test maps to
3. Note whether the failure is in the test logic or the backend implementation
4. Log a summary using this format:

```
## Test Run Results -- {feature} -- {date}

### Failures ({count})

| Test | Spec Scenario | Failure | Category |
|------|--------------|---------|----------|
| {test name} | {spec section reference} | {expected vs actual} | test-logic / backend-bug / env-issue |

### Errors ({count})
{Stack traces or connection errors -- raw, unedited}

### Passing ({count})
{Summary only}
```

**Category definitions:**
- **test-logic** -- The test itself may have a bug (wrong assertion, stale fixture, race condition)
- **backend-bug** -- The backend behavior doesn't match the spec; the test is correct
- **env-issue** -- Connection failures, missing env vars, database not published, timeout

After reporting, you may offer analysis but do not act without the user's go-ahead.

### Every Fix Must Mirror Real User Flows

After implementing ANY fix, answer this: "Is this how a real user would interact with the reducers, or am I just making tests pass?"

A test that passes for the wrong reasons is worse than a test that fails. If your fix requires data, access patterns, or call sequences that a real client would never use, the fix is wrong.

Mandatory checklist after every fix:
- Does the data come from public subscription tables a real client would have?
- Does the call sequence match real usage (connect -> login -> subscribe -> call reducers)?
- Am I filtering/querying data the same way the frontend would?
- If I added a helper, would a real client have equivalent access?

If the answer to any is "no", stop. Re-examine the fix.

---

## The Spec Contract

Every backend feature has a behavior spec at `docs/{feature}/contract.md`. This is the single source of truth for expected behavior.

### Lifecycle

```
Planning (decision recorded in DECISIONS.md)
  -> User approves behavior spec updates          [source: DECISIONS.md Axx]
    -> Spec becomes the acceptance criteria
      -> Execution builds code (may add beyond spec)
        -> Claude updates contract with additions  [source: Phase <step> execution]
          -> UAT session: tests, runs them, reports results
            -> User reviews execution-sourced entries + test results
              -> User approves, modifies, or rejects additions
```

### Rules

1. Specs update after phase discussions, when new decisions are finalized -- not during execution
2. Never modify behavior specs during execution. If a spec has gaps, report what you would write but stop
3. After execution, update the contract with provenance (see Provenance Tracking below)
4. Each acceptance scenario maps to at least one test case
5. Specs describe WHAT should happen, not HOW
6. Track coverage honestly: "complete" = every reducer has acceptance scenarios, error paths, and permissions documented

For the full template, read `references/workflow-doc-template.md`. Reference example: `docs/tournament/contract.md`.

### Provenance Tracking

Every entry in a contract's Phase History table identifies where the decision came from:

| Source pattern | Meaning |
|---------------|---------|
| `DECISIONS.md Axx` | User-approved decision |
| `step Sx` / `step Mx` (planning) | Established while planning the step |
| `Phase <step> execution` | Claude-added during implementation |

**Rule of thumb:** If the reducer or behavior is covered by a decision (even at a high level), cite that decision id -- specific error messages and edge cases inherit the parent reducer's provenance. Tag as `execution` only for supporting reducers the user never mentioned.

During a UAT session (or when reviewing the step's `docs/log/<date>-<step>.md` doc checklist), the user reviews execution-sourced entries and approves, modifies, or rejects them.

### Centralized Doc Pattern

Each backend feature has documentation under `docs/{feature}/`:

| Location | Contains | Update when |
|----------|----------|-------------|
| `docs/{feature}/architecture.md` | Table diagrams, reducer reference, data patterns | Backend code changes |
| `docs/{feature}/contract.md` | Acceptance scenarios, edge cases, phase history | A decision is recorded; after execution with provenance tags |

Architecture docs cross-reference behavior specs. No duplication between them.

---

## Workflow per step

| Stage | Layer | What happens |
|---|---|---|
| Planning (`grill-me`, decision recorded in `DECISIONS.md`) | Contract | Produces decisions -> user approves spec updates |
| Executing an agreed step | Architecture | Builds the code -- does not modify contract during execution |
| Post-execution | Contract | Claude updates contract with additions, tagged `Phase <step> execution` in Phase History |
| UAT session | Verification (manual) | Manual harness UAT -- exercise reducers step-by-step, confirm with user |
| Explicit test-writing task | Verification (automated) | Write vitest files from confirmed-correct behavior |
| `npm test` | Verification (regression) | Run existing tests -- failures are diagnostic |

**Per-step order:** Always the manual UAT session first, then the test-writing task. Manual UAT finds bugs while context is fresh. Automated tests lock in the confirmed behavior afterward.

---

## Running Tests

| Command | What it runs | When to use |
|---------|-------------|-------------|
| `npm test` | Unit tests only (fast, no deps) | After any code change |
| `npm run test:integration` | Integration tests against test1 (sets `STDB_TARGET=test`; wipes + bootstraps test1 in globalSetup; refuses prod) | Once per release (energy rule) |
| `SKIP_DB_CLEAR=1 npm run test:integration -- test/backend/{feature}` | Single feature tests, no wipe | During feature development |
| `npm run test:watch` | Unit tests in watch mode | During active development |

After running any test command, always produce the failure report format from Process Integrity, regardless of whether you were explicitly asked. If all tests pass, "All {count} tests passing" is sufficient.

---

## Cold Start Smoke Test (Maincloud)

This project publishes to SpacetimeDB maincloud (hosted). No local server to start/stop.

1. **Publish** -- `npm run stdb:publish:test` (add `-- --dry-run` to print the command first)
2. **Check logs** -- `spacetime logs hsr-spacetimedb-test1 --server maincloud --no-config`
3. **Basic query** -- `spacetime sql hsr-spacetimedb-test1 "SELECT COUNT(*) AS n FROM user" --server maincloud --no-config`

Do NOT include `spacetime start` or "kill the server" -- maincloud is always running. Only wipe (`npm run stdb:publish:test:clear`, test only) when the plan explicitly requires it. Every target comes from `--target` / `STDB_TARGET` (`test` | `prod`); database names live in `shared/stdb-targets.ts`.

## Post-Publish Bootstrap

After every wipe publish (`npm run stdb:publish:test:clear`):

```bash
npm run stdb:bootstrap:test
```

Auto-bootstraps: `init` has already registered the publisher as Owner + SYSTEM user -> bootstrap mints a fresh identity -> `server_register_delegate` (as Owner) -> writes `STDB_SERVER_TOKEN` + `STDB_SERVER_IDENTITY` to `.env.test.local` -> seeds game data from `data/seed/` JSONs, achievements, configs, GC jobs. Re-seed alone: `npm run stdb:seed:test`.

---

## Known Limitations

### `sync()` is a naive sleep

The test harness's `sync(ms?)` method is a `setTimeout` wrapper, not a real subscription sync. It defaults to 500ms, which is usually enough, but:

- It can cause flaky tests under load -- the cache may not have updated in time
- There's no "wait until the subscription confirms this row exists" primitive yet
- **Workaround:** Increase the sleep duration for tests that depend on seeing rows immediately

When SpacetimeDB adds a subscription sync primitive, `sync()` should be replaced. Treat flaky tests that pass on retry as a `sync()` timing issue -- categorize as **test-logic** in failure reports.

### Maincloud disconnect detection delay

`conn.disconnect()` closes the WebSocket, but maincloud can take 30-60 seconds to detect the closure and fire `clientDisconnected`. This means `User.isOnline` stays `true` long after disconnect.

- **Workaround:** Call `server_set_online({ userId, isOnline: false })` via a server-token connection to force the flag immediately
- **Helper pattern:** See `test/backend/garbage-collector/identity-gc.test.ts` for the `setOnline()` helper
- **When it matters:** Any test that runs GC, checks offline status, or tests disconnect-triggered behavior

---

## Test Structure

```
test/
├── shared/
│   ├── connection.ts   # Test harness (createTestHarness, createVerifiedTestHarness)
│   ├── fixtures.ts     # Data factories
│   ├── helpers/        # Shared reducer arg helpers (Phase 10.5)
│   └── mocks/
├── data/               # GITIGNORED -- raw game data JSONs
├── data-templates/     # COMMITTED -- shows expected JSON structure
├── backend/{feature}/  # Feature tests (.test.ts files)
└── frontend/           # Future (v1.0)
```

For the full file inventory, feature index, and shared helpers reference, see `references/test-index.md`.
For harness API details and test writing patterns, see `references/test-writing-guide.md`.
