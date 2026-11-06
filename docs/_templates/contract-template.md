# {Feature Name}

**Architecture:** [architecture.md](architecture.md)

## Feature Overview

<!-- Replace with feature-specific content -->
{One paragraph describing what this feature does from a user/system perspective. What problem does it solve? Who uses it? What are the key constraints?}

## Reducers

<!-- Replace with feature-specific reducer documentation.
     Read actual reducer source files in spacetimedb/src/reducers/ before writing.
     Do NOT copy from stale docs -- source code is the single source of truth.
     Contract documents the WHAT (acceptance spec), not the HOW -- that lives in architecture.md. -->

### {reducer_name}

**Purpose:** {What this reducer does -- one line}

**Permission:** {Who can call it -- e.g., "Any verified (non-guest) user", "Account owner", "Admin only", "TournamentHost+"}

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| {name} | {type} | Yes | {what it is and any validation rules} |
| {name} | {type} | No | {what it is, default behavior if omitted} |

**Flow:**
1. {Auth/permission check -- e.g., ensureVerifiedUser, ensureAdmin, ownership check}
2. {Input validation -- e.g., format check, range check, uniqueness check}
3. {Business logic -- e.g., derive computed values, check limits, validate relationships}
4. {State mutation -- Insert/Update/Delete with relevant columns}
5. {Side effects -- e.g., cascade, recalc, trigger related update}

**Expected State Changes:**
- {Table}.{column} = {value} ({inserted / updated / deleted})
- {Other table changes, cascade effects}

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| {When X -- e.g., guest caller} | "{Exact or approximate error string}" |
| {When Y -- e.g., not owner} | "{Error string}" |
| {When Z -- e.g., limit exceeded} | "{Error string}" |

<!-- Repeat for each reducer in this feature.
     Admin proxy reducers can be grouped as a subsection.
     Views/anonymous views should be listed under "Views" or "View Definitions". -->

### Admin proxy reducers

<!-- If applicable: document admin_* variants that mirror user reducers -->

All `admin_*` reducers mirror user reducers: {list reducer names}.

**Differences from user reducers:**
- Use `ensureAdmin(ctx)` -- require Admin role
- Accept `targetUserId` for create operations (proxy on behalf of another user)
- No ownership checks -- admins can operate on any row
- Audit trail uses admin's user ID

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Non-admin caller | "Admin" |

## Acceptance Scenarios

<!-- Replace with feature-specific scenarios.
     Each scenario should be concrete enough to become a test case.
     Include both happy path and error scenarios. -->

### {Scenario Name -- Happy Path}
**Given:** {Initial state -- what exists in the database}
**When:** `{reducer_name}({param}="{value}", {param}="{value}")`
**Then:** {Expected outcome -- what the database looks like after, including specific column values}

### {Scenario Name -- Validation Error}
**Given:** {Initial state}
**When:** `{reducer_name}({invalid param combination})`
**Then:** Throws "{error message}"

### {Scenario Name -- Permission Guard}
**Given:** {User without permission}
**When:** Any `{reducer_name}` called
**Then:** Throws "{permission error message}"

<!-- Add more scenarios as needed. Complex features should have 10-20+ scenarios. -->

## Edge Cases

<!-- Replace with feature-specific edge cases.
     These capture boundary conditions, race conditions, and unusual inputs that have been explicitly handled or should be. -->

| Case | Expected Behavior | Notes |
|------|-------------------|-------|
| {Unusual input or boundary condition} | {What should happen} | {Why this matters, any test coverage} |
| {Cascade behavior on deletion} | {What cascades, what doesn't} | {Any explicit guards or known gaps} |

## Integration Points

<!-- Replace with feature-specific integration points.
     Document cross-feature dependencies: FKs, shared reducers, cascade effects. -->

| This Feature | Connects To | How | Direction |
|-------------|------------|-----|-----------|
| {table/reducer} | {other feature's table/reducer} | {FK (application-enforced), shared column, trigger} | {Reads / Writes / Both} |

## Phase History

<!-- Add one row per significant design decision.
     Source = planning artifact (CONTEXT.md, RESEARCH.md, STATE.md, review).
     Tag Phase 13 normalization entries as "Phase 13 normalization" for provenance.
     Do NOT rewrite existing entries -- only append new ones. -->

| Decision | Source | Date |
|----------|--------|------|
| {What was decided and why} | {Phase N CONTEXT.md / review / execution} | {YYYY-MM-DD} |

---

*Last updated: YYYY-MM-DD*
*Feature owner: Phase {N}*
