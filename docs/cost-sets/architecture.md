# Cost Sets -- Architecture

Last updated: 2026-04-15

## Overview

Cost sets define per-game-mode + per-draft-mode point values for characters, lightcones, and synergies used in drafts. Tournament organizers create custom cost sets via a draft/publish workflow: edits stay private in draft tables until `publish_cost_set` copies them atomically to the live public tables. `costSetId=0` is the sentinel for the default (system) cost set and cannot be modified via these reducers.

**Phase 15.4 restructure (2026-04-15):** The parallel `classicCosts` + `auctionBaseBid` column pair on character/lightcone tables was collapsed into a single `costs` struct column, and a new `draftMode: DraftMode` (`Classic | Auction`) discriminator column was added to all six cost tables. The composite PK tuple on each table was extended by `draftMode`. One row = one `(name, gameMode, draftMode, costSetId)` combination. Synergy auction support (rows with `draftMode=Auction`) was introduced here; previous phases had no synergy auction data.

## Table Relationships

```
CostSet (id: u32 autoInc PK)  [public: true]
  +-- name: string (1-100 chars)
  +-- creatorId -> User.id  [btree: creator_id]
  +-- gameMode: GameMode (MemoryOfChaos | ApocalypticShadow | AnomalyArbitration)
  +-- isPublished: bool
  +-- isDraft: bool
  +-- isLocked: bool
  +-- audit columns

Private draft tables (public: false -- not broadcast to clients):
  +-- CostSetDraftCharacter (PK: [costSetId, characterName, gameMode, draftMode])
  |     costSetId -> CostSet.id  [btree: cost_set_id]
  |     characterName -> HsrCharacter.name
  |     gameMode: GameMode
  |     draftMode: DraftMode (Classic | Auction)
  |     costs: EidolonCost struct (e0-e6 numbers)
  |     Indexes: cost_set_id (btree), by_set_character_and_mode (btree 4-col)
  |
  +-- CostSetDraftLightcone (PK: [costSetId, lightconeName, gameMode, draftMode])
  |     costSetId -> CostSet.id  [btree: cost_set_id]
  |     lightconeName -> HsrLightcone.name
  |     gameMode: GameMode
  |     draftMode: DraftMode
  |     costs: SuperimpositionCost struct (s1-s5 numbers)
  |     Indexes: cost_set_id (btree), by_set_lightcone_and_mode (btree 4-col)
  |
  +-- CostSetDraftSynergy (PK: [costSetId, sourceName, targetName, gameMode, draftMode])
        costSetId -> CostSet.id  [btree: cost_set_id]
        sourceName -> HsrCharacter.name
        targetName -> HsrCharacter.name
        gameMode: GameMode
        draftMode: DraftMode
        costModifier: f32
        Indexes: cost_set_id (btree), by_tuple (btree 5-col: [costSetId, sourceName, targetName, gameMode, draftMode])

Live cost tables (public: true -- broadcast to all subscribers):
  +-- HsrCharacterCost (PK: [characterName, gameMode, draftMode, costSetId])
  |     characterName -> HsrCharacter.name
  |     gameMode: GameMode
  |     draftMode: DraftMode
  |     costs: EidolonCost
  |     costSetId -> CostSet.id (0=default)
  |     Indexes: cost_set_id (btree), by_character_mode_and_set (btree 4-col: [characterName, gameMode, draftMode, costSetId])
  |
  +-- HsrLightconeCost (PK: [lightconeName, gameMode, draftMode, costSetId])
  |     lightconeName -> HsrLightcone.name
  |     gameMode: GameMode
  |     draftMode: DraftMode
  |     costs: SuperimpositionCost
  |     costSetId -> CostSet.id (0=default)
  |     Indexes: cost_set_id (btree), by_lightcone_mode_and_set (btree 4-col: [lightconeName, gameMode, draftMode, costSetId])
  |
  +-- HsrSynergyCost (id: u32 autoInc PK)
        sourceName -> HsrCharacter.name
        targetName -> HsrCharacter.name
        gameMode: GameMode
        draftMode: DraftMode
        costModifier: f32
        costSetId -> CostSet.id (0=default)
        Indexes: source_mode (btree 3-col: [sourceName, gameMode, draftMode]),
                 target_name (btree), cost_set_id (btree),
                 by_tuple (btree 5-col: [sourceName, targetName, gameMode, draftMode, costSetId])
```

**PK declaration note (Phase 15.4 D-06, live-probed):** The `primaryKey: [...]` multi-column arrays declared on CostSetDraft* tables and HsrCharacterCost/HsrLightconeCost are *decorative self-documentation* -- SpacetimeDB v2.1.0 does NOT enforce these as engine-level unique constraints (verified via the PkTest probe published 2026-04-14). The only engine-enforced constraint on any cost table is HsrSynergyCost's `id: t.u32().primaryKey().autoInc()`. Tuple uniqueness on the composite PKs is enforced at the **reducer layer** via tuple-match-before-insert in `admin.ts` and `costSetManagement.ts`.

## Reducer Flows

### create_cost_set(name, sourceSetId, gameModeTag)
1. `ensureTournamentHost(ctx)` -- requires TournamentHost+ role
2. Validate name length 1-100 chars (after trim)
3. Validate `gameModeTag` is a valid GameMode variant
4. If `sourceSetId != 0`: verify source exists and `isPublished=true`
5. Insert `CostSet` row (`isDraft=true`, `isPublished=false`, `isLocked=false`)
6. Clone from source: copy `HsrCharacterCost`, `HsrLightconeCost`, `HsrSynergyCost` rows matching `gameModeTag` into their respective `CostSetDraft*` tables (filtered via `cost_set_id` index). **Source `draftMode` passes through unchanged** -- both Classic and Auction rows clone together in a single loop without code branching (Phase 15.4 D-20).

### edit_draft_character_cost(costSetId, characterName, gameModeTag, draftModeTag, costsJson)
1. `getAuthenticatedUser(ctx)` -- ownership check: `costSet.creatorId === user.id` OR Moderator+
2. Find `CostSet` -- reject if not found; reject if `!isDraft`
3. Parse and validate `costsJson` as `EidolonCost` (e0-e6 numeric fields)
4. Find existing draft row via `cost_set_id` index + in-memory filter on 4-tuple `(characterName, gameMode, draftMode, costSetId)`; delete if found
5. Insert new `CostSetDraftCharacter` row (delete+insert composite PK upsert)

One call = one row. Editing both classic and auction for the same character = two reducer calls. Consolidated from prior two-JSON signature per Phase 15.4 D-16.

### edit_draft_lightcone_cost(costSetId, lightconeName, gameModeTag, draftModeTag, costsJson)
1. Same ownership/draft-state checks as character variant
2. Parse and validate `costsJson` as `SuperimpositionCost` (s1-s5 numeric fields)
3. 4-tuple draft lookup including `draftMode`; delete+insert upsert on `CostSetDraftLightcone` (Phase 15.4 D-17).

### edit_draft_synergy_cost(costSetId, sourceName, targetName, gameModeTag, draftModeTag, costModifier)
1. Same ownership/draft-state checks
2. No JSON parsing -- `costModifier: f32` is a scalar payload
3. 5-tuple draft lookup `(sourceName, targetName, gameMode, draftMode, costSetId)`; delete+insert upsert on `CostSetDraftSynergy` (Phase 15.4 D-18). First-ever synergy auction support.

### publish_cost_set(costSetId)
1. Ownership check -- creator or Moderator+; reject if `!isDraft`
2. Phase A: copy `CostSetDraftCharacter` -> `HsrCharacterCost`. **`existingLive` predicate extended with `r.draftMode.tag === draft.draftMode.tag`** (Phase 15.4 D-21, Pitfall 7). Delete existing live row then insert; preserves audit history via `auditUpdate` when overwriting.
3. Phase B: copy `CostSetDraftLightcone` -> `HsrLightconeCost` (same 3-way predicate match on name + gameMode + draftMode).
4. Phase C: copy `CostSetDraftSynergy` -> `HsrSynergyCost` (existing live row matched by 4-tuple including draftMode: `id.update()` to preserve autoInc id; new row: insert with draftMode).
5. Phase D: delete all `CostSetDraft*` rows for this `costSetId`.
6. Phase E: update `CostSet` metadata: `isDraft=false`, `isPublished=true`.

### lock_cost_set(costSetId)
1. Ownership check; reject `costSetId=0`; reject if not published; reject if already locked
2. `CostSet.id.update()` with `isLocked=true`

### unpublish_cost_set(costSetId)
1. Ownership check; reject `costSetId=0`; reject if not published; reject if `!isLocked` (must lock first)
2. `CostSet.id.update()` with `isPublished=false`, `isLocked=false`
3. Live cost rows remain -- only metadata toggled (rows persist until `delete_cost_set`)

### delete_cost_set(costSetId)
1. Ownership check; reject `costSetId=0`; reject if `isPublished=true` (must unpublish first)
2. Delete all `HsrCharacterCost` rows via `cost_set_id` index
3. Delete all `HsrLightconeCost` rows via `cost_set_id` index
4. Delete all `HsrSynergyCost` rows via `cost_set_id` index (by autoInc `id`)
5. Delete any remaining `CostSetDraft*` rows (all three tables)
6. Delete the `CostSet` metadata row

## Data Patterns

### Row-absence semantic (Phase 15.4 D-10)

A missing row for the tuple `(name, gameMode, draftMode, costSetId)` means "not configured for that draft mode." Reader reducers return `0` in this case (`draftClassic.getCharacterBaseCost`, `draftAuction.getCharacterBaseCost`, `postDraft.ts` lightcone lookup -- see [cost-tables/architecture.md](../cost-tables/architecture.md)). Fail-fast enforcement at lobby creation time (reject cost sets that do not cover the `(mode x draftMode)` matrix) is tracked as a separate deferred todo (`.planning/todos/pending/2026-04-14-lobby-creation-cost-set-coverage-validation.md`).

Seed fan-out enforces this rule symmetrically: a template sub-block (`classic` / `auction`) present in the source data produces one DB row; a sub-block absent means no row is written for that draft mode. No zero-padding.

### Admin tuple-match implementation (Phase 15.4 A2 decision: A2_FALLBACK_ITER)

The existence check in `admin_bulk_upsert` for the three cost tables uses an `iter()` scan with an extended predicate that includes `draftMode.tag === r.draftMode`, not a multi-column btree filter. This follows the Phase 15 precedent documented in `RESEARCH.md` Assumption A2: tuple-filter with a tagged-union enum struct value is not supported by the current bindings, so the reducer-layer tuple match falls back to `O(n)` iteration per row. The 4-col / 5-col btree indexes declared on these tables (`by_character_mode_and_set`, `by_lightcone_mode_and_set`, `by_tuple`) remain useful to downstream views and client subscriptions but are not the path the admin bulk-upsert uses today. Revisiting this requires a bindings-layer enhancement, not a schema change.

`postDraft.ts` equip_lightcone LC lookup similarly falls back to `cost_set_id`-filter + predicate-find with `draftMode.tag === 'Classic'` -- same A2 constraint.

### Reducer arg convention (JSON payload for struct; scalar for f32)

Character/lightcone cost edits use a single `costsJson: string` arg (JSON-parsed server-side to an `EidolonCost` / `SuperimpositionCost` struct). Synergy cost edit uses `costModifier: f32` directly -- no JSON wrapping for scalar payloads. See `reference_reducer_client_patterns.md` for the broader convention.

### Enum struct passing

- Insert: `{ tag: 'Classic', value: {} } as any` (or `'Auction'`).
- Reducer arg: `draftModeTag: t.string()` -- reducer body wraps as `{ tag: draftModeTag, value: {} }`.
- Filter predicate: `row.draftMode.tag === 'Classic'`.

## View Definitions

| View | Returns | Purpose |
|------|---------|---------|
| `view_my_cost_sets` | `CostSet[]` | All cost sets owned by the caller (via `creator_id` index) |
| `view_my_draft_character_costs` | `CostSetDraftCharacter[]` | Caller's draft character costs across all owned sets |
| `view_my_draft_lightcone_costs` | `CostSetDraftLightcone[]` | Caller's draft lightcone costs |
| `view_my_draft_synergy_costs` | `CostSetDraftSynergy[]` | Caller's draft synergy costs |

All 4 views resolve `ctx.sender -> UserIdentity -> User`, then filter by `creatorId`.

## Phase History

| Decision | Source | Date |
|----------|--------|------|
| costSetId=0 sentinel for default cost set -- existing rows belong to set 0 | Phase 03 CONTEXT.md | 2026-02-15 |
| Draft tables are private (no public:true) -- draft edits not broadcast to clients | Phase 03 execution | 2026-02-15 |
| publish_cost_set preserves audit history via auditUpdate when live row already exists (supports republishing) | Phase 03 execution | 2026-02-15 |
| HsrSynergyCost uses id.update() on publish (autoInc PK); character/lightcone use delete+insert (composite PK) | Phase 03 execution | 2026-02-15 |
| unpublish_cost_set does NOT delete live cost rows -- only toggles isPublished/isLocked metadata | Phase 03 execution | 2026-02-15 |
| iter() used in per-user draft views -- no cross-table (creatorId, costSetId) index | Phase 03 execution | 2026-02-15 |
| Normalized to standard template | Phase 13 normalization | 2026-04-09 |
| `draftMode: DraftMode` column added to all 6 cost tables; classicCosts+auctionBaseBid collapsed to single `costs` struct; first-ever synergy auction support. PK tuples extended by `draftMode`; 4-col btrees on char/lc; new 5-col `by_tuple` btree on both synergy tables; `source_mode` extended to 3 cols (`[sourceName, gameMode, draftMode]`). Reducer tuple match via iter() + predicate (A2_FALLBACK_ITER). Reducer arg shape: `edit_draft_*_cost` collapses dual JSON inputs to single `costsJson` and adds `draftModeTag`; one call = one row. | Phase 15.4 execution | 2026-04-15 |

---

*Last updated: 2026-04-15*
*Feature owner: Phase 03 (schema), Phase 15.4 (draftMode restructure)*

**Behavior specification** (acceptance scenarios, edge cases, phase history): See [contract.md](contract.md)
