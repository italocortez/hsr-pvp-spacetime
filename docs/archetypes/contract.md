# Archetypes

**Architecture:** [architecture.md](architecture.md)

## Feature Overview

Admin-managed labels for HSR characters used for draft strategy tagging (e.g., "sustain", "hyper-carry", "follow-up"). Archetypes feed into the account rating system's horizontal score — measuring roster breadth across strategic categories. All operations are Admin-only.

## Reducers

### admin_upsert_archetype

**Purpose:** Create or update an archetype by name (upsert semantics)

**Permission:** Admin only

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| name | string | Yes | Archetype name (trimmed, unique) |
| description | string | Yes | Archetype description |

**Flow:**
1. ensureAdmin — reject non-Admin callers
2. Validate name is non-empty after trim
3. Look up existing archetype by name (unique index)
4. If not found: insert new Archetype row (id auto-incremented)
5. If found: update description only, preserve created* audit fields

**Expected State Changes:**
- INSERT: new Archetype row with audit columns
- UPDATE: description overwritten, lastModified* updated, created* preserved

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Non-Admin caller | "Forbidden: Requires Admin privileges." |
| Empty name (after trim) | "Archetype name cannot be empty" |

**Edge Cases:**
- Upsert with same name + same description = no-op (description overwritten with identical value)
- Name is trimmed before uniqueness check

---

### admin_delete_archetype

**Purpose:** Delete an archetype and cascade-remove all character assignments

**Permission:** Admin only

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| archetypeId | u32 | Yes | Archetype to delete |

**Flow:**
1. ensureAdmin
2. Verify archetype exists by ID
3. Delete all HsrCharacterArchetype junction rows for this archetypeId
4. Delete the Archetype row

**Expected State Changes:**
- All HsrCharacterArchetype rows with matching archetypeId deleted
- Archetype row deleted

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Non-Admin caller | "Forbidden: Requires Admin privileges." |
| Archetype not found | "Archetype not found" |

**Edge Cases:**
- No error if archetype has zero character assignments (cascade is no-op)
- Does NOT automatically recalculate account ratings — caller must run `admin_recalculate_all_ratings` separately if ratings depend on this archetype

---

### admin_assign_character_archetypes

**Purpose:** Assign one or more archetypes to a character (idempotent, all-or-nothing validation)

**Permission:** Admin only

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| characterName | string | Yes | Target character name |
| archetypeIdsJson | string | Yes | JSON array of u32 archetype IDs |

**Flow:**
1. ensureAdmin
2. **Phase 1 (validation):** Verify character exists in HsrCharacter. Verify ALL archetype IDs exist. Fail on first missing — no writes happen.
3. **Phase 2 (idempotent write):** For each archetype ID, check if junction row exists. Insert only if missing. Skip existing assignments silently.

**Expected State Changes:**
- HsrCharacterArchetype rows inserted for each new assignment

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Non-Admin caller | "Forbidden: Requires Admin privileges." |
| Character not found | "Character not found" |
| Any archetype ID not found | "Archetype #\{id\} not found" |

**Edge Cases:**
- Idempotent: assigning already-assigned archetypes produces no error and no duplicate rows
- All-or-nothing: if archetype #3 doesn't exist, archetype #1 and #2 are NOT assigned either
- Duplicate IDs in the array are handled gracefully (second insert skipped)

---

### admin_remove_character_archetypes

**Purpose:** Remove one or more archetype assignments from a character (all-or-nothing validation)

**Permission:** Admin only

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| characterName | string | Yes | Target character name |
| archetypeIdsJson | string | Yes | JSON array of u32 archetype IDs |

**Flow:**
1. ensureAdmin
2. **Phase 1 (validation):** Verify ALL junction rows exist for the given character + archetype pairs. Fail on first missing — no deletes happen.
3. **Phase 2 (delete):** Delete each junction row.

**Expected State Changes:**
- HsrCharacterArchetype rows deleted for each specified assignment

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Non-Admin caller | "Forbidden: Requires Admin privileges." |
| Any assignment not found | "Character \"\{name\}\" is not assigned to archetype #\{id\}" |

**Edge Cases:**
- All-or-nothing: if any one assignment doesn't exist, none are removed
- Does NOT automatically recalculate ratings

---

### Generic Admin Operations

Archetypes are also accessible via generic admin reducers:

**`admin_bulk_upsert`** (tableName = 'Archetype'):
- Expects rows with `[name, description]` only (no id, no audit columns)
- Same upsert semantics as `admin_upsert_archetype`

**`admin_delete_row`** (tableName = 'Archetype'):
- Same cascading delete as `admin_delete_archetype`

**`admin_delete_row`** (tableName = 'HsrCharacterArchetype'):
- Deletes a single junction row by composite key

## Rating System Integration

Archetypes feed the **horizontal score** component of account ratings:

- Each archetype's contribution = `min(sum(age_weight for owned chars in archetype) / archetypeThreshold, 1.0)`
- Horizontal score = mean across all archetypes
- `archetypeThreshold` is configurable via `admin_update_rating_config` (default: 3.0)
- Archetypes with zero assigned characters are skipped (threshold = 0 guard)
- After bulk archetype edits, `admin_recalculate_all_ratings` must be called manually to update account ratings (per D-32)

## Acceptance Scenarios

### Scenario: Create a new archetype
- **Given:** Admin is authenticated
- **When:** `admin_upsert_archetype({ name: "Hyper Carry", description: "High single-target DPS" })`
- **Then:** Archetype row created with auto-incremented ID, name="Hyper Carry"

### Scenario: Update existing archetype description
- **Given:** Archetype "Hyper Carry" exists
- **When:** `admin_upsert_archetype({ name: "Hyper Carry", description: "Updated description" })`
- **Then:** Description updated, createdById/createdDate preserved

### Scenario: Assign archetypes to character
- **Given:** Character "acheron" exists, archetypes [1, 2] exist
- **When:** `admin_assign_character_archetypes({ characterName: "acheron", archetypeIdsJson: "[1, 2]" })`
- **Then:** Two HsrCharacterArchetype junction rows created

### Scenario: Idempotent re-assignment
- **Given:** "acheron" already assigned to archetype 1
- **When:** `admin_assign_character_archetypes({ characterName: "acheron", archetypeIdsJson: "[1, 2]" })`
- **Then:** Only archetype 2 junction row created, archetype 1 skipped silently

### Scenario: Delete archetype cascades
- **Given:** Archetype 1 has 3 character assignments
- **When:** `admin_delete_archetype({ archetypeId: 1 })`
- **Then:** All 3 junction rows deleted, then archetype row deleted

### Scenario: All-or-nothing validation on assign
- **Given:** Archetype 1 exists, archetype 99 does not
- **When:** `admin_assign_character_archetypes({ characterName: "acheron", archetypeIdsJson: "[1, 99]" })`
- **Then:** Error "Archetype #99 not found", NO junction rows created (not even for archetype 1)

### Scenario: Non-admin rejected
- **Given:** Caller has User role
- **When:** Any archetype reducer called
- **Then:** "Forbidden: Requires Admin privileges."

## Edge Cases

| Case | Expected |
|------|----------|
| Upsert with identical name + description | No-op (description overwritten with same value) |
| Assign with duplicate IDs in array | Second insert skipped silently |
| Delete archetype with zero assignments | Cascade is no-op, archetype deleted |
| Assign/remove with mix of valid/invalid IDs | All-or-nothing: no writes if any ID invalid |
| Rating recalculation after archetype edit | Must be triggered manually via `admin_recalculate_all_ratings` |

## Integration Points

- **Account Rating System:** Archetypes feed horizontal score via `archetypeThreshold` config. Changes to archetype assignments require manual `admin_recalculate_all_ratings` call.
- **HsrCharacter:** Character names validated against HsrCharacter table on assign. No FK constraint — application-enforced.
- **Generic Admin:** `admin_bulk_upsert` and `admin_delete_row` support Archetype and HsrCharacterArchetype tables with same semantics as dedicated reducers.

## Phase History

| Decision | Source | Date |
|----------|--------|------|
| Archetype CRUD reducers (admin_upsert/delete/assign/remove) | Phase 3 execution | 2026-03-17 |
| All-or-nothing validation pattern for assign/remove | Phase 3 execution | 2026-03-17 |
| Idempotent assign (skip existing, no error) | Phase 3 execution | 2026-03-17 |
| Cascading delete on archetype removal | Phase 3 execution | 2026-03-17 |
| Rating horizontal score integration with archetypeThreshold | Phase 7 execution | 2026-03-28 |
| Generic admin operations (bulk_upsert, delete_row) | Phase 3 execution | 2026-03-17 |
| Contract retroactively written | Phase 12.1 execution | 2026-04-08 |
| Full hydration from codebase | Phase 13 normalization | 2026-04-09 |
