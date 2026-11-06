---
name: severity-review
description: Use when a developer asks for a review with a specific depth -- "just check for critical issues", "do a thorough review", or "full review with nitpicks"
---

# Review By Severity

Perform a code review with configurable depth, from critical-issues-only to thorough with nitpicks.

## When to Use
- Developer specifies review depth: "just the critical stuff" or "go thorough"
- Quick pre-merge sanity check (critical only)
- Detailed review for important features (thorough)

## Modes

Determine the mode from the developer's request:

**Critical Only** -- words like "quick", "critical", "just the important stuff", "sanity check"
Focus ONLY on:
- Security vulnerabilities
- Data loss risks
- Crash-causing bugs
- Breaking changes

Skip style, minor optimizations, and suggestions.

**Standard** -- default when no preference is stated, or words like "review", "check"
Report all significant issues:
- CRITICAL: Security, crashes, data loss
- HIGH: Bugs, logic errors, race conditions
- MEDIUM: Performance issues, error handling gaps
- LOW: Style inconsistencies, minor improvements

**Thorough** -- words like "thorough", "detailed", "everything", "nitpick"
Report everything including:
- All levels from standard mode
- NITPICK: Variable naming, formatting, comment quality, import order

## Steps

1. **Determine the mode** from the developer's request (default to Standard).

2. **Get changed files:**
```bash
git diff --name-only HEAD~1
git diff HEAD~1
```

3. **Read and review each changed file.**

4. **Format each issue as:**
```
[SEVERITY] file:line -- Brief description
  Problem: What's wrong
  Fix: How to fix it
```

5. **End with a summary count:**
```
Critical: 0 | High: 1 | Medium: 2 | Low: 3
```
Include Nitpicks count only in Thorough mode.

## Rules
- Match the depth to the requested mode. Don't nitpick in Critical Only mode.
- CRITICAL means "this will break production." Use it sparingly.
- In Standard mode, skip pure formatting issues unless they hurt readability.
- Always provide the fix, not just the problem.

---

## How to Install

Save everything above the line to your project as a `.md` file:

**Claude Code:** `.claude/skills/severity-review/SKILL.md`
**Cursor:** `.cursor/skills/severity-review/SKILL.md`
**Codex:** `.codex/skills/severity-review/SKILL.md`

The skill activates when you ask your agent for a review with a specific depth level.