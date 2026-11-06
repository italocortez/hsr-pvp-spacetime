# Match Results -- Architecture

Last updated: 2026-04-12

## Overview

Match results track the outcome of each lobby game, from submission through dispute resolution to finalization. A `MatchResultRecord` is created when a referee or moderator calls `submit_match_result`. Participants confirm scores per-team before submission. Disputes are allowed once per match; admins resolve them via `override_match_result`. Finalization (`run_finalization`) runs an 19-step pipeline: it processes ELO/MMR, updates player stats, awards achievements, and closes the lobby. Tournament matches also advance the bracket. Concede flows (`concede_match`, `request_concede`, `accept_concede`) let teams forfeit at any draft or game stage. Admin tools (`admin_void_match`, `admin_force_finalize`, `admin_set_bracket_winner`) handle edge cases. All finalization state writes are idempotent via `mmrProcessedAt` and `mmrSeason` guards.

## Table Relationships

```
MatchResultRecord (id: u32 autoInc PK)  [public: true]
  +-- lobbyId -> Lobby.id  [btree: lobby_id]
  +-- bracketMatchId: u32? -> BracketMatch.id  [btree: bracket_match_id]
  +-- tournamentId: u32? -> Tournament.id  [btree: tournament_id]
  +-- status: MatchResultStatus (Pending | Submitted | Disputed | Validated | Rejected | Void)
  +-- gameMode: GameMode
  +-- draftMode: DraftMode
  +-- teamSize: u8
  +-- blueTeamId: u32? -> TournamentTeam.id
  +-- redTeamId: u32? -> TournamentTeam.id
  +-- winnerTeamSide: TeamSide? (Blue | Red | Draw)
  +-- winnerTeamId: u32? -> TournamentTeam.id
  +-- blueScore: u8
  +-- redScore: u8
  +-- blueConfirmedAt: Timestamp?
  +-- redConfirmedAt: Timestamp?
  +-- disputedAt: Timestamp?
  +-- disputedByUserId: u32?
  +-- resolvedAt: Timestamp?
  +-- resolvedByUserId: u32?
  +-- mmrProcessedAt: Timestamp? (idempotency guard)
  +-- mmrSeason: u32? (season at finalization time)
  +-- isConcedeResult: bool
  +-- audit columns

  +-- MatchResultParticipant (PK: [matchResultId, userId])  [public: true]
  |     matchResultId -> MatchResultRecord.id  [btree: match_result_id]
  |     userId -> User.id  [btree: user_id]
  |     teamSide: TeamSide (Blue | Red | Spectator)
  |     charactersPicked: string[] (character names)
  |     lightconesPicked: string[] (lightcone names per character slot)
  |     finalTeamScore: u8
  |     isWinner: bool
  |     accountRatingSnapshot (f64, default 0)  // Phase 12.3: frozen HsrAccount.accountRating input for ELO modifier
  |     audit columns
  |
  +-- MatchResultGame (id: u32 autoInc PK)  [public: true]
        matchResultId -> MatchResultRecord.id  [btree: match_result_id]
        gameNumber: u8
        winnerTeamSide: TeamSide
        blueScore: u8
        redScore: u8
        audit columns
```

## Reducer Flows

### confirm_match_scores(lobbyId, teamScoreBlue, teamScoreRed)
1. `getAuthenticatedUser(ctx)` -- find caller's `LobbyMember`
2. Lobby must be in Scoring stage; caller must be on Blue or Red team (not Spectator)
3. Find `MatchResultRecord` via `lobby_id` index with `status=Pending`
4. Validate scores are within range for bestOf series
5. Set `blueConfirmedAt` or `redConfirmedAt` depending on caller's team side (delete+insert update)

### submit_match_result(lobbyId, winnerTeamSideTag, gameResultsJson?)
1. `getAuthenticatedUser(ctx)` -- caller must be referee OR Moderator+
2. Find Lobby in Scoring stage; find `MatchResultRecord` with `status=Pending`
3. Verify both teams have confirmed (`blueConfirmedAt` and `redConfirmedAt` both set); or caller is Mod+ (can override confirmation)
4. Parse `winnerTeamSideTag` ('Blue' | 'Red' | '' for draw)
5. Parse optional `gameResultsJson` array into `MatchResultGame` rows
6. Update `MatchResultRecord`: `status=Submitted`, `winnerTeamSide`, `blueScore`, `redScore`
7. If tournament-linked and `autoAdvanceBracket=true`: call `submit_and_advance_bracket`

### dispute_match_result(matchResultId)
1. `getAuthenticatedUser(ctx)` -- caller must be in `MatchResultParticipant` for this match
2. `MatchResultRecord.status` must be `Submitted` (not already disputed or resolved)
3. Only one dispute per match: reject if `disputedAt` already set
4. Update `MatchResultRecord`: `status=Disputed`, `disputedAt=ctx.timestamp`, `disputedByUserId`

### override_match_result(matchResultId, newStatusTag, winnerTeamSideTag?)
1. `ensureAdmin(ctx)` OR `isRoleAtLeast(caller.role, 'Moderator')`; also tournament access check for tournament matches
2. Find `MatchResultRecord` -- reject if status is `Void` or already `Validated`
3. Validate `newStatusTag` (Validated | Rejected | Disputed | Submitted)
4. If setting to `Validated`: set `winnerTeamSide` from `winnerTeamSideTag`; compute `winnerTeamId`
5. Update record fields; set `resolvedAt`, `resolvedByUserId`
6. If `newStatusTag=Validated`: trigger `run_finalization`

### concede_match(lobbyId)
1. `getAuthenticatedUser(ctx)` -- caller must be active lobby member
2. Lobby must be in Drafting, Equipping, or Scoring stage
3. Caller's team side becomes the losing side; opponent team wins
4. Insert `MatchResultRecord` with `isConcedeResult=true`, `status=Submitted`, winner set to opponent
5. Advance lobby to AwaitingResult; trigger `run_finalization`

### request_concede(lobbyId) / accept_concede(lobbyId)
1. `request_concede`: caller must be team captain or host; sets `concedeRequestedByTeam` flag on Lobby
2. `accept_concede`: other team captain or host accepts; calls concede flow (both teams consent)
3. Used for mutual concede scenarios; `concede_match` is unilateral (referee/TO triggered)

### run_finalization(ctx, matchResultRecord) -- internal helper
Called after result validation. 19-step pipeline (steps run in order, guarded by `mmrProcessedAt`):

1. Mark `mmrProcessedAt = ctx.timestamp`, `mmrSeason = currentSeasonId` (idempotency stamp)
2. Load all `MatchResultParticipant` rows
3. Compute per-team outcome (Win/Loss/Draw) from `winnerTeamSide`
4. Update ELO/MMR: call `updateEloForMatch(ctx, participants, outcome, gameMode, seasonId)`
5. Update `MmrHistory` rows for each participant
6. Update `PlayerStat` rows (wins/losses/draws/games counters)
7. Update `PlayerCharacterStat` rows (per-character usage and win counts)
8. Update `GlobalCharacterStat` rows (global usage aggregate)
9. Update `GroupPhaseRecord` if tournament group-stage match
10. Set winner/loser flags on `MatchResultParticipant` rows (`isWinner`)
11. Update `TournamentEnrolled.participantStatus` (Eliminated if final bracket loss)
12. Update `Leaderboard` entry for each participant
13. Award achievements: call `runAchievementChecks(ctx, userIds, matchData)`
14. If tournament: call `advance_bracket_match` (or leave for manual advance if `autoAdvanceBracket=false`)
15. Close the Lobby: advance stage to Closed; cascade-delete chat messages; delete LobbyGcJob
16. Create `MatchSessionHistory` snapshot from `MatchSession`
17. Create `MatchSessionStepHistory` rows from `MatchSessionStep` rows
18. Create `MatchParticipantHistory` snapshot
19. Hard-delete ephemeral match session rows (`MatchSession`, `MatchSessionStep`)

### admin_void_match(matchResultId, reason)
1. `ensureAdmin(ctx)` OR TO/Mod+ with tournament access
2. Find `MatchResultRecord` -- reject if already `Void`
3. Set `status=Void`; cancel any pending bracket advancement
4. Does NOT delete the record or trigger MMR adjustments

### admin_force_finalize(lobbyId)
1. `ensureAdmin(ctx)` -- Admin only
2. Find Lobby -- find associated `MatchResultRecord`
3. Force `status=Validated` with admin-specified winner; trigger `run_finalization`

### admin_set_bracket_winner(bracketMatchId, winnerTeamSideTag)
1. TO/Mod/Admin access required
2. Find `BracketMatch` -- set `winnerTeamId` directly (bypasses match result flow)
3. Optionally: call `advance_bracket_match` if autoAdvance is set

### Phase 12.3: MMR accountRatingSnapshot lifecycle

The account-rating input to `processMatchMmr` is frozen at match-record time on a
`MatchResultParticipant.accountRatingSnapshot: f64` column (Phase 12.3 D-F-01).
This eliminates three race vectors documented in Phase 12.3 CONTEXT.md D-E-01:

1. `set_active_hsr_account` called post-capture
2. `batch_upsert_characters` / `batch_remove_characters` called post-capture
3. `process_tournament_mmr` re-reading `isActive` at tournament-end (potentially hours later)

**Capture point** (D-A-01): `start_draft` at `draftClassic.ts` computes
`max(HsrAccount.accountRating)` across all `LobbyMemberAccount` rows for
`(lobbyId, userId)` at the moment the lobby transitions `Waiting -> Drafting`
and writes the value in the same MRP insert loop. For casual matches with zero
LMA rows the snapshot defaults to 0 (matches the pre-phase `?? 0` fallback).

**Monotonic update** (D-B-03): `select_match_account` extends the snapshot upward
between games in a best-of-N series via a post-insert hook:
`accountRatingSnapshot = max(existing, newAccount.accountRating)`. `deselect_match_account`
does NOT run the hook (removing from selection can never lower the max). The hook
short-circuits when no `MatchResultRecord` exists (Waiting stage) or when the caller
has no MRP row (stand-ins joining after `start_draft`).

**Read-site** (D-readpath-01): `processMatchMmr` at `finalizationHelpers.ts` reads
`participant.accountRatingSnapshot` directly. Both the standalone-ranked path
(`runFinalization` step 11) and the tournament-batch path (`process_tournament_mmr`)
call the same helper, so the read-path swap is path-independent by construction.

**Tournament ordering guard** (D-H-01): `finalize_match_result` rejects
tournament-controlled matches while the parent tournament is not `Completed` or
`Cancelled`. Unconditional (`countTowardsMmr` is not consulted) because the guard
protects both MMR batch processing AND bracket rollback capability. Cross-reference:
see `docs/tournament/architecture.md`.

**Public subscription impact** (C7): `MatchResultParticipant` is `public: true`,
so `accountRatingSnapshot` ships to subscribed clients. One f64 per player per
live match; bounded by match count × team size. Acceptable within the energy budget.

## Phase History

| Decision | Source | Date |
|----------|--------|------|
| MatchResultRecord.status lifecycle: Pending -> Submitted -> (Disputed) -> Validated / Rejected / Void | Phase 06 CONTEXT.md | 2026-02-28 |
| Two-team confirmation before submission -- blueConfirmedAt / redConfirmedAt | Phase 06 CONTEXT.md | 2026-02-28 |
| One dispute per match (disputedAt guard) | Phase 06 CONTEXT.md | 2026-02-28 |
| winnerTeamSide (TeamSide enum Blue/Red) replaces winnerUserId (Phase 10.1) | Phase 10.1 execution | 2026-03-25 |
| isConcedeResult flag differentiates concede finalization path | Phase 06 execution | 2026-02-28 |
| mmrProcessedAt idempotency guard prevents double finalization | Phase 06 execution | 2026-02-28 |
| run_finalization 19-step pipeline: ELO, stats, achievements, bracket, lobby close, history snapshot | Phase 06 execution | 2026-02-28 |
| MatchResultGame rows for per-game scores in best-of series | Phase 07 execution | 2026-03-07 |
| admin_void_match: marks void, does not delete or trigger MMR | Phase 06 execution | 2026-02-28 |
| rollback_bracket_match blocked if mmrProcessedAt is set -- post-MMR rollback not allowed | Phase 04 execution | 2026-02-20 |
| MatchResultRecord.tournamentId removed -- derived from bracketMatch.tournamentId (Phase 10.1) | Phase 10.1 execution | 2026-03-25 |
| Normalized to standard template | Phase 13 normalization | 2026-04-09 |
| Phase 12.3 | Freeze account-rating input to ELO via MRP.accountRatingSnapshot, monotonic-upward hook in select_match_account, read-path swap in processMatchMmr, finalize_match_result tournament-ordering guard, timer_expiry_classic auto-pick LMA migration |

---

*Last updated: 2026-04-12*
*Feature owner: Phase 06 / Phase 07 / Phase 10.1 / Phase 12.3*

**Behavior specification** (acceptance scenarios, edge cases, phase history): See [contract.md](contract.md)
