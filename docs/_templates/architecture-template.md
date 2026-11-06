# {Feature Name} -- Architecture

Last updated: YYYY-MM-DD

## Overview

<!-- Replace with feature-specific content -->
{1-2 paragraphs: what this feature does, who uses it, and high-level design decisions}

## Table Relationships

<!-- Replace with feature-specific tree diagram using +-- and |-- connectors.
     Annotate [PRIVATE] for private tables and include decision refs inline. -->

```
{ParentTable} ({PK column})
  +-- {ChildTable} ({FK column} -> {ParentTable}.{PK})  [PRIVATE -- D-XX, Phase Y]
  |     {columnName} -> {what it references or represents}
  |     {columnName} -> {what it references or represents}
  +-- {AnotherChildTable} ({FK column} -> {ParentTable}.{PK})
        {columnName} -> {what it references or represents}

{StandaloneTable} ({PK column}) -- {admin-managed or self-contained note}
  +-- {JunctionTable} ({FK1} + {FK2}) -- junction
        {FK1column} -> {Table1}.{PK} ({enforcement note})
        {FK2column} -> {Table2}.{PK} ({enforcement note})
```

## Reducer Flows

<!-- Replace with feature-specific reducer flows.
     Each reducer gets its own subsection with numbered steps.
     Architecture documents the HOW (operational sequence), not the WHAT (acceptance spec) -- that lives in contract.md. -->

### {reducer_name}({param1}, {param2})
1. {Validation step -- e.g., ensureVerifiedUser, ensureAdmin, ownership check}
2. {Input validation -- e.g., format check, range check, uniqueness check}
3. {Business logic -- e.g., derive computed values, apply limits}
4. {State mutation -- Insert/Update/Delete}
5. {Side effects -- e.g., cascade, recalc, trigger related update}

### {another_reducer_name}({param1}, {param2})
1. {Step 1}
2. {Step 2}
3. {Step 3}

<!-- Repeat for each reducer in this feature.
     Admin proxy reducers can be grouped in a subsection if they mirror user reducers. -->

### Admin proxy reducers

<!-- If applicable: list admin_* variants and note differences from user reducers -->

All `admin_*` reducers mirror user reducers:
- Use `ensureAdmin(ctx)` instead of `ensureVerifiedUser`
- Accept `targetUserId` parameter for operations on behalf of other users
- No ownership checks -- admins can operate on any row
- Audit trail uses admin's user ID

## Phase History

<!-- Add one row per significant design decision.
     Source = planning artifact (CONTEXT.md, RESEARCH.md, STATE.md, review).
     Tag Phase 13 normalization entries as "Phase 13 normalization" for provenance.
     Do NOT rewrite existing entries -- only append new ones. -->

| Decision | Source | Date |
|----------|--------|------|
| {What was decided and why} | {Phase N CONTEXT.md / RESEARCH.md / review} | {YYYY-MM-DD} |

---

*Last updated: YYYY-MM-DD*
*Feature owner: Phase {N}*

**Behavior specification** (acceptance scenarios, edge cases, phase history): See [contract.md](contract.md)
