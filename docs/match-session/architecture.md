# Match Session -- Architecture

Last updated: 2026-11-06

## Overview

Match sessions manage the real-time draft and game flow within a lobby. A `MatchSession` row is created when a draft starts and acts as the authoritative clock and stage state for that match. `MatchSessionStep` rows record every draft action (picks, bans, coin flips, etc.) as an append-only event log. At the end of a match, `run_finalization` snapshots all session data into history tables (`MatchSessionHistory`, `MatchSessionStepHistory`, `MatchParticipantHistory`) and hard-deletes the ephemeral rows. The timer model uses server-side `timerStartedAt` and `timerDurationSeconds`; pausing accumulates elapsed ms in `timerResumedOffset`. Both Classic and Auction draft modes share the same step infrastructure, differentiated by `stepType`.

## Table Relationships

```
Lobby (id: u32 autoInc PK)
  +-- MatchSession (lobbyId: u32 PK -- same as Lobby.id)  [public: true]
  |     lobbyId -> Lobby.id
  |     stage: lives on Lobby.stage (Waiting | Drafting | Equipping | Scoring | AwaitingResult; A67(1): one game per lobby)
  |     (A67(3), S8e: no series columns: seriesBestOf / gamesWonBlue / gamesWonRed / currentGameNumber removed)
  |     currentTurnUserId: u32? -> User.id
  |     timerStartedAt: Timestamp?
  |     timerDurationSeconds: u32
  |     timerPausedAt: Timestamp?
  |     timerResumedOffset: u64 (accumulated elapsed ms before last resume)
  |     blueScore: u8
  |     redScore: u8
  |     currentGame: u8
  |     draftPhase: u8 (which segment of the pick/ban order)
  |     draftTurnIndex: u8 (position within current draftPhase)
  |     auctionBudgets: AuctionBudgetMap (per-user remaining auction budget, serialized)
  |     audit columns
  |
  +-- MatchSessionStep (id: u32 autoInc PK)  [public: true]
  |     lobbyId -> Lobby.id  [btree: lobby_id]
  |     stepType: MatchStepType (Pick | Ban | CoinFlip | AuctionBid | AuctionWin | SystemEvent)
  |     actorUserId: u32 -> User.id (0=anonymous sentinel)
  |     targetCharacterName: string? -> HsrCharacter.name
  |     targetLightconeName: string? -> HsrLightcone.name
  |     teamSide: TeamSide?
  |     bidAmount: u32? (Auction mode only)
  |     payload: string? (JSON -- extra context for system events)
  |     audit columns
  |     Indexes: lobby_id (btree)
  |
  +-- MatchParticipantHistory (PK: [matchResultId, userId])  [public: true]
  |     matchResultId -> MatchResultRecord.id  [btree: match_result_id]
  |     userId -> User.id
  |     teamSide: TeamSide
  |     charactersPicked: string[]
  |     lightconesPicked: string[]
  |     finalTeamScore: u8
  |     isWinner: bool
  |     audit columns
  |
  +-- MatchSessionHistory (matchResultId: u32 PK)  [public: true]
  |     matchResultId -> MatchResultRecord.id
  |     lobbyId: u32 (original lobby, preserved for reference)
  |     gameMode: GameMode
  |     draftMode: DraftMode
  |     teamSize: u8
  |     blueScore: u8
  |     redScore: u8
  |     audit columns
  |
  +-- MatchSessionStepHistory (id: u32 autoInc PK)  [public: true]
        matchResultId -> MatchResultRecord.id  [btree: match_result_id]
        stepType: MatchStepType
        actorUserId: u32
        targetCharacterName: string?
        targetLightconeName: string?
        teamSide: TeamSide?
        bidAmount: u32?
        payload: string?
        audit columns
        Indexes: match_result_id (btree)
```

## Reducer Flows

### initialize_match_session(lobbyId)
1. Called internally when `start_draft` transitions lobby to Drafting
2. Insert `MatchSession` row with `stage=Drafting`, `currentGame=1`, `draftPhase=0`, `draftTurnIndex=0`
3. Set `timerStartedAt=ctx.timestamp`, `timerDurationSeconds` from Lobby setting
4. Compute initial turn order from coin flip result; set `currentTurnUserId`

### flip_coin(lobbyId)
1. `getAuthenticatedUser(ctx)` -- caller must be in lobby
2. Lobby must be in Waiting stage (pre-draft coin flip)
3. Deterministic coin flip: `(lobbyId * 31 + ctx.timestamp.micros) % 2` -- no Math.random()
4. Insert `MatchSessionStep` with `stepType=CoinFlip`, result encoded in `payload`
5. Record which team picks first; stored on `MatchSession` for turn order computation

### submit_draft_action(lobbyId, stepType, characterName?, lightconeName?, bidAmount?)
1. `getAuthenticatedUser(ctx)`
2. Find `MatchSession` -- verify `stage=Drafting`
3. Verify `currentTurnUserId === caller.id` (it is caller's turn)
4. Timer check: if timer expired (elapsed > `timerDurationSeconds * 1000 - timerResumedOffset`): auto-pick or skip
5. Classic mode:
   - Validate `stepType` is `Pick` or `Ban`
   - Validate `characterName` is not already picked/banned in this lobby
   - Validate ownership if `requireOwnership=true`: character must be in caller's `HsrAccountCharacter`
   - Insert `MatchSessionStep`
   - Advance draft: increment `draftTurnIndex`; advance `draftPhase` and flip team at phase boundaries
6. Auction mode:
   - `stepType=AuctionBid`: validate bid <= caller's remaining budget in `auctionBudgets`
   - `stepType=AuctionWin`: resolve auction; deduct winning bid; assign character
   - Insert `MatchSessionStep`
7. Update `MatchSession`: new `currentTurnUserId`, `draftPhase`, `draftTurnIndex`
8. If draft complete: transition `MatchSession.stage=Equipping`; transition `Lobby.stage=Equipping`

### submit_equip_action(lobbyId, characterName, lightconeName)
1. `getAuthenticatedUser(ctx)` -- verify caller is in lobby (Equipping stage)
2. Find `MatchSession` -- verify `stage=Equipping`
3. Validate `lightconeName` path matches `characterName` path (must be same Path enum)
4. Validate lightcone ownership if `requireOwnership=true`
5. Insert `MatchSessionStep` with `stepType=Pick`, `targetCharacterName`, `targetLightconeName`
6. Check if all players have equipped all characters; if so: transition stage to Scoring
7. Update `MatchSession.stage=Scoring`; update `Lobby.stage=Scoring`

### pause_timer(lobbyId) / resume_timer(lobbyId)
1. Permission: host OR referee (if `refereeControlsShelving=true`) OR TO/Mod+
2. `pause_timer`: verify timer running (`timerPausedAt=null`); set `timerPausedAt=ctx.timestamp`
3. `resume_timer`: compute elapsed since pause; add to `timerResumedOffset`; clear `timerPausedAt`; set `timerStartedAt=ctx.timestamp`

### advance_stage(lobbyId, targetStage)
1. Permission: host OR referee OR TO/Mod+ _Superseded in Phase S10b execution (DECISIONS.md A80)._
2. Validate stage transition is legal from current `MatchSession.stage`
3. Insert system `MatchSessionStep` with `stepType=SystemEvent`, payload indicating stage change
4. Update `MatchSession.stage` and `Lobby.stage`

### Series reducers (removed in S8e, A67(1))
`advance_to_next_game`, `shelve_series` and `resume_series` are deleted with `reducers/seriesManagement.ts`: a lobby
hosts one game, the bracket match is the only series (`docs/brackets/architecture.md`).

### Finalization snapshot (called from run_finalization)
1. Insert `MatchSessionHistory` row from `MatchSession` fields
2. Copy all `MatchSessionStep` rows to `MatchSessionStepHistory` (swap `lobbyId` for `matchResultId`)
3. Insert `MatchParticipantHistory` rows from `MatchResultParticipant` rows
4. Delete all `MatchSessionStep` rows for this lobby (via `lobby_id` index)
5. Delete `MatchSession` row for this lobby

### Phase 12.3: timer_expiry_classic auto-pick pool migration

**D-I-01/02**: When `autoRandomPick=true` on a Classic draft Pick turn and the timer
expires, the auto-pick character pool was previously built by reading
`HsrAccount` filtered by `isActive=true` for each acting team member (the global
active account). Phase 12.3 migrated this read to `LobbyMemberAccount` rows for
`(lobbyId, userId)` — the per-match selected accounts.

**Why this matters**: Phase 10.4 introduced per-match account selection
(`LobbyMemberAccount`). After that change, a player's globally active account
(`HsrAccount.isActive=true`) can legitimately differ from their match-selected
account. Using the old path meant timer expiry auto-picks would sample the wrong
character pool — the pool from the globally active account rather than the accounts
the player brought into this specific match.

**Post-migration behavior**: Timer expiry builds the owned-character union across
all `LobbyMemberAccount` rows for the acting team's members, matching the pattern
used by `ownershipValidation.ts` (real-time pick ownership checks) and
`start_draft`'s `autoRandomPick` pre-validation gate (lines 76-96). This closes
the last in-gameplay runtime read of `HsrAccount.isActive`.

**Scope**: The migration applies only to the `requireOwnership=true` path. When
`requireOwnership=false`, the pool comes from the cost table for the game mode
(no account read needed), which was unchanged.

### Phase 15.4: draftMode-aware reads + postDraft gameNumber stamping

Two code-review follow-ups from the Phase 15.4 restructure (`draftMode: DraftMode`
column added to all cost tables) touch this feature's reducers:

**WR-02 — `timer_expiry_classic` autoRandomPick pool filters `draftMode='Classic'`**
(`draftClassic.ts:694-703` + `:749-757`)

When `autoRandomPick=true` fires on a Classic-mode pick or ban timer expiry, the
available-pool build now filters cost rows by `r.draftMode.tag === 'Classic'` in
addition to `r.gameMode.tag === lobby.gameMode.tag`. Without this filter, a
character whose cost set only has an Auction row (no Classic row, per the D-10
row-absence rule) could be auto-picked in Classic mode with `costPaid: 0`, which
doesn't reflect "not configured for Classic" — it actively breaks the invariant.
Pattern matches the `draftMode` filter already present in the normal
`pick_character` cost lookup at `draftClassic.ts:361-367`.

**WR-04 — postDraft step inserts stamp `gameNumber`**
(`postDraft.ts` — `equip_lightcone`, `arrange_lineup`, `confirm_lineup`)

Every `MatchSessionStep.insert` across `draftClassic.ts`, `draftAuction.ts`,
`draftControl.ts` (Undo + Pause steps), `postDraft.ts` (equip / arrange /
confirm), and `index.ts` (clientConnected reconnect audit) writes
`gameNumber: session.currentGameNumber`. Prior to Phase 15.3 Cluster G and
Plan 10, three draft-family sites (draftControl L60 + L176, index.ts L215)
and the three postDraft sites omitted this field; the `as any` cast silenced
the TypeScript error and SpacetimeDB defaulted the u8 to 0. No in-game
reducer re-reads postDraft steps by `gameNumber`, so this was
not a runtime correctness bug. The impact surfaces at **archival**: when the
series finalizes and steps flow into `MatchSessionStepHistory` (whose PK is
`[matchHistoryId, gameNumber, sequence]`), draft steps carried their correct
game number while equip/arrange/confirm steps collapsed to `gameNumber=0`,
leaving them dangling relative to their actual game in any per-game replay
query. Cosmetic for `bestOf=1`, genuine inconsistency for `bestOf>1` archives.

`arrange_lineup` and `confirm_lineup` also gained a `MatchSession` lookup +
`SenderError('Match session not found.')` guard at reducer entry, matching the
pattern already present in `equip_lightcone`.

### Phase S4 execution: paused-draft guards, step sequences, undo, auto-pause source

Decisions: DECISIONS.md A22(3), A22(4), A22a; bug review F3, F5, F8, F9.

**Paused draft (A22(3), F3).** `pick_character`, `ban_character`, `nominate_character`, `place_bid`, `pass_bid`, `timer_expiry_classic` and `timer_expiry_auction` throw `SenderError('Draft is paused.')` while `MatchSession.timerState.isPaused`. The two `timer_expiry_*` reducers also call `ensureLobbyMember` (F3): a non-member can no longer burn a paused team's turns.

**Step sequences (F9).** Every `MatchSessionStep` writer takes `sequence` from `helpers/draft/stepSequence.ts::getNextSequence(ctx, lobbyId)` (max existing sequence in the lobby + 1, 0 for the first step): Classic Pick/Ban (`draftClassic.ts`, including the timer-expiry auto-steps), every auction step (`draftAuction.ts`), the manual Pause (`pause_draft`), the auto-Pause (`run_referee_transfer_check`) and the Undo record (`undo_last_step`). `MatchSession.turnIndex` is Classic turn progress, not a sequence number, so Pause/Undo rows never collide with a draft step and the history key `[matchHistoryId, gameNumber, sequence]` stays unique. `postDraft.ts` already computed max + 1 inline (unchanged). Until the first pause or undo the Classic sequences still equal 0, 1, 2, ... as before.

**undo_last_step (F9).** *Superseded by Phase S10t execution (A127): undo removes the last draft step of any kind; see that section.* Rejects while paused ("Nothing to undo right now.") and during the auction phase ("Undo is not available during the auction phase."; Phase S10r execution, A122(9): only once a nomination exists, see "Phase S10r execution"; Phase S10s execution, A125: only once a bid or a sale exists, a first undo cancelling an open nomination, see "Phase S10s execution"). It deletes the highest-sequence **Pick or Ban** step (never a Pause / Undo row), inserts the Undo record with `originalSequenceId = <deleted step's sequence>` and its own sequence, and decrements `turnIndex`. The old "undo crosses back out of the auction phase" branch is gone: unreachable under the auction-phase rejection.

**Auto-pause (A22a, F5).** The disconnect hook no longer pauses. `run_referee_transfer_check` (`reducers/lobby/refereeTransfer.ts`, bound with `onSchedule`) fires 15 s after a user's last device disconnected and inserts the auto-Pause step (`actorUserId = 0`, `isAutoPause = true`, `timeRemainingMs` computed like `pause_draft`) and sets `timerState.isPaused` only when `decideAutoPause` (`shared/lobby-rules`) says so: the subject is still offline, a team player (not a spectator, coach or spectator-referee), the lobby is Drafting under Standard/Deferred and the draft is not already paused. `join_lobby`'s auto-resume on reconnect is unchanged. Details: `docs/lobby/architecture.md`.
Phase S8f execution (A68(1)(2)(3)): a player's Leave in a live stage is a disconnect (row kept away with `leftAt`, clock stamped, the same 15 s check, so it auto-pauses a Drafting lobby like a disconnect); an away row counts as offline for the check and for `isForfeitEligible` whatever the presence rows say; no reducer concedes automatically.

**Result reducers (A22(4), F8).** `ensureMatchAlive` stays on the draft/equip reducers; `confirm_match_scores`, `submit_match_result` and `record_game_scores` use `ensureNotConceded` (`helpers/lobby/disconnectHelpers.ts`), which rejects a conceded record or a Finished lobby but allows AwaitingResult, where `advance_stage` parks the lobby after Scoring (`docs/match-results/contract.md`).

### Phase S6 execution: initSessionForGame, head start, Ban Restriction, merged snapshot
- **F2 (BACKEND-BUGS):** `initSessionForGame(ctx, lobby, session?, actorId)` (helpers/matchSessionInit.ts) is the one writer of a game's draft state: the sequence (`buildClassicSequence` / `buildAuctionBanSequence` from `lobby.banMode`), `turnIndex = 0`, `isAuctionPhase` (Auction with an empty ban sequence), `nextNominatorTeam = Blue`, `currentBidTeam = Spectator`, no nomination / bid, characters won 0, both budgets from the lobby, a fresh `timerState` (reserve banks from `reserveBankSeconds`, not paused), pause counters 0. `start_draft` calls it without a session (inserts the row with `currentGameNumber = 1`, `seriesBestOf = lobby.bestOf`); `advance_to_next_game` calls it with the session (keeps `gamesWonBlue` / `gamesWonRed` and `seriesBestOf`, `currentGameNumber + 1`) after deleting the previous game's steps, so game 2 of a Bo3 can be drafted in Classic and Auction.
- **A27 head start:** on insert, `gamesWonBlue = 1` when `lobby.bestOfNAdvantage = Blue`, `gamesWonRed = 1` when Red (0 or 1 under the {1, 3} cap). `advance_stage` (Scoring → BetweenGames / AwaitingResult) recounts wins from `MatchResultGame` and now adds the head start back, so it survives the recount. Tournament lobbies get their side from the bracket in S8.
- **A45(2) Ban Restriction:** `banRestrictionError(ctx, lobby, team, characterName)` (helpers/lobby/banRestriction.ts) counts the team's Ban steps of the current game by `HsrCharacter.role` (SKIP / EMPTY / unknown names carry no role). `ban_character` rejects with the rule's message; the `timer_expiry_classic` auto-ban pool (autoRandomPick) keeps only characters the acting team may still ban and records SKIP when none is left (unchanged sentinel). Applies to both draft modes (Auction bans go through the same reducers).
- **Backlog #10 merged snapshot:** `start_draft` sets `MatchResultParticipant.accountRatingSnapshot = computeLobbyMemberRating(lobbyId, userId)`: one selected account → its stored `HsrAccount.accountRating`; several → `computeMergedAccountRating` over the union of their rosters (per character the max eidolon). Replaces the MAX rule. The `select_match_account` ratchet stays monotonic-upward (**superseded, A69(3):** the ratchet is gone; the snapshot is taken once at `start_draft`).

### Phase S7 execution: lineup groups, eidolon snapshot, format-driven count
Behavior: [contract.md](contract.md) "Lineup Groups (Phase S7 execution)" and following. Formula and scoring tables: `docs/match-results/architecture.md` "Scoring (S7)".
- **`MatchLineup`** (S3 table, private; `id` PK autoInc, `by_lobby_game` (lobbyId, gameNumber)): one live row per team per game. `arrange_lineup(lobbyId: u32, teamSide: TeamSide, groups: string)` (`reducers/draft/postDraft.ts`): Equipping, `ensureMatchAlive`, caller = captain of that team (player seat) or any referee (`ensureCaptainOrReferee`, `helpers/results/scoringHelpers.ts`); throttle `AbuseConfig.lineupMinIntervalMs` against `LobbyMember.lastLineupAt` (delete + insert without audit bump, like `lastCursorAt`); `groups` JSON `string[][]` ≤ 2000 characters, validated by `lineupError` against the team's drafted characters of the current game (`teamDraft`: Pick steps by `actorSlot`, AuctionSold by `winningTeam`); upsert with `synergySurcharge` and the live `rosterCost` (`lineupCosts`, clamped ≥ 0 for the u32 columns), `isConfirmed = false`. No step and no `Lobby.lastActivityAt` write on arrange (fan-out egress). `confirm_lineup(lobbyId: u32, teamSide: TeamSide)`: same callers; recomputes surcharge and cost; Auction rejects `surcharge > toHundredths(team LC budget)`; sets `isConfirmed`, stores the final `rosterCost`, inserts the `ConfirmLineup` step (`ConfirmLineupPayload { confirmed, groups }`, `groups` added in S7; `actorSlot` = the lineup's team) and bumps `lastActivityAt`. `HsrSynergyCost` rows are read for `(lobby.costSetId, gameMode, draftMode)`, `costModifier` → hundredths.
- **Roster cost (A21):** Σ `toHundredths(Pick.costPaid)` (Classic: the cost at the pick's eidolon) or `AuctionSold.winningAmount` (Auction: the budget spent) + Σ `EquipLightcone.costPaid` + the surcharge. Tie-break 1 and the handicaps always use the live value (steps + current groups), confirmed or not. `equip_lightcone` refreshes the side's lineup row (`refreshLineupCosts`, confirmation kept) and, in Auction, rejects a light cone when its cost plus a confirmed lineup's surcharge exceeds the LC budget (the surcharge is reserved, not debited). Review fix, Phase S7 execution. A net-negative pair modifier is ignored (the surcharge is clamped at 0 before it is summed).
- **Eidolon snapshot (A43 CH-S6, D.8.7):** `resolveOwnedEidolon(ctx, lobbyId, userId, characterName)` (`helpers/draft/ownershipValidation.ts`) = max `HsrAccountCharacter.eidolonLevel` over the caller's `LobbyMemberAccount` rows, 0 when none has it. `pick_character` and `nominate_character` use it instead of the argument when `lobby.requireOwnership`; the cost lookup and the payload use the resolved value. `equip_lightcone` keeps its argument (no light-cone ownership data).
- **Format-driven count (A21):** `buildClassicSequence(banMode, lineupFormat)` appends 8 picks (R-B-B-R-R-B-B-R) for Thirds (12 picks per team); `buildAuctionBanSequence` is unchanged (bans only); `isAuctionComplete(session, lobby)` uses `charactersPerTeam(lineupFormat)` (8 / 12). `initSessionForGame` passes `lobby.lineupFormat`. (Thirds order superseded, Phase S7b execution: see "Phase S7b execution: game package edits, Auction eidolon economics, Thirds orders" below and [draft-order.md](draft-order.md) "Thirds (12 picks per team)".)
- **Lifecycle (A56):** lineups are archived to `MatchLineupHistory` by `runFinalization` and deleted with the record there and in `hardDeleteLobby`; `server_nuke_test_data` clears `MatchLineup` and `MatchLineupHistory`.

### Phase S7b execution: game package edits, Auction eidolon economics, Thirds orders (A59, A60, A61)
Behavior: [contract.md](contract.md) scenarios tagged "Phase S7b execution". Confirmation, close and series submission: `docs/match-results/architecture.md` "Phase S7b execution".
- **Removed (A60(8)):** `confirm_lineup`, `MatchLineup.isConfirmed`, the `ConfirmLineup` step kind (`ActionType` / `StepPayload` / `ConfirmLineupPayload`), the S7 surcharge reservation in `equip_lightcone`, the Scoring branch of `advance_stage`. Replaced by the per-game confirmation on `MatchResultGame` (`confirm_game`, `close_game`).
- **Edit window (`resolveEditWindow`, `reducers/draft/postDraft.ts`):** (S8e fix pass 2, A69(2): the window ends at validation; the fall-through's status rejections come from `ensureEditableRecord`: `'No pending match result for this lobby.'` (no record), `'This game is closed.'` (Submitted record, caller not an Admin), `'This game can no longer be edited here; corrections go through override_match_result.'` (Validated, Finalized, Disputed, Rejected, Voided: everyone, Admins included); see `docs/match-results/architecture.md` "Phase S8e execution".) reads the session and the lobby's record (Pending; for role Admin also Submitted). If the current game's `MatchResultGame` row is closed, `ensureOpenGame` (`helpers/results/scoringHelpers.ts`) rejects everyone but an Admin (`'This game is closed.'`) and the Admin path runs with `ensureNotConceded` only (no stage check, no throttle, confirmations untouched, `recomputeSeriesAfterAdminEdit` at the end, A60(7)). Otherwise `ensureStageIs(stages)` + `ensureMatchAlive` + a Pending record; after the edit the game is recomputed (if its row exists) and `resetConfirmations(ctx, game, actorId)` clears both flags (A60(2)).
- **`equip_lightcone(lobbyId, characterName, lightconeName, superimposition)`:** stages Equipping, Scoring. Callers unchanged (non-coach team member). Strict `lcCost > currentLcBudget` reject kept; the step, `refreshLineupCosts`, the budget debit, then recompute + reset. Admin path: the team is the one whose draft of the current game holds `characterName`. _Superseded in Phase S10b execution (DECISIONS.md A78)._
- **`arrange_lineup(lobbyId, teamSide, groups)`:** stages Equipping, Scoring; callers unchanged (captain of that side or any referee); throttled (open path only); upsert without a confirmation column; recompute + reset.
- **`set_eidolon(lobbyId: u32, teamSide: TeamSide, characterName: string, eidolon: u8)`** (new): stages Drafting, Equipping, Scoring; `ensureMatchAlive`; callers: a player seat of that team (not coach, not spectator) or any lobby referee (`ensureEidolonEditor`); throttled through `AbuseConfig.lineupMinIntervalMs` / `LobbyMember.lastLineupAt` like `arrange_lineup`. The character must be in that team's draft of the current game (`teamDraft`: Classic Pick by that side, Auction AuctionSold to that side); `EMPTY` rejected; 0..6; the same level as the current one is rejected. Under `requireOwnership` the level must be in `teamOwnedEidolons(ctx, lobbyId, side, characterName)` (`helpers/draft/ownershipValidation.ts`: distinct `HsrAccountCharacter.eidolonLevel` over the `LobbyMemberAccount` rows of the team's player seats). Classic: `costPaid` = the Classic cost row at the new level (0 without a row), no budget. Auction: `costPaid` = `auctionEidolonExtra(new)`; `delta = extra(new) − extra(current)`; `delta > 0` → `chargeExtra` (character budget first, rest from the light-cone budget; rejected `'Not enough budget for that eidolon.'` when `delta > char + lc`); `delta < 0` → refunded to the light-cone budget in every stage (S7b orchestrator rule: a refund never restores bidding power). Logs a `SetEidolon` step (`actorSlot` = the team), `refreshLineupCosts`, recompute + reset (open) or the Admin series recompute. _Superseded in Phase S10b execution (DECISIONS.md A78)._
- **`teamDraft` (A60(1), A61(7)):** the latest `SetEidolon` step per character of that side and game (highest `sequence`; for Classic only an edit after the pick counts, so an undone pick's edits are ignored) sets the eidolon (tie-break 3) and the cost: Classic = `SetEidolon.costPaid` else `Pick.costPaid`; Auction = `AuctionSold.winningAmount` + (`SetEidolon.costPaid` else `AuctionSold.eidolonCost`), hundredths.
- **`advance_stage`:** Drafting → Equipping (D-50 rollover + chat; since Phase S10t, A129 / A130, through `finishDraft`, also reached by the confirm-window expiry) and Equipping → Scoring (host signal, no gate, A60(5)) unchanged; from Scoring it throws `'Games close through confirm_game or close_game; the stage moves on the close.'`. _Superseded in Phase S10b execution (DECISIONS.md A80)._
- **Auction (A61, `reducers/draft/draftAuction.ts`):** `nominate_character(lobbyId, characterName)` (the `eidolon` argument is gone): base cost = the Auction cost row's `e0` (`getCharacterBaseCost`); under `requireOwnership` the nominating team must own the character on a selected account (`'Your team does not own this character on any selected account.'`, `EMPTY` exempt); guard `baseCost ≤ charBudget` (D-53) **and** `baseCost + extra(teamDefaultEidolon) ≤ charBudget + lcBudget` (`'Not enough total budget: the eidolon extra for this character would exceed it.'`). `place_bid(lobbyId, bidAmount)`: the same ownership check and total guard for the bidding team, bids still capped by the character budget. Helpers: `auctionCostAt`, `auctionEidolonExtra = max(0, cost[e] − cost[e0])`, `teamDefaultEidolon` (lowest owned level under ownership, A64(1) amending A61(3); else 0), `chargeExtra(session, side, extra)` (character budget first, floor 0; the light-cone remainder clamped at 0 with a log line). **Sale** (A61(3), A64: the default eidolon is the lowest owned level; higher owned levels are bought later through `set_eidolon`) (`resolveSale`, both `pass_bid` and the bidding branch of `timer_expiry_auction`): the winning team's default eidolon and extra are resolved at the sale (never from the Nominate step); `winningAmount` comes out of the character budget, then `chargeExtra`; the D-50 rollover at auction completion carries the non-negative leftovers. Payloads: `NominatePayload { characterName }`, `AuctionSoldPayload { characterName, winningAmount, winningTeam, eidolon, eidolonCost }`.
- **Step kinds:** `SetEidolon` (`SetEidolonPayload { characterName, eidolon, previousEidolon, costPaid }`, `costPaid` in the mode's terms) and `ConfirmGame` (`ConfirmGamePayload { confirmedSide, closed, winnerOverride?, winnerOverrideReason? }`). `MatchSessionStepHistory.targetName` = the character for `SetEidolon`, none for `ConfirmGame`; the character-stats pass of `runFinalization` ignores both.
- **Review fixes (Phase S7b execution, A61(4)/(5), A22(3)):** in Auction Drafting, while the team holds the current bid, `set_eidolon` treats the bid plus the extra the team would owe at the sale (`teamDefaultEidolon`) as reserved: a positive delta above (char + LC budget) − (bid + extra) is rejected (`'Not enough budget for that eidolon: your current bid is reserved.'`) and the character budget is charged only above the committed bid (the rest from the light-cone budget). `resolveSale` rejects a winning amount above the winner's character budget (`'Winning amount exceeds the <side> character budget.'`) instead of clamping. `set_eidolon` is rejected with `'Draft is paused.'` in a paused Drafting stage (open path; the reconnect auto-resume reads the last step for an auto-pause).
- **Thirds orders (A59):** `buildClassicSequence(banMode, 'Thirds')` returns the per-ban-mode order from `THIRDS_ORDERS` (`helpers/draft/draftSequences.ts`); `THIRDS_EXTRA_PICKS` is gone. The three orders: [draft-order.md](draft-order.md) "Thirds (12 picks per team)". Halves and `buildAuctionBanSequence` unchanged.

## Phase S8d execution (DECISIONS.md A65; S7b hand-offs)

**Step table lifecycle (A65).** `MatchSessionStep` rows of every game of a series stay in the live table until the
match ends: `advance_to_next_game` no longer deletes them. Exits: finalization archives every game into
`MatchSessionStepHistory` (`[matchHistoryId, gameNumber, sequence]`; step 4 sorts by (gameNumber, sequence), step 8
copies `step.gameNumber`) and then deletes the live rows; the lobby GC / `hardDeleteLobby` deletes them on the other
exits. Sequences stay lobby-wide (`getNextSequence`; game 2 continues after game 1's last sequence).

**Game-scoped readers** go through `currentGameSteps(ctx, lobbyId, gameNumber)` (`helpers/draft/stepSequence.ts`): the
ban restriction, Classic availability / auto-random pick, the Auction won / banned sets and the nomination lookup,
`undo_last_step` ("Nothing to undo in this game." when the current game has no Pick / Ban; it never crosses into an
earlier game; _superseded in Phase S10t execution (A127): the text is gone, "No steps to undo." when no character step is left_), `resume_draft` (latest Pause), the join auto-resume (latest Pause of the current game), `teamDraft`
(tie-breaks, lineups, edits). Lobby-wide: `getNextSequence`, the user-deletion guard, the lobby GC, the finalization
read. `view_my_match_steps` rows carry `gameNumber`.

**unequip_lightcone(lobbyId, characterName, gameNumber?)** (new). Same callers and window as `equip_lightcone`. _Superseded in Phase S10b execution (DECISIONS.md A78)._
Removes the latest light cone still equipped on the character for the side; refunds its `costPaid` to the side's
light-cone budget (current game only); logs `UnequipLightcone` (`UnequipLightconePayload { characterName,
lightconeName, refunded }`, new `ActionType` / `StepPayload` member); refreshes the lineup costs; recomputes and resets
confirmations (A60(2)). `teamDraft.lightconeCosts` = the light cones still equipped (`equippedLightcones`).
`MatchSessionStepHistory.targetName` = the light cone. "X has no light cone equipped." when none.

**equip_lightcone** (S7b hand-off): on the open path the character must be in the caller's team draft of the game _Superseded in Phase S10b execution (DECISIONS.md A78)._
("X is not in your team's draft of this game."); the sequence comes from `getNextSequence`.

**Earlier-game Admin edits (A65(4)).** `set_eidolon`, `equip_lightcone`, `unequip_lightcone`, `arrange_lineup`
take an optional trailing `gameNumber`; `resolveEditWindow` applies it (Admin only, an earlier closed game;
"Only an Admin may edit an earlier game." / "Only a closed earlier game of the series can be edited."). Such an edit
records its step (or lineup row) on that game and recomputes it; it does not charge or refund a session budget.
**Superseded by S8e (A67(3)):** see below.

## Phase S8e execution (DECISIONS.md A67(1)(3); supersedes A65)

- **One session per lobby.** `start_draft` inserts the `MatchSession` once with the draft sequence
  (`buildClassicSequence(banMode, lineupFormat)` / `buildAuctionBanSequence(banMode)`), turn index 0, timers, auction
  state, both budgets and pause counters (the S6 `initSessionForGame` helper and `helpers/matchSessionInit.ts` are
  folded in and deleted). No series columns, no A27 head-start seeding (the head start lives on the bracket match).
- **Steps without game numbers.** `MatchSessionStep` and `MatchSessionStepHistory` lose `gameNumber`; the history key
  is `[matchHistoryId, sequence]`. `helpers/draft/stepSequence.ts`: `getNextSequence(ctx, lobbyId)` unchanged;
  `currentGameSteps` is replaced by `lobbySteps(ctx, lobbyId)` (every live step of the lobby), read by the ban
  restriction, Classic / Auction draft state, `undo_last_step`, `resume_draft`, the join auto-resume, `teamDraft`,
  `equippedLightcones`. Finalization sorts the steps by `sequence` and archives them. `view_my_match_steps` rows have
  no `gameNumber`.
- **Edit reducers.** `set_eidolon(lobbyId, teamSide, characterName, eidolon)`, `equip_lightcone(lobbyId,
  characterName, lightconeName, superimposition)`, `unequip_lightcone(lobbyId, characterName)`,
  `arrange_lineup(lobbyId, teamSide, groups)`: the optional trailing `gameNumber` is gone. `resolveEditWindow` returns
  `{ mode, session, record }`: 'admin' when the record's game is closed and the caller is an Admin (record Pending or
  Submitted, A60(7)); otherwise the open-game rules. A69(2) (fix pass 2): a record past Submitted (Validated and
  beyond) is not editable by anyone, Admins included (`'This game can no longer be edited here; corrections go through
  override_match_result.'`); a player on a Submitted record gets `'This game is closed.'`. Every edit, the Admin one included, charges / refunds the
  session budgets as before (the S8d earlier-game budget asymmetry is gone).
- **MatchLineup** loses `gameNumber`; index `by_lobby` (lobbyId) replaces `by_lobby_game`.
- **Removed:** the series reducers (above), `MatchSession.seriesBestOf` / `gamesWonBlue` / `gamesWonRed` /
  `currentGameNumber`, `initSessionForGame`, `currentGameSteps`.


## Phase S9a execution (DECISIONS.md A37, A40, A56, A60, A63; user 2026-11-07)

- `start_draft` no longer writes `MatchResultRecord.refereeFullControl` (column dropped; since A63 no reducer read it;
  the referee's live seat decides neutrality).
- New per-sender views (subscribed past Waiting, PAGE-MAP D3): `view_my_match_session` (the `MatchSession` row without
  audit columns, PK `lobbyId`), `view_my_lineups` (both teams' live `MatchLineup` rows with the game's
  `blueConfirmed` / `redConfirmed` / `closedAt`), `view_my_match_lineup_history` (replay, participated matches, A56(1);
  replaced in S10n by the per-match `view_my_match_history_lineups(matchHistoryId)`, DECISIONS.md A115).
  `view_my_match_steps` and `view_my_match_participants` mask user ids through `hideUserId`; the participant row adds
  `accountRatingSnapshot?` per A40. Catalogue: [../views/architecture.md](../views/architecture.md).

## Phase S10b execution (DECISIONS.md A78)

One caller rule for the game-package edits on the open game; supersedes the caller lines of the S7b / S8d / S8e entries
above for these reducers. The Admin path on a closed game (A60(7), A69(2)) is unchanged: no caller rule beyond the
Admin role, no throttle, no confirmation reset.

| Reducer | Signature | Caller (open path) | Throttle |
|---|---|---|---|
| `set_eidolon` | `(lobbyId, teamSide, characterName, eidolon)` | captain of `teamSide` or any lobby referee: `ensureCaptainOrReferee(ctx, lobbyId, userId, side, 'set an eidolon for that team')`; `ensureEidolonEditor` removed | lineup throttle (unchanged) |
| `equip_lightcone` | `(lobbyId, teamSide, characterName, lightconeName, superimposition)` (**new `teamSide`**, second) | same rule, `'equip lightcones'` | lineup throttle (**new**) |
| `unequip_lightcone` | `(lobbyId, teamSide, characterName)` (**new `teamSide`**, second) | same rule, `'unequip lightcones'` | lineup throttle (**new**) |
| `arrange_lineup` | `(lobbyId, teamSide, groups)` | same rule (unchanged) | lineup throttle (unchanged) |

- Caller rejection: `'Only the <side> captain or a referee can <what>.'` (`helpers/results/scoringHelpers.ts`). The check
  runs before the edit window for a non-Admin (as `arrange_lineup` did), so a non-captain, non-referee caller gets it
  before any stage / status rejection; a non-member gets it instead of `'You are not a member of this lobby.'`.
- `teamSide` goes through `ensureTeamTag` (`'teamSide must be Blue or Red.'`). The light-cone budget, the step's
  `actorSlot`, `refreshLineupCosts` and `equippedLightcones` all use that side (previously the caller's seat).
- Light cones: the character must be in that side's draft of the game on both paths (`ensureInTeamDraft`:
  `'<character> is not in the <side> team's draft of this game.'`). The Admin path's "first team whose draft holds the
  character" lookup (`lightconeEditSide`) and the `'Coaches cannot … lightcones.'` / `'Spectators cannot …
  lightcones.'` / `'… is not in your team's draft …'` / `'… is not in either team's draft …'` texts are gone.
- Throttle (B-4): `ensureLineupThrottle(member)` before the edit and `stampLineupThrottle` after it on the open path,
  against the caller's `LobbyMember.lastLineupAt` (`AbuseConfig.lineupMinIntervalMs`), shared by all four reducers.

## Phase S10b execution (DECISIONS.md A80)

`start_draft` (`reducers/draft/draftClassic.ts`) and `advance_stage` (`reducers/draft/postDraft.ts`) are referee powers:
`ensureRefereeOrAbove(ctx, lobby, user)` (`helpers/lobby/lobbyHelpers.ts`) replaces `ensureHostOrAbove` in both. The
caller's `LobbyMember` row in the lobby has `isReferee`, or the caller is Moderator+ (no membership needed); the host as
such no longer qualifies. Rejection: `'Only the referee, moderators, or admins can perform this action.'`. No lobby
setting gates it. Check order and everything else unchanged: `start_draft` checks the caller right after the lobby
lookup, before the Waiting check; `advance_stage` checks it before `ensureMatchAlive`; Equipping → Scoring is a referee
signal with no gate (A60(5)). `ensureHostOrAbove` keeps its other callers (`update_lobby_settings`, `set_team_slot`
on another seat, `shuffle_teams`, `close_lobby`). Tournament lobbies: `create_tournament_lobby` seats the creator with
`isReferee: true` (A34), so the creator starts and advances as before; no server-side path calls either reducer.

## Phase S10c execution (audit 2026-11-09; DECISIONS.md A81, A85)

Input bounds (audit draft slice, findings 1-3):

- `pick_character` (`reducers/draft/draftClassic.ts`): without `requireOwnership` (the argument is used) an `eidolon`
  above 6 is rejected with `'eidolon must be between 0 and 6.'` (the `set_eidolon` text). Under `requireOwnership` the
  argument is ignored as before (`resolveOwnedEidolon`).
- `equip_lightcone` (`reducers/draft/postDraft.ts`): `superimposition` outside 1..5 is rejected with
  `'superimposition must be between 1 and 5.'`, on the open path and on the Admin closed-game path (after the draft check).
- `place_bid` (`reducers/draft/draftAuction.ts`): a `bidAmount` that is not finite (`Number.isFinite`) or is negative is
  rejected first, before the caller lookup: `'bidAmount must be a finite, non-negative number.'`.

A81, a full team sits out of the Auction (`reducers/draft/draftAuction.ts`):

- `teamIsFull(session, lobby, side)` = the side's won count `>= charactersPerTeam(lineupFormat)`; `isAuctionComplete` =
  both sides full (unchanged meaning).
- `nominate_character` and `place_bid` reject a caller whose team is full: `'Your team already has all its characters.'`
  (after the spectator check, before the turn / holder checks).
- **Shared sale** `completeSale(ctx, lobby, session, { characterName, winningTeam, winningAmount, nominatingTeamTag,
  actorUserId, actorSlot, auditUserId })`: `resolveSale` (budgets, default eidolon, `chargeExtra`), the `AuctionSold`
  step, the won counts, the D-46 rotation, the end check with the D-50 rollover, the session and lobby writes. Used by
  `pass_bid`, the timer sale of `timer_expiry_auction` and the immediate sale below; their outputs are unchanged.
- **Rotation (A81(1)):** after the D-46 normal / steal rule, a next nominator that is full hands the turn to the other
  team (unless the auction just ended).
- **Immediate sale (A81(2)):** when the other team is full, `nominate_character` (after the unchanged budget checks:
  `baseCost <= charBudget`, `ensureTotalBudgetFits`) logs the `Nominate` step and sells at once to the nominating team at
  the base cost through `completeSale` (actor = the nominator); no bidding round, `currentNomination` never set.
- **Timer:** `timer_expiry_auction`'s nomination branch nominates `EMPTY` for `nextNominatorTeam`, or for the other team
  when that one is full (defensive; the rotation never leaves a full nominator); when the other team is full the
  `EMPTY` nomination sells at once at 0 (system actor `0`, `actorSlot` Spectator, as the timer sale).
- A team that cannot afford any base cost nominates `EMPTY` (cost 0, never exclusive) as before; while the other team
  is full each such nomination is an immediate 0-cost sale, so the team fills its remaining slots with `EMPTY`.

A85(2), `resume_draft` (`reducers/draft/draftControl.ts`): when the latest Pause step is an auto-pause
(`isAutoPause`), the referee or any seated player of either team (`isSeatedPlayer`: a Blue / Red player seat, not a
coach, not a spectator) whose row is not away or abandoned (`memberHasLeft`: `leftAt` / `abandonedAt` unset) may
resume; a seated player who left the room or abandoned the match for another lobby is rejected like the others (the
referee rule is unchanged). Others get `'Only the referee or a seated player can resume an auto-paused
draft.'`. A manual pause keeps D-62 (`'Only the referee or the player who paused can resume the draft.'`). The clock
math is unchanged (F10). The `join_lobby` auto-resume (A85(1)) is described in [../lobby/architecture.md](../lobby/architecture.md).

## Phase S10d execution (DECISIONS.md A86, A87, A92(1))

All in `reducers/draft/draftClassic.ts`:

- **Mirror picks once per team (A87).** `picksBlockingTeam(steps, lobby, team)`: without `allowMirrorPicks` every Pick
  of either team; with it, only the Picks whose `actorSlot` is that team (manual and timer picks both carry the team).
  `pick_character` rejects a character in that set: `'Character already picked.'` (no mirror, unchanged) or
  `'Your team already picked this character.'` (mirror). The timer auto-pick pool excludes the same set, so under
  mirror the other team's picks stay drawable. `EMPTY` is exempt: it is the no-pick placeholder, not a character, so it
  never enters the set, mirror on or off, and a team may hold any number of `EMPTY` picks, manual or by timer (this
  also lifts the older non-mirror block where one `EMPTY` of either team rejected every later manual `EMPTY`). Auction
  never applies mirror (D-42: sales are exclusive), so no Auction path changes.
- **Timer auto-pick priced like a pick (A86).** `classicPickCost(ctx, lobby, characterName, eidolon)` (0 for EMPTY,
  else `classicCostAt` in `helpers/draft/costSetGuards.ts`: the Classic cost row of the lobby's set and game mode,
  `costs['e' + eidolon]`, 0 without a row; `set_eidolon` uses the same helper) is shared by `pick_character` and
  `timer_expiry_classic`. The timer prices on the acting team (pool = union of the team's selected accounts, eidolon =
  the highest level any of its players owns), while `pick_character` prices on the caller: equal to a manual pick in
  1v1, and never cheaper than one in 2v2 and above (it can be dearer, or draw a character only a teammate owns).
  With `autoRandomPick` and a drawn character: eidolon 0 without `requireOwnership`; under it the highest level the acting team owns (`resolveOwnedEidolon` per non-coach player of the
  team, the maximum), and `costPaid` from that level. The pool: without ownership the Classic cost rows of the set and
  mode; under ownership the union of the acting team's selected accounts (D-I-01/02, unchanged); both minus bans and
  `picksBlockingTeam`. Classic has no budget check on picks, so "cannot afford" does not arise; a team that owns nothing
  pickable gets `EMPTY` at cost 0, as does a lobby without `autoRandomPick`.
- **`start_draft` (A92(1)).** After the confirmation check: `'All Blue and Red players must be online before
  starting.'` while `anySeatedPlayerAway(ctx, lobbyId)` (a seated player offline, away or abandoned).

## Phase S10e execution (lobby audit #9, #10, #6)

- **Seat-named rejections (A74(4) completed).** The three account / character rejections of `start_draft` name the seat,
  never a user id: "The player at seat N has no account selected for this match. ...", "The player at seat N has no
  account selected. autoRandomPick requires ...", "The player at seat N has no characters on their selected
  account(s). ...".
- **Team size.** After the one-player-per-team check: "{Blue|Red} team has N players; the team size is M." when a team
  seats more non-coach players than `lobby.teamSize` (an `update_lobby_settings` that lowered it after the seating).
- **Chat window.** "Draft has started!" is inserted after `trimChatForInsert` (D-13, `docs/chat/architecture.md`).
- **Offline host or referee (fix pass F2, A93(4)).** After the stage moves to Drafting, `start_draft` calls
  `scheduleChecksForOfflineStaff`: the host's row and the referee's row, when offline, away or abandoned, get the 15 s
  `RefereeTransferCheck` (a pending one is kept), so the host role and the flag move in the live stages as for a
  disconnect after the start (`docs/lobby/architecture.md`). No `disconnectedAt` stamp, no pause from `start_draft`.
- **Ownership pool and abandoned players (fix pass F3).** An abandoned player's `LobbyMemberAccount` rows stay, so
  `teamOwnedEidolons`, `resolveOwnedEidolon`, `teamDefaultEidolon` and the timer auto-pick pool still see the departed
  player's characters for the rest of the game (S10e's release of those rows is reverted).

## Phase S10f execution (draft audit #5, #8; BACKEND-BUGS F10; policy review G10)

- **Turn clock (F10).** One definition in `helpers/draft/turnClock.ts`, used by `pause_draft`, the disconnect auto-pause
  (`run_referee_transfer_check`), `resume_draft`, `liftAutoPauseOnReturn` (`join_lobby` reconnect and
  `client_connected`) and both `timer_expiry_*` reducers. The column `TimerState.accumulatedPauseMs` keeps its name and
  now holds the turn's **budget measured from `turnStartAt`** (0 = a full turn):
  - `budgetMs = accumulatedPauseMs > 0 ? accumulatedPauseMs : lobby.standardTurnSeconds * 1000`
  - `remainingMs = isPaused ? budgetMs : max(0, budgetMs - (now - turnStartAt))`
  - a new turn (start, pick, ban, nomination, bid, sale, undo) writes `turnStartAt = now`, `accumulatedPauseMs = 0`;
  - a pause (manual or auto) freezes it: `isPaused = true`, `turnStartAt = now`, `accumulatedPauseMs = remainingMs`
    (at least 1 ms, so a turn paused at 0 never comes back as a full turn); the Pause step's `timeRemainingMs` is the
    same value;
  - a resume (`resume_draft` or the automatic lift) writes `isPaused = false`, `turnStartAt = now` and keeps
    `accumulatedPauseMs`: the turn continues with exactly the time it had left. `resume_draft` no longer reads the
    time from the Pause step (it still reads the step for the D-62 / A85(2) caller rule);
  - `timer_expiry_classic` / `timer_expiry_auction` accept the call only when `remainingMs` is 0
    ("Turn timer has not yet expired." otherwise). Clients compute the same `remainingMs` from `view_my_match_session`.
- **Edit-step cap (draft audit #8; per side since review F1).** `helpers/draft/stepSequence.ts::ensureEditStepRoom(ctx,
  lobbyId, side, kind)`: counted per team side, so one team can only exhaust its own allowance. Each side has two
  counters of `MAX_EDIT_STEPS_PER_LOBBY = 300`: edits (`SetEidolon`, `EquipLightcone`, `UnequipLightcone` steps whose
  `actorSlot`, the edited team, is that side, whoever the caller was: captain or referee) and confirmations
  (`ConfirmGame` steps whose `confirmedSide` is that side). A Thirds game drafts 24 characters; normal play stays far
  below. Checked on the open-game path of `set_eidolon`, `equip_lightcone`, `unequip_lightcone` (edit counter of the
  step's `teamSide`): "The {side} side of this game has reached the limit of 300 edit steps; the referee or staff can
  still close it."; and by `confirm_game` (confirmation counter of the confirming side): "The {side} side of this game
  has reached the limit of 300 confirmation steps; the referee or staff can still close it." The A60(7) Admin
  closed-game edit, `close_game` and the concede are not capped.
- **Pause throttle (draft audit #8; per pausing party since review F3).** `ensurePauseInterval(ctx, lobby, party)`: a
  manual `pause_draft` is rejected while the latest manual Pause step of the caller's own party is younger than
  `PAUSE_MIN_INTERVAL_MS = 10 000` ("The draft was paused moments ago. Please wait a few seconds before pausing
  again."). Parties: `Blue` and `Red` (a team's players, and a referee without the pause power, who pauses as a player
  of their seat) and `Referee` (a referee pausing with the power, `isReferee && refereeCanPause`, seated or not). A
  Pause step's party: `Referee` when its `actorSlot` is Spectator or the actor's current `LobbyMember` row is a referee
  and the lobby has `refereeCanPause`; otherwise its `actorSlot` (Blue / Red). So after Blue pauses, Red's first pause
  and the referee's are accepted at once; Blue's next one waits 10 s. Every pause / resume cycle logs one Pause step
  and `resume_draft` needs a pause, so each party's cycles are bounded at one per 10 s, the referee's unlimited pauses
  included. Auto-pauses are neither counted nor throttled. The party of an older step is resolved from the actor's
  current member row, so a referee transfer inside the 10 s re-labels that actor's earlier pauses (accepted edge).
- **Lineup throttle moved.** `ensureLineupThrottle` / `stampLineupThrottle` moved from `postDraft.ts` to
  `helpers/lobby/abuseControls.ts`; the stamp re-reads the member row before writing it. Still used by the four package
  edits only: the result reducers use the per-user result-entry window instead (`docs/match-results/architecture.md`,
  S10f).
- **LOW fixes.** `undo_last_step` takes the Undo row's sequence before deleting the undone step (it could reuse the
  deleted step's number); `advance_stage` loses the unused `nextMsgId`; `postDraft.ts` drops the unused
  `slotToTeamSide` import.

## Phase S10i execution (DECISIONS.md A100, A101, A107, A108)

**A100: no advance out of an unfinished draft.** `advance_stage` from Drafting (`reducers/draft/postDraft.ts`) first
counts what each team holds: `teamDraft(...).characters.length`, i.e. the team's Pick steps in Classic and the
AuctionSold steps it won in Auction, `EMPTY` included. Both must reach `charactersPerTeam(lineupFormat)` (8 Halves,
12 Thirds), else "The draft is not finished: Blue holds b of N characters and Red holds r of N." Nothing changes on
a rejection. The automatic transitions at the end of a draft (`pick_character` / `timer_expiry_classic` on the last
Classic step, the Auction sale that fills both teams) do not go through `advance_stage` and are unchanged; in practice
the manual Drafting branch now only passes for a draft that is already complete. _Superseded in Phase S10t execution
(A129, A130): there is no automatic transition at the last step; `advance_stage` and the confirm-window expiry share
`finishDraft`._

**A101 / A107(1)(5): every price from the lobby's own cost rows.** All lookups go through
`helpers/draft/costSetGuards.ts` (lobby cost set + game mode + **lobby draft mode**; no default-set fallback):

| Reader | Before | Now |
|---|---|---|
| `pick_character` (`classicPickCost`) | Classic rows, 0 without a row | `characterCostAt`; no row → rejected |
| `timer_expiry_classic` pick pool, ownership off | Classic rows of the set | `pricedCharacterNames` (lobby draft mode) |
| `timer_expiry_classic` pick pool, ownership on | owned characters | owned characters **with a row** (`pricedCharacterNames`) |
| `timer_expiry_classic` pick price | Classic row, 0 without | `characterCostAt` (pool is priced, so never rejects) |
| `timer_expiry_classic` ban pool (Classic and the Auction ban phase) | Classic rows | `pricedCharacterNames` (lobby draft mode) |
| `nominate_character` base cost (`getCharacterBaseCost`) | Auction rows, 0 without | `characterCostAt(…, 0)`; no row → rejected |
| `place_bid` / `ensureTotalBudgetFits` / `resolveSale` / `chargeExtra` input (`auctionEidolonExtra` → `auctionCostAt`) | Auction rows, 0 without | `characterCostAt`; a nomination already proved the row |
| `set_eidolon` Classic (`classicCostAt`) | Classic rows, 0 without | `characterCostAt`; no row → rejected |
| `set_eidolon` Auction (`auctionEidolonExtra`) | Auction rows, 0 without | `characterCostAt` |
| `equip_lightcone` | Classic rows, then set 0, then 0 | `lightconeCostAt`; no row → rejected |
| `unequip_lightcone` | no lookup (refunds the step's `costPaid`) | unchanged |
| synergy surcharge (`synergyPairs`: `arrange_lineup`, `refreshLineupCosts`, `recomputeGame`) | already the lobby's set and draft mode | unchanged; a pair without a row has no surcharge |
| `doesCostSetCover` | same rows | same rows through `costSetRowsFor`; set 0 checked like any other set (review F2, A108(2)) |

`classicCostAt` was removed (`characterCostAt` replaces it). Rejection text: `"<name> has no cost in this lobby's cost
set."`, where `<name>` is the argument as given. A row that exists but lacks the requested field (`e<eidolon>` /
`s<superimposition>`) is rejected with `"The cost row of <name> has no <field> value."` instead of being priced at 0
(review F3, A108(2)); the reducers bound eidolon to 0..6 and superimposition to 1..5, so only a defective row reaches
it. `EMPTY` always costs 0 by rule and is never rejected. A lobby on the default set whose seed lacks the lobby's draft
mode is refused at creation by the coverage guard (docs/cost-sets/architecture.md), not mid-draft. The manual Drafting
branch of `advance_stage` stays; past the A100 check it is reachable only through engineered state (review F7). `ban_character` is not
priced and keeps accepting any name. A cost set can be patched (A107(3)) only while none of its lobbies is in Drafting,
Equipping or Scoring, so a price never changes under a live draft (docs/cost-sets/architecture.md "Phase S10i
execution").

## Phase S10o execution (DECISIONS.md A117)

- **Start check (A117(1)).** `start_draft`'s `autoRandomPick` check (every seated player has a selected account with
  characters: "The player at seat N has no account selected. autoRandomPick requires ...", "... has no characters on
  their selected account(s). ...") runs only when `lobby.requireOwnership` is on. Without ownership the draft starts
  with no accounts, guests included. The D-08 account check of Ranked lobbies and MMR-counted tournament lobbies is a
  separate block and is unchanged.
- **Pools (A117(2)), unchanged.** Ownership on: the acting team's owned characters on its selected accounts that the
  lobby's cost set prices. Ownership off: every character priced in the lobby's cost set, game mode and draft mode
  (`pricedCharacterNames`). Both minus bans and `picksBlockingTeam` (A87); the ban pool minus bans, picks and the Ban
  Restriction (A45(2)).
- **Timer draw (A117(3)).** `timerDrawIndex(ctx, lobbyId, turnIndex, n, nextSequence)` in `draftClassic.ts` calls the
  pure `timerDrawIndex` of `shared/lobby-rules/timerDraw.ts`. It hashes five 32-bit words, the transaction timestamp
  in microseconds (low and high word, all 64 bits kept), the lobby id, the session's `turnIndex` and `nextSequence` (the
  `MatchSessionStep.sequence` the auto step takes: `getNextSequence`, read once per call and also written on the
  step), with MurmurHash3 x86_32 (seed 0, `fmix32` finalizer), and reduces the 32-bit hash `h` to the pool by
  multiply-high: `index = floor(h * n / 2^32)`. Every index gets `floor(2^32 / n)` or `ceil(2^32 / n)` hash values, so
  the residual bias is at most `n / 2^32` relative (about 2e-8 at n = 80). It replaces `(turnIndex * 31 + lobbyId) % n`,
  which gave the same entry every time a turn was replayed. Used by the Classic auto-pick, the Classic auto-ban and the
  Auction ban phase (which runs through `timer_expiry_classic`); `timer_expiry_auction` auto-nominates `EMPTY` and
  draws nothing.
  - Why not `ctx.random` (fix pass, review F1): on the host SDK 2.14.1 seeds it with `pcg32` of the transaction
    timestamp, whose signed shift sign-fills the high bits of the 32-bit seed, and the first output is the seed
    complemented, so one pool position was about 3.3 times as likely as average at n = 80. Measured over 200,000
    structured inputs (timestamps 13.3 s apart over a month, five lobby ids, 40 sequences), the new draw gives every
    position a share between 49.96% and 50.04% at n = 2, 8.13% and 8.44% at n = 12, 1.17% and 1.32% at n = 80
    (`shared/lobby-rules/timerDraw.test.ts`).
  - Why it changes after an undo: the replayed expiry is a later transaction (new timestamp), and `undo_last_step`
    inserts an Undo row that takes the next sequence, so `nextSequence` is higher too. A pool of one entry gives index 0
    every time. The same transaction on the same state gives the same draw (CLAUDE.md §3.2), on the host and in the
    in-memory harness (where the timestamp is the TestClock's).
  - Who fires it: the expiry is client-triggered. Any present member of the lobby (spectators included) may call
    `timer_expiry_classic` once the turn clock reads 0; the accepted call advances the turn, so a turn is fired once.
    The draw depends on the host's microsecond commit time, which a client cannot aim (network jitter is thousands of
    microseconds), and no check after the draw lets a caller reject the result and retry.
  - Follow-up, not changed here: the other `ctx.random` users, `ctx.random.shuffle` in random bracket seeding
    (`seed_bracket` mode `random`, `bracketGeneration.ts`), the RandomSwap of `shuffle_teams` (`lobbySettings.ts`) and
    the A36a random team formation (`tournamentHelpers.ts`), still carry the same seed skew.

## Phase S10p execution (DECISIONS.md A120)

- The follow-up noted under Phase S10o is done: random bracket seeding, the RandomSwap of `shuffle_teams` and the
  A36a random team formation use `fairShuffle` of `shared/lobby-rules/timerDraw.ts` (same MurmurHash3 and
  multiply-high as the timer draw, one hash per Fisher-Yates position, a domain word per site). No module code
  outside tests calls `ctx.random`. The timer draw itself is unchanged. Details: brackets, lobby and tournament
  architecture docs, Phase S10p (formula and limits: [lobby/architecture.md](../lobby/architecture.md#phase-s10p-execution-decisionsmd-a120)).

## Phase S10r execution (DECISIONS.md A122)

- **Ban names (A122(7), L32).** `ban_character` checks the name after the captain check and before availability: `EMPTY` is refused ("EMPTY is not a character and cannot be banned."); any other name needs the lobby's cost row (`characterCostRow`: cost set, game mode, draft mode, the pool the timer draws from and the check `pick_character` makes through `characterCostAt`), else "<name> has no cost in this lobby's cost set." (`costMissingText`). No system path writes an `EMPTY` ban: the timer's empty ban is the `SKIP` sentinel (`timer_expiry_classic`), which never blocks an `EMPTY` pick. A manual `SKIP` ban has no cost row and is refused by the same check.
- **Coaches do not pause (A122(8), L33).** `pause_draft`: on the non-referee path a coach is refused ("Coaches cannot pause the draft.") before the `allowPlayerPause` and team-pause checks, so a coach uses none of the team's three pauses. A coach holding the referee flag with `refereeCanPause` pauses as referee, as before. `resume_draft` needs no change: a coach is never the original pauser now, and the auto-pause path already refuses coaches (A85(2)).
- **Undo of the last Auction ban (A122(9), L34).** `undo_last_step` accepts the call while `isAuctionPhase` is true as long as the auction has not begun: `currentNomination` unset and no `Nominate`, `Bid` or `AuctionSold` step in the lobby. The window is from the last ban (which set `isAuctionPhase`) to the first nomination (manual or the timer's `EMPTY` auto-nomination). The undo then deletes that `Ban` step, writes the `Undo` row, sets `turnIndex` back to the ban turn, `isAuctionPhase = false` and resets the turn timer. Nothing else changed when the phase opened, so nothing else is restored. Once a nomination exists, the old text "Undo is not available during the auction phase." stands. **Window end superseded by Phase S10s execution (A125):** the window now closes at the first bid or sale. **Window superseded by Phase S10t execution (A127):** there is no window; undo walks back any draft step.
- **Undo cap (A122(10), L35).** `undo_last_step` calls `ensureUndoStepRoom` (`helpers/draft/stepSequence.ts`, next to `ensureEditStepRoom`, same constant `MAX_EDIT_STEPS_PER_LOBBY` = 300) before deleting the step: at 300 `Undo` rows in the lobby's game the call is refused ("This game has reached the limit of 300 undo steps."). The count is per lobby, not per side: undo is the referee's power over the whole draft.

## Phase S10s execution (DECISIONS.md A125)

- **Superseded by Phase S10t execution (A127):** the window and its refusal text are gone; the nomination undo described below is kept as one case of the general undo.
- **Auction undo window until the first bid (A125).** `undo_last_step` (`reducers/draft/draftControl.ts`) refuses in the
  auction phase only once a `Bid` or `AuctionSold` step exists in the lobby's game ("Undo is not available during the
  auction phase.", unchanged text). Inside the window at most one nomination exists (a nomination ends only with a sale).
- **What a nomination writes.** `nominate_character` (and the A81(2) immediate sale aside, which writes `AuctionSold`
  and so closes the window): one `Nominate` step (actor, nominator's slot, `characterName`); on `MatchSession`:
  `currentNomination` = the character, `currentBidAmount` = its base cost (the opening bid; nothing is charged until a
  sale, `resolveSale` in `completeSale`), `currentBidTeam` = the nominator, a fresh turn clock (`turnStartAt` = now,
  `accumulatedPauseMs` 0); `Lobby.lastActivityAt`. It does not move `turnIndex`, `nextNominatorTeam`, either character
  or light-cone budget, the won counts or the reserve banks (no reducer writes `teamBlue/RedReserveMs` after
  `start_draft`).
- **The timer's nomination.** `timer_expiry_auction` with no open nomination writes the same: a `Nominate` step with
  `actorUserId` 0, the nominator's slot and `EMPTY`; `currentNomination` 'EMPTY', `currentBidAmount` 0,
  `currentBidTeam` the nominator, a fresh clock. It does not pass the nomination turn: the other team now bids or
  passes. It counts as a nomination step like a manual one.
- **The undo of an open nomination.** With the window open and a nomination open, a first undo deletes that
  `Nominate` step, inserts an `Undo` row (`originalSequenceId` = the nomination's sequence; counted by
  `ensureUndoStepRoom`, the L35 cap of 300), and restores the no-nomination state exactly: `currentNomination` and
  `currentBidAmount` unset, `currentBidTeam` Spectator (what `start_draft` and every sale leave), a fresh turn clock for
  `nextNominatorTeam` (unchanged, so the nominator), `Lobby.lastActivityAt`. `turnIndex`, `isAuctionPhase`, budgets and
  won counts are untouched (they never moved). A further undo takes the A123 / A122(9) path: the last ban is deleted,
  `turnIndex` back on it, `isAuctionPhase` false. The "No steps to undo." check no longer blocks a nomination undo in an
  Auction without bans (`turnIndex` 0). The A117 re-roll is unaffected: the Undo row raises the next sequence, which the
  timer draw keys on (the Auction timer nomination itself is always `EMPTY`, no draw).

## Phase S10t execution (DECISIONS.md A127, A129, A130, A131, A132)

`undo_last_step` (`reducers/draft/draftControl.ts`) removes the last character step of the lobby's game and restores
the state before it, one step per call, in every draft mode and phase, while the lobby stage is Drafting. "Last step" =
the highest-sequence Ban, Pick, Nominate, Bid or AuctionSold step. A132: an eidolon selection (SetEidolon, written by
`set_eidolon` during Drafting) is not a step of its own for undo: it is never the target and never blocks one, even as
the most recent step; it goes with its character. Pause and Undo rows are skipped and kept, as before. No other step
kind is written during Drafting. Unchanged: the referee rule (D-60, `refereeCanUndo`), A98 (present caller), the pause
refusal ("Nothing to undo right now."), "No steps to undo." when no character step is left, the 300-row cap (A122(10):
every undo inserts exactly one Undo row, `originalSequenceId` = the undone character step, and checks the cap first;
removed SetEidolon steps add no Undo row). The refusal "Undo is not available during the auction phase." is removed
(nothing can reach it). Every undo stamps `Lobby.lastActivityAt`; the A117 re-roll still works (the Undo row raises
the next sequence the draw keys on).

| Step kind (writer) | What the step's call writes | What the undo restores |
|---|---|---|
| Ban (`ban_character`, `timer_expiry_classic`) | the step; `turnIndex` + 1; on the last Auction ban `isAuctionPhase` true; fresh clock | step deleted; `turnIndex` - 1; `isAuctionPhase` false when set; fresh clock |
| Pick (`pick_character`, `timer_expiry_classic`) | the step; `turnIndex` + 1; fresh clock. Later `set_eidolon` calls of that side on that character add SetEidolon steps (Classic: no budget) | the pick and every SetEidolon step of the picking side on that character after it deleted (one Undo row); `turnIndex` - 1; fresh clock |
| Nominate (`nominate_character`, the timer's `EMPTY` nomination) | the step; `currentNomination`, `currentBidAmount` (E0 cost), `currentBidTeam` (nominator); fresh clock | step deleted; nomination unset, `currentBidTeam` Spectator; fresh clock (`nextNominatorTeam` never moved) |
| Bid (`place_bid`) | the step (with `previousAmount`); `currentBidAmount`, `currentBidTeam`; fresh clock | step deleted; `currentBidAmount` = `previousAmount` (the earlier bid, else the opening amount); `currentBidTeam` = the other team (bids alternate); fresh clock. Refused when that team's character budget is below `previousAmount` (review 2 G2, below) |
| AuctionSold by pass / timer (`pass_bid`, `timer_expiry_auction` → `completeSale`) | the step (with `charCharged` / `lcCharged`: what it took from the winner's character and light-cone budget); nomination cleared; winner's two budgets; won count + 1; `nextNominatorTeam`; fresh clock | the sale and every SetEidolon step of the winner on that character after it deleted (one Undo row); nomination reopened (`currentNomination` = character, `currentBidAmount` = `winningAmount`, `currentBidTeam` = `winningTeam`); each winner budget += the sale's charge to it + each removed edit's charge to it (a lowering edit's negative charge takes its refund back); won count - 1; `nextNominatorTeam` = the nomination's `Nominate.actorSlot`; fresh clock. Nominate / Bid steps stay |
| AuctionSold, A81(2) immediate (`nominate_character` or the timer nomination while the other team is full; always the case for the last sale) | Nominate and AuctionSold in one call; budgets, won count, `nextNominatorTeam` as above, no open nomination | Nominate, AuctionSold and the character's SetEidolon steps deleted with one Undo row (`originalSequenceId` = the sale); no nomination; budgets as above, won count, `nextNominatorTeam` = the nominator; fresh clock. Detected by "the team other than the nominator was full before the sale" (won counts move only at sales) |
| SetEidolon during Drafting (`set_eidolon`) | the step (with `charCharged` / `lcCharged`: what it took from each budget, negative = refund; 0 in Classic); Auction: the team's two budgets; the editor's `lastLineupAt` throttle stamp | never undone on its own (A132); removed with its character's pick or sale. An edit on another character keeps its row and its charge, even when made after the sale being undone |

**Budgets (A132).** Undoing a sale gives back exactly what that character cost, per budget, and nothing is recomputed
or replayed. The charges are the exact differences of the stored f32 budgets (`before - Math.fround(after)`), kept in
f64 fields, so with no edit on another character in between the undo restores the budgets bit for bit; with one, the
state is "before the sale, with that other edit's charges applied" (for example character budget 10, light cones 50, buy
A for 10, raise B for 5 from the light-cone budget, undo the sale of A: character 10, light cones 45). In that case the
result is rounded from a different f32 value, so a residue of one unit in the last place can remain (review 2 L1; bounded
by the 300 Undo cap, integer and dyadic prices are exact). Invariant (tested): a team's two budgets add up to its
starting budgets minus the cost of what it still holds (the remaining sales' and edits' charges), and neither budget is
ever below 0 (review 2 G1, `restoredBudgets` in `draftControl.ts`): a lowering edit refunds to the light-cone budget,
and if the team spent that refund on another character, taking it back would leave the light-cone budget negative (a
later `chargeExtra` clamp would then create budget). The undo moves that shortfall to the character budget and stores
0, so the total is unchanged and nothing is dropped (budgets 100 / 50: buy B for 5 and A for 5.5, raise A by 30, lower
it again, raise B by 139, undo the sale of A: 6 / 0). The mirror case cannot occur (everything given back to the
character budget was taken from it) and is clamped the same way. The reopened bid stays backed: the character budget
after the move is at least the winning amount.

**The one refusal inside the draft (review 2 G2).** Undoing a bid is refused with "Cannot undo this bid: the previous
bidder can no longer cover their bid." when the restored holder's character budget is below `previousAmount`.
`set_eidolon` reserves the bid only for the team that holds it, so an outbid team may spend its character budget on an
eidolon raise, and A132 does not walk that edit back; restoring its hold would leave a bid no sale can settle
(`resolveSale` refuses it, so the pass and the timer sale would fail). Nothing changes on the refusal; the draft goes on
with the current holder (pass, timer or a new bid). The per-side edit cap (`ensureEditStepRoom`) counts live SetEidolon steps, so the edits removed with a
character free their slots; undo no longer spends Undo rows on edits (review F1: a captain can no longer bury the last
pick under edits; `set_eidolon` stays allowed in the confirm window and one undo still removes the last pick).

**Payload fields added (S11 clear-publish list).** `BidPayload.previousAmount: f32`; `AuctionSoldPayload.charCharged: f64`,
`lcCharged: f64` (the winner's); `SetEidolonPayload.charCharged: f64`, `lcCharged: f64` (the edited team's, written by
every `set_eidolon` call, 0 in Classic or for a delta of 0). Appended at the end of each struct. The bid's opening amount
is logged because an admin cost-row import can change a price during a live draft. `MatchSessionStepHistory.payload` is
the JSON of the live payload (`finalizationHelpers.ts`), so the history copy carries the new fields without a change.

**The end of the draft (A129, A130, A131; supersedes the automatic move).** The last Classic pick (`pick_character`,
`timer_expiry_classic`) and the last Auction sale (`completeSale`, by pass, by the timer or, always in practice, the
A81(2) immediate sale: before the last sale one team is full and a full team never nominates) no longer move the lobby
to Equipping and no longer roll the budgets over. The lobby stays in Drafting with the draft complete
(`isDraftComplete`, `helpers/draft/draftComplete.ts`: Classic `turnIndex >= draftSequence.length`; Auction
`isAuctionPhase` and both won counts at `charactersPerTeam`). Stage flow: Waiting → Drafting (turns … last step →
confirm window) → Equipping → Scoring → AwaitingResult.

- **No turn runs.** `pick_character`, `ban_character`, `nominate_character`, `place_bid` and `pass_bid` refuse with
  "The draft is complete. It moves to Equipping when the referee advances it or the confirm window ends." (after their
  pause / coach guards). Neither expiry reducer auto-picks, auto-bans, nominates or sells.
- **The confirm window** (`Lobby.confirmWindowSeconds`, 0-300, default 60, A131) runs on the session's turn clock:
  the last step wrote `timerState.turnStartAt` = its time and `accumulatedPauseMs` = 0. `turnFullMs(lobby, session)`
  (`helpers/draft/turnClock.ts`) returns `confirmWindowSeconds * 1000` while the draft is complete in Drafting, else
  `standardTurnSeconds * 1000`; `pause_draft`, the disconnect auto-pause (`run_referee_transfer_check`) and
  `resume_draft` pass it, so a pause freezes the window's remaining time in `accumulatedPauseMs` exactly as for a turn.
  **Client countdown:** when `isDraftComplete` holds (computed from `view_my_match_session` and the lobby's
  `draftMode` / `lineupFormat`), remaining = `isPaused ? budget : max(0, budget - (now - turnStartAt))` with
  budget = `accumulatedPauseMs > 0 ? accumulatedPauseMs : confirmWindowSeconds * 1000`. The client must derive "whose
  turn" from the same test, not from the stage: in the window `draftSequence[turnIndex]` is undefined (Classic) and
  `nextNominatorTeam` names a full team (Auction).
- **Ways out.** (1) `advance_stage` by whoever A80 allows (the referee, or a Moderator+), at any time in the window,
  after the A100 check. (2) The expiry: `timer_expiry_classic` or `timer_expiry_auction`, called by any present member
  (A98) once the window has elapsed (refused before with "The confirm window has not yet expired."; "Draft is paused."
  while paused). The Classic expiry also serves an Auction lobby in the window (its complete-draft branch is not
  mode-gated); the Auction expiry refuses a Classic lobby earlier ("Auction phase not active."). Both call
  `finishDraft(ctx, lobby, session, actorId)`: the D-50 roll-over (each leftover character budget added to the
  light-cone budget, character budgets 0), stage Equipping, `lastActivityAt`, the system chat line "Draft complete.
  Stage: Equipping". The expiry's audit actor is 0 (system), as for the timer steps. (3) `undo_last_step`: the
  last pick or sale is undone like any other step (no roll-over to reverse); its turn reopens with a fresh clock, and
  the next completing step starts a fresh window.
- **No window (`confirmWindowSeconds` = 0).** `finishDraftWithoutWindow` runs after the last pick / sale: the lobby
  moves to Equipping in that same call through `finishDraft`, and that last step cannot be undone. One difference from
  the automatic move before A129: `finishDraft` also posts the system chat line "Draft complete. Stage: Equipping"
  (the old automatic move posted none; `advance_stage` always did).
- **Other rules in the window.** `set_eidolon` works (stage Drafting, the character is drafted) and does not touch the
  clock. The disconnect rules are unchanged: the stage is Drafting, so the 15 s check may auto-pause (which holds the
  window), the forfeit clock and pool run (A85, A92), and a concede or forfeit is stored with `concedeAtStage` Drafting
  but counted like an Equipping one for the stats (review F2, below).
- **The move ends a pause (review F3).** `finishDraft` writes `isPaused` false, `accumulatedPauseMs` 0 and `turnStartAt` now, so a
  window held by a manual pause or a disconnect auto-pause never leaves the lobby paused in Equipping (`resume_draft` is
  Drafting-only). The pause counters (`pausesUsedBlue` / `pausesUsedRed`) keep the pauses spent; the Pause step rows stay
  (the log; no resume row exists in any case).
- **Concede in the window (review F2).** A concede or forfeit there is stored with `concedeAtStage` Drafting, but the D-79
  stats matrix treats a complete draft like Equipping: Ranked character stats are counted
  ([../match-results/architecture.md](../match-results/architecture.md) "Phase S10t execution").
- **The window is as soft as a turn timer (review F6).** Nothing ends it on its own: if no client calls an expiry reducer
  the lobby stays in Drafting and undo keeps working (any present member's client ends it, as for turns). A player's
  manual pause holds the window, and only that player or the referee can resume it (D-62); with the referee away a
  paused window stays paused, the same exposure as any paused turn.
- **Roll-over rounding (review F7).** The Auction roll-over used to add the leftover character budget to the light-cone
  budget in double precision before the f32 store; `finishDraft` now adds the two stored f32 values. For prices that are
  not exact in f32 the result can differ by one f32 unit in the last place; integer and dyadic prices are unchanged.
- **After the move**, `undo_last_step` refuses with "The draft is finished: undo works only while the lobby is in the
  draft stage." (Equipping, Scoring, AwaitingResult; Waiting keeps the stage text).

## Phase History

| Decision | Source | Date |
|----------|--------|------|
| MatchSession uses lobbyId as PK (same as Lobby.id) -- one session per lobby | Phase 07 CONTEXT.md | 2026-03-07 |
| MatchSessionStep append-only event log -- no updates, only inserts and bulk delete on finalization | Phase 07 CONTEXT.md | 2026-03-07 |
| Timer model: server-side timerStartedAt + timerResumedOffset accumulates pause elapsed (D-07) | Phase 07 CONTEXT.md | 2026-03-07 |
| Auction mode: auctionBudgets serialized as JSON map on MatchSession | Phase 07 execution | 2026-03-07 |
| Deterministic coin flip: no Math.random() in reducers | Phase 04 execution | 2026-02-20 |
| History tables (MatchSessionHistory, MatchSessionStepHistory, MatchParticipantHistory): created at finalization, ephemeral rows deleted | Phase 07 execution | 2026-03-07 |
| Equipping stage: lightcone path must match character path (same Path enum) | Phase 07 execution | 2026-03-07 |
| Anonymous enforcement in MatchSessionStep: actorUserId=0 when isAnonymousPlayers | Phase 09 CONTEXT.md | 2026-03-28 |
| BetweenGames stage added for best-of-N series; advance_to_next_game resets draft state | Phase 07 execution | 2026-03-07 |
| Normalized to standard template | Phase 13 normalization | 2026-04-09 |
| Phase 12.3 execution | timer_expiry_classic auto-pick pool migrated from HsrAccount.isActive to LobbyMemberAccount per-match selection (D-I-01/02); closes last in-gameplay isActive read from Phase 10.4 migration gap | 2026-04-12 |
| Phase 15.4 execution | timer_expiry_classic autoRandomPick pool builders now filter `draftMode='Classic'` — prevents 0-cost auto-picks of Auction-only characters (WR-02, matches pick_character cost lookup pattern) | 2026-04-15 |
| Phase 15.4 execution | postDraft step inserts (equip_lightcone, arrange_lineup, confirm_lineup) stamp `gameNumber: session.currentGameNumber` — matches draft-phase invariant; preserves step-to-game attribution in MatchSessionStepHistory for bestOf>1 archives (WR-04); arrange_lineup + confirm_lineup gained session-lookup guard matching equip_lightcone | 2026-04-15 |
| Phase 15.3 execution | Typed audit helpers (`insertWithAudit` / `updateWithAudit`) migration surfaced latent schema drift hidden by bare-spread `as any` closures: Rule 2 — `draftControl.ts` Undo (L60) + Pause (L176) steps and `index.ts` clientConnected audit step (L215) now stamp `gameNumber: session.currentGameNumber` (broadens WR-04 invariant from 2 files to 4). Rule 2 — `draftClassic.ts` MatchResultRecord now populates `concedeTrigger` / `concedeSummary` / `concedeAtStage`. Rule 1 — `seriesManagement.ts::advance_to_next_game` `initialTimerState` now writes the canonical 5-field TimerState shape (`turnStartAt`, `teamBlueReserveMs`, `teamRedReserveMs`, `isPaused`, `accumulatedPauseMs`); pre-fix code wrote non-existent `pausedAt` + `pauseRemainingMs`, silently dropped at serialization | 2026-04-18 |
| Phase S4 execution | Paused-draft guard on pick/ban/nominate/bid/pass and both timer expiries (DECISIONS.md A22(3)); `timer_expiry_*` require lobby membership (F3); all step writers use `getNextSequence` (F9); `undo_last_step` undoes the last Pick/Ban only and rejects while paused / in the auction phase (F9); auto-pause moved from `client_disconnected` to `run_referee_transfer_check` (DECISIONS.md A22a, F5); result reducers switched to `ensureNotConceded` (DECISIONS.md A22(4), F8) | 2026-11-06 |
| F2: `initSessionForGame` shared by `start_draft` and `advance_to_next_game` (sequence, turn, auction state, budgets, timer, pauses); game N + 1 is draftable | Phase S6 execution (BACKEND-BUGS F2) | 2026-11-06 |
| `start_draft` seeds `gamesWonBlue/Red` from `lobby.bestOfNAdvantage`; `advance_stage` keeps the head start in its win recount | Phase S6 execution (DECISIONS.md A27; backlog #7) | 2026-11-06 |
| Ban Restriction enforced per team in `ban_character` and respected by the timer-expiry auto-ban | Phase S6 execution (DECISIONS.md A45(2)) | 2026-11-06 |
| MMR snapshot = merged account rating of the selected accounts (replaces MAX) | Phase S6 execution (backlog #10) | 2026-11-06 |
| `MatchLineup` writers (`arrange_lineup` / `confirm_lineup` with `teamSide`), `ConfirmLineupPayload.groups`, eidolon snapshot, Thirds = 12 picks | Phase S7 execution (DECISIONS.md A21, A43 CH-S6, A56; backlog #3) | 2026-11-06 |
| `confirm_lineup`, `MatchLineup.isConfirmed`, the `ConfirmLineup` step and the `equip_lightcone` surcharge reservation removed; `equip_lightcone` / `arrange_lineup` open in Equipping and Scoring for the open game; new `set_eidolon` (Drafting → Scoring, owned levels under ownership, lineup throttle); every open-game edit recomputes and resets both game confirmations; Admin path on a closed game; `advance_stage` loses its Scoring branch; `SetEidolon` / `ConfirmGame` step kinds | Phase S7b execution (DECISIONS.md A60) | 2026-11-07 |
| Auction: E0 nominations (`nominate_character` loses `eidolon`), ownership on nominations and bids, total-budget guard, extra charged at the sale (character budget first, then light cones), `AuctionSoldPayload.eidolonCost`; Auction eidolon refunds go to the light-cone budget (orchestrator rule) | Phase S7b execution (DECISIONS.md A61) | 2026-11-07 |
| Classic Thirds orders per ban mode (`THIRDS_ORDERS`), `THIRDS_EXTRA_PICKS` removed; `draft-order.md` gains the Thirds section | Phase S7b execution (DECISIONS.md A59) | 2026-11-07 |
| Auction default eidolon at the sale, the bid-time guard and the bid reservation = the **lowest** owned level (`teamDefaultEidolon` returns the first of the ascending owned list); Classic keeps the highest (`resolveOwnedEidolon`) | Phase S7b follow-up (DECISIONS.md A64) | 2026-11-07 |
| Steps kept for the whole series (A65): game-scoped readers filter by gameNumber (`currentGameSteps`), finalization archives every game, `view_my_match_steps` carries `gameNumber`; `unequip_lightcone` + `UnequipLightcone` step; `equip_lightcone` checks the caller's team draft; auto-resume reads the latest Pause; optional `gameNumber` on the edit reducers (A65(4)) | Phase S8d execution | 2026-11-07 |
| One game per lobby: session created once by `start_draft` (initializer folded in), no series columns, steps / lineups without `gameNumber`, `lobbySteps` replaces `currentGameSteps`, edit reducers lose the trailing `gameNumber`, series reducers deleted | Phase S8e execution (DECISIONS.md A67(1)(3)) | 2026-11-08 |
| Edit window ends at validation (`ensureEditableRecord`: three precise rejections); `select_match_account` ratchet removed | Phase S8e execution (DECISIONS.md A69(2)(3)) | 2026-11-08 |
| A live-stage Leave runs the disconnect path (auto-pause via the 15 s check, forfeit clock); away rows offline for the check and the forfeit test; no automatic concede | Phase S8f execution (DECISIONS.md A68) | 2026-11-08 |
| `refereeFullControl` write removed from `start_draft`; live views `view_my_match_session`, `view_my_lineups` (A60 flags), replay `view_my_match_lineup_history`; step / participant views mask ids via `hideUserId` | Phase S9a execution (DECISIONS.md A37, A40, A56, A60, A63) | 2026-11-08 |
| Game-package edits: captain of that side or a referee (`ensureCaptainOrReferee`) for `set_eidolon`, `equip_lightcone`, `unequip_lightcone`; light-cone reducers take `teamSide` (second argument) and the lineup throttle; Admin path uses the given side | Phase S10b execution (DECISIONS.md A78) | 2026-11-09 |
| `start_draft` and `advance_stage`: referee flag holder or Moderator+ (`ensureRefereeOrAbove`), host as such no longer | Phase S10b execution (DECISIONS.md A80) | 2026-11-09 |
| Input bounds: `pick_character` eidolon 0..6 when the argument is used, `equip_lightcone` superimposition 1..5 (both paths), `place_bid` finite non-negative `bidAmount` | Phase S10c execution (audit 2026-11-09) | 2026-11-09 |
| Auction: a full team neither nominates nor bids and is skipped by the rotation and the timer; while one team is full the other's nomination sells at once at base cost (`completeSale` shared by every sale) | Phase S10c execution (DECISIONS.md A81) | 2026-11-09 |
| `resume_draft` on an auto-pause: the referee or any seated player of either team | Phase S10c execution (DECISIONS.md A85) | 2026-11-09 |
| Timer auto-pick priced from the Classic cost row (owned eidolon under ownership); mirror picks once per team on the manual and timer paths; `start_draft` rejects while a seated player is offline or away | Phase S10d execution (DECISIONS.md A86, A87, A92(1)) | 2026-11-09 |
| `start_draft` rejections name the seat; a team over `teamSize` is rejected; the start line respects the chat window | Phase S10e execution (lobby audit #6, #9, #10) | 2026-11-09 |
| Fix pass: `start_draft` schedules the 15 s check for an offline host or referee; abandoned players stay in the team's ownership and auto-pick pools | Phase S10e execution (review F2, F3; DECISIONS.md A93(4)) | 2026-11-09 |
| One turn clock (`turnClock.ts`): pause freezes the remaining time in `accumulatedPauseMs`, resume and the automatic lift restore it, expiry needs remaining 0; edit-step cap 300 per team side (edits and confirmations counted separately, review F1); manual pause throttle 10 s per pausing party (Blue, Red, Referee; review F3) | Phase S10f execution (draft audit #5, #8; BACKEND-BUGS F10; policy review G10) | 2026-11-09 |
| A98: `pick_character`, `ban_character`, `timer_expiry_classic`, the Auction reducers, `undo_last_step`, `pause_draft`, `resume_draft` reject an away / abandoned caller (`ensurePresentMember`); `start_draft` / `advance_stage` through `ensureRefereeOrAbove` (Moderator+ exempt). Full list: [../lobby/architecture.md](../lobby/architecture.md) "Phase S10h execution" | Phase S10h execution (DECISIONS.md A98) | 2026-11-10 |
| `advance_stage` from Drafting needs `charactersPerTeam` characters per team; every character / light-cone price from the lobby's own set, game mode and draft mode, no fallback, a missing row rejects; timer pools draw priced characters only | Phase S10i execution (DECISIONS.md A100, A101, A107) | 2026-11-10 |
| `doesCostSetCover` no longer exempts set 0 (review F2); a cost row without the requested eidolon / superimposition field is rejected, no `?? 0` (review F3); the manual Drafting branch of `advance_stage` kept with a note (review F7) | Phase S10i execution (DECISIONS.md A108) | 2026-11-10 |
| `start_draft`'s `autoRandomPick` account check only under `requireOwnership`; timer pick / ban draw = MurmurHash3 of the transaction timestamp, lobby, turn and next sequence, reduced by multiply-high (`shared/lobby-rules/timerDraw.ts`; re-rolls after an undo; not `ctx.random`, review F1); pools unchanged | Phase S10o execution (DECISIONS.md A117) | 2026-11-10 |
| No module code draws with `ctx.random`: the three remaining shuffles (seeding, RandomSwap, A36a formation) use `fairShuffle` (`shared/lobby-rules/timerDraw.ts`); timer draw unchanged | Phase S10p execution (DECISIONS.md A120) | 2026-11-10 |
| `ban_character` needs a priced name of the lobby's pool, `EMPTY` refused; coaches cannot pause; the last Auction ban is undoable until the first nomination; Undo rows capped at 300 per game | Phase S10r execution (DECISIONS.md A122) | 2026-11-10 |
| `undo_last_step` in Auction: the window stays open until the first Bid / AuctionSold step; a first undo cancels the open nomination (manual or the timer's `EMPTY`) and restores the no-nomination state with a fresh turn for the nominator; a further undo removes the last ban | Phase S10s execution (DECISIONS.md A125) | 2026-11-10 |
| The last pick / sale leaves the lobby in Drafting with the draft complete (no roll-over, draft actions refused); a confirm window (`Lobby.confirmWindowSeconds`, 0-300, default 60, on the turn clock fields) ends through `advance_stage` or either timer expiry reducer once elapsed, both via `finishDraft` (roll-over, Equipping, chat line); 0 = the last step moves at once | Phase S10t execution (DECISIONS.md A129, A130, A131) | 2026-11-10 |
| `undo_last_step` removes the last character step (ban, pick, nomination, bid, sale incl. the A81 immediate sale in one call) with an exact restore; refused once the stage left Drafting ("The draft is finished: ...", A129: after `advance_stage` or the window); the auction-phase refusal is removed; payload field `BidPayload.previousAmount` added | Phase S10t execution (DECISIONS.md A127) | 2026-11-10 |
| Review 2: a sale undo never leaves a budget below 0 (a light-cone shortfall moves to the character budget); a bid undo is refused when the previous bidder can no longer cover its bid | Phase S10t execution (DECISIONS.md A127, A132; review 2 G1, G2) | 2026-11-10 |
| Eidolon selections are not undo steps: a pick or sale is undone together with its own SetEidolon steps (one Undo row); the budgets get back exactly what the sale and those edits charged; edits on other characters keep their charges; payload fields `AuctionSoldPayload` / `SetEidolonPayload` `charCharged`, `lcCharged` (f64). Fix pass: `finishDraft` clears a pause; a Ranked concede in the window counts character stats | Phase S10t execution (DECISIONS.md A132; review F1, F2, F3) | 2026-11-10 |

---

*Last updated: 2026-11-10 (S10t)*
*Feature owner: Phase 07 / Phase 09 / Phase 12.3 / Phase 15.4 / Phase 15.3*

**Behavior specification** (acceptance scenarios, edge cases, phase history): See [contract.md](contract.md)
