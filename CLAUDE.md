# hsr-pvp-spacetime

Honkai: Star Rail PvP drafting and match site. Vite + React SPA in `web/`, SpacetimeDB 2.14.1 TypeScript module in `spacetimedb/`, static hosting on Vercel Hobby plus one auth function. Decisions: `DECISIONS.md` (append-only). Step status: `ROADMAP.md`.

Migration in progress: `ROADMAP.md` lists which steps have landed; a path or script tagged (Mx)/(Sx) exists only after that step.

## 1. Repo map and databases

| Path | Holds |
|---|---|
| `web/` | Vite + React 18 + TanStack Router app; `src/module_bindings/` is the one committed bindings copy (M3) |
| `spacetimedb/` | the module: `src/`, in-memory tests (S10) |
| `shared/` | pure TS used by both sides: `stdb-targets.ts`, `scoring/`, `bracket/`, `lobby-rules/`; no runtime import of `spacetimedb` or `react` (M2, S7, S8) |
| `api/auth/discord/` | the one Vercel function pair (M5) |
| `scripts/stdb/` | publish, bootstrap, seed, generate, describe, manage-user, backup, restore; all take `--target test\|prod` (M2) |
| `data/seed/` | public reference data: characters, light cones, synergies, achievements (A18) |
| `test/` | live residue + harness, `frontend/screenshots/<page>/` |
| `docs/` | `<feature>/{contract,architecture}.md`, `ERD.md`, `frontend/`, `research/`, `log/<date>-<step>.md` |
| `design/` | local only, gitignored (A53): `DESIGN.md`, `UI-DECISIONS.md`, frozen `mockups/*.html`, `assets/`; mirror of the Open Design project |
| `tools/` | `energy-model.js`, `capture-ws-frames.ts` |

Two databases: `hsr-spacetimedb-test1` and `hsr-spacetimedb-prod`. The names live in `shared/stdb-targets.ts` and are never typed by hand in code or scripts. Every `spacetime` CLI call carries `--server maincloud --no-config`; prefer the `stdb:*` scripts over raw CLI calls.

## 2. Energy rules

- Budget: **100,000 TeV/month**, Free tier with a permanent referral bonus. The cap is hard: no pay-as-you-go, no point-in-time backups (A16, A41).
- Egress is the dominant cost; every subscription is a bandwidth decision.
- No load tests, ever. The live suite runs on test1 only, once per release, never in parallel.
- `npm test` must never touch maincloud.
- Page PRs report the dev egress meter numbers.

## 3. SpacetimeDB core rules

1. **Reducers are transactional**: they do not return data to callers. Read data through views and subscriptions, not reducer return values.
2. **Reducers are deterministic**: no filesystem, network or timers. `ctx.random()` and `ctx.newUuidV4()` are allowed; `Math.random` is not.
3. **`ctx.sender` is the authenticated principal**: never trust identity arguments.
4. **Auto-increment ids are not sequential**: gaps are normal; never use them for ordering.
5. **Egress first**: consider bandwidth when designing any table, view or feature.
6. Do not invent SpacetimeDB APIs; use only what exists in the docs, the installed SDK or this repo.
7. Publishing always goes through the `stdb:publish:*` scripts, never the default server of `spacetime server list`. A database's dashboard is `https://spacetimedb.com/@<username>/<database-name>`.

**Editing behavior:** make the smallest change necessary; do not touch unrelated files, configs or dependencies; do not add restrictions the task didn't ask for (if "users can do X", implement X for all users).

## 4. Frontend rules

- Subscribe only to **views and the public reference set**. `subscribeToAllTables` is banned in `web/` (CI grep).
- No page except the **admin Users tab** subscribes the `User` table; names and avatars are denormalized into the views that need them (PAGE-MAP D2).
- One subscription per table per route; keep the handles and unsubscribe on route leave. The reference set is subscribed by the first route that needs it and kept for the session; `/` and `/profile` never trigger it.
- Match views and cursor events subscribe only once the lobby stage is past Waiting; cursor events are consumed via `onInsert`.
- Styling: CSS Modules + `web/src/styles/tokens.css` (from `design/DESIGN.md`); no Tailwind; no repeated inline SVG.
- Breakpoints: the shared `@custom-media` scale **480 / 560 / 768 / 1040 / 1120 / 1320** (A49a). Snap mockup values to the nearest step and record the snaps in the PR; a layout that visibly breaks at a snapped width keeps its value as a page-local custom media query.
- One responsive page per screen; no mobile-only routes or component trees (A13).

**Screenshot loop (Playwright CLI).** Any edit that changes rendered output ends with a screenshot + Read before the task is reported complete: typechecks prove syntax, screenshots prove what the user sees. Use `playwright-cli` in its default mode only.
1. Ensure `npm run dev` is running.
2. `playwright-cli open http://localhost:<port>/<route>` (once per session).
3. Screenshot at desktop width and at **390 px**: `playwright-cli screenshot --filename test/frontend/screenshots/<page>/<name>.png`. Throwaway shots go to `tmp/pw/`.
4. Read the PNG; compare it to the frozen mockup in `design/mockups/` or the task intent; iterate if wrong.
5. `playwright-cli close` at the end of the session.

Skip it for backend-only edits, pure refactors with no visual delta, and utility/hook/type changes below the component level: if a grep can prove it, skip the screenshot.

## 5. Env scheme

| Concept | Name | Values / notes |
|---|---|---|
| Target id | `test` \| `prod` | the only two strings that parse |
| Databases (committed constants) | `STDB_DATABASES.test = hsr-spacetimedb-test1`, `.prod = hsr-spacetimedb-prod` | in `shared/stdb-targets.ts`; not env vars; no fallback |
| Host / server | `wss://maincloud.spacetimedb.com` / `maincloud` | constants |
| Node-side target | `STDB_TARGET` env **or** `--target` CLI flag (flag wins) | scripts, vitest configs, test harness |
| Browser target | `VITE_STDB_TARGET` | Vercel Preview = `test`, Production = `prod`; `.env.development` = `test` |
| Server token | `STDB_SERVER_TOKEN` | same key name, **different file per target** |
| Secret files | `.env.test.local`, `.env.prod.local` | gitignored by `.env*.local`; nothing reads `.env.local` |
| Auth function secrets | `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `AUTH_SECRET`, `STDB_SERVER_TOKEN` | Vercel env per environment; never in the repo |
| Module env (D-C1) | `STDB_TARGET` declared in `schema({...}, { env: { STDB_TARGET: t.enum('StdbTarget', ['test','prod']) } })` | the publish script spawns `spacetime publish …` with `STDB_TARGET=<target>` in the **process environment** (`publishArgs(...).env`). Note: the CLI's `--env <name>` flag selects a `spacetime.<name>.json` config file, it does not set a value (2.14.1 `publish --help`) |
| npm scripts | `stdb:publish:test`, `stdb:publish:test:clear`, `stdb:publish:prod`, `stdb:bootstrap:<t>`, `stdb:seed:<t>`, `stdb:describe:<t>`, `stdb:generate`, `test:integration` (test only) | all call `scripts/stdb/*.ts --target …` |

**Never read `.env*.local` values; key names only.** Never delete or commit `.env` / `.env*.local`.

## 6. Tests

- Test files (`test/`, module and web test files) are the verification layer: do not create, edit, delete or rename them without an explicit task (a named T-task of a step). Reading them and proposing changes is fine.
- Failures are diagnostic: report them, never auto-fix. The user triages each one as an architecture bug (fix the code) or a direction change (update the contract).
- In-memory module tests are the default; the live residue (subscriptions, lifecycle hooks, scheduler, outsider isolation) runs on test1 only, once per release.
- If verification needs gitignored data, the verification is wrong: use a fixture under `test/data-templates/`.

## 7. Docs

- `docs/<feature>/architecture.md`: tables, keys, indexes, reducer reference. **Update it with every backend change.**
- `docs/<feature>/contract.md`: Given/When/Then scenarios, edge cases, integration points, Phase History. Template: `.claude/skills/uat/references/workflow-doc-template.md`; reference example: `docs/tournament/contract.md`.
- **Never modify a contract during execution.** After execution, add the new entries and tag each one `Phase <step> execution` in Phase History so the user can tell their decisions from Claude's. User decisions cite their `DECISIONS.md` id.
- Every executed step writes `docs/log/<date>-<step>.md`: goal, decisions implemented, files changed, done-check and test results, deviations, and a doc checklist (per touched `docs/<feature>/`: architecture / contract / both / skip with reason). The step is not done until the checklist is answered.
- Architecture docs cross-reference contracts; no duplication between them.
- Frontend: `docs/frontend/pages.md` per ported page; a `design/DESIGN.md` §11 delta per page.
- New decisions are appended to `DECISIONS.md`; existing entries are never edited.

## 8. Git

- Commit only when asked. Branch per feature; commits land on the feature branch.
- **Never `git add -f` / `--force`**, for any reason.
- Never commit `notes/`, `tmp/`, `backups/`, `.env*`, or anything under `test/data/`. Transform scripts for gitignored data live in `tmp/` and run locally, never committed.
- Test files change only under an explicit task (§6).
- Worktrees spawn from the last commit: uncommitted changes are invisible to them.
- Prod publish only through `stdb:publish:prod`, after the release checklist (ACCESS-SECURITY-OPS §C.5).

**When executing an agreed step**, don't pause for: commits on the feature branch, routine git reads, file writes inside the step's scope, builds, tests and seed scripts, approach choices reversible within the session. **Do pause for:** file, branch or worktree deletion; force operations (`push --force`, destructive `reset --hard`, `--no-verify`); pushes, PRs, deploys, every `spacetime publish` and any maincloud write; dependencies not already pinned; deviations from a decision; real problems (unexpected paths in a commit, hook rejections, unexpected test failures, merge conflicts). Planning and design conversations are not execution: there, asking is the work.

## 9. Skills

Load the relevant skill before writing code: **`spacetimedb`** for anything touching tables, reducers, views, schema, publishing or bindings; **`frontend-design:frontend-design`** (plugin) for UI components, pages, layouts and styling.

| Skill | Purpose |
|---|---|
| `spacetimedb` | backend patterns, API reference, guardrails |
| `frontend-design:frontend-design` | plugin: intentional visual design for UI work |
| `grill-me` | planning: interrogates a plan before a step starts |
| `uat` | behavior specs, test integrity, UAT and failure diagnostics |
| `vercel-setup` / `vercel-deploy` / `vercel-logs` | Vercel CLI project setup, deploys, logs |
| `pr-description` | PR descriptions |
| `severity-review` | code review at varying depth |
| `security-scan` | security review of changes |
| `humanizer` | plain-language rewrite of prose |
| `skill-creator:skill-creator` | plugin: create and improve skills |
| `simplify` | review changed code for reuse and efficiency |

## 10. UAT format

During a UAT session, present ONE test at a time in this format:

```
**STEP N: {who} does {what} on {whom}**

| col | col | col |        ← spacetime sql output as a markdown table
|-----|-----|-----|
| val | val | **changed** | ← bold changed values

{who} ({role}) called `{reducer}` on {target}: {field} changed from `old` → `new`.
```

- `spacetime sql` after EVERY state-changing reducer call, no exceptions; tables grow as rows accumulate (show the full table each step).
- Give participant/team/user ids colored markers (🔴🔵🟢🟡🟣🟠), the same color across all tables.
- Rejection tests: one summary table (`caller | action | error`) and one final snapshot proving no state changed.
- After all steps show a checkpoint box and wait for the user. One test per checkpoint; never batch.
