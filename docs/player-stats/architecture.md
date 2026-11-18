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

## Phase S9b execution (DECISIONS.md A37, A40, A43, A44, A48)

- `view_my_player_stats` / `view_my_character_stats` (`views/statsViews.ts`) emit the stat key and counters only: no
  `userId` (the caller) and no audit columns, whose actor is the finalizing user (possibly an anonymized opponent or
  referee, A37). Index-only (`by_user`).
- `GlobalCharacterStat` (public): `incrementGlobalCharacterStat` lost its `actingUserId` parameter and stamps
  `SYSTEM_USER_ID` on insert and update (A37, R2(3)). `view_my_relationships` carries the other player's card
  (displayName, avatar, title, MMR per mode; PAGE-MAP D2, A40) and no audit columns: see
  [../views/architecture.md](../views/architecture.md) "Phase S9b execution".

## Phase S10f execution (results audit #3)

Finalization step 16 (`helpers/results/finalizationHelpers.ts`) writes no `PlayerCharacterStat`, faced, ban or
`GlobalCharacterStat` row for the sentinels `EMPTY` (timer pick or auto-nomination) and `SKIP` (timer ban), and no
`PlayerCharacterStat` row for the system user (a Classic timer pick of a real character, `actorUserId = 0`). For that
timer pick the opponents' faced rows and the global row are still written, with the side read from `actorSlot` as for
a manual pick. Details: `docs/match-results/architecture.md`, "Phase S10f execution".

## Phase S10i execution (DECISIONS.md A106)

A Classic timer auto-pick of a real character (`actorUserId = 0`) now gives the "played" stat to every non-coach
participant of the acting team, with that team's win flag, like an Auction sale (A82(2)); the other team gets "faced"
and the global stat is written once. A manual pick still credits the picker only; `EMPTY` / `SKIP` write nothing.
This replaces the S10f rule "no played row for a timer pick". Details: `docs/match-results/architecture.md`, "Phase
S10i execution" (`playedCredit`).

## Phase S10k execution (DECISIONS.md A110)

The "played" side of `PlayerCharacterStat` (`matchesPlayed`, `wins`, `losses`) follows ownership for every way a team
gets a character: a manual Classic pick, a Classic timer auto-pick and an Auction sale. Each non-coach player of the
owning side who owns the character on any of their HSR accounts (selected for the match or not) gets it, with that
side's win flag; with no owner, a one-player side credits its player and a side of two or more credits nobody. The
faced rows, ban rows, `GlobalCharacterStat`, the `EMPTY` / `SKIP` skip and the concede flags are unchanged; no row for
the system user. Ownership is read at finalization, so later roster edits do not change stored rows. This replaces
A82(2), A82(4) and A106 for the played stat (S10i above: whole team on a timer pick). Details, including the index
reads: `docs/match-results/architecture.md`, "Phase S10k execution".

## Phase S10t execution (DECISIONS.md A129; S10t review F2)

- **Concede in the confirm window (S10t review F2, A129).** The D-79 matrix in `finalizationHelpers.ts` treats a concede or forfeit made while the draft is complete but the lobby still in Drafting (the confirm window, A129 / A130) like an Equipping concede: for a Ranked match the character stats (`PlayerCharacterStat`, `GlobalCharacterStat`) are counted, as they were for the same moment before A129, when a complete draft was already in Equipping. The test is `concedeAtStage === 'Drafting' && !isDraftComplete(lobby, session)` (`helpers/draft/draftComplete.ts`; the session and lobby rows still exist at that point of finalization). `concedeAtStage` stays the literal stage ("Drafting"). A concede mid-draft still skips them. Details: [../match-results/architecture.md](../match-results/architecture.md) "Phase S10t execution".

## Phase S14.5s execution (DECISIONS.md A226 items 5, 6, 7): the Best Ally and Nemesis cards

New per-caller view `view_my_player_cards` (`views/socialViews.ts`; no new table). Row `PlayerCardRow`, at most two:

| Column | Meaning |
|---|---|
| `relation` (PK, string) | `BestAlly` or `Nemesis`; one row each at most, so the client gets `onUpdate` |
| `userId`, `displayName`, `username`, `avatarCharacterName`, `displayedAchievementId?` | the carded player (the username is the handle; the title is the displayed achievement) |
| `mmrByMode` | the active season's rating per mode, `[MemoryOfChaos, ApocalypticShadow, AnomalyArbitration]`, `EloConfig.initialRating` for a mode not played (as `mmrByModeOf`) |
| `globalRating?` | "Global MMR": `MmrRating.globalCompositeRating` of the active season, which finalization stores on each of the season's rows (A102: the rounded average of the player's rated modes of that season, played modes only). Unset before the player's first rated match of the season. The web must not average `mmrByMode` itself (that array fills unplayed modes with the initial rating) |
| `activeAccountRating?` | `accountRating` of the player's game account flagged `isActive` (A226 item 5: always shown on a card); unset when no account is active (none, or none flagged) |
| `accountCount` | the number of the player's game accounts |
| `matches`, `wins`, `losses` | the caller's side: together (BestAlly) or against (Nemesis), summed over the active season |

**Selection.** The caller's `PlayerRelationship` rows of the active season (`seasonId` 0 when none is active, as finalization writes) are summed per other player over game mode, draft mode, match type and team size. Best ally: the most `winsAsAlly` among players with `matchesAsAlly >= 3` (`PLAYER_CARD_MIN_MATCHES`); nemesis: the most losses against (`matchesAsOpponent - winsAsOpponent`) among players with `matchesAsOpponent >= 3`. A count of 0 never qualifies. Ties: fewer shared matches first (the higher rate), then the lower user id. A candidate with no `User` row (deleted) or with `deletedAt` set (pending deletion after an admin deletion or a ban) is skipped and the next one is taken; with no candidate left the row is absent. A suspended player is shown (no other view hides a suspended player from others). One player can be both rows. A guest partner shows with their guest name and 0 accounts.

**Caller.** `callerUserId`: a suspended caller or an unmapped identity gets `[]` (no `.sender` read of its own; the `suspension-structure.test.ts` allow-list is unchanged). Relationships are aggregates of finished matches, whose identities the participants already know (A37); outside a lobby there is no anonymity setting.

**Read set and egress.** Index reads only: `UserIdentity.identity` and `UserSuspension` (through `callerUserId`), `Season.is_active`, `PlayerRelationship.by_user` (the caller's rows of every season, filtered in the body; the table has no index with a season prefix), then for each carded player only `User.id`, `MmrRating.by_user_mode_season` (three reads), `EloConfigTable.id` (only for an unplayed mode) and `HsrAccount.user_id`; plus `User.id` of each skipped deleted candidate. The server re-evaluates the view when a table it reads changes and sends only rows that differ (reasoned from the view diff, not yet measured: the dev egress meter after a publish confirms it), so the two rows reach the client again only when (a) a match the caller finished changes the totals of a carded player or changes who is carded, (b) a carded player's name, handle, avatar, title, active-season rating, active account rating, active flag or account count changes, or (c) the active season changes. A rating change of any other partner sends nothing. By contrast, `view_my_relationships` carries every partner's `otherMmrByMode` on every one of that partner's rows (one per mode, draft mode, match type, team size and season), so each partner's ranked match re-sends all of that partner's rows to the caller; the card view avoids that. Size: two rows of about 80 bytes plus the strings.

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
| Stat views without userId / audit ids; GlobalCharacterStat SYSTEM actor; relationships with the other player's card and MMR | Phase S9b execution (DECISIONS.md A37, A40, A43, A44, A48) | 2026-11-08 |
| No stat rows for `EMPTY`, `SKIP` or the system picker | Phase S10f execution (results audit #3) | 2026-11-09 |
| A Classic timer pick credits the whole acting team with "played" | Phase S10i execution (DECISIONS.md A106) | 2026-11-10 |
| A Ranked concede in the confirm window counts the character stats (the complete draft is treated like Equipping) | Phase S10t execution (DECISIONS.md A129, review F2) | 2026-11-10 |
| "Played" follows ownership (owners on the owning side; lone player when nobody owns it; nobody in a 2+ side) for picks, timer picks and sales | Phase S10k execution (DECISIONS.md A110) | 2026-11-10 |
| `view_my_player_cards`: Best Ally and Nemesis cards from the caller's active-season relationships (3-match threshold, ties by fewer matches then lower id, deleted and pending-deletion players skipped), with the card's ratings, active account rating and account count | Phase S14.5s execution (DECISIONS.md A226 items 5, 6, 7) | 2026-11-18 |

---

*Last updated: 2026-04-09*
*Feature owner: Phase 06*

**Behavior specification** (acceptance scenarios, edge cases, phase history): See [contract.md](contract.md)
