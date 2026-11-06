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

---

*Last updated: 2026-04-09*
*Feature owner: Phase 04 / Phase 10.1*

**Behavior specification** (acceptance scenarios, edge cases, phase history): See [contract.md](contract.md)
