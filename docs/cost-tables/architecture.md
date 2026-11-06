# Cost Tables (Game Data) -- Architecture

Last updated: 2026-04-15

## Overview

Cost tables store the admin-managed game data definitions for HSR characters, lightcones, and synergy cost modifiers. These tables are the source of truth for draft costs. `HsrCharacter` and `HsrLightcone` hold game entity definitions; their associated cost tables (`HsrCharacterCost`, `HsrLightconeCost`, `HsrSynergyCost`) store per-game-mode, per-draft-mode, per-cost-set pricing. All writes to these tables go through `admin_bulk_upsert` or the cost-set publish workflow. Players cannot write to any of these tables.

**Phase 15.4 restructure (2026-04-15):** The `classicCosts` + `auctionBaseBid` column pair on character/lightcone tables was replaced with a single `costs` struct column plus a `draftMode: DraftMode` (`Classic | Auction`) discriminator. The composite PK tuples and multi-column btree indexes were extended to include `draftMode`. Synergy tables gained `draftMode` as well, introducing first-class synergy auction rows. Row absence for a given `(name, gameMode, draftMode, costSetId)` tuple means "not configured for that draft mode" -- see [cost-sets/architecture.md](../cost-sets/architecture.md) for row-absence semantic details.

## Table Relationships

```
HsrCharacter (name: string PK)  [public: true]
  +-- displayName: string
  +-- aliases: string[]
  +-- rarity: u8
  +-- path: Path (Destruction | Hunt | Erudition | Harmony | Nihility | Preservation | Abundance | Remembrance)
  +-- element: Element (Fire | Ice | Wind | Lightning | Physical | Quantum | Imaginary)
  +-- role: CharRole (Dps | Support | Sustain)
  +-- imageUrl: string
  +-- versionReleased: f64
  +-- treatAsVersion: f64 (override version for rating weight calculation)
  +-- audit columns
  Indexes: by_path (btree), by_element (btree), by_role (btree)

  +-- HsrCharacterCost (PK: [characterName, gameMode, draftMode, costSetId])  [public: true]
  |     characterName -> HsrCharacter.name
  |     gameMode: GameMode
  |     draftMode: DraftMode (Classic | Auction)
  |     costs: EidolonCost struct (e0-e6 numeric fields)
  |     costSetId: u32 (0=default sentinel, or CostSet.id)  [btree: cost_set_id]
  |     audit columns
  |     Indexes: cost_set_id (btree),
  |              by_character_mode_and_set (btree 4-col: [characterName, gameMode, draftMode, costSetId])

HsrLightcone (name: string PK)  [public: true]
  +-- displayName: string
  +-- aliases: string[]
  +-- path: Path
  +-- rarity: u8
  +-- imageUrl: string
  +-- posX: i32 (CSS positioning correction)
  +-- posY: i32
  +-- width: i32
  +-- audit columns
  Indexes: by_path (btree)

  +-- HsrLightconeCost (PK: [lightconeName, gameMode, draftMode, costSetId])  [public: true]
        lightconeName -> HsrLightcone.name
        gameMode: GameMode
        draftMode: DraftMode
        costs: SuperimpositionCost struct (s1-s5 numeric fields)
        costSetId: u32 (0=default sentinel, or CostSet.id)  [btree: cost_set_id]
        audit columns
        Indexes: cost_set_id (btree),
                 by_lightcone_mode_and_set (btree 4-col: [lightconeName, gameMode, draftMode, costSetId])

HsrSynergyCost (id: u32 autoInc PK)  [public: true]
  +-- sourceName -> HsrCharacter.name
  +-- targetName -> HsrCharacter.name
  +-- gameMode: GameMode
  +-- draftMode: DraftMode
  +-- costModifier: f32
  +-- costSetId: u32 (0=default sentinel, or CostSet.id)
  +-- audit columns
  Indexes: source_mode (btree 3-col: [sourceName, gameMode, draftMode]),
           target_name (btree),
           cost_set_id (btree),
           by_tuple (btree 5-col: [sourceName, targetName, gameMode, draftMode, costSetId])
```

**PK declaration note (Phase 15.4 D-06):** The composite `primaryKey: [...]` arrays on HsrCharacterCost / HsrLightconeCost are decorative self-documentation -- SpacetimeDB v2.1.0 does not enforce multi-column PK uniqueness at the engine layer (live-probed via PkTest 2026-04-14). Only HsrSynergyCost's `id: t.u32().primaryKey().autoInc()` is engine-enforced. Tuple uniqueness on the composite tuples is reducer-enforced via tuple-match-before-insert.

## Reader Helpers

Three reducer-internal readers consume these tables during draft/equip flows:

### `draftClassic.ts` `place_pick` cost read (inline)
Filters `HsrCharacterCost` rows by `cost_set_id.filter(lobby.costSetId)`, then in-memory `.find()` on `(characterName, gameMode.tag, draftMode.tag === 'Classic')`. Returns `costRow.costs[eidolonKey]`. Row absence or `'EMPTY'` character -> `0` (Phase 15.4 D-10/D-11).

### `draftAuction.ts:getCharacterBaseCost`
Filters `HsrCharacterCost` rows by `cost_set_id`, then in-memory `.find()` on `(characterName, gameMode.tag, draftMode.tag === 'Auction')`. Returns `costRow.costs[eidolonKey]`. Row absence -> `0`. Replaces the prior read of the dropped `auctionBaseBid` column (Phase 15.4 D-10/D-11).

### `postDraft.ts` equip_lightcone LC lookup
Looks up `HsrLightconeCost` by `cost_set_id.filter(costSetIdToTry)` + predicate `.find(r => r.lightconeName === ... && r.gameMode.tag === ... && r.draftMode.tag === 'Classic')`. LC equip happens in the classic draft context regardless of the character-phase draft mode. Returns `costRow.costs[sField]`. Falls back to `costSetId=0` if the lobby's cost set has no matching row (Phase 15.4 D-10/D-11, Pitfall 6).

All three readers use the `iter()`-equivalent fallback pattern (btree filter + in-memory predicate) because tuple-filter with a tagged-union enum struct value is unsupported in current SpacetimeDB bindings (RESEARCH Assumption A2). See [cost-sets/architecture.md](../cost-sets/architecture.md) "Admin tuple-match implementation" for the same rationale in the admin write path.

## Reducer Flows

### admin_bulk_upsert(tableName, jsonData) -- for game data tables
1. `ensureAdmin(ctx)` -- requires Admin role
2. Parse `jsonData` as JSON array; `validateKeys(rows, tableName)` -- reject if row keys don't match exactly expected columns (now includes `draftMode`, replaces `classicCosts` / `auctionBaseBid` with single `costs` on char/lc)
3. Per-table switch:
   - **HsrCharacter**: validate path/element/role enum tags; upsert by `name` PK. Auto-triggers `maxPossible` recalculation and rating recalc for all accounts if `maxPossible` changes (D-33)
   - **HsrLightcone**: validate path enum tag; upsert by `name` PK
   - **HsrCharacterCost**: validate gameMode + draftMode enum tags; iter-find by `(characterName, gameMode.tag, draftMode.tag, costSetId)` 4-tuple; delete+insert (Phase 15.4 D-19)
   - **HsrLightconeCost**: validate gameMode + draftMode enum tags; iter-find by `(lightconeName, gameMode.tag, draftMode.tag, costSetId)` 4-tuple; delete+insert
   - **HsrSynergyCost**: validate gameMode + draftMode enum tags; iter-find by `(sourceName, targetName, gameMode.tag, draftMode.tag, costSetId)` 5-tuple; upsert via `id.update()` if exists, insert with `draftMode` if not
   - **Archetype**: upsert by unique name (see archetypes/architecture.md)

### admin_delete_row(tableName, primaryKeyJson) -- for game data tables
1. `ensureAdmin(ctx)` -- requires Admin role
2. Per-table switch:
   - **HsrCharacter**: delete by `name` PK
   - **HsrLightcone**: delete by `name` PK
   - **HsrCharacterCost**: iter-find by `{ characterName, gameModeTag, draftModeTag, costSetId }` JSON key; delete row
   - **HsrLightconeCost**: iter-find by `{ lightconeName, gameModeTag, draftModeTag, costSetId }` JSON key; delete row
   - **HsrSynergyCost**: delete by autoInc `id`

## Phase History

| Decision | Source | Date |
|----------|--------|------|
| All game data tables admin-managed -- players cannot modify | Phase 01 CONTEXT.md | 2026-02-01 |
| costSetId=0 sentinel for default cost set -- backward-compatible with pre-cost-set rows | Phase 03 execution | 2026-02-15 |
| Composite PKs with [..., costSetId] allow per-tournament custom cost configurations | Phase 03 execution | 2026-02-15 |
| HsrCharacterCost and HsrLightconeCost PK expansion required --clear-database (Phase 03-01) | Phase 03 execution | 2026-02-15 |
| Strict key + enum validation in admin_bulk_upsert prevents malformed data | Phase 02 execution | 2026-02-10 |
| versionReleased and treatAsVersion added to HsrCharacter for age-weight account rating calculation | Phase 11 execution | 2026-04-01 |
| admin_bulk_upsert HsrCharacter auto-triggers rating recalc if maxPossible changes (D-33) | Phase 11 execution | 2026-04-01 |
| HsrCharacter.role (CharRole enum: Dps/Support/Sustain) used in rating role-exponent formula | Phase 11 execution | 2026-04-01 |
| posX, posY, width on HsrLightcone for CSS positioning corrections in UI | Phase 02 execution | 2026-02-10 |
| Normalized to standard template | Phase 13 normalization | 2026-04-09 |
| `draftMode: DraftMode` added to all 3 live cost tables; `classicCosts` + `auctionBaseBid` collapsed to single `costs` struct on char/lc. PK tuples extended by `draftMode` (decorative); 4-col btrees on char/lc; 5-col `by_tuple` btree on synergy; `source_mode` extended to 3 cols. Reader helpers filter `draftMode.tag === 'Classic' | 'Auction'` explicitly. Admin bulk-upsert + postDraft LC lookup use iter()/predicate fallback per A2; btree indexes remain for downstream view/sub usage. First-ever synergy auction row shape. pk_test probe table removed via same publish (D-23). | Phase 15.4 execution | 2026-04-15 |

---

*Last updated: 2026-04-15*
*Feature owner: Phase 01 / Phase 03 / Phase 11 / Phase 15.4*

**Behavior specification** (acceptance scenarios, edge cases, phase history): See [contract.md](contract.md) (to be born in Phase 17 when the cost-tables frontend lands with user-visible scenarios)
