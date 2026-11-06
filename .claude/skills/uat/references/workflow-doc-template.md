# Workflow Documentation Template

Use this template when creating or updating `docs/{feature}/contract.md` files.

These docs capture the **"what should happen" narrative** — the specification that test code validates against. They are NOT test code. They describe expected behaviors, reducer flows, and acceptance scenarios in human-readable form.

---

## Template

````markdown
# {Feature Name}

## Feature Overview

{One paragraph describing what this feature does from a user/system perspective. What problem does it solve? Who uses it?}

## Reducers

### {reducer_name}

**Purpose:** {What this reducer does — one line}

**Permission:** {Who can call it — e.g., "Any authenticated user", "TournamentHost+", "Admin only"}

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| {name} | {type} | Yes/No | {what it is} |

**Flow:**
1. {Step 1 — what the reducer does first}
2. {Step 2 — validation, lookups, etc.}
3. {Step 3 — state mutation (insert/update/delete)}
4. {Step 4 — side effects if any}

**Expected State Changes:**
- {Table}.{column} = {value} (insert/update/delete)
- {Other table changes}

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| {When X} | "{Exact error string}" |

{Repeat for each reducer in this feature}

## Acceptance Scenarios

### {Scenario Name}

**Given:** {Initial state — what exists in the database}
**When:** {Action — which reducer is called with what args}
**Then:** {Expected outcome — what the database looks like after}

### {Another Scenario}

**Given:** {State}
**When:** {Action}
**Then:** {Outcome}

{Include both happy path and error scenarios. Each scenario should map to at least one test case.}

## Edge Cases

| Case | Expected Behavior | Notes |
|------|-------------------|-------|
| {Unusual input or boundary condition} | {What should happen} | {Why this matters} |

## Integration Points

| This Feature | Connects To | How | Direction |
|-------------|------------|-----|-----------|
| {reducer/table} | {other feature's reducer/table} | {FK, shared column, trigger} | {reads/writes/both} |

## Phase History

{Which phase discussion or research established each behavior. This is the audit trail.}

| Decision | Source | Date |
|----------|--------|------|
| {What was decided} | {DECISIONS.md Axx, step Sx / Phase <step> execution} | {Date} |

---

*Last updated: {date}*
*Feature owner: Phase {N}*
````

---

## Guidelines

### What belongs in a workflow doc

- Expected reducer behavior (inputs → outputs → state changes)
- Validation rules and error messages
- Cross-feature dependencies
- Business rules ("a locked cost set cannot be selected by new lobbies")
- The decision trail (which phase established each rule)

### What does NOT belong

- Implementation details (which helper function to use, code patterns)
- Performance considerations (those go in RESEARCH.md)
- Frontend behavior (that goes in test/frontend/)
- Test code (that goes in `test/backend/{feature}/*.test.ts`)

### Keeping docs current

The workflow doc should always reflect the **current expected behavior**, not historical decisions. When a behavior changes:

1. Update the relevant reducer flow and acceptance scenarios
2. Add the change to Phase History with the new source
3. Mark the old behavior as superseded (don't delete — annotate)

### Granularity

- One contract.md per feature directory
- Each reducer in the feature gets its own section
- Acceptance scenarios should be concrete enough to become test cases
- Edge cases table should grow as bugs are found and fixed

### Referencing decisions

Cite the decision id and the step that implemented it:

```markdown
| Series length capped to {1, 3} | DECISIONS.md A28, step S6 | 2026-11-06 |
| Group ranking: points, head-to-head, game differential, seed | DECISIONS.md A30, step S8 | 2026-11-06 |
```

This creates the traceability chain: **decision → specification → test**.
