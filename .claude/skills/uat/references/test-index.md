# UAT Feature Index

Entry point for any agent or human working with behavior specs and tests. Maps every feature to its spec status, architecture doc, and test coverage.

> **A PostToolUse hook reminds you to update this index** when test files or docs change. Keep it current.

## Backend Features

| Feature | Behavior Spec | Coverage | Architecture Doc | Tests | Phases |
|---------|--------------|----------|-----------------|-------|--------|
| **Achievements** | `docs/achievements/contract.md` | Complete | `docs/achievements/architecture.md` | 3 test files | Phase 7 |
| **Anonymous Play** | `docs/anonymous-play/contract.md` | Complete | `docs/anonymous-play/architecture.md` | 1 test file | Phase 6 |
| **Admin** | `docs/admin/contract.md` | Complete | `docs/admin/architecture.md` | None yet | Phase 1 |
| **Archetypes** | No spec | -- | `docs/archetypes/architecture.md` | None yet | Phase 2, 11 |
| **Auth** | `docs/auth/contract.md` | Complete | `docs/auth/architecture.md` | None yet | Phase 1 |
| **Brackets** | `docs/brackets/contract.md` | Complete | `docs/brackets/architecture.md` | 3 test files | Phase 4 |
| **Calendar** | `docs/calendar/contract.md` | Complete | `docs/calendar/architecture.md` | 3 test files | Phase 8 |
| **Chat** | `docs/chat/contract.md` | Complete | `docs/chat/architecture.md` | 1 test file | Phase 9 |
| **Cost Sets** | `docs/cost-sets/contract.md` | Complete | `docs/cost-sets/architecture.md` | 1 test file | Phase 3 |
| **Cost Tables** | No spec | -- | `docs/cost-tables/architecture.md` | None yet | Phase 1 |
| **Lobby** | `docs/lobby/contract.md` | Complete | `docs/lobby/architecture.md` | 13 test files | Phase 9, 10 |
| **Match Results** | `docs/match-results/contract.md` | Complete | `docs/match-results/architecture.md` | 6 test files | Phase 3, 5 |
| **Match Session** | `docs/match-session/contract.md` | Complete | `docs/match-session/architecture.md` | 4 test files | Phase 9 |
| **MMR** | No spec | -- | `docs/mmr/architecture.md` | None yet | Phase 5 |
| **Player Stats** | `docs/player-stats/contract.md` | Complete | `docs/player-stats/architecture.md` | None yet | Phase 6 |
| **Roster** | `docs/roster/contract.md` | Complete | `docs/roster/architecture.md` | 6 test files | Phase 2 |
| **Season** | No spec | -- | -- | 2 test files | Phase 6 |
| **Smoke** | Stub | -- | -- (cross-cutting) | None yet | Cross-phase |
| **Tournaments** | `docs/tournament/contract.md` | Complete | `docs/tournament/architecture.md` | 9 test files | Phase 3, 4 |
| **Views** | `docs/views/contract.md` | Complete | `docs/views/architecture.md` | None yet | Phase 10.3 |

> **Coverage key:**
> - **Complete** = contract exists with acceptance scenarios (Given/When/Then or detailed reducer specs)
> - **Partial** = contract exists with some scenarios but not all implemented reducers are covered
> - **Stub** = placeholder contract exists but has no acceptance scenarios yet
> - **No spec** = architecture doc exists but no contract.md yet
>
> Use `references/workflow-doc-template.md` when creating or fleshing out a behavior spec.

## Test File Inventory (52 files)

| Directory | Count | Files |
|-----------|-------|-------|
| `test/backend/achievements/` | 3 | achievement-auto-award, achievement-checker.unit, achievement-management |
| `test/backend/anonymous-play/` | 1 | anonymous-labels |
| `test/backend/brackets/` | 3 | bracket-advancement, bracket-generation.unit, group-to-elimination |
| `test/backend/calendar/` | 3 | calendar-availability, calendar-events, calendar-saved |
| `test/backend/chat/` | 1 | chat-messages |
| `test/backend/cost-sets/` | 1 | cost-set-lifecycle |
| `test/backend/lobby/` | 13 | account-selection, disconnect-admin-tools, disconnect-concede, disconnect-gc, disconnect-helpers.unit, disconnect-leave-lobby, flag-transfer-helpers.unit, lobby-lifecycle, lobby-presets, lobby-settings, lobby-slot-helpers.unit, lobby-tournament, ownership-validation.unit |
| `test/backend/match-results/` | 6 | account-rating.unit, elo-calculation.unit, match-lifecycle, mmr-stats, referee-coach, score-entry |
| `test/backend/match-session/` | 4 | draft-auction, draft-classic, draft-control, post-draft |
| `test/backend/roster/` | 6 | account-deletion-guard, archetype-crud, roster-accounts, roster-characters, roster-helpers.unit, roster-migration |
| `test/backend/season/` | 2 | season-admin, tournament-player-account |
| `test/backend/tournaments/` | 9 | tournament-admin, tournament-cancel-cleanup, tournament-helpers.unit, tournament-management, tournament-mmr, tournament-registration, tournament-stage-validation.unit, tournament-stages, tournament-teams |

## Frontend Features

| Feature | Test Directory | Status |
|---------|---------------|--------|
| *(None yet)* | `test/frontend/` | Placeholder -- v1.0 milestone |

## Shared Infrastructure

| File | Purpose |
|------|---------|
| `test/shared/connection.ts` | WebSocket test harness -- `createTestHarness()`, `createVerifiedTestHarness()`, `expectReducerError()`, `sleep()`, `hasServerToken()` |
| `test/shared/fixtures.ts` | Data factories -- `nextUid()`, `createAccountArgs()`, `characterBatch()`, `resetUidCounter()`, etc. |
| `test/shared/seed-data.ts` | Test-specific data seeder (characters, lightcones, costs, archetypes) |
| `test/shared/mocks/spacetimedb-server.ts` | Mock for unit tests (no live SpacetimeDB needed) |

### Shared Helpers (`test/shared/helpers/`)

See `test-writing-guide.md` for the full helpers reference table. Phase 10.5 extracted ~70 inline helpers to eliminate duplication -- always import from there instead of writing inline copies.

## Operational Scripts

| Script | Purpose | When to run |
|--------|---------|-------------|
| `scripts/post-publish.ts` | Bootstrap after `--clear-database` -- identity, server, seed data | After every destructive publish |
| `scripts/seed-data.ts` | Standalone game data seeder (characters, lightcones, costs) | When you need to re-seed without full bootstrap |
| `scripts/register-server.ts` | Register server identity only | First-time setup or manual re-register |
| `scripts/manage-user.ts` | User management utilities (set-role, delete) | Admin operations |

## Data

| Directory | Committed | Contents |
|-----------|-----------|----------|
| `test/data/` | No (gitignored) | Raw game data JSONs -- private |
| `test/data-templates/` | Yes | Example JSON structure with 1-2 rows per template |

## Updating This Index

A PostToolUse hook at `.claude/hooks/post-test-index-reminder.js` fires after Write/Edit operations and reminds you to update this file when relevant changes are detected. Update this file when:
- A new `docs/{feature}/` directory is created
- A `contract.md` is created or its coverage changes
- Tests are added to a feature
- New shared utilities or scripts are added

Keep the tables above current -- this is the first thing any agent reads when loading the uat skill.
