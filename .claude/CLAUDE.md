# Git Rules

- Worktrees spawn from the last commit — uncommitted changes are invisible to them and cause merge conflicts. Revert with `git reset --soft HEAD~1` if needed.
- NEVER delete or commit `.env.local` or `.env`. These files are only edited by `post-publish.ts` after `--clear-database`.

---

# Autonomous Execution (applies ONLY during `/gsd-execute-phase` and inline sub-workflows)

This repo runs `mode: yolo` in `.planning/config.json`. During execution workflows — and ONLY during execution — operate autonomously. Structural gates (gitignore pre-audit, post-commit stat verification, hooks, `files_modified` frontmatter) provide the safety payoff. Extra "proceed?" prompts are pure friction.

**Does NOT apply during** `/gsd-discuss-phase`, `/gsd-plan-phase`, `/gsd-verify-work`, `/gsd-code-review`, architectural discussions, or any conversational phase — there, asking IS the design.

## During execution, never pause for:
- git commits on the current branch (gsd-tools, direct, amending unpushed)
- Approach-selection decisions reversible within the session (sequential vs parallel, wave ordering)
- Branch creation on the current feature branch
- Routine reads (`git log/diff/show/status/blame/check-ignore`)
- File writes inside the plan's `files_modified` frontmatter
- Running tests, builds, seed scripts

## During execution, DO pause for:
- File / branch / worktree deletion
- Force operations (`git push --force`, destructive `git reset --hard`, `--no-verify` bypass)
- Cross-boundary actions (pushes to remote, PRs, external APIs, deploys)
- Real problems (stranger paths in commits, hook rejections, unexpected test failures, merge conflicts)
- Plan-level `human-action` checkpoints baked into PLAN.md (D-11/D-12 gates, etc.)

---

# Gitignore Guardrail (applies during execution commits only)

NEVER commit anything under `test/data/`, `tmp/`, or `.env*`. The rule is about the ACTION:

- No `git add -f` / `git add --force`, ever, for any reason
- Plan `files_modified` frontmatter must not contain gitignored paths — pre-execution audit catches this
- Data-transform scripts for gitignored files are local-only: described as "user runs `tmp/migrate.ts` locally", never committed
- If verification needs a gitignored file, verification is wrong — use a fixture under `test/data-templates/` (whitelist path)

**Scope note:** this rule is absolute about force-adding gitignored paths during an execution commit. It does NOT imply extra caution on adjacent decisions — the structural pre-execution gate already prices in the risk.

Recovery procedure (if it happens anyway): see `memory/feedback_never_force_add_gitignored.md`.

---

# Frontend Self-Check (Playwright CLI)

Any UI edit that changes rendered output MUST be followed by a Playwright CLI screenshot + Read before reporting the task as complete. Code typechecks prove syntax; screenshots prove the user actually sees what the task intended.

Tool: `playwright-cli` (installed globally via `npm i -g @playwright/cli`, `.playwright/cli.config.json` sets msedge default).

Loop:
1. Ensure `npm run dev` is running (foreground or background).
2. `playwright-cli open http://localhost:3000/<route>` (once per session).
3. After UI edit: `playwright-cli screenshot --filename tmp/pw/<name>.png`.
4. `Read tmp/pw/<name>.png`. Compare to UI-SPEC.md (if exists) or task intent.
5. Iterate if wrong. `playwright-cli close` at end of session.

Path rules: `tmp/pw/` is ephemeral (gitignored). Durable audit screenshots written by `/gsd-ui-review` land under `.planning/phases/{N}/screenshots/` and ARE committed.

Pattern for embedding screenshots in plan `<acceptance_criteria>`: see `.claude/get-shit-done/references/playwright-cli-verify.md`.

Exception: backend-only edits, pure refactors with no visual delta, utility/hook/type changes below the component level. Use judgment — if a grep can prove it, skip the screenshot.

---

# Mandatory Skills

When working on ANY task in this project, use the appropriate skill:

| Area | Skill | When |
|------|-------|------|
| **Backend** (spacetimedb/) | `/spacetimedb` | Any work touching tables, reducers, schema, indexes, views, procedures, publishing, or generating bindings |
| **Frontend** (app/, components/) | `/frontend-design:frontend-design` (plugin) | Any work on UI components, pages, layouts, styling, or React features |

Always load the relevant skill before writing code. The skills contain project-specific patterns, API references, and guardrails that prevent common mistakes.

## All available skills

| Skill | Purpose |
|-------|---------|
| `spacetimedb` | SpacetimeDB backend development, multiplayer sync patterns, module bindings reference |
| `frontend-design:frontend-design` | Plugin (auto-updates): distinctive, intentional visual design for UI work |
| `skill-creator:skill-creator` | Plugin (auto-updates): create, improve, and benchmark skills |
| `vercel-deploy` | Deploy to Vercel |
| `vercel-logs` | View Vercel deployment logs |
| `vercel-setup` | Set up Vercel CLI and project config |
| `pr-description` | Generate PR descriptions |
| `severity-review` | Code review at varying depth levels |
| `uat` | Behavior spec contract, acceptance testing, per-feature specs and test verification |
| `simplify` | Review changed code for reuse, quality, efficiency |

---

# SpacetimeDB Core Rules

These are always-in-context rules that apply regardless of skill loading.

## Core Concepts

1. **Reducers are transactional** — they do not return data to callers
2. **Reducers must be deterministic** — no filesystem, network, timers, or random
3. **Read data via tables/subscriptions** — not reducer return values
4. **Auto-increment IDs are not sequential** — gaps are normal, don't use for ordering
5. **`ctx.sender` is the authenticated principal** — never trust identity args
6. **Energy budget matters** — egress is the dominant cost on maincloud; consider bandwidth impact when designing features

## Backend Feature Docs

All backend feature documentation lives in `docs/{feature}/`:

**Architecture** (`docs/{feature}/architecture.md`):
- Table relationship diagrams, PKs, FKs, indexes
- Reducer reference table (permissions, descriptions)
- Data patterns (composite PK updates, audit columns)
- **Update every time backend code changes** (new tables, reducers, schema modifications)

**Behavior specs** (`docs/{feature}/contract.md`):
- Acceptance scenarios (Given/When/Then)
- Edge cases and error messages
- Integration points (cross-feature dependencies)
- Phase history (which discussion/research established each decision)
- **Update after every phase discussion** with new workflow decisions
- See `docs/tournament/contract.md` for the reference example
- Use the template from `.claude/skills/uat/references/workflow-doc-template.md`
- **Never modify behavior specs (`docs/*/contract.md`) during execution.** After execution completes, update the contract with any additions — tag every new entry with `Phase X execution` in the Phase History table so the user can distinguish their decisions from Claude's. The user reviews execution-sourced entries during `/gsd-verify-work`.
- **Test files (`test/`) are the verification layer.** Do not create, edit, or delete test files without an explicit task. Test failures are diagnostic — report them, never auto-fix.

Architecture docs cross-reference behavior specs. No duplication between them.

**Enforcement:** The `/gsd-verify-work` workflow includes a mandatory doc-update checkpoint (step `doc_update_checkpoint`) that runs after UAT passes and before the phase is marked complete. It detects which `docs/{feature}/` directories the phase touched via git diff and prompts per-feature for architecture.md / contract.md / both / skip (with reason). Phase completion is blocked until every touched feature is answered. This is the structural enforcement of the two "update" rules above — it is not a replacement for them, and automated (AST/timestamp) staleness checkers are explicitly out of scope (see `memory/feedback_doc_updates_human_gated.md`).

## Editing Behavior

- Make the smallest change necessary
- Do NOT touch unrelated files, configs, or dependencies
- Do NOT invent new SpacetimeDB APIs — use only what exists in docs or this repo
- Do NOT add restrictions the prompt didn't ask for — if "users can do X", implement X for all users

## Deployment

- Maincloud is the spacetimedb hosted cloud and the default location for module publishing
- The default server marked by *** in `spacetime server list` should be used when publishing
- If the default server is maincloud you should publish to maincloud
- Publishing to maincloud is free of charge
- When publishing to maincloud the database dashboard will be at the url: https://spacetimedb.com/@<username>/<database-name>
- The database owner can view utilization and performance metrics on the dashboard

## UAT Verify-Work Format

During `/gsd-verify-work`, present ONE test at a time using this exact format:

```
**STEP N: {who} does {what} on {whom}**

| col | col | col |        ← spacetime sql output as markdown table
|-----|-----|-----|
| val | val | **changed** | ← bold changed values

{who} ({role}) called `{reducer}` on {target} — {field} changed from `old` → `new`.
```

- `spacetime sql` after EVERY state-changing reducer call — no exceptions
- Tables GROW as rows accumulate (show full table each step, not just the new row)
- Assign colored emoji markers (🔴🔵🟢🟡🟣🟠) to participant/team/user IDs — same color across all tables so the user can track entities through steps
- Rejection tests: group in a summary table (`caller | action | error`), one final snapshot confirms no state changed
- After all steps: show checkpoint box, wait for user response
- Do NOT batch multiple tests — one test per checkpoint, one response before the next

