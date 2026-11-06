# Player Stats -- Architecture

Last updated: 2026-04-09

## Overview

Player stats aggregate per-player and per-character match outcomes. All stat tables are written exclusively by `run_finalization` helpers -- there are no direct reducer calls from clients. `PlayerStat` and `PlayerCharacterStat` are private (not broadcast to clients); `GlobalCharacterStat` is public for leaderboard and analytics use. Stats are partitioned by `seasonId`, `matchType` (Solo | Team), and `teamSize` to allow fine-grained filtering. The `PlayerRelationship` table tracks head-to-head match history between pairs of players.

## Table Relationships

```
PlayerStat (PK: [userId, gameMode, seasonId, matchType, teamSize])  [PRIVATE]
  +-- userId -> User.id  [btree: user_id]
  +-- gameMode: GameMode
  +-- seasonId -> Season.id
  +-- matchType: MatchType (Solo | Team)
  +-- teamSize: u8
  +-- wins: u32
  +-- losses: u32
  +-- draws: u32
  +-- gamesPlayed: u32
  +-- audit columns
  Indexes: user_id (btree), by_user_mode_season (btree, [userId, gameMode, seasonId])

PlayerCharacterStat (PK: [userId, characterName, gameMode, seasonId, matchType, teamSize])  [PRIVATE]
  +-- userId -> User.id  [btree: user_id]
  +-- characterName -> HsrCharacter.name
  +-- gameMode: GameMode
  +-- seasonId -> Season.id
  +-- matchType: MatchType
  +-- teamSize: u8
  +-- timesPickedBlue: u32
  +-- timesPickedRed: u32
  +-- timesBanned: u32
  +-- winsWithCharacter: u32
  +-- lossesWithCharacter: u32
  +-- audit columns
  Indexes: user_id (btree), by_character (btree, characterName)

GlobalCharacterStat (PK: [characterName, gameMode, seasonId, matchType, teamSize])  [public: true]
  +-- characterName -> HsrCharacter.name
  +-- gameMode: GameMode
  +-- seasonId -> Season.id
  +-- matchType: MatchType
  +-- teamSize: u8
  +-- totalPicks: u32
  +-- totalBans: u32
  +-- totalWins: u32
  +-- totalLosses: u32
  +-- pickRate: f64 (computed: totalPicks / totalGames)
  +-- banRate: f64 (computed: totalBans / totalGames)
  +-- winRate: f64 (computed: totalWins / totalPicks)
  +-- audit columns
  Indexes: by_character (btree, characterName), by_game_mode_season (btree, [gameMode, seasonId])

PlayerRelationship (PK: [userId, opponentUserId, gameMode, seasonId])  [PRIVATE]
  +-- userId -> User.id  [btree: user_id]
  +-- opponentUserId -> User.id
  +-- gameMode: GameMode
  +-- seasonId -> Season.id
  +-- winsAgainst: u32
  +-- lossesAgainst: u32
  +-- drawsAgainst: u32
  +-- audit columns
  Indexes: user_id (btree)
```

## Reducer Flows

No direct client-callable reducers. All writes are performed by internal helpers called from `run_finalization`.

### incrementPlayerStats(ctx, userId, gameMode, seasonId, matchType, teamSize, outcome) -- internal helper
1. Find existing `PlayerStat` row by composite PK; if not found, insert with zero counters
2. Increment `wins`, `losses`, or `draws` based on `outcome`
3. Increment `gamesPlayed`
4. Write via delete+insert (composite PK update pattern)

### incrementPlayerCharacterStats(ctx, userId, characterName, teamSide, gameMode, seasonId, matchType, teamSize, outcome, isBan) -- internal helper
1. Find existing `PlayerCharacterStat` row; if not found, insert with zero counters
2. If `isBan=true`: increment `timesBanned`
3. Else: increment `timesPickedBlue` or `timesPickedRed` based on `teamSide`; increment `winsWithCharacter` or `lossesWithCharacter` based on `outcome`
4. Write via delete+insert

### incrementGlobalCharacterStats(ctx, characterName, teamSide, gameMode, seasonId, matchType, teamSize, outcome, isBan, totalGamesForMode) -- internal helper
1. Find existing `GlobalCharacterStat` row; if not found, insert with zero counters
2. Update pick/ban/win/loss totals
3. Recompute `pickRate`, `banRate`, `winRate` from updated totals and `totalGamesForMode`
4. Write via delete+insert

### incrementPlayerRelationship(ctx, userId, opponentUserId, gameMode, seasonId, outcome) -- internal helper
1. Find existing `PlayerRelationship` row by composite PK; if not found, insert with zero counters
2. Increment `winsAgainst`, `lossesAgainst`, or `drawsAgainst`
3. Write via delete+insert

## Phase History

| Decision | Source | Date |
|----------|--------|------|
| PlayerStat and PlayerCharacterStat are private -- not broadcast to clients | Phase 06 CONTEXT.md | 2026-02-28 |
| GlobalCharacterStat is public -- accessible for analytics and leaderboard UI | Phase 06 CONTEXT.md | 2026-02-28 |
| Composite PK includes seasonId, matchType, teamSize for fine-grained filtering | Phase 06 execution | 2026-02-28 |
| No direct reducer calls -- all writes from run_finalization helpers | Phase 06 CONTEXT.md | 2026-02-28 |
| PlayerRelationship head-to-head table: per-pair per-season win/loss/draw | Phase 06 execution | 2026-02-28 |
| pickRate / banRate / winRate computed on write and stored (not computed at query time) | Phase 06 execution | 2026-02-28 |
| MatchType (Solo | Team) partition allows separate stats for 1v1 vs team formats | Phase 06 execution | 2026-02-28 |
| Normalized to standard template | Phase 13 normalization | 2026-04-09 |

---

*Last updated: 2026-04-09*
*Feature owner: Phase 06*

**Behavior specification** (acceptance scenarios, edge cases, phase history): See [contract.md](contract.md)
