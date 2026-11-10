# Match Session (Draft System)

**Architecture:** [architecture.md](architecture.md)

## Feature Overview

The match session system manages the entire draft lifecycle within a lobby: character bans, character picks (Classic mode), character auctions (Auction mode), lightcone equipping, lineup arrangement, and stage advancement through Drafting, Equipping, and Scoring. It enforces turn order, budget constraints, timer expiry, pause/resume, and referee undo. Coaches are blocked from all draft and equip actions. Captains (or sole players when no captain is assigned) are the only team members who can perform draft actions.

## Reducers

### start_draft

**Purpose:** Creates the MatchSession, MatchResultRecord, and MatchResultParticipant rows, assigns auto-captains, and transitions the lobby from Waiting to Drafting.

**Permission:** Host, Admin, or Moderator (ensureHostOrAbove) _Superseded in Phase S10b execution (DECISIONS.md A80)._

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| lobbyId | u32 | Yes | Target lobby ID |

**Flow:**
1. Authenticate caller; verify host/admin/moderator permission on the lobby
2. Verify lobby is in `Waiting` stage
3. Gather all Blue+Red members; filter to non-coach players only
4. Reject if any non-coach player is not confirmed (D-29)
5. Reject if either team has zero non-coach players
6. If `autoRandomPick=true`, validate every non-coach player has an active HSR account with at least one character (D-43b)
7. Build draft sequence: Classic mode uses `buildClassicSequence(banMode)`, Auction mode uses `buildAuctionBanSequence(banMode)` (ban steps only)
8. Auto-assign captains (D-30): for each team, if no player has `isCaptain=true`, set the first non-coach player as captain
9. Insert `MatchSession` row with initial budgets from lobby settings, `turnIndex=0`, timer initialized
10. Determine `refereeFullControl` from referee's slot (spectator slot = full control, team slot = false) (D-44)
11. Insert `MatchResultRecord` with `status=Pending`
12. Insert `MatchResultParticipant` rows for every non-coach Blue+Red member (re-reads members to capture updated isCaptain)
13. Transition lobby stage to `Drafting`
14. Insert system chat message: "Draft has started!"

**Expected State Changes:**
- `MatchSession` inserted (lobbyId PK)
- `MatchResultRecord` inserted (autoInc id)
- `MatchResultParticipant` rows inserted (one per non-coach team member)
- `LobbyMember.isCaptain` updated for auto-assigned captains
- `Lobby.stage` = Drafting
- `ChatMessage` inserted (system message)

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Lobby not found | "Lobby not found." |
| Caller not host/admin/mod | Permission error from ensureHostOrAbove _Superseded in Phase S10b execution (DECISIONS.md A80)._ |
| Not in Waiting stage | Stage assertion error |
| Unconfirmed non-coach player exists | "All Blue and Red players must be confirmed before starting." |
| Blue team has no non-coach players | "Blue team must have at least one non-coach player." |
| Red team has no non-coach players | "Red team must have at least one non-coach player." |
| autoRandomPick + player missing active HSR account | "Player #N has no active HSR account. autoRandomPick requires all players to have characters." _Superseded in Phase S10e execution (backend audit 2026-11-09, lobby finding 9)._ |
| autoRandomPick + player has no characters | "Player #N has no characters on their active HSR account. autoRandomPick requires all players to have characters." _Superseded in Phase S10e execution (backend audit 2026-11-09, lobby finding 9)._ |

---

### pick_character

**Purpose:** Records a character pick on the current Classic draft turn.

**Permission:** Captain of the team whose turn it is (or any non-coach team member if no captain assigned)

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| lobbyId | u32 | Yes | Target lobby ID |
| characterName | string | Yes | Character to pick |
| eidolon | u8 | Yes | Eidolon level (0-6) |

**Flow:**
1. Authenticate caller; verify lobby member
2. Verify lobby is in `Drafting` stage
3. Coach guard: reject if caller's slot is a coach slot (D-39/MOUS-03)
4. Turn validation: `draftSequence[turnIndex]` must exist, `actionRequired` must be `Pick`, `teamTurn` must match caller's team
5. Captain check: if team has a captain, only the captain can pick
6. If `allowMirrorPicks=false`: reject if characterName already appears in a Pick step _Superseded in Phase S10d execution (DECISIONS.md A87)._
7. Always reject if characterName appears in a Ban step (bans are never bypassed)
8. If `requireOwnership=true`: validate character ownership (D-40)
9. Look up cost from `HsrCharacterCost` table using (characterName, eidolon, costSetId, gameMode) -- EMPTY costs 0
10. Insert `MatchSessionStep` with action=Pick, payload includes costPaid
11. Advance `turnIndex` by 1; reset timer
12. If Classic draft complete (newTurnIndex >= sequence length): transition lobby to `Equipping`
13. If Auction ban phase complete: set `isAuctionPhase=true`

**Expected State Changes:**
- `MatchSessionStep` inserted (Pick action)
- `MatchSession.turnIndex` incremented
- `MatchSession.timerState.turnStartAt` reset
- `Lobby.stage` = Equipping (if Classic draft complete)
- `MatchSession.isAuctionPhase` = true (if Auction bans complete)

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Lobby not found | "Lobby not found." |
| Session not found | "Draft session not found." |
| Wrong stage | Stage assertion error |
| Caller is coach | "Coaches cannot perform draft actions." |
| No more steps | "No more steps in draft sequence." |
| Current turn is not Pick | "Current turn is not a Pick." |
| Wrong team's turn | "It is not your team's turn to pick." |
| Not captain (but captain exists) | "Only the team captain can pick characters." |
| Character already picked (mirror off) | "Character already picked." |
| Character banned | "Character is banned and cannot be picked." |
| Ownership validation fails | "You do not own this character." (or custom reason) |

**Phase S4 execution (DECISIONS.md A22(3), F9):** after the membership check the reducer throws "Draft is paused." while `timerState.isPaused`; the Pick step takes `sequence = getNextSequence(lobbyId)` (max existing + 1), not `turnIndex`.

---

### ban_character

**Purpose:** Records a character ban on the current draft turn.

**Permission:** Captain of the team whose turn it is (or any non-coach team member if no captain assigned)

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| lobbyId | u32 | Yes | Target lobby ID |
| characterName | string | Yes | Character to ban |

**Flow:**
1. Authenticate caller; verify lobby member
2. Verify lobby is in `Drafting` stage
3. Coach guard: reject if caller's slot is a coach slot (D-39/MOUS-03)
4. Turn validation: `draftSequence[turnIndex]` must exist, `actionRequired` must be `Ban`, `teamTurn` must match caller's team
5. Captain check: if team has a captain, only the captain can ban
6. Reject if character already banned
7. Reject if character already picked
8. Insert `MatchSessionStep` with action=Ban
9. Advance `turnIndex` by 1; reset timer
10. If Auction ban phase complete: set `isAuctionPhase=true`

**Expected State Changes:**
- `MatchSessionStep` inserted (Ban action)
- `MatchSession.turnIndex` incremented
- `MatchSession.timerState.turnStartAt` reset
- `MatchSession.isAuctionPhase` = true (if Auction bans complete)

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Lobby not found | "Lobby not found." |
| Session not found | "Draft session not found." |
| Wrong stage | Stage assertion error |
| Caller is coach | "Coaches cannot perform draft actions." |
| No more steps | "No more steps in draft sequence." |
| Current turn is not Ban | "Current turn is not a Ban." |
| Wrong team's turn | "It is not your team's turn to ban." |
| Not captain (but captain exists) | "Only the team captain can ban characters." |
| Character already banned | "Character already banned." |
| Character already picked | "Character already picked and cannot be banned." |

**Phase S4 execution (DECISIONS.md A22(3), F9):** after the membership check the reducer throws "Draft is paused." while `timerState.isPaused`; the Ban step takes `sequence = getNextSequence(lobbyId)`.

---

### timer_expiry_classic

**Purpose:** Handles turn timer expiry during Classic draft (or Auction ban phase). Auto-picks EMPTY (or random character if autoRandomPick) on pick turns; auto-bans SKIP (or random character if autoRandomPick) on ban turns.

**Permission:** Any authenticated lobby member (timer expiry is client-driven, server validates elapsed time)

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| lobbyId | u32 | Yes | Target lobby ID |

**Flow:**
1. Authenticate caller
2. Verify lobby is in `Drafting` stage
3. Server-side timer validation: elapsed time since `turnStartAt` must be >= `standardTurnSeconds * 1000` ms _Superseded in Phase S10f execution (backend audit 2026-11-09, draft finding 5 (bug F10))._
4. Read current step from `draftSequence[turnIndex]`
5. **If Pick turn:**
   - Default: `characterName="EMPTY"`, `eidolon=0`
   - If `autoRandomPick=true`: build available pool — Phase 12.3 D-I-01/02: if `requireOwnership=true`, pool is union of characters from all `LobbyMemberAccount` rows for `(lobbyId, userId)` for each acting team member (migrated from `HsrAccount.isActive` global account); if `requireOwnership=false`, pool is all cost table characters for the game mode — exclude banned+picked, deterministic hash `(turnIndex * 31 + lobbyId) % poolSize`
   - Insert Pick step with `actorUserId=0` (system), `costPaid=0` _Superseded in Phase S10d execution (DECISIONS.md A86)._
6. **If Ban turn:**
   - Default: `characterName="SKIP"`
   - If `autoRandomPick=true`: same deterministic hash from available pool (same LobbyMemberAccount-based pool when requireOwnership=true)
   - Insert Ban step with `actorUserId=0` (system)
7. Advance `turnIndex` by 1; reset timer
8. If Classic draft complete: transition to `Equipping`
9. If Auction bans complete: set `isAuctionPhase=true`

**Expected State Changes:**
- `MatchSessionStep` inserted (system actor, userId=0)
- `MatchSession.turnIndex` incremented
- `Lobby.stage` = Equipping (if Classic complete)
- `MatchSession.isAuctionPhase` = true (if Auction bans complete)

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Lobby not found | "Lobby not found." |
| Session not found | "Draft session not found." |
| Wrong stage | Stage assertion error |
| Timer not yet expired | "Turn timer has not yet expired." |
| No more steps | "No more steps in draft sequence." |

**Phase S4 execution (F3, DECISIONS.md A22(3), F9):** the caller must be a lobby member (`ensureLobbyMember`: "You are not a member of this lobby.") and the reducer throws "Draft is paused." while `timerState.isPaused`; the auto Pick/Ban step takes `sequence = getNextSequence(lobbyId)`. The "Timer expiry with paused timer: not validated" edge case below is superseded.

---

### nominate_character

**Purpose:** Nominating team puts a character up for auction at the base cost from the cost table. The nominator is automatically the first bidder at base cost.

**Permission:** Captain of the nominating team (or any non-coach team member if no captain assigned)

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| lobbyId | u32 | Yes | Target lobby ID |
| characterName | string | Yes | Character to nominate |
| eidolon | u8 | Yes | Eidolon level (0-6) |

**Flow:**
1. Authenticate caller; verify lobby member
2. Verify lobby is in `Drafting` stage
3. Coach guard (D-39/MOUS-03)
4. Verify `isAuctionPhase=true`
5. Reject if `currentNomination` is not null (auction already in progress)
6. Reject if caller is spectator
7. Turn check: caller's team must match `nextNominatorTeam`
8. Captain check
9. If characterName is not "EMPTY": reject if character already won (AuctionSold), reject if banned
10. Look up base cost from `HsrCharacterCost` filtered by `(characterName, gameMode, draftMode=Auction, costSetId)` and read `costs.eN` (D-53 retained, Phase 15.4 shape). EMPTY = 0. Tuple-filter with enum struct unsupported (A2_FALLBACK_ITER): reducer uses `cost_set_id` btree filter + predicate match on `draftMode.tag === 'Auction'`.
11. Budget check: base cost must not exceed nominating team's `teamBlue/RedCharBudget` (D-53)
12. Insert `Nominate` step
13. Update session: `currentNomination=characterName`, `currentBidAmount=baseCost`, `currentBidTeam=nominatingTeam`; reset timer

**Expected State Changes:**
- `MatchSessionStep` inserted (Nominate action)
- `MatchSession.currentNomination` set
- `MatchSession.currentBidAmount` = base cost
- `MatchSession.currentBidTeam` = nominating team
- `MatchSession.timerState.turnStartAt` reset

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Lobby not found | "Lobby not found." |
| Session not found | "Draft session not found." |
| Wrong stage | Stage assertion error |
| Caller is coach | "Coaches cannot perform draft actions." |
| Not auction phase | "Auction phase not active." |
| Auction already in progress | "An auction is already in progress." |
| Caller is spectator | "Spectators cannot nominate characters." |
| Wrong team's turn | "It is not your team's turn to nominate." |
| Not captain (but captain exists) | "Only the team captain can nominate characters." |
| Character already won | "Character has already been won in this auction." |
| Character banned | "Character is banned and cannot be nominated." |
| Budget insufficient | "Not enough budget to nominate this character." |

**Phase S4 execution (DECISIONS.md A22(3)):** after the membership check the reducer throws "Draft is paused." while `timerState.isPaused`.

---

### place_bid

**Purpose:** Raises the current bid on an active auction. Bidder must be on the opposite team from the current bid holder.

**Permission:** Captain of the opposing team (or any non-coach team member if no captain assigned)

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| lobbyId | u32 | Yes | Target lobby ID |
| bidAmount | f32 | Yes | New bid amount |

**Flow:**
1. Authenticate caller; verify lobby member
2. Verify lobby is in `Drafting` stage
3. Coach guard (D-39/MOUS-03)
4. Verify `isAuctionPhase=true`
5. Reject if no `currentNomination` (no active auction)
6. Reject if caller is spectator
7. Reject if caller's team is the same as `currentBidTeam` (must be opposite team, alternating bids D-48)
8. Captain check
9. Minimum raise check: bidAmount >= `currentBidAmount + lobby.minimumBidRaise` (D-53)
10. Budget cap check: bidAmount <= caller's team `charBudget`
11. Insert `Bid` step with amount and targetCharacter
12. Update session: `currentBidAmount=bidAmount`, `currentBidTeam=caller's team`; reset timer

**Expected State Changes:**
- `MatchSessionStep` inserted (Bid action)
- `MatchSession.currentBidAmount` updated
- `MatchSession.currentBidTeam` updated to bidder's team
- `MatchSession.timerState.turnStartAt` reset

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Lobby not found | "Lobby not found." |
| Session not found | "Draft session not found." |
| Wrong stage | Stage assertion error |
| Caller is coach | "Coaches cannot perform draft actions." |
| Not auction phase | "Auction phase not active." |
| No active auction | "No auction in progress." |
| Caller is spectator | "Spectators cannot bid." |
| Same team as bid holder | "Your team already holds the current bid. Wait for the other team to respond." |
| Not captain (but captain exists) | "Only the team captain can place bids." |
| Bid too low | "Bid must be at least {min} (current bid {current} + minimum raise {raise})." |
| Bid exceeds budget | "Bid exceeds your remaining character budget." |

**Phase S4 execution (DECISIONS.md A22(3)):** after the membership check the reducer throws "Draft is paused." while `timerState.isPaused`.

---

### pass_bid

**Purpose:** The opposing team concedes the auction. The current bid holder wins the character at their last bid amount. Implements steal-skip logic (D-46).

**Permission:** Captain of the opposing team (team opposite to currentBidTeam)

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| lobbyId | u32 | Yes | Target lobby ID |

**Flow:**
1. Authenticate caller; verify lobby member
2. Verify lobby is in `Drafting` stage
3. Coach guard (D-39/MOUS-03)
4. Verify `isAuctionPhase=true`; reject if no `currentNomination`
5. Reject if caller is spectator
6. Reject if caller's team is the same as `currentBidTeam` (passer must be the expected responder)
7. Captain check
8. Resolve auction: `currentBidTeam` wins at `currentBidAmount`
9. Look up eidolon from the most recent Nominate step for this character
10. Insert `AuctionSold` step
11. Deduct `winningAmount` from winning team's `charBudget`; increment their `charactersWon`
12. **Steal-skip logic (D-46):**
    - If nominating team == winning team: other team nominates next (normal rotation)
    - If nominating team != winning team: nominating team keeps their turn (steal -- opponent "spent" the nominator's slot)
13. Clear auction state: `currentNomination=null`, `currentBidAmount=null`, `currentBidTeam=Spectator`
14. If both teams reached 8 characters won: transition to `Equipping`

**Expected State Changes:**
- `MatchSessionStep` inserted (AuctionSold action)
- `MatchSession.teamBlue/RedCharBudget` decremented by winning amount
- `MatchSession.blue/redCharactersWon` incremented by 1
- `MatchSession.currentNomination` cleared
- `MatchSession.nextNominatorTeam` updated per steal-skip logic
- `Lobby.stage` = Equipping (if both teams reached 8 characters)

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Lobby not found | "Lobby not found." |
| Session not found | "Draft session not found." |
| Wrong stage | Stage assertion error |
| Caller is coach | "Coaches cannot perform draft actions." |
| Not auction phase | "Auction phase not active." |
| No active auction | "No auction in progress." |
| Caller is spectator | "Spectators cannot pass bids." |
| Same team as bid holder | "Your team holds the current bid. The other team must respond." |
| Not captain (but captain exists) | "Only the team captain can pass the bid." |

**Phase S4 execution (DECISIONS.md A22(3)):** after the membership check the reducer throws "Draft is paused." while `timerState.isPaused`.

---

### timer_expiry_auction

**Purpose:** Handles turn timer expiry during the auction phase. Auto-nominates EMPTY if no active nomination; auto-passes for the expected bidding team if a nomination is active.

**Permission:** Any authenticated lobby member (client-driven, server validates elapsed time)

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| lobbyId | u32 | Yes | Target lobby ID |

**Flow:**
1. Authenticate caller
2. Verify lobby is in `Drafting` stage; verify `isAuctionPhase=true`
3. Server-side timer validation: elapsed time >= `standardTurnSeconds * 1000` ms
4. **If no `currentNomination` (nomination phase):**
   - Insert `Nominate` step for EMPTY CHARACTER with `actorUserId=0` (system)
   - Set auction state: `currentNomination="EMPTY"`, `currentBidAmount=0`, `currentBidTeam=nextNominatorTeam`
5. **If `currentNomination` exists (bidding phase):**
   - Current bid holder wins by default (auto-pass for the opposing team)
   - Look up eidolon from most recent Nominate step
   - Insert `AuctionSold` step with `actorUserId=0` (system)
   - Deduct budget, increment won count
   - Apply steal-skip logic (D-46)
   - Clear auction state; check if auction complete (both teams at 8 characters)
   - If complete: transition to `Equipping`

**Expected State Changes:**
- `MatchSessionStep` inserted (system actor, userId=0)
- If nomination: `MatchSession` auction state set for EMPTY
- If bidding: `MatchSession` budget decremented, characters won incremented, auction cleared
- `Lobby.stage` = Equipping (if auction complete)

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Lobby not found | "Lobby not found." |
| Session not found | "Draft session not found." |
| Wrong stage | Stage assertion error |
| Not auction phase | "Auction phase not active." |
| Timer not yet expired | "Turn timer has not yet expired." |

**Phase S4 execution (F3, DECISIONS.md A22(3)):** the caller must be a lobby member (`ensureLobbyMember`: "You are not a member of this lobby.") and the reducer throws "Draft is paused." while `timerState.isPaused`, before the auction-phase and elapsed-time checks.

---

### undo_last_step

**Purpose:** Referee undoes the most recent draft step. Deletes the last step, decrements turnIndex, inserts an Undo audit record.

**Permission:** Referee only, when `refereeCanUndo=true` on the lobby (D-60)

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| lobbyId | u32 | Yes | Target lobby ID |

**Flow:**
1. Authenticate caller; verify lobby member
2. Verify lobby is in `Drafting` stage
3. Reject if caller is not referee OR `refereeCanUndo=false`
4. Reject if `turnIndex=0` (nothing to undo)
5. Find the highest-sequence step; delete it
6. Insert `Undo` audit step with `originalSequenceId = turnIndex - 1`
7. Decrement `turnIndex` by 1
8. If session was in auction phase and new turnIndex falls back into ban sequence range: set `isAuctionPhase=false`
9. Reset timer

**Expected State Changes:**
- Most recent `MatchSessionStep` deleted
- New `MatchSessionStep` inserted (Undo audit)
- `MatchSession.turnIndex` decremented
- `MatchSession.isAuctionPhase` may revert to false if undo crosses phase boundary

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Lobby not found | "Lobby not found." |
| Session not found | "Draft session not found." |
| Wrong stage | Stage assertion error |
| Not referee or undo disabled | "Only referees with undo permission can undo." |
| No steps to undo (turnIndex=0) | "No steps to undo." |
| No step rows found | "No steps to undo." |

**Phase S4 execution (F9, DECISIONS.md A22(2)):** steps 5–8 are superseded. After the `turnIndex=0` check the reducer throws "Nothing to undo right now." while `timerState.isPaused` and "Undo is not available during the auction phase." when `isAuctionPhase`. It deletes the highest-sequence **Pick or Ban** step (Pause and Undo audit rows are skipped; "Nothing to undo right now." if none), inserts the Undo record with `originalSequenceId = <deleted step's sequence>` and `sequence = getNextSequence(lobbyId)`, decrements `turnIndex` and resets the timer. `isAuctionPhase` is never reverted by undo.

---

### pause_draft

**Purpose:** Pauses the draft timer. Players get 3 pauses per team (when `allowPlayerPause=true`). Referees get unlimited pauses (when `refereeCanPause=true`).

**Permission:** Referee (with refereeCanPause) or non-coach/non-spectator player (with allowPlayerPause)

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| lobbyId | u32 | Yes | Target lobby ID |

**Flow:**
1. Authenticate caller; verify lobby member
2. Verify lobby is in `Drafting` stage
3. Reject if already paused
4. Reject if caller is spectator (and not referee)
5. If caller is referee with `refereeCanPause=true`: unlimited pauses, skip team counter
6. If caller is non-referee player: require `allowPlayerPause=true`, enforce 3-per-team limit
7. Calculate `timeRemainingMs` from elapsed time and accumulated pause time _Superseded in Phase S10f execution (backend audit 2026-11-09, draft finding 5 (bug F10))._
8. Insert `Pause` step with `timeRemainingMs` and `isAutoPause=false`
9. Set `timerState.isPaused=true`
10. If non-referee pause: increment `pausesUsedBlue` or `pausesUsedRed`

**Expected State Changes:**
- `MatchSessionStep` inserted (Pause action)
- `MatchSession.timerState.isPaused` = true
- `MatchSession.pausesUsedBlue/Red` incremented (non-referee pauses only)

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Lobby not found | "Lobby not found." |
| Session not found | "Draft session not found." |
| Wrong stage | Stage assertion error |
| Already paused | "Draft is already paused." |
| Spectator (non-referee) | "Spectators cannot pause the draft." |
| Player pause disabled | "Player pausing is not allowed in this lobby." |
| Blue team exhausted | "Blue team has used all 3 pauses." |
| Red team exhausted | "Red team has used all 3 pauses." |

**Phase S4 execution (F9, DECISIONS.md A22a, F5):** the Pause step takes `sequence = getNextSequence(lobbyId)` instead of `turnIndex`, so it never shares a sequence with a draft step. The auto-pause on disconnect is no longer written by `client_disconnected`: `run_referee_transfer_check` writes it 15 s after the player's last device disconnected, only for an offline team player, never for a spectator or coach (`docs/lobby/contract.md`).

---

### resume_draft

**Purpose:** Resumes a paused draft. Restores the timer to the exact point where it was paused using `accumulatedPauseMs`.

**Permission:** Referee or the original player who paused (D-62)

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| lobbyId | u32 | Yes | Target lobby ID |

**Flow:**
1. Authenticate caller; verify lobby member
2. Verify lobby is in `Drafting` stage
3. Reject if not currently paused
4. Find most recent Pause step to identify original pauser and stored `timeRemainingMs`
5. Allow resume if caller is referee OR is the original pauser _Superseded in Phase S10c execution (DECISIONS.md A85)._
6. Set `timerState.isPaused=false`, `turnStartAt=ctx.timestamp`, `accumulatedPauseMs=timeRemainingMs` (so timer resumes from paused position) _Superseded in Phase S10f execution (backend audit 2026-11-09, draft finding 5 (bug F10))._

**Expected State Changes:**
- `MatchSession.timerState.isPaused` = false
- `MatchSession.timerState.turnStartAt` reset to current timestamp
- `MatchSession.timerState.accumulatedPauseMs` = timeRemainingMs from Pause step _Superseded in Phase S10f execution (backend audit 2026-11-09, draft finding 5 (bug F10))._

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Lobby not found | "Lobby not found." |
| Session not found | "Draft session not found." |
| Wrong stage | Stage assertion error |
| Not paused | "Draft is not paused." |
| Not referee and not original pauser | "Only the referee or the player who paused can resume the draft." |

---

### equip_lightcone

**Purpose:** Records a lightcone equip on a character during the Equipping stage. Deducts the LC cost from the team's LC budget.

**Permission:** Captain (or sole player if no captain). Non-coach, non-spectator. _Superseded in Phase S10b execution (DECISIONS.md A78)._

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| lobbyId | u32 | Yes | Target lobby ID |
| characterName | string | Yes | Character to equip the LC on |
| lightconeName | string | Yes | Lightcone name |
| superimposition | u8 | Yes | Superimposition level (1-5) |

**Flow:**
1. Authenticate caller; verify lobby member
2. Verify lobby is in `Equipping` stage
3. Coach guard (D-39): reject coaches
4. Reject spectators
5. Look up LC cost from `HsrLightconeCost` filtered by `(lightconeName, gameMode, draftMode=Classic, costSetId)` and read `costs.sN` (Phase 15.4 D-10/D-11, Pitfall 6 regression guard). LC equip happens in the classic draft context regardless of char-phase draftMode. Tuple-filter with enum struct unsupported (A2_FALLBACK_ITER): `cost_set_id` btree filter + predicate match on `draftMode.tag === 'Classic'`
6. Budget check: LC cost must not exceed team's `teamBlue/RedLcBudget` (D-55)
7. Insert `EquipLightcone` step with costPaid
8. Deduct cost from team's LC budget

**Expected State Changes:**
- `MatchSessionStep` inserted (EquipLightcone action)
- `MatchSession.teamBlue/RedLcBudget` decremented by LC cost

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Lobby not found | "Lobby not found." |
| Session not found | "Match session not found." |
| Wrong stage | Stage assertion error |
| Caller is coach | "Coaches cannot equip lightcones." _Superseded in Phase S10b execution (DECISIONS.md A78)._ |
| Caller is spectator | "Spectators cannot equip lightcones." _Superseded in Phase S10b execution (DECISIONS.md A78)._ |
| Budget insufficient | "Not enough LC budget." |

---

### arrange_lineup

> **Superseded (Phase S7 execution, A21, backlog #3):** now `arrange_lineup(lobbyId, teamSide, groups)`, captain of that team or a referee only, a live `MatchLineup` row, no step. See "Lineup Groups (Phase S7 execution)" below.

**Purpose:** Records the character position order for a team during the Equipping stage.

**Permission:** Captain (or sole player if no captain). Non-coach, non-spectator.

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| lobbyId | u32 | Yes | Target lobby ID |
| positions | string | Yes | JSON array of character name strings |

**Flow:**
1. Authenticate caller; verify lobby member
2. Verify lobby is in `Equipping` stage
3. Coach guard (D-39): reject coaches
4. Reject spectators
5. Validate `positions` is a valid JSON array of strings
6. Insert `ArrangeLineup` step

**Expected State Changes:**
- `MatchSessionStep` inserted (ArrangeLineup action)

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Lobby not found | "Lobby not found." |
| Wrong stage | Stage assertion error |
| Caller is coach | "Coaches cannot arrange lineups." |
| Caller is spectator | "Spectators cannot arrange lineups." |
| Invalid JSON | "positions must be a valid JSON array of strings." |

---

### confirm_lineup

> **Superseded (Phase S7 execution, A21, backlog #3):** now `confirm_lineup(lobbyId, teamSide)`, same callers as `arrange_lineup`, Auction surcharge gate, the step carries the groups. See "Lineup Groups (Phase S7 execution)" below.

**Purpose:** Records lineup confirmation for a team during the Equipping stage.

**Permission:** Captain (or sole player if no captain). Non-coach, non-spectator.

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| lobbyId | u32 | Yes | Target lobby ID |

**Flow:**
1. Authenticate caller; verify lobby member
2. Verify lobby is in `Equipping` stage
3. Coach guard (D-39): reject coaches
4. Reject spectators
5. Insert `ConfirmLineup` step with `confirmed=true`

**Expected State Changes:**
- `MatchSessionStep` inserted (ConfirmLineup action)

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Lobby not found | "Lobby not found." |
| Wrong stage | Stage assertion error |
| Caller is coach | "Coaches cannot confirm lineups." |
| Caller is spectator | "Spectators cannot confirm lineups." |

---

### advance_stage

**Purpose:** Host manually transitions the lobby between sub-phases: Drafting to Equipping, or Equipping to Scoring. Scoring to Finished is blocked (must use finalize_match_result).

**Permission:** Host, Admin, or Moderator (ensureHostOrAbove) _Superseded in Phase S10b execution (DECISIONS.md A80)._

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| lobbyId | u32 | Yes | Target lobby ID |

**Flow:**
1. Authenticate caller; verify host/admin/moderator
2. **Drafting to Equipping (D-50):**
   - Budget rollover: add remaining `charBudget` to `lcBudget` for each team
   - Set `charBudget` to 0 for both teams
   - Transition lobby stage to `Equipping`
   - Insert system chat message: "Draft complete. Stage: Equipping"
3. **Equipping to Scoring (D-58):**
   - Transition lobby stage to `Scoring`
   - Insert system chat message: "Lineups set. Stage: Scoring"
4. **Scoring:** Blocked -- throws error directing caller to use finalize_match_result
5. **Other stages:** Throws generic error

**Expected State Changes:**
- Drafting to Equipping: `MatchSession.teamBlue/RedLcBudget` += charBudget, `charBudget` zeroed, `Lobby.stage` = Equipping, system chat inserted
- Equipping to Scoring: `Lobby.stage` = Scoring, system chat inserted

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Lobby not found | "Lobby not found." |
| Caller not host/admin/mod | Permission error |
| Session not found (Drafting) | "Match session not found." |
| Currently in Scoring | "Use finalize_match_result to transition from Scoring to Finished." (legacy error text — finalization actually cascade-deletes the lobby via AwaitingResult) |
| Other stage | "Cannot advance stage from {stage}." |

---

## Acceptance Scenarios

### Classic Draft: Happy Path (BanMode Six)

**Given:** Lobby in Waiting stage with 1 confirmed Blue player, 1 confirmed Red player, Classic mode, BanMode Six, no captains assigned
**When:** Host calls `start_draft(lobbyId)`
**Then:** MatchSession created with 22-step sequence, both players auto-captained. Lobby stage = Drafting. MatchResultRecord created with status=Pending.

**When:** Blue captain calls `ban_character(lobbyId, "Kafka")`
**Then:** Ban step recorded at sequence 0. turnIndex advances to 1.

**When:** Red captain calls `ban_character(lobbyId, "Jingliu")`
**Then:** Ban step recorded at sequence 1. turnIndex advances to 2.

**When:** Players complete all 22 turns (6 bans + 16 picks in BanMode Six pattern)
**Then:** After last pick, lobby automatically transitions to Equipping.

### Classic Draft: Timer Expiry Auto-Pick

**Given:** Active Classic draft, current step is Pick for Blue, autoRandomPick=false
**When:** Turn timer expires and any member calls `timer_expiry_classic(lobbyId)`
**Then:** Pick step recorded with characterName="EMPTY", eidolon=0, actorUserId=0 (system), costPaid=0. turnIndex advances.

### Classic Draft: Timer Expiry Auto-Ban

**Given:** Active Classic draft, current step is Ban for Red, autoRandomPick=false
**When:** Turn timer expires and member calls `timer_expiry_classic(lobbyId)`
**Then:** Ban step recorded with characterName="SKIP", actorUserId=0 (system). turnIndex advances.

### Classic Draft: Timer Expiry with autoRandomPick

**Given:** Active Classic draft, current step is Pick for Blue, autoRandomPick=true, requireOwnership=false
**When:** Turn timer expires
**Then:** System deterministically selects from available pool using hash `(turnIndex * 31 + lobbyId) % poolSize`. Pick step recorded with selected character, actorUserId=0.

### Classic Draft: Timer Expiry Auto-Pick Uses Match-Selected Account (Phase 12.3 D-I)

**Given:** Active Classic draft, autoRandomPick=true, requireOwnership=true; Blue player's globally-active HSR account has "Kafka" but their match-selected account (LobbyMemberAccount) has "Jingliu" and "Blade"
**When:** Turn timer expires on Blue's Pick turn
**Then:** Auto-pick pool is built from the match-selected account (LobbyMemberAccount rows) — contains "Jingliu" and "Blade", NOT "Kafka". System deterministically picks from {Jingliu, Blade}. Pick recorded with actorUserId=0.
Note: The globally-active account (HsrAccount.isActive=true) is NOT consulted. Pool reflects match selection, not global account preference. (D-I-01/02, Phase 12.3)

### Classic Draft: Mirror Picks

**Given:** Active Classic draft, allowMirrorPicks=true, Blue has already picked "Kafka"
**When:** Red captain calls `pick_character(lobbyId, "Kafka", 0)`
**Then:** Pick succeeds (mirror allowed). Kafka appears twice in steps.

**Given:** Active Classic draft, allowMirrorPicks=false, Blue has already picked "Kafka"
**When:** Red captain calls `pick_character(lobbyId, "Kafka", 0)`
**Then:** Throws "Character already picked."

### Classic Draft: Banned Character Cannot Be Picked

**Given:** Active Classic draft, "Kafka" was banned in ban phase
**When:** Blue captain calls `pick_character(lobbyId, "Kafka", 0)`
**Then:** Throws "Character is banned and cannot be picked." (even with allowMirrorPicks=true)

### Auction Draft: Nomination and Bidding

**Given:** Lobby in Auction mode, BanMode Four, ban phase complete, isAuctionPhase=true, nextNominatorTeam=Blue, characterBudget=100
**When:** Blue captain calls `nominate_character(lobbyId, "Kafka", 0)` (base cost 10)
**Then:** Nominate step recorded. MatchSession: currentNomination="Kafka", currentBidAmount=10, currentBidTeam=Blue.

**When:** Red captain calls `place_bid(lobbyId, 15)` (minimumBidRaise=1, so min bid=11)
**Then:** Bid step recorded. currentBidAmount=15, currentBidTeam=Red.

**When:** Blue captain calls `pass_bid(lobbyId)`
**Then:** AuctionSold step: Kafka sold to Red for 15. teamRedCharBudget decremented by 15. redCharactersWon incremented. Steal-skip: Blue nominated and Red won, so Blue keeps nomination turn (steal).

### Auction Draft: Steal-Skip Logic

**Given:** Blue nominates, Blue wins the auction (Red passes immediately)
**Then:** Normal rotation: nextNominatorTeam = Red

**Given:** Blue nominates, Red outbids and wins the auction (Blue passes)
**Then:** Steal: nextNominatorTeam = Blue (nominator keeps turn because opponent "spent" their slot)

### Auction Draft: End at 8 Characters Per Team

**Given:** Auction phase, blueCharactersWon=7, redCharactersWon=8
**When:** Blue's 8th character is sold (AuctionSold)
**Then:** Both teams at 8+. Lobby transitions to Equipping.

### Auction Draft: Budget Enforcement

**Given:** Auction phase, Blue's charBudget=5, base cost for "Kafka"=10
**When:** Blue captain calls `nominate_character(lobbyId, "Kafka", 0)`
**Then:** Throws "Not enough budget to nominate this character."

**Given:** Auction phase, Red's charBudget=12, currentBidAmount=10, minimumBidRaise=5
**When:** Red captain calls `place_bid(lobbyId, 15)` (min=15, Red has 12)
**Then:** Throws "Bid exceeds your remaining character budget."

### Auction Draft: Timer Expiry (Nomination Phase)

**Given:** Auction phase, no currentNomination, nextNominatorTeam=Blue
**When:** Timer expires
**Then:** System auto-nominates EMPTY CHARACTER at cost 0 for Blue. currentNomination="EMPTY", currentBidTeam=Blue.

### Auction Draft: Timer Expiry (Bidding Phase)

**Given:** Auction phase, currentNomination="Kafka", currentBidTeam=Blue, currentBidAmount=10
**When:** Timer expires
**Then:** Auto-pass for Red. AuctionSold: Kafka sold to Blue for 10. Budget decremented, won count incremented.

### Coach Blocked From All Actions

**Given:** Blue coach slot member in an active draft
**When:** Coach calls `pick_character`, `ban_character`, `nominate_character`, `place_bid`, `pass_bid`, `equip_lightcone`, `arrange_lineup`, or `confirm_lineup`
**Then:** Each throws "Coaches cannot perform draft actions." (or the action-specific variant like "Coaches cannot equip lightcones.") _Superseded in Phase S10b execution (DECISIONS.md A78)._

### Referee Undo

**Given:** Active draft, refereeCanUndo=true, referee is a lobby member, turnIndex=3
**When:** Referee calls `undo_last_step(lobbyId)`
**Then:** Highest-sequence step deleted. Undo audit step inserted with originalSequenceId=2. turnIndex decremented to 2. Timer reset.

### Referee Undo: Cannot Undo at turnIndex=0

**Given:** Draft just started, turnIndex=0
**When:** Referee calls `undo_last_step(lobbyId)`
**Then:** Throws "No steps to undo."

### Referee Undo: Reverts Auction Phase Transition

**Given:** Auction mode, ban phase just completed (isAuctionPhase=true), turnIndex = banSequenceLength
**When:** Referee calls `undo_last_step(lobbyId)`
**Then:** turnIndex decremented below ban sequence length. isAuctionPhase reverts to false.

### Pause and Resume: Player

**Given:** Active draft, allowPlayerPause=true, pausesUsedBlue=0
**When:** Blue player calls `pause_draft(lobbyId)`
**Then:** Pause step recorded with timeRemainingMs. timerState.isPaused=true. pausesUsedBlue incremented to 1.

**When:** Same Blue player calls `resume_draft(lobbyId)`
**Then:** timerState.isPaused=false. accumulatedPauseMs = timeRemainingMs from Pause step. turnStartAt reset. _Superseded in Phase S10f execution (backend audit 2026-11-09, draft finding 5 (bug F10))._

### Pause and Resume: Referee

**Given:** Active draft, refereeCanPause=true
**When:** Referee calls `pause_draft(lobbyId)`
**Then:** Pause step recorded. timerState.isPaused=true. pausesUsedBlue and pausesUsedRed NOT incremented.

### Pause: 3-Per-Team Limit

**Given:** Active draft, allowPlayerPause=true, pausesUsedBlue=3
**When:** Blue player calls `pause_draft(lobbyId)`
**Then:** Throws "Blue team has used all 3 pauses."

### Equipping: Lightcone Budget

**Given:** Equipping stage, Blue's lcBudget=20, lightcone costs 15
**When:** Blue captain calls `equip_lightcone(lobbyId, "Kafka", "Patience Is All You Need", 1)` _Superseded in Phase S10b execution (DECISIONS.md A78)._
**Then:** EquipLightcone step recorded with costPaid=15. teamBlueLcBudget reduced to 5.

**When:** Blue captain tries to equip another LC costing 10
**Then:** Throws "Not enough LC budget."

### Equipping: Arrange and Confirm Lineup

**Given:** Equipping stage
**When:** Blue captain calls `arrange_lineup(lobbyId, '["Kafka","Jingliu","Blade","Bronya"]')`
**Then:** ArrangeLineup step recorded with positions JSON.

**When:** Blue captain calls `confirm_lineup(lobbyId)`
**Then:** ConfirmLineup step recorded with confirmed=true.
*Superseded (Phase S7 execution): see the lineup-group scenarios below.*

### Lineup Groups (Phase S7 execution, A21, backlog #3)
**Given:** Equipping, a Halves lobby, Blue drafted 8 characters
**When:** the Blue captain calls `arrange_lineup(lobbyId, Blue, '[[4 names],[4 names]]')`
**Then:** one live `MatchLineup` row for (lobby, game, Blue) holds the groups, the synergy surcharge and the live roster cost (hundredths), `isConfirmed = false`; no step is logged. Every drafted character must appear exactly once, in 2 groups of 4 (Thirds: 3 groups of 4); otherwise rejected with the first problem ("… is not a drafted character of this team, or is placed twice.", "A Thirds lineup has 3 groups.", "Every group has 4 characters.").

**When:** the same captain calls it again within `AbuseConfig.lineupMinIntervalMs` (250 ms)
**Then:** rejected: "Lineup changes are too frequent. Please wait a moment." (`LobbyMember.lastLineupAt`, stamped without an audit bump)

**When:** a teammate who is not the captain, or the Red captain, arranges Blue
**Then:** rejected: "Only the Blue captain or a referee can arrange the lineup." A referee (seated or not) may arrange and confirm either team.

**When:** the captain calls `confirm_lineup(lobbyId, Blue)`
**Then:** `isConfirmed = true`, the final `rosterCost` is stored (tie-break 1 reads it), and a `ConfirmLineup` step is logged with `{ confirmed: true, groups }` and `actorSlot = Blue` (the lineup's team, also when a spectator referee confirms). A later `arrange_lineup` clears the confirmation.

### Synergy Surcharge: The Herta + Argenti + Tribbie (Phase S7 execution, backlog #3)
**Given:** synergy pairs The Herta–Argenti +4 and The Herta–Tribbie +4 in the lobby's cost set (Classic)
**When:** all three are placed in one group
**Then:** `synergySurcharge = 800` (+8; Argenti–Tribbie is not a pair) and the roster cost includes it; splitting Tribbie into the other group gives +4.

### Auction: Over-Budget Lineup Cannot Be Confirmed (Phase S7 execution, backlog #3)
**Given:** an Auction lobby in Equipping whose lineup puts a +500 pair in one group while the team's remaining light-cone budget is 150
**When:** the captain arranges it, then confirms
**Then:** the arrangement is stored (shown red by the client); `confirm_lineup` is rejected: "The synergy surcharge exceeds the remaining light-cone budget; rearrange the lineup." After splitting the pair it confirms. The budget itself is not debited by the surcharge.

### Light Cones Equipped After confirm_lineup (Phase S7 execution, review fix, A21)
**Given:** both lineups confirmed in Equipping
**When:** the Blue captain equips a light cone costing 3
**Then:** Blue's `MatchLineup.rosterCost` rises by 300 hundredths and stays confirmed; the scored game uses the new cost (tie-break 1). In Auction, an equip whose cost plus the confirmed lineup's surcharge exceeds the LC budget is rejected ("Not enough LC budget: the confirmed lineup's synergy surcharge is reserved.").

### Eidolon Snapshot Under requireOwnership (Phase S7 execution, A43 CH-S6, ACCESS-SECURITY-OPS D.8.7)
**Given:** `requireOwnership = true`; the Blue captain selected two accounts owning Blue-1 at E6 and E3
**When:** the captain calls `pick_character(lobbyId, 'blue-1', eidolon 0)`
**Then:** the Pick payload records `eidolon = 6` (max over the selected accounts) and the cost is read at E6; the argument is ignored. With `requireOwnership = false` the argument stands. `nominate_character` resolves the same way (E0 when the nominator's accounts lack the character). `equip_lightcone` keeps its `superimposition` argument: light cones have no ownership data yet.

### Thirds Lobbies Draft 12 per Team (Phase S7 execution, A21)
**Given:** `lineupFormat = Thirds`
**When:** the draft starts
**Then:** Classic: the sequence holds 12 picks per team (the Halves sequence plus 8 picks R-B-B-R-R-B-B-R); Auction: the auction ends when both teams won 12 characters. Halves keeps 8.

### Budget Rollover on Drafting → Equipping (D-50)

D-50 applies to ALL Drafting→Equipping transitions: auto (last Classic pick, last Auction pass, timer expiry completions) and manual (`advance_stage`). Leftover `charBudget` is added to `lcBudget`; `charBudget` is zeroed for both teams.

**Given:** Drafting stage, Blue charBudget=30 remaining, Blue lcBudget=50
**When:** Last Classic pick completes (auto-transition) OR host calls `advance_stage(lobbyId)`
**Then:** Lobby transitions to Equipping. Blue lcBudget = 50 + 30 = 80. Blue charBudget = 0.

### Advance Stage: Scoring Blocked

**Given:** Lobby in Scoring stage
**When:** Host calls `advance_stage(lobbyId)`
**Then:** Throws "Use finalize_match_result to transition from Scoring to Finished." (Note: the error string is legacy — finalization actually cascade-deletes the lobby via AwaitingResult, not sets Finished.)

### System Chat on Stage Transitions

**Given:** Host calls `start_draft` _Superseded in Phase S10b execution (DECISIONS.md A80)._
**Then:** System chat message: "Draft has started!"

**Given:** Host calls `advance_stage` from Drafting _Superseded in Phase S10b execution (DECISIONS.md A80)._
**Then:** System chat message: "Draft complete. Stage: Equipping"

**Given:** Host calls `advance_stage` from Equipping _Superseded in Phase S10b execution (DECISIONS.md A80)._
**Then:** System chat message: "Lineups set. Stage: Scoring"

---

### Paused Draft Rejects Draft Actions (Phase S4 execution, A22(3))
**Given:** Active Classic draft, timerState.isPaused=true
**When:** The team on turn calls `pick_character` / `ban_character`; in an auction lobby `nominate_character` / `place_bid` / `pass_bid`
**Then:** Throws "Draft is paused." No step inserted, turnIndex unchanged.

### Timer Expiry by a Non-Member (Phase S4 execution, F3)
**Given:** Lobby #10 in Drafting, turn timer elapsed; user #99 is not a member
**When:** #99 calls `timer_expiry_classic(10)` (or `timer_expiry_auction`)
**Then:** Throws "You are not a member of this lobby." No EMPTY/SKIP step.

### Timer Expiry While Paused (Phase S4 execution, F3)
**Given:** Lobby #10 in Drafting, timerState.isPaused=true, `turnStartAt` older than `standardTurnSeconds`
**When:** A member calls `timer_expiry_classic(10)`
**Then:** Throws "Draft is paused." The paused team's turn is not consumed.

### Undo Skips the Pause Row (Phase S4 execution, F9)
**Given:** Steps Pick(seq 0), Pick(seq 1), Pause(seq 2); draft resumed; turnIndex=2
**When:** Referee calls `undo_last_step`
**Then:** Pick(seq 1) deleted; Undo record inserted with originalSequenceId=1 and sequence=3; turnIndex=1; the Pause row is untouched. The next pick takes sequence 4.

### Undo While Paused (Phase S4 execution, F9)
**Given:** Active draft, timerState.isPaused=true, turnIndex>0
**When:** Referee calls `undo_last_step`
**Then:** Throws "Nothing to undo right now."

### Undo During the Auction Phase (Phase S4 execution, F9)
**Given:** Auction lobby, ban phase complete, isAuctionPhase=true
**When:** Referee calls `undo_last_step`
**Then:** Throws "Undo is not available during the auction phase." Supersedes "Referee Undo: Reverts Auction Phase Transition" above.

### Auto-Pause Comes From the Grace Check (Phase S4 execution, A22a, F5)
**Given:** Lobby #10 in Drafting (Standard), Blue player #10 connected on one device
**When:** #10 disconnects
**Then:** No Pause step and isPaused unchanged at disconnect time. 15 s later, if #10 is still offline, `run_referee_transfer_check` inserts Pause(actorUserId=0, isAutoPause=true, sequence=max+1) and sets isPaused=true; a spectator's or coach's disconnect never does.

### Bo3 Game 2 Drafts to Completion (Phase S6 execution, BACKEND-BUGS F2)
_Superseded in Phase S8e execution (DECISIONS.md A67(1))._
**Given:** A Bo3 lobby (Classic, ban mode None) whose game 1 ended in BetweenGames
**When:** The host calls `advance_to_next_game`, then the captains pick in sequence order
**Then:** The session has a fresh 16-step sequence, `turnIndex = 0`, `currentGameNumber = 2`; after 16 picks (all `gameNumber = 2`) the lobby is in Equipping. Auction (no bans): game 2 opens with `isAuctionPhase = true`, Blue nominating, budgets reset, and reaches Equipping after 16 sales (8 per team). The won-game counters are carried over.

### Series Head Start (Phase S6 execution, A27, backlog #7)
_Superseded in Phase S8e execution (DECISIONS.md A67(3))._
**Given:** A casual lobby with `bestOf = 3`, `bestOfNAdvantage = Red`
**When:** The host starts the draft; game 1 ends with no recorded game _Superseded in Phase S10b execution (DECISIONS.md A80)._
**Then:** The session starts 0–1 (`gamesWonRed = 1`); after game 1 the recount in `advance_stage` keeps Red at 1. A Bo1 lobby always starts 0–0 (advantage stored as None).

### Ban Restriction (Phase S6 execution, A45(2))
**Given:** A Classic lobby, ban mode Four, `banRestriction = MaxOneDps`; Blue already banned one DPS character this game
**When:** Blue's captain bans a second DPS character
**Then:** Rejected: "Ban restriction: your team may ban at most one DPS character."; a Support ban is accepted; Red's own first DPS ban is unaffected. MaxTwoDps allows two DPS bans per team; MaxOnePerRole rejects a second ban of any role. When Blue's ban timer expires with autoRandomPick on, the auto-ban draws only characters Blue may still ban (SKIP when none).

### Eidolon Edit in Scoring Recomputes and Resets Both Confirmations (Phase S7b execution, A60(1)(2))
**Given:** a Classic Bo3 lobby in Scoring, game 1 open; Blue drafted Blue-1 at E0 (Classic cost 2 at E0, 5 at E2); both teams' group scores are in and the Red captain has confirmed the game (`MatchResultGame.redConfirmed = true`)
**When:** a Blue player calls `set_eidolon(lobbyId, Blue, 'blue-1', 2)`
**Then:** a `SetEidolon` step is logged with `{ characterName: 'blue-1', eidolon: 2, previousEidolon: 0, costPaid: 5 }` and `actorSlot = Blue`; Blue's roster cost rises by 300 hundredths (the lineup row too), the game is recomputed (tie-break 3 reads E2), and both `blueConfirmed` and `redConfirmed` are false. The Red captain must confirm again.

**When:** the same player calls it again within `AbuseConfig.lineupMinIntervalMs`
**Then:** rejected: "Lineup changes are too frequent. Please wait a moment."

**When:** a Blue coach, a spectator who is not a referee, or a Red player sets a Blue eidolon
**Then:** rejected: "Only a Blue player or a referee can set an eidolon for that team." A referee (seated or not) may set either team's eidolons. _Superseded in Phase S10b execution (DECISIONS.md A78)._

**When:** `requireOwnership = true` and Blue's selected accounts own Blue-1 only at E0 and E6, and a Blue player asks for E2
**Then:** rejected: "Your team does not own that eidolon level on its selected accounts." E6 is accepted.

**When:** the game has been closed (both confirmations) and a player or a Moderator edits it (A63: closed through `close_game`)
**Then:** rejected: "This game is closed." (light cones, lineups, scores and adjustments the same).

### Light Cones and Lineups Stay Editable in Scoring (Phase S7b execution, A60(1))
**Given:** a lobby in Scoring, game open
**When:** the Blue captain calls `arrange_lineup` or a Blue player `equip_lightcone`
**Then:** accepted (Equipping and Scoring both allowed); the game is recomputed and both confirmations reset. There is no lineup confirmation: `confirm_lineup` was removed (the game is confirmed as a whole with `confirm_game`, see `docs/match-results/contract.md`). In Auction, an over-budget arrangement is stored; the surcharge gate sits at `confirm_game` / `close_game`.

### Auction Sale Charges the Eidolon Extra Across Both Budgets (Phase S7b execution, A61(1)(3)(5))
*Superseded by DECISIONS.md A64 (Phase S7b follow-up): the default is the lowest owned level; see "Auction Sale Resolves the Lowest Owned Eidolon (Phase S7b follow-up, A64)".*
**Given:** an Auction lobby with `requireOwnership = true`; Red's selected accounts own Red-1 at E2; Red-1's Auction costs are e0 = 4, e2 = 7 (extra 3); Red has a character budget of 5 and a light-cone budget of 10
**When:** Red nominates Red-1 (`nominate_character(lobbyId, 'red-1')`, no `eidolon` argument) at its E0 base cost 4 (guards: 4 ≤ 5, and 4 + 3 ≤ 5 + 10) and Blue passes
**Then:** at the sale the winning team's default eidolon is resolved (Red: E2, the highest it owns) and the extra 3 is charged immediately: the bid 4 leaves a character budget of 1, the extra takes that 1 (character budget 0, never negative) and the remaining 2 from the light-cone budget (10 → 8). The `AuctionSold` step records `{ winningAmount: 4, eidolon: 2, eidolonCost: 3 }`; the roster cost of the character is 7 (700 hundredths). Without `requireOwnership` the default eidolon is E0 and the extra is 0. Both sale paths (`pass_bid`, timer expiry) behave the same; the eidolon of the Nominate step is no longer used (the nominator may not be the winner).

**When:** later, in Equipping, a Red player sets Red-1 to E0 with `set_eidolon`
**Then:** the extra difference (−3) is refunded to Red's light-cone budget (never to the character budget); setting it back to E2 charges 3 again (character budget first while it is positive, otherwise the light-cone budget), rejected with "Not enough budget for that eidolon." when the difference exceeds both.

### A Nomination or Bid Without Ownership Is Rejected (Phase S7b execution, A61(2)(4))
**Given:** an Auction lobby with `requireOwnership = true`; none of Red's selected accounts owns Blue-2
**When:** Blue nominates Blue-2 and the Red captain calls `place_bid`
**Then:** rejected: "Your team does not own this character on any selected account." The same applies to a nomination by a team that does not own the character. `EMPTY` is exempt. A bid (or nomination) whose amount plus the team's eidolon extra exceeds its character + light-cone budget is rejected: "Not enough total budget: the eidolon extra for this character would exceed it." Bids stay capped by the character budget alone ("Bid exceeds your remaining character budget.").

### A Thirds Draft Follows the A59 Order (Phase S7b execution, A59)
**Given:** a Classic lobby with `lineupFormat = Thirds`
**When:** the draft starts with ban mode None, Four or Six
**Then:** `MatchSession.draftSequence` is the A59 order of that ban mode ([draft-order.md](draft-order.md) "Thirds (12 picks per team)"): None `B · RR · B · R · BB · RR · BB · RR · BB · R · B · R · B · R · BB · RR` (24 steps), Four `[B] · [R] · B · RR · B · [R] · [B] · R · BB · RR · BB · RR · BB · RR · BB · RR · BB · R` (28), Six `[B] · [R] · B · RR · B · [R] · [B] · R · BB · R · [B] · [R] · BB · RR · BB · RR · BB · RR · B · R · B · R` (30). 12 picks per team, Blue first, Red last, no run longer than two, ban positions as in Halves. Auction Thirds is unchanged (ban prefix only, 12 sales per team).

### advance_stage From Scoring (Phase S7b execution, A60(5)(8))
**Given:** a lobby in Scoring
**When:** the host calls `advance_stage` _Superseded in Phase S10b execution (DECISIONS.md A80)._
**Then:** rejected: "Games close through confirm_game or close_game; the stage moves on the close." Drafting → Equipping (D-50 rollover) and Equipping → Scoring (no gate) are unchanged.

### Auction Sale Resolves the Lowest Owned Eidolon (Phase S7b follow-up, A64)
**Given:** an Auction lobby with `requireOwnership = true`; Red's selected accounts own Red-1 at E2 and E6; Red-1's Auction costs are e0 = 4, e2 = 7, e6 = 10
**When:** Red wins Red-1 at a bid of 4
**Then:** the default eidolon at the sale is **E2** (the lowest level Red owns) and the extra charged is cost[e2] − cost[e0] = 3 (character budget first, the rest from the light-cone budget); the `AuctionSold` step records `{ eidolon: 2, eidolonCost: 3 }`. The bid-time guard and the reservation of a committed bid use the same lowest-owned extra. If one of Red's accounts owned E0, the default would be E0 and the extra 0.

**When:** a Red player later calls `set_eidolon(lobbyId, Red, 'red-1', 6)`
**Then:** Red pays cost[e6] − cost[e2] = 3 from its pool (character budget first while it exists, then light cones); a later downgrade back to E2 refunds 3 to the light-cone budget.

**Given / Then:** without `requireOwnership` the default is E0 and the extra 0. Classic is unchanged: `pick_character` records the highest owned level (A64(3)).

## Edge Cases

| Case | Expected Behavior | Notes |
|------|-------------------|-------|
| Pick EMPTY character manually | Costs 0, recorded normally | Frontend renders as "No Pick" |
| Ban SKIP on timer expiry | Recorded as Ban with characterName="SKIP" | Only when autoRandomPick=false |
| autoRandomPick with empty available pool | Falls back to EMPTY/SKIP | All characters banned+picked |
| Nominate EMPTY in auction | Bypasses won/banned checks, cost=0 | Teams with 0 budget nominate EMPTY |
| Bid on EMPTY character | Allowed, min raise still enforced | Wasteful but not blocked |
| Timer expiry with paused timer | Not validated (timer paused = client doesn't fire) | Server only checks elapsed time |
| Undo the only step (turnIndex=1) | Deletes step, turnIndex goes to 0 | Further undo blocked ("No steps to undo") |
| Undo auction phase boundary | isAuctionPhase reverts to false | If newTurnIndex < draftSequence.length |
| Resume by different teammate (not original pauser, not referee) | Rejected | Only referee or original pauser |
| Captain leaves mid-draft | No captain on team; any team member can now act | Captain check passes if no captain exists |
| arrange_lineup with invalid JSON | Rejected | "positions must be a valid JSON array of strings." |
| advance_stage from Waiting | Rejected | ensureHostOrAbove passes but stage check fails _Superseded in Phase S10b execution (DECISIONS.md A80)._ |
| advance_stage from Finished | Rejected | "Cannot advance stage from Finished." |
| Duplicate LobbyMember.isCaptain on same team | First captain wins captain check | Only one captain should exist per team |
| Auction sold when only one team needs characters | Normal flow, no short circuit | Other team's won count already at 8, one team still filling _Superseded in Phase S10c execution (DECISIONS.md A81)._ |
| Timer expiry with paused timer (Phase S4 execution, F3) | Rejected: "Draft is paused." Supersedes the "Not validated" row above | Non-members rejected too |
| Undo auction phase boundary (Phase S4 execution, F9) | Rejected: "Undo is not available during the auction phase." Supersedes the "isAuctionPhase reverts" row above | No budget / won-count rollback exists |
| Undo when the highest-sequence row is a Pause or Undo record (Phase S4 execution, F9) | The last Pick/Ban is undone; audit rows are skipped | Audit rows carry their own sequence |
| arrange_lineup with invalid JSON (Phase S7 execution) | Rejected: "groups must be a JSON array of arrays of character names." Supersedes the `positions` row above | `groups` capped at 2000 characters |
| confirm_lineup before any arrangement (Phase S7 execution) | Rejected: "Arrange the lineup before confirming it." | |
| Auction end at 8 characters (Phase S7 execution, A21) | 8 for Halves, 12 for Thirds; supersedes "won count already at 8" above | `charactersPerTeam(lineupFormat)` |

---

## Integration Points

| This Feature | Connects To | How | Direction |
|-------------|------------|-----|-----------|
| MatchSession.lobbyId | Lobby.id | FK, 1-to-1 | Reads lobby config, writes stage |
| MatchResultRecord.lobbyId | Lobby.id | FK | Created by start_draft |
| MatchResultParticipant.matchResultId | MatchResultRecord.id | FK | Created by start_draft |
| MatchResultParticipant.userId | LobbyMember.userId | FK | Reads member list |
| MatchSession budgets | Lobby.characterBudget, lightconeBudget | Initialized from | Reads at start_draft |
| HsrCharacterCost | costSetId + gameMode | Cost lookup for picks/auctions | Reads |
| HsrLightconeCost | costSetId + gameMode | Cost lookup for equip | Reads |
| HsrAccount + HsrAccountCharacter | userId | Ownership validation (D-40) | Reads |
| ChatMessage.lobbyId | Lobby.id | System messages on stage transitions | Writes |
| LobbyMember.isCaptain | Auto-captain assignment at start_draft | Writes |
| finalize_match_result | MatchSession, MatchSessionStep | Archives to history tables, deletes session | Reads/Writes |
| Lobby.bracketMatchId | BracketMatch (Tournament) | Passed to MatchResultRecord | Reads |
| `arrange_lineup` / `confirm_lineup` (Phase S7 execution) | `MatchLineup`, `HsrSynergyCost`, `shared/scoring` | Live lineup row, surcharge, roster cost | Writes / Reads |
| `pick_character` / `nominate_character` (Phase S7 execution) | `LobbyMemberAccount` + `HsrAccountCharacter` | Eidolon under requireOwnership (CH-S6) | Reads |
| `MatchLineup.rosterCost`, Pick / AuctionSold payloads (Phase S7 execution) | match-results tie-breaks 1–3 | Scoring inputs | Read by match-results |

---

## Acceptance Scenarios (Phase S8d execution)

### S8d-S1 Game 1 steps survive the next game (A65(1))
_Superseded in Phase S8e execution (DECISIONS.md A67(3))._
**Given** a Bo3 whose game 1 is closed
**When** the host calls `advance_to_next_game`
**Then** game 1's steps are still in `MatchSessionStep`; game 2's draft state (availability, ban restriction, undo) reads game 2's steps only

### S8d-S2 Undo stays in the current game (A65(2))
_Superseded in Phase S8e execution (DECISIONS.md A67(3))._
**Given** game 2 has no Pick or Ban yet
**When** the referee calls `undo_last_step`
**Then** rejected ("No steps to undo." at turnIndex 0, "Nothing to undo in this game." otherwise); game 1's steps are untouched

### S8d-S3 The archive holds every game (A65(3))
_Superseded in Phase S8e execution (DECISIONS.md A67(3))._
**When** the series is finalized
**Then** `MatchSessionStepHistory` holds the steps of games 1 and 2 with their `gameNumber`

### S8d-S4 Unequip a light cone (S7b hand-off)
**Given** a light cone equipped on a drafted character in Equipping
**When** that team's player calls `unequip_lightcone(lobbyId, characterName)` _Superseded in Phase S10b execution (DECISIONS.md A78)._
**Then** an `UnequipLightcone` step is logged, the cost is refunded to the light-cone budget, the roster cost drops, both confirmations reset

### S8d-S5 Equip only on your own draft
**When** a player equips a light cone on a character the other team drafted
**Then** rejected: "X is not in your team's draft of this game." _Superseded in Phase S10b execution (DECISIONS.md A78)._


## Acceptance Scenarios (Phase S8e execution)

### S8e-S1 One session per lobby (A67(3))
**When** `start_draft` runs
**Then** one `MatchSession` is created with the draft sequence, timers, budgets and pause counters; it has no `seriesBestOf`, `gamesWonBlue`, `gamesWonRed` or `currentGameNumber`; no head start is seeded (the bracket match carries it, A27 / A67(4))

### S8e-S2 Steps without game numbers (A67(3); supersedes A65)
**When** any draft, edit, pause or confirmation step is logged
**Then** the `MatchSessionStep` row has no `gameNumber`; every reader (draft state, undo, ban restriction, eidolon and light-cone edits, auto-resume, tie-breaks) reads the lobby's steps; finalization archives them into `MatchSessionStepHistory` keyed `[matchHistoryId, sequence]`

### S8e-S3 Edits take no game number (A67(3))
**When** a client calls `set_eidolon`, `equip_lightcone`, `unequip_lightcone` or `arrange_lineup`
**Then** the reducer takes no `gameNumber` argument; an Admin still edits the closed game until the record is finalized (A60(7)); the edit charges or refunds the session budgets like an open-game edit

### S8e-S4 The step view has no game number (A67(3))
**When** a member subscribes to `view_my_match_steps`
**Then** the rows carry no `gameNumber`

## Phase History

| Decision | Source | Date |
|----------|--------|------|
| Draft sequence generation (Classic + Auction ban phases) | Phase 9 execution | 2026-03-29 |
| EMPTY CHARACTER on timer expiry (autoRandomPick=false) | Phase 9 execution | 2026-03-29 |
| SKIP ban on timer expiry | Phase 9 execution | 2026-03-29 |
| autoRandomPick deterministic hash: (turnIndex * 31 + lobbyId) % poolSize | Phase 9 execution | 2026-03-29 |
| Coach guard on all draft/equip actions (D-39/MOUS-03) | Phase 9 execution | 2026-03-29 |
| Captain-or-sole-player restriction on all team actions | Phase 9 execution | 2026-03-29 |
| Auto-captain assignment at start_draft (D-30) | Phase 9 execution | 2026-03-29 |
| All Blue+Red non-coach players must be confirmed before start (D-29) | Phase 9 execution | 2026-03-29 |
| Auction steal-skip logic (D-46): nominator keeps turn when opponent wins | Phase 9 execution | 2026-03-29 |
| Auction end at 8 characters per team (D-48, game mode driven) | Phase 9 execution | 2026-03-29 |
| Budget enforcement: nomination rejected if base cost > budget (D-53) | Phase 9 execution | 2026-03-29 |
| Minimum bid raise enforcement (D-53) | Phase 9 execution | 2026-03-29 |
| Budget cap on bids | Phase 9 execution | 2026-03-29 |
| Budget rollover: charBudget carries to lcBudget on Drafting to Equipping (D-50) | Phase 9 execution | 2026-03-29 |
| LC budget strict enforcement (D-55) | Phase 9 execution | 2026-03-29 |
| Referee undo: one step, turnIndex decremented (D-60) | Phase 9 execution | 2026-03-29 |
| Player pause 3-per-team limit, referee unlimited (D-61) | Phase 9 execution | 2026-03-29 |
| Resume: referee or original pauser only (D-62) | Phase 9 execution | 2026-03-29 _Superseded in Phase S10c execution (DECISIONS.md A85)._ |
| Timer is client-driven with server-side elapsed time validation | Phase 9 execution | 2026-03-29 |
| System chat messages on stage transitions (D-11) | Phase 9 execution | 2026-03-29 |
| Scoring to Finished blocked in advance_stage (must use finalize_match_result) | Phase 9 execution | 2026-03-29 |
| Classic BanMode Six sequence: 22 steps (6 bans interleaved with 16 picks) | Phase 9 execution | 2026-03-29 |
| Classic BanMode Four sequence: 20 steps (4 bans interleaved with 16 picks) | Phase 9 execution | 2026-03-29 |
| Auction BanMode sequences: 4 or 6 ban-only steps before dynamic auction | Phase 9 execution | 2026-03-29 |
| BanMode.Two removed in Phase 9; only None, Four, Six remain | Phase 9 execution | 2026-03-29 |
| refereeFullControl derived from spectator slot (D-44) | Phase 9 execution | 2026-03-29 |
| MatchResultParticipant created at start_draft for all non-coach team members | Phase 9 execution | 2026-03-29 |
| runFinalization step 19: cascade-deletes lobby after ephemeral cleanup (was set Finished, changed to cascade-delete) | Phase 9 execution | 2026-03-29 |
| AwaitingResult stage: submit_match_result sets AwaitingResult (frees players), finalization cascade-deletes lobby | Phase 9 execution | 2026-03-29 |
| Full hydration from codebase | Phase 13 normalization | 2026-04-09 |
| Phase 12.3 execution | timer_expiry_classic auto-pick pool migrated from HsrAccount.isActive (global active account) to LobbyMemberAccount (per-match selected accounts) when requireOwnership=true (D-I-01/02); closes last in-gameplay runtime read of HsrAccount.isActive introduced in Phase 10.4 migration gap | 2026-04-12 |
| Post-draft LC lookup filters by `(lightconeName, gameMode, draftMode=Classic, costSetId)` and reads `costs.sN` (was `classicCosts.sN`); Pitfall 6 regression guard | Phase 15.4 execution | 2026-04-15 |
| Auction nomination base-cost lookup filters by `draftMode=Auction` and reads `costs.eN` (was `auctionBaseBid[eN]`); D-53 semantics retained, column shape updated | Phase 15.4 execution | 2026-04-15 |
| `timer_expiry_classic` autoRandomPick pool builders now filter `draftMode=Classic` — prevents 0-cost auto-picks of Auction-only characters (WR-02 fix) | Phase 15.4 execution | 2026-04-15 |
| `equip_lightcone`, `arrange_lineup`, `confirm_lineup` stamp `gameNumber: session.currentGameNumber` on MatchSessionStep inserts — matches draft-phase invariant; preserves step-to-game attribution in MatchSessionStepHistory for bestOf>1 archives (WR-04 fix) | Phase 15.4 execution | 2026-04-15 |
| pick/ban/nominate/bid/pass and both timer expiries reject while paused ("Draft is paused.") | Phase S4 execution (DECISIONS.md A22(3)) | 2026-11-06 |
| `timer_expiry_classic` / `timer_expiry_auction` require lobby membership (F3) | Phase S4 execution (DECISIONS.md A22(2)) | 2026-11-06 |
| `undo_last_step` undoes the last Pick/Ban only; rejected while paused and in the auction phase; Pick/Ban/Pause/Undo sequences from `getNextSequence` (F9) | Phase S4 execution (DECISIONS.md A22(2)) | 2026-11-06 |
| Auto-pause decided by `run_referee_transfer_check` 15 s after the last disconnect, team players only (F5) | Phase S4 execution (DECISIONS.md A22(5), A22a) | 2026-11-06 |
| Scenarios "Bo3 Game 2 Drafts to Completion", "Series Head Start", "Ban Restriction" added; `advance_to_next_game` rebuilds the draft through `initSessionForGame` | Phase S6 execution (BACKEND-BUGS F2; DECISIONS.md A27, A45(2)) | 2026-11-06 |
| Lineup groups: `arrange_lineup(lobbyId, teamSide, groups)` / `confirm_lineup(lobbyId, teamSide)`, captain or referee only, throttled, live `MatchLineup`, Auction surcharge gate, ConfirmLineup step with groups; scenarios "Lineup Groups", "Synergy Surcharge", "Auction: Over-Budget Lineup" added | Phase S7 execution (DECISIONS.md A21; backlog #3) | 2026-11-06 |
| Eidolon resolved from the selected accounts under requireOwnership (pick, nominate); light-cone superimposition argument stands; scenario "Eidolon Snapshot Under requireOwnership" | Phase S7 execution (DECISIONS.md A43 CH-S6) | 2026-11-06 |
| `lineupFormat` drives the character count: Thirds = 12 picks per team (Classic sequence, Auction completion); scenario "Thirds Lobbies Draft 12 per Team" | Phase S7 execution (DECISIONS.md A21) | 2026-11-06 |
| `equip_lightcone` refreshes the lineup row and reserves a confirmed Auction surcharge; scenario "Light Cones Equipped After confirm_lineup" | Phase S7 execution (review fix; DECISIONS.md A21) | 2026-11-06 |
| Game package edits: eidolons (`set_eidolon`) from Drafting, light cones and lineups in Equipping and Scoring, open game only, each edit recomputes and resets both confirmations; `confirm_lineup` removed; `advance_stage` from Scoring rejected; scenarios "Eidolon Edit in Scoring Recomputes and Resets Both Confirmations", "Light Cones and Lineups Stay Editable in Scoring", "advance_stage From Scoring" added. The S7 scenarios naming `confirm_lineup` ("Lineup Groups" last When, "Auction: Over-Budget Lineup Cannot Be Confirmed", "Light Cones Equipped After confirm_lineup") and "Eidolon Snapshot Under requireOwnership" for `nominate_character` are superseded by these | Phase S7b execution (DECISIONS.md A60) | 2026-11-07 |
| Auction eidolon economics: E0 nominations and bids, ownership on nominations and bids, total-budget guard, the extra charged at the sale across both budgets, edits pay or refund (refund to the light-cone budget); scenarios "Auction Sale Charges the Eidolon Extra Across Both Budgets", "A Nomination or Bid Without Ownership Is Rejected" added | Phase S7b execution (DECISIONS.md A61) | 2026-11-07 |
| Thirds Classic orders per ban mode; scenario "A Thirds Draft Follows the A59 Order" added (supersedes the S7 extra-picks order in "Thirds Lobbies Draft 12 per Team") | Phase S7b execution (DECISIONS.md A59) | 2026-11-07 |
| Auction default eidolon at the sale = the lowest owned level (was the highest, A61(3)); higher levels bought through `set_eidolon`; scenario "Auction Sale Resolves the Lowest Owned Eidolon" added and "Auction Sale Charges the Eidolon Extra Across Both Budgets" marked superseded | Phase S7b follow-up (DECISIONS.md A64) | 2026-11-07 |
| Scenarios S8d-S1..S5: steps kept for the series, undo within the game, archive of every game, `unequip_lightcone`, own-draft equip | Phase S8d execution (DECISIONS.md A65) | 2026-11-07 |
| Scenarios S8e-S1..S4: one session per lobby, steps and edits without game numbers, step view without `gameNumber`; supersedes the A65 whole-series step rules and the S8d-S scenarios | Phase S8e execution (DECISIONS.md A67(3)) | 2026-11-08 |
| `start_draft` D-08 gate text: "Player #<userId> has no account selected for this match. All players must select an account before starting a ranked or MMR-counted match." — Ranked lobbies and tournament lobbies whose tournament has `countTowardsMmr` (tests `s10-account-selection`) | Phase S10 execution (DECISIONS.md A76) | 2026-11-09 _Superseded in Phase S10e execution (backend audit 2026-11-09, lobby finding 9)._ |
| Open for the user (S10 port finding, not decided): `equip_lightcone` / `unequip_lightcone` "Permission: Captain (or sole player if no captain)" above vs the implementation, which accepts any player seat of that team (not a coach, not a spectator; an Admin on the A60(7) path); no test asserts either reading; the permission line stays unmarked until ruled | Phase S10 execution (open) | 2026-11-09 _Superseded in Phase S10b execution (DECISIONS.md A78)._ |
| Game-package callers unified: `set_eidolon`, `equip_lightcone`, `unequip_lightcone` and `arrange_lineup` accept the captain of the named team or any lobby referee (seated or not); a non-captain teammate, a coach, a non-referee spectator and the other team's captain are rejected with "Only the <Side> captain or a referee can set an eidolon for that team." / "… can equip lightcones." / "… can unequip lightcones." / "… can arrange the lineup."; the caller check runs before the stage check. Admin edits of a closed game unchanged (A60(7), A69(2)). Scenarios that say "a Blue player" / "a Red player" for these edits read "the Blue captain" / "the Red captain" | Phase S10b execution (DECISIONS.md A78) | 2026-11-09 |
| `equip_lightcone(lobbyId, teamSide, characterName, lightconeName, superimposition)` and `unequip_lightcone(lobbyId, teamSide, characterName)`: the team is named by `teamSide` ("teamSide must be Blue or Red."); the character must be in that team's draft ("<name> is not in the <Side> team's draft of this game."); budget, step and refund belong to that side, so under `allowMirrorPicks` each team's copy is edited separately, also on the Admin path. Both use the lineup throttle on the open game ("Lineup changes are too frequent. Please wait a moment.", shared per member with `set_eidolon` and `arrange_lineup`): a swap is an unequip and an equip at least `AbuseConfig.lineupMinIntervalMs` apart | Phase S10b execution (DECISIONS.md A78) | 2026-11-09 |
| `start_draft` and `advance_stage` are referee powers: accepted from the lobby member holding the referee flag (any seat) or a Moderator / Admin; everyone else, the host included, gets "Only the referee, moderators, or admins can perform this action." with nothing changed. A host who gave the flag away takes it back with `reclaim_referee`. Scenarios that say "the host starts the draft" / "the host calls `advance_stage`" read "the referee" | Phase S10b execution (DECISIONS.md A80) | 2026-11-09 |
| Input bounds: `pick_character` rejects an eidolon above 6 when ownership is not required ("eidolon must be between 0 and 6."); `equip_lightcone` rejects a superimposition outside 1 to 5 on the open and the Admin closed-game path ("superimposition must be between 1 and 5."); `place_bid` rejects a bid that is not finite or is negative ("bidAmount must be a finite, non-negative number.") | Phase S10c execution (backend audit 2026-11-09, draft findings 1 to 3) | 2026-11-09 |
| Auction, full team sits out: a team holding `charactersPerTeam` characters is rejected by `nominate_character` and `place_bid` ("Your team already has all its characters."); the rotation and the timer hand the nomination to the team that is not full; while one team is full, a nomination by the other team is sold to it at once at base cost with no bidding round (the nominating team's budget, ownership and exclusivity checks unchanged; the timer's EMPTY nomination sells at 0). No team can exceed `charactersPerTeam` | Phase S10c execution (DECISIONS.md A81) | 2026-11-09 |
| `resume_draft` on an automatic (disconnect) pause: accepted from the referee or from any seated player of either team who is present; a coach, a non-referee spectator and an away or abandoned player are rejected ("Only the referee or a seated player can resume an auto-paused draft."). A manual pause keeps D-62 and its text | Phase S10c execution (DECISIONS.md A85) | 2026-11-09 |
| Timer auto-pick pricing: with `autoRandomPick`, a real character drawn by the timer is priced from the lobby's Classic cost row like a manual pick: eidolon 0 when ownership is not required, the acting team's highest owned eidolon when it is (the pool stays the union of the team's selected accounts, D-I-01/02; equal to a manual pick in 1v1, never cheaper than one in 2v2 and above). `EMPTY` (setting off, or an empty pool) stays at cost 0 | Phase S10d execution (DECISIONS.md A86) | 2026-11-09 |
| Mirror picks, once per team: with `allowMirrorPicks` a team may pick a character the other team holds, but not one it already holds ("Your team already picked this character."); without it "Character already picked." is unchanged. The timer pool follows the same rule. `EMPTY` is never blocking: a team may hold any number of `EMPTY` picks, manual or by timer, with mirror on or off. Auction is unaffected (sales are exclusive) | Phase S10d execution (DECISIONS.md A87) | 2026-11-09 |
| `start_draft` is rejected while a seated player (not a coach) is offline: "All Blue and Red players must be online before starting."; an offline coach or spectator does not block | Phase S10d execution (DECISIONS.md A92(1)) | 2026-11-09 |
| `start_draft` account rejections name the seat, never the user id: "The player at seat N has no account selected for this match. …", "The player at seat N has no account selected. autoRandomPick requires …", "The player at seat N has no characters on their selected account(s). …" | Phase S10e execution (backend audit 2026-11-09, lobby finding 9) | 2026-11-09 |
| Turn clock, one definition for pause, auto-pause, resume, both auto-pause lift paths and both timer expiry reducers (Classic and Auction): the turn budget is `accumulatedPauseMs` when it is above 0, otherwise `standardTurnSeconds * 1000`; the remaining time is the budget while paused, otherwise the budget minus the time since `turnStartAt`, never below 0. A pause stores the remaining time (at least 1 ms) as the budget; a resume keeps it and restarts `turnStartAt`; a new turn resets the budget to 0. After any pause and resume a turn has exactly the time it had left, and expiry is accepted only at 0 remaining | Phase S10f execution (backend audit 2026-11-09, draft finding 5 (bug F10)) | 2026-11-09 |
| Post-draft edit steps are capped per team side: 300 `SetEidolon` / `EquipLightcone` / `UnequipLightcone` steps per edited side and 300 `ConfirmGame` steps per confirming side ("The <Side> side of this game has reached the limit of 300 edit steps; the referee or staff can still close it." / "… confirmation steps; …"); `close_game`, the Admin closed-game edit and concede are not capped. A manual `pause_draft` is rejected within 10 s of the same party's previous manual pause (Blue, Red, or the referee); auto-pauses are neither counted nor rejected | Phase S10f execution (backend audit 2026-11-09, draft finding 8) | 2026-11-09 |

---

*Last updated: 2026-11-06*
*Feature owner: Phase 9 / Phase 12.3 / Phase 15.4*
