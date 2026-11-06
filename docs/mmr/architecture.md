# MMR & ELO -- Architecture

Last updated: 2026-04-09

## Overview

MMR tracks each player's skill rating per game mode per season using an ELO-based formula. `MmrRating` holds the current rating; `MmrHistory` records every change with before/after values. `EloConfig` is a singleton table that stores global formula parameters (K-factors, spread penalty, team modifier). `Season` rows define rating periods; `Leaderboard` holds the top-N snapshot per game mode per season. Account rating modifiers (derived from roster completeness and character age weights) feed into ELO computation via the account rating subsystem. All ELO writes happen inside `run_finalization` and are guarded by `mmrProcessedAt` for idempotency.

## Table Relationships

```
Season (id: u32 autoInc PK)  [public: true]
  +-- name: string
  +-- gameMode: GameMode
  +-- startAt: Timestamp
  +-- endAt: Timestamp?
  +-- isActive: bool
  +-- audit columns
  Indexes: by_game_mode (btree, gameMode), by_active (btree, isActive)

EloConfig (id: u32 PK -- singleton, always id=1)  [public: true]
  +-- kFactorBase: f64
  +-- kFactorHighRating: f64 (reduced K above rating threshold)
  +-- kFactorThreshold: f64 (rating above which high K-factor applies)
  +-- spreadPenaltyEnabled: bool
  +-- spreadPenaltyFactor: f64 (extra loss/gain for large rating gaps)
  +-- teamSizeModifier: f64 (scales K by 1/teamSize for team matches)
  +-- audit columns

MmrRating (PK: [userId, gameMode, seasonId])  [public: true]
  +-- userId -> User.id  [btree: user_id]
  +-- gameMode: GameMode
  +-- seasonId -> Season.id  [btree: season_id]
  +-- rating: f64 (current ELO rating)
  +-- wins: u32
  +-- losses: u32
  +-- draws: u32
  +-- gamesPlayed: u32
  +-- peakRating: f64
  +-- audit columns
  Indexes: user_id (btree), season_id (btree), by_user_mode_season (btree, [userId, gameMode, seasonId])

MmrHistory (id: u32 autoInc PK)  [public: true]
  +-- userId -> User.id  [btree: user_id]
  +-- gameMode: GameMode
  +-- seasonId -> Season.id
  +-- matchResultId -> MatchResultRecord.id  [btree: match_result_id]
  +-- ratingBefore: f64
  +-- ratingAfter: f64
  +-- ratingDelta: f64
  +-- outcome: MatchOutcome (Win | Loss | Draw)
  +-- audit columns
  Indexes: user_id (btree), match_result_id (btree)

Leaderboard (PK: [gameMode, seasonId, rank])  [public: true]
  +-- gameMode: GameMode
  +-- seasonId -> Season.id
  +-- rank: u32
  +-- userId -> User.id
  +-- rating: f64
  +-- wins: u32
  +-- losses: u32
  +-- audit columns
  Indexes: by_game_mode_season (btree, [gameMode, seasonId])
```

## Reducer Flows

### create_season(name, gameMode, startAt, endAt?)
1. `ensureAdmin(ctx)` -- Admin only
2. Validate name non-empty; validate `gameMode` enum tag
3. Deactivate any currently active season for this gameMode (`isActive=false` update)
4. Insert `Season` row with `isActive=true`

### end_season(seasonId)
1. `ensureAdmin(ctx)`
2. Find Season -- reject if not found or not active
3. Set `isActive=false`, `endAt=ctx.timestamp`
4. Trigger leaderboard snapshot: compute top-N `MmrRating` rows for this gameMode+season; delete existing `Leaderboard` rows; insert fresh snapshot

### update_elo_config(params)
1. `ensureAdmin(ctx)`
2. Find singleton `EloConfig` row (id=1) -- upsert
3. Update `kFactorBase`, `kFactorHighRating`, `kFactorThreshold`, `spreadPenaltyEnabled`, `spreadPenaltyFactor`, `teamSizeModifier`

### server_set_mmr(userId, gameMode, seasonId, rating)
1. Server identity check (`ensureServerIdentity(ctx)`)
2. Upsert `MmrRating` row for `[userId, gameMode, seasonId]` with provided rating
3. Used by test harness and admin seeding

### updateEloForMatch(ctx, participants, outcome, gameMode, seasonId) -- internal helper
Called from `run_finalization`. Per-participant:

1. Load `EloConfig` singleton
2. Load or create `MmrRating` for `[userId, gameMode, seasonId]` (default starting rating if first match)
3. Compute expected score: `E = 1 / (1 + 10^((opponentRating - myRating) / 400))`
4. Determine actual score: Win=1.0, Draw=0.5, Loss=0.0
5. Select K-factor: `kFactorHighRating` if `rating >= kFactorThreshold`, else `kFactorBase`
6. Apply team modifier: `K = K * (1 / teamSize)` if `teamSize > 1`
7. Apply spread penalty if enabled and rating gap exceeds threshold
8. Apply account rating modifier: `ratingDelta *= accountRatingModifier` (from account rating subsystem)
9. Compute new rating: `newRating = oldRating + K * (actualScore - expectedScore)`
10. Upsert `MmrRating`: update `rating`, `peakRating` (if new > peak), increment wins/losses/draws/gamesPlayed
11. Insert `MmrHistory` row with `ratingBefore`, `ratingAfter`, `ratingDelta`, `outcome`

### rebuild_leaderboard(gameMode, seasonId)
1. `ensureAdmin(ctx)` OR Moderator+
2. Query all `MmrRating` rows for `[gameMode, seasonId]` via indexes
3. Sort by `rating` descending; take top-N (configurable, default 100)
4. Delete existing `Leaderboard` rows for `[gameMode, seasonId]`
5. Insert new `Leaderboard` rows with `rank` 1..N

## Phase History

| Decision | Source | Date |
|----------|--------|------|
| ELO formula: expected score E = 1/(1+10^((opp-my)/400)); K-factor tiers above threshold | Phase 05 CONTEXT.md | 2026-02-25 |
| EloConfig singleton (id=1) for global formula parameters | Phase 05 execution | 2026-02-25 |
| Team size modifier: K scaled by 1/teamSize for team matches | Phase 05 CONTEXT.md | 2026-02-25 |
| Spread penalty: extra delta for large rating gaps | Phase 05 CONTEXT.md | 2026-02-25 |
| MmrRating PK: [userId, gameMode, seasonId] -- per-season ratings | Phase 05 execution | 2026-02-25 |
| peakRating tracked on MmrRating for all-time high | Phase 05 execution | 2026-02-25 |
| MmrHistory insert per finalized match -- ratingBefore, ratingAfter, ratingDelta | Phase 05 execution | 2026-02-25 |
| Account rating modifier applied to ratingDelta in ELO computation (Phase 11) | Phase 11 execution | 2026-04-01 |
| Leaderboard: top-N snapshot per gameMode+season; rebuilt on season end or manual trigger | Phase 05 execution | 2026-02-25 |
| mmrProcessedAt on MatchResultRecord guards against double finalization | Phase 06 execution | 2026-02-28 |
| Season: per-gameMode rating periods; deactivate old season on create_season | Phase 05 execution | 2026-02-25 |
| Normalized to standard template | Phase 13 normalization | 2026-04-09 |

---

*Last updated: 2026-04-09*
*Feature owner: Phase 05 / Phase 11*

**Behavior specification** (acceptance scenarios, edge cases, phase history): See [contract.md](contract.md)
