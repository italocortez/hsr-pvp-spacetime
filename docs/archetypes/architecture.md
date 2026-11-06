# Archetypes -- Architecture

Last updated: 2026-04-09

## Overview

Archetypes are admin-managed labels for HSR characters (e.g., "sustain", "hyper-carry", "follow-up"). They serve two purposes: draft strategy tagging for the UI and the horizontal score component of account rating calculation. Admins create archetypes, assign them to characters, and the rating system uses archetype coverage to score how well-rounded a player's roster is.

## Table Relationships

```
Archetype (id: u32 autoInc PK)
  +-- name: string (unique)
  +-- description: string
  +-- audit columns
  Indexes: name (unique)

HsrCharacter (name: string PK)  -- admin-managed game data
  +-- [see cost-tables/architecture.md for full schema]

  +-- HsrCharacterArchetype (junction table -- no autoInc PK)
        characterName: string -> HsrCharacter.name (app-enforced FK)
        archetypeId: u32 -> Archetype.id (app-enforced FK)
        audit columns
        Indexes: character_name (btree, characterName),
                 archetype_id (btree, archetypeId),
                 by_character_and_archetype (btree, [characterName, archetypeId])
```

## Reducer Flows

### admin_upsert_archetype(name, description)
1. `ensureAdmin(ctx)` -- requires Admin role
2. Trim name; validate non-empty
3. Look up existing via `Archetype.name.find(name)` (unique index)
4. If found: `Archetype.id.update()` with merged fields and audit update (upsert via PK, not unique index -- unique indexes lack `.update()`)
5. If not found: insert new `Archetype` row

### admin_delete_archetype(archetypeId)
1. `ensureAdmin(ctx)` -- requires Admin role
2. Find archetype by `Archetype.id.find(archetypeId)` -- reject if not found
3. CASCADE: delete all `HsrCharacterArchetype` rows via `archetype_id.filter(archetypeId)`
4. Delete the `Archetype` row

### admin_assign_character_archetypes(characterName, archetypeIdsJson)
1. `ensureAdmin(ctx)` -- requires Admin role
2. Parse `archetypeIdsJson` as JSON array of u32 IDs
3. ALL-OR-NOTHING validation phase: verify every archetypeId exists in `Archetype.id` -- reject entire batch if any missing
4. ALL-OR-NOTHING write phase: for each archetypeId:
   - Check `by_character_and_archetype.filter([characterName, archetypeId])` -- skip if already assigned (idempotent)
   - Insert `HsrCharacterArchetype` junction row

### admin_remove_character_archetypes(characterName, archetypeIdsJson)
1. `ensureAdmin(ctx)` -- requires Admin role
2. Parse `archetypeIdsJson` as JSON array of u32 IDs
3. ALL-OR-NOTHING validation phase: verify every archetypeId exists -- reject if any missing
4. ALL-OR-NOTHING write phase: delete each `HsrCharacterArchetype` junction row via composite lookup

### admin_bulk_upsert (tableName='Archetype')
1. `ensureAdmin(ctx)` -- requires Admin role (handled in admin.ts)
2. Validate row keys match expected columns (name, description)
3. For each row: upsert by `Archetype.name.find()` -- update via `id.update()` if exists, insert if not

### admin_delete_row (tableName='Archetype' or 'HsrCharacterArchetype')
- `'Archetype'`: cascade-delete junction rows via `archetype_id` index, then delete archetype
- `'HsrCharacterArchetype'`: delete single junction row via `by_character_and_archetype` composite index

## Rating Integration

Archetypes feed the horizontal score component of account ratings (see `helpers/accountRating.ts`):

```
per_archetype = min(sum(age_weight for owned chars in archetype) / archetypeThreshold, 1.0)
horizontal_score = mean(per_archetype for ALL archetypes)
final_rating = (vertical * verticalWeight + horizontal * horizontalWeight) * scale
```

- `archetypeThreshold` (default 3.0) is configurable via `admin_update_rating_config`
- Archetypes with zero assigned characters are skipped in horizontal score calculation
- After bulk archetype edits, `admin_recalculate_all_ratings` must be called manually (D-32)

## Phase History

| Decision | Source | Date |
|----------|--------|------|
| Archetypes introduced as admin-managed labels for draft strategy tagging | Phase 02 CONTEXT.md | 2026-02-10 |
| admin_upsert_archetype uses id.update() for update path -- unique index lacks .update() method | Phase 02 execution | 2026-02-10 |
| All-or-nothing validation in assign/remove reducers -- batch rejected if any input invalid | Phase 02 execution | 2026-02-10 |
| Idempotent assign -- by_character_and_archetype check before insert | Phase 02 execution | 2026-02-10 |
| Archetypes feed horizontal score in account rating formula (D-32) | Phase 11 CONTEXT.md | 2026-04-01 |
| admin_recalculate_all_ratings required after bulk archetype edits (D-32) | Phase 11 execution | 2026-04-01 |
| Normalized to standard template | Phase 13 normalization | 2026-04-09 |

---

*Last updated: 2026-04-09*
*Feature owner: Phase 02 / Phase 11*

**Behavior specification** (acceptance scenarios, edge cases, phase history): See [contract.md](contract.md)
