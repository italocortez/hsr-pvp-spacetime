# Brackets & Group Phase Records

**Architecture:** [architecture.md](architecture.md)

## Feature Overview

The brackets feature handles all tournament bracket lifecycle: seeding teams, generating bracket structures (single elimination, double elimination, group phase, hybrid), advancing matches, rolling back results, and transitioning group-phase winners into elimination brackets. Bracket generation uses a two-pass FK wiring approach to handle self-referencing match links. BYE matches are auto-advanced during generation. Group phase records track win/loss/draw/points per team per group with tiebreaker resolution.

## Reducers

### generate_bracket

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
**Given:** Tournament in Seeding stage, 4 teams
**When:** `seed_bracket(tournamentId, "random")` called twice
**Then:** Both calls produce identical seed assignments. Hash: `(tournamentId * 31 + teamId) % 2147483647`

### Swap Seeds
**Given:** Tournament in Seeding stage, team A (seed 1), team B (seed 4)
**When:** `swap_seeds(tournamentId, teamA, teamB)`
**Then:** Team A now has seed 4, team B has seed 1. Swap-back restores original.

### Generate Single Elimination Bracket
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
**Given:** Tournament InProgress, BracketMatch with winnerTeamId set
**When:** `advance_bracket_match(bracketMatchId)`
**Then:** Winner placed in nextWinnerMatchId slot. In double elim, loser routed to nextLoserMatchId. GroupPhaseRecord updated for Group matches.

### Submit and Advance Bracket
**Given:** Tournament InProgress, MatchResultRecord with winnerTeamSide (TeamSide: Blue/Red), autoAdvanceBracket=true
**When:** `submit_and_advance_bracket(matchResultId)`
**Then:** Maps winnerTeamSide (Blue→team1Id, Red→team2Id) directly to winnerTeamId — no TournamentEnrolled lookup needed. Sets BracketMatch.winnerTeamId. Auto-advances winner to next match.

### Rollback Bracket Match
**Given:** Tournament InProgress, BracketMatch with winnerTeamId set, no MMR processed
**When:** `rollback_bracket_match(bracketMatchId)`
**Then:** winnerTeamId cleared, winner removed from next match slot, loser removed from losers bracket slot. GroupPhaseRecord reversed. If a CalendarEvent is linked to this bracketMatchId, it and its CalendarEventInvite rows are cascade-deleted.

### Group Phase Scoring
**Given:** GroupOnly or hybrid tournament with group phase, matches in a group complete
**When:** `advance_bracket_match` processes group-phase BracketMatch (bracketSide=Group)
**Then:** GroupPhaseRecord rows updated: Win=2pts, Draw=1pt, Loss=0pts. Tiebreaker order: head-to-head result, then total points, then seeding.

### Hybrid Format Group-to-Elimination Advancement
**Given:** Hybrid format (GroupIntoSingleElim or GroupIntoDoubleElim) tournament, all group matches complete
**When:** Group winners determined by GroupPhaseRecord points + tiebreaker
**Then:** Top N teams from each group (N = tournament.groupAdvanceCount) advance to elimination bracket slots.

### DQ Auto-Advance
**Given:** Tournament InProgress, autoAdvanceBracket=true, team A vs team B in bracket
**When:** `dq_participant(tournamentId, playerA)`
**Then:** Player A's TournamentEnrolled status=Disqualified. Team B auto-advanced to next bracket match. If a CalendarEvent is linked to this bracket match, it and its CalendarEventInvite rows are cascade-deleted.

### Team Elimination on Final Bracket Loss
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

---

*Last updated: 2026-04-09*
*Feature owner: Phase 4*
