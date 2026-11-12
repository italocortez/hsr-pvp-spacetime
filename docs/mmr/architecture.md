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
2. Upsert `MmrRating` row for `[userId, gameMode, seasonId]` with provided rating (S11a, triage L5: the code takes no `seasonId` argument; it resolves the active season, the `Season` row with `isActive`, else 0, and reads the row through `by_user_mode_season`; it used to match on the mode only and insert an unset season)
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
3. Sort by `rating` descending; take top-N (configurable, default 100) [superseded in Phase S9b execution: top 20, see below]
4. Delete existing `Leaderboard` rows for `[gameMode, seasonId]`
5. Insert new `Leaderboard` rows with `rank` 1..N

## Phase S8d execution (DECISIONS.md A24(4)(5), A36b)

Tournament MMR is computed only by the `run_tournament_finalize` job of a **Completed** `countTowardsMmr` tournament:
`runFinalization(…, { tournamentMmr: true })` runs step 11 (`processMatchMmr` with the participants' stored
`accountRatingSnapshot`) after the history row exists, so `MmrHistory.matchHistoryId` is the real history id. Records
are processed in bracket order (group matches, Winners, Losers, third place, grand final), so every player's matches
apply in play order. Cancelled tournaments: no MMR (A24(5)). The leaderboard is rebuilt once at the end of the job
(MMR tournaments only). `process_tournament_mmr` and the `matchHistoryId = 0` sentinel are gone; `processMatchMmr`
has one caller, `runFinalization` step 11.


## Phase S8e execution (DECISIONS.md A67(7))

Every lobby is a match: `runFinalization` step 11 and `processMatchMmr` run per record, as before. A tournament Bo3
played over three lobbies produces three records, each finalized by the job in bracket order (records of a match by
creation time), so MMR moves up to three times in an MMR tournament (user confirmed 2026-11-08). Nothing aggregates
across games; the job's `{ tournamentMmr }` option is unchanged. No table change.

## Phase S9b execution (DECISIONS.md A37, A40, A43, A44, A48)

**Leaderboard (A40 mitigation (1), A44(2), A45(1)).** `helpers/stats/leaderboardRebuild.ts` `rebuildLeaderboard(ctx,
seasonId?)` deletes the season's rows of every category and writes at most **20 rows per category** (`MemoryOfChaos`,
`ApocalypticShadow`, `AnomalyArbitration`, `Global`; `LEADERBOARD_MAX_ENTRIES = 20`), ordered by rating descending, then
wins descending, then user id ascending (a total order: equal rating and wins never swap between rebuilds). Eligibility
is unchanged (`MIN_MATCHES = 2` in the season; Global = the stored `globalCompositeRating` > 0). Wins = the season's
`PlayerStat.wins` of the user in that mode (every draft mode and match type), summed for Global. The audit actor of
every row is `SYSTEM_USER_ID` (A37: the finalizing player may sit in an anonymous lobby); the `actingUserId` parameter is
gone, so `runFinalization` and the S8d finalize job call `rebuildLeaderboard(ctx, seasonId)`. One pass over `MmrRating`
(was four). No view: `Leaderboard` stays public. S11a (S10j review F3): the pass reads `MmrRating.season_id.filter(seasonId)` and the delete step `Leaderboard.season_id.filter(seasonId)` (new btree indexes on both tables) instead of scanning every season's rows.

**`view_my_mmr_ratings`** (`views/statsViews.ts`, per-sender; A44(1) D1): the caller's `MmrRating` rows (index `user_id`),
one per mode and season: `gameMode`, `seasonId`, `rating`, `matchesPlayed`, `wins` (the season's PlayerStat wins in that
mode, as above), `lastUpdatedAt` (`lastModifiedDate`). No audit ids. `MmrRating` stays private (A40); other players'
MMR reaches a client only where the UI names that player: the lobby member row (S9a) and `view_my_relationships`
(`otherMmrByMode`, S9b).

## Phase S10f execution (results audit #9)

**Leaderboard and deleted users.** `rebuildLeaderboard` skips every `MmrRating` row whose user has no live `User` row
(no row, or `deletedAt` set). User deletion keeps `MmrRating` / `PlayerStat` (history), so before this a deleted
account could hold a public top-20 slot for the rest of the season; it now drops out at the next rebuild. The check is
cached per user within one rebuild.

## Phase S11a execution (DECISIONS.md A163(1))

**A deleted user leaves the leaderboard at once.** `performUserDeletion` ends, after the `User` row is gone, with
`removeDeletedUserFromLeaderboard(ctx, userId)` (`helpers/stats/leaderboardRebuild.ts`): it deletes the user's
`Leaderboard` rows of every season (`by_user`) and, when one of them was in the active season (`Season.is_active`, or 0
when no season is active), runs `rebuildLeaderboard` for that season, which no longer ranks them, so the next-ranked
players fill the places. Past seasons are not rebuilt: their other rows keep their ranks, so a rank number can be
missing there. No name or avatar of a deleted account stays in the table. Every deletion path goes through it (own
request, ban, staff deletion, server deletion, the old guest of `server_link_provider`, identity GC; the GC never
deletes a guest that holds a `Leaderboard` row).

Cost per deletion:
- A user with no `Leaderboard` row: one `by_user` index read returning nothing; no write.
- A user ranked only in past seasons: that read, plus one delete per row (at most 4 per season).
- A user ranked in the active season: the above, plus one `Season.is_active` read and the full rebuild of that season.
  The rebuild deletes the season's rows (at most 80) and inserts at most 80. It reads every `MmrRating` row of the
  season (`season_id`; R rows, up to 3 per rated user), one `User` row per rated user (cached), and per candidate
  (R mode entries with at least 2 matches, plus one Global entry per such user) the user's `PlayerStat` rows
  (`by_user`), and per Global candidate the user's `MmrRating` rows (`user_id`). So reads grow with the season's rated
  users; writes are bounded at 160 plus the deleted rows. It is the same rebuild a Ranked finalization already runs.

## Phase S10i execution (DECISIONS.md A102)

**`globalCompositeRating` is per season.** `processMatchMmr` (`helpers/results/finalizationHelpers.ts`) averages only
the user's `MmrRating` rows of the season the finalization writes (`seasonId`: the active season, or 0 without one) and
writes the average to those rows only. Rows of earlier seasons keep the value they had when their season was current.
`rebuildLeaderboard` already read the stored value from the season's rows, so the Global category now ranks a
season-only average.

## Phase S10r execution (DECISIONS.md A122)

- **Rating config bounds (A122(12), L44).** `admin_update_elo_config` (`reducers/stats/eloAdmin.ts`; the "update_elo_config" flow above lists older field names) validates the merged row (stored values with the given changes) before the update: `spreadDivisor` must be above 0 ("spreadDivisor must be greater than 0."), and `newThreshold` must not be above `midThreshold` ("newThreshold must not be greater than midThreshold."). Every field is unsigned (u8 / u32), so nothing is negative. `spreadDivisor` is the one divisor read from the config (`stdev / spreadDivisor` in the team rating); the other divisions in `helpers/stats/eloCalculation.ts` are by constants (400, 1000) or by the team size. Equal thresholds are accepted (an empty middle band).

## Phase S11a execution (DECISIONS.md A77)

**Leaderboard card.** `User` is private (A77), so the public `Leaderboard` rows carry the player's card: columns
`displayName` and `avatarCharacterName` after `userId` (schema change, clear-publish). `rebuildLeaderboard` writes them
from the live `User` row of each ranked user (`User.id`, the users `isLive` kept). `syncLeaderboardCard(ctx, userId)`
(`helpers/stats/leaderboardRebuild.ts`) rewrites the user's rows (`Leaderboard.by_user`, at most one per category and
season; delete + insert, audit actor SYSTEM as the rebuild, A37) when the card changed; called after
`update_display_name`, `update_avatar` (`reducers/identity/profile.ts`) and `admin_update_user`. A user deleted after
the last rebuild keeps name and avatar on the rows until the next rebuild, as their id did before. Egress: about +30 B
per row, at most 80 rows per season (implementer's choice of A77(1): columns, not `view_leaderboard`; sizes in
[../views/architecture.md](../views/architecture.md) "Phase S11a execution").

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
| Tournament MMR moved into the finalize job (Completed only, bracket order, real matchHistoryId, one leaderboard rebuild); `process_tournament_mmr` deleted (A24) | Phase S8d execution | 2026-11-07 |
| MMR per game: one record per lobby, each finalized on its own; nothing aggregates across the games of a bracket match (A67(7)) | Phase S8e execution | 2026-11-08 |
| Leaderboard: top 20 per category (rating, wins, user id), SYSTEM audit actor, `actingUserId` parameter removed; `view_my_mmr_ratings` (own rows per mode and season) | Phase S9b execution (DECISIONS.md A37, A40, A43, A44, A48) | 2026-11-08 |
| Leaderboard rebuild skips users with no live `User` row | Phase S10f execution (results audit #9) | 2026-11-09 |
| `globalCompositeRating` computed from and written to the current season's `MmrRating` rows only | Phase S10i execution (DECISIONS.md A102) | 2026-11-10 |
| `admin_update_elo_config` rejects `spreadDivisor` 0 and `newThreshold` above `midThreshold` (merged row) | Phase S10r execution (DECISIONS.md A122) | 2026-11-10 |
| `Leaderboard` carries `displayName` / `avatarCharacterName` (written by the rebuild, rewritten by `syncLeaderboardCard` on a rename or new avatar) because `User` is private | Phase S11a execution (DECISIONS.md A77) | 2026-11-11 |
| `server_set_mmr` writes the active season's row (L5); `Leaderboard` and `MmrRating` gain a `season_id` btree index read by `rebuildLeaderboard` (S10j review F3) | Phase S11a execution (part 2) | 2026-11-11 |
| A user deletion deletes the user's `Leaderboard` rows of every season and rebuilds the active season when it held one (`removeDeletedUserFromLeaderboard`); past seasons are not rebuilt | Phase S11a execution (DECISIONS.md A163(1)) | 2026-11-12 |

---

*Last updated: 2026-11-11 (S11a part 2)*
*Feature owner: Phase 05 / Phase 11*

**Behavior specification** (acceptance scenarios, edge cases, phase history): See [contract.md](contract.md)
