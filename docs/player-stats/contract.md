# Player Stats

**Architecture:** [architecture.md](architecture.md)

## Feature Overview

Player stats are computed automatically during match finalization — there are no user-callable reducers for directly modifying stats. The finalization pipeline (`runFinalization`) writes to `PlayerStat`, `PlayerRelationship`, `PlayerCharacterStat`, `BanStat`, `FacedStat`, and global character stats using a composite-PK delete+insert upsert pattern. Stats are partitioned by `(userId, gameMode, draftMode, seasonId, matchType, teamSize)`. Clients read aggregate stats via views (`view_player_stats`, `view_player_character_stats`) rather than raw tables.

## Stat Computation

### When Stats Are Written

Stats are written during match finalization. Finalization is triggered:
1. **Casual matches:** Automatically inline during `submit_match_result` (D-37)
2. **Ranked matches:** Explicitly via `finalize_match_result` after result is Validated
3. **Admin force-finalize:** Via `admin_force_finalize` for stuck AwaitingResult matches
4. **Tournament batch MMR:** Via `process_tournament_mmr` for unprocessed tournament matches

### PlayerStat Increment

Called once per participant (not coaches or spectators) after finalization. Composite PK: `(userId, gameMode, draftMode, seasonId, matchType, teamSize)`.

| Field | How Computed |
|-------|-------------|
| `matchesPlayed` | +1 always |
| `wins` | +1 if participant's team side matches `winnerTeamSide` |
| `losses` | +1 if participant lost (not win, not draw) |
| `draws` | +1 if `matchEndReason=Draw` |
| `matchesSpectated` | Preserved (not incremented on participant path) |

Upsert pattern: if a row exists for the PK tuple, delete then insert with updated counters; otherwise insert fresh.

### PlayerRelationship Increment

Called for every directional pair `(A, B)` among participants — both ally pairs and opponent pairs — giving bidirectional tracking. Each direction is a separate row.

| Field | How Computed |
|-------|-------------|
| `matchesWith` | +1 if both on same side (isAlly=true) |
| `matchesVs` | +1 if on opposing sides (isAlly=false) |
| `winsWith` | +1 if allies and won |
| `winsVs` | +1 if opponents and caller won |

### PlayerCharacterStat Increment

Called once per character pick per participant. Composite PK: `(userId, characterName, gameMode, draftMode, seasonId, matchType, teamSize)`. Tracks `picked`, `wins`, `losses`, `draws`.

### BanStat Increment

Called once per ban action. Composite PK: `(userId, characterName, gameMode, draftMode, seasonId, matchType, teamSize)`. Tracks `banned` count.

### FacedStat Increment

Called once per character facing (characters picked by the opposing team). Tracks how often a player faces a specific character. Composite PK: `(userId, characterName, gameMode, draftMode, seasonId, matchType, teamSize)`.

### Global Character Stat Increment

Aggregates character picks across all players into `GlobalCharacterStat` rows per `(characterName, gameMode, draftMode, seasonId, matchType, teamSize)`. Tracks `totalPicked`, `totalWins`, `totalLosses`, `totalDraws`, `totalBanned`.

### Composite PK Partition Key

All stat tables share the same partition dimensions:

| Dimension | Values |
|-----------|--------|
| `gameMode` | MemoryOfChaos, ApocalypticShadow, AnomalyArbitration |
| `draftMode` | Classic, Snake |
| `seasonId` | Active season ID at time of finalization (0 if no active season) |
| `matchType` | Casual, Ranked |
| `teamSize` | 1, 2, or 3 |

## Acceptance Scenarios

### Player Win/Loss Tracking
**Given:** Match finalized (casual auto-finalize or ranked finalize_match_result)
**When:** Finalization pipeline runs
**Then:** Each participant's PlayerStat row incremented: matchesPlayed +1, wins +1 or losses +1 based on outcome. PK breakdown per gameMode/draftMode/seasonId/matchType/teamSize.

### Spectated Count (D-30)
**Given:** Lobby with 2 spectators at finalization time
**When:** Finalization pipeline runs
**Then:** Each spectator's PlayerStat.matchesSpectated incremented +1 for the matching PK bucket. Spectator identities NOT preserved in MatchParticipantHistory (D-31).

### Best Ally / Nemesis (D-40)
**Given:** Player A and Player B on the same team, match finalized as a win
**When:** PlayerRelationship rows updated
**Then:** A's row for otherUserId=B: matchesAsAlly +1, winsAsAlly +1. B's row for otherUserId=A: same. Bidirectional pair increment. Client derives Best Ally (highest winsAsAlly ratio) and Nemesis (highest opponent winsAsOpponent) from these counters.

### Character Pick Stats
**Given:** Player picked character "Acheron" in a match that was won
**When:** Finalization pipeline processes picks from MatchSessionStep rows
**Then:** PlayerCharacterStat for [userId, "Acheron", ...]: matchesPlayed +1, wins +1. Only picked characters count -- bans excluded from pick stats (D-27).

### Character Ban Stats (D-23)
**Given:** Character "Kafka" was banned during draft, 4 participants in match
**When:** Finalization pipeline processes bans from MatchSessionStep rows
**Then:** ALL 4 participants get PlayerCharacterStat.timesBannedInMatch +1 for "Kafka". Answers "how available is this character in my matches?" GlobalCharacterStat.timesBanned +1 for "Kafka" (community aggregate, D-29).

### Character Faced Stats (D-24)
**Given:** Player A's opponent picked "Silver Wolf", Player A won
**When:** Finalization pipeline processes opponent picks
**Then:** Player A's PlayerCharacterStat for "Silver Wolf": timesFaced +1, winsAgainst +1. Answers "which characters do I struggle against most?"

### Global Character Stats (D-34)
**Given:** Match finalized, "Acheron" was picked by winning team, "Kafka" was banned
**When:** Finalization pipeline runs global stat increments
**Then:** GlobalCharacterStat for "Acheron": timesPicked +1, wins +1, matchesPlayed +1. GlobalCharacterStat for "Kafka": timesBanned +1. Public table -- enables community pick rate, ban rate, win rate calculations.

### Season Bucketing (D-45)
**Given:** Active season with id=3, match finalized
**When:** Finalization reads active season from Season table
**Then:** All stat rows written with seasonId=3 in PK. If no active season exists, seasonId=0 (pre-season). Client sums across all seasons for career/all-time stats (D-35).

### Private Stats with Per-User Views (D-33)
**Given:** PlayerStat, PlayerCharacterStat, PlayerRelationship tables are private (public: false)
**When:** Client subscribes to view_my_player_stats, view_my_character_stats, view_my_relationships
**Then:** Only the caller's own stat rows returned. Stats visibility follows user's roster visibility setting. In-match context: lobby/tournament rosterVisibility overrides.

### Match History Replay (D-50 through D-55)
**Given:** Match finalized
**When:** Finalization pipeline writes history
**Then:** Four history tables populated:
- **MatchSessionHistory** -- match summary (winner, mode, duration)
- **MatchParticipantHistory** -- who played (real userId + displayName, D-53)
- **MatchSessionStepHistory** -- individual draft step rows (actorUserId + actorDisplayName, sequence, action, characterName, D-50)
- **MatchResultGameHistory** -- per-game/per-boss scores (mirrors MatchResultGame, D-51)

All flat structured rows, zero JSON blobs (D-55). Self-contained for replay rendering with zero lookups.

### Create Season (Admin)
**Given:** Admin user
**When:** `create_season(name="Patch 3.0", startDate, endDate)`
**Then:** Season row inserted with isActive=false. Season is inert until explicitly activated.

### Set Active Season (Single-Active Guarantee)
**Given:** Season #1 is active (isActive=true), Season #2 exists (isActive=false)
**When:** Admin calls `set_active_season(seasonId=2)`
**Then:** Season #1.isActive set to false, Season #2.isActive set to true. Only one season active at any time.

### Casual Auto-Finalize (D-37)
**Given:** MatchResultRecord with matchType=Casual, all captains confirmed
**When:** `submit_match_result(matchResultId, winnerUserId)` called
**Then:** Status changes to Validated AND finalization runs inline in same transaction. Stats, history, and MMR (if ranked) all written atomically. No separate finalize_match_result call needed for casual matches.

## Edge Cases

| Case | Expected Behavior |
|------|-------------------|
| Mirror pick (both sides pick same character) | Both "picked" and "faced" counters fire on same PlayerCharacterStat row -- independent columns, no conflict (D-26) |
| Bans excluded from pick stats | Only picked characters count for matchesPlayed/wins/losses. Bans only increment timesBannedInMatch (D-27) |
| Classic Pick vs Auction WinBid | Both map to same pick stat increment. draftMode in PK keeps them separate (D-28) |
| No stat rollback on disputes | Disputes resolved BEFORE finalization -- stats not yet written. Post-finalization corrections are manual admin cases (D-36) |
| Client sums across seasons for all-time | No all-time bucket row. Client aggregates across seasonId values (D-35) |
| Spectator identities not in history | matchesSpectated incremented on PlayerStat, but no MatchParticipantHistory row for spectators (D-31) |
| Pre-season match | seasonId=0 used when no active Season exists (D-45) |
| No active season at finalization | seasonId defaults to 0, stats still written (D-45) |
| create_season by non-admin | Throws permission error (ensureAdmin) |
| set_active_season with invalid seasonId | Throws "Season #X not found." |
| set_active_season on already-active season | No-op on deactivation (season is in active list, gets deactivated then reactivated). Result: same season remains active. |
| PlayerRelationship self-reference | Never created -- userId and otherUserId are always different participants |
| Ban stat semantics differ per table | PlayerCharacterStat.timesBannedInMatch = personal experience; GlobalCharacterStat.timesBanned = community meta (D-29) |

## Testing Notes

**Deferred to Phase 9 UAT:** Tests requiring lobby CRUD, pick/ban reducers, or full match lifecycle. Phase 6 tests cover finalization pipeline logic with pre-seeded data.

## Integration Points

| This Feature | Connects To | Direction |
|-------------|------------|-----------|
| PlayerStat | finalize_match_result / auto-finalize | Written at finalization |
| PlayerCharacterStat | MatchSessionStep (picks/bans) | Reads steps, writes stats |
| PlayerRelationship | MatchResultParticipant (team sides) | Reads participants, writes relationships |
| GlobalCharacterStat | MatchSessionStep (picks/bans) | Reads steps, writes global stats |
| MatchSessionStepHistory | MatchSessionStep (ephemeral) | Reads then archives |
| MatchResultGameHistory | MatchResultGame (ephemeral) | Reads then archives |
| MatchParticipantHistory | MatchResultParticipant (ephemeral) | Reads then archives |
| Season.id | All stat PKs | Reads active season at finalization |
| view_my_player_stats | PlayerStat (private) | Per-user view |
| view_my_character_stats | PlayerCharacterStat (private) | Per-user view |
| view_my_relationships | PlayerRelationship (private) | Per-user view |

## Phase History

| Decision | Source | Date |
|----------|--------|------|
| PlayerCharacterStat gets 4 new columns: banned/faced/winsAgainst/lossesAgainst (D-22) | Phase 6 CONTEXT.md | 2026-03-21 |
| timesBannedInMatch incremented for ALL participants per ban (D-23) | Phase 6 CONTEXT.md | 2026-03-21 |
| timesFaced/winsAgainst/lossesAgainst track opponent character performance (D-24) | Phase 6 CONTEXT.md | 2026-03-21 |
| Full character matchup matrix deferred (D-25) | Phase 6 CONTEXT.md | 2026-03-21 |
| Mirror-pick safe: independent pick + faced columns (D-26) | Phase 6 CONTEXT.md | 2026-03-21 |
| Bans excluded from pick stats (D-27) | Phase 6 CONTEXT.md | 2026-03-21 |
| Classic Pick and Auction WinBid both map to pick increment (D-28) | Phase 6 CONTEXT.md | 2026-03-21 |
| Ban stat semantics split: personal vs community (D-29) | Phase 6 CONTEXT.md | 2026-03-21 |
| matchesSpectated incremented at finalization for lobby spectators (D-30) | Phase 6 CONTEXT.md | 2026-03-21 |
| Spectator identities not preserved in history (D-31) | Phase 6 CONTEXT.md | 2026-03-21 |
| Spectated count follows full PK pattern (D-32) | Phase 6 CONTEXT.md | 2026-03-21 |
| Stat tables private with per-user views (D-33) | Phase 6 CONTEXT.md | 2026-03-21 |
| GlobalCharacterStat public table for community meta (D-34) | Phase 6 CONTEXT.md | 2026-03-21 |
| Client sums across seasons for all-time, no all-time bucket (D-35) | Phase 6 CONTEXT.md | 2026-03-21 |
| No stat rollback on disputes (D-36) | Phase 6 CONTEXT.md | 2026-03-21 |
| Casual auto-finalize inline in submit_match_result (D-37) | Phase 6 CONTEXT.md | 2026-03-21 |
| PlayerStat PK expanded: +seasonId, +matchType, +teamSize (D-38) | Phase 6 CONTEXT.md | 2026-03-21 |
| PlayerCharacterStat PK expanded (D-39) | Phase 6 CONTEXT.md | 2026-03-21 |
| PlayerRelationship PK expanded (D-40) | Phase 6 CONTEXT.md | 2026-03-21 |
| MmrRating PK: +seasonId (D-41) | Phase 6 CONTEXT.md | 2026-03-21 |
| Leaderboard PK: +seasonId (D-42) | Phase 6 CONTEXT.md | 2026-03-21 |
| seasonId=0 for pre-season matches (D-45) | Phase 6 CONTEXT.md | 2026-03-21 |
| Season table: full table with admin management (D-47/D-48) | Phase 6 CONTEXT.md | 2026-03-21 |
| No costSetId link on Season (D-49) | Phase 6 CONTEXT.md | 2026-03-21 |
| MatchSessionStepHistory repurposed to individual rows (D-50) | Phase 6 CONTEXT.md | 2026-03-21 |
| MatchResultGameHistory new table for score archival (D-51) | Phase 6 CONTEXT.md | 2026-03-21 |
| rosterBlue/rosterRed dropped from MatchSessionHistory (D-52) | Phase 6 CONTEXT.md | 2026-03-21 |
| History tables denormalize display names for self-containment (D-53) | Phase 6 CONTEXT.md | 2026-03-21 |
| Finalization reads MatchSessionStep for both stats and archival (D-54) | Phase 6 CONTEXT.md | 2026-03-21 |
| Four history tables, all flat rows, zero JSON (D-55) | Phase 6 CONTEXT.md | 2026-03-21 |
| 19-step finalization pipeline (D-56) | Phase 6 CONTEXT.md | 2026-03-21 |
| Update 38 existing tests for new PK shapes (D-65) | Phase 6 CONTEXT.md | 2026-03-21 |
| create_season creates inactive season; set_active_season enforces single-active guarantee | Phase 9 execution | 2026-03-29 |
| Full hydration from codebase; Feature Overview and Stat Computation section added | Phase 13 normalization | 2026-04-09 |

---

*Last updated: 2026-04-09*
