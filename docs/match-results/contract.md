# Match Results

**Architecture:** [architecture.md](architecture.md)

## Feature Overview

Match results manage the full lifecycle of determining a match outcome: per-game score entry, captain confirmation, referee submission, dispute handling, and finalization that writes stats and MMR. Casual matches auto-validate on submit and auto-finalize inline. Ranked matches go through a two-step flow: submission by referee puts the result in Submitted status; a moderator, referee, or tournament organizer then validates it. Admin tools handle exceptional cases: force-finalization of stuck matches, voiding matches without stats, setting bracket winners post-rollback, and overriding disputed results.

## Reducers

### record_game_scores

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
4. Liveness guard: `ensureMatchAlive` — blocks scoring after concede
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
4. Liveness guard: block after concede
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
4. Liveness guard: block after concede
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

## Phase 12.3: accountRatingSnapshot lifecycle

### Capture (MMR-RACE-01)

At `start_draft` time, when `MatchResultParticipant` rows are inserted, the reducer
resolves each player's `LobbyMemberAccount` rows for `(lobbyId, userId)`, reads
`HsrAccount.accountRating` for each selected account, and writes
`max(accountRatings)` to `MatchResultParticipant.accountRatingSnapshot`. For casual
matches with zero `LobbyMemberAccount` rows the snapshot defaults to `0`.

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
`accountRatingSnapshot` is extended to `max(existing, newAccount.accountRating)`.
`deselect_match_account` does NOT run the hook — removing from selection can never
lower the max. The hook short-circuits when no MRP row exists (stand-ins joining
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

---

*Last updated: 2026-04-12*
*Feature owner: Phase 7 / Phase 12.3*
