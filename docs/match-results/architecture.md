# Match Results -- Architecture

Last updated: 2026-04-12

## Overview

Match results track the outcome of each lobby game, from submission through dispute resolution to finalization. A `MatchResultRecord` is created when a referee or moderator calls `submit_match_result`. Participants confirm scores per-team before submission. Disputes are allowed once per match; admins resolve them via `override_match_result`. Finalization (`run_finalization`) runs an 19-step pipeline: it processes ELO/MMR, updates player stats, awards achievements, and closes the lobby. Tournament matches also advance the bracket. Concede flows (`concede_match`, `request_concede`, `accept_concede`) let teams forfeit at any draft or game stage. Admin tools (`admin_void_match`, `admin_force_finalize`) handle edge cases; tournament bracket corrections go through `resolve_bracket_match` / `rollback_bracket_match` (Phase S8c execution). All finalization state writes are idempotent via `mmrProcessedAt` and `mmrSeason` guards.

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
7. If tournament-linked: the bracket advances through `applyBracketResult` (Phase S8c execution; the legacy wrapper reducer was deleted)

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
14. If tournament: `applyBracketResult` (decidedBy Played / Concede, idempotent; Phase S8c execution, S8d replaces this step with the A24 hand-off)
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
> **Superseded (Phase S8c execution):** removed (A23); staff use `resolve_bracket_match` / `rollback_bracket_match` (`results`), see docs/brackets/architecture.md "Phase S8c execution".

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

## Scoring (S7)

Phase S7 execution (A21, A31, A39, A55, A56; backlog #11). Behavior and authority rules: [contract.md](contract.md) "Server-Computed Scoring". The diagram and the `submit_match_result` / `confirm_match_scores` flows above predate S3/S7 and are kept for history; this section is current for scoring.

### Shared module `shared/scoring/` (barrel `index.ts`; the module, `scoringHelpers.ts` included, imports it as `@shared/scoring`)

| Export | Does |
|---|---|
| `toHundredths` / `fromHundredths` / `mulHundredths` | f32 boundary ↔ integer hundredths; hundredths × hundredths / 100 truncated toward zero (BigInt) |
| `unitOf`, `lowerWins`, `advantageToDelta` | cycles (MoC, AA; lower wins) vs points (AS; higher wins); an advantage lowers cycles / raises points |
| `groupCount`, `charactersPerTeam`, `lineupError` | Halves 2×4 = 8, Thirds 3×4 = 12; lineup validation |
| `canonicalPair`, `synergySurcharge` | unordered pairs; every pair inside one group adds its `costModifier` once |
| `rosterCost` | Σ character costs + Σ light-cone costs + surcharge |
| `thresholdAdvantage`, `applyHandicaps` | roster diff to the cheaper team, threshold (exactly at = neutral, 0 = off), deaths |
| `sumGroupResults`, `applyModifiers`, `decideWinner`, `scoreGame` | the chain: groups → modifiers → handicaps → tie-break levels 0–4 |

### Tables (all private; columns from S3 unless marked)

| Table | Key / indexes | Written by | Deleted by |
|---|---|---|---|
| `MatchResultGroupScore` (`matchResultId`, `teamSide`, `groupIndex`, `value` u32 hundredths; S8e: no `gameNumber`) | `id` PK; `by_result` (matchResultId) (S8e, A67(3)) | `record_group_scores` (upsert per group index) | `runFinalization`, `hardDeleteLobby` (`deleteScoringRows`) |
| `MatchResultAdjustment` (`value` i32 hundredths, `reason?`, `setById`; S8e: no `gameNumber`) | `id` PK; `by_result` (S8e) | `set_score_adjustment` | same |
| `MatchResultGame` (S8e: one row per record, no `gameNumber`) | decorative PK (matchResultId); `match_result_id` (S8e: `by_result_and_game` removed) | `record_group_scores` creates; `recomputeGame` stores raw totals (`team*CyclesUsed` for cycle modes / `team*Score` for points, hundredths, A56(2)), `team*AdjustedResult`, `tieBreakLevel`, `winnerTeamSide` (Spectator = undecided or level-4 tie until an override) | as before |
| `MatchResultRecord.winnerOverride / winnerOverrideById / winnerOverrideReason` | — | `submit_match_result` | with the record |
| `MatchSessionHistory.handicapApplied` (i32 hundredths) | — | `runFinalization`: Σ over games of (Blue's net handicap advantage − Red's); positive favours Blue; modifiers excluded | — |
| `MatchSessionHistory.winnerOverride` (TeamSide?), `winnerOverrideById` (u32?), `winnerOverrideReason` (string?) — new columns, Phase S7 execution (A21 "kept for audit and replay", A39) | — | `runFinalization` copies them from the record, so a casual override survives the record's deletion | — |
| **`MatchLineupHistory`** (new, A56(1)): `id` PK autoInc, `matchHistoryId`, `teamSide` (S8e: `gameNumber` removed), `groups`, `synergySurcharge`, `rosterCost`, audit | `by_match_history` | `runFinalization` step 9b, one row per live `MatchLineup` | `server_nuke_test_data` only |

Index note: the (id, gameNumber) indexes are scanned per full key over `lobbyGameNumbers` (1..max(bestOf, current game, highest game row)). A bare-scalar prefix scan is rejected and a prefix + `Range` scan returns nothing in the 2.14.1 in-memory test datastore. **S8e (A67(3)):** the indexes are single-column (`by_result`, `by_lobby`, `match_result_id`) and `lobbyGameNumbers` is deleted.

### Reducers

| Reducer | Arguments | Notes |
|---|---|---|
| `record_group_scores` | `lobbyId: u32, teamSide: TeamSide, values: u32[] (hundredths, one per group), deaths: u8, screenshotUrl?: string` (S8e: `gameNumber` removed) | captain of that side or any referee; Pending record; `ensureNotConceded`; the current game, or an earlier closed game for an Admin (`ensureEditableGame`, A65(4)); resets both confirmations; recomputes the game; each value ≤ 100,000,000 hundredths |
| `set_score_adjustment` | `lobbyId: u32, teamSide: TeamSide, value: i32, reason?: string, adjustmentId?: u32` (S8e: `gameNumber` removed) | a lobby referee, Moderator+, or in a tournament lobby the organizer or an assistant with `canResolveResults` (the A39 staff set); no id → insert (0 rejected); id + value ≠ 0 → replace value / team / reason; id + 0 → delete; reason trimmed, ≤ 1000 chars; |value| ≤ 100,000,000 hundredths |
| `confirm_match_scores` | `matchResultId: u32` | unchanged |
| `submit_match_result` | `matchResultId: u32, winnerOverride?: TeamSide, winnerOverrideReason?: string` | recomputes the current game; every game needs complete scores; override only on a level-4 tie (A39 routing in the contract); series winner = game wins + A27 head start |
| `advance_stage` (Scoring) | unchanged | recomputes the current game before counting game winners |
| `equip_lightcone` | unchanged signature | refreshes the side's `MatchLineup.rosterCost` / `synergySurcharge` (confirmation kept); Auction: rejects when the light cone plus a confirmed lineup's surcharge exceeds the LC budget (review fix, Phase S7 execution) (superseded, Phase S7b execution: see "Game package: confirmation, close, automatic submission (S7b)" below and docs/match-session/architecture.md "Phase S7b execution") _Superseded in Phase S10b execution (DECISIONS.md A78)._ |
| `override_match_result` / `admin_force_finalize` | unchanged signatures | A31: no winner-less Validated result; `runFinalization` throws on a record without a winner |

## Game package: confirmation, close, automatic submission (S7b)

Phase S7b execution (DECISIONS.md A60). Behavior: [contract.md](contract.md) "Game Confirmation, Close and Series Submission". Edit reducers (`equip_lightcone`, `arrange_lineup`, `set_eidolon`): `docs/match-session/architecture.md` "Phase S7b execution". This section supersedes the `confirm_match_scores` / `submit_match_result` rows of "Scoring (S7)" and the `advance_stage` (Scoring) row.

Phase S7b follow-up (DECISIONS.md A63, amends A60(3)): `confirm_game` only sets the captain's ready flag and never closes a game; `close_game` is the explicit submit (either captain once both flags are set, or the staff set at any time). The full-control spectator referee shortcut is gone; the referee closes with `close_game`.

**Removed:** `confirm_match_scores`, `submit_match_result` (the reducer; its body is the helper `submitSeriesResult`), `MatchResultRecord.blueConfirmed` / `redConfirmed`, the `winnerOverride*` reducer arguments, the S7 Disputed route for a seated referee's tie override.

**Columns:** `MatchResultGame` gains `blueConfirmed: bool`, `redConfirmed: bool`, `closedAt: timestamp?` (closed ⇔ set), `closedById: u32?`; `ensureGame` initialises them (false / undefined). `MatchResultRecord.winnerOverride / winnerOverrideById / winnerOverrideReason` are now written by `closeGame` (the latest staff override; `runFinalization` copies them to `MatchSessionHistory`).

**Helpers** (`helpers/results/scoringHelpers.ts` unless stated):

| Helper | Does |
|---|---|
| `findEditableResult(ctx, lobbyId, user)` (S8e fix pass 2, A69(2): was `allowSubmitted`) | `ensureEditableRecord(findLobbyResult(…), user)`: the Pending record, or for an Admin caller a Submitted one; otherwise `'No pending match result for this lobby.'` (no record), `'This game is closed.'` (Submitted record, caller not an Admin), `'This game can no longer be edited here; corrections go through override_match_result.'` (Validated, Finalized, Disputed, Rejected, Voided: everyone, Admins included) |
| `ensureOpenGame(ctx, lobby, record, user)` (S8e: no `gameNumber`; A69(3): runs after the record lookup, its status throws are gone) | `'open'` (no game row, or `closedAt` unset) / `'admin'` (closed game, role Admin exactly) / throws `'This game is closed.'` (anyone else on a closed game, Moderators included; defensive) |
| `ensureResultAuthority(ctx, lobby, user, message)` | the A39 staff set: lobby referee, Moderator+, tournament organizer, assistant with `canResolveResults`; returns `{ member, isReferee, isStaff }` (shared by `set_score_adjustment` and `close_game`); the non-throwing `resultAuthority(ctx, lobby, user)` is the same lookup (`close_game` also admits captains, A63) |
| `resetConfirmations(ctx, game, actorId)` | clears both flags on the game row (`replaceGame`), no-op when both are false |
| `ensureAuctionSurchargeFits(ctx, lobby, session, gameNumber, side)` | Auction gate (A60(4)): `MatchLineup.synergySurcharge` ≤ `toHundredths(charBudget + lcBudget)` |
| `seriesTally(ctx, record, lobby, seriesBestOf)` | wins over **closed** games + the A27 head start; `decided` = a side reached `ceil(seriesBestOf / 2)` |
| `closeGame(...)` (`helpers/results/gameClose.ts`) | sets `closedAt`, `closedById`, both flags; applies a staff override (winner = override, `tieBreakLevel` stays 4, record `winnerOverride*`); writes `MatchSession.gamesWonBlue/Red`; logs one `ConfirmGame` step (`closed: true`); decided → `submitSeriesResult`, else lobby → BetweenGames + `Game N complete (b-r). Stage: BetweenGames`; rejects a level-4 tie without an override |
| `submitSeriesResult(ctx, record, lobby, actorId)` (`helpers/results/gameClose.ts`) | every game closed with a result (defensive); winner from the tally (a level series is rejected); Casual → Validated + `runFinalization` inline (D-04 / D-37), otherwise Submitted; `winnerTeamSide`, `matchEndReason = Completed`, `refereeUserId` = the closer; lobby → AwaitingResult + `Series complete (b-r). Stage: AwaitingResult` (Bo1: `Match complete. Stage: AwaitingResult`) |
| `recomputeSeriesAfterAdminEdit(ctx, lobby, record, actorId)` (`helpers/results/gameClose.ts`) | recompute the edited (current) game; a level-4 tie rejects the edit (`'The edit would leave the game tied; add an adjustment that decides it.'`) unless the game was already a tie closed with an override, whose winner is kept; rewrite the tally; Submitted: an undecided series rejects (`'The edit would undo the series result; void or force-finalize the match instead.'`), a changed winner updates `MatchResultRecord.winnerTeamSide`; Pending whose series becomes decided → `submitSeriesResult`; when the edit resolves a tie this game had closed with a staff override, `MatchResultRecord.winnerOverride*` is cleared so finalization does not copy a stale override (review fix) |

`helpers/results/gameClose.ts` is separate from `scoringHelpers.ts` because it calls `runFinalization`, and `finalizationHelpers.ts` already imports `scoringHelpers.ts` (a back-import closes a cycle the bundler warns about).

**Reducers** (`reducers/results/matchResultSubmission.ts`, `reducers/results/scoreEntry.ts`):

| Reducer | Arguments | Notes |
|---|---|---|
| `confirm_game` | `lobbyId: u32, teamSide: TeamSide` | A63 (amends A60(3)): the captain's ready flag only, never a close. Equipping or Scoring; `ensureMatchAlive`; Pending record; game open; caller = the captain of `teamSide` (live `LobbyMember.isCaptain`, player seat; a referee who is that captain confirms as the captain), anyone else `'Only the team captain can confirm the game.'`, a captain naming the other side `` `Only the team captain can confirm the ${side} side of the game.` ``; the side's lineup; both sides' scores complete (the game is recomputed); Auction gate for the side. A side cannot confirm twice. Sets the flag, logs `ConfirmGame { confirmedSide: side, closed: false }`, bumps `lastActivityAt`. The full-control spectator referee shortcut is removed (A63(4)); `MatchResultRecord.refereeFullControl` is no longer read |
| `close_game` | `lobbyId: u32, winnerOverride?: TeamSide, winnerOverrideReason?: string` | A63(2): the submit of a game. Authority: the A60(4) staff set at any time (`resultAuthority`: lobby referee seated or spectator, Moderator+, organizer, assistant with `canResolveResults`), or, once `blueConfirmed && redConfirmed`, the captain of either team (player seat). A captain before both flags: `'Both captains must confirm the game before it can be submitted.'`; anyone else: `'Only a captain (once both sides confirmed), a referee, a Moderator or, in a tournament lobby, the organizer or a results assistant can close a game.'`. Equipping or Scoring; `ensureMatchAlive`; Pending record; game open; both lineups; scores complete; Auction gate for both. `winnerOverride` from the staff set only (a captain: `'Only staff may decide a tie.'`), only on a level-4 tie (`'A winner override is only accepted on an unresolved tie.'`), required on one; reason trimmed ≤ 1000. A39: in a tournament lobby a seated referee (player or coach slot) who is not staff cannot override (`'A referee seated on a team cannot decide a tie in a tournament lobby; staff must close this game.'`); casual: accepted and audited. Step `closed: true`; `actorSlot` = `confirmedSide` = the closer's team side for a captain or a seated referee, `Spectator` otherwise (A63(5)) |
| `record_group_scores`, `set_score_adjustment` | S8e: no `gameNumber` | `ensureOpenGame` after `findEditableResult`: the record's game is open, or the caller is an Admin and the record is Pending or Submitted (not yet validated, A60(7), A69(2)); the status rejections are `findEditableResult`'s (A69(2)); open game: recompute + `resetConfirmations` on the game row; Admin on a closed game: no reset, `recomputeAfterAdminEdit`. `record_group_scores` skips the captain/referee check for an Admin's closed-game edit |
| `advance_stage` (Scoring) | — | rejected: `'Games close through confirm_game or close_game; the stage moves on the close.'` |
| `dispute_match_result` | unchanged | still requires Submitted |

**Superseded by S8e (A67(3)), see "Phase S8e execution" below.** **Admin edits reach any closed game of the series** (A65(4), S8d; supersedes the S7 "current game only" limit): `record_group_scores` / `set_score_adjustment` go through `ensureEditableGame(ctx, lobbyId, gameNumber, user, record)` (the current game for everyone; an earlier game whose `MatchResultGame` row exists and is closed for an Admin; otherwise "Scores can only be entered for the current game (N)."); `set_eidolon`, `equip_lightcone`, `unequip_lightcone` and `arrange_lineup` take an optional trailing `gameNumber` (an earlier closed game, Admin only: "Only an Admin may edit an earlier game."). `recomputeSeriesAfterAdminEdit(ctx, lobby, record, actorId, gameNumber)` recomputes the edited game. The steps of every game stay until finalization (A65(1)), so tie-breaks 2/3 can read them. An earlier-game edit does not touch the session budgets (they belong to the current game).

## Phase S8d execution (DECISIONS.md A24, A36, A38(1), A54, A60(6), A63, A65; ACCESS-SECURITY-OPS §D.8.3)

**One record per lobby (A54).** `start_draft` inserts the lobby's only `MatchResultRecord`; `performConcede`
updates it in place (Validated, `winnerTeamSide`, `matchEndReason: Concede`, `concedeTrigger`, `concedeSummary`,
`concedeAtStage`, `settledAt`, `refereeUserId` = the conceding caller) and `defer_match` records `concedeSummary` /
`concedeAtStage` on the Pending record (no winner). Both reject "No match result for this lobby." when none exists
(they run from Drafting on). Readers: `findLobbyResult` (scoringHelpers) and `findPendingResult` /
`findEditableResult` on it; `hasConcededRecord` reads the one record; `admin_force_finalize` / `admin_void_match`
use `findLobbyResult`; `dispute_match_result` reads the disputed record's own `matchEndReason`. Views that still read
records per lobby (S9 rewrites them; unchanged and correct with one record): `view_my_match_participants`
(`views/matchViews.ts`, `[0]`),`view_my_tournament_match_results` (`views/tournamentViews.ts`, every record
of a bracket match, Voided ones included), plus `accountSelection.ts` (`[0]`).

**Routing at the deciding close (`submitSeriesResult`).** Standalone: Casual → Validated + `runFinalization`; Ranked →
Submitted. Tournament (A24(1)(2)(4), A36): `requireResultValidation` → Submitted (staff: `validate_match_result`);
otherwise Validated with `settledAt` and `handOffToBracket`. A tournament record is **never** finalized here; the lobby
parks in AwaitingResult until the finalize job ([../tournament/architecture.md](../tournament/architecture.md)).

| Reducer | Change |
|---|---|
| `validate_match_result(matchResultId)` (new) | `results`; tournament InProgress; record Submitted or Disputed (the dispute blocks until staff review, A36); → Validated, `settledAt`, `handOffToBracket('Played')`. Standalone records: "Only tournament results are validated by staff; use admin_force_finalize for a standalone match." |
| `finalize_match_result` | tournament records rejected first: "Tournament matches finalize when the tournament completes (A24)."; authority = Moderator+ or the record's referee (the tournament branch and the D-H-01 guard are gone) |
| `process_tournament_mmr` | **deleted**; MMR of tournament records runs in `runFinalization` step 11 inside the job (`options.tournamentMmr`), with the real `matchHistoryId` (the sentinel back-fill, step 12, is gone) |
| `admin_force_finalize` / `admin_void_match` | reject tournament lobbies: "This is a tournament lobby: use resolve_bracket_match(bracketMatchId, winnerTeamId, reason) or validate_match_result(matchResultId) (results permission)." / "… use rollback_bracket_match(bracketMatchId, reason) …"; standalone unchanged (`winnerTeamId` 1 = Blue, 2 = Red) |
| `override_match_result` | tournament record (InProgress; status Submitted, Disputed or Validated, else "Only a Submitted, Disputed or Validated tournament result can be overridden (this one is X)."; the lobby still exists, else "The match lobby no longer exists; use resolve_bracket_match."): Validated(winner) → record Validated + `settledAt`, then rollback when the match is Decided for the other team and `applyBracketResult(…, 'Staff')`; Rejected → rollback when the match is Decided for this record's team, lobby voided, status kept Rejected. Standalone unchanged |
| `runFinalization` | 4th argument `options`; step 4 sorts by (gameNumber, sequence) and step 8 archives every game (A65(3)); step 17 (bracket) removed; leaderboard rebuild (13b) stays standalone-only |

## Phase S8e execution (DECISIONS.md A67(3)(4)(6); supersedes A65 and A60(6)'s series submission)

**One game per record.** `MatchResultGame` keeps one row per record (decorative key `matchResultId`, index
`match_result_id`); `MatchResultGroupScore` / `MatchResultAdjustment` are keyed by the record (`by_result`);
`MatchResultGameHistory` is keyed by `matchHistoryId`; `MatchLineupHistory` has no `gameNumber`. `MatchResultGame`
stays a separate 1:1 table (A67(3), smallest diff).

**Helpers** (`helpers/results/scoringHelpers.ts`): `findGame(ctx, matchResultId)`, `ensureGame(ctx, record, lobby, actorId)`,
`recomputeGame(ctx, record, lobby, actorId)`, `ensureOpenGame(ctx, lobby, record, user)`, `teamDraft(ctx, lobbyId,
side)`, `findLineup(ctx, lobbyId, side)`, `teamRosterCost(ctx, lobby, side, draft)`, `refreshLineupCosts(ctx, lobby,
side, actorId)`, `ensureAuctionSurchargeFits(ctx, lobby, session, side)`, `equippedLightcones(ctx, lobbyId, side)`,
`lobbyLineups(ctx, lobbyId)` (index `by_lobby`), `deleteScoringRows(ctx, matchResultId, lobbyId)`. Deleted:
`lobbyGameNumbers`, `seriesTally`.

**Game close (`helpers/results/gameClose.ts`).** `closeGame` closes the game (flags, `closedAt` / `closedById`, staff override
on a level-4 tie, one `ConfirmGame` step) and always calls **`submitGameResult(ctx, record, lobby, actorId)`** (renamed
from `submitSeriesResult`): the game must be closed with a result; the record's `winnerTeamSide` = the game's winner
(ties: the A60 / A63 override already on the game row); Casual standalone → Validated + `runFinalization` inline;
Ranked → Submitted; tournament → Validated + `handOffToBracket` (derived tally, A67(4)) or Submitted under
`requireResultValidation`; lobby → AwaitingResult + "Match complete. Stage: AwaitingResult". The between-games branch,
`writeTally` and the tally-based decision are gone. **`recomputeAfterAdminEdit(ctx, lobby, record, actorId)`**
(renamed from `recomputeSeriesAfterAdminEdit`): recompute the record's game; the tie rule as before; a Submitted
record's `winnerTeamSide` follows the game's winner. A69(3) (fix pass 2): the Pending branch is gone; the record is
always Submitted here (the close submits; a Validated record is no longer editable).

**Edit rule.** `ensureEditableGame` is deleted: `record_group_scores` and `set_score_adjustment` use `ensureOpenGame`
alone (the game is open, or the caller is an Admin and the record is Pending or Submitted, i.e. not yet validated;
A60(7), A69(2)). **A69(2) (fix pass 2):** the window ends at validation. The status rule lives in one helper,
`ensureEditableRecord(record, user)` (`findEditableResult(ctx, lobbyId, user)` wraps it; `resolveEditWindow` in
`reducers/draft/postDraft.ts` calls it in its fall-through, after the unchanged Admin closed-game branch and the stage
guard): Pending → editable; Submitted → editable by an Admin only; rejections `'No pending match result for this lobby.'` (no record), `'This game is closed.'` (Submitted record, caller not an Admin), `'This game can no longer be edited here; corrections go through override_match_result.'` (Validated, Finalized, Disputed, Rejected, Voided: everyone, Admins included). A Validated tournament
record has already moved the bracket, so corrections go through `override_match_result` (A24 TD-13 / TD-14), which
reverts and recomputes the tally (A67(4)). `ensureOpenGame` then only decides open / Admin closed-game edit. The four edit reducers of the session lose their trailing `gameNumber` (`docs/match-session/architecture.md`).

**Concede (A67(6)).** `performConcede` settles the lobby's record (A54 / A66 unchanged) and hands it to the bracket
through `handOffToBracket` → `recordGameSettled` (the game counts toward the tally; the match ends only when a side
reaches ceil(bestOf / 2) or staff resolve it). Stage list: Drafting, Equipping, Scoring.

**Finalization.** `runFinalization` sorts the steps by `sequence`, writes one `MatchResultGameHistory` row per game row
(one), the lineups and the steps without `gameNumber`. Per-record MMR is unchanged (step 11).

| Reducer | S8e change |
|---|---|
| `override_match_result` | tournament record: a Decided bracket match is first reverted without voiding any game (`rollbackBracketResult(…, false, false)`, refused while a downstream match is Decided); Validated → record Validated, then `recordGameSettled(…, 'Staff')`; Rejected → lobby voided, status kept Rejected, then the tally is recomputed. Details: [../admin/architecture.md](../admin/architecture.md). The Ranked screenshot message names "the game" (no number) |

## Phase S8g execution (DECISIONS.md A70)

- **Result credit by the match's colours (A70(1)).** `recordWinnerTeamId(match, record)` (`helpers/tournament/tournamentResults.ts`)
  returns `sideTeamId(match, record.winnerTeamSide)` (`helpers/tournament/matchSides.ts`): the team that plays the winning colour
  in this bracket match (`BracketMatch.blueTeamId`, default team1 = Blue). The tally credits each Validated record the
  same way: [../brackets/architecture.md](../brackets/architecture.md) "Phase S8g execution". Records keep
  `winnerTeamSide` as a colour; nothing changes in the record schema.

## Phase S9a execution (DECISIONS.md A37, A54, A56, A60(9), A63; user 2026-11-07)

- **`MatchResultRecord.refereeFullControl` is dropped** with its `start_draft` write: since A63 no reducer read it, the
  live seat decides neutrality, and the snapshot went stale after a referee transfer. `view_my_tournament_match_results`
  (projects the row type) no longer carries it.
- **`view_my_match_result`** (per-sender, live or parked lobby): status, winner, concede and override fields, settledAt;
  no `refereeUserId`; `disputedByUserId` / `winnerOverrideById` masked per A37.
- **`view_my_match_result_games`**: the record's one `MatchResultGame` with its `MatchResultGroupScore` rows
  (`groupScores[]`) and `MatchResultAdjustment` rows (`adjustments[]`) nested; the A60 flags and closed marker;
  `validatedByUserId`, `closedById`, `setById` masked per A37; no audit columns.
- **`view_admin_stuck_games`** (Moderator+, else `[]`): ranked lobbies in Scoring whose open game has exactly one ready
  flag, or both on an unresolved level-4 tie (`isUnresolvedTie`); `{ lobbyId, joinCode, stage, blueConfirmed,
  redConfirmed, isTie, sinceAt = game.lastModifiedDate }`. Catalogue: [../views/architecture.md](../views/architecture.md).

## Phase S10c execution (audit 2026-11-09; DECISIONS.md A82, A83)

- **Finalization step 16, character stats (A82;** `helpers/results/finalizationHelpers.ts`**).** An `AuctionSold` step no
  longer reads its actor (the passer, or the system `0` / Spectator slot on a timer or immediate timer sale). The owning
  side is `payload.value.winningTeam`; a step whose winning team is not Blue / Red writes nothing. Every participant of
  the owning side (`effectiveParticipants`: the non-coach `MatchResultParticipant` rows, or the concede fallback rows,
  which exclude coaches and spectators) gets `incrementPlayerCharacterStat` with the owning side's win flag; every
  participant of the other side gets `incrementFacedStat`; `incrementGlobalCharacterStat` runs once with the owning
  side's win flag. No row is written for the system user. Classic `Pick` (picker = actor, "played"; the other side
  "faced") and `Ban` are unchanged.
- **`view_my_match_result` (A83;** `views/matchResultViews.ts`**).** `concedeSummary` is emitted only when the caller's
  `User.role` is Moderator or above (`isRoleAtLeast`); every other caller gets no value, whatever the lobby's anonymity
  flags. The stored text (D-71, with user ids) is unchanged. A83 narrows this member view only:
  `view_my_tournament_match_results` (tournament staff view, `views/tournamentViews.ts`) still returns the column to the
  tournament's organizer and assistants, who resolve deferred and conceded matches and already see real ids in their own
  tournament (A37).

## Phase S10f execution (results audit #3, #7, #8)

- **Finalization step 16, sentinels (#3).** A step whose character is `EMPTY` (timer pick, auto-nomination) or `SKIP`
  (timer ban) writes no stat row of any kind (player, faced, ban, global). A Classic timer pick of a real character
  (A86 `autoRandomPick`: `actorUserId = 0`, `actorSlot` = the acting team) writes no `PlayerCharacterStat` row for the
  system user; the opponents' faced rows and the global row are written, the global row's win flag taken from
  `actorSlot` exactly as for a manual pick (whose `actorSlot` is the picker's team). The dead Nominate / Bid name
  extraction is gone.
- **Result-entry window (#7).** `record_group_scores`, `set_score_adjustment` and `confirm_game` count each call in a
  per-user fixed window (`consumeResultEntryAllowance`, `helpers/lobby/abuseControls.ts`; `UserRateState`
  `resultEntryWindowStart` / `resultEntryCount`, row created on first use, window starting at the epoch): at most
  `RESULT_ENTRIES_PER_WINDOW = 30` writes per `RESULT_ENTRY_WINDOW_MS = 10 000`, then "You are entering results too
  quickly. Please wait a moment." until the window is 10 s old. Burst-tolerant, so a referee saving both teams' scores
  in one click (two calls back to back) passes; the three reducers share the count, and a rejected call consumes
  nothing (the reducer rolls back). Constants, not `AbuseConfig` columns. Counted on the open-game path for a caller
  with a `LobbyMember` row in the lobby; staff outside the lobby and the A60(7) Admin closed-game edit are not counted.
  These reducers do not use the B-4 lineup throttle (`LobbyMember.lastLineupAt`, 250 ms), which stays on
  `arrange_lineup`, `equip_lightcone`, `unequip_lightcone` and `set_eidolon` only. `confirm_game` also counts against
  the confirming side's confirmation-step cap (per side since review F1; `docs/match-session/architecture.md`, S10f).
- **Adjustment bounds (#7).** `set_score_adjustment`: at most `MAX_ADJUSTMENTS_PER_RECORD = 20` rows per record (both
  teams; a new entry beyond it: "A game can carry at most 20 adjustments; edit or delete one first."); each value
  within ±`MAX_SCORE_HUNDREDTHS` (100 000 000, unchanged). Review F2: the sum of each team's adjustments after the
  call stays within the same bound for every team the call changes: the entry's team after the call (a new entry or
  an edit: the `teamSide` argument; a delete, `value = 0` with `adjustmentId`: the existing row's team, the `teamSide`
  argument is ignored) and, on an edit or a delete, the existing row's team, which loses the old value ("The {team}
  adjustments cannot add up to more than 100000000 hundredths either way.", naming the team out of bounds). So moving
  or deleting an entry while naming the other team cannot push the old team past the bound, and no team's sum leaves
  ±100 000 000; the adjusted result fits the i32 `team*AdjustedResult` columns. An unknown `adjustmentId` is rejected
  ("Adjustment not found for this game.") before the sum check. `value` is an i32 argument, so it is always a finite integer.
- **`override_match_result` on a standalone record (#8,** `reducers/tournament/tournamentAdmin.ts`**).** The record must
  not be Voided ("This result was voided."), must be Submitted, Disputed or Validated ("Only a Submitted, Disputed or
  Validated result can be overridden (this one is X)."), and its lobby must exist ("The match lobby no longer exists.")
  and be in AwaitingResult ("Only the result of a match waiting for its result (AwaitingResult) can be overridden."). A
  tournament record whose bracket match is gone takes the same path. The tournament branch is unchanged.
- **LOW.** The stale `dispute_match_result` comment on optional u32 values is removed.

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
| "Scoring (S7)" section: `shared/scoring/`, `record_group_scores`, `set_score_adjustment`, `submit_match_result` without `winnerId`, stored computation, `MatchLineupHistory`, `MatchSessionHistory.winnerOverride*`, deletions on both exits (A21, A31, A39, A55, A56) | Phase S7 execution | 2026-11-06 |
| Review fixes: roster cost always live (light cones after confirm count), `equip_lightcone` refreshes the lineup and reserves a confirmed Auction surcharge, adjustment authority = A39 staff set, input bounds, surcharge clamped before summing, `@shared/scoring` import | Phase S7 execution | 2026-11-06 |
| "Game package" section: per-game `blueConfirmed` / `redConfirmed` / `closedAt` / `closedById` on `MatchResultGame`; `confirm_game`, `close_game` (A39 seating rule at the close), automatic series submission (`submitSeriesResult`), closed-game rule (`ensureOpenGame`), Admin edit path (`recomputeSeriesAfterAdminEdit`); `confirm_match_scores`, `submit_match_result`, `MatchResultRecord.blueConfirmed/redConfirmed` removed; `advance_stage` Scoring branch removed | Phase S7b execution (DECISIONS.md A60) | 2026-11-07 |
| `confirm_game` = ready flag only (captain of the side; full-control referee shortcut removed); `close_game` = the submit (either captain once both flags are set, or the staff set; only staff may override); close step `actorSlot` = the closer's team side or Spectator; `resultAuthority` split from `ensureResultAuthority` | Phase S7b follow-up (DECISIONS.md A63) | 2026-11-07 |
| One record per lobby (concede / defer update it; readers explicit); tournament routing at the deciding close (Validated + hand-off, or Submitted for staff); `validate_match_result` added; `process_tournament_mmr` deleted; `finalize_match_result` and the admin tools reject tournament records / lobbies; Admin edits reach earlier closed games (A24, A36, A54, A65(4), D.8.3) | Phase S8d execution | 2026-11-07 |
| One game per record: `gameNumber` and the per-game keys removed from the result tables; the close submits the game (`submitGameResult`); `recomputeAfterAdminEdit`; `ensureEditableGame` removed; override recomputes the derived bracket tally (A67(3)(4)(6)) | Phase S8e execution | 2026-11-08 |
| Admin edit window ends at validation (`ensureEditableRecord` / `findEditableResult(ctx, lobbyId, user)`, three rejections); `ensureOpenGame` loses its status throws; `recomputeAfterAdminEdit` loses its Pending branch | Phase S8e execution (DECISIONS.md A69(2)(3)) | 2026-11-08 |
| `recordWinnerTeamId` maps the winning colour through the bracket match's colour mapping | Phase S8g execution (DECISIONS.md A70) | 2026-11-08 |
| `refereeFullControl` dropped; `view_my_match_result`, `view_my_match_result_games` (nested group scores and adjustments), staff-only `view_admin_stuck_games` | Phase S9a execution (DECISIONS.md A37, A54, A56, A60(9), A63) | 2026-11-08 |
| Finalization step 16: `AuctionSold` stats follow `winningTeam` (played for every player of that side, faced for the other, one global row), never the step actor | Phase S10c execution (DECISIONS.md A82) | 2026-11-09 |
| `view_my_match_result.concedeSummary` only for Moderator / Admin callers | Phase S10c execution (DECISIONS.md A83) | 2026-11-09 |
| No stats for `EMPTY` / `SKIP` / the system picker; result reducers share a per-user result-entry window (30 writes per 10 s, `UserRateState`); at most 20 adjustments per record and a bounded per-team sum, checked on every team the call changes (review F2); standalone `override_match_result` needs Submitted / Disputed / Validated and an AwaitingResult lobby | Phase S10f execution (results audit #3, #7, #8) | 2026-11-09 |

---

*Last updated: 2026-11-08*
*Feature owner: Phase 06 / Phase 07 / Phase 10.1 / Phase 12.3*

**Behavior specification** (acceptance scenarios, edge cases, phase history): See [contract.md](contract.md)
