# Achievements & Titles

**Architecture:** [architecture.md](architecture.md)

## Feature Overview

Admins and Moderators define achievements with flexible, data-driven criteria. The system auto-awards achievements during match finalization when a player's stats satisfy all criteria (AND logic). TOs and Moderators can manually award achievements. Players can display an earned achievement as a title on their profile. Achievements are defined by name, description, rarity, and an optional global cap on total awards.

## Reducers

### create_achievement

**Purpose:** Create a new achievement definition

**Permission:** Moderator+

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| name | string | Yes | Unique achievement name |
| description | string | Yes | Achievement description |
| rarity | AchievementRarity | Yes | Rare, Epic, or Legendary |
| isManualOnly | bool | Yes | If true, never auto-awarded by the checker |
| maxAwards | u32? | No | Global cap on total awards (null = unlimited, 1 = one-time) |

**Flow:**
1. Verify caller is Moderator or Admin
2. Validate name is non-empty
3. Check name uniqueness via `Achievement.name` unique index
4. Insert Achievement row with auto-increment ID

**Expected State Changes:**
- Achievement row inserted (name, description, rarity, isManualOnly, maxAwards, audit columns)

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Caller is not Moderator+ | "Forbidden: Requires Moderator or Admin privileges." |
| Name is empty | "Achievement name must not be empty." |
| Name already exists | "Achievement with this name already exists." |

### update_achievement

**Purpose:** Edit name, description, or rarity of an existing achievement

**Permission:** Moderator+

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| achievementId | u32 | Yes | Target achievement ID |
| name | string? | No | New name (must be unique if changing) |
| description | string? | No | New description |
| rarity | AchievementRarity | Yes | New rarity (required because enum types don't support optional) |

**Flow:**
1. Verify caller is Moderator or Admin
2. Find achievement by ID
3. If name is changing, verify new name doesn't conflict
4. Update row with changed fields, preserve unchanged fields

**Expected State Changes:**
- Achievement.name, description, rarity updated

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Achievement not found | "Achievement #{id} not found." |
| New name conflicts | "Achievement with this name already exists." |

### delete_achievement

**Purpose:** Cascade-delete an achievement and all related data

**Permission:** Admin only

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| achievementId | u32 | Yes | Achievement to delete |

**Flow:**
1. Verify caller is Admin
2. Find achievement by ID
3. CASCADE step 1: Delete all AchievementCriteria rows for this achievement
4. CASCADE step 2: Delete all UserAchievement rows for this achievement
5. CASCADE step 3: Clear User.displayedAchievementId for any user displaying this achievement
6. CASCADE step 4: Delete the Achievement row

**Expected State Changes:**
- All AchievementCriteria rows for this achievement deleted
- All UserAchievement rows for this achievement deleted
- User.displayedAchievementId cleared for users displaying this achievement
- Achievement row deleted

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Caller is not Admin | "Forbidden: Requires Admin privileges." |
| Achievement not found | "Achievement #{id} not found." |

### add_achievement_criteria

**Purpose:** Add a criteria row defining an auto-award condition

**Permission:** Moderator+

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| achievementId | u32 | Yes | Target achievement ID |
| statTable | string | Yes | "PlayerStat", "PlayerCharacterStat", or "MmrRating" |
| statField | string | Yes | Field name to evaluate (e.g. "wins", "rating") |
| operator | ComparisonOperator | Yes | GreaterOrEqual, GreaterThan, Equal, LessThan, LessOrEqual |
| thresholdValue | u32 | Yes | Threshold to compare against |
| filterGameMode | string? | No | Optional GameMode filter |
| filterCharacterName | string? | No | Optional character name filter |
| filterMatchType | string? | No | Optional MatchType filter |

**Flow:**
1. Verify caller is Moderator or Admin
2. Find achievement by ID
3. Check criteria lock: reject if any UserAchievement exists for this achievement
4. Validate statTable is one of the 3 supported resolver targets
5. Insert AchievementCriteria row

**Expected State Changes:**
- AchievementCriteria row inserted (linked to achievement by achievementId)

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Achievement not found | "Achievement #{id} not found." |
| Criteria locked | "Cannot modify criteria: players have already earned this achievement." |
| Invalid statTable | "Invalid statTable \"{name}\". Must be one of: PlayerStat, PlayerCharacterStat, MmrRating." |

### remove_achievement_criteria

**Purpose:** Remove a criteria row

**Permission:** Moderator+

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| criteriaId | u32 | Yes | Criteria row to remove |

**Flow:**
1. Verify caller is Moderator or Admin
2. Find criteria row by ID
3. Check criteria lock: reject if any UserAchievement exists for the parent achievement
4. Delete the criteria row

**Expected State Changes:**
- AchievementCriteria row deleted

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Criteria not found | "AchievementCriteria #{id} not found." |
| Criteria locked | "Cannot modify criteria: players have already earned this achievement." |

### manual_award_achievement

**Purpose:** Manually award an achievement to a specific user

**Permission:** Admin/Moderator unrestricted; TournamentHost scoped to own tournament participants

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| achievementId | u32 | Yes | Achievement to award |
| targetUserId | u32 | Yes | User to receive the award |

**Flow:**
1. Check caller permission tier (Admin/Mod: any user; TO: own tournament participants only)
2. Find achievement by ID
3. Check per-user duplicate: reject if user already has this achievement
4. Check global cap: reject if maxAwards reached
5. Verify target user exists
6. Insert UserAchievement row with awardedById = caller

**Expected State Changes:**
- UserAchievement row inserted (achievementId, userId, awardedById, awardedAt)

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Caller lacks permission | "Forbidden: Requires Moderator, Admin, or Tournament Host privileges." |
| TO targeting non-participant | "Forbidden: Target user is not a participant in your tournaments." |
| Achievement not found | "Achievement #{id} not found." |
| Already earned | "User has already earned this achievement." |
| Global cap reached | "Achievement \"{name}\" has reached its global award limit ({N})." |
| Target user not found | "User #{id} not found." |

### set_displayed_achievement

**Purpose:** Set or clear a user's displayed achievement title

**Permission:** User sets own title; Admin sets for any user

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| targetUserId | u32? | No | Target user (omit or 0 = self) |
| achievementId | u32? | No | Achievement to display (omit or 0 = clear title) |

**Flow:**
1. Determine effective user (self if targetUserId omitted/0)
2. If setting another user's title, require Admin
3. If setting own title, reject guests
4. If achievementId provided and non-zero: verify achievement exists, verify user earned it
5. Update User.displayedAchievementId

**Expected State Changes:**
- User.displayedAchievementId updated (set to achievementId or cleared)

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Non-admin setting other user's title | "Forbidden: Only admins can set titles for other users." |
| Guest setting own title | "Guests cannot set displayed achievements." |
| Achievement not found | "Achievement #{id} not found." |
| User hasn't earned it | "User has not earned this achievement." |

## Auto-Award Pipeline

The achievement checker runs at step 16.5 of `runFinalization`, after all stat increments (PlayerStat, PlayerCharacterStat, MmrRating, Leaderboard) but before bracket advancement.

**For each non-manual achievement, for each participant:**
1. Skip if user already has it (by_user_achievement index)
2. Skip if global cap reached (by_achievement count vs maxAwards)
3. Load criteria rows (by_achievement index); skip if empty
4. Evaluate ALL criteria (AND logic) — all must pass
5. Award if all pass

**Criteria resolution:**
| statTable | Aggregation | Filter support |
|-----------|-------------|----------------|
| PlayerStat | Sum across filtered rows | gameMode, matchType |
| PlayerCharacterStat | Sum across filtered rows | gameMode, matchType, characterName |
| MmrRating | Max across all rows (best-mode) | None |

## Acceptance Scenarios

### Admin Creates Achievement with Criteria
**Given:** Admin user exists
**When:** Admin calls `create_achievement` then `add_achievement_criteria`
**Then:** Achievement row created with correct fields; AchievementCriteria row linked by FK

### Moderator Creates and Manages Achievement
**Given:** Moderator user exists
**When:** Moderator calls `create_achievement`, `update_achievement`, `add_achievement_criteria`, `remove_achievement_criteria`
**Then:** All succeed — Moderator has same CRUD permissions as Admin

### Moderator Cannot Delete Achievement
**Given:** Moderator user exists, achievement exists
**When:** Moderator calls `delete_achievement`
**Then:** Rejected with "Forbidden: Requires Admin privileges."

### Duplicate Name Rejected
**Given:** Achievement "Veteran" exists
**When:** Any Moderator+ calls `create_achievement` with name="Veteran"
**Then:** Rejected with "Achievement with this name already exists."

### Manual Award with Duplicate Prevention
**Given:** UserB already has achievement X
**When:** Admin calls `manual_award_achievement` for UserB + achievement X
**Then:** Rejected with "User has already earned this achievement."

### Global Cap Enforcement
**Given:** Achievement with maxAwards=1, UserA already awarded
**When:** Admin calls `manual_award_achievement` for UserB
**Then:** Rejected with global award limit message

### Criteria Lock After Award
**Given:** Achievement X has criteria, UserB has earned it
**When:** Admin calls `add_achievement_criteria` or `remove_achievement_criteria` for achievement X
**Then:** Rejected with "Cannot modify criteria: players have already earned this achievement."

### Set and Clear Display Title
**Given:** UserB has earned achievement X
**When:** UserB calls `set_displayed_achievement` with achievementId=X, then with achievementId=0
**Then:** User.displayedAchievementId set to X, then cleared to null

### Cascade Delete
**Given:** Achievement with criteria rows, UserAchievement rows, and a user displaying it
**When:** Admin calls `delete_achievement`
**Then:** All criteria rows, all UserAchievement rows deleted; User.displayedAchievementId cleared; Achievement row deleted

### Moderator Cannot Set Other User's Title
**Given:** Moderator exists, UserB exists with earned achievement
**When:** Moderator calls `set_displayed_achievement` with targetUserId=UserB
**Then:** Rejected with "Forbidden: Only admins can set titles for other users."

### Permission Guards
**Given:** Guest user, regular User, Moderator, Admin
**When:** Each calls achievement reducers
**Then:** Guest rejected on all; User rejected on all except set_displayed_achievement (own); Moderator rejected on delete + set other's title; Admin unrestricted

## Edge Cases

| Case | Expected Behavior | Notes |
|------|-------------------|-------|
| Empty achievement name | Rejected: "must not be empty" | Whitespace-only also rejected (trim check) |
| maxAwards=0 | Effectively blocks all awards (cap check: 0 >= 0) | Valid but unusual |
| Achievement with no criteria (non-manual) | Never auto-awarded (empty criteria → skip) | Must add criteria for auto-award to work |
| Manual-only achievement | Skipped by checker entirely | isManualOnly filter in checker |
| Unknown statTable in criteria | Checker logs warning, returns false | Does not crash finalization |
| Unknown statField in criteria | getField returns undefined → sum is 0 | Logs warning |
| rarity param required on update | Callers pass existing rarity to leave unchanged | SpacetimeDB enum types don't support .optional() |

## Integration Points

| This Feature | Connects To | How | Direction |
|-------------|------------|-----|-----------|
| AchievementCriteria | PlayerStat | statTable="PlayerStat" string reference | Reads |
| AchievementCriteria | PlayerCharacterStat | statTable="PlayerCharacterStat" string reference | Reads |
| AchievementCriteria | MmrRating | statTable="MmrRating" string reference | Reads |
| checkAndAwardAchievements | runFinalization (step 16.5) | Called after stat increments | Writes UserAchievement |
| User.displayedAchievementId | Achievement.id | FK reference | Reads |
| manual_award_achievement | Tournament/TournamentEnrolled | TO scope check via organizer_id index | Reads |
| delete_achievement cascade | User table | Clears displayedAchievementId | Writes |
| post-publish.ts | Achievement/AchievementCriteria | Seeds 3 starter achievements | Writes |

## Phase History

| Decision | Source | Date |
|----------|--------|------|
| Criteria-driven achievement system (AchievementCriteria table, ComparisonOperator enum) | Phase 07 RESEARCH.md | 2026-03-27 |
| AchievementTriggerType dropped, replaced by isManualOnly + ComparisonOperator | Phase 07 CONTEXT.md | 2026-03-27 |
| maxAwards replaces isOneTime (null=unlimited, 1=one-time, N=capped) | Phase 07 CONTEXT.md | 2026-03-27 |
| Criteria lock: cannot add/remove criteria after any player earned the achievement | Phase 07 CONTEXT.md | 2026-03-27 |
| No revocation: once earned, always kept | Phase 07 CONTEXT.md | 2026-03-27 |
| Title = Achievement.name via User.displayedAchievementId FK | Phase 07 CONTEXT.md | 2026-03-27 |
| Achievement checker at finalization step 16.5 (after stat increments, before bracket advancement) | Phase 07 execution | 2026-03-28 |
| MmrRating criteria uses Math.max (best-mode), PlayerStat/PlayerCharacterStat use sum (aggregate) | Phase 07 execution | 2026-03-28 |
| Explicit getField switch/case for row field access (no string indexing on SpacetimeDB row objects) | Phase 07 execution | 2026-03-28 |
| 3 starter achievements seeded via post-publish.ts (MMR Elite, Veteran, Solar First Tournament Winner) | Phase 07 execution | 2026-03-28 |
| Moderators have same permissions as Admins except delete_achievement and set other user's title | Phase 07 UAT (user decision) | 2026-03-28 |
| Bootstrap seedAchievements fixed: subscriptionBuilder().subscribeToAllTables() + cache lookup replaces broken onInsert pattern | Phase 07 UAT | 2026-03-28 |
| Full hydration from codebase | Phase 13 normalization | 2026-04-09 |

---

*Last updated: 2026-04-09*
*Feature owner: Phase 7*
