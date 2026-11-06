---
name: pr-description
description: Use when creating a pull request, or when a developer asks to generate a PR description, write PR summary, or document changes for a PR
---

# PR Description Generator

Automatically generate a professional pull request description from git history and diffs.

## When to Use
- Developer is about to create a PR
- Developer asks to "write a PR description" or "summarize my changes"
- After completing work on a feature branch

## Steps

1. **Gather context:**
```bash
git log --oneline main...HEAD
git diff --stat main...HEAD
git diff main...HEAD
```

2. **Detect the PR type** from the branch name:
   - `feat/` or `feature/` -> New Feature
   - `fix/` or `bugfix/` -> Bug Fix
   - `refactor/` -> Refactoring
   - `docs/` -> Documentation
   - `test/` -> Tests
   - `chore/` -> Maintenance

3. **Check for a ticket ID** in the branch name or commit messages (e.g., `JIRA-123`, `#456`).

4. **Generate the PR description** using this structure:

```markdown
## Summary
[1-2 sentence summary of what this PR does and why]

## Changes Made
- [Bullet point for each significant change]
- [3-5 bullets, focused on what changed]
- [Include new dependencies if any]

## Type
[Feature | Bug Fix | Refactor | Docs | Tests | Maintenance]

## Testing
- [ ] [How to verify this works]
- [ ] [Edge cases to check]

## Related
[Closes #ticket-id if found]
```

5. **Adjust emphasis by PR type:**
   - **Feature:** Emphasize user-facing behavior, new capabilities
   - **Bug Fix:** Emphasize what was broken, root cause, how it's fixed
   - **Refactor:** Emphasize why it was needed, confirm no behavior change
   - **Docs/Tests:** Keep it brief

## Rules
- Keep the summary to 1-2 sentences.
- List 3-5 bullet points for changes -- not every file, just significant changes.
- Make it scannable. Reviewers should understand the PR in 15 seconds.
- Don't include implementation details unless they affect the review.

---

## How to Install

Save everything above the line to your project as a `.md` file:

**Claude Code:** `.claude/skills/pr-description/SKILL.md`
**Cursor:** `.cursor/skills/pr-description/SKILL.md`
**Codex:** `.codex/skills/pr-description/SKILL.md`

The skill activates when you ask your agent to write a PR description or create a PR.