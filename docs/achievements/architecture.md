# Achievements & Titles -- Architecture

Last updated: 2026-04-09

## Overview

The achievements system provides a flexible, criteria-driven mechanism for awarding titles and recognition to players. Admins and moderators define achievements with optional criteria (e.g., "reach 50 wins") and award caps. The auto-award pipeline runs inside `runFinalization` after every match finalization, checking all non-manual achievements against each participant's updated stats. Manual awards are also supported for TOs awarding participants in their own tournaments.

Titles are simply Achievement names -- there is no separate title table. Players set their displayed title by pointing `User.displayedAchievementId` at a `UserAchievement` they have earned.

## Table Relationships

```
Achievement (id: u32 autoInc PK)
  +-- name (unique string)
  +-- description (string)
  +-- rarity: AchievementRarity (Rare | Epic | Legendary)
  +-- isManualOnly: bool
  +-- maxAwards: u32? (null=unlimited, 1=one-time, N=capped globally)
  +-- audit columns
  Indexes: name (unique), by_rarity (btree, rarity)

  +-- AchievementCriteria (id: u32 autoInc PK)
  |     achievementId -> Achievement.id  [btree: by_achievement]
  |     statTable: string ('PlayerStat' | 'PlayerCharacterStat' | 'MmrRating')
  |     statField: string (field name within statTable row)
  |     operator: ComparisonOperator (GreaterThanOrEqual | GreaterThan | Equal | LessThan | LessThanOrEqual)
  |     thresholdValue: u32
  |     filterGameMode: string? (GameMode tag)
  |     filterCharacterName: string?
  |     filterMatchType: string? (MatchType tag)
  |     audit columns
  |     Indexes: by_achievement (btree, achievementId), by_stat_table (btree, statTable)

  +-- UserAchievement (id: u32 autoInc PK)
        userId -> User.id  [btree: by_user]
        achievementId -> Achievement.id  [btree: by_achievement]
        awardedById -> User.id (who awarded it)
        audit columns
        Indexes: by_user (btree, userId), by_achievement (btree, achievementId),
                 by_user_achievement (btree, [userId, achievementId])

User (id: u32 autoInc PK)
  +-- displayedAchievementId: u32? -> Achievement.id (title display FK)
```

## Reducer Flows

### create_achievement(name, description, rarity, isManualOnly, maxAwards?)
1. `ensureModerator(ctx)` -- requires Admin or Moderator role
2. Validate name is non-empty after trim
3. Check `Achievement.name.find(name)` -- reject if duplicate name exists
4. Insert Achievement row with audit columns

### update_achievement(achievementId, name?, description?, rarity)
1. `ensureModerator(ctx)` -- requires Admin or Moderator role
2. Find achievement by `Achievement.id.find(achievementId)` -- reject if not found
3. If name changing: check `Achievement.name.find(newName)` -- reject if conflict
4. `Achievement.id.update()` with merged fields and audit update

### delete_achievement(achievementId)
1. `ensureAdmin(ctx)` -- requires Admin role only
2. Find achievement by `Achievement.id.find(achievementId)` -- reject if not found
3. CASCADE step 1: delete all `AchievementCriteria` rows via `by_achievement.filter(achievementId)`
4. CASCADE step 2: delete all `UserAchievement` rows via `by_achievement.filter(achievementId)`
5. CASCADE step 3: iter `User` table, clear `displayedAchievementId` where it matches (small table)
6. CASCADE step 4: delete the `Achievement` row

### add_achievement_criteria(achievementId, statTable, statField, operator, thresholdValue, filterGameMode?, filterCharacterName?, filterMatchType?)
1. `ensureModerator(ctx)` -- requires Admin or Moderator role
2. Find achievement -- reject if not found
3. Criteria lock check: `UserAchievement.by_achievement.filter(achievementId)` -- reject if any award exists (D-25)
4. Validate `statTable` is one of: `['PlayerStat', 'PlayerCharacterStat', 'MmrRating']`
5. Insert `AchievementCriteria` row with audit columns

### remove_achievement_criteria(criteriaId)
1. `ensureModerator(ctx)` -- requires Admin or Moderator role
2. Find criteria row -- reject if not found
3. Criteria lock check: `UserAchievement.by_achievement.filter(criteria.achievementId)` -- reject if any award exists (D-25)
4. Delete the criteria row

### manual_award_achievement(achievementId, targetUserId)
1. `getAuthenticatedUser(ctx)` -- resolves caller
2. Permission check:
   - Moderator+: unrestricted
   - TournamentHost: only own tournament participants (via `Tournament.organizer_id` + `TournamentEnrolled.by_tournament_and_user`)
   - Otherwise: reject
3. Find achievement -- reject if not found
4. Per-user duplicate check via `UserAchievement.by_user_achievement.filter([targetUserId, achievementId])`
5. Global cap check: if `maxAwards` set, count via `by_achievement` index -- reject if at cap (D-04)
6. Verify target user exists
7. Insert `UserAchievement` row

### set_displayed_achievement(targetUserId?, achievementId?)
1. `getAuthenticatedUser(ctx)` -- resolves caller
2. Determine `effectiveUserId`: defaults to caller if `targetUserId` is 0 or absent
3. If setting another user's title: require Admin role
4. If setting own title: reject guests
5. Find target user -- reject if not found
6. If `achievementId` is set and non-zero:
   - Verify achievement exists
   - Verify user has earned it via `by_user_achievement` index
   - Update `User.displayedAchievementId`
7. Otherwise: clear `User.displayedAchievementId` (set to undefined)

### Auto-Award Pipeline (in runFinalization)
1. Load all non-manual achievements via `Achievement.iter()` (small admin table, <100 rows)
2. For each achievement, for each match participant:
   a. Skip if user already has it (`by_user_achievement` index)
   b. Skip if global cap reached (`by_achievement` count vs `maxAwards`)
   c. Load criteria via `by_achievement` index
   d. Evaluate ALL criteria (AND logic) against stat tables
   e. Award if all criteria pass (insert `UserAchievement`)

Criteria resolution uses a hardcoded resolver map:
- `PlayerStat`: sum filtered rows by `by_user` index
- `PlayerCharacterStat`: sum filtered rows by `by_user` index
- `MmrRating`: max across all rows for user (`user_id` index)

## Phase History

| Decision | Source | Date |
|----------|--------|------|
| AchievementTriggerType enum dropped; replaced by isManualOnly bool + ComparisonOperator enum | Phase 07 CONTEXT.md | 2026-03-14 |
| AchievementCriteria filter columns use t.string().optional() not enum types | Phase 07 execution | 2026-03-14 |
| update_achievement rarity param required (not optional) | Phase 07 execution | 2026-03-14 |
| Achievement checker uses iter() on Achievement table and Math.max for MmrRating | Phase 07 execution | 2026-03-14 |
| Moderators have same achievement permissions as Admins except delete_achievement and set_displayed_achievement for other users | Phase 07 execution | 2026-03-14 |
| Criteria lock: AchievementCriteria rows cannot be modified once any UserAchievement exists (D-25) | Phase 07 CONTEXT.md | 2026-03-14 |
| maxAwards enforced both per-user (no duplicates) and globally (D-04) | Phase 07 CONTEXT.md | 2026-03-14 |
| Cascade: Achievement -> AchievementCriteria -> UserAchievement -> User.displayedAchievementId (D-23) | Phase 07 CONTEXT.md | 2026-03-14 |
| Title = Achievement.name; no separate title table; displayedAchievementId FK on User (D-17, D-18) | Phase 07 CONTEXT.md | 2026-03-14 |
| Normalized to standard template | Phase 13 normalization | 2026-04-09 |

---

*Last updated: 2026-04-09*
*Feature owner: Phase 07*

**Behavior specification** (acceptance scenarios, edge cases, phase history): See [contract.md](contract.md)
