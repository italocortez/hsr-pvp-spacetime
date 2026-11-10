# Brackets & Group Phase -- Architecture

Last updated: 2026-11-07

## Overview

The brackets feature manages tournament bracket generation, seeding, and match advancement across four bracket formats: single elimination, double elimination, group phase (round-robin), and hybrid (group into elimination). All participant references use `TournamentTeam.id` -- even solo players get an auto-created team row at registration so bracket code treats all formats uniformly. Bracket adjacency is encoded as explicit FK links (`nextWinnerMatchId`, `nextLoserMatchId`) rather than position arithmetic or JSON blobs.

## Table Relationships

```
Tournament (id: u32 autoInc PK)
  +-- [see tournament/architecture.md for full schema]
  |     lastSeedChangeAt: Timestamp?   (seed_bracket / set_seed_order / manual groups / a DQ after generation)
  |     bracketGeneratedAt: Timestamp? (generate_bracket; Seeding -> InProgress needs it >= lastSeedChangeAt)

  +-- TournamentTeam (status, seedNumber: u32?, groupId: u32?)   [group membership; standings are computed, A23]

  +-- BracketMatch (id: u32 autoInc PK; public, team ids only)
        tournamentId -> Tournament.id              [btree tournament_id, by_tournament_and_position]
        positionKey: string  ('W-R1-M1', 'L-R2-M1', 'GF', 'TP', 'G0-R1-M1': the engine's address)
        bracketSide: BracketSide (Winners | Losers | GrandFinals | ThirdPlace | Group)
        roundNumber, matchNumber: u32; groupId: u32? (Group rows)
        team1Id / team2Id: u32? -> TournamentTeam.id; team1IsBye / team2IsBye: bool  (default colours team1 = Blue, team2 = Red, A35)
        blueTeamId: u32? (the team playing Blue; unset or stale = default, A70(1); reset on a slot change, A71(3))
        nextWinnerMatchId / nextLoserMatchId: u32? (self-FK) + nextWinnerSlot / nextLoserSlot: u8 (exact slot)
        bestOf, winnerAdvantage: u8 (GF: WB finalist in slot 1, A27); scheduledAt: Timestamp?
        state: Pending | Ready | Decided | Walkover | Void
        winnerTeamId / loserTeamId: u32?; decidedBy: (Played | Concede | Dq | Staff)?; team1Games / team2Games: u8

Lobby (id: u32 autoInc PK)
  +-- bracketMatchId: u32? -> BracketMatch.id  [btree index]
```

## Reducer Flows

See **Phase S8c execution** below for the reducer reference (seeding, generation, group advancement, staff
resolve / rollback, DQ). The legacy flows (`swap_seeds`, `advance_bracket_match`, `submit_and_advance_bracket`,
`advance_group_to_elimination`, the first-empty-slot placement, `GroupPhaseRecord`) were deleted in S8c (A23).

### Lobby series reducers (removed in S8e, A67(1))
The lobby-level series reducers are deleted; the bracket match is the only series (see "Phase S8e execution").

## Phase S8a execution (DECISIONS.md A23, A27, A29–A32, A35)

S8a lays the foundation of the tournament rewrite: a pure shared bracket module and the module helpers every
later tournament reducer calls. **No reducer calls them yet**: the legacy generation and advancement code
(`helpers/bracketGeneration.ts`, `helpers/bracketHelpers.ts`, `reducers/tournament/bracketGeneration.ts`,
`reducers/tournament/bracketAdvancement.ts`) and the reducer flows above still run until S8c replaces them. No schema change.

### Shared module `shared/bracket/` (pure; imported as `@shared/bracket`, barrel `index.ts`)

| File | Exports | Rule |
|---|---|---|
| `engine.ts` | `generateSingleElim`, `generateDoubleElim`, `classifyMatches`, `BracketEngine`, `checkStructure`, `toRowDrafts`, `foldSeeding`, `dropSource`, `nextPowerOf2`, `wbKey` / `lbKey` / `groupKey` / `GF_KEY` / `TP_KEY`; types `BracketSpec`, `MatchSpec`, `SlotSource`, `Route`, `Slot`, `BracketSide` | the review prototype moved unchanged: exact slots, bracket padded to 2^k with BYE seeds, one-BYE match = walkover, two-BYE match = void; single grand final with the WB finalist in slot 1 carrying `winnerAdvantage` (A27); third-place match only in single elimination (A29). Keys: `W-R{r}-M{m}`, `L-R{r}-M{m}`, `GF`, `TP`, `G{g}-R{r}-M{m}` |
| `groups.ts` | `groupCount`, `splitIntoGroups`, `roundRobin`, `groupSpec`, `meetingRound`, `placeQualifiers`; type `GroupMatchSpec` | A32: `groupCount = max(1, floor(teams / groupSize))`, snake seeding, so leftovers spread one per group and sizes differ by at most one; circle-method round robin (odd counts: one team sits out per round); group match numbers count within (group, round) |
| `standings.ts` | `rankGroup`, `compareGroupTeams`, `groupTeamStats`; types `DecidedGroupMatch`, `GroupTeam`, `GroupTeamStats`, `RankedTeam` | A30 order: wins (A31, no draws) → head-to-head only when exactly two teams are tied on wins → game differential over the group's decided matches (stored `team1Games` / `team2Games`) → lower seed number → team id (total order only) |
| `guards.ts` | `isEligibleTeam`, `allowsThirdPlace`, `canOpenRegistration`, `canCloseRegistration`, `canStartInProgress`, `canComplete`; type `GuardResult` | review §5.1 predicates over plain rows; `{ ok: false, reason }` is what the reducer throws |

**Qualifier placement** (`placeQualifiers(rankedGroups, advanceCount)`, review T7): qualifiers enter Winners round 1
only. Seeds go rank by rank (all group winners take seeds 1..G in group order, then all runners-up, …), so a better
rank always gets a better seed. Each later rank is placed in alternating direction (rank 2 last group → first, rank 3
first → last, …), and each team takes the free seed of its rank's block where it meets its own group's
already-placed teams latest in the winners bracket (ties: lowest seed). With two or more groups no round-1
elimination match pairs two teams of one group. The elimination bracket is `generateSingleElim` /
`generateDoubleElim` over that order.

The seat-enforcement core moved to `shared/lobby-rules/allowedSlots.ts` (`allowedSlotsFor`, `autoSeatFor`,
`ALL_SLOTS`, `SeatContext`).

### Module helpers (`spacetimedb/src/helpers/`)

| Helper | Signature | Behaviour |
|---|---|---|
| `bracketStore.ts` | `insertBracket(ctx, tournament, spec, teamIdsBySeed, actorId): Map<string, number>` | one row per `MatchSpec` (BYE flags from seeds above `teamCount`, `bestOf` = `defaultBestOf`, the GF `grandFinalBestOf`), `team1Games = winnerAdvantage` (the A27 head start, A69(1)), second pass wires `nextWinnerMatchId` / `nextLoserMatchId` through the positionKey → id map, then `settle` |
| | `insertGroupBracket(ctx, tournament, groups, actorId): Map<string, number>` | `Group` rows from `groupSpec`, `groupId` = group index (0-based), state Ready; writes `TournamentTeam.groupId` |
| | `placeEntrant(ctx, matchId, slot, teamId \| 'BYE', actorId)` | exact slot; same entrant → no-op; another entrant → `SenderError`; Pending → Ready when both slots hold teams |
| | `settle(ctx, tournamentId, actorId)` | until stable: one BYE → `Walkover` (winner = the team, routed; BYE down the loser route), two BYEs → `Void` (BYE down both routes); settled matches untouched |
| | `deleteBracket(ctx, tournamentId, actorId?)` | every match with its `TournamentStandIn` rows and `CalendarEvent` rows (+ invites, `calendarCascade`); clears `TournamentTeam.groupId`, keeps `seedNumber` |
| `bracketResults.ts` | `applyBracketResult(ctx, bracketMatchId, winnerTeamId, decidedBy, games, actorId)` | **the only writer of a result's `BracketMatch.winnerTeamId`** (`settle` stamps structural walkovers): two real teams, winner one of them; Ready → Decided, same winner on a Decided match → no-op, another winner → "roll back first" (A24(3)); sets loser, `decidedBy`, series games; routes winner / loser to their exact slots; no loser route → loser `Active → Eliminated` (A26; never for group matches); then `settle` |
| | `rollbackBracketResult(ctx, bracketMatchId, actorId)` (**superseded by S8e**: now `rollbackBracketResult(ctx, bracketMatchId, actorId, voidDeciding = true, redecide = true)`; voids the deciding record of a match decided by play, writes the derived tally instead of 0-0, re-decides as Played when the tally decides; see "Phase S8e execution") | inverse; refuses when a destination is Decided (also through a walkover chain); removes the entrants downstream (destinations back to Pending, walkovers they settled unwound), clears winner / loser / `decidedBy`, games 0-0, state Ready, loser `Eliminated → Active`; leaves `MatchResultRecord` and lobbies to the reducers |
| | `seriesGames(session): { team1, team2 }` | `gamesWonBlue` / `gamesWonRed` (A35: Blue = team1, Red = team2). **Deleted in S8e**: replaced by `matchGames(ctx, match)` (A67(4)) |
| `tournamentStandings.ts` | `groupStandings(ctx, tournamentId, groupId): RankedTeam[]`, `qualifiersFor(ctx, tournamentId, groupAdvanceCount): number[]` | rows → `rankGroup` (Decided group matches only; unseeded teams sort last) → `placeQualifiers`; `qualifiersFor` first drops Withdrawn / Disqualified / Eliminated teams (A26: status is the single gate for bracket placement) |
| `tournamentLobbySides.ts` | `allowedSlotsFor(ctx, lobby, userId): LobbySlotTag[]` | A35 / D.8.5: team1 members + its stand-ins for this match → BluePlayer / BlueCoach, team2 → RedPlayer / RedCoach, everyone else (staff included) Spectator; Spectator always; non-tournament lobby → every slot. S8d wires it into `join_lobby` / `set_team_slot`. S8g (A70(1)): the Blue / Red teams come from `matchSides(match)`, not team1 / team2 |

Behaviour scenarios: [contract.md](contract.md), "Phase S8c execution" scenarios.

## Phase S8c execution (DECISIONS.md A23, A24(1)(3), A25, A26, A26a, A29, A30, A32, A36a, A38(1))

The bracket reducers now run on `shared/bracket` and the S8a helpers. Deleted: `swap_seeds`,
`advance_bracket_match`, `submit_and_advance_bracket`, `advance_group_to_elimination`, `admin_set_bracket_winner`,
`helpers/bracketGeneration.ts`, `helpers/bracketHelpers.ts` and the inline advancement of `dq_participant`.

**Single writer, enforced.** `BracketMatch.winnerTeamId` is written only by `bracketResults.applyBracketResult`
(results), `bracketResults.rollbackBracketResult` (clears it) and `bracketStore.settle` (structural BYE walkovers).
Callers of `applyBracketResult`: `resolve_bracket_match` (Staff), `dq_participant` (Dq), `performConcede`
(Concede, A38(1); only while the match is Ready; series score from the session; audit actor `SYSTEM_USER_ID`, A37)
and finalization step 17 (Played / Concede, `SYSTEM_USER_ID`; removed in S8d: see "Phase S8d execution").

### Reducer reference

All rejections are `SenderError`s. Permissions per A25 (`ensureTournamentPermission`).

| Reducer | Permission; stage | Behaviour | Messages |
|---|---|---|---|
| `seed_bracket(tournamentId, mode: 'mmr' \| 'random')` | `bracket`; Seeding | Ready teams only (A26). `mmr`: captain's `MmrRating` for `defaultGameMode` (any season; 0 when none), highest first, ties by team id. `random`: `ctx.random.shuffle` of the Ready teams in id order (C-a7). Writes `seedNumber` 1..n, stamps `lastSeedChangeAt` | "Tournament is not in Seeding." · "Seeding mode must be "mmr" or "random"." · "No Ready teams to seed." |
| `set_seed_order(tournamentId, teamIds: u32[])` | `bracket`; Seeding | `teamIds` = exactly the Ready teams, each once; position i -> seed i + 1; stamps `lastSeedChangeAt`. Replaces `swap_seeds` | "A team appears twice in the seed order." · "The seed order must list every Ready team exactly once." |
| `generate_bracket(tournamentId)` | `bracket`; Seeding | (1) teams still Forming -> Withdrawn, members stay enrolled (A26a); (2) >= 2 Ready teams, every one seeded, seeds unique; format checks (A29 third place, `groupSize` >= 2, `groupAdvanceCount` 1..2, >= 2 qualifiers) and manual groups read; (3) `deleteBracket` (rows, stand-ins, calendar rows, `groupId`; T20); (4) rows per format (below); (5) stamps `bracketGeneratedAt` | "At least 2 Ready teams are needed." · "Seed every Ready team first." · "Seed numbers must be unique." · "A third-place match exists only in single elimination." · "groupSize must be at least 2." · "groupAdvanceCount must be 1 or 2." · "At least 2 teams must qualify from the groups." · manual: "Team "X" has no group." / "… only N groups exist." / "Every group needs at least N teams." / "Group sizes may differ by one team at most." |
| `advance_group_stage(tournamentId)` | `bracket`; InProgress | GroupInto* only; every group match Decided / Walkover / Void; no elimination row yet (checked by `bracketSide`, since `GF` also starts with G); qualifiers = `qualifiersFor` (A30 ranking, Withdrawn / Disqualified / Eliminated dropped, T7 placement); `generateSingleElim(n, { thirdPlace })` / `generateDoubleElim(n, { winnerAdvantage })` + `insertBracket`; grouped teams that did not qualify and are still Active -> Eliminated | "Tournament is not in progress." · "A group-only tournament has no elimination stage." · "This tournament has no group stage." · "Generate the bracket first." · "The elimination bracket already exists." · "N group match(es) are not settled." · "At least 2 teams must qualify." |
| `resolve_bracket_match(bracketMatchId, winnerTeamId, reason)` | `results`; InProgress | match Ready -> calendar event deleted (D-22), `applyBracketResult(…, 'Staff', 0-0)`; Decided with another winner -> `rollbackBracketResult` (refused while anything downstream is Decided) then apply; Decided with the same winner -> no-op. Replaces `admin_set_bracket_winner`; the D.8.3 "force-finalize" tool for a tournament match | "Bracket match not found." · "Tournament is not in progress." · "Reason must be at most 1000 characters." · "<key> is <state>; only a Ready or Decided match can be resolved." · "Team N does not play <key>." · "<key> is decided; roll that back first." |
| `rollback_bracket_match(bracketMatchId, reason)` | `results`; InProgress | match Decided; `rollbackBracketResult` (refused while a downstream match is Decided); deletes the match's calendar event (D-22). The D.8.3 "void" tool for a tournament match | "<key> is <state>; only a decided match can be rolled back." · "<key> is decided; roll that back first." |
| `dq_participant(tournamentId, userId, reason, dqWholeTeam?)` | `participants`; any stage | enrolment -> Disqualified (row kept, A26a(2)); the player (with `dqWholeTeam`: every member, their enrolments Disqualified too) leaves the team, captain transferred (D-21); a team left non-empty gets `refreshTeamStatus` only before generation (Ready -> Forming possible); after generation it keeps its status and plays with stand-ins (A26a(3)); a team left empty -> **Disqualified** (row kept). Seeding after generation: stamps `lastSeedChangeAt` (regenerate). InProgress: every open match of the team is settled (rule below). Live lobby handling unchanged (D-25 / D-26) | "Participant not found in this tournament." · "Participant is already disqualified." · "Cannot disqualify a participant who has already withdrawn." |

`reason` (resolve, rollback, dq) has no column: it is written to the module log (resolve / rollback: trimmed, at
most 1000 characters); the actor lands in the audit columns (`lastModifiedById`). S8d may add an audit table.

**DQ settling rule.** Repeated until the disqualified team holds no open slot: a **Ready** match (opponent known)
-> `applyBracketResult(opponent, 'Dq', 0-0)` (its calendar event deleted, D-22); a **Pending** match (the other slot
still empty) -> the team's slot becomes a BYE (`teamNIsBye = true`), so `settle` turns the match into a Walkover for
the opponent when it arrives (or a Void if a BYE arrives). In double elimination a DQ loss in the winners bracket
routes the team into the losers bracket first, where the same rule applies. Group matches: every open group match
is settled for the opponent (review T12). Limit: once a DQ'd team's slot is a BYE, its feeder match can no longer
be rolled back (the slot no longer holds the team).

### Generation per format

| Format | Rows at generation | Later |
|---|---|---|
| `SingleElimination` | `generateSingleElim(n, { thirdPlace: has3rdPlaceMatch })` over the Ready teams by seed; BYE walkovers settled | — |
| `DoubleElimination` | `generateDoubleElim(n, { winnerAdvantage })`; single grand final, WB finalist in slot 1 (A27) | — |
| `GroupOnly` | `insertGroupBracket(groups)`; groups = manual `groupId`s (A36a; validated: every Ready team grouped, exactly `groupCount(n, groupSize)` groups, each >= `groupSize` unless there is only one group, sizes within one) or `splitIntoGroups(teamIdsBySeed, groupSize)` (A32 snake); within a group, teams by seed | placements from the standings at Completed (S8d) |
| `GroupIntoSingleElim` / `GroupIntoDoubleElim` | the group rows only | `advance_group_stage` creates the elimination rows from the standings (T7) |

## Phase S8d execution (DECISIONS.md A24(1)(3), A35, A38(1), A54; ACCESS-SECURITY-OPS §D.8.3)

**Hand-off.** `helpers/tournament/tournamentResults.ts` `handOffToBracket(ctx, record, 'Played' | 'Concede')` is the one
result path into `applyBracketResult`: winner team = team1 for Blue, team2 for Red (A35); series score from the
session; actor `SYSTEM_USER_ID` (A37); only a Ready match of an InProgress tournament (idempotent and quiet otherwise).
Callers: `performConcede` (Concede, A38(1)), `submitSeriesResult` (Played, a tournament without
`requireResultValidation`), `validate_match_result` (Played). Finalization step 17 is gone. `override_match_result`
uses `rollbackBracketResult` + `applyBracketResult` (Staff) directly. Callers of `applyBracketResult` now:
`handOffToBracket`, `resolve_bracket_match`, `dq_participant`, `override_match_result`.

**Resolve / rollback side effects (`voidMatchLobbies`).** **Superseded by S8e (A67(4)(8)): see "Phase S8e execution" below.**

| Reducer | Records and lobbies of the match |
|---|---|
| `rollback_bracket_match` | every lobby of the match (`Lobby.bracket_match_id`) is voided: its record is marked **Voided** and kept (audit; the finalize job deletes it without effect), the lobby is hard-deleted with every other row of the match (`hardDeleteLobby(…, keepResultRecord = true)`), so a replay lobby can be created (A24(3)) |
| `resolve_bracket_match` | a lobby whose record is **Validated for the resolved winner** stays parked (finalized at Completed); every other lobby of the match (Waiting or playing, a Pending / Submitted / Disputed record, or a Validated record for the other team) is voided as above: staff decided the match |


## Phase S8e execution (DECISIONS.md A67(4)(5)(8), A27, A30, A35)

**The bracket match is the series.** `BracketMatch.bestOf` (A28 chain: `Tournament.defaultBestOf` /
`grandFinalBestOf` → `BracketMatch.bestOf`) caps the games; a lobby hosts one game. `team1Games` / `team2Games` are
the running tally, written only by `helpers/tournament/bracketResults.ts` (`bracketStore.insertBracket` inserts the head start, `team1Games = winnerAdvantage`, `team2Games = 0`, A69(1); `insertGroupBracket` inserts 0 / 0):

| Helper (`bracketResults.ts`) | Does |
|---|---|
| `matchGames(ctx, match): { team1, team2 }` | **derives** the tally (A71(1)): `team1 = match.winnerAdvantage +` the Validated records of the match (`MatchResultRecord.bracket_match_id`) whose `winnerTeamSide` is the colour team1 plays; `team2 =` the Validated records whose `winnerTeamSide` is the colour team2 plays (colour mapping: `helpers/tournament/matchSides.ts`, default team1 = Blue, A35 / A70(1)). The head start is always team1's (slot 1, the WB finalist, A27), whatever the colours. Only `status = Validated` counts (a concede is Validated, A24(1)); Pending, Submitted, Disputed, Rejected, Voided do not. The head start is on the row from generation (A69(1)), so stored = derived from the insert on; no lobby or result record seeds it |
| `recordGameSettled(ctx, record, decidedBy, actorId)` | a game of the match settled. Not Ready → return (a match staff already settled stays as it is). Writes the derived tally; when a side reaches `winsNeededFor(bestOf) = ceil(bestOf / 2)` → `applyBracketResult(ctx, match.id, team, decidedBy, tally, actorId)` (routing, A30, A37 actor); otherwise only the tally changes |
| `rollbackBracketResult(ctx, id, actorId, voidDeciding = true, redecide = true)` | the S8c revert (downstream unplaced, loser un-eliminated, Ready), then: when `voidDeciding` and the match was decided by play (`decidedBy` Played / Concede) the **deciding record** = the latest Validated record of the match by `settledAt` (id only as a tie-break) is marked Voided and its lobby hard-deleted (`keepResultRecord`); a Staff / Dq decision voids no record. The tally is recomputed from the remaining Validated records and written with the Ready state; with `redecide` (rollback_bracket_match only) a side that already has ceil(bestOf / 2) games is decided again as **Played** through `applyBracketResult` (e.g. 2-0 by play, resolved by staff for the other team, then rolled back). `resolve_bracket_match` and `override_match_result` pass `redecide = false` (they decide right after) |

`handOffToBracket(ctx, record, decidedBy)` (`tournamentResults.ts`, signature and callers unchanged: `submitGameResult`,
`validate_match_result`, `performConcede`) keeps its guards (tournament record, Ready match, InProgress tournament, a
winner side mapped to a team) and calls `recordGameSettled(…, SYSTEM_USER_ID)`. `seriesGames` is deleted.

| Reducer | S8e rule |
|---|---|
| `rollback_bracket_match` | `rollbackBracketResult(…, voidDeciding = true)`: the deciding game only is voided; earlier games stay Validated and the tally is recomputed (e.g. 2-1 → 1-1); then `voidMatchLobbies` sweeps any unsettled lobby |
| `resolve_bracket_match` | every Validated game record is kept (their lobbies stay parked for the job); a Decided match is rolled back with `voidDeciding = false`; `voidMatchLobbies` voids only unsettled lobbies; `applyBracketResult(…, 'Staff', matchGames(…))` with the current tally |
| `dq_participant` | a Ready match → `applyBracketResult(opponent, 'Dq', matchGames(…))` (the derived tally, not 0-0); after the force-concede of the team's live lobby, `writeMatchGames` rewrites the tally so the concede's Validated record counts (decidedBy stays Dq) |
| `create_tournament_lobby` | also rejects a Ready match whose derived tally already gives a side ceil(bestOf / 2) games: "This bracket match is decided by its games." (defensive) |
| `override_match_result` | a Decided match is reverted without voiding (`voidDeciding = false, redecide = false`), the record overridden, then `recordGameSettled(…, 'Staff')` re-decides from the new tally; see [../admin/architecture.md](../admin/architecture.md) "Phase S8e execution" |

`voidMatchLobbies(ctx, bracketMatchId, actorId)` (the `keepWinnerTeamId` parameter is gone): voids every lobby of the
match whose record is not Validated (no record, Pending, Submitted, Disputed); settled lobbies stay (A67(8)).
A30 game differential reads the stored tally, head start included.

## Phase S8g execution (DECISIONS.md A70, A71)

**Colours per bracket match.** `BracketMatch.blueTeamId: u32?` names the team that plays Blue in every lobby of the
match (the other plays Red); unset, or a value that is no longer `team1Id` / `team2Id`, falls back to the A35 default
team1 = Blue (the read-side fallback stays as a defence, A71(3)). `insertBracket` and `insertGroupBracket` write
`blueTeamId = undefined`. The head start is not a colour: it stays on team1 (A71(1), A27), and nothing is stored for
"which colour leads" (A71(2); the bracket view derives it from the tally and the mapping). Group matches take the same
column and the same reducer. Group standings (`tournamentStandings.ts`, `shared/bracket/standings.ts`) stay team-based and
read no colour.

| Helper (`helpers/tournament/matchSides.ts`, the one mapping) | Does |
|---|---|
| `sideSlot(match, side): 1 \| 2 \| undefined` | the slot that plays `side` (`blueTeamId === team2Id` → Blue is slot 2; otherwise slot 1); undefined for a non-colour tag |
| `sideTeamId(match, side)` / `matchSides(match)` | the team id playing a colour / both (`{ blueTeamId, redTeamId }`) |
| `teamSideOf(match, teamId)` | the colour a team plays, undefined when it does not play the match |
| `slotChangeReset(match)` | A71(3): the columns written with every slot change: `{ blueTeamId: undefined, team1Games: winnerAdvantage, team2Games: 0 }` |

Readers: `allowedSlotsFor` (feeds the shared core's `team1*` inputs with the Blue team, `team2*` with the Red team;
seat enforcement unchanged), `recordWinnerTeamId` (result credit), `matchGames` (tally), `dq_participant` (the DQ'd
team's losing colour for the force-concede). No other code compares `team1Id` with a colour.

**Tally rule (A71(1)).** `matchGames`: team1 starts at `winnerAdvantage`, team2 at 0, whatever the colours; each
Validated record adds one to the slot that played its `winnerTeamSide`. A colour choice never changes either number.
Decide / rollback / resolve / override are unchanged (they compare the tally by slot).

**A slot change voids the colour choice (A71(3)).** Every write that changes a slot of a match (`placeEntrant` and
`setSlotBye` in `bracketStore.ts`, `unplaceEntrant` in `bracketResults.ts`) spreads `slotChangeReset(row)` into the
same `updateWithAudit`: `blueTeamId` is unset (the choice was made for the old pairing) and the stored tally is set
to the derived one (a match whose slot changes has no counted game: `team1Games = winnerAdvantage`, `team2Games = 0`).
`placeEntrant` also runs right after generation and in `settle`'s BYE routing; the reset is a no-op there.
`bracketStore` imports the helper from `matchSides.ts`, not from `bracketResults.ts`.

| Reducer | Permission | Rule |
|---|---|---|
| `set_match_sides(bracketMatchId, blueTeamId)` (A71(2)) | `bracket` (A25) | checks in order: match exists ("Bracket match not found."); tournament exists; permission ("You are not authorized to set the sides of this match."); tournament not Completed / Cancelled ("Tournament is over."); match Ready ("{positionKey} is {state}; sides are set on a Ready match."); `blueTeamId` ∈ {team1Id, team2Id} ("blueTeamId must be one of the match's two teams."); no `MatchResultRecord` of the match Pending / Submitted / Disputed / Validated ("The sides can no longer be changed: a game of this match has started."; Voided / Rejected do not block); then no `Lobby` of the match ("Close the open lobby of this match before changing its sides."; by then only a Waiting lobby, or one whose records are all Voided / Rejected). Records before lobbies (A70(3), fixed in the A71 pass). Then `blueTeamId` (`updateWithAudit`, the caller's id, A37; skipped when unchanged) and `writeMatchGames`. Any Ready match, group-stage included |

## Phase S10c execution (DECISIONS.md A84)

`unplaceEntrant` (`helpers/tournament/bracketResults.ts`), reached through `rollbackBracketResult` from
`rollback_bracket_match`, `resolve_bracket_match` (a Decided match with another winner) and `override_match_result` (a
Decided match), now refuses when the downstream match has any lobby (`Lobby.bracket_match_id`: Waiting, playing, or
parked in AwaitingResult) or any `MatchResultRecord` (`bracket_match_id`) that is Pending, Submitted, Disputed or
Validated: `'<key> has a lobby or a game result; void or roll that match back first.'` The Decided refusal ("<key> is
decided; roll that back first.") comes first and is unchanged. Nothing is voided automatically; the transaction rolls
back whole. Staff clear the downstream match with existing reducers, so the refusal is never a dead end:

- a Waiting lobby: `close_lobby` (host, Moderator, Admin; Waiting only);
- a lobby with a Submitted / Disputed / Validated record: `override_match_result(…, 'Rejected', …)` (`results`; the lobby
  is voided, the record kept as Rejected, which does not block);
- a lobby still drafting or scoring (Pending record): `resolve_bracket_match` on the downstream match (its
  `voidMatchLobbies` voids the unsettled lobby), then `rollback_bracket_match` on it (a Staff decision voids nothing and
  returns it to Ready);
- a downstream match that is itself Decided: `rollback_bracket_match` first, as before.

`close_lobby` needs the host, a Moderator or an Admin, so tournament staff holding only the `results` permission clear a
downstream match with resolve-then-rollback (third path), which also clears a Waiting lobby (`voidMatchLobbies` voids
every lobby without a Validated record) and deletes that match's calendar event (not restored by the rollback).

## Phase History

| Decision | Source | Date |
|----------|--------|------|
| BracketSide enum (5 variants: Winners, Losers, GrandFinals, ThirdPlace, Group) replaces isLosersBracket bool | Phase 04 CONTEXT.md | 2026-02-20 |
| Explicit FK links (nextWinnerMatchId, nextLoserMatchId) -- no JSON blob storage | Phase 04 CONTEXT.md | 2026-02-20 |
| seedNumber moved from TournamentParticipant to TournamentTeam -- seeding is team-level | Phase 04 execution | 2026-02-20 |
| Solo tournaments auto-create TournamentTeam on register_for_tournament | Phase 04 execution | 2026-02-20 |
| Deterministic seeding hash for random mode -- no Math.random() in reducers | Phase 04 execution | 2026-02-20 |
| Two-pass FK wiring for self-referential BracketMatch FKs | Phase 04 execution | 2026-02-20 |
| GroupPhaseRecord teamId renamed from participantUserId (Phase 4) to participantTeamId (Phase 04.1) to teamId (Phase 10.1) | Phase 10.1 execution | 2026-03-25 |
| TournamentParticipant split into TournamentEnrolled (enrollment) + TournamentTeamMember (team membership) | Phase 10.1 execution | 2026-03-25 |
| winnerTeamSide (TeamSide enum Blue/Red) replaces winnerUserId on MatchResultRecord | Phase 10.1 execution | 2026-03-25 |
| BracketMatch.lobbyId removed; relationship inverted -- Lobby.bracketMatchId with btree index | Phase 10.1 execution | 2026-03-25 |
| MatchResultRecord.tournamentId removed -- derived from bracketMatch.tournamentId via bracketMatchId FK | Phase 10.1 execution | 2026-03-25 |
| rollback_bracket_match cascades to CalendarEvent (D-22) | Phase 08 execution | 2026-03-28 |
| submit_and_advance_bracket re-reads bracketMatch after update for fresh state in auto-advance logic | Phase 04 execution | 2026-02-20 |
| dq_participant auto-advance is inline code, not a reducer call -- keeps it atomic | Phase 04 execution | 2026-02-20 |
| Normalized to standard template | Phase 13 normalization | 2026-04-09 |
| Shared pure `shared/bracket/` + `bracketStore` / `bracketResults` / `tournamentStandings` / `tournamentLobbySides` helpers, not wired yet (A23, A27, A29–A32, A35) | Phase S8a execution | 2026-11-07 |
| Bracket reducers rebuilt on the shared engine: `seed_bracket` (ctx.random), `set_seed_order`, `generate_bracket` (A26a Withdraw, manual / auto groups, `bracketGeneratedAt`), `advance_group_stage`, `resolve_bracket_match`, `rollback_bracket_match`, `dq_participant` through `applyBracketResult`; legacy generation / advancement and `admin_set_bracket_winner` deleted; single writer enforced (A23, A24, A25, A26a, A29, A30, A32, A36a, A38(1)) | Phase S8c execution | 2026-11-07 |
| Result hand-off `handOffToBracket` (validation, concede; finalization step 17 removed); rollback voids the match's lobbies (record Voided and kept, lobby hard-deleted); resolve keeps a parked record that agrees with the staff winner and voids the rest (A24(1)(3), A38(1), D.8.3) | Phase S8d execution | 2026-11-07 |
| The bracket match is the series: derived tally (`matchGames`: head start + Validated records), `recordGameSettled` decides at ceil(bestOf / 2), rollback voids the deciding record only, resolve keeps every Validated game, DQ applies the tally; `seriesGames` deleted (A67(4)(8)) | Phase S8e execution | 2026-11-08 |
| `blueTeamId` on `BracketMatch`, `helpers/tournament/matchSides.ts` as the one colour mapping, result credit by colour, `set_match_sides` (group matches included) | Phase S8g execution (DECISIONS.md A70) | 2026-11-08 |
| Head start on team1 whatever the colours, `headStartSide` removed, `set_match_sides(bracketMatchId, blueTeamId)`, records checked before lobbies, `slotChangeReset` on every slot change | Phase S8g execution (DECISIONS.md A71) | 2026-11-08 |
| `unplaceEntrant` also refuses a downstream match with a lobby or a Pending / Submitted / Disputed / Validated record | Phase S10c execution (DECISIONS.md A84) | 2026-11-09 |

---

*Last updated: 2026-11-08*
*Feature owner: Phase 04 / Phase 10.1*

**Behavior specification** (acceptance scenarios, edge cases, phase history): See [contract.md](contract.md)
