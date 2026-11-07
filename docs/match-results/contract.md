# Match Results

**Architecture:** [architecture.md](architecture.md)

## Feature Overview

Match results manage the full lifecycle of determining a match outcome: per-game score entry, captain confirmation, referee submission, dispute handling, and finalization that writes stats and MMR. Casual matches auto-validate on submit and auto-finalize inline. Ranked matches go through a two-step flow: submission by referee puts the result in Submitted status; a moderator, referee, or tournament organizer then validates it. Admin tools handle exceptional cases: force-finalization of stuck matches, voiding matches without stats, setting bracket winners post-rollback, and overriding disputed results.

## Reducers

### record_game_scores

> **Superseded (Phase S7 execution, A21):** removed; replaced by `record_group_scores` + `set_score_adjustment` (see "Server-Computed Scoring" below). Kept for history.

**Purpose:** Record or update per-game scores for a match result. Composite PK upsert (delete + insert on existing row).

**Permission:** Participant captain (own side only) OR spectator referee with `refereeFullControl=true` (both sides)

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| matchResultId | u32 | Yes | Target MatchResultRecord |
| gameNumber | u8 | Yes | Game number (1-based) |
| winnerTeamSide | string | Yes | "Blue" or "Red" |
| teamBlueCyclesUsed | u32? | No | Blue team cycle count |
| teamRedCyclesUsed | u32? | No | Red team cycle count |
| teamBlueScore | u64? | No | Blue team score |
| teamRedScore | u64? | No | Red team score |
| teamBlueBoss1Score | u64? | No | Blue boss 1 score |
| teamBlueBoss2Score | u64? | No | Blue boss 2 score |
| teamRedBoss1Score | u64? | No | Red boss 1 score |
| teamRedBoss2Score | u64? | No | Red boss 2 score |
| teamBlueScreenshotUrl | string? | No | Blue screenshot URL |
| teamRedScreenshotUrl | string? | No | Red screenshot URL |

**Flow:**
1. Authenticate caller via `getAuthenticatedUser(ctx)`
2. Look up `MatchResultRecord` by id; throw if not found
3. Validate status is `Pending`; throw if not
4. Liveness guard: `ensureNotConceded` (Phase S4 execution, F8 / DECISIONS.md A22(4)) — blocks scoring after a concede or in Finished; AwaitingResult is allowed
5. Validate `winnerTeamSide` is "Blue" or "Red"
6. Authority check:
   - If participant: must be `isCaptain=true`; Blue captain rejects Red-side fields, Red captain rejects Blue-side fields
   - If non-participant: must be `isReferee=true` on the lobby AND `matchResult.refereeFullControl=true`
7. Upsert `MatchResultGame` row: if row exists for `[matchResultId, gameNumber]`, delete then insert (composite PK); otherwise insert fresh

**Expected State Changes:**
- `MatchResultGame` row inserted or replaced for `[matchResultId, gameNumber]`

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Match result not found | "Match result not found." |
| Status is not Pending | "Scores can only be recorded when the match is in Pending status." |
| `winnerTeamSide` invalid | "winnerTeamSide must be \"Blue\" or \"Red\"." |
| Caller not captain | "Only the team captain can record game scores." |
| Blue captain provides Red-side fields | "Captains can only enter scores for their own side." |
| Non-participant, not referee | "You are not a participant or authorized referee of this match." |
| Non-participant referee, no `refereeFullControl` | "You are not a participant or authorized referee of this match." |
| Associated lobby not found | "Associated lobby not found." |

---

### confirm_match_scores

**Purpose:** Confirm scores for a team side. Captains confirm their own side; spectator referees with `refereeFullControl=true` confirm both sides at once.

**Permission:** Participant captain OR spectator referee with `refereeFullControl=true`

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| matchResultId | u32 | Yes | Target MatchResultRecord |

**Flow:**
1. Authenticate caller
2. Look up `MatchResultRecord`; throw if not found
3. Validate status is `Pending`
4. Liveness guard: `ensureNotConceded` — block after a concede or in Finished; AwaitingResult is allowed (Phase S4 execution, F8 / DECISIONS.md A22(4))
5. Participant path: caller must be `isCaptain=true`; sets `blueConfirmed` or `redConfirmed`
6. Non-participant path: requires `refereeFullControl=true` and `isReferee=true`; sets both `blueConfirmed` and `redConfirmed`

**Expected State Changes:**
- `MatchResultRecord.blueConfirmed` and/or `redConfirmed` set to `true`

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Match result not found | "Match result not found." |
| Status is not Pending | "Scores can only be confirmed when the match is in Pending status." |
| Participant but not captain | "Only the team captain can confirm match scores." |
| Non-participant, `refereeFullControl` disabled | "Referee full control is not enabled for this match." |
| Non-participant, not referee | "You are not a participant or referee of this match." |

---

### submit_match_result

> **Superseded in part (Phase S7 execution, A21/A31/A39):** `winnerId` is gone; the server computes the winner and the optional `winnerOverride` / `winnerOverrideReason` arguments decide an unresolved tie. See "Server-Computed Scoring" below.

**Purpose:** Submit the final match result with a winner (or 0 for draw). Casual matches auto-validate; Ranked matches transition to Submitted status for later validation.

**Permission:** Lobby referee, Moderator+, or tournament TO/assistant with `canValidateResults=true`

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| matchResultId | u32 | Yes | Target MatchResultRecord |
| winnerId | u32 | Yes | Winner's userId, or 0 for draw |

**Flow:**
1. Authenticate caller
2. Look up `MatchResultRecord`; throw if not found
3. Validate status is `Pending`
4. Liveness guard: `ensureNotConceded` — block after a concede or in Finished; AwaitingResult is allowed (Phase S4 execution, F8 / DECISIONS.md A22(4))
5. Require both `blueConfirmed` and `redConfirmed` to be `true`
6. Validate `winnerId`: must be a participant userId, or 0 for draw
7. Authority check: caller is lobby referee, OR Moderator+, OR tournament TO/assistant (derived via BracketMatch since `tournamentId` removed from MatchResultRecord per D-42)
8. Set status: `Validated` for Casual, `Submitted` for Ranked
9. Set `winnerTeamSide`, `matchEndReason` (Completed or Draw), `refereeUserId`
10. Transition lobby to `AwaitingResult` if not already there or Finished
11. Casual auto-finalize: call `runFinalization` inline

**Expected State Changes:**
- `MatchResultRecord.status` → Validated (Casual) or Submitted (Ranked)
- `MatchResultRecord.winnerTeamSide`, `matchEndReason`, `refereeUserId` set
- `Lobby.stage` → AwaitingResult (if applicable)
- Casual: full finalization pipeline runs inline (stats, MMR, lobby delete)

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Match result not found | "Match result not found." |
| Status is not Pending | "Match result can only be submitted when in Pending status." |
| Both sides not confirmed | "All team captains must confirm scores before submission." |
| `winnerId` not a participant | "Invalid winner: must be a match participant or 0 for a draw." |
| Caller has no authority | "You do not have referee authority to submit this match result." |

---

### dispute_match_result

**Purpose:** Allow a match participant to dispute a submitted result.

**Permission:** Match participant only

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| matchResultId | u32 | Yes | Target MatchResultRecord |
| reason | string | Yes | Dispute reason (1-1000 chars) |

**Flow:**
1. Authenticate caller
2. Look up `MatchResultRecord`; throw if not found
3. Check idempotency: throw if already `Disputed`
4. Validate status is `Submitted` (not Pending, not Validated)
5. Block after concede (matchEndReason=Concede)
6. Verify caller is a `MatchResultParticipant`
7. Validate reason: non-empty after trim, max 1000 chars
8. Update status to `Disputed`, set `disputedByUserId`, `disputeReason`

**Expected State Changes:**
- `MatchResultRecord.status` → Disputed
- `MatchResultRecord.disputedByUserId`, `disputeReason` set

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Match result not found | "Match result not found." |
| Already disputed | "This match result has already been disputed." |
| Status is not Submitted | "A match result can only be disputed after it has been submitted." |
| Match conceded | "Match has been conceded." |
| Caller not a participant | "You are not a participant of this match." |
| Empty reason | "Dispute reason cannot be empty." |
| Reason > 1000 chars | "Dispute reason cannot exceed 1000 characters." |

---

### finalize_match_result

**Purpose:** Finalize a Validated match result, running the full 19-step finalization pipeline (stats, MMR, leaderboard, lobby cleanup).

**Permission:** Moderator+, the match referee, or tournament TO/assistant

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| matchResultId | u32 | Yes | Target MatchResultRecord |

**Flow:**
1. Authenticate caller
2. Look up `MatchResultRecord`; throw if not found
3. Validate status is `Validated`
4. Authority check: Moderator+, OR `refereeUserId === user.id`, OR tournament access via BracketMatch
5. Phase 12.3 D-H-01 ordering guard: if match is tournament-controlled, reject unless the parent tournament stage is `Completed` or `Cancelled`
6. Delegate to `runFinalization(ctx, matchResult, user.id)`

**Expected State Changes:**
- Full finalization: `MatchHistory` row inserted, `PlayerStats` updated, `MmrHistory` rows written, leaderboard rebuilt, lobby hard-deleted

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Match result not found | "Match result not found." |
| Status is not Validated | "Match result must be Validated before finalization." |
| No authority | "You do not have authority to finalize this match result." |
| Tournament match, tournament not yet Completed or Cancelled (D-H-01) | Ordering guard error — must wait for tournament to finish |

---

### admin_force_finalize

**Purpose:** Resolve a stuck AwaitingResult match by setting a winner and running the full finalization pipeline. Per D-52.

**Permission:** Moderator+, tournament organizer, or tournament assistant

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| lobbyId | u32 | Yes | Target lobby in AwaitingResult |
| winnerTeamId | u32 | Yes | Winner team ID (tournament: actual team ID; non-tournament: 1=Blue wins, 2=Red wins) |

**Flow:**
1. Authenticate caller
2. Look up `Lobby`; throw if not found
3. Permission check via `ensureAdminOrOrganizer`
4. Validate lobby stage is `AwaitingResult`
5. Find `MatchResultRecord` for lobby; throw if not found
6. Reject if `mmrProcessedAt` already set (already processed)
7. Determine `winnerTeamSide` from `winnerTeamId` (tournament: via BracketMatch team1Id/team2Id; non-tournament: 1=Blue, 2=Red)
8. Update `MatchResultRecord` with winner, status=Validated, preserve existing `matchEndReason` if already set (e.g., Concede)
9. Call `runFinalization`

**Expected State Changes:**
- `MatchResultRecord.status` → Validated with winner set
- Full finalization pipeline runs

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Lobby not found | "Lobby not found." |
| No authority | "Only moderators, admins, or the tournament organizer can perform this action." |
| Stage is not AwaitingResult | "Can only force-finalize matches in AwaitingResult stage." |
| No match result record | "No match result record found for this lobby." |
| Already processed | "This match has already been processed. Cannot force-finalize." |

---

### admin_void_match

**Purpose:** Erase an AwaitingResult match completely without running finalization. No stats written. Per D-53, D-55.

**Permission:** Moderator+, tournament organizer, or tournament assistant

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| lobbyId | u32 | Yes | Target lobby in AwaitingResult |

**Flow:**
1. Authenticate caller
2. Look up `Lobby`; throw if not found
3. Permission check via `ensureAdminOrOrganizer`
4. Validate lobby stage is `AwaitingResult`
5. Reject if `matchResult.mmrProcessedAt` set
6. Call `hardDeleteLobby` — deletes lobby + all MatchResult* rows

**Expected State Changes:**
- Lobby and all associated `MatchResultRecord`, `MatchResultParticipant`, `MatchResultGame` rows hard-deleted
- No stats, MMR, or history written

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Lobby not found | "Lobby not found." |
| No authority | "Only moderators, admins, or the tournament organizer can perform this action." |
| Stage is not AwaitingResult | "Can only void matches in AwaitingResult stage." |
| Already processed | "This match has already been processed. Cannot void." |

---

### admin_set_bracket_winner

**Purpose:** Directly set a bracket match winner and advance the bracket. Used post-finalization for bracket fixes. Per D-54.

**Permission:** Moderator+, tournament organizer, or tournament assistant

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| bracketMatchId | u32 | Yes | Target BracketMatch |
| winnerTeamId | u32 | Yes | Winner's team ID |

**Flow:**
1. Authenticate caller
2. Look up `BracketMatch`; throw if not found
3. Permission check: Moderator+ OR tournament organizer OR assistant
4. Validate no winner already set (must call `rollback_bracket_match` first)
5. Validate `winnerTeamId` is `team1Id` or `team2Id`
6. Call `advanceBracketMatch`

**Expected State Changes:**
- `BracketMatch.winnerTeamId` set, winner advanced to next match

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Bracket match not found | "Bracket match not found." |
| No authority | "Only moderators, admins, or the tournament organizer can set bracket winners." |
| Winner already set | "Bracket match already has a winner. Call rollback_bracket_match first." |
| Winner not a participant | "Winner team must be one of the bracket match participants." |

---

### override_match_result

> **Changed (Phase S7 execution, A31):** a Validated override needs `winnerTeamSideTag` "Blue" or "Red"; "" / "Draw" / "Spectator" are rejected (no draws). This is also how staff resolve a record left Disputed by a seated referee's tie override (A39).

**Purpose:** Override a match result status to Validated or Rejected. Per D-30, D-31, D-42.

**Permission:** Tournament TO/assistant (tournament matches) or Moderator+ (non-tournament matches)

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| matchResultId | u32 | Yes | Target MatchResultRecord |
| newStatusTag | string | Yes | "Validated" or "Rejected" |
| winnerTeamSideTag | string | Yes | "Blue", "Red", or "" for draw |
| reason | string | Yes | Override reason (stored in disputeReason field) |

**Flow:**
1. Validate `newStatusTag` is "Validated" or "Rejected"
2. Look up `MatchResultRecord`; throw if not found
3. Permission check: tournament matches use `ensureTournamentAccess` (TO/assistant), non-tournament use `ensureModerator`
4. For Validated: parse `winnerTeamSideTag`; "" / "Draw" / "Spectator" = draw
5. For Ranked + Validated: require all games have both screenshots
6. Update record: status, `winnerTeamSide`, `matchEndReason`, store reason in `disputeReason`

**Expected State Changes:**
- `MatchResultRecord.status`, `winnerTeamSide`, `matchEndReason` updated

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Invalid `newStatusTag` | "Invalid status override: \"...\". Must be one of: Validated, Rejected" |
| Match result not found | "Match result not found." |
| Invalid `winnerTeamSideTag` for Validated | "Invalid winnerTeamSideTag: must be \"Blue\", \"Red\", or \"\" for a draw." |
| Ranked match missing screenshots | "Cannot validate: no game scores have been recorded." / "Cannot validate Ranked match: game N is missing screenshot(s). All games must have both teamBlueScreenshotUrl and teamRedScreenshotUrl." |

## Server-Computed Scoring (Phase S7 execution, A21, A31, A39, A55, A56)

The server decides every game and the series from the submitted inputs; the formula lives only in `shared/scoring/` (pure TypeScript, integer hundredths), which the web live preview imports too. Reducer signatures and storage: [architecture.md](architecture.md) "Scoring (S7)".

**Per game** (one team's inputs → result):
1. Raw result = sum of the team's group results (`MatchResultGroupScore`, one per lineup group: 2 for Halves, 3 for Thirds). Unit: cycles in Memory of Chaos / Anomaly Arbitration (lower wins), points in Apocalyptic Shadow (higher wins).
2. + every `MatchResultAdjustment` entry for that team and game, added as entered in the mode's unit (+2 cycles is a penalty, +500 points a bonus).
3. Handicaps, as an advantage (fewer cycles / more points): the cheaper team gets `rosterDiffAdvantage × |costBlue − costRed|`; a roster cost below `rosterThreshold` gets `underThresholdAdvantage`, above it `aboveThresholdPenalty`, **exactly at it neither**, and a threshold of 0 disables the pair; `deathPenalty × deaths` is a penalty.
4. Tie-break chain on equal adjusted results: (1) lower roster cost, (2) more 4★ characters (`HsrCharacter.rarity`), (3) fewer total eidolons on the team's 5★ characters (from the Pick / AuctionSold step payloads), (4) unresolved → the referee's `winnerOverride`.

**Who:** `record_group_scores` — the captain of that side, or any lobby referee for either side. `set_score_adjustment` — a lobby referee, a Moderator+, or in a tournament lobby the organizer or an assistant with `canResolveResults` (the A39 staff set, same as `submit_match_result`); reason optional (A55). Both reset both captains' confirmations. Group values and |adjustments| are capped at 100,000,000 hundredths.

**Override authority (A39):** `winnerOverride` is accepted only while a game's computed outcome is an unresolved tie (level 4) and then decides every tied game. Series rule: one `winnerOverride` per record decides **every** tied game of the series; until submit, a tied game counts for nobody, so `advance_stage` does not move the series on with it. From a referee not seated on either team, or from staff (Moderator+, the tournament organizer, an assistant with `canResolveResults`): accepted. From a referee seated on a team (player or coach seat): in a tournament lobby (`MatchResultRecord.isTournamentControlled`) the record goes to **Disputed** for staff, with the proposal stored in `winnerOverride*`; in a casual (non-tournament) lobby it is accepted. `winnerOverrideById` / `winnerOverrideReason` audit it.

**History (A56):** finalization archives each `MatchLineup` as a `MatchLineupHistory` row and the game row (raw totals, adjusted results, deaths, tie-break level, winner) as before; group scores, adjustments and live lineups are deleted with the result record on both exits (finalization and `hardDeleteLobby`).

## Game Confirmation, Close and Series Submission (Phase S7b execution, A60)

> Amended by DECISIONS.md A63 (Phase S7b follow-up): the second confirmation no longer closes the game and the full-control referee shortcut is gone; confirmations are ready flags and `close_game` is the explicit submit. See "Both Captains Ready, a Captain Submits the Game".

Supersedes, for games played from S7b on, the series-level confirmation (`confirm_match_scores`), the referee's submission (`submit_match_result`) and the S7 override routing above. Reducer reference: [architecture.md](architecture.md) "Game package".

- **One confirmation per captain per game** (`confirm_game(lobbyId, teamSide)`), covering lineup, light cones, eidolons and scores of the current game. Needs the side's lineup, both sides' complete group scores and, in Auction, the side's synergy surcharge within its remaining budget (character + light cones). A spectator referee with `refereeFullControl` confirms both sides at once. A side cannot confirm twice.
- **Every open-game edit resets both confirmations** (scores, adjustments, eidolons, light cones, lineups), after recomputing the game.
- **The second confirmation closes the game**: `MatchResultGame.closedAt` / `closedById` are set, the series tally (`MatchSession.gamesWonBlue/Red` = wins over closed games + the A27 head start) is updated, and the lobby moves to **BetweenGames**, or, when the series is decided, the result **submits itself**: Casual → Validated and finalized inline (D-04 / D-37); Ranked and tournament → **Submitted** (staff force-finalize; tournament routing unchanged). `refereeUserId` = the closer. There is no submit click any more.
- **A level-4 tie never closes on confirmations**: both flags stay set and the game stays open until staff close it with `winnerOverride`.
- **Staff close** (`close_game(lobbyId, winnerOverride?, winnerOverrideReason?)`): any lobby referee, a Moderator+, or in a tournament lobby the organizer or an assistant with `canResolveResults` may close the current game without both confirmations (both lineups and both scores needed; Auction gate for both teams). `winnerOverride` only on a level-4 tie, and required there. **A39 at the close:** in a tournament lobby a referee seated on a team (player or coach) who is not staff cannot decide a tie (rejected; staff close it); in a casual lobby the override is accepted and audited in `MatchResultRecord.winnerOverride*` (copied to `MatchSessionHistory` at finalization).
- **Closed is closed**: every edit reducer rejects a closed game ("This game is closed."), also between the close and the next draft, Moderators included.
- **Admin edits a closed game** (role Admin only) while the record is Pending or Submitted: scores, adjustments, eidolons, light cones, lineup of the **current** game. The game stays closed, confirmations stay, the audit columns name the admin, and the series is recomputed: an edit that leaves the game tied (unless it was already closed with an override) or undoes a submitted series result is rejected; a changed series winner on a Submitted record updates `winnerTeamSide`. After finalization nothing is editable (force-finalize and disputes are the tools).

## Phase 12.3: accountRatingSnapshot lifecycle

### Capture (MMR-RACE-01)

At `start_draft` time, when `MatchResultParticipant` rows are inserted, the reducer
resolves each player's `LobbyMemberAccount` rows for `(lobbyId, userId)` and writes the
**merged account rating** to `MatchResultParticipant.accountRatingSnapshot`:
`computeMergedAccountRating` over the union of the selected accounts' rosters (per character the
max eidolon across the accounts, same formula and `maxPossible` denominator). One selected account
gives that account's own `accountRating`. For casual matches with zero `LobbyMemberAccount` rows the
snapshot defaults to `0`. *(Phase S6/S7 execution, backlog #10: replaces the former
`max(accountRatings)` MAX rule; see docs/mmr/contract.md "Merged Account Rating".)*

This freeze eliminates three race vectors: (1) `set_active_hsr_account` post-capture,
(2) `batch_upsert/remove_characters` post-capture, (3) `process_tournament_mmr`
re-reading `HsrAccount` at tournament-end (potentially hours after match start).

### Read-path (MMR-RACE-02)

`processMatchMmr` at `finalizationHelpers.ts` reads `participant.accountRatingSnapshot`
directly. Both the standalone-ranked path (`runFinalization` step 11) and the
tournament-batch path (`process_tournament_mmr`) call the same helper, so the
read-path swap is path-independent.

### Monotonic-upward hook in BetweenGames

`select_match_account` carries a post-insert hook: if a `MatchResultRecord` exists for
the lobby (i.e. the match is in BetweenGames) and the caller has an MRP row,
`accountRatingSnapshot` becomes `max(existing, merged rating of the current selection)`
*(Phase S6/S7 execution, backlog #10: the merged rating replaces `newAccount.accountRating`; the ratchet stays)*.
`deselect_match_account` does NOT run the hook — removing from selection can never
lower the snapshot. The hook short-circuits when no MRP row exists (stand-ins joining
after `start_draft`).

## Acceptance Scenarios

### Happy Path: Captain Records and Confirms Scores, Referee Submits

**Given:** MatchResultRecord in Pending status, Blue captain and Red captain exist
**When:** Blue captain calls `record_game_scores(matchResultId, 1, "Blue", ...)`, Red captain records their side, both call `confirm_match_scores`, referee calls `submit_match_result(matchResultId, blueCaptainId)`
**Then:** MatchResultRecord transitions to Validated (Casual) or Submitted (Ranked). Lobby stage → AwaitingResult.

### Casual Match Auto-Finalizes

**Given:** Casual MatchResultRecord, both sides confirmed
**When:** Referee calls `submit_match_result`
**Then:** Status → Validated, `runFinalization` runs inline. Stats written. Lobby hard-deleted.

### Dispute After Submission

**Given:** Ranked MatchResultRecord in Submitted status
**When:** Participant calls `dispute_match_result(matchResultId, "Scores are wrong")`
**Then:** Status → Disputed. `disputedByUserId`, `disputeReason` set.

### Admin Force-Finalizes Stuck Match

**Given:** Lobby in AwaitingResult, `mmrProcessedAt` is undefined
**When:** Moderator calls `admin_force_finalize(lobbyId, winnerTeamId)`
**Then:** MatchResultRecord status → Validated with winner. Full finalization runs.

### Admin Voids a Match

**Given:** Lobby in AwaitingResult, `mmrProcessedAt` is undefined
**When:** Moderator calls `admin_void_match(lobbyId)`
**Then:** Lobby and all MatchResult* rows hard-deleted. No stats written.

### Spectator Referee Records Both Sides

**Given:** `refereeFullControl=true` on MatchResultRecord, spectator referee in lobby
**When:** Referee calls `record_game_scores` with both Blue and Red fields
**Then:** MatchResultGame row inserted for both sides. Referee may also call `confirm_match_scores` to confirm both sides at once.

### Ranked Override (Disputed Match)

**Given:** Ranked MatchResultRecord in Disputed status
**When:** Moderator calls `override_match_result(matchResultId, "Validated", "Blue", "Screenshot confirms Blue win")`
**Then:** Status → Validated, winnerTeamSide=Blue, matchEndReason=Completed, disputeReason set.

### Phase 12.3: processMatchMmr Reads Snapshot (MMR-RACE-02)

**Given:** A finalized match with two participants, each having an accountRatingSnapshot value set at start_draft time
**When:** `processMatchMmr` runs (either via runFinalization or process_tournament_mmr)
**Then:** ELO modifier is computed from `participant.accountRatingSnapshot` — not from a live `HsrAccount.accountRating` lookup. Even if a player changed their roster or active account after the draft started, the snapshot value is used.

### Phase 12.3: BetweenGames Monotonic Snapshot Update

**Given:** A best-of-N series in BetweenGames stage; player has accountRatingSnapshot=100 on their MRP row; player selects a second account with accountRating=150
**When:** `select_match_account(lobbyId, higherRatedAccountId)`
**Then:** accountRatingSnapshot updated to 150 (max wins).
*Superseded in part (Phase S6/S7 execution, backlog #10): the new value is the merged rating of the whole current selection, ratcheted against the old snapshot; the two-account case is in docs/mmr/contract.md "Merged Account Rating".*

**Given:** Same series; player then selects a third account with accountRating=80
**When:** `select_match_account(lobbyId, lowerRatedAccountId)`
**Then:** accountRatingSnapshot remains 150 (monotonic-upward; lower value does not replace).

### Phase 12.3: Tournament Ordering Guard (D-H-01)

**Given:** A tournament match where the parent tournament is still InProgress
**When:** Moderator calls `finalize_match_result(matchResultId)`
**Then:** Throws ordering guard error — tournament must reach Completed or Cancelled before individual match finalization is allowed.

**Given:** Same tournament match after the tournament stage advances to Completed
**When:** Moderator calls `finalize_match_result(matchResultId)`
**Then:** Finalization proceeds normally — 19-step pipeline runs, stats and MMR written, lobby hard-deleted.

### Result Submitted After advance_stage Parked the Lobby (Phase S4 execution, F8)
**Given:** bestOf=1, scores confirmed, host called `advance_stage` from Scoring, so the lobby is in AwaitingResult and the MatchResultRecord is Pending
**When:** Captains call `record_game_scores` / `confirm_match_scores`, then the referee calls `submit_match_result`
**Then:** All three succeed (`ensureNotConceded` allows AwaitingResult). A conceded record still rejects with "Match has been conceded."; a Finished lobby with "Match has ended."
*Note (Phase S7 execution): `record_game_scores` is now `record_group_scores`; the guard is unchanged.*

### A 4v4 + 4v4 Bo1 Scored by the Server (Phase S7 execution, A21)
**Given:** a Classic Memory of Chaos Halves lobby (deathPenalty 1 cycle), both lineups arranged and confirmed, stage Scoring
**When:** the Blue captain calls `record_group_scores(lobbyId, 1, Blue, [10.00, 12.00] in hundredths, deaths 1)` and the Red captain `[11.00, 11.50]`, deaths 0
**Then:** the game row holds `teamBlueCyclesUsed = 2200`, `teamRedCyclesUsed = 2250` (raw), `teamBlueAdjustedResult = 2300`, `tieBreakLevel = 0`, winner Red

### A Referee Adjustment Resets the Confirmations (Phase S7 execution, A21, A55)
**Given:** the game above, both captains confirmed
**When:** the referee calls `set_score_adjustment(lobbyId, 1, Red, +100)` with no reason
**Then:** `blueConfirmed` and `redConfirmed` are false; Red's adjusted result is 2350 and Blue wins at level 0; after both confirm again, `submit_match_result(matchResultId)` validates the casual result with winner Blue, writes `MatchSessionHistory.handicapApplied = −100` (Blue's death penalty; modifiers are not handicaps), the game history row and two `MatchLineupHistory` rows, and deletes the group scores, the adjustment and the live lineups

### Engineered Ties Resolved by Each Tie-Break Level (Phase S7 execution, A21)
**Given:** both captains record identical groups and no deaths
**When:** Blue's roster costs more / Blue has one more 4★ character / Blue picked a 5★ at E2 / nothing differs
**Then:** Red wins at level 1 / Blue wins at level 2 / Red wins at level 3 / `tieBreakLevel = 4` with no winner, and `submit_match_result` without `winnerOverride` is rejected ("…tied after every tie-break: the referee decides with winnerOverride.")

### Override Off a Tie Is Rejected (Phase S7 execution, A21, A39)
**Given:** a decided game
**When:** the referee submits with `winnerOverride`
**Then:** rejected: "A winner override is only accepted on an unresolved tie."

### Spectator Referee Overrides a Level-4 Tie in a Casual Lobby (Phase S7 execution, A39)
**Given:** a level-4 tie, the host is the spectator referee
**When:** the host submits with `winnerOverride = Red`
**Then:** accepted; the game is Red's (history `tieBreakLevel = 4`, winner Red) and the Red players get the win

### Seated Player-Referee Overrides in a Tournament Lobby (Phase S7 execution, A39)
**Given:** a level-4 tie, the referee is a Blue player, `MatchResultRecord.isTournamentControlled = true`
**When:** the referee submits with `winnerOverride = Blue`
**Then:** the record is **Disputed** with no `winnerTeamSide`, `winnerOverride = Blue`, `winnerOverrideById` = the referee; the lobby goes to AwaitingResult; nothing is finalized. Staff resolve it with `override_match_result`. In a casual lobby the same override is accepted and finalized.

### Both Captains Confirm a Bo1: the Game Closes and the Series Submits Itself (Phase S7b execution, A60(3)(6))
*Superseded by DECISIONS.md A63 (Phase S7b follow-up): see "Both Captains Ready, a Captain Submits the Game (Phase S7b follow-up, A63)".*
**Given:** a Casual Bo1 lobby in Scoring; both lineups arranged; both sides' group scores entered; Blue wins on the adjusted result
**When:** the Blue captain calls `confirm_game(lobbyId, Blue)`
**Then:** `MatchResultGame.blueConfirmed = true`, a `ConfirmGame` step `{ confirmedSide: Blue, closed: false }` is logged; nothing else changes.

**When:** the Red captain calls `confirm_game(lobbyId, Red)`
**Then:** the game closes (`closedAt`, `closedById` = the Red captain, both flags true), one `ConfirmGame` step `{ confirmedSide: Red, closed: true }` is logged, the record becomes Validated with `winnerTeamSide = Blue`, `matchEndReason = Completed`, `refereeUserId` = the Red captain, the system chat says "Match complete. Stage: AwaitingResult", and finalization runs inline. In a **Ranked** lobby the record lands in **Submitted** instead (lobby AwaitingResult) and waits for staff force-finalize.

**When:** a captain confirms the other side, a non-captain player confirms, or a seated referee who is not its team's captain confirms
**Then:** rejected ("Only the team captain can confirm …"). A spectator referee without `refereeFullControl`: "Referee full control is not enabled for this match."; with it, both flags are set at once and the game closes.

**When:** a captain confirms before the side's lineup exists, or before both sides' scores are complete
**Then:** rejected: "Arrange the lineup before confirming the game." / "Both teams' group scores are needed before confirming."

### A Bo3 Game 1 Close Moves to BetweenGames With the Tally (Phase S7b execution, A60(3), A27)
*Superseded by DECISIONS.md A63 (Phase S7b follow-up): see "Both Captains Ready, a Captain Submits the Game (Phase S7b follow-up, A63)".*
**Given:** a Bo3 lobby, game 1 in Scoring, Red wins game 1
**When:** both captains confirm
**Then:** game 1 is closed, `MatchSession.gamesWonRed = 1` (plus the A27 head start, if any), the lobby moves to BetweenGames with "Game 1 complete (0-1). Stage: BetweenGames"; the record stays Pending. Any edit of game 1 by a player, referee or Moderator is now rejected ("This game is closed."), also before the next draft starts. The close of the deciding game (2-0 or 2-1) submits the series ("Series complete (b-r). Stage: AwaitingResult").

### A Tie Stays Open Until a Staff Close With an Override (Phase S7b execution, A60(3)(4))
*Superseded by DECISIONS.md A63 (Phase S7b follow-up): see "Both Captains Ready, a Captain Submits the Game (Phase S7b follow-up, A63)".*
**Given:** game 1 is a level-4 tie (equal adjusted results, roster cost, 4★ count and 5★ eidolons)
**When:** both captains confirm
**Then:** both flags are set, no error, and the game stays **open** (no close, no stage change).

**When:** the spectator referee calls `close_game(lobbyId)` without an override
**Then:** rejected: "Game 1 is tied after every tie-break: staff closes the game with winnerOverride."

**When:** the spectator referee calls `close_game(lobbyId, Blue, 'coin toss on stream')`
**Then:** the game closes with `winnerTeamSide = Blue`, `tieBreakLevel = 4`; `MatchResultRecord.winnerOverride = Blue`, `winnerOverrideById` = the referee, `winnerOverrideReason` = the reason; the `ConfirmGame` step carries `{ confirmedSide: Spectator, closed: true, winnerOverride: Blue, … }`. An override on a game that is not a tie is rejected: "A winner override is only accepted on an unresolved tie."

### A Seated Referee Cannot Close a Tie in a Tournament Lobby (Phase S7b execution, A39, A60(4))
**Given:** a tournament lobby (`isTournamentControlled`), a level-4 tie, the lobby referee holds a Blue player seat and is not a Moderator, the organizer or a results assistant
**When:** the referee calls `close_game(lobbyId, Blue)`
**Then:** rejected: "A referee seated on a team cannot decide a tie in a tournament lobby; staff must close this game." Nothing changes; the organizer, a results assistant or a Moderator closes it. In a casual lobby the same call is accepted and audited. (Replaces the S7 Disputed route.)

### An Admin Edits a Closed Game, a Moderator Cannot (Phase S7b execution, A60(7))
**Given:** a Ranked Bo1 whose game closed with Blue winning; the record is Submitted, the lobby AwaitingResult
**When:** a Moderator calls `set_score_adjustment` for game 1
**Then:** rejected: "This game is closed."

**When:** an Admin calls `record_group_scores` for game 1 with corrected Blue values that keep Blue the winner
**Then:** accepted: the group rows and the game are recomputed, the game stays closed, both confirmations stay set, the audit columns name the Admin, the record stays Submitted with `winnerTeamSide = Blue`.

### An Admin Edit That Would Undo the Series Is Rejected (Phase S7b execution, A60(7))
**Given:** a Ranked Bo3 with the A27 head start for Blue (1-0); game 1 closed with Blue winning, so the series is 2-0, Submitted, lobby AwaitingResult
**When:** an Admin enters game 1 values that make Red win it (the tally would be 1-1)
**Then:** rejected: "The edit would undo the series result; void or force-finalize the match instead." Nothing changes.

**When:** an Admin enters values that leave game 1 a level-4 tie
**Then:** rejected: "The edit would leave the game tied; add an adjustment that decides it." (A game already closed on a tie with a staff override keeps its override winner when an edit leaves it tied.)

**When:** in a Ranked Bo1 (Submitted, Blue 1-0) an Admin's edit makes Red win the game
**Then:** accepted: the series is still decided (Red 1-0) and `MatchResultRecord.winnerTeamSide` becomes Red.

### Both Captains Ready, a Captain Submits the Game (Phase S7b follow-up, A63)
**Given:** a Casual Bo1 lobby in Scoring; both lineups arranged; both sides' group scores entered; Blue wins on the adjusted result
**When:** the Blue captain calls `confirm_game(lobbyId, Blue)`, then the Red captain calls `confirm_game(lobbyId, Red)`
**Then:** `blueConfirmed` and `redConfirmed` are both true and each call logged a `ConfirmGame` step `{ confirmedSide: <side>, closed: false }`; the game is still **open** (no close, no stage change), tie or not.

**When:** a non-captain player, a coach, a spectator, a referee who is not that side's captain (seated or spectator, full control or not) calls `confirm_game`
**Then:** rejected: "Only the team captain can confirm the game." A captain naming the other side: "Only the team captain can confirm the Red side of the game."

**When:** before both flags are set, a captain calls `close_game(lobbyId)`
**Then:** rejected: "Both captains must confirm the game before it can be submitted." A player who is neither captain nor staff: "Only a captain (once both sides confirmed), a referee, a Moderator or, in a tournament lobby, the organizer or a results assistant can close a game."

**When:** with both flags set, either captain (here Red) calls `close_game(lobbyId)`
**Then:** the game closes (`closedAt`, `closedById` = the Red captain), one `ConfirmGame` step `{ confirmedSide: Red, closed: true }` with `actorSlot = Red` is logged, and the series submits itself: Casual → Validated and finalized inline ("Match complete. Stage: AwaitingResult"); Ranked → Submitted. In a Bo3 that is not decided yet the lobby moves to BetweenGames with the tally.

**When:** with both flags set on a level-4 tie, a captain calls `close_game(lobbyId, Blue)`
**Then:** rejected: "Only staff may decide a tie." Without the override it is rejected by the tie rule; a referee or other staff closes it with `winnerOverride` (A39 seating rule unchanged). A referee or staff may also close without both flags at any time (staff close); a spectator referee's close logs `confirmedSide: Spectator`.

## Edge Cases

| Case | Expected Behavior | Notes |
|------|-------------------|-------|
| `winnerId=0` on submit | Draw: no `winnerTeamSide` set, `matchEndReason=Draw` | 0 is sentinel for draw |
| Submit before both sides confirmed | Rejected: "All team captains must confirm scores..." | Both flags required |
| Dispute already-disputed match | Rejected: "This match result has already been disputed." | Idempotent check |
| Captain tries to enter opponent's scores | Rejected: "Captains can only enter scores for their own side." | Side isolation |
| Force-finalize already processed match | Rejected: "This match has already been processed..." | `mmrProcessedAt` guard |
| Void already processed match | Rejected: "This match has already been processed. Cannot void." | Same guard |
| `admin_set_bracket_winner` before rollback | Rejected: "Bracket match already has a winner." | Must rollback first |
| Override non-tournament match as non-moderator | Rejected by `ensureModerator` | Tournament vs non-tournament permission split |
| Ranked override without screenshots | Rejected: "Cannot validate Ranked match: game N is missing screenshot(s)." | All games must have both URLs |
| Result reducers in AwaitingResult (Phase S4 execution, F8) | Allowed; only a concede or Finished rejects | `ensureMatchAlive` stays on the draft/equip reducers (DECISIONS.md A22(4)) |
| `winnerId=0` on submit (Phase S7 execution, A31) | Superseded: `winnerId` no longer exists; no draws anywhere | the two rows above about draws / own-side fields describe the removed reducers |
| Wrong number of group results (Phase S7 execution) | Rejected: "A Halves lineup has 2 group results; got 3." | Halves 2, Thirds 3 |
| Scores for a game other than the current one (Phase S7 execution) | Rejected: "Scores can only be entered for the current game (N)." | tie-breaks 2/3 read that game's steps, which `advance_to_next_game` deletes |
| Submit with a game missing a side's groups (Phase S7 execution) | Rejected: "Game N does not have complete group scores for both teams." | |
| Series level after the override (Phase S7 execution) | Rejected: "The series is level (x-y): play the deciding game first." | Bo3 only |
| Adjustment value 0 without `adjustmentId` (Phase S7 execution) | Rejected: "An adjustment of 0 changes nothing." | With an id, 0 deletes the entry |
| `admin_force_finalize` with a `winnerTeamId` that names no side and no concede winner (Phase S7 execution, A31) | Rejected: "winnerTeamId must name the winning team …: no draws." | `runFinalization` also refuses a record without a winner |

## Integration Points

| This Feature | Connects To | How | Direction |
|-------------|------------|-----|-----------|
| `MatchResultRecord.lobbyId` | `Lobby.id` | FK reference | Reads |
| `MatchResultParticipant.matchResultId` | `MatchResultRecord.id` | FK reference | Reads |
| `record_game_scores` | `MatchResultGame` | Composite PK upsert (delete+insert) | Writes |
| `submit_match_result` | `Lobby.stage` | Sets AwaitingResult | Writes |
| `submit_match_result` (Casual) | `runFinalization` | Inline finalization | Calls |
| `finalize_match_result` | `runFinalization` | Full pipeline | Calls |
| `admin_force_finalize` | `runFinalization` | Full pipeline | Calls |
| `admin_void_match` | `hardDeleteLobby` | Hard-deletes lobby + results | Calls |
| `admin_set_bracket_winner` | `BracketMatch`, `advanceBracketMatch` | Bracket advancement | Writes |
| `override_match_result` | `BracketMatch.tournamentId` | Permission derivation (D-42) | Reads |
| `MatchResultRecord.bracketMatchId` | `BracketMatch.id` | FK derivation for tournamentId (D-42) | Reads |
| `record_group_scores`, `set_score_adjustment`, `submit_match_result` (Phase S7 execution) | `shared/scoring` (`scoreGame`) | The one formula, also imported by the web live preview | Calls |
| Tie-breaks 2 and 3 (Phase S7 execution) | `HsrCharacter.rarity`, `MatchSessionStep` Pick / AuctionSold payloads | 4★ count, 5★ eidolon total | Reads |
| Tie-break 1 (Phase S7 execution) | steps + `MatchLineup.groups` (match-session) | Live roster cost (picks / sold characters + light cones + surcharge of the current groups), also after confirmation | Reads |
| `runFinalization` (Phase S7 execution, A56) | `MatchLineupHistory`; `MatchResultGroupScore`, `MatchResultAdjustment`, `MatchLineup` | Archive lineups; delete the live rows | Writes |

## Phase History

| Decision | Source | Date |
|----------|--------|------|
| MatchResultRecord, MatchResultParticipant, MatchResultGame table design | Phase 7 discussion | 2026-03-28 |
| Captain-only confirmation (blueConfirmed/redConfirmed) | Phase 7 execution | 2026-03-28 |
| Dispute flow for Ranked matches | Phase 7 execution | 2026-03-28 |
| Casual auto-validate on submit (D-04) | Phase 7 discussion | 2026-03-28 |
| Ranked two-step: submit → referee validates (MTCH-05) | Phase 7 discussion | 2026-03-28 |
| Liveness guard (D-12) — block actions after concede | Phase 10 execution | 2026-04-03 |
| admin_force_finalize (D-52), admin_void_match (D-53), admin_set_bracket_winner (D-54) | Phase 11 discussion | 2026-04-06 |
| D-56: guard against re-processing already-processed matches | Phase 11 discussion | 2026-04-06 |
| tournamentId removed from MatchResultRecord; derived via BracketMatch (D-42) | Phase 11 execution | 2026-04-06 |
| override_match_result uses winnerTeamSide + matchEndReason (D-30, D-31) | Phase 11 execution | 2026-04-06 |
| Ranked override requires screenshots (D-07) | Phase 11 execution | 2026-04-06 |
| Full hydration from codebase | Phase 13 normalization | 2026-04-09 |
| Phase 12.3 execution | accountRatingSnapshot capture at MRP insert (MMR-RACE-01); processMatchMmr snapshot read-path (MMR-RACE-02) replacing live HsrAccount lookup; select_match_account monotonic-upward hook in BetweenGames; finalize_match_result D-H-01 tournament ordering guard | 2026-04-12 |
| Phase S4 execution | Liveness guard split (DECISIONS.md A22(4), F8): `record_game_scores`, `confirm_match_scores`, `submit_match_result` use `ensureNotConceded` (concede or Finished rejected, AwaitingResult allowed); `ensureMatchAlive` unchanged for draft/equip reducers | 2026-11-06 |
| Phase S6/S7 execution | Snapshot capture wording: MAX of the selected accounts → merged rating over the union of their rosters, ratchet kept (backlog #10) | 2026-11-06 |
| Phase S7 execution | Server-computed scoring (A21): `record_group_scores` + `set_score_adjustment` replace `record_game_scores`; `submit_match_result` drops `winnerId`; tie-break chain; threshold boundary neutral, hundredths, eidolons from step payloads (backlog #11 settled items); `winnerOverride` authority (A39); no draws in submit / force-finalize / override / finalization (A31); optional adjustment reason (A55); `MatchLineupHistory` + deletions on both exits (A56); scenarios "A 4v4 + 4v4 Bo1 Scored by the Server" … "Seated Player-Referee Overrides in a Tournament Lobby" added | 2026-11-06 |
| Phase S7 execution | Review fixes: roster cost computed live (light cones equipped after `confirm_lineup` count); `set_score_adjustment` authority widened to the A39 staff set; input caps; series rule for `winnerOverride` stated. Synergy pairs (A21 / backlog #3): canonical storage + update-on-resubmit supersedes the literal "reject a pair that exists in either order" wording, **pending the user's confirmation** (docs/cost-sets/architecture.md) | 2026-11-06 |
| Phase S7b execution | Game package (DECISIONS.md A60): per-game confirmation `confirm_game` (second confirmation closes the game; a level-4 tie stays open), staff close `close_game` with `winnerOverride` (A39 seating rule at the close replaces the Disputed route), automatic series submission at the deciding close (Casual finalizes inline, Ranked → Submitted), closed-game rule for every edit reducer, Admin edits of a closed game; `confirm_match_scores`, `submit_match_result` and `MatchResultRecord.blueConfirmed/redConfirmed` removed. Rules section "Game Confirmation, Close and Series Submission" and scenarios "Both Captains Confirm a Bo1" … "An Admin Edit That Would Undo the Series Is Rejected" added; the `confirm_match_scores` / `submit_match_result` reducer sections and the S7 override scenarios describe the removed path | 2026-11-07 |
| Phase S7b follow-up (DECISIONS.md A63) | `confirm_game` sets only the captain's ready flag (never closes; full-control referee shortcut removed); `close_game` is the explicit submit: either captain once both flags are set, or the staff set at any time; only staff may pass `winnerOverride`. Scenario "Both Captains Ready, a Captain Submits the Game" added; "Both Captains Confirm a Bo1", "A Bo3 Game 1 Close Moves to BetweenGames" and "A Tie Stays Open Until a Staff Close" marked superseded | 2026-11-07 |

---

*Last updated: 2026-11-06*
*Feature owner: Phase 7 / Phase 12.3*
