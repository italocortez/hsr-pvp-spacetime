# Match Session -- Architecture

Last updated: 2026-04-12

## Overview

Match sessions manage the real-time draft and game flow within a lobby. A `MatchSession` row is created when a draft starts and acts as the authoritative clock and stage state for that match. `MatchSessionStep` rows record every draft action (picks, bans, coin flips, etc.) as an append-only event log. At the end of a match, `run_finalization` snapshots all session data into history tables (`MatchSessionHistory`, `MatchSessionStepHistory`, `MatchParticipantHistory`) and hard-deletes the ephemeral rows. The timer model uses server-side `timerStartedAt` and `timerDurationSeconds`; pausing accumulates elapsed ms in `timerResumedOffset`. Both Classic and Auction draft modes share the same step infrastructure, differentiated by `stepType`.

## Table Relationships

```
Lobby (id: u32 autoInc PK)
  +-- MatchSession (lobbyId: u32 PK -- same as Lobby.id)  [public: true]
  |     lobbyId -> Lobby.id
  |     stage: MatchSessionStage (Waiting | Drafting | Equipping | Scoring | BetweenGames | AwaitingResult)
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
1. Permission: host OR referee OR TO/Mod+
2. Validate stage transition is legal from current `MatchSession.stage`
3. Insert system `MatchSessionStep` with `stepType=SystemEvent`, payload indicating stage change
4. Update `MatchSession.stage` and `Lobby.stage`

### advance_to_next_game(lobbyId)
1. Permission: host OR TO/Assistant/Mod+; referee if `refereeControlsShelving=true`
2. Lobby must be in BetweenGames stage
3. Increment `MatchSession.currentGame`; reset draft state (`draftPhase=0`, `draftTurnIndex=0`)
4. Transition `MatchSession.stage=Drafting`; transition `Lobby.stage=Drafting`
5. Restart timer: `timerStartedAt=ctx.timestamp`, clear `timerPausedAt`, reset `timerResumedOffset=0`

### shelve_series(lobbyId)
1. Permission: host OR TO/Mod+; referee if `refereeControlsShelving=true`
2. Lobby must be in BetweenGames or active stage (not Closed/AwaitingResult)
3. Transition `Lobby.stage=Shelved`; update `MatchSession.stage=Shelved`

### resume_series(lobbyId)
1. Same permission as shelve_series
2. Lobby must be in Shelved stage
3. Transition back to BetweenGames; restart timer

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

---

*Last updated: 2026-04-18*
*Feature owner: Phase 07 / Phase 09 / Phase 12.3 / Phase 15.4 / Phase 15.3*

**Behavior specification** (acceptance scenarios, edge cases, phase history): See [contract.md](contract.md)
