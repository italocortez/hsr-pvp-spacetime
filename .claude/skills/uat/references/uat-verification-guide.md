# UAT Verification Guide

Reference for running `/gsd-verify-work` sessions. Covers DB snapshots, step presentation, emoji markers, and report cards.

## Table of Contents

1. [DB Snapshot Requirements](#db-snapshot-requirements)
2. [Step Presentation Format](#step-presentation-format)
3. [Emoji Entity Markers](#emoji-entity-markers)
4. [Rejection Tests](#rejection-tests)
5. [Implementation Pattern](#implementation-pattern)
6. [Report Cards](#report-cards)

## DB Snapshot Requirements

Every reducer call during UAT MUST be followed by a live database query showing the actual state of the tables that action touched. Snapshots are the proof that the reducer did what it claims.

### Rules

1. **Query after each individual action.** Run `spacetime sql` on the affected table(s) immediately after each reducer call -- not after a batch of calls.
2. **Query the DB after EVERY state-changing action.** A script that runs 8 reducer calls and prints console.log output is NOT a substitute for per-step DB snapshots.
3. **Show only tables the action touched.** Don't dump unrelated tables.
4. **Never reconstruct snapshots.** If you ran a batch test, the final DB state does NOT count as per-step snapshots. You must run actions individually with a query between each one.
5. **Include snapshots in all outputs:**
   - Inline conversation when presenting checkpoint results
   - Written UAT files (`.planning/phases/XX-name/{phase_num}-UAT.md`)
   - Report cards (`notes/reportcards/uat/backend-testing/`)

## Step Presentation Format

Present ONE test at a time. Each step uses this format:

```
**STEP N: {who} does {what} on {whom}**

| col | col | col |        <-- spacetime sql output as markdown table
|-----|-----|-----|
| val | val | **changed** | <-- bold changed values

{who} ({role}) called `{reducer}` on {target} -- {field} changed from `old` -> `new`.
```

Example:
```
**Moderator promotes target to TournamentHost**

| id | username | role |
|----|----------|------|
| 101 | TestUser_abc | tournamentHost |

User 100 (Moderator) called `mod_promote_to_host` on user 101 -- role changed from `user` -> `tournamentHost`.
```

Key rules:
- `spacetime sql` after EVERY state-changing reducer call -- no exceptions
- Tables GROW as rows accumulate (show full table each step, not just the new row)
- After all steps: show checkpoint box, wait for user response
- Do NOT batch multiple tests -- one test per checkpoint, one response before the next

## Emoji Entity Markers

Assign colored emoji (🔴🔵🟢🟡🟣🟠) to participant/team/user IDs the first time they appear. Use the same color for that ID across ALL tables and steps so the user can track entities through the progression. Use `*BYE*` for empty opponent slots.

```
| id | participant1 | participant2 | winner |
|----|--------------|--------------|--------|
| 101 | 🔴 5 | 🔵 8 | 🔴 5 |
| 102 | 🟢 6 | *BYE* | 🟢 6 |
```

## Rejection Tests

For rejection tests (no state change), group them in one script with `expectReducerError`. Present results as a summary table:

```
| caller | action | error |
|--------|--------|-------|
| Guest | create_lobby | "Must be verified user" |
| User | admin_delete | "Requires Admin role" |
```

One final snapshot confirms no state changed.

## Implementation Pattern

Run each reducer call individually, then immediately `spacetime sql` the affected tables. Collect all snapshot outputs. Then present the full progression as one formatted story.

1. Call reducer (via harness script or `spacetime call`)
2. `spacetime sql` -- capture the output
3. Call next reducer
4. `spacetime sql` -- capture the output
5. Repeat until done
6. Present all collected snapshots as a formatted progression

A single harness script CAN do multiple steps, as long as it pauses for a `spacetime sql` query between each one.

## Report Cards

When a UAT session is **paused, abandoned, or interrupted** to work on something else, write a report card before switching context.

**Location:** `notes/reportcards/uat/backend-testing/`
**Naming:** `Phase-{X}_{YYYY-MM-DD}_{n}.md` (n increments for multiple reports same day)

### Template

```markdown
# Phase {X} UAT Report Card -- {YYYY-MM-DD} (#{n})

## Session Summary

**Phase:** {XX} -- {Phase Name}
**Started:** {time UTC}
**Paused:** {time UTC}
**Status:** {Paused at Test N of M / Completed / Abandoned}
**UAT file:** {path to UAT.md} (status: {paused/testing/complete})

## What We Did

{Numbered list of actions taken during the session.}

## Errors Encountered

### Found and fixed during session:
{Numbered list. Include: what the error was, where, what caused it, how it was fixed.}

### Found but not fixed:
{Numbered list. Include: what the error was, severity, why it wasn't fixed.}

## What We Covered

| Test | Status |
|------|--------|
| {N}. {Test Name} | {Pass / Issue (detail) / Skipped / Not started} |

**Additional coverage:**
{Anything verified outside the formal test list.}

## Where We Stopped

**Stopped at:** {Test N of M}
**Why:** {Clear explanation of why the session was interrupted.}

## Next Steps

{Numbered list of what needs to happen before this UAT can resume.}
```

### When to write

- UAT session paused to fix a different phase's failures
- UAT session abandoned because blockers were found
- User explicitly asks to stop and switch context
- Session interrupted by `/clear` with unfinished tests

### When NOT to write

- UAT completes normally (all tests run) -- the UAT.md file is sufficient
- Quick re-run of a single test -- no context switch happening
