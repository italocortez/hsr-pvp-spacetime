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
  |     Indexes: cost_set_id (btree)
  |
  +-- CostSetDraftLightcone (PK: [costSetId, lightconeName, gameMode, draftMode])
  |     costSetId -> CostSet.id  [btree: cost_set_id]
  |     lightconeName -> HsrLightcone.name
  |     gameMode: GameMode
  |     draftMode: DraftMode
  |     costs: SuperimpositionCost struct (s1-s5 numbers)
  |     Indexes: cost_set_id (btree)
  |
  +-- CostSetDraftSynergy (PK: [costSetId, sourceName, targetName, gameMode, draftMode])
        costSetId -> CostSet.id  [btree: cost_set_id]
        sourceName -> HsrCharacter.name
        targetName -> HsrCharacter.name
        gameMode: GameMode
        draftMode: DraftMode
        costModifier: f32
        Indexes: cost_set_id (btree)

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
        Indexes: cost_set_id (btree),
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
4. Phase S7 execution (A21, backlog #3): synergies are unordered pairs. The two names are stored as `characterA` / `characterB` in canonical (alphabetical) order (`canonicalPair`, `shared/scoring`), so B + A updates the A + B row instead of creating a reversed duplicate. The arguments keep their names. `admin_bulk_upsert` (HsrSynergyCost) canonicalizes each row the same way, matches an existing pair in either order, and rejects a payload listing the same pair twice in either order. The surcharge itself is computed by `synergySurcharge` (docs/match-session/architecture.md "Phase S7 execution").
5. Phase S10c execution (audit 2026-11-09): after the ownership and draft-state checks, both names must be `HsrCharacter` rows, else `'Character <name> not found.'` (`admin_bulk_upsert` HsrSynergyCost does the same).

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

## Phase S10f execution (roster audit #9; LOW #17)

**`edit_draft_*_cost` input rules** (`reducers/roster/costSetManagement.ts`), in this order after the set, owner and
draft-state checks:
- `costsJson` is a JSON object with the named fields (`e0`..`e6` or `s1`..`s5`), each a finite number from 0 to
  `BUDGET_MAX` (100 000, the lobby budget ceiling, `helpers/lobby/lobbyConfigBounds.ts`): "costsJson field "X" must be a
  number between 0 and 100000."; the stored cost object holds only those fields.
- `gameModeTag` is a GameMode tag and equals the set's own `gameMode` ("This cost set is for X; gameModeTag must be
  X."); `draftModeTag` is Classic or Auction ("Invalid draftModeTag. Must be one of: Classic, Auction").
- The character name must be an `HsrCharacter` row ("Character X not found."), the light-cone name an `HsrLightcone`
  row ("Light cone X not found."); the synergy names were already checked (S10c).
- `edit_draft_synergy_cost`: `costModifier` finite with |value| <= 100 000 ("costModifier must be a number between
  -100000 and 100000."); negative modifiers stay allowed.

**Seed (roster audit #10).** `scripts/stdb/_seed.ts` sends only the archetype names not yet in `Archetype`, so a re-seed
keeps descriptions an admin wrote (the `Archetype` branch of `admin_bulk_upsert` has no keep-merge).

**LOW.** The `unpublish_cost_set` header no longer claims clients stop receiving the live rows (they stay public until
`delete_cost_set`).

## Phase S10i execution (DECISIONS.md A101, A107, A108)

Supersedes, for the reducers below, the "Row-absence semantic" (readers returned 0), the `publish_cost_set` Phase D
(draft rows deleted) and the "not in draft state" edit rule above.

**Lookups (A107(1)(5)).** Every character and light-cone price is read from the live rows of the lobby's own cost set,
game mode and draft mode (`helpers/draft/costSetGuards.ts`: `characterCostRow` / `lightconeCostRow`, through
`characterCostAt` / `lightconeCostAt` / `pricedCharacterNames`). No default-set fallback, no fixed draft mode. `EMPTY`
costs 0 by rule. A real character or light cone without a row is rejected with `"<name> has no cost in this lobby's cost
set."` A row that exists but lacks the requested eidolon / superimposition field is a data defect and is rejected with
`"The cost row of <name> has no <field> value."` (`e0`..`e6` / `s1`..`s5`; review F3, A108(2): no price default).
`doesCostSetCover` reads the same rows (`costSetRowsFor`) and checks the default set (id 0) like any other set (review
F2, A108(2)): a set 0 without a character and a light-cone row for the game mode and draft mode is refused at lobby,
preset and tournament selection with the coverage text, not mid-draft. Set 0 remains selectable without a `CostSet` row
(`ensureSelectableCostSet`). A synergy pair without a row in the set and mode adds no surcharge (it is never a
rejection). The readers are listed in docs/match-session/architecture.md "Phase S10i execution".

**Draft copy and patch in place (A107(3)).** `helpers/roster/costSetCompleteness.ts`.
- The `CostSetDraft*` rows of a set are its full editable copy. `publish_cost_set` no longer deletes them.
- `edit_draft_*_cost` accept a set that is a draft or published and not locked (`ensureCostSetPatchable`; texts
  "This cost set is locked; its costs cannot be changed." / "This cost set is unpublished; its costs cannot be
  changed."). A published set without any draft row (published before S10i) gets its draft rebuilt from its live rows
  first (`ensureDraftCopy`), in the edit and in a re-publish.
- No `CostSet` column was added: there is no "unpublished edits" flag. The owner's client can compare
  `view_my_draft_*_costs` with the live rows if it wants to show pending edits.

**publish_cost_set(costSetId, confirmFillMissing?: bool)** (the argument is optional; omitted = false):
1. Owner or Moderator+; `ensureCostSetPatchable`.
2. A patch (the set is already published) is refused while any lobby on the set is in Drafting, Equipping or Scoring:
   "Cannot patch this cost set while N lobbies using it are in Drafting, Equipping or Scoring." (`liveLobbiesOnCostSet`:
   "using the set" = `Lobby.costSetId`; read through the `Lobby.stage` btree, one filter per live stage, then the
   id compared. Waiting rooms, AwaitingResult lobbies, tournaments and presets do not block.)
3. `ensureDraftCopy`.
4. Completeness (A107(2), `missingCostEntries`): for each draft mode the draft prices at all (a character or light-cone
   row of the set's game mode; synergy rows do not count), every `HsrCharacter` / `HsrLightcone` row without a draft
   row in that mode. A draft mode with no character or light-cone row is not checked and not filled. Gaps without
   confirmation: refused with "This cost set has no cost for C characters and L light cones (Classic: c characters, l
   light cones; Auction: ...). Confirm to publish them at cost 0." Gaps with confirmation: written into the draft at
   cost 0 (every eidolon / superimposition field 0), so they reach the live copy in step 5.
5. `mirrorDraftToLive`: the live rows become equal to the draft under the same id. A new key is inserted; a changed
   price replaces the row (audit kept); an unchanged row is not written (no broadcast); a live row with no draft row
   is deleted. Synergies: changed modifier through `id.update`, new pairs inserted, stale pairs deleted.
6. `CostSet`: `isPublished = true`, `isDraft = false` (the row is updated on every publish, audit columns move).

Lobbies, presets and tournaments pointing at the set are not changed; they read the new prices from then on. Finished
games keep the costs on their steps and lineups (A107(6)).

**Lock, unpublish, delete, clone with pending draft edits.** Lock freezes the set: no edit, no patch; draft edits not
yet published stay in the private draft and never go live. Unpublish (needs a lock) keeps them frozen. Delete removes
the draft rows with the live rows (unchanged cascade). Clone (`create_cost_set` with a published source) copies the
source's live rows, so unpublished draft edits of the source are not cloned.

**Default set (id 0).** It is written by `admin_bulk_upsert` from `data/seed/` and has no `CostSet` row, so
`publish_cost_set`, the completeness check and the patch guard never apply to it. Its completeness depends on the seed.
A108(1): `data/seed/characters.json` and `data/seed/lightcones.json` price every character (83) and light cone (156)
for Classic and for Auction, with equal values in all three game modes, so the seed writes 249 + 249 `HsrCharacterCost`
rows and 468 + 468 `HsrLightconeCost` rows for set 0 (synergy rows keep their explicit Auction values). No reducer
applies a default price or a cross-mode fallback (A108(2)). A database published with this module must be re-seeded
(`stdb:seed`) before Auction lobbies on the default set work; until then the coverage guard refuses them at creation.

**View.** `view_cost_set_missing(costSetId)`: rows `{ costSetId, draftMode, kind ('Character' | 'Lightcone'), name }`,
for the set's owner and Moderator+ (checked before any read; anyone else and an unknown set get none). It reads the
whole `HsrCharacter` / `HsrLightcone` reference tables (iter) after the permission check.

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
| Synergy pairs canonicalized (alphabetical) in `edit_draft_synergy_cost` and `admin_bulk_upsert`; either-order match; duplicate pair in one bulk payload rejected | Phase S7 execution (DECISIONS.md A21; backlog #3) | 2026-11-06 |
| `edit_draft_*_cost`: finite costs 0..100000, bounded modifier, tags checked (game mode = the set's), names checked against `HsrCharacter` / `HsrLightcone`; re-seed keeps archetype descriptions | Phase S10f execution (roster audit #9, #10) | 2026-11-09 |
| Lookups read the lobby's own set, game mode and draft mode with no fallback, a missing row rejects; publish checks completeness (confirm fills at cost 0); the draft stays after publish and a published, unlocked set is patched in place, refused while a lobby on it is live; `view_cost_set_missing` | Phase S10i execution (DECISIONS.md A101, A107) | 2026-11-10 |
| The seed prices set 0 for Classic and Auction with equal values (249 + 249 character rows, 468 + 468 light-cone rows); no reducer applies a default price; `doesCostSetCover` checks set 0 like any other set (review F2); a cost row without the requested field is rejected (review F3); re-seed after publish | Phase S10i execution (DECISIONS.md A108) | 2026-11-10 |

---

*Last updated: 2026-04-15*
*Feature owner: Phase 03 (schema), Phase 15.4 (draftMode restructure)*

**Behavior specification** (acceptance scenarios, edge cases, phase history): See [contract.md](contract.md)
