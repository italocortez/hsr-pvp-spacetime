# Brackets & Group Phase Records

**Architecture:** [architecture.md](architecture.md)

## Feature Overview

The brackets feature handles all tournament bracket lifecycle: seeding teams, generating bracket structures (single elimination, double elimination, group phase, hybrid), advancing matches, rolling back results, and transitioning group-phase winners into elimination brackets. Bracket generation uses a two-pass FK wiring approach to handle self-referencing match links. BYE matches are auto-advanced during generation. Group phase records track win/loss/draw/points per team per group with tiebreaker resolution.

## Reducers

### generate_bracket
> **Superseded (Phase S8c execution):** rebuilt on the shared engine (Ready teams by seed, A26a Withdraw, manual / auto groups, no GroupPhaseRecord); see "Acceptance Scenarios (Phase S8c execution)" and architecture.md.


**Purpose:** Generate all BracketMatch rows (and GroupPhaseRecord rows for group formats) for a tournament

**Permission:** Tournament Host / Assistant / Moderator / Admin (ensureTournamentAccess)

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| tournamentId | u32 | Yes | Target tournament |

**Flow:**
1. `ensureTournamentAccess` — verify caller has TO/assistant/mod/admin access
2. Verify tournament is in `Seeding` stage
3. Delete all existing BracketMatch rows for this tournament (idempotent regeneration)
4. Delete all existing GroupPhaseRecord rows for this tournament
5. Load active teams (those with at least one TournamentTeamMember), sorted by seedNumber ascending (unseeded go last)
6. Verify at least 2 active teams exist
7. Dispatch to format-specific generator: SingleElimination, DoubleElimination, GroupOnly, GroupIntoSingleElim, GroupIntoDoubleElim
8. Insert bracket matches via two-pass FK wiring (Pass 1: insert with null FKs, Pass 2: update FK links, Pass 3: auto-advance BYE winners)
9. For group formats: insert GroupPhaseRecord rows (one per team per group, all starting at 0)

**Expected State Changes:**
- All prior BracketMatch rows for tournament deleted
- All prior GroupPhaseRecord rows for tournament deleted
- New BracketMatch rows inserted (linked tree with nextWinnerMatchId / nextLoserMatchId FKs)
- GroupPhaseRecord rows inserted for group formats
- BYE matches: winnerTeamId pre-set, resultStatus=Validated, winner placed in next match slot

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Caller lacks tournament access | Permission error from ensureTournamentAccess |
| Tournament not in Seeding stage | "generate_bracket can only be called during the Seeding stage." |
| Fewer than 2 active teams | "At least 2 active teams are required to generate a bracket." |
| Unknown tournament format | "Unknown tournament format: {formatTag}" |

### seed_bracket
> **Superseded (Phase S8c execution):** Ready teams only, `random` through `ctx.random`, stamps `lastSeedChangeAt`; messages changed (see S8c-1, S8c-2).


**Purpose:** Assign seedNumber to all active teams by MMR or deterministic hash

**Permission:** Tournament Host / Assistant / Moderator / Admin (ensureTournamentAccess)

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| tournamentId | u32 | Yes | Target tournament |
| mode | string | Yes | "mmr" or "random" |

**Flow:**
1. `ensureTournamentAccess`
2. Verify tournament is in `Seeding` stage
3. Validate mode is "mmr" or "random"
4. Load active teams (with at least one TournamentTeamMember)
5. If mode="mmr": sort by captain's MmrRating for tournament.defaultGameMode descending; ties broken by lower team.id
6. If mode="random": sort by deterministic hash `(tournamentId * 31 + teamId) % 2147483647`
7. Assign seedNumber 1..N to sorted teams

**Expected State Changes:**
- TournamentTeam.seedNumber updated for all active teams (1-based index)

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Tournament not in Seeding stage | "seed_bracket can only be called during the Seeding stage." |
| Invalid mode | "Invalid seeding mode. Must be \"mmr\" or \"random\"." |
| No active teams found | "No active teams found for this tournament." |

### swap_seeds
> **Superseded (Phase S8c execution):** deleted; replaced by `set_seed_order` (S8c-3).


**Purpose:** Manually exchange seed numbers between two teams

**Permission:** Tournament Host / Assistant / Moderator / Admin (ensureTournamentAccess)

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| tournamentId | u32 | Yes | Target tournament |
| teamId1 | u32 | Yes | First team |
| teamId2 | u32 | Yes | Second team |

**Flow:**
1. `ensureTournamentAccess`
2. Verify tournament is in `Seeding` stage
3. Find team1 by ID; verify it belongs to this tournament
4. Find team2 by ID; verify it belongs to this tournament
5. Swap their seedNumber values

**Expected State Changes:**
- TournamentTeam[teamId1].seedNumber = team2's old seedNumber
- TournamentTeam[teamId2].seedNumber = team1's old seedNumber

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Tournament not in Seeding stage | "swap_seeds can only be called during the Seeding stage." |
| Team1 not found | "Team #{teamId1} not found." |
| Team1 not in this tournament | "Team #{teamId1} does not belong to tournament #{tournamentId}." |
| Team2 not found | "Team #{teamId2} not found." |
| Team2 not in this tournament | "Team #{teamId2} does not belong to tournament #{tournamentId}." |

### advance_bracket_match
> **Superseded (Phase S8c execution):** deleted (A23); results reach the bracket through `applyBracketResult`.


**Purpose:** Place winner in next match slot; route loser to losers bracket; update group standings

**Permission:** Tournament Host / Assistant / Moderator / Admin (ensureTournamentAccess)

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| bracketMatchId | u32 | Yes | BracketMatch to advance |

**Flow:**
1. Find BracketMatch by ID
2. `ensureTournamentAccess` for match's tournament
3. Verify tournament is in `InProgress` stage
4. For elimination matches: require winnerTeamId set; for group matches: allow draws (winnerTeamId undefined)
5. If winner set and nextWinnerMatchId exists: place winner in that match's first empty slot
6. If winner set and nextLoserMatchId exists: place loser in that match's first empty slot
7. Set Eliminated status on losing team (single elim: any loss; double elim: only if no nextLoserMatchId; grand finals loser is NOT eliminated)
8. If group match: call `updateGroupPhaseRecords` (Win=2pts, Draw=1pt, Loss=0pts)
9. For group draw: set resultStatus=Validated

**Expected State Changes:**
- Next winner BracketMatch: team1Id or team2Id updated with winner
- Next loser BracketMatch: team1Id or team2Id updated with loser
- Losing team members' TournamentEnrolled.status = Eliminated (if applicable)
- GroupPhaseRecord rows updated for group matches

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| BracketMatch not found | "Bracket match not found." |
| Tournament not InProgress | "Bracket advancement is only allowed during InProgress stage." |
| No winner set (elimination match) | "No winner set on this bracket match. Submit a result first." |

### submit_and_advance_bracket
> **Superseded (Phase S8c execution):** deleted (A23); results reach the bracket through `applyBracketResult`.


**Purpose:** Map MatchResult winnerTeamSide to BracketMatch winnerTeamId and auto-advance in one transaction

**Permission:** Any authenticated user (referee/TO authority validated inline)

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| matchResultId | u32 | Yes | MatchResultRecord with winnerTeamSide set |

**Flow:**
1. Authenticate caller
2. Find MatchResultRecord by ID
3. Verify matchResult.bracketMatchId is set
4. Verify matchResult.winnerTeamSide is set
5. Find BracketMatch; derive tournamentId from it (D-42: removed from MatchResultRecord)
6. Verify tournament is InProgress
7. Map winnerTeamSide (Blue → bracketMatch.team1Id, Red → bracketMatch.team2Id)
8. Update BracketMatch: winnerTeamId set, resultStatus=Validated
9. Set Eliminated status on loser (if non-group match)
10. If tournament.autoAdvanceBracket: place winner in nextWinnerMatchId, route loser to nextLoserMatchId, update group standings

**Expected State Changes:**
- BracketMatch.winnerTeamId set, resultStatus=Validated
- If autoAdvanceBracket: next match slots populated
- Losing team TournamentEnrolled.status = Eliminated (if applicable)

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| MatchResult not found | "Match result not found." |
| No bracketMatchId on result | "Not a bracket match -- use submit_match_result for non-tournament matches." |
| No winnerTeamSide set | "No winner on match result. Submit scores first." |
| BracketMatch not found | "Bracket match not found." |
| Tournament not InProgress | "Bracket advancement is only allowed during InProgress stage." |
| Winner team slot empty | "Winner team slot is empty on bracket match." |

### rollback_bracket_match
> **Superseded (Phase S8c execution):** now `rollback_bracket_match(bracketMatchId, reason)` on `rollbackBracketResult`, refused while a downstream match is Decided; the MMR guard is gone (A24) (S8c-14).


**Purpose:** Reverse one bracket advancement step — clear winnerTeamId, remove placements, reverse group records

**Permission:** Tournament Host / Assistant / Moderator / Admin (ensureTournamentAccess)

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| bracketMatchId | u32 | Yes | BracketMatch to roll back |

**Flow:**
1. Find BracketMatch by ID
2. `ensureTournamentAccess`
3. Verify tournament is in `InProgress` stage
4. Verify winnerTeamId is set (something to rollback)
5. Delete linked CalendarEvent + CalendarEventInvite rows (D-22)
6. Check all MatchResultRecords for this bracketMatchId: reject if any have mmrProcessedAt set
7. Remove winner from nextWinnerMatchId slot
8. Remove loser from nextLoserMatchId slot (double elim)
9. Reverse GroupPhaseRecord changes if group match
10. Clear BracketMatch.winnerTeamId, reset resultStatus=Pending

**Expected State Changes:**
- BracketMatch.winnerTeamId cleared, resultStatus=Pending
- Winner removed from next winner match slot
- Loser removed from next loser match slot
- GroupPhaseRecord reversed (points/wins/losses decremented)
- Linked CalendarEvent and CalendarEventInvite rows deleted

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| BracketMatch not found | "Bracket match not found." |
| Tournament not InProgress | "Bracket rollback is only allowed during InProgress stage." |
| No winner to rollback | "No winner to rollback." |
| MMR already processed | "Cannot rollback: MMR has already been processed for this match. MMR reversal is deferred to Phase 5." |

### advance_group_to_elimination
> **Superseded (Phase S8c execution):** deleted; replaced by `advance_group_stage` (S8c-11).


**Purpose:** After all group matches complete, place top N teams from each group into elimination bracket R1 slots using cross-seeding

**Permission:** Tournament Host / Assistant / Moderator / Admin (ensureTournamentAccess)

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| tournamentId | u32 | Yes | Hybrid format tournament |

**Flow:**
1. `ensureTournamentAccess`
2. Verify tournament is InProgress
3. Verify format is GroupIntoSingleElim or GroupIntoDoubleElim
4. Verify groupAdvanceCount >= 1
5. Verify all group BracketMatches are resolved (resultStatus=Validated)
6. Verify elimination R1 slots are empty (not already populated)
7. Load GroupPhaseRecord rows; sort each group by points desc, tiebreaker: head-to-head result, then seeding
8. Collect advancing teams: snake-seed across groups (rank 1 from all groups, then rank 2, etc.)
9. Use fold seeding to determine matchups in elimination R1
10. Place teams into sorted R1 match slots; auto-advance BYE winners

**Expected State Changes:**
- Elimination R1 BracketMatch.team1Id and team2Id populated
- BYE matches: winnerTeamId set, winner placed in R2 slot
- GroupPhaseRecord rows unchanged (read-only in this reducer)

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Tournament not InProgress | "Group-to-elimination advancement is only allowed during InProgress stage." |
| Not a hybrid format | "This reducer is only for hybrid (group-into-elimination) tournament formats." |
| groupAdvanceCount < 1 | "Tournament groupAdvanceCount must be at least 1." |
| Unresolved group matches | "Not all group matches are resolved. Match #{id} is still {status}." |
| Elimination slots already populated | "Elimination bracket already has teams placed. Rollback first if re-advancing." |
| Group with no teams to advance | "Group {groupId} has no teams to advance." |
| Fewer than 2 advancing teams | "At least 2 teams must advance to form an elimination bracket." |

## Acceptance Scenarios

### Seed Bracket (MMR mode)
**Given:** Tournament in Seeding stage, 4 teams with distinct captain MMR ratings (1800, 1600, 1400, 1200)
**When:** `seed_bracket(tournamentId, "mmr")`
**Then:** TournamentTeam.seedNumber assigned by captain's MMR descending -- highest MMR gets seed 1. Ties broken by lower team.id.

### Seed Bracket (Random mode -- deterministic)
> **Superseded (Phase S8c execution):** the hash was team-id order (C-a7); random seeding uses `ctx.random` (S8c-1).

**Given:** Tournament in Seeding stage, 4 teams
**When:** `seed_bracket(tournamentId, "random")` called twice
**Then:** Both calls produce identical seed assignments. Hash: `(tournamentId * 31 + teamId) % 2147483647`

### Swap Seeds
> **Superseded (Phase S8c execution):** `swap_seeds` deleted; see S8c-3.

**Given:** Tournament in Seeding stage, team A (seed 1), team B (seed 4)
**When:** `swap_seeds(tournamentId, teamA, teamB)`
**Then:** Team A now has seed 4, team B has seed 1. Swap-back restores original.

### Generate Single Elimination Bracket
> **Superseded (Phase S8c execution):** BYEs are explicit slots and walkovers use `state` Walkover, exact slots (S8c-5).

**Given:** Tournament format=SingleElimination, 5 seeded teams
**When:** `generate_bracket(tournamentId)`
**Then:** 7 BracketMatch rows (bracket size 8 = next power of 2). All bracketSide=Winners. 3 BYE matches have winnerTeamId pre-set + resultStatus=Validated. BYE winners auto-placed in R2 slots. nextWinnerMatchId FK links form bracket tree to finals.

### Generate Single Elimination Bracket (4 teams, no BYEs)
**Given:** Tournament format=SingleElimination, 4 seeded teams
**When:** `generate_bracket(tournamentId)`
**Then:** 3 BracketMatch rows (2 semifinals + 1 final). All bracketSide=Winners. No BYEs. Both R1 matches have nextWinnerMatchId pointing to the finals match.

### Generate Double Elimination Bracket
**Given:** Tournament format=DoubleElimination, 4 seeded teams, winnerAdvantage=1
**When:** `generate_bracket(tournamentId)`
**Then:** 6 BracketMatch rows: 3 Winners + 2 Losers + 1 GrandFinals. WB R1 matches have nextLoserMatchId pointing to LB. GrandFinals match has winnerAdvantage=1.

### Bracket Regeneration
**Given:** Tournament in Seeding stage with existing BracketMatch rows
**When:** `generate_bracket(tournamentId)` called again
**Then:** Existing rows deleted first, new rows created. Supports re-generation after seed changes.

### Advance Bracket Match
> **Superseded (Phase S8c execution):** `advance_bracket_match` deleted (A23).

**Given:** Tournament InProgress, BracketMatch with winnerTeamId set
**When:** `advance_bracket_match(bracketMatchId)`
**Then:** Winner placed in nextWinnerMatchId slot. In double elim, loser routed to nextLoserMatchId. GroupPhaseRecord updated for Group matches.

### Submit and Advance Bracket
> **Superseded (Phase S8c execution):** `submit_and_advance_bracket` deleted (A23).

**Given:** Tournament InProgress, MatchResultRecord with winnerTeamSide (TeamSide: Blue/Red), autoAdvanceBracket=true
**When:** `submit_and_advance_bracket(matchResultId)`
**Then:** Maps winnerTeamSide (Blue→team1Id, Red→team2Id) directly to winnerTeamId — no TournamentEnrolled lookup needed. Sets BracketMatch.winnerTeamId. Auto-advances winner to next match.

### Rollback Bracket Match
> **Superseded (Phase S8c execution):** see S8c-14 (downstream refusal, no MMR guard, no GroupPhaseRecord).

**Given:** Tournament InProgress, BracketMatch with winnerTeamId set, no MMR processed
**When:** `rollback_bracket_match(bracketMatchId)`
**Then:** winnerTeamId cleared, winner removed from next match slot, loser removed from losers bracket slot. GroupPhaseRecord reversed. If a CalendarEvent is linked to this bracketMatchId, it and its CalendarEventInvite rows are cascade-deleted.

### Group Phase Scoring
> **Superseded (Phase S8c execution):** standings are computed by `rankGroup` (A30, A31: wins only, no draws); GroupPhaseRecord dropped.

**Given:** GroupOnly or hybrid tournament with group phase, matches in a group complete
**When:** `advance_bracket_match` processes group-phase BracketMatch (bracketSide=Group)
**Then:** GroupPhaseRecord rows updated: Win=2pts, Draw=1pt, Loss=0pts. Tiebreaker order: head-to-head result, then total points, then seeding.

### Hybrid Format Group-to-Elimination Advancement
> **Superseded (Phase S8c execution):** see S8c-11 (`advance_group_stage`).

**Given:** Hybrid format (GroupIntoSingleElim or GroupIntoDoubleElim) tournament, all group matches complete
**When:** Group winners determined by GroupPhaseRecord points + tiebreaker
**Then:** Top N teams from each group (N = tournament.groupAdvanceCount) advance to elimination bracket slots.

### DQ Auto-Advance
> **Superseded (Phase S8c execution):** see S8c-15 / S8c-16 (settled through `applyBracketResult`, decidedBy Dq; no autoAdvanceBracket flag).

**Given:** Tournament InProgress, autoAdvanceBracket=true, team A vs team B in bracket
**When:** `dq_participant(tournamentId, playerA)`
**Then:** Player A's TournamentEnrolled status=Disqualified. Team B auto-advanced to next bracket match. If a CalendarEvent is linked to this bracket match, it and its CalendarEventInvite rows are cascade-deleted.

### Team Elimination on Final Bracket Loss
> **Superseded (Phase S8c execution):** the team status becomes Eliminated (A26), set by `applyBracketResult`; enrolment rows are not changed.

**Given:** Tournament InProgress, team loses their final bracket match (eliminated from Winners in single elim, or from Losers in double elim)
**When:** `advance_bracket_match` processes the loss
**Then:** Losing team's TournamentEnrolled status set to Eliminated. Team cannot be placed in further bracket matches.

### Series / Best-of-N
**Given:** BracketMatch with `bestOf` column (e.g., bestOf=3)
**When:** Tournament lobby is created for this bracket match
**Then:** Lobby inherits the bestOf value from BracketMatch. Match result requires winning the series (e.g., first to 2 wins in best-of-3) before the bracket match can be advanced.

### Match End Reasons
MatchEndReason enum replaces MatchOutcome: Completed (normal finish), Draw (tied result), Concede (forfeit by a team). BlueWins/RedWins variants removed — winner is determined by winnerTeamSide on MatchResultRecord.

## Edge Cases

> **Superseded rows (Phase S8c execution):** the rows for `swap_seeds`, `advance_bracket_match`, `submit_and_advance_bracket` and the MMR / "No winner" rollback guards describe deleted code; see "Edge cases (Phase S8c execution)".

| Case | Expected Behavior | Notes |
|------|-------------------|-------|
| seed_bracket invalid mode | Throws "Invalid seeding mode. Must be 'mmr' or 'random'." | |
| seed_bracket outside Seeding stage | Throws "seed_bracket can only be called during the Seeding stage." | |
| swap_seeds outside Seeding stage | Throws "swap_seeds can only be called during the Seeding stage." | |
| swap_seeds by non-TO | Throws "Forbidden: Not authorized for this tournament." | |
| swap_seeds with non-existent team | Throws "Team #X not found." | |
| swap_seeds with team from different tournament | Throws "Team #X does not belong to tournament #Y." | |
| generate_bracket outside Seeding stage | Throws "generate_bracket can only be called during the Seeding stage." | |
| generate_bracket with fewer than 2 teams | Throws "At least 2 active teams are required to generate a bracket." | |
| advance_bracket_match without winnerTeamId | Throws "No winner set on this bracket match. Submit a result first." | |
| advance_bracket_match outside InProgress | Throws "Bracket advancement is only allowed during InProgress stage." | |
| rollback after MMR processed | Throws "Cannot rollback: MMR has already been processed for this match. MMR reversal is deferred to Phase 5." | Only applies after tournament ends + batch MMR runs, or immediately for casual/ranked |
| rollback without winnerTeamId | Throws "No winner to rollback." | |
| submit_and_advance_bracket on non-bracket match | Throws "Not a bracket match -- use submit_match_result for non-tournament matches." | |
| submit_and_advance_bracket without winnerTeamSide | Throws "No winner on match result. Submit scores first." | |
| Hybrid format: fewer teams in group than groupAdvanceCount | All teams in that group advance (no error — groupAdvanceCount is a cap, not a minimum) | |
| Client binding uses `has3RdPlaceMatch` (capital R) | SpacetimeDB codegen quirk -- callers must use binding's casing | |

## Integration Points

| This Feature | Connects To | How | Direction |
|-------------|------------|-----|-----------|
| BracketMatch.tournamentId | Tournament.id | FK reference | Reads |
| BracketMatch.team1Id/team2Id/winnerTeamId | TournamentTeam.id | Reads/Writes | Both |
| BracketMatch.nextWinnerMatchId/nextLoserMatchId | BracketMatch.id | Self-referencing FK | Both |
| GroupPhaseRecord.teamId | TournamentTeam.id | Reads/Writes | Both |
| seed_bracket MMR mode | MmrRating (captain's rating) | Reads captain's rating for tournament.defaultGameMode | Reads |
| submit_and_advance_bracket | MatchResultRecord.winnerTeamSide (TeamSide enum) | Maps Blue/Red to team1Id/team2Id | Reads |
| Lobby.bracketMatchId | BracketMatch.id | Navigated via Lobby (BracketMatch.lobbyId removed) | Reads |
| MatchResultRecord.tournamentId | Derived via BracketMatch (column removed from MatchResultRecord) | D-42 | Derived |
| rollback_bracket_match | MatchResultRecord.mmrProcessedAt | Guard check | Reads |
| dq_participant auto-advance | BracketMatch (scans for team's active match) | Reads/Writes | Both |
| rollback_bracket_match / dq_participant | CalendarEvent + CalendarEventInvite | Cascade delete | Writes |

## Acceptance Scenarios (Phase S8c execution)

Reducers on the shared engine and the single writer (A23); every scenario tagged `Phase S8c execution`. Teams are
`TournamentTeam` rows; "Ready" / "Active" etc. are `TournamentTeam.status` (A26).

### S8c-1 Random seeding uses ctx.random
**Given:** Tournament in Seeding, 5 Ready teams and 1 Forming team; caller has `bracket` (A25)
**When:** `seed_bracket(tournamentId, "random")`
**Then:** the 5 Ready teams get `seedNumber` 1..5 in an order drawn from `ctx.random` (not team-id order, C-a7); the Forming team is not seeded; `Tournament.lastSeedChangeAt` = now.

### S8c-2 MMR seeding
**Given:** Tournament in Seeding, Ready teams whose captains have `MmrRating` rows for `defaultGameMode`
**When:** `seed_bracket(tournamentId, "mmr")`
**Then:** highest captain rating gets seed 1; a captain without a row counts as 0; ties by lower team id; `lastSeedChangeAt` stamped.

### S8c-3 Explicit seed order
**Given:** Tournament in Seeding, Ready teams A, B, C
**When:** `set_seed_order(tournamentId, [C, A, B])`
**Then:** C = seed 1, A = 2, B = 3; `lastSeedChangeAt` stamped. A list missing a Ready team, naming a non-Ready team or repeating a team is rejected and nothing changes.

### S8c-4 Generation withdraws still-Forming teams (A26a)
**Given:** Tournament in Seeding with 2 seeded Ready teams and 1 Forming team (its members enrolled)
**When:** `generate_bracket(tournamentId)`
**Then:** the Forming team becomes Withdrawn, its members' `TournamentEnrolled` rows stay; the bracket is built from the 2 Ready teams; `Tournament.bracketGeneratedAt` = now.

### S8c-5 Single elimination with BYEs
**Given:** SingleElimination, 5 Ready teams seeded 1..5
**When:** `generate_bracket(tournamentId)`
**Then:** 7 rows (bracket of 8, keys `W-R{r}-M{m}`); seeds 6–8 are BYE slots (`teamNIsBye`); the three one-BYE round-1 matches are `Walkover` with `winnerTeamId` = the seeded team, placed in their exact round-2 slot; the remaining round-1 match is `Ready`. With `has3rdPlaceMatch` a `TP` row takes the semifinal losers.

### S8c-6 Double elimination
**Given:** DoubleElimination, 4 seeded Ready teams, `winnerAdvantage` 1
**When:** `generate_bracket(tournamentId)`
**Then:** Winners, Losers and one `GF` row; the WB finalist feeds `GF` slot 1, which carries `winnerAdvantage` 1 (A27); no third-place row (A29).

### S8c-7 Groups, automatic
**Given:** GroupIntoSingleElim, `groupAssignmentMode` Auto, `groupSize` 3, 7 seeded Ready teams
**When:** `generate_bracket(tournamentId)`
**Then:** floor(7 / 3) = 2 groups of 4 and 3, snake-seeded (A32); every team's `groupId` written; only `Group` rows (`G{g}-R{r}-M{m}`, Ready, round robin); no elimination rows yet.

### S8c-8 Groups, manual
**Given:** GroupOnly, `groupAssignmentMode` Manual, `groupSize` 2, 4 seeded Ready teams assigned with `assign_team_group` to groups 0, 0, 1, 1
**When:** `generate_bracket(tournamentId)`
**Then:** two groups exactly as assigned. Rejected (nothing written) when a Ready team has no group, a group index is beyond `groupCount(n, groupSize)`, a group is smaller than `groupSize` while there are two or more groups (fewer Ready teams than `groupSize` = one group, as in the auto split), or sizes differ by more than one.

### S8c-9 Generation preconditions
**Given:** Tournament in Seeding
**When:** `generate_bracket` with fewer than 2 Ready teams, or with a Ready team unseeded, or with duplicate seeds
**Then:** rejected ("At least 2 Ready teams are needed." / "Seed every Ready team first." / "Seed numbers must be unique."); no row written, no team withdrawn.

### S8c-10 Regeneration
**Given:** a generated bracket with stand-ins and calendar events on its matches, then a seed change
**When:** `generate_bracket(tournamentId)` again
**Then:** old rows, their `TournamentStandIn` rows and their calendar events are deleted first (T20); new rows built; `bracketGeneratedAt` ≥ `lastSeedChangeAt`, so Seeding → InProgress passes.

### S8c-11 Group advancement with the status gate
**Given:** GroupIntoSingleElim in progress, every group match settled, one group leader Disqualified
**When:** `advance_group_stage(tournamentId)`
**Then:** the elimination rows are created from `qualifiersFor` (A30 ranking; the Disqualified team is skipped and the next team of its group qualifies); no two teams of one group meet in elimination round 1; grouped teams that did not qualify and were Active become Eliminated. A second call is rejected ("The elimination bracket already exists."); a call with an open group match is rejected ("N group match(es) are not settled."); a GroupOnly tournament is rejected.

### S8c-12 Staff resolve of a Ready match
**Given:** Tournament in progress, a Ready elimination match A vs B; caller has `results`
**When:** `resolve_bracket_match(matchId, A, "no-show")`
**Then:** the match is Decided, `decidedBy` Staff, games 0-0; A placed in its exact next slot; B Eliminated when it has no loser route; the reason is logged; `lastModifiedById` = the caller.

### S8c-13 Staff resolve of a Decided match (correction)
**Given:** the match from S8c-12 Decided for A, its next match still Ready / Pending
**When:** `resolve_bracket_match(matchId, B, "wrong winner")`
**Then:** the result is rolled back (A out of the next slot, B Active again) and re-applied for B (A Eliminated). Resolving again for the same winner changes nothing.

### S8c-14 Rollback refused downstream
**Given:** match M Decided and the match its winner went to also Decided
**When:** `rollback_bracket_match(M, reason)` or `resolve_bracket_match(M, otherTeam, reason)`
**Then:** rejected ("<key> is decided; roll that back first."); nothing changes. Rolling back the downstream match first, then M, succeeds: M returns to Ready, games 0-0, its calendar event deleted.

### S8c-15 DQ settles an open match
**Given:** Tournament in progress, team T (one member) in a Ready match against U; caller has `participants`
**When:** `dq_participant(tournamentId, T's member, reason)`
**Then:** the enrolment is Disqualified (row kept), T is left empty → T Disqualified; the match is Decided for U with `decidedBy` Dq, 0-0, its calendar event deleted; U advances to its exact next slot. With `dqWholeTeam` the same happens for a team of several members, all enrolments Disqualified.

### S8c-16 DQ of a team waiting for its opponent
**Given:** Tournament in progress, team T sits in a Pending match whose other slot waits for the winner of X vs Y
**When:** T is disqualified (whole team)
**Then:** T's slot becomes a BYE; when X vs Y is decided, the match becomes a Walkover for that winner and routes it on. In double elimination a DQ loss in the winners bracket first routes T into the losers bracket, where the same rules apply until T holds no open slot.

### S8c-17 Concede advances the bracket (A38(1))
**Given:** a tournament lobby for a Ready bracket match, in Drafting / Equipping / Scoring
**When:** one side concedes (`concede_match`, forfeit or auto-concede)
**Then:** the match is Decided for the other side through the single writer, `decidedBy` Concede, games = the series score so far; the lobby parks in AwaitingResult (record / lobby handling: S8d). If staff already settled the match, the concede leaves the bracket as it is.

### Edge cases (Phase S8c execution)

| Case | Expected Behavior | Notes |
|---|---|---|
| `seed_bracket` / `set_seed_order` / `generate_bracket` outside Seeding | "Tournament is not in Seeding." | |
| `seed_bracket` with no Ready team | "No Ready teams to seed." | |
| `generate_bracket` with `has3rdPlaceMatch` on a double-elimination format | "A third-place match exists only in single elimination." | A29, also refused at create / update |
| GroupInto* where groups × `groupAdvanceCount` < 2 | "At least 2 teams must qualify from the groups." | |
| `resolve_bracket_match` on a Pending / Walkover / Void match | "<key> is <state>; only a Ready or Decided match can be resolved." | |
| `resolve_bracket_match` / `rollback_bracket_match` outside InProgress | "Tournament is not in progress." | |
| reason longer than 1000 characters | "Reason must be at most 1000 characters." | resolve / rollback |
| `rollback_bracket_match` on a non-Decided match | "<key> is <state>; only a decided match can be rolled back." | |
| DQ of a team in Seeding after generation | team Disqualified, `lastSeedChangeAt` stamped: regenerate before InProgress | |
| DQ of one member of a team that plays on | member leaves; before the bracket the team may drop Ready → Forming | `refreshTeamStatus` (A26) |
| Feeder rollback after a DQ turned a slot into a BYE | refused ("… does not hold …"): the slot no longer holds the team | known limit |

## Acceptance Scenarios (Phase S8d execution)

### S8d-B1 Rollback voids the parked record (A24(3))
**Given** a Decided match whose lobby is parked in AwaitingResult with a Validated record
**When** `results` staff call `rollback_bracket_match`
**Then** the match is Ready, the record is `Voided` and still exists, the lobby and its participants, games, steps and session are gone; a new lobby can be created for the match

### S8d-B2 Resolve of a match with a live lobby
**Given** a Ready match whose lobby is in Scoring (Pending record)
**When** staff resolve it for team2
**Then** the match is Decided (Staff); the record is Voided and the lobby hard-deleted

### S8d-B3 Resolve that agrees with the played result
**Given** a match Decided by a Validated record for team1 (lobby parked)
**When** staff resolve it for team1
**Then** no change (same winner); resolving it for team2 rolls the match back, voids the record and lobby, and decides for team2

### S8d-B4 Validation advances the bracket (A24(1))
**Given** a tournament with `requireResultValidation` and a Submitted record
**When** `results` staff call `validate_match_result`
**Then** the record is Validated with `settledAt`, the match Decided (Played) for the record's team, the lobby stays in AwaitingResult


## Phase History

| Decision | Source | Date |
|----------|--------|------|
| BracketSide enum (5 variants) replaces isLosersBracket bool | Phase 4 CONTEXT.md | 2026-03-17 |
| Explicit FK links (no JSON blob) | Phase 4 CONTEXT.md | 2026-03-17 |
| seedNumber on TournamentTeam (not Participant) | Phase 4 CONTEXT.md | 2026-03-18 |
| GroupPhaseRecord.teamId (not userId) | Phase 4 CONTEXT.md | 2026-03-18 |
| Solo auto-team creation on registration | Phase 4 CONTEXT.md | 2026-03-17 |
| Win=2, Draw=1, Loss=0 group point system | Phase 4 CONTEXT.md | 2026-03-17 |
| Grand finals: single match + winnerAdvantage | Phase 4 CONTEXT.md | 2026-03-17 |
| has3rdPlaceMatch toggle | Phase 4 CONTEXT.md | 2026-03-17 |
| autoAdvanceBracket toggle | Phase 4 CONTEXT.md | 2026-03-17 |
| Rollback: one step, MMR reversal deferred to Phase 5 | Phase 4 CONTEXT.md | 2026-03-17 |
| Deterministic seeding hash for random mode | Phase 4 execution | 2026-03-18 |
| MatchResultParticipant junction table for 2v2/3v3 | Phase 4 CONTEXT.md | 2026-03-18 |
| Two-pass FK wiring for BracketMatch self-references | Phase 4 execution | 2026-03-18 |
| Crossed losers feed-in to minimize rematches | Phase 4 execution | 2026-03-18 |
| BYE auto-advancement during generate_bracket | Phase 4 execution | 2026-03-18 |
| dq_participant auto-advance is inline (one transaction) | Phase 4 execution | 2026-03-18 |
| server_set_mmr reducer for test seeding | Phase 4 UAT | 2026-03-19 |
| Slot placement is first-empty-slot, not seed-ordered (frontend sorts by seedNumber) | Phase 4 UAT | 2026-03-19 |
| team1Id/team2Id replace participant1Id/participant2Id, winnerTeamId replaces winnerId | Phase 04.1 execution | 2026-03-20 |
| teamId replaces participantTeamId (GroupPhaseRecord) | Phase 04.1 execution | 2026-03-20 |
| Rollback during tournament is free -- MMR not yet processed (batched at tournament end) | Phase 04.1 execution | 2026-03-20 |
| rollback_bracket_match cascade-deletes linked CalendarEvent + CalendarEventInvite | Phase 08 CONTEXT.md (D-22) | 2026-03-28 |
| dq_participant cascade-deletes linked CalendarEvent + CalendarEventInvite | Phase 08 CONTEXT.md (D-22) | 2026-03-28 |
| Finalization step 17 auto-advances bracket (isTournamentControlled + winnerTeamSide set) | Phase 10.1 execution | 2026-04-03 |
| Rollback after finalization leaves no re-advance path (match record + lobby deleted) — deferred admin bracket override to Phase 10 | Phase 9 execution | 2026-03-29 |
| Group phase scoring (GroupPhaseRecord): Win=2pts, Draw=1pt, Loss=0pts; tiebreaker: head-to-head, total points, seeding | Phase 9 execution | 2026-03-29 |
| Hybrid format: groupAdvanceCount determines how many teams per group advance to elimination bracket | Phase 9 execution | 2026-03-29 |
| GroupStanding → GroupPhaseRecord rename | Phase 10.1 execution | 2026-04-03 |
| winnerUserId → winnerTeamSide (TeamSide enum: Blue/Red); direct team1Id/team2Id mapping, no TournamentParticipant lookup | Phase 10.1 execution | 2026-04-03 |
| TournamentParticipant → TournamentEnrolled + TournamentTeamMember split | Phase 10.1 execution | 2026-04-03 |
| MatchOutcome → MatchEndReason (Completed/Draw/Concede); BlueWins/RedWins removed | Phase 10.1 execution | 2026-04-03 |
| BracketMatch.lobbyId removed — relationship navigated via Lobby.bracketMatchId | Phase 10.1 execution | 2026-04-03 |
| MatchResultRecord.tournamentId removed — derived via BracketMatch | Phase 10.1 execution | 2026-04-03 |
| Team elimination: TournamentEnrolled status=Eliminated on final bracket loss | Phase 10.1 execution | 2026-04-03 |
| BracketMatch.bestOf column; tournament lobbies inherit bestOf for series play | Phase 10.1 execution | 2026-04-03 |
| Full hydration from codebase — Reducers section added | Phase 13 normalization | 2026-04-09 |
| `seed_bracket` random mode through `ctx.random`; Ready teams only; `set_seed_order` replaces `swap_seeds` (A23, A26, C-a7) | Phase S8c execution | 2026-11-07 |
| `generate_bracket` withdraws still-Forming teams, requires unique seeds, builds manual or snake groups, leaves the GroupInto* elimination part to `advance_group_stage`, stamps `bracketGeneratedAt` (A26a, A32, A36a, T7, T20) | Phase S8c execution | 2026-11-07 |
| `advance_group_stage` replaces `advance_group_to_elimination`: status-gated qualifiers, A30 ranking, elimination generated from the standings (A23, A26, A30) | Phase S8c execution | 2026-11-07 |
| `resolve_bracket_match` replaces `admin_set_bracket_winner`; `rollback_bracket_match` takes a reason and refuses while downstream is Decided (A24(3), A25) | Phase S8c execution | 2026-11-07 |
| `dq_participant` settles open matches with decidedBy Dq; a Pending slot becomes a BYE; empty team → Disqualified (row kept); optional `dqWholeTeam` (A23, A26a(2)) | Phase S8c execution | 2026-11-07 |
| A concede advances the bracket through the single writer, decidedBy Concede (A38(1)) | Phase S8c execution | 2026-11-07 |
| Scenarios S8d-B1..B4: rollback / resolve side effects on records and lobbies, validation hand-off | Phase S8d execution (DECISIONS.md A24(1)(3)) | 2026-11-07 |

---

*Last updated: 2026-11-07*
*Feature owner: Phase 4*
