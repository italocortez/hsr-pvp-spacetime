# Match Session (Draft System)

**Architecture:** [architecture.md](architecture.md)

## Feature Overview

The match session system manages the entire draft lifecycle within a lobby: character bans, character picks (Classic mode), character auctions (Auction mode), lightcone equipping, lineup arrangement, and stage advancement through Drafting, Equipping, and Scoring. It enforces turn order, budget constraints, timer expiry, pause/resume, and referee undo. Coaches are blocked from all draft and equip actions. Captains (or sole players when no captain is assigned) are the only team members who can perform draft actions.

## Reducers

### start_draft

**Purpose:** Creates the MatchSession, MatchResultRecord, and MatchResultParticipant rows, assigns auto-captains, and transitions the lobby from Waiting to Drafting.

**Permission:** Host, Admin, or Moderator (ensureHostOrAbove)

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
| Caller not host/admin/mod | Permission error from ensureHostOrAbove |
| Not in Waiting stage | Stage assertion error |
| Unconfirmed non-coach player exists | "All Blue and Red players must be confirmed before starting." |
| Blue team has no non-coach players | "Blue team must have at least one non-coach player." |
| Red team has no non-coach players | "Red team must have at least one non-coach player." |
| autoRandomPick + player missing active HSR account | "Player #N has no active HSR account. autoRandomPick requires all players to have characters." |
| autoRandomPick + player has no characters | "Player #N has no characters on their active HSR account. autoRandomPick requires all players to have characters." |

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
6. If `allowMirrorPicks=false`: reject if characterName already appears in a Pick step
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
3. Server-side timer validation: elapsed time since `turnStartAt` must be >= `standardTurnSeconds * 1000` ms
4. Read current step from `draftSequence[turnIndex]`
5. **If Pick turn:**
   - Default: `characterName="EMPTY"`, `eidolon=0`
   - If `autoRandomPick=true`: build available pool — Phase 12.3 D-I-01/02: if `requireOwnership=true`, pool is union of characters from all `LobbyMemberAccount` rows for `(lobbyId, userId)` for each acting team member (migrated from `HsrAccount.isActive` global account); if `requireOwnership=false`, pool is all cost table characters for the game mode — exclude banned+picked, deterministic hash `(turnIndex * 31 + lobbyId) % poolSize`
   - Insert Pick step with `actorUserId=0` (system), `costPaid=0`
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
7. Calculate `timeRemainingMs` from elapsed time and accumulated pause time
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
5. Allow resume if caller is referee OR is the original pauser
6. Set `timerState.isPaused=false`, `turnStartAt=ctx.timestamp`, `accumulatedPauseMs=timeRemainingMs` (so timer resumes from paused position)

**Expected State Changes:**
- `MatchSession.timerState.isPaused` = false
- `MatchSession.timerState.turnStartAt` reset to current timestamp
- `MatchSession.timerState.accumulatedPauseMs` = timeRemainingMs from Pause step

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

**Permission:** Captain (or sole player if no captain). Non-coach, non-spectator.

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
| Caller is coach | "Coaches cannot equip lightcones." |
| Caller is spectator | "Spectators cannot equip lightcones." |
| Budget insufficient | "Not enough LC budget." |

---

### arrange_lineup

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

**Permission:** Host, Admin, or Moderator (ensureHostOrAbove)

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
**Then:** Each throws "Coaches cannot perform draft actions." (or the action-specific variant like "Coaches cannot equip lightcones.")

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
**Then:** timerState.isPaused=false. accumulatedPauseMs = timeRemainingMs from Pause step. turnStartAt reset.

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
**When:** Blue captain calls `equip_lightcone(lobbyId, "Kafka", "Patience Is All You Need", 1)`
**Then:** EquipLightcone step recorded with costPaid=15. teamBlueLcBudget reduced to 5.

**When:** Blue captain tries to equip another LC costing 10
**Then:** Throws "Not enough LC budget."

### Equipping: Arrange and Confirm Lineup

**Given:** Equipping stage
**When:** Blue captain calls `arrange_lineup(lobbyId, '["Kafka","Jingliu","Blade","Bronya"]')`
**Then:** ArrangeLineup step recorded with positions JSON.

**When:** Blue captain calls `confirm_lineup(lobbyId)`
**Then:** ConfirmLineup step recorded with confirmed=true.

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

**Given:** Host calls `start_draft`
**Then:** System chat message: "Draft has started!"

**Given:** Host calls `advance_stage` from Drafting
**Then:** System chat message: "Draft complete. Stage: Equipping"

**Given:** Host calls `advance_stage` from Equipping
**Then:** System chat message: "Lineups set. Stage: Scoring"

---

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
| advance_stage from Waiting | Rejected | ensureHostOrAbove passes but stage check fails |
| advance_stage from Finished | Rejected | "Cannot advance stage from Finished." |
| Duplicate LobbyMember.isCaptain on same team | First captain wins captain check | Only one captain should exist per team |
| Auction sold when only one team needs characters | Normal flow, no short circuit | Other team's won count already at 8, one team still filling |

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

---

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
| Resume: referee or original pauser only (D-62) | Phase 9 execution | 2026-03-29 |
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

---

*Last updated: 2026-04-15*
*Feature owner: Phase 9 / Phase 12.3 / Phase 15.4*
