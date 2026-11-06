<!-- generated-by: gsd-doc-writer -->
# MMR / ELO System

**Architecture:** [architecture.md](architecture.md)

## Feature Overview

The MMR/ELO system tracks player skill ratings across three game modes (MemoryOfChaos, ApocalypticShadow, AnomalyArbitration) using standard ELO math extended with team-size modifiers and account-rating modifiers. Ratings are per-user, per-mode, per-season. Only Ranked matches process MMR; Casual matches skip it entirely. Standalone Ranked matches process MMR inline at finalization; tournament Ranked matches defer MMR to a batch operation after the tournament completes. A materialized Leaderboard table is rebuilt after every MMR processing event.

The system has three admin-tunable config tables: EloConfig (ELO math parameters), AccountRatingConfig (roster strength formula parameters), and Season (season management). All config changes apply to future matches only.

## Reducers

### finalize_match_result

**Purpose:** Run the 19-step finalization pipeline on a Validated match result, including inline MMR processing for standalone Ranked matches.

**Permission:** Admin/Moderator, match referee, or tournament TO/assistant.

**Parameters:** `matchResultId` (u32)

**Flow:**
1. Authenticate caller, find MatchResultRecord by id
2. Verify status is `Validated`
3. Authority check: Moderator+, OR referee, OR tournament TO/assistant (derived via bracketMatch since tournamentId was removed from MatchResultRecord per D-42)
4. Delegate to `runFinalization(ctx, matchResult, userId)` which runs steps 7-18:
   - Steps 7-10: Archive ephemeral data to history tables
   - Step 11: If `matchType=Ranked` AND `isTournamentControlled=false` -> call `processMatchMmr`, stamp `mmrProcessedAt`
   - Step 12: Back-fill MmrHistory sentinel `matchHistoryId=0` for tournament matches already processed
   - Step 13: Increment PlayerStat (win/loss/draw)
   - Step 13b: Rebuild leaderboard (standalone Ranked only)
   - Steps 14-16: Increment spectator stats, player relationships, character stats
   - Step 16.5: Check and award achievements
   - Step 17: Advance bracket (tournament matches)
   - Steps 18-19: Delete ephemeral records, cascade-delete lobby

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Match result not found | "Match result not found." |
| Status is not Validated | "Match result must be Validated before finalization." |
| Caller lacks authority | "You do not have authority to finalize this match result." |

### process_tournament_mmr

**Purpose:** Batch-process MMR for all Validated, unprocessed matches in a completed tournament.

**Permission:** TO/assistant/Moderator/Admin (via `ensureTournamentAccess`).

**Parameters:** `tournamentId` (u32)

**Flow:**
1. Verify tournament access via `ensureTournamentAccess`
2. Verify tournament stage is `Completed` or `Cancelled`
3. Verify `tournament.countTowardsMmr` is true
4. Find all Validated, unprocessed MatchResultRecords via BracketMatch chain (D-42: `BracketMatch.tournament_id` -> `MatchResultRecord.bracket_match_id`)
5. If no unprocessed matches found, log and return (no-op)
6. Read EloConfig, read active Season
7. For each match result: call `processMatchMmr` with `matchHistoryId=0` sentinel, stamp `mmrProcessedAt`
8. Rebuild leaderboard once after all matches processed (with seasonId)

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Tournament not Completed/Cancelled | "Tournament must be Completed or Cancelled to process MMR." |
| countTowardsMmr is false | "This tournament does not count toward MMR (countTowardsMmr=false)." |
| EloConfig not initialized | "ELO config not initialized. Call admin_seed_elo_config first." |

### admin_seed_elo_config

**Purpose:** Create the initial EloConfig row with default values (sentinel PK id=1).

**Permission:** Admin only.

**Parameters:** None.

**Flow:**
1. Verify caller is Admin
2. Check if EloConfig row already exists (id=1)
3. Insert EloConfig with defaults: kFactorNew=40, kFactorMid=20, kFactorVet=10, newThreshold=20, midThreshold=100, initialRating=1000, sizeBonus=150, spreadDivisor=2, maxAccountBonus=200

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Caller is not Admin | "Requires Admin privileges" |
| Config already exists | "ELO config already seeded. Use admin_update_elo_config to modify." |

### admin_update_elo_config

**Purpose:** Update EloConfig fields. All fields are optional; only provided fields are changed.

**Permission:** Admin only.

**Parameters:** `kFactorNew?` (u8), `kFactorMid?` (u8), `kFactorVet?` (u8), `newThreshold?` (u32), `midThreshold?` (u32), `initialRating?` (u32), `sizeBonus?` (u32), `spreadDivisor?` (u8), `maxAccountBonus?` (u32)

**Flow:**
1. Verify caller is Admin
2. Find existing EloConfig row (id=1)
3. Build changes object from non-undefined fields
4. Update EloConfig row with merged changes + audit columns

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Caller is not Admin | "Requires Admin privileges" |
| Config not initialized | "ELO config not initialized. Call admin_seed_elo_config first." |
| No fields provided | "No fields provided to update." |

### admin_seed_rating_config

**Purpose:** Create the initial AccountRatingConfig row with default values (sentinel PK id=1) and compute initial maxPossible from current character pool.

**Permission:** Admin only.

**Parameters:** None.

**Flow:**
1. Verify caller is Admin
2. Check if AccountRatingConfig row already exists (id=1)
3. Compute initial `maxPossible` from current HsrCharacter pool using default weights
4. Insert AccountRatingConfig with defaults: verticalWeight=0.4, horizontalWeight=0.6, compression=0.2, roleExponentDps=2.0, roleExponentSupport=1.3, roleExponentSustain=1.0, archetypeThreshold=3.0, scale=1000.0

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Caller is not Admin | "Requires Admin privileges" |
| Config already exists | "Rating config already seeded. Use admin_update_rating_config to modify." |

### admin_update_rating_config

**Purpose:** Update AccountRatingConfig fields. All fields optional. `maxPossible` is auto-recomputed after every update (per D-11b).

**Permission:** Admin only.

**Parameters:** `verticalWeight?` (f64), `horizontalWeight?` (f64), `compression?` (f64), `roleExponentDps?` (f64), `roleExponentSupport?` (f64), `roleExponentSustain?` (f64), `archetypeThreshold?` (f64), `scale?` (f64)

**Flow:**
1. Verify caller is Admin
2. Find existing AccountRatingConfig (id=1)
3. Validate each provided f64 value is finite and >= 0
4. Merge changes, recompute `maxPossible` using updated config + current HsrCharacter pool
5. Update row with changes + recomputed maxPossible + audit columns

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Caller is not Admin | "Requires Admin privileges" |
| Config not initialized | "Rating config not initialized. Call admin_seed_rating_config first." |
| Negative or non-finite value | "Invalid value for {field}: must be a finite positive number" |
| No fields provided | "No fields provided to update." |

### admin_recalculate_all_ratings

**Purpose:** Recompute maxPossible from current character pool, then iterate all HsrAccount rows and recompute each account's rating. Use after bulk archetype edits or manual config changes (per D-32).

**Permission:** Admin only.

**Parameters:** None.

**Flow:**
1. Verify caller is Admin
2. Find AccountRatingConfig (id=1)
3. Recompute maxPossible from current HsrCharacter pool; update config if changed
4. Iterate all HsrAccount rows, call `updateAccountRating` for each

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Caller is not Admin | "Requires Admin privileges" |
| Config not initialized | "Rating config not initialized. Call admin_seed_rating_config first." |

### create_season

**Purpose:** Create a new Season row. Defaults to `isActive=false`.

**Permission:** Admin only.

**Parameters:** `name` (string), `startDate` (timestamp), `endDate?` (timestamp)

**Flow:**
1. Verify caller is Admin
2. Insert Season with autoInc id, isActive=false

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Caller is not Admin | "Requires Admin privileges" |

### set_active_season

**Purpose:** Deactivate all currently active seasons, then activate the target season. Enforces single-active guarantee.

**Permission:** Admin only.

**Parameters:** `seasonId` (u32)

**Flow:**
1. Verify caller is Admin
2. Find target Season by id
3. Iterate all active seasons (via `is_active` btree index), set `isActive=false` on each
4. Re-read target season (may have been in active list), set `isActive=true`

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Caller is not Admin | "Requires Admin privileges" |
| Season not found | "Season #{seasonId} not found." |

### admin_force_finalize

**Purpose:** Resolve an AwaitingResult match by setting a winner and running full finalization pipeline (including MMR if Ranked).

**Permission:** Moderator+, or tournament organizer/assistant.

**Parameters:** `lobbyId` (u32), `winnerTeamId` (u32)

**Flow:**
1. Auth check, find lobby, verify Moderator+ or tournament organizer
2. Verify lobby stage is `AwaitingResult`
3. Verify `mmrProcessedAt` is undefined (not already processed)
4. Map `winnerTeamId` to `winnerTeamSide` (Blue/Red)
5. Update MatchResultRecord with winner + Validated status
6. Run full finalization pipeline (`runFinalization`)

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Lobby not found | "Lobby not found." |
| Not AwaitingResult | "Can only force-finalize matches in AwaitingResult stage." |
| Already processed | "This match has already been processed. Cannot force-finalize." |
| Insufficient permission | "Only moderators, admins, or the tournament organizer can perform this action." |

## Core Helper: processMatchMmr

**Location:** `spacetimedb/src/helpers/finalizationHelpers.ts`

**Purpose:** Pure MMR processing for a single match. Called by both `runFinalization` (standalone Ranked) and `process_tournament_mmr` (tournament batch).

**Flow:**
1. Read EloConfig (sentinel id=1)
2. Separate participants into Blue and Red teams by `teamSide.tag`
3. Get or create MmrRating row for each participant (userId + gameMode + seasonId); new players start at `initialRating` (default 1000)
4. Calculate team effective ratings using `calculateTeamEffective` (average + sizeBonus - spread penalty)
5. Apply account rating modifier (Fair MMR mode, always active in Phase 5): find each player's active HsrAccount, compute team average account ratings, add modifier to the higher-account side's effective rating
6. Determine actual result from `matchResult.winnerTeamSide`: Blue=1/Red=0, or 0.5/0.5 for draw
7. For each participant:
   - Get player's current K-factor from `getKFactor(matchesPlayed, config)`
   - Calculate expected score using team effective ratings
   - Calculate delta: `K * (actualResult - expectedScore)`, rounded to integer
   - New rating = `max(0, currentRating + delta)` (floor at 0)
   - Delete + insert MmrRating (composite PK upsert pattern)
   - Recalculate `globalCompositeRating` as average across all modes for this user
   - Insert MmrHistory row with previousRating, newRating, delta, matchHistoryId

## Pure Math Helpers

**Location:** `spacetimedb/src/helpers/eloCalculation.ts`

All functions are pure math with zero database access.

- **`getKFactor(matchesPlayed, config)`** -- Returns K-factor tier: kFactorNew (0-newThreshold), kFactorMid (newThreshold+1 to midThreshold), kFactorVet (midThreshold+1 and above). Boundary is inclusive on the lower tier (<=).
- **`calculateExpectedScore(playerEffective, opponentEffective)`** -- Standard ELO formula: `1 / (1 + 10^((opponent - player) / 400))`. Returns probability [0, 1].
- **`calculateRatingChange(kFactor, actualResult, expectedScore)`** -- `Math.round(K * (actual - expected))`. Positive for gain, negative for loss.
- **`calculateTeamEffective(teamRatings, sizeBonus, spreadDivisor)`** -- Solo: raw rating. Team: `round(avg + sizeBonus * (teamSize - 1) - stdev / spreadDivisor)`. Stdev uses population formula (divides by N).
- **`calculateAccountModifier(higherAccountRating, lowerAccountRating, maxAccountBonus)`** -- `round((gap / 1000) * maxAccountBonus)`. Applied to the higher-account side's effective rating.

## Acceptance Scenarios

### First Ranked Match -- New Players Get Rated
**Given:** Two players with no existing MmrRating rows, EloConfig seeded with defaults
**When:** A Ranked standalone match is finalized with Blue as winner
**Then:** MmrRating rows created for both players in the match's gameMode. Winner rating > 1000, loser rating < 1000. Both have matchesPlayed=1. Deltas are symmetric (winner gain + loser loss = 0, within rounding tolerance of 1).

### MmrHistory Records Created
**Given:** A Ranked match is finalized
**When:** processMatchMmr runs for each participant
**Then:** MmrHistory row inserted per participant with previousRating=1000 (initial), newRating matching the new MmrRating.rating, delta = newRating - previousRating. matchHistoryId links to MatchSessionHistory.id (standalone) or 0 sentinel (tournament batch).

### GlobalCompositeRating -- Single Mode
**Given:** A player has MmrRating in only one gameMode
**When:** Rating is updated after a match
**Then:** globalCompositeRating equals the mode rating (average of one value = the value itself).

### GlobalCompositeRating -- Multiple Modes
**Given:** A player has MmrRating rows in multiple gameModes
**When:** Any mode's rating changes
**Then:** globalCompositeRating is recalculated as `round(average of all mode ratings)` for all of that player's MmrRating rows.

### Leaderboard Threshold -- Minimum 2 Matches
**Given:** Player A has matchesPlayed=1, Player B has matchesPlayed=2 in MemoryOfChaos
**When:** Leaderboard is rebuilt
**Then:** Player B appears on the MemoryOfChaos leaderboard. Player A does not (below MIN_MATCHES=2 threshold).

### Leaderboard Rank Ordering
**Given:** Two players each with matchesPlayed >= 2, Player A has higher rating
**When:** Leaderboard is rebuilt
**Then:** Player A has a lower (better) rank number than Player B. Leaderboard is sorted by rating descending.

### Leaderboard Wins from PlayerStat
**Given:** Player has 2 wins and 0 losses after 2 matches
**When:** Leaderboard is rebuilt
**Then:** Leaderboard.wins = 2 (joined from PlayerStat, filtered by gameMode and seasonId).

### Global Leaderboard
**Given:** Players with matchesPlayed >= 2 and globalCompositeRating > 0
**When:** Leaderboard is rebuilt
**Then:** Global category includes those players, sorted by globalCompositeRating descending. Max 100 entries per category.

### Casual Match Skips MMR
**Given:** A Casual match reaches finalization
**When:** `runFinalization` executes
**Then:** Step 11 skips `processMatchMmr` (matchType is not Ranked). No MmrRating or MmrHistory rows created/updated. mmrProcessedAt is never set.

### Tournament Match Defers MMR
**Given:** A Ranked tournament match (`isTournamentControlled=true`) is finalized
**When:** `runFinalization` executes
**Then:** Step 11 skips inline MMR (isTournamentControlled is true). MMR is deferred to `process_tournament_mmr` batch call after tournament ends.

### Tournament Batch Processing
**Given:** Tournament is Completed with countTowardsMmr=true, matches are Validated with mmrProcessedAt=undefined
**When:** `process_tournament_mmr(tournamentId)` is called
**Then:** All Validated unprocessed matches have MMR calculated. MmrRating rows created/updated. MmrHistory rows inserted with matchHistoryId=0 sentinel. mmrProcessedAt stamped on each MatchResultRecord. Leaderboard rebuilt once at the end.

### Tournament Batch No-Op on Second Call
**Given:** `process_tournament_mmr` already ran for this tournament
**When:** Called again
**Then:** No unprocessed matches found (all have mmrProcessedAt set). Logs "No unprocessed matches" and returns. No duplicate MMR processing.

### Tournament countTowardsMmr=false Rejection
**Given:** Tournament has countTowardsMmr=false, stage is Completed
**When:** `process_tournament_mmr` is called
**Then:** Throws "This tournament does not count toward MMR (countTowardsMmr=false)."

### Double-Processing Guard (Structural)
**Given:** A match has been finalized (MatchResultRecord deleted in step 18)
**When:** `finalize_match_result` is called with the same matchResultId
**Then:** "Match result not found." error. No duplicate MMR processing.

### EloConfig Seed Idempotency
**Given:** EloConfig already seeded (id=1 row exists)
**When:** `admin_seed_elo_config` is called again
**Then:** "ELO config already seeded. Use admin_update_elo_config to modify."

### EloConfig Partial Update
**Given:** EloConfig exists with defaults
**When:** `admin_update_elo_config` called with only `kFactorNew=30`
**Then:** kFactorNew updated to 30. All other fields unchanged.

### Season Single-Active Guarantee
**Given:** Season A is active, Season B is inactive
**When:** `set_active_season(seasonB.id)` is called
**Then:** Season A becomes inactive. Season B becomes active. Only one active season exists.

### Season-Aware MMR Isolation
**Given:** Season A is active. Player has MmrRating in Season A with rating 1200.
**When:** Season B is activated and a new Ranked match is finalized
**Then:** New MmrRating row created for Season B at initialRating (1000). Season A row untouched (PK includes seasonId).

### Account Rating Modifier -- Fair MMR
**Given:** Blue player has accountRating=800, Red player has accountRating=200. Both have MMR 1000.
**When:** Ranked match is finalized
**Then:** Blue's effective rating boosted by `round((600/1000) * 200)` = 120 points. F2P player (Red) is the ELO underdog, gaining more for a win and losing less for a loss.

### Account Rating Modifier -- Equal Accounts
**Given:** Both players have equal accountRating
**When:** Ranked match is finalized
**Then:** Account modifier is 0 for both sides. Pure skill ELO.

### Team Size Modifier -- 1v2
**Given:** Solo player vs duo, all at 1000 rating, K=40
**When:** Match is finalized
**Then:** Solo effective = 1000. Duo effective = 1000 + 150*(2-1) - 0 = 1150 (no spread with equal ratings). Solo expected ~30%. Solo wins: +28, Solo loses: -12.

### Team Size Modifier -- Spread Penalty
**Given:** Duo of 1200+1800 vs solo
**When:** Effective ratings calculated
**Then:** Duo avg=1500, stdev=300, spread penalty=300/2=150. Duo effective = 1500 + 150 - 150 = 1500 (spread cancels size bonus entirely).

### Rating Floor at Zero
**Given:** Player with very low rating (e.g., 5)
**When:** Player loses a match with large negative delta (e.g., -20)
**Then:** New rating = max(0, 5 + (-20)) = 0. Rating cannot go negative.

### Concede -- Ranked Non-Tournament Processes MMR
**Given:** A Ranked non-tournament match with a concede (matchEndReason=Concede)
**When:** `runFinalization` executes with concedeFlags
**Then:** `doMmr=true` and `doLeaderboard=true`. MMR is processed. Winner gets rating increase, loser gets decrease. Leaderboard rebuilt.

### Concede -- Ranked Tournament Defers MMR
**Given:** A Ranked tournament match with a concede
**When:** `runFinalization` executes with concedeFlags
**Then:** `doMmr=false` (tournament defers to batch). MMR not processed inline.

### AccountRatingConfig -- maxPossible Recomputation
**Given:** AccountRatingConfig exists, verticalWeight is changed from 0.4 to 0.7
**When:** `admin_update_rating_config` called
**Then:** maxPossible is automatically recomputed using the updated weights and current HsrCharacter pool. Config row updated with new maxPossible.

### AccountRating -- Empty Roster Returns Zero
**Given:** HsrAccount exists with no HsrAccountCharacter rows
**When:** `computeAccountRating` is called
**Then:** Returns 0 (no owned characters -> no vertical or horizontal score).

### AccountRating -- All E6 Returns Scale (1000)
**Given:** All HsrCharacters owned at E6, maxPossible correctly computed
**When:** `computeAccountRating` is called
**Then:** Returns 1000 (combined/maxPossible = 1.0, scaled by config.scale).

## Edge Cases

| Case | Expected Behavior | Notes |
|------|-------------------|-------|
| New player's first match | MmrRating row created with initialRating (1000) via `getOrCreateRating` | matchesPlayed starts at 0, incremented to 1 after processing |
| Symmetric deltas (equal ratings) | Winner gain + loser loss = 0 (within rounding tolerance of 1) | K-factor is per-player, so rounding can cause +-1 difference |
| Draw result (winnerTeamSide undefined) | Both sides get actualResult=0.5, expected=0.5 with equal ratings -> delta=0 | No rating change for perfectly matched draw |
| Rating cannot go negative | `Math.max(0, rating + delta)` floors at 0 | Prevents negative MMR values |
| MmrRating composite PK upsert | Delete + insert pattern (no SpacetimeDB composite PK update) | Necessary because PK is [userId, gameMode, seasonId] |
| globalCompositeRating cascade update | All MmrRating rows for a user are delete+insert'd to update this field | Recalculated as average across all modes after any mode changes |
| Tournament MmrHistory sentinel | matchHistoryId=0 until runFinalization step 12 back-fills it | process_tournament_mmr runs before finalization creates MatchSessionHistory |
| Season 0 (pre-season) | `getActiveSeasonId` returns 0 when no Season has isActive=true | Pre-season matches still get rated, isolated from future seasons |
| K-factor boundary (20 matches) | matchesPlayed=20 -> kFactorNew (40), matchesPlayed=21 -> kFactorMid (20) | Inclusive boundary: <= threshold gets lower tier |
| K-factor boundary (100 matches) | matchesPlayed=100 -> kFactorMid (20), matchesPlayed=101 -> kFactorVet (10) | Same inclusive pattern |
| EloConfig not seeded | processMatchMmr throws "ELO config not initialized" | Finalization fails entirely, match stays un-finalized |
| Leaderboard max 100 per category | Top 100 entries only, 4 categories = max 400 rows per season | Overflow players excluded from leaderboard but still rated |
| Leaderboard wins join | Wins aggregated from PlayerStat across all draftModes for the mode+season | Sum of wins across Classic/Auction/etc. draft modes |
| Account modifier uses team average | Multi-player teams: avg(team account ratings) used for gap calculation | Individual account ratings averaged per side |
| f64 config validation | Negative or non-finite values rejected for AccountRatingConfig fields | "Invalid value for {field}: must be a finite positive number" |
| admin_recalculate_all_ratings | Iterates ALL HsrAccount rows, recomputes each | Use after bulk archetype edits or config changes |
| Concede at Drafting stage (Ranked) | doCharStats=false, doGlobalCharStats=false (no pick data at Drafting) | MMR still processed for Ranked non-tournament concedes |
| Concede achievements | doAchievements=false always for concede (D-76) | Prevents gaming achievement system via strategic concedes |
| admin_force_finalize mmrProcessedAt guard | Rejects if mmrProcessedAt already set | "This match has already been processed. Cannot force-finalize." |
| admin_void_match mmrProcessedAt guard | Rejects if mmrProcessedAt already set | "This match has already been processed. Cannot void." |

## Integration Points

| This Feature | Connects To | How | Direction |
|-------------|------------|-----|-----------|
| `MmrRating` (userId, gameMode, seasonId) | User, Season | FK to User.id and Season.id | reads |
| `MmrHistory.matchHistoryId` | MatchSessionHistory.id | FK to permanent match record (not ephemeral MatchResultRecord) | reads |
| `processMatchMmr` | `finalizationHelpers.runFinalization` step 11 | Called inline for standalone Ranked | writes |
| `processMatchMmr` | `matchFinalization.process_tournament_mmr` | Called in loop for tournament batch | writes |
| `rebuildLeaderboard` | `finalizationHelpers.runFinalization` step 13b | Standalone Ranked: rebuild after PlayerStat increment | writes |
| `rebuildLeaderboard` | `matchFinalization.process_tournament_mmr` step 8 | Tournament: rebuild once after batch | writes |
| `Leaderboard.wins` | `PlayerStat.wins` | Joined during rebuild (filtered by gameMode + seasonId) | reads |
| `EloConfig` | `processMatchMmr` | Read at start of every MMR calculation | reads |
| `AccountRatingConfig` | `computeAccountRating` helper | Read per rating computation | reads |
| `HsrAccount.accountRating` | `processMatchMmr` step 5 | Read per participant for Fair MMR modifier | reads |
| `Season.isActive` | `getActiveSeasonId` helper | Determines seasonId at finalization/rebuild time | reads |
| `MatchResultRecord.mmrProcessedAt` | Finalization gate | Checked by finalize_match_result, admin_force_finalize, admin_void_match | reads/writes |
| `MatchResultRecord.matchType` | MMR conditional | Ranked -> process MMR; Casual -> skip | reads |
| `MatchResultRecord.isTournamentControlled` | MMR deferral | Tournament matches defer MMR to batch | reads |
| `Tournament.countTowardsMmr` | process_tournament_mmr gate | false -> reject batch processing | reads |
| `computeAccountRating` | `updateAccountRating` | Called per HsrAccount during admin_recalculate_all_ratings | writes |
| `HsrAccountCharacter` | `computeAccountRating` | Owned characters drive vertical score | reads |
| `Archetype` + `HsrCharacterArchetype` | `computeAccountRating` | Archetype coverage drives horizontal score | reads |
| `concedeFlags.doMmr` | Concede finalization matrix | Ranked non-tournament: true; others: false | reads |

## Phase History

| Decision | Source | Date |
|----------|--------|------|
| ELO formula with K-factor tiers (40/20/10) | Phase 5 execution | 2026-03-20 |
| Team size modifier (sizeBonus + spread penalty) | Phase 5 execution | 2026-03-20 |
| Account rating modifier (Fair MMR always active) | Phase 5 execution | 2026-03-20 |
| EloConfig as single-row admin-tunable table | Phase 5 discussion | 2026-03-20 |
| globalCompositeRating stored on MmrRating (not computed on-the-fly) for btree index | Phase 5 discussion | 2026-03-20 |
| delta stored in MmrHistory for dashboard display without recalculation | Phase 5 discussion | 2026-03-20 |
| MmrHistory.matchHistoryId FKs to MatchSessionHistory (permanent, not ephemeral MatchResultRecord) | Phase 5 discussion | 2026-03-20 |
| Tournament countTowardsMmr setting determines matchType (Ranked vs Casual) | Phase 5 execution | 2026-03-20 |
| process_tournament_mmr batch processing (avoids mid-tournament MMR volatility) | Phase 5 execution | 2026-03-20 |
| mmrProcessedAt as finalization gate (double-processing guard) | Phase 5 execution | 2026-03-20 |
| Leaderboard materialized table, 100 per category, MIN_MATCHES=2 | Phase 5 execution | 2026-03-20 |
| seasonId added to MmrRating PK [userId, gameMode, seasonId] | Phase 6 execution (D-41/D-42/D-60) | 2026-03-22 |
| seasonId added to Leaderboard PK [category, rank, seasonId] | Phase 6 execution (D-41/D-42/D-60) | 2026-03-22 |
| Season table with isActive btree index; getActiveSeasonId helper | Phase 6 execution (D-47/D-48) | 2026-03-22 |
| rebuildLeaderboard accepts optional seasonId parameter | Phase 6 execution | 2026-03-22 |
| mmr_rating_value index name (not mmr_rating) to avoid namespace collision | Phase 6 execution | 2026-03-22 |
| AccountRatingConfig matrix-based formula (vertical 40% + horizontal 60%) replacing Phase 5 placeholder | Phase 11 execution | 2026-04-03 |
| maxPossible auto-recomputed on every AccountRatingConfig update (D-11b) | Phase 11 execution | 2026-04-03 |
| admin_recalculate_all_ratings for bulk recomputation after config/archetype changes (D-32) | Phase 11 execution | 2026-04-03 |
| Concede finalization matrix: Ranked non-tournament concedes process MMR (D-77/D-78/D-79) | Phase 10 execution | 2026-04-03 |
| D-42: tournamentId removed from MatchResultRecord; derived via BracketMatch chain | Phase 7 execution | 2026-03-25 |
| Full hydration from codebase | Phase 13 normalization | 2026-04-09 |

---

*Last updated: 2026-04-09*
