# Brackets & Group Phase -- Architecture

Last updated: 2026-04-09

## Overview

The brackets feature manages tournament bracket generation, seeding, and match advancement across four bracket formats: single elimination, double elimination, group phase (round-robin), and hybrid (group into elimination). All participant references use `TournamentTeam.id` -- even solo players get an auto-created team row at registration so bracket code treats all formats uniformly. Bracket adjacency is encoded as explicit FK links (`nextWinnerMatchId`, `nextLoserMatchId`) rather than position arithmetic or JSON blobs.

## Table Relationships

```
Tournament (id: u32 autoInc PK)
  +-- [see tournament/architecture.md for full schema]

  +-- BracketMatch (id: u32 autoInc PK)
  |     tournamentId -> Tournament.id
  |     roundNumber: u32
  |     matchNumber: u32
  |     bracketSide: BracketSide (Winners | Losers | GrandFinals | ThirdPlace | Group)
  |     groupId: u32? (set when bracketSide=Group)
  |     team1Id: u32? -> TournamentTeam.id
  |     team2Id: u32? -> TournamentTeam.id
  |     nextWinnerMatchId: u32? -> BracketMatch.id (self-FK)
  |     nextLoserMatchId: u32? -> BracketMatch.id (self-FK, double elim)
  |     winnerTeamId: u32? -> TournamentTeam.id (set when match resolved)
  |     bestOf: u8 (series length, copied to Lobby.bestOf on lobby creation)
  |     gameMode: GameMode
  |     winnerAdvantage: u8 (game head-start for GrandFinals WB winner)
  |     resultStatus: MatchResultStatus
  |
  +-- GroupPhaseRecord (PK: [tournamentId, groupId, teamId])
        tournamentId -> Tournament.id
        groupId: u32 (group number)
        teamId -> TournamentTeam.id
        wins: u32
        losses: u32
        draws: u32
        points: u32

Lobby (id: u32 autoInc PK)
  +-- bracketMatchId: u32? -> BracketMatch.id  [btree index]
  (relationship: BracketMatch -> Lobby is navigated via Lobby.bracketMatchId index)
```

## Reducer Flows

### generate_bracket(tournamentId)
1. Verify caller has tournament host permissions; tournament must be in Seeding stage
2. Delete existing BracketMatch and GroupPhaseRecord rows (supports regeneration)
3. Read `Tournament.format` and branch to algorithm:
   - `SingleElimination`: fold seeding, create winner slots
   - `DoubleElimination`: winners + losers brackets + GrandFinals match
   - `GroupPhase`: circle-method round-robin + GroupPhaseRecord rows
   - `GroupIntoSingleElim` / `GroupIntoDoubleElim`: group matches + empty elimination bracket
4. **Two-pass FK wiring**: insert all matches with null FKs, build positionKey->insertedId map, then update `nextWinnerMatchId`/`nextLoserMatchId` using the map
5. Auto-advance BYE matches: pre-set `winnerTeamId` and place in next slot

### seed_bracket(tournamentId, mode)
1. Verify caller has tournament host permissions; tournament must be in Seeding stage
2. `mode='mmr'`: sort TournamentTeams by captain's MmrRating for tournament gameMode
3. `mode='random'`: deterministic shuffle via `(tournamentId * 31 + teamId) % 2147483647` (no Math.random -- reducers must be deterministic)
4. Assign `seedNumber` to each TournamentTeam row

### swap_seeds(tournamentId, teamId1, teamId2)
1. Verify caller has tournament host permissions; tournament must be in Seeding stage
2. Swap `seedNumber` between two TournamentTeam rows

### advance_bracket_match(bracketMatchId)
1. Verify tournament is InProgress
2. Read BracketMatch -- reject if `winnerTeamId` not set
3. Place winner in `nextWinnerMatchId` slot (set `team1Id` or `team2Id` on the next match)
4. For double elim: route loser to `nextLoserMatchId` slot
5. For group matches: update `GroupPhaseRecord` via `updateGroupPhaseRecords` (Win=2, Draw=1, Loss=0 points)
6. Set eliminated status: when a team loses their final match (`setEliminatedStatus` on TournamentEnrolled rows)

### submit_and_advance_bracket(matchResultId)
1. Wrapper for tournament matches -- reads MatchResultRecord
2. Map `winnerTeamSide` (Blue/Red TeamSide enum) to `winnerTeamId`:
   - `Blue` -> `bracketMatch.team1Id`
   - `Red` -> `bracketMatch.team2Id`
3. Set `BracketMatch.winnerTeamId`
4. If `Tournament.autoAdvanceBracket=true`: call `advance_bracket_match`

### rollback_bracket_match(bracketMatchId)
1. Verify tournament is InProgress; verify `mmrProcessedAt` not set on MatchResultRecord (blocks post-MMR rollback)
2. Cascade-delete linked CalendarEvent + invites (Phase 8, D-22)
3. Clear `winnerTeamId` on this match
4. Remove winner from `nextWinnerMatchId` slot; remove loser from `nextLoserMatchId` slot

### advance_to_next_game(lobbyId), shelve_series(lobbyId), resume_series(lobbyId)
1. Verify series authority: lobby host, TO, TO assistant, admin/mod, or referee if `refereeControlsShelving=true`
2. Advance/shelve/resume the best-of-N series state on the Lobby

## Phase S8a execution (DECISIONS.md A23, A27, A29–A32, A35)

S8a lays the foundation of the tournament rewrite: a pure shared bracket module and the module helpers every
later tournament reducer calls. **No reducer calls them yet**: the legacy generation and advancement code
(`helpers/bracketGeneration.ts`, `helpers/bracketHelpers.ts`, `reducers/bracketGeneration.ts`,
`reducers/bracketAdvancement.ts`) and the reducer flows above still run until S8c replaces them. No schema change.

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
| `bracketStore.ts` | `insertBracket(ctx, tournament, spec, teamIdsBySeed, actorId): Map<string, number>` | one row per `MatchSpec` (BYE flags from seeds above `teamCount`, `bestOf` = `defaultBestOf`, the GF `grandFinalBestOf`), second pass wires `nextWinnerMatchId` / `nextLoserMatchId` through the positionKey → id map, then `settle` |
| | `insertGroupBracket(ctx, tournament, groups, actorId): Map<string, number>` | `Group` rows from `groupSpec`, `groupId` = group index (0-based), state Ready; writes `TournamentTeam.groupId` |
| | `placeEntrant(ctx, matchId, slot, teamId \| 'BYE', actorId)` | exact slot; same entrant → no-op; another entrant → `SenderError`; Pending → Ready when both slots hold teams |
| | `settle(ctx, tournamentId, actorId)` | until stable: one BYE → `Walkover` (winner = the team, routed; BYE down the loser route), two BYEs → `Void` (BYE down both routes); settled matches untouched |
| | `deleteBracket(ctx, tournamentId, actorId?)` | every match with its `TournamentStandIn` rows and `CalendarEvent` rows (+ invites, `calendarCascade`); clears `TournamentTeam.groupId`, keeps `seedNumber` |
| `bracketResults.ts` | `applyBracketResult(ctx, bracketMatchId, winnerTeamId, decidedBy, games, actorId)` | **the only writer of a result's `BracketMatch.winnerTeamId`** (`settle` stamps structural walkovers): two real teams, winner one of them; Ready → Decided, same winner on a Decided match → no-op, another winner → "roll back first" (A24(3)); sets loser, `decidedBy`, series games; routes winner / loser to their exact slots; no loser route → loser `Active → Eliminated` (A26; never for group matches); then `settle` |
| | `rollbackBracketResult(ctx, bracketMatchId, actorId)` | inverse; refuses when a destination is Decided (also through a walkover chain); removes the entrants downstream (destinations back to Pending, walkovers they settled unwound), clears winner / loser / `decidedBy`, games 0-0, state Ready, loser `Eliminated → Active`; leaves `MatchResultRecord` and lobbies to the reducers |
| | `seriesGames(session): { team1, team2 }` | `gamesWonBlue` / `gamesWonRed` (A35: Blue = team1, Red = team2) |
| `tournamentStandings.ts` | `groupStandings(ctx, tournamentId, groupId): RankedTeam[]`, `qualifiersFor(ctx, tournamentId, groupAdvanceCount): number[]` | rows → `rankGroup` (Decided group matches only; unseeded teams sort last) → `placeQualifiers`; `qualifiersFor` first drops Withdrawn / Disqualified / Eliminated teams (A26: status is the single gate for bracket placement) |
| `tournamentLobbySides.ts` | `allowedSlotsFor(ctx, lobby, userId): LobbySlotTag[]` | A35 / D.8.5: team1 members + its stand-ins for this match → BluePlayer / BlueCoach, team2 → RedPlayer / RedCoach, everyone else (staff included) Spectator; Spectator always; non-tournament lobby → every slot. S8d wires it into `join_lobby` / `set_team_slot` |

Behaviour scenarios are not in [contract.md](contract.md) yet: S8c / S8d rewrite it once the reducers use these helpers.

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

---

*Last updated: 2026-04-09*
*Feature owner: Phase 04 / Phase 10.1*

**Behavior specification** (acceptance scenarios, edge cases, phase history): See [contract.md](contract.md)
