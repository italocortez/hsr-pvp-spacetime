# Lobby System

**Architecture:** [architecture.md](architecture.md)

## Feature Overview

The lobby system manages the lifecycle of match rooms where players assemble, configure settings, assign teams, and ready up before entering the draft phase. It handles lobby creation with preset support, join/leave flows with password protection, team slot assignment with capacity enforcement, ready-up coordination, captain designation, and administrative actions (kick/ban/close). Tournament-controlled lobbies inherit locked settings while allowing QoL adjustments. A preset system lets privileged users save and reuse lobby configurations.

## Reducers

### create_lobby

**Purpose:** Creates a new lobby and inserts the creator as host/referee.

**Permission:** Any authenticated user

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| joinCode | string | Yes | Ignored — server generates a 6-char code _Superseded in Phase S10n execution (DECISIONS.md A114)._ |
| presetId | u32 | Yes | Preset to copy config from (0 = no preset) _Superseded in Phase S10n execution (DECISIONS.md A116)._ |
| teamSize | u8 | Yes | Players per team (1, 2, 3) |
| draftMode | DraftMode | Yes | Classic or Auction |
| banMode | BanMode | Yes | None, Four, or Six |
| gameMode | GameMode | Yes | MemoryOfChaos, ApocalypticShadow, AnomalyArbitration |
| matchType | MatchType | Yes | Casual or Ranked |
| isPublic | bool | Yes | Public (no password) or Private |
| password | string | Yes | Password for private lobbies (empty if public) |
| standardTurnSeconds | u32 | Yes | Turn timer in seconds |
| reserveBankSeconds | u32 | Yes | Reserve bank per team in seconds |
| characterBudget | f32 | Yes | Per-team character budget (Auction mode) |
| lightconeBudget | f32 | Yes | Per-team lightcone budget |
| minimumBidRaise | f32 | Yes | Minimum bid increment (Auction mode) |
| allowMirrorPicks | bool | Yes | Both teams can pick same character |
| autoRandomPick | bool | Yes | Auto-pick on timer expiry |
| refereeCanUndo | bool | Yes | Referee undo power |
| refereeCanPause | bool | Yes | Referee pause power |
| refereeCanSetCaptain | bool | Yes | Referee captain assignment power |
| refereeCanKick | bool | Yes | Referee kick power |
| allowPlayerPause | bool | Yes | Players get 3 pauses per team |
| rosterDiffAdvantage | f32 | Yes | Handicap: roster cost diff advantage |
| rosterThreshold | f32 | Yes | Handicap: cost threshold |
| underThresholdAdvantage | f32 | Yes | Handicap multiplier below threshold |
| aboveThresholdPenalty | f32 | Yes | Handicap multiplier above threshold |
| deathPenalty | f32 | Yes | Handicap: penalty per death |
| isAnonymousPlayers | bool | Yes | Hide player identities during match |
| isAnonymousSpectators | bool | Yes | Hide spectator identities |
| rosterVisibility | RosterVisibility | Yes | OpenRoster / ClosedWithRating / ClosedNoRating |
| requireOwnership | bool | Yes | Require HsrAccountCharacter ownership for picks |
| costSetId | u32 | Yes | FK to CostSet (0 = default) |
| disconnectPolicy | DisconnectPolicy | Yes | Behavior on member disconnect |
| disconnectForfeitSeconds | u32 | Yes | Auto-forfeit timeout (0 = not set) _Superseded in Phase S10d execution (DECISIONS.md A92)._ |
| teamBlueAlias | string | Yes | Blue team display name |
| teamRedAlias | string | Yes | Red team display name |
| bestOf | u8 | Yes | Series length (0 → 1; 1 = single game, 3/5/7 = series) _Superseded in Phase S8e execution (DECISIONS.md A67(2))._ |
| refereeControlsShelving | bool | Yes | Referee controls shelve/continue in BetweenGames _Superseded in Phase S8e execution (DECISIONS.md A67(2))._ |

**Flow:**
1. Authenticate caller via `getAuthenticatedUser`
2. If `presetId > 0`: validate preset exists
3. D-22: `ensureNotInLobby` — reject if user is already in any lobby
4. Generate deterministic 6-char join code (Jackbox-style, hash-based, retry on collision)
5. D-23: `ensureGuestRestrictions` — guests cannot create Ranked lobbies
6. D-23: If guest, force `rosterVisibility=ClosedNoRating`
7. D-42: If Ranked, force `allowMirrorPicks=false`
8. Insert Lobby row with `stage=Waiting`, `currentPlayerCount=1`
9. Insert LobbyMember for host: `isReferee=true`, `lobbySlot=Spectator` (D-24, D-27)
10. If private (`!isPublic` and password non-empty): insert LobbyPassword row

**Expected State Changes:**
- Lobby row inserted (stage=Waiting, currentPlayerCount=1)
- LobbyMember row inserted (host, isReferee=true, lobbySlot=Spectator, isConfirmed=false, isCaptain=false)
- LobbyPassword row inserted (private lobbies only)

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| presetId > 0 but not found | "Preset not found." |
| User already in a lobby (D-22) | "You are already in a lobby. Leave it before creating or joining another." |
| Guest creating Ranked lobby (D-23) | "Guests cannot create or join Ranked lobbies." |
| Join code collision after 10 retries | "Could not generate a unique join code. Please try again." |

---

### join_lobby

**Purpose:** Joins an existing lobby by lobbyId or joinCode.

**Permission:** Any authenticated user

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| lobbyId | u32 | Yes | Lobby PK (0 to use joinCode instead) |
| joinCode | string | Yes | Join code (empty to use lobbyId instead) |
| password | string | Yes | Password for private lobbies (empty if public) |

**Flow:**
1. Authenticate caller
2. D-03: Resolve lobby — `lobbyId > 0` uses PK lookup, else `joinCode` uses unique index lookup
3. D-22: `ensureNotInLobby` — one lobby at a time
4. D-23: `ensureGuestRestrictions` — guests cannot join Ranked lobbies
5. D-21: `ensureNotBanned` — reject if LobbyBan row exists
6. D-04: Stage-specific join:
   - **Waiting:** normal join (falls through)
   - **Drafting:** if existing offline member, reconnect (set isOnline=true); if new user, allowed as spectator only (falls through to insert)
   - **Other stages:** rejected
   _Superseded in Phase S8f execution (DECISIONS.md A68)._ New joins are accepted in Waiting, Drafting, Equipping and Scoring (Spectator in the live stages); AwaitingResult stays closed (S8f-L9).
7. D-02: Password check for private lobbies — compare against LobbyPassword row
8. Cap enforcement: max 20 total members, max 12 spectators
   _Superseded in Phase S8f execution (DECISIONS.md A68)._ The spectator cap is `Lobby.maxSpectators` (S8f-L10).
9. Insert LobbyMember with `lobbySlot=Spectator` (D-27)
10. Increment `currentPlayerCount` on Lobby
11. Insert system ChatMessage: "{name} joined the lobby."

**Expected State Changes:**
- LobbyMember row inserted (lobbySlot=Spectator, isReferee=false, isConfirmed=false, isCaptain=false)
- Lobby.currentPlayerCount incremented
- Lobby.lastActivityAt updated
- ChatMessage system row inserted
- (Reconnect case: existing LobbyMember.isOnline set to true, no new row)

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Lobby not found by ID or code | "Lobby not found." |
| User already in a lobby (D-22) | "You are already in a lobby. Leave it before creating or joining another." |
| Guest joining Ranked lobby (D-23) | "Guests cannot create or join Ranked lobbies." |
| User banned from lobby (D-21) | "You are banned from this lobby." |
| Non-Waiting/non-Drafting stage (D-04) | "Cannot join a lobby in stage: {stage}" _Superseded in Phase S8f execution (DECISIONS.md A68)._ |
| Wrong password (D-02) | "Incorrect lobby password." |
| 20 members already | "Lobby is full (max 20 members)." |
| 12 spectators already | "Spectator slots are full (max 12)." _Superseded in Phase S8f execution (DECISIONS.md A68)._ |

**Phase S4 execution (F1, DECISIONS.md A22(2)):** the reconnect branch (step 6, existing member) is evaluated **before** steps 3–5. `ensureNotInLobby` counts the row of the lobby being rejoined, so the old order rejected every reconnect with "You are already in a lobby…". The guest and ban checks apply to new joins only (an existing member passed them at join time; `ban_member` deletes the membership row). Reconnect stages are Waiting, Drafting, Equipping, Scoring, BetweenGames, Shelved and AwaitingResult (Waiting added: a refresh in the waiting room is a reconnect, so "Cannot rejoin this lobby in its current stage." no longer applies to it). `client_connected` performs the same restore for every membership of the reconnecting user, so `join_lobby` is the explicit path, not the only one. New rows take `joinSeq = max(joinSeq in lobby) + 1` (R4).

---

### leave_lobby

**Purpose:** Removes the caller from a lobby.

**Permission:** Any member

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| lobbyId | u32 | Yes | Lobby to leave |

**Flow:**
1. Authenticate caller; `ensureLobbyMember` — validate membership; load lobby
2. **Active-stage branch** (Drafting / Equipping / Scoring / BetweenGames):
   _Superseded in Phase S8e execution (DECISIONS.md A67(1))._
   - D-29 spectators & coaches: delete their LobbyMemberAccount rows, delete LobbyMember row, decrement `currentPlayerCount`, return
   - D-31 players: delete LobbyMemberAccount rows; delete + reinsert LobbyMember with `voluntarilyLeft=true`, `isOnline=false` — **row is kept for finalization, count NOT decremented** _Superseded in Phase S8f execution (DECISIONS.md A68)._
   - D-34/35/36: `transferCaptain`, `transferReferee`, `transferHost` to the next eligible online team member _Superseded in Phase S8f execution (DECISIONS.md A68)._
   - D-31/D-82: if the leaver's team has no remaining non-left members, `performConcede` (their team loses, reason VoluntaryLeave) — UNLESS `refereeExclusiveConcede` + a third-party referee is present (then blocked; referee decides) _Superseded in Phase S8f execution (DECISIONS.md A68)._
   - Insert system ChatMessage "{name} left the match."; return
3. **Normal branch** (Waiting / AwaitingResult / Finished): delete LobbyMemberAccount rows; delete LobbyMember row; compute new count
   _Superseded in Phase S8e execution (DECISIONS.md A67(1))._
4. If new count reaches 0 and stage is Waiting: auto-close via `hardDeleteLobby`
5. D-19: if new count reaches 0 and stage is Shelved: set count to 0, do NOT delete (preserved for return)
   _Superseded in Phase S8e execution (DECISIONS.md A67(1))._
6. Otherwise: update Lobby activity timestamp and insert system ChatMessage "{name} left the lobby."

**Expected State Changes:**
- Normal branch: LobbyMember + LobbyMemberAccount rows deleted, `currentPlayerCount` decremented, `lastActivityAt` updated, system ChatMessage inserted
- Active-stage player leave: LobbyMember row kept (`voluntarilyLeft=true`, `isOnline=false`), LobbyMemberAccount rows deleted, captain/referee/host flags transferred, count unchanged; possible auto-concede _Superseded in Phase S8f execution (DECISIONS.md A68)._ See S8f-L1.
- (If empty + Waiting: full cascade delete of lobby and all associated rows via `hardDeleteLobby`)
- (If empty + Shelved: count set to 0, lobby preserved for later return)
   _Superseded in Phase S8e execution (DECISIONS.md A67(1))._

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Lobby not found | "Lobby not found." |
| Not a member | "You are not a member of this lobby." |

**Phase S4 execution (F6):** after `transferCaptain` / `transferReferee` / `transferHost`, the `Lobby` row is re-read; `performConcede` and the final `lastActivityAt` update spread the fresh row, so a host flag transferred to a teammate is not handed back to the leaver.
_Superseded in Phase S8f execution (DECISIONS.md A68)._ A live-stage Leave transfers nothing and concedes nothing; every row removal re-reads the Lobby row after `transferFlagsOnRemoval` (S8f-L7).

---

### close_lobby

**Purpose:** Hard-deletes a lobby and all associated data.

**Permission:** Host / Admin / Moderator (D-21)

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| lobbyId | u32 | Yes | Lobby to close |

**Flow:**
1. Authenticate caller
2. Find lobby
3. D-21: `ensureHostOrAbove` — host, moderator, or admin
4. D-20: `ensureStageIs(Waiting, Finished)` — only closeable in these stages
   _Superseded in Phase S8e execution (DECISIONS.md A67(1))._
5. D-19: `hardDeleteLobby` cascade (in order):
   1. Delete MatchResultParticipant → MatchResultGame → MatchResultRecord rows
   2. Delete all ChatMessage rows
   3. Delete all LobbyMemberAccount rows (D-28)
   4. Delete all LobbyMember rows
   5. Delete all LobbyBan rows
   6. Delete LobbyPassword (if exists)
   7. Delete all MatchSessionStep rows
   8. Delete MatchSession (if exists)
   9. Delete Lobby row
   (LobbyCursorEvent is an event table — auto-expires, no explicit delete)

**Expected State Changes:**
- All associated rows cascade-deleted (MatchResult*, ChatMessage, LobbyMemberAccount, LobbyMember, LobbyBan, LobbyPassword, MatchSessionStep, MatchSession, Lobby)

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Lobby not found | "Lobby not found." |
| Not host/mod/admin | "Only the host, moderators, or admins can perform this action." |
| Stage not Waiting or Finished (D-20) | "This action is not allowed in the current lobby stage ({stage})." _Superseded in Phase S8e execution (DECISIONS.md A67(1))._ |

---

### kick_member

**Purpose:** Removes a member from a lobby without banning them.

**Permission:** Host / Admin / Moderator / Referee (if refereeCanKick=true)

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| lobbyId | u32 | Yes | Lobby |
| targetUserId | u32 | Yes | User to kick _Superseded in Phase S9c execution (DECISIONS.md A74)._ |

**Flow:**
1. Authenticate caller
2. Find lobby
3. `ensureLobbyMember` for caller — get their LobbyMember row
4. `canKickOrBan` permission check (host, admin, moderator, or referee with refereeCanKick)
5. Cannot kick self or the host
6. Validate target is a member
7. Delete target's LobbyMember row
   _Superseded in Phase S8f execution (DECISIONS.md A68)._ A player cannot be kicked in Drafting / Equipping / Scoring; a removal deletes the LobbyMemberAccount rows too and transfers the flags (S8f-L6, S8f-L7).
8. Decrement `currentPlayerCount`
9. Insert system ChatMessage: "{name} was kicked from the lobby."

**Expected State Changes:**
- Target's LobbyMember row deleted
- Lobby.currentPlayerCount decremented
- Lobby.lastActivityAt updated
- ChatMessage system row inserted

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Lobby not found | "Lobby not found." |
| Caller not a member | "You are not a member of this lobby." |
| No kick permission | "Only the host, moderators, admins, or an authorized referee can kick members." |
| Kicking self | "Cannot kick yourself." |
| Kicking host | "Cannot kick the host." |
| Target not a member | "Target user is not a member of this lobby." _Superseded in Phase S9c execution (DECISIONS.md A74): the seat is resolved first; an unknown seat is rejected with "No member sits at seat N of this lobby."._ |

---

### ban_member

**Purpose:** Bans a user from a lobby, creating a LobbyBan row and removing current membership.

**Permission:** Host / Admin / Moderator / Referee (if refereeCanKick=true)

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| lobbyId | u32 | Yes | Lobby |
| targetUserId | u32 | Yes | User to ban _Superseded in Phase S9c execution (DECISIONS.md A74)._ |

**Flow:**
1. Authenticate caller
2. Find lobby
3. `ensureLobbyMember` for caller
4. `canKickOrBan` permission check
5. Cannot ban self or the host
6. Insert LobbyBan row (lobbyId, bannedUserId, bannedByUserId)
7. If target is currently a member: delete LobbyMember, decrement `currentPlayerCount`
   _Superseded in Phase S8f execution (DECISIONS.md A68)._ The kick stage rule and removal apply (S8f-L6, S8f-L7).
8. Insert system ChatMessage: "{name} was banned from the lobby."

**Expected State Changes:**
- LobbyBan row inserted
- Target's LobbyMember row deleted (if member)
- Lobby.currentPlayerCount decremented (if member was present)
- Lobby.lastActivityAt updated
- ChatMessage system row inserted

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Lobby not found | "Lobby not found." |
| Caller not a member | "You are not a member of this lobby." |
| No ban permission | "Only the host, moderators, admins, or an authorized referee can ban members." |
| Banning self | "Cannot ban yourself." |
| Banning host | "Cannot ban the host." |

---

### update_lobby_settings

**Purpose:** Updates all mutable lobby configuration fields. Resets all members' `isConfirmed` to false.

**Permission:** Host / Admin / Moderator (D-21)

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| lobbyId | u32 | Yes | Lobby to update |
| (all config fields) | various | Yes | Same as create_lobby minus joinCode/presetId |
| isPublic | bool | Yes | Public/private toggle |
| password | string | Yes | New password (empty to keep existing or remove) |

**Flow:**
1. Authenticate caller
2. Find lobby
3. D-21: `ensureHostOrAbove` — host, moderator, or admin
4. D-28: `ensureStageIs(Waiting)` — settings locked once Drafting begins
5. D-65: If `isTournamentControlled`: locked fields retain lobby values (teamSize, gameMode, matchType, anonymity settings, rosterVisibility, requireOwnership, costSetId, disconnectPolicy, disconnectForfeitSeconds, allowMirrorPicks). Free fields accept new values (draftMode, banMode, timers, budgets, handicaps, referee powers, aliases, pause settings, isPublic).
6. D-23: If guest and not tournament-locked: force matchType=Casual, rosterVisibility=ClosedNoRating
7. D-42: If Ranked (and not tournament-locked): force allowMirrorPicks=false
8. Update Lobby row with resolved values
9. Handle password: if private + password provided, upsert LobbyPassword; if changed to public, delete LobbyPassword
10. Reset all members' `isConfirmed=false`

**Expected State Changes:**
- Lobby config columns updated
- Lobby.lastActivityAt updated
- LobbyPassword upserted or deleted (depending on isPublic/password)
- All LobbyMember.isConfirmed set to false

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Lobby not found | "Lobby not found." |
| Not host/mod/admin | "Only the host, moderators, or admins can perform this action." |
| Not in Waiting stage (D-28) | "This action is not allowed in the current lobby stage ({stage})." |

---

### set_team_slot

**Purpose:** Moves a member to a different LobbySlot (BluePlayer, BlueCoach, RedPlayer, RedCoach, or Spectator).

**Permission:** Self-move: any member. Moving others: Host / Admin / Moderator. Coach assignment: Host / Referee only.

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| lobbyId | u32 | Yes | Lobby |
| targetUserId | u32 | Yes | User to move (can be self) _Superseded in Phase S9c execution (DECISIONS.md A74)._ |
| lobbySlot | LobbySlot | Yes | Target slot |

**Flow:**
1. Authenticate caller
2. Find lobby
3. D-28: `ensureStageIs(Waiting)` — free movement only during Waiting
4. If moving someone else: `ensureHostOrAbove`; if self: `ensureLobbyMember`
5. Find target member
6. Coach guard: if assigning to a coach slot and target wasn't already a coach, require host or referee
7. Cap enforcement (checked when team/role changes):
   - **Player slots:** max `teamSize` players per team (excluding coaches)
   - **Coach slots:** max 1 coach per team
   - **Spectator:** max 12 spectators _Superseded in Phase S8f execution (DECISIONS.md A68)._ Max `Lobby.maxSpectators` (S8f-L10).
8. Delete + reinsert LobbyMember with new `lobbySlot` and `isConfirmed=false`
9. Update Lobby.lastActivityAt

**Expected State Changes:**
- LobbyMember.lobbySlot updated to new value
- LobbyMember.isConfirmed reset to false
- Lobby.lastActivityAt updated

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Lobby not found | "Lobby not found." |
| Not Waiting stage | "This action is not allowed in the current lobby stage ({stage})." |
| Moving other without permission | "Only the host, moderators, or admins can perform this action." |
| Not a member (self-move) | "You are not a member of this lobby." |
| Target not a member | "You are not a member of this lobby." |
| Coach assignment without host/referee | "Only the lobby host or referee can assign the coach role." |
| Team already has a coach | "{Blue/Red} team already has a coach." |
| Team player slots full | "{Blue/Red} team is full (max {teamSize} players)." |
| Spectator slots full | "Spectator slots are full (max 12)." _Superseded in Phase S8f execution (DECISIONS.md A68)._ "Spectator slots are full (max N)." |

---

### confirm_ready

**Purpose:** Marks the calling player as confirmed/ready.

**Permission:** Any member

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| lobbyId | u32 | Yes | Lobby |

**Flow:**
1. Authenticate caller
2. Find lobby
3. D-29: `ensureStageIs(Waiting)`
4. `ensureLobbyMember` — validate membership
5. Set `isConfirmed=true` on caller's LobbyMember
6. Update Lobby.lastActivityAt

**Expected State Changes:**
- LobbyMember.isConfirmed set to true
- Lobby.lastActivityAt updated

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Lobby not found | "Lobby not found." |
| Not Waiting stage | "This action is not allowed in the current lobby stage ({stage})." |
| Not a member | "You are not a member of this lobby." |

---

### unconfirm_ready

**Purpose:** Clears the calling player's ready confirmation.

**Permission:** Any member

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| lobbyId | u32 | Yes | Lobby |

**Flow:**
1. Authenticate caller
2. Find lobby
3. D-28: `ensureStageIs(Waiting)` — blocked once Drafting begins
4. `ensureLobbyMember` — validate membership
5. Set `isConfirmed=false` on caller's LobbyMember

**Expected State Changes:**
- LobbyMember.isConfirmed set to false

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Lobby not found | "Lobby not found." |
| Not Waiting stage | "This action is not allowed in the current lobby stage ({stage})." |
| Not a member | "You are not a member of this lobby." |

---

### set_captain

**Purpose:** Assigns the captain designation to a team member. Demotes existing captain on the same team.

**Permission:** Host / Referee (if refereeCanSetCaptain=true) / Admin (D-30)

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| lobbyId | u32 | Yes | Lobby |
| targetUserId | u32 | Yes | User to designate as captain _Superseded in Phase S9c execution (DECISIONS.md A74)._ |

**Flow:**
1. Authenticate caller
2. Find lobby
3. `ensureLobbyMember` for caller — get their row
4. Permission: host OR (referee with refereeCanSetCaptain) OR admin
5. Find target member
6. Target must be a player (BluePlayer/RedPlayer) — not Spectator, not Coach
7. Demote existing captain on the same team (set isCaptain=false)
8. Set target's isCaptain=true

**Expected State Changes:**
- Target LobbyMember.isCaptain set to true
- Previous captain on same team: isCaptain set to false (if one existed)

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Lobby not found | "Lobby not found." |
| Caller not a member | "You are not a member of this lobby." |
| No captain permission | "Only the host, an authorized referee, or an admin can assign captains." |
| Target not a member | "You are not a member of this lobby." |
| Target is spectator | "Captain must be a team member (Blue or Red), not a spectator." |
| Target is coach | "A coach cannot be assigned as captain." |

---

### create_lobby_preset

**Purpose:** Creates a new lobby preset with given configuration.

**Permission:** TournamentHost+ (Admin, Moderator, TournamentHost)

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| name | string | Yes | Display name (1-50 chars) |
| (all config fields) | various | Yes | Mirror of lobby config columns |

**Flow:**
1. Authenticate caller
2. Require TournamentHost+ role
3. Validate name length (1-50 characters)
4. Insert LobbyPreset row with `isSystemPreset=false`, `creatorUserId=caller`

**Expected State Changes:**
- LobbyPreset row inserted

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Role below TournamentHost | "Only Tournament Hosts, Moderators, and Admins can create lobby presets." |
| Name empty or > 50 chars | "Preset name must be between 1 and 50 characters." |

---

### update_lobby_preset

**Purpose:** Updates an existing lobby preset.

**Permission:** Per D-31b hierarchy: Admin (any), Moderator (own + other mod/TO, not system), TO (own only)

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| presetId | u32 | Yes | Preset to update |
| name | string | Yes | New display name (1-50 chars) |
| (all config fields) | various | Yes | Mirror of lobby config columns |

**Flow:**
1. Authenticate caller
2. Find preset
3. `ensureCanMutatePreset` — D-31b permission hierarchy
4. Validate name length (1-50 characters)
5. Update LobbyPreset row

**Expected State Changes:**
- LobbyPreset row updated with new values

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Preset not found | "Lobby preset not found." |
| Non-admin editing system preset | "Only admins can modify or delete system presets." |
| Moderator editing non-mod/non-TO preset | "Moderators can only modify presets created by moderators, TOs, or themselves." |
| TO editing another user's preset | "You do not have permission to modify this preset." |
| Name empty or > 50 chars | "Preset name must be between 1 and 50 characters." |

---

### delete_lobby_preset

**Purpose:** Deletes a lobby preset.

**Permission:** Per D-31b hierarchy (same as update)

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| presetId | u32 | Yes | Preset to delete |

**Flow:**
1. Authenticate caller
2. Find preset
3. `ensureCanMutatePreset` — D-31b permission hierarchy
4. Delete LobbyPreset row

**Expected State Changes:**
- LobbyPreset row deleted

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Preset not found | "Lobby preset not found." |
| Non-admin deleting system preset | "Only admins can modify or delete system presets." |
| Moderator deleting non-mod/non-TO preset | "Moderators can only modify presets created by moderators, TOs, or themselves." |
| TO deleting another user's preset | "You do not have permission to modify this preset." |

---

### claim_forfeit

**Purpose:** Claims a forfeit against a team whose players are all offline past the disconnect grace (D-15, D-16). Section added in Phase S4 execution (F7); `concede_match` and `defer_match` keep their Phase 10 history rows.

**Permission:** A team player, or the exclusive spectator referee when `refereeExclusiveConcede` is on and a third-party referee exists (D-81)

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| lobbyId | u32 | Yes | Target lobby |
| forfeitingTeamSide | u8 | Yes | 0 = the team opposing the caller's slot; 1 = Blue; 2 = Red. Non-zero is required for the exclusive referee (Spectator slot, no team to derive from) — F7 |

**Flow:**
1. Authenticate caller; `ensureLobbyMember`; load lobby
2. Stage must be Drafting, Equipping, Scoring or BetweenGames
   _Superseded in Phase S8e execution (DECISIONS.md A67(1))._
3. D-81: if `refereeExclusiveConcede` and a third-party referee exists, only that referee may call; otherwise spectators and coaches are rejected
4. D-15: `disconnectPolicy` must be Standard
5. F7: resolve the forfeiting team from `forfeitingTeamSide` (0 derives the team opposing the caller's slot)
6. D-16: `isForfeitEligible` — every non-coach player of that team is offline with `disconnectedAt` set and either the pool is depleted or `disconnectForfeitSeconds` (default 60) has elapsed
7. `performConcede` (trigger RefereeDecision for a referee, Disconnect otherwise)

**Expected State Changes:**
- As `performConcede`: MatchResultRecord (Validated, winner = the other team, matchEndReason Concede), Lobby.stage = AwaitingResult, system ChatMessage; casual lobbies finalize inline

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Wrong stage | "Forfeit claim is only available during Drafting, Equipping, Scoring, or BetweenGames." _Superseded in Phase S8e execution (DECISIONS.md A67(1))._ |
| Not the exclusive referee while one exists | "Only the referee can claim forfeit when referee exclusive concede is active." |
| Spectator / coach caller (no exclusive referee) | "Spectators cannot claim forfeit." / "Coaches cannot claim forfeit." |
| Policy not Standard | "Forfeit claim is only available under Standard disconnect policy." |
| Exclusive referee passes 0 | "Referee must specify forfeitingTeamSide: 1=Blue, 2=Red." |
| Value outside 0–2 | "forfeitingTeamSide must be 0 (derive), 1 (Blue) or 2 (Red)." |
| 0 from a caller without a team | "Cannot determine team for forfeit claim." |
| Team not eligible | "Opposing team is not eligible for forfeit. At least one player is still connected or grace period has not expired." |

---

## Acceptance Scenarios

### Lobby Creation (Happy Path)
**Given:** Authenticated user with no current lobby
**When:** `create_lobby` with valid Casual settings, isPublic=true
**Then:** Lobby inserted (stage=Waiting, currentPlayerCount=1). Host's LobbyMember has isReferee=true, lobbySlot=Spectator.

### Lobby Creation from Preset
**Given:** LobbyPreset with id=5 exists
**When:** `create_lobby` with presetId=5
**Then:** Lobby created successfully. Preset validated but config comes from args (host can override at creation).

### Lobby Creation (One Per User)
**Given:** User already in lobby #1 as a member
**When:** `create_lobby`
**Then:** Throws "You are already in a lobby. Leave it before creating or joining another."

### Guest Creates Casual Lobby
**Given:** Guest user (isGuest=true)
**When:** `create_lobby` with matchType=Casual
**Then:** Lobby created. rosterVisibility forced to ClosedNoRating.

### Guest Blocked from Ranked Lobby
**Given:** Guest user
**When:** `create_lobby` with matchType=Ranked
**Then:** Throws "Guests cannot create or join Ranked lobbies."

### Ranked Lobby Forces No Mirror Picks
**Given:** User creates lobby with matchType=Ranked, allowMirrorPicks=true
**When:** `create_lobby`
**Then:** Lobby created with allowMirrorPicks=false (server overrides).

### Private Lobby with Password
**Given:** User creates lobby with isPublic=false, password="secret"
**When:** `create_lobby`
**Then:** Lobby created. LobbyPassword row inserted with passwordHash="secret".

### Join by Lobby ID
**Given:** Lobby #10 exists in Waiting stage, public
**When:** `join_lobby(lobbyId=10, joinCode="", password="")`
**Then:** LobbyMember inserted with lobbySlot=Spectator. currentPlayerCount incremented. System chat: "{name} joined the lobby."

### Join by Join Code
**Given:** Lobby with joinCode="ABC123" exists in Waiting, public
**When:** `join_lobby(lobbyId=0, joinCode="ABC123", password="")`
**Then:** LobbyMember inserted with lobbySlot=Spectator.

### Join Private Lobby (Correct Password)
**Given:** Private lobby #10 with password "secret"
**When:** `join_lobby(lobbyId=10, joinCode="", password="secret")`
**Then:** Join succeeds.

### Join Private Lobby (Wrong Password)
**Given:** Private lobby #10 with password "secret"
**When:** `join_lobby(lobbyId=10, joinCode="", password="wrong")`
**Then:** Throws "Incorrect lobby password."

### Join Banned User
**Given:** LobbyBan row exists for (lobbyId=10, userId=5)
**When:** User #5 calls `join_lobby(lobbyId=10)`
**Then:** Throws "You are banned from this lobby."

### Join During Drafting (Reconnect)
**Given:** Lobby #10 in Drafting stage, user #5 has offline LobbyMember row
**When:** User #5 calls `join_lobby(lobbyId=10)`
**Then:** Existing member's isOnline set to true. No new row. No password check needed (reconnect bypasses).

### Join During Drafting (New Spectator)
**Given:** Lobby #10 in Drafting stage, user #5 has no existing member row
**When:** User #5 calls `join_lobby(lobbyId=10)` (public lobby)
**Then:** LobbyMember inserted with lobbySlot=Spectator (can only spectate an active draft).

### Join During Non-Joinable Stage
**Given:** Lobby #10 in Equipping stage
**When:** `join_lobby(lobbyId=10)`
**Then:** Throws "Cannot join a lobby in stage: Equipping"
_Superseded in Phase S8f execution (DECISIONS.md A68)._ Equipping accepts a new spectator; only AwaitingResult is closed (S8f-L9).

### Join Full Lobby (20 Members)
**Given:** Lobby #10 has 20 members
**When:** `join_lobby(lobbyId=10)`
**Then:** Throws "Lobby is full (max 20 members)."

### Join Full Spectator Slots
**Given:** Lobby #10 has 12 spectators (but < 20 total)
**When:** `join_lobby(lobbyId=10)` (new member joins as Spectator)
**Then:** Throws "Spectator slots are full (max 12)."

### Leave Lobby
**Given:** User #5 is a member of lobby #10 (Waiting, 3 members)
**When:** User #5 calls `leave_lobby(lobbyId=10)`
**Then:** LobbyMember deleted. currentPlayerCount decremented to 2. System chat: "{name} left the lobby."

### Leave Lobby (Auto-Close Empty)
**Given:** User #5 is the only member of lobby #10 (Waiting stage)
**When:** User #5 calls `leave_lobby(lobbyId=10)`
**Then:** Lobby auto-closed via `hardDeleteLobby`. All associated rows cascade-deleted. No system chat (lobby is deleted).

### Close Lobby (Host)
**Given:** Lobby #10 in Waiting stage, user #5 is host
**When:** User #5 calls `close_lobby(lobbyId=10)`
**Then:** Full cascade delete. Lobby, LobbyMember, LobbyBan, LobbyPassword, ChatMessage, MatchSession, MatchSessionStep rows all deleted.

### Close Lobby (Finished Stage)
_Superseded in Phase S8e execution (DECISIONS.md A67(1))._
**Given:** Lobby #10 in Finished stage
**When:** Host calls `close_lobby(lobbyId=10)`
**Then:** Cascade delete succeeds.

### Close Lobby (Drafting Stage — Blocked)
**Given:** Lobby #10 in Drafting stage
**When:** Host calls `close_lobby(lobbyId=10)`
**Then:** Throws "This action is not allowed in the current lobby stage (Drafting)."

### Kick Member
**Given:** Lobby #10, user #5 is host, user #7 is a member
**When:** User #5 calls `kick_member(lobbyId=10, targetUserId=7)` _Superseded in Phase S9c execution (DECISIONS.md A74)._
**Then:** User #7's LobbyMember deleted. currentPlayerCount decremented. System chat: "{name} was kicked from the lobby."

### Kick by Referee (refereeCanKick=true)
**Given:** Lobby #10 with refereeCanKick=true, user #6 is referee (not host)
**When:** User #6 calls `kick_member(lobbyId=10, targetUserId=7)` _Superseded in Phase S9c execution (DECISIONS.md A74)._
**Then:** Kick succeeds.

### Kick by Referee (refereeCanKick=false)
**Given:** Lobby #10 with refereeCanKick=false, user #6 is referee (not host, not mod/admin)
**When:** User #6 calls `kick_member(lobbyId=10, targetUserId=7)` _Superseded in Phase S9c execution (DECISIONS.md A74)._
**Then:** Throws "Only the host, moderators, admins, or an authorized referee can kick members."

### Kick Self (Blocked)
**Given:** Lobby #10, user #5 is host
**When:** User #5 calls `kick_member(lobbyId=10, targetUserId=5)` _Superseded in Phase S9c execution (DECISIONS.md A74)._
**Then:** Throws "Cannot kick yourself."

### Kick Host (Blocked)
**Given:** Lobby #10, user #5 is host, user #6 is admin
**When:** User #6 calls `kick_member(lobbyId=10, targetUserId=5)` _Superseded in Phase S9c execution (DECISIONS.md A74)._
**Then:** Throws "Cannot kick the host."

### Ban Member
**Given:** Lobby #10, user #5 is host, user #7 is a member
**When:** User #5 calls `ban_member(lobbyId=10, targetUserId=7)` _Superseded in Phase S9c execution (DECISIONS.md A74)._
**Then:** LobbyBan row inserted. User #7's LobbyMember deleted. currentPlayerCount decremented. System chat: "{name} was banned from the lobby."

### Ban Non-Member
**Given:** Lobby #10, user #5 is host, user #7 is NOT a current member
**When:** User #5 calls `ban_member(lobbyId=10, targetUserId=7)` _Superseded in Phase S9c execution (DECISIONS.md A74)._
**Then:** LobbyBan row inserted (preventive ban). No LobbyMember deletion (nothing to delete). currentPlayerCount unchanged. _Superseded in Phase S9c execution (DECISIONS.md A74): the preventive ban is gone; `ban_member` takes a seat, so its target always holds a member row (A74(2)); a user without a row is banned when they come back (S9c-L1)._

### Set Team Slot (Self-Move to BluePlayer)
**Given:** Lobby #10 (teamSize=3, Waiting), user #5 is Spectator
**When:** User #5 calls `set_team_slot(lobbyId=10, targetUserId=5, lobbySlot=BluePlayer)` _Superseded in Phase S9c execution (DECISIONS.md A74)._
**Then:** User #5's lobbySlot changed to BluePlayer. isConfirmed reset to false.

### Set Team Slot (Host Moves Other to RedPlayer)
**Given:** Lobby #10, user #5 is host, user #7 is Spectator
**When:** User #5 calls `set_team_slot(lobbyId=10, targetUserId=7, lobbySlot=RedPlayer)` _Superseded in Phase S9c execution (DECISIONS.md A74)._
**Then:** User #7 moved to RedPlayer. isConfirmed=false.

### Set Team Slot (Coach Assignment by Host)
**Given:** Lobby #10, user #5 is host, user #7 is Spectator, no existing Blue coach
**When:** User #5 calls `set_team_slot(lobbyId=10, targetUserId=7, lobbySlot=BlueCoach)` _Superseded in Phase S9c execution (DECISIONS.md A74)._
**Then:** User #7 moved to BlueCoach.

### Set Team Slot (Coach Self-Assignment Blocked)
**Given:** Lobby #10, user #7 is a regular member (not host, not referee)
**When:** User #7 calls `set_team_slot(lobbyId=10, targetUserId=7, lobbySlot=BlueCoach)` _Superseded in Phase S9c execution (DECISIONS.md A74)._
**Then:** Throws "Only the lobby host or referee can assign the coach role."

### Set Team Slot (Team Full)
**Given:** Lobby #10 (teamSize=1), Blue team already has 1 player
**When:** `set_team_slot(lobbyId=10, targetUserId=7, lobbySlot=BluePlayer)` _Superseded in Phase S9c execution (DECISIONS.md A74)._
**Then:** Throws "Blue team is full (max 1 players)."

### Set Team Slot (Duplicate Coach)
**Given:** Lobby #10, Red team already has a coach
**When:** Host calls `set_team_slot(lobbyId=10, targetUserId=7, lobbySlot=RedCoach)` _Superseded in Phase S9c execution (DECISIONS.md A74)._
**Then:** Throws "Red team already has a coach."

### Set Team Slot (Spectator Slots Full)
**Given:** Lobby #10 with 12 spectators
**When:** `set_team_slot(lobbyId=10, targetUserId=7, lobbySlot=Spectator)` (user #7 is BluePlayer) _Superseded in Phase S9c execution (DECISIONS.md A74)._
**Then:** Throws "Spectator slots are full (max 12)."

### Confirm Ready
**Given:** Lobby #10 in Waiting stage, user #5 is a member
**When:** User #5 calls `confirm_ready(lobbyId=10)`
**Then:** User #5's isConfirmed set to true.

### Unconfirm Ready
**Given:** Lobby #10 in Waiting stage, user #5 has isConfirmed=true
**When:** User #5 calls `unconfirm_ready(lobbyId=10)`
**Then:** User #5's isConfirmed set to false.

### Ready State Reset on Settings Change
**Given:** Lobby #10, user #5 and #6 both have isConfirmed=true
**When:** Host calls `update_lobby_settings(lobbyId=10, ...)`
**Then:** Both user #5 and #6 have isConfirmed reset to false.

### Update Settings (Tournament-Controlled Lobby)
**Given:** Lobby #10 with isTournamentControlled=true, teamSize=3, gameMode=MoC
**When:** Host calls `update_lobby_settings(lobbyId=10, teamSize=1, gameMode=AS, draftMode=Auction)`
**Then:** teamSize remains 3 (locked), gameMode remains MoC (locked), draftMode changes to Auction (free field).

### Update Settings (Blocked During Drafting)
**Given:** Lobby #10 in Drafting stage
**When:** Host calls `update_lobby_settings(lobbyId=10, ...)`
**Then:** Throws "This action is not allowed in the current lobby stage (Drafting)."

### Set Captain
**Given:** Lobby #10, user #7 is BluePlayer, no existing Blue captain
**When:** Host calls `set_captain(lobbyId=10, targetUserId=7)` _Superseded in Phase S9c execution (DECISIONS.md A74)._
**Then:** User #7's isCaptain set to true.

### Set Captain (Demotes Existing)
**Given:** Lobby #10, user #6 is Blue captain (isCaptain=true), user #7 is BluePlayer
**When:** Host calls `set_captain(lobbyId=10, targetUserId=7)` _Superseded in Phase S9c execution (DECISIONS.md A74)._
**Then:** User #6's isCaptain set to false. User #7's isCaptain set to true.

### Set Captain (Spectator Blocked)
**Given:** Lobby #10, user #7 is Spectator
**When:** Host calls `set_captain(lobbyId=10, targetUserId=7)` _Superseded in Phase S9c execution (DECISIONS.md A74)._
**Then:** Throws "Captain must be a team member (Blue or Red), not a spectator."

### Set Captain (Coach Blocked)
**Given:** Lobby #10, user #7 is BlueCoach
**When:** Host calls `set_captain(lobbyId=10, targetUserId=7)` _Superseded in Phase S9c execution (DECISIONS.md A74)._
**Then:** Throws "A coach cannot be assigned as captain."

### Set Captain (Referee Without Power)
**Given:** Lobby #10 with refereeCanSetCaptain=false, user #6 is referee (not host, not admin)
**When:** User #6 calls `set_captain(lobbyId=10, targetUserId=7)` _Superseded in Phase S9c execution (DECISIONS.md A74)._
**Then:** Throws "Only the host, an authorized referee, or an admin can assign captains."

### Create Lobby Preset (TO)
**Given:** User with TournamentHost role
**When:** `create_lobby_preset(name="My Config", ...)`
**Then:** LobbyPreset inserted with isSystemPreset=false, creatorUserId=caller.

### Create Lobby Preset (User Role Blocked)
**Given:** User with User role (not TO/Mod/Admin)
**When:** `create_lobby_preset(name="Config", ...)`
**Then:** Throws "Only Tournament Hosts, Moderators, and Admins can create lobby presets."

### Update Lobby Preset (Owner)
**Given:** LobbyPreset #5 created by user #10 (TO role)
**When:** User #10 calls `update_lobby_preset(presetId=5, name="Updated", ...)`
**Then:** Preset updated.

### Update Lobby Preset (Admin on System Preset)
**Given:** System preset #1 (isSystemPreset=true)
**When:** Admin calls `update_lobby_preset(presetId=1, ...)`
**Then:** Preset updated.

### Update Lobby Preset (Moderator on System Preset — Blocked)
**Given:** System preset #1 (isSystemPreset=true)
**When:** Moderator calls `update_lobby_preset(presetId=1, ...)`
**Then:** Throws "Only admins can modify or delete system presets."

### Update Lobby Preset (TO on Another's Preset — Blocked)
**Given:** LobbyPreset #5 created by user #10, user #11 is a TO
**When:** User #11 calls `update_lobby_preset(presetId=5, ...)`
**Then:** Throws "You do not have permission to modify this preset."

### Delete Lobby Preset
**Given:** LobbyPreset #5 created by user #10
**When:** User #10 calls `delete_lobby_preset(presetId=5)`
**Then:** Preset deleted.

### Delete Lobby Preset (Not Found)
**Given:** No preset with id=99
**When:** `delete_lobby_preset(presetId=99)`
**Then:** Throws "Lobby preset not found."

### Create Tournament Lobby (Happy Path)
**Given:** Tournament at InProgress with bracket match #42 (team1Id and team2Id assigned). TO is the caller.
**When:** TO calls `create_tournament_lobby(bracketMatchId=42, joinCode="")`
**Then:** Lobby created with `isTournamentControlled=true`, `tournamentId` and `bracketMatchId` set. Settings inherited from tournament: teamSize, gameMode (`tournament.defaultGameMode`), anonymity (`isAnonymousDefault`, `isAnonymousSpectators`), rosterVisibility, costSetId, disconnectPolicy (forfeit seconds derived from `autoForfeitEnabled` + `autoForfeitMinutes`). matchType derived from `countTowardsMmr` (true→Ranked, false→Casual). Host joins as Spectator with `isReferee=true`. Lobby stage=Waiting, isPublic=true.

### Create Tournament Lobby (Duplicate bracketMatchId Prevention)
**Given:** Lobby #50 already exists for bracketMatchId=42 and its stage is Waiting (not Finished).
_Superseded in Phase S8e execution (DECISIONS.md A67(5))._
**When:** TO calls `create_tournament_lobby(bracketMatchId=42, joinCode="")`
**Then:** Throws "A lobby already exists for this bracket match."

### Create Tournament Lobby (Finished Lobby Allows Recreation)
_Superseded in Phase S8e execution (DECISIONS.md A67(5))._
**Given:** Lobby #50 exists for bracketMatchId=42 but stage=Finished.
**When:** TO calls `create_tournament_lobby(bracketMatchId=42, joinCode="")`
**Then:** New lobby created successfully. Finished lobbies do not block duplicate prevention.

### Create Tournament Lobby (Unauthorized User)
**Given:** User is not a match participant, not the TO, not an assistant, and not Admin/Moderator.
**When:** User calls `create_tournament_lobby(bracketMatchId=42, joinCode="")`
**Then:** Throws "You are not authorized to create a lobby for this bracket match."

### Create Tournament Lobby (Match Participant Authorization)
**Given:** User is a TournamentParticipant on team1Id for bracket match #42.
**When:** User calls `create_tournament_lobby(bracketMatchId=42, joinCode="")`
**Then:** Lobby created. Match participants are authorized to create the lobby (D-64).

### Approve Stand-In (Happy Path)
**Given:** Tournament lobby exists for bracket match #42. User #15 is registered but not a participant in the match.
**When:** TO calls `approve_stand_in(bracketMatchId=42, userId=15)`
**Then:** TournamentStandIn row inserted with `[bracketMatchId=42, userId=15, approvedByUserId=TO]`. User #15 can now join the lobby and use `set_team_slot` to Blue/Red despite not being a registered tournament participant.

### Approve Stand-In (Duplicate — Already Approved)
**Given:** TournamentStandIn row already exists for (bracketMatchId=42, userId=15).
**When:** TO calls `approve_stand_in(bracketMatchId=42, userId=15)`
**Then:** Throws "Stand-in already approved for this bracket match."

### Approve Stand-In (Unauthorized Caller)
**Given:** Caller is a regular user (not TO, not assistant, not Admin/Moderator).
**When:** Caller calls `approve_stand_in(bracketMatchId=42, userId=15)`
**Then:** Throws "Only a tournament organizer, assistant, moderator, or admin can approve stand-ins."

### Approve Stand-In (Target User Not Found)
**Given:** No user exists with id=999.
**When:** TO calls `approve_stand_in(bracketMatchId=42, userId=999)`
**Then:** Throws "Target user not found."

### Tournament Lobby Settings Lock (Split Fields)
**Given:** Tournament-controlled lobby #10 with locked fields: teamSize=3, gameMode=MemoryOfChaos, matchType=Ranked, isAnonymousPlayers=true, isAnonymousSpectators=false, rosterVisibility=ClosedWithRating, costSetId=2, disconnectPolicy=TimerThenForfeit, allowMirrorPicks=false.
**When:** Host calls `update_lobby_settings(lobbyId=10, teamSize=1, gameMode=ApocalypticShadow, draftMode=Auction, standardTurnSeconds=90, teamBlueAlias="Alpha", refereeCanUndo=false)`
**Then:** Locked fields unchanged: teamSize=3, gameMode=MemoryOfChaos, matchType=Ranked, isAnonymousPlayers=true, isAnonymousSpectators=false, rosterVisibility=ClosedWithRating, costSetId=2, disconnectPolicy=TimerThenForfeit, allowMirrorPicks=false. Free fields updated: draftMode=Auction, standardTurnSeconds=90, teamBlueAlias="Alpha", refereeCanUndo=false. All members' isConfirmed reset to false.

### LobbyMemberAccount Auto-Created at Join (Phase 10.4)
**Given:** User with active HsrAccount, joins a non-tournament Waiting lobby
**When:** `join_lobby(lobbyId, ...)`
**Then:** LobbyMember row inserted AND LobbyMemberAccount row created for [lobbyId, userId, activeAccount.id]. (D-04, D-09, Phase 10.4 execution)

### LobbyMemberAccount Tournament Path at Join (Phase 10.4)
**Given:** User enrolled in tournament with 2 locked accounts (TPA rows), active account is account A (which is locked), joins tournament lobby
**When:** `join_lobby(lobbyId, ...)`
**Then:** LobbyMember row inserted AND LobbyMemberAccount row created using account A (active + locked). (D-04, Phase 10.4 execution)

### LobbyMemberAccount Cascade Delete at Leave (Phase 10.4)
**Given:** Player has LobbyMemberAccount row in a Waiting lobby
**When:** `leave_lobby(lobbyId)`
**Then:** LobbyMember row deleted AND LobbyMemberAccount.by_lobby_and_user rows for this user deleted. No orphaned LMA rows. (D-29, Phase 10.4 execution)

### LobbyMemberAccount Cascade Delete via hardDeleteLobby (Phase 10.4)
**Given:** Lobby with 2 members, each with LobbyMemberAccount rows
**When:** `close_lobby(lobbyId)` or lobby GC triggers `hardDeleteLobby`
**Then:** All LobbyMemberAccount rows for this lobbyId deleted before LobbyMember rows. No orphaned LMA rows. (D-28, Phase 10.4 execution)

### Reconnect Precedes the One-Lobby Check (Phase S4 execution, F1)
**Given:** User #5 has an offline LobbyMember row in lobby #10 (Drafting)
**When:** User #5 calls `join_lobby(lobbyId=10)`
**Then:** The reconnect branch runs first: isOnline=true, disconnectedAt cleared, pool decremented by the offline time. No "You are already in a lobby…" error.

### Reconnect in Waiting (Phase S4 execution, F1)
**Given:** Lobby #10 in Waiting, user #5 is a member whose client disconnected (isOnline=false)
**When:** User #5 reconnects (`client_connected`) or calls `join_lobby(lobbyId=10)`
**Then:** isOnline=true; no new row; "Cannot rejoin this lobby in its current stage." is no longer raised for Waiting.

### Disconnect Marks Offline and Schedules the Grace Check (Phase S4 execution, A22a)
**Given:** Lobby #10 in Drafting (Standard); user #5 is a Blue player, captain and referee, connected on one device
**When:** The device disconnects (`client_disconnected`)
**Then:** LobbyMember(10, 5): isOnline=false, disconnectedAt=now. One RefereeTransferCheck row (lobbyId=10, userId=5, scheduledAt=now+15 s). No flag moved, no Pause step, timerState.isPaused unchanged.

### Refresh Within 15 s Keeps Every Flag (Phase S4 execution, A22a)
**Given:** The state above, 5 s later
**When:** User #5 reconnects (`client_connected`)
**Then:** isOnline=true, disconnectedAt cleared, the RefereeTransferCheck row is deleted; isReferee, isCaptain and Lobby.hostUserId unchanged; the draft was never paused.

### Referee Still Offline After 15 s (Phase S4 execution, A22(5))
**Given:** Lobby #10 in Drafting; host #1 is the Spectator referee, offline for 15 s with no other device; members by joinSeq: #20 (Red), #10 (Blue), #30 (Spectator), all online
**When:** `run_referee_transfer_check` fires for (10, 1)
**Then:** isReferee moves to #10 (Blue players come before Red players, whatever the join order; spectators after both teams); Lobby.hostUserId moves per D-36; audit actor SYSTEM_USER_ID. No Pause step: the subject is a spectator-referee (F5).

### Offline Team Player After 15 s Pauses the Draft (Phase S4 execution, A22a, F5)
**Given:** Lobby #10 in Drafting (Standard), timerState.isPaused=false; Blue player #10 offline for 15 s
**When:** `run_referee_transfer_check` fires for (10, 10)
**Then:** One Pause step (actorUserId=0, isAutoPause=true, sequence = max step sequence + 1); timerState.isPaused=true. Under NoAction, or outside Drafting, no Pause step.

### Spectator or Coach Disconnect Never Pauses (Phase S4 execution, F5)
**Given:** Lobby #10 in Drafting; spectator #30 (or Blue coach #40) offline for 15 s
**When:** `run_referee_transfer_check` fires
**Then:** No Pause step; no referee / captain / host change unless the subject held the flag.

### Second Device Keeps the Player Online (Phase S4 execution, A48)
**Given:** User #5 connected from two identities (two UserPresence rows with isOnline=true), member of lobby #10 in Drafting
**When:** One device disconnects
**Then:** Only that identity's UserPresence row turns offline; LobbyMember.isOnline stays true; no disconnectedAt, no RefereeTransferCheck.

### Host Leaves Mid-Draft, Host Transfer Survives (Phase S4 execution, F6)
**Given:** Lobby #10 in Drafting, host #1 plays Blue with teammate #11 (online)
**When:** #1 calls `leave_lobby(10)`
**Then:** `transferHost` sets hostUserId to an eligible member and the final activity update keeps it; #1's row has voluntarilyLeft=true.
_Superseded in Phase S8f execution (DECISIONS.md A68)._ The Leave is a disconnect: the host flag moves through the 15 s check if #1 is still away (S8f-L1).

### Exclusive Referee Claims a Forfeit (Phase S4 execution, F7)
**Given:** Default lobby (refereeExclusiveConcede=true), host #1 is the Spectator referee; every Red player offline past `disconnectForfeitSeconds`
**When:** #1 calls `claim_forfeit(lobbyId, forfeitingTeamSide=2)`
**Then:** Red forfeits (`performConcede`, trigger RefereeDecision). With `forfeitingTeamSide=0` the call is rejected: "Referee must specify forfeitingTeamSide: 1=Blue, 2=Red."

### Player Claims a Forfeit (Phase S4 execution, F7)
**Given:** Lobby without an exclusive referee; Blue player #10 online; every Red player offline past the grace
**When:** #10 calls `claim_forfeit(lobbyId, forfeitingTeamSide=0)`
**Then:** Red (the opposing team) forfeits, trigger Disconnect. `isForfeitEligible` stays the gate for every value of `forfeitingTeamSide`.

### Cursor Throttle (Phase S5 execution, B-4, A43)
**Given:** Lobby #10 in Drafting; user #5 is a Blue player; `AbuseConfig.cursorMinIntervalMs = 50`
**When:** User #5 calls `broadcast_cursor(10, 0.5, 0.5)` twice 20 ms apart, then again 60 ms later
**Then:** Two `LobbyCursorEvent` rows are emitted (the first and the third call); the second call returns silently. `LobbyMember(10, 5).lastCursorAt` holds the third call's time; its audit columns are unchanged.

### Cursor Out of Bounds (Phase S5 execution, B-4)
**Given:** As above
**When:** User #5 calls `broadcast_cursor` with x = 1.5, y = -0.1 or a NaN coordinate
**Then:** No event, no error, `lastCursorAt` unchanged.

### Lobby Creation Cap (Phase S5 execution, B-7, A43)
**Given:** `AbuseConfig.lobbyCreatesPerHour = 10`; guest #7 created and closed 10 lobbies in the last hour
**When:** Guest #7 calls `create_lobby`
**Then:** Rejected: "Lobby creation limit reached: at most 10 lobbies per hour." After the hour the next create is accepted and opens a new window (`UserRateState.lobbyCreates = 1`).

### Guest Kill Switch (Phase S5 execution, A42)
**Given:** An admin called `admin_set_guest_lobby_creation(false)`; guest #7 is in no lobby; guest #8 is a member of lobby #10
**When:** Guest #7 calls `create_lobby`; a Discord-linked user calls `create_lobby`; guest #8 keeps playing
**Then:** Guest #7 is rejected: "Guest lobby creation is temporarily disabled". The linked user's lobby is created. Guest #8 and lobby #10 are unaffected (`join_lobby` is not gated). After `admin_set_guest_lobby_creation(true)` guest #7's create is accepted.

### Preset Cap (Phase S5 execution, B-7)
**Given:** `AbuseConfig.maxPresetsPerUser = 10`; TournamentHost #3 owns 10 presets
**When:** #3 calls `create_lobby_preset`
**Then:** Rejected: "Preset limit reached: you can own at most 10 lobby presets. Delete one first."

### Create Lobby With Series Settings (Phase S6 execution, A45(5), D-A8, A27, A40)
_Superseded in Phase S8e execution (DECISIONS.md A67(2))._
**Given:** A user in no lobby
**When:** They call `create_lobby` with `bestOf = 3`, `bestOfNAdvantage = Red`, `lineupFormat = Thirds`, `banRestriction = MaxOneDps`, `hideMmr = true`, `name = "  Friday scrim  "`, and `refereeExclusiveConcede` omitted
**Then:** The lobby stores those values, `name = "Friday scrim"` and `refereeExclusiveConcede = true`. Omitting all six new arguments gives name '', NoRestriction, Halves, hideMmr false, advantage None, exclusive concede true. A name longer than 50 characters is rejected.

### bestOf Capped to 1 or 3 (Phase S6 execution, A28, A38(2))
_Superseded in Phase S8e execution (DECISIONS.md A67(2))._
**Given:** A user in no lobby
**When:** They call `create_lobby` with `bestOf = 5` (or a host calls `update_lobby_settings` with `bestOf = 5`)
**Then:** Rejected: "bestOf must be 1 or 3.". `bestOf = 0` on `create_lobby` keeps the D-11 sentinel and stores 1. With `bestOf = 1` any `bestOfNAdvantage` is stored as None.

### Series Settings Editable in Waiting (Phase S6 execution, backlog #9, A33, A38(4))
_Superseded in Phase S8e execution (DECISIONS.md A67(2))._
**Given:** A casual lobby in Waiting with `bestOf = 1` and all four players confirmed
**When:** The host calls `update_lobby_settings` with `bestOf = 3` (and any of `refereeControlsShelving`, `lineupFormat`, `bestOfNAdvantage`, `banRestriction`, `hideMmr`, `name`)
**Then:** The lobby takes the new values and every member's `isConfirmed` becomes false. Keys left out keep their values. Setting `bestOf` back to 1 forces `bestOfNAdvantage = None`.

### Tournament Lobby Locks bestOf, lineupFormat and bestOfNAdvantage (Phase S6 execution, A33, A27)
_Superseded in Phase S8e execution (DECISIONS.md A67(2))._
**Given:** A tournament-controlled lobby in Waiting (`bestOf = 1`, Halves)
**When:** The host calls `update_lobby_settings` with `bestOf = 3`, then with `lineupFormat = Thirds`, then with `bestOfNAdvantage = Blue`, then with `refereeControlsShelving = false` and `banRestriction = MaxOnePerRole`
**Then:** The first three are rejected ("bestOf is set by the tournament bracket and cannot be changed in a tournament lobby." / "lineupFormat is set by the tournament and cannot be changed in a tournament lobby." / "bestOfNAdvantage is set by the tournament bracket and cannot be changed in a tournament lobby."; the head start comes from the bracket, A27); the fourth is accepted (free set).

### Cost Set Must Be Selectable and Cover the Mode (Phase S6 execution, backlog #2, D-D6)
**Given:** Published cost set #5 with Classic rows for MemoryOfChaos only; published set #6 with no rows; set #7 locked
**When:** A user calls `create_lobby` with set #6, with set #5 and `draftMode = Auction`, with set #7, with set #5 Classic, with set 0
**Then:** #6 and #5 Auction are rejected: "This cost set has no costs for MemoryOfChaos × {Classic|Auction}. Pick another set or ask its owner to extend it."; #7 is rejected ("Cost set 7 is locked and cannot be selected."); #5 Classic and set 0 are accepted. `update_lobby_settings` runs the same checks when `costSetId`, `gameMode` or `draftMode` change; presets and tournaments run them too.

### Preset Stores the Series Fields (Phase S6 execution, backlog #6)
_Superseded in Phase S8e execution (DECISIONS.md A67(2))._
**Given:** A TournamentHost+
**When:** They create a preset with `bestOf = 3`, `refereeControlsShelving = false`, `bestOfNAdvantage = Red`, `lineupFormat = Thirds`
**Then:** All four are stored and read back unchanged; `bestOf = 5` is rejected on create and update ("bestOf must be 1 or 3."); an update that omits the series keys keeps them; an update to `bestOf = 1` stores the advantage as None.

### System Preset (Phase S6 execution, A33a)
**Given:** A freshly initialized database
**When:** Anyone lists `LobbyPreset`; an Admin calls `delete_lobby_preset` on the system preset; a non-admin calls `update_lobby_preset` on it
**Then:** Exactly one row has `isSystemPreset = true` (name "Tournament default", owner SYSTEM_USER_ID 0, the tournament-lobby defaults); a second `init` adds none. The delete is rejected ("The system lobby preset cannot be deleted."); the non-admin update is rejected ("Only admins can modify or delete system presets.").

### Shuffle Teams (Phase S6 execution, A45(3))
**Given:** A lobby in Waiting: b1, b2 Blue players, r1, r2 Red players, all confirmed; the host is a spectator
**When:** The host calls `shuffle_teams(lobbyId, TeamSwap)`; later `shuffle_teams(lobbyId, RandomSwap)`
**Then:** TeamSwap: b1, b2 are Red, r1, r2 are Blue, everyone unconfirmed. RandomSwap: the four players are redistributed two per team at random (`ctx.random`), spectators and coaches stay, captain flags cleared, everyone unconfirmed. A player who is not the host (and not Moderator+) is rejected ("Only the host, moderators, or admins can perform this action."); in Drafting the call is rejected by the stage guard.

### Unban Member (Phase S6 execution, A45(3))
**Given:** The host banned r2 from lobby #10
**When:** Player b1 (no referee power) calls `unban_member(10, r2)`; then the host does; then the host repeats it _Superseded in Phase S9c execution (DECISIONS.md A74)._
**Then:** b1 is rejected ("Only the host, moderators, admins, or an authorized referee can lift a lobby ban."); the host's call deletes the `LobbyBan` row and r2 can join again; the repeat is rejected ("This user is not banned from the lobby."). A referee may unban while `refereeCanKick` is on; Moderator+ may unban without being a member.

### Guest Burst Trips the Kill Switch (Phase S6 execution, A57, A58)
**Given:** 50 guest lobby creations in the current 10-minute window, switch on
**When:** A 51st guest calls `create_lobby`; then a 52nd
**Then:** The 51st lobby is created and the switch turns off in the same transaction with one `AdminAlert` (docs/admin/contract.md "Circuit Breaker Trips"); the 52nd is rejected ("Guest lobby creation is temporarily disabled").

### The Lineup Format Is the Character Count (Phase S7 execution, A21)
**Given:** A lobby created with `lineupFormat = Thirds` (or Halves)
**When:** The host starts the draft _Superseded in Phase S10b execution (DECISIONS.md A80)._
**Then:** Each team drafts 12 characters (Halves: 8), in Classic and in Auction, and arranges them in 3 groups of 4 (Halves: 2 groups of 4). See docs/match-session/contract.md "Thirds Lobbies Draft 12 per Team".

### Only the Captain or a Referee Arranges the Lineup (Phase S7 execution, A21, backlog #3)
**Given:** Equipping; Blue has a captain and a second player; the host is the referee
**When:** The second Blue player, or the Red captain, calls `arrange_lineup` for Blue
**Then:** Rejected: "Only the Blue captain or a referee can arrange the lineup." The Blue captain and the referee (for either team) are accepted. This tightens the earlier rule that let any non-coach team member arrange.

## Edge Cases

| Case | Expected Behavior | Notes |
|------|-------------------|-------|
| Create lobby with presetId=0 | Preset validation skipped, config from args | 0 is sentinel for "no preset" |
| Create private lobby with empty password | No LobbyPassword row inserted | Password length check: `password.length > 0` _Superseded in Phase S10h execution (DECISIONS.md A99)._ |
| Join code collision after 10 retries | Throws "Could not generate a unique join code" | Extremely unlikely with 36^6 = ~2.2B codes |
| Reconnect to Drafting lobby when already online | No-op (silently returns) | Prevents duplicate member rows |
| Leave active-stage lobby (last non-left player on a team) | Auto-concede via `performConcede` (team loses, VoluntaryLeave) unless a 3rd-party referee holds exclusive concede | D-31/D-82: no hardDelete; row kept with voluntarilyLeft=true _Superseded in Phase S8f execution (DECISIONS.md A68)._ |
| Leave Shelved lobby (last member) | Count set to 0, lobby preserved (no auto-close) | D-19: Shelved lobbies persist for later return _Superseded in Phase S8e execution (DECISIONS.md A67(1))._ |
| Ban user who is already banned | Duplicate LobbyBan insert (may fail on PK) | Edge: should check existing ban first |
| set_team_slot during Drafting | Rejected by stage guard | Slots frozen once draft begins |
| unconfirm_ready during Drafting | Rejected by stage guard | Ready state locked during draft |
| Guest calls update_lobby_settings with Ranked | Forced to Casual server-side | Guest override applies regardless of input |
| disconnectForfeitSeconds=0 in create/update | Stored as undefined (not set) | 0 is sentinel for "no timeout" _Superseded in Phase S10d execution (DECISIONS.md A92)._ |
| Tournament lobby update_lobby_settings | Locked fields silently retain values | No error — free fields still update |
| Preset name exactly 50 chars | Accepted | Boundary: 1-50 inclusive |
| Preset name 51 chars | Rejected | "Preset name must be between 1 and 50 characters." |
| Moderator editing another moderator's preset | Allowed | Mods can edit mod/TO presets (not system) |
| Host is auto-referee | LobbyMember.isReferee=true at creation | No explicit set_referee reducer needed |
| lobby_gc on Waiting lobby idle > 30 min | Hard-deleted via `hardDeleteLobby` | `lastActivityAt` compared to current time _Superseded in Phase S8f execution (DECISIONS.md A68)._ |
| lobby_gc on Finished lobby idle > 30 min | Hard-deleted via `hardDeleteLobby` | Safety net for abandoned closed lobbies _Superseded in Phase S8e execution (DECISIONS.md A67(1))._ |
| lobby_gc on Drafting/Equipping/Scoring while any member online | NOT touched — skipped while a member is `isOnline && !voluntarilyLeft` | D-17/D-47 _Superseded in Phase S8f execution (DECISIONS.md A68)._ |
| lobby_gc on Drafting/Equipping/Scoring with ALL members offline > 30 min | Hard-deleted via `hardDeleteLobby` | D-47: active stages ARE collected once fully offline |
| lobby_gc on AwaitingResult | NOT touched — always skipped | D-48: finalization cascade owns this stage, not GC |
| Tournament with countTowardsMmr=true | Lobby matchType=Ranked | D-67: matchType derived from tournament flag |
| Tournament with countTowardsMmr=false | Lobby matchType=Casual | D-67: matchType derived from tournament flag |
| Duplicate bracketMatchId (non-Finished lobby exists) | Throws "A lobby already exists for this bracket match." | D-45: iterates all lobbies checking bracketMatchId + stage _Superseded in Phase S8e execution (DECISIONS.md A67(5))._ |
| Duplicate bracketMatchId (only Finished lobby exists) | New lobby created successfully | Finished lobbies do not block recreation _Superseded in Phase S8e execution (DECISIONS.md A67(5))._ |
| Reconnect when already online (Phase S4 execution, F1) | `client_connected` leaves rows already online alone; `join_lobby` reconnect rewrites the row with the same values and bumps activity | Supersedes the "No-op (silently returns)" row above |
| Disconnect in Waiting / AwaitingResult / Finished (Phase S4 execution, A22a) | isOnline=false only; no disconnectedAt, no RefereeTransferCheck | Only Drafting, Equipping, Scoring, BetweenGames, Shelved schedule the check _Superseded in Phase S8e execution (DECISIONS.md A67(1))._ |
| Disconnect under NoAction in an active stage (Phase S4 execution, A22a) | isOnline=false, disconnectedAt untouched, check scheduled (referee / captain / host may still move after 15 s); never a pause | `decideAutoPause` rejects NoAction |
| Disconnect in BetweenGames or Shelved under Standard/Deferred (Phase S4 execution, A22a; S4 review #1) | isOnline=false, check scheduled (flags may move after 15 s), **no disconnectedAt**: the D-08 forfeit clock runs only in Drafting, Equipping, Scoring, so a shelved series never drains the pool or becomes forfeit-eligible on resume | `DISCONNECT_CLOCK_STAGES` in `index.ts` _Superseded in Phase S8e execution (DECISIONS.md A67(1))._ |
| Member leaves or the lobby closes before the 15 s check fires (Phase S4 execution, A22a) | `run_referee_transfer_check` is a no-op | The scheduler consumes the row |
| Guest already in a lobby when the kill switch goes off (Phase S5 execution, A42) | Stays; can still join other lobbies; only `create_lobby` is gated | `join_lobby` has no switch check |
| `create_lobby` rejected for another reason (one-lobby rule, Ranked guest) (Phase S5 execution) | The hourly counter is not charged | The rejection rolls the transaction back |
| Two disconnects of the same (lobby, user) without a reconnect between them (Phase S4 execution) | The stale pending check is replaced; one row per pair | Idempotent scheduling |
| A player presses Leave twice in a live stage (Phase S8f execution) | The second call changes nothing | The clock keeps the first stamp (A68(2)) |
| An away player closes the tab or reloads the site (Phase S8f execution) | `client_disconnected` / `client_connected` leave the row alone; its pending 15 s check survives | A68(2) |
| A player with an abandoned row calls `leave_lobby` in a live stage (Phase S8f execution) | Nothing changes | The row stays an offline player of its team (A68(4)) |
| `maxSpectators` lowered below the current spectator count (Phase S8f execution) | Existing spectators stay; new Spectator joins are refused until the count drops | A68(8) |

## Integration Points

| This Feature | Connects To | How | Direction |
|-------------|------------|-----|-----------|
| Lobby.costSetId | CostSet.id | FK for pick cost validation | Reads |
| Lobby.tournamentId | Tournament.id | FK for tournament-controlled lobbies | Reads |
| Lobby.bracketMatchId | BracketMatch.id | FK for bracket-linked lobbies | Reads |
| LobbyMember.userId | User.id | FK for auth and display names | Reads |
| LobbyBan.bannedUserId | User.id | FK for ban records | Reads |
| LobbyPreset.creatorUserId | User.id | FK for permission hierarchy | Reads |
| create_lobby (presetId) | LobbyPreset.id | Validates preset exists | Reads |
| join_lobby (system chat) | ChatMessage table | Inserts system messages | Writes |
| close_lobby (hardDeleteLobby) | ChatMessage, MatchSession, MatchSessionStep | Cascade deletes | Writes |
| set_captain (isCaptain) | Draft reducers (pick/ban/bid) | Captain is the only actor for draft actions | Reads |
| Lobby.stage | start_draft (draftControl) | Transitions Waiting → Drafting | Writes |
| TournamentStandIn | BracketMatch, User | Approves non-registered stand-in players | Reads/Writes |
| view_lobby_browser | Lobby (anonymous view) | Projects public lobby list for browser | Reads |

## Acceptance Scenarios (Phase S8d execution)

### S8d-L1 Players are auto-seated in a tournament lobby (A26, A35)
**Given** a Waiting tournament lobby of a match between team1 and team2
**When** a member of team2 joins
**Then** the member sits on `RedPlayer`; a non-member (staff included) joins as `Spectator`; a team member whose side is full joins as `Spectator`
_Superseded in Phase S8g execution (DECISIONS.md A70)._ team1 = Blue / team2 = Red is the default only; the seat follows the colour the team plays in the bracket match (S8g-L1).

### S8d-L2 Seats outside the team are refused (A35)
**When** a team1 member (or the host moving them) asks `set_team_slot` for `RedPlayer` or `RedCoach`
**Then** rejected: "This seat is not available to you in this tournament lobby."; `BlueCoach` and `Spectator` are allowed; a casual lobby accepts every slot
_Superseded in Phase S8g execution (DECISIONS.md A70)._ Read "team1" as "the Blue team of the match" (default team1, S8g-L1).

### S8d-L3 Staff reclaim the referee flag (D.8.4)
**Given** a tournament lobby whose referee is a player
**When** a member of the lobby with `canResolveResults` calls `reclaim_referee`
**Then** the caller holds the flag; an assistant without `canResolveResults` is rejected: "Only the lobby host can reclaim the referee flag."


## Acceptance Scenarios (Phase S8e execution)

### S8e-L1 A lobby hosts one game (A67(1))
**Given** a lobby whose game is closed
**When** the close submits the game
**Then** the lobby is in AwaitingResult (or finalized and deleted for a casual standalone match); no later stage exists; `advance_to_next_game`, `shelve_series` and `resume_series` no longer exist. Supersedes D-10, D-15, D-16, D-19, D-93 and the 72 h GC rule

### S8e-L2 No series settings (A67(2))
**When** a host creates a lobby or a preset, or edits lobby settings
**Then** there is no `bestOf`, `bestOfNAdvantage` or `refereeControlsShelving` argument or column; a tournament lobby still rejects a changed `lineupFormat`

### S8e-L3 Stage lists are the live stages (A67(1))
**When** a player concedes, claims a forfeit or defers outside Drafting / Equipping / Scoring
**Then** rejected: "Concede is only available during Drafting, Equipping, or Scoring." (resp. "Forfeit claim …", "Defer …"); account selection is Waiting only ("Account selection is only allowed during the Waiting stage."); `close_lobby` is Waiting only; the referee-transfer and forfeit clocks run in Drafting, Equipping and Scoring

### S8e-L4 GC without the series rules (A67(1))
**Given** lobbies idle for more than 30 minutes
**When** `run_lobby_gc` runs
**Then** Waiting lobbies and live lobbies with every member offline are hard-deleted; AwaitingResult lobbies are kept (D-48)

## Acceptance Scenarios (Phase S8g execution)

### S8g-L1 Seats follow the bracket match's colours (A35, A70(1))
**Given** a bracket match whose staff called `set_match_sides(blueTeamId = team2)` before any lobby
**When** a member of team2 joins (or creates) the match's lobby, and a member of team1 asks `set_team_slot` for `BluePlayer`
**Then** the team2 member sits on `BluePlayer`; the team1 member is refused ("This seat is not available to you in this tournament lobby.") and may sit on `RedPlayer` / `RedCoach`; approved stand-ins follow their team's colour; with the sides never set, team1 = Blue as before

### S8g-L2 Shuffle stays refused in tournament lobbies (A35, A70(1))
**When** the host calls `shuffle_teams` in a tournament lobby
**Then** rejected: "Seats in a tournament lobby follow the bracket's sides (A35 / A70); shuffling is not available."

## Acceptance Scenarios (Phase S8f execution)

### S8f-L1 Leave in a live stage is a disconnect (A68(1)(2))
**Given** a lobby in Drafting, Equipping or Scoring under Standard or Deferred, player #11 online
**When** #11 calls `leave_lobby`
**Then** #11's row is kept with `isOnline = false`, `leftAt = now`, `disconnectedAt = now`; its LobbyMemberAccount rows and `currentPlayerCount` are unchanged; one `RefereeTransferCheck` is scheduled 15 s out; no flag moves at once; system chat "{name} left the match."; under NoAction `disconnectedAt` is not stamped

### S8f-L2 The away player stays away while browsing (A68(2))
**Given** #11 is away (S8f-L1) and still connected, or reconnects to the site
**When** `client_connected` runs, or the 15 s check fires
**Then** #11's row stays offline with `leftAt` set and its pending check is not cancelled; the check treats #11 as offline whatever the presence rows say, moves the referee flag to the first online candidate in the A22(5) order, the host to an online candidate and the captain to a teammate, and auto-pauses a Drafting lobby under Standard / Deferred

### S8f-L3 The away player returns (A68(1)(2))
**Given** #11 is away in a live stage
**When** #11 calls `join_lobby` for that lobby
**Then** `leftAt` and `disconnectedAt` are cleared, `isOnline = true`, the pool is decremented by the time away, an auto-paused draft resumes; system chat "{name} is back."; flags that moved stay where they are _Superseded in Phase S10c execution (DECISIONS.md A85)._

### S8f-L4 No automatic forfeit (A68(3))
**Given** the last Blue player leaves (or disconnects) in a live stage under Standard
**Then** the match is not conceded; once every Blue player row (away and abandoned rows included) is offline and the grace has elapsed or the pool is empty, any Red player or the exclusive referee naming Blue may `claim_forfeit`; a team with no player rows is never forfeit-eligible

### S8f-L5 Taking another lobby gives up the match (A68(4))
**Given** #11 is away from lobby ABC123 in a live stage
**When** #11 calls `create_lobby`, `join_lobby` (another lobby) or `create_tournament_lobby` without `abandonCurrentMatch`
**Then** rejected: "You left lobby ABC123 mid-match. Joining here means you cannot return to it."
**When** the same call carries `abandonCurrentMatch = true`
**Then** it succeeds and #11's row in ABC123 gets `abandonedAt = now` (`leftAt`, offline, `disconnectedAt` kept; still an offline player for the forfeit test; still counted in `currentPlayerCount`); a later `join_lobby` of ABC123 is rejected: "You left this match for another lobby and cannot return."; `view_my_lobbies` no longer lists ABC123
**And** a membership that is online, in Waiting, or a spectator / coach row still rejects with "You are already in a lobby. Leave it before creating or joining another." whatever the flag; AwaitingResult and abandoned rows never count

### S8f-L6 Players are never removed after the draft starts (A68(6))
**Given** a lobby in Drafting, Equipping or Scoring
**When** the host or an authorized referee calls `kick_member` or `ban_member` on a player
**Then** rejected: "Players cannot be removed once the draft has started; the match ends by result, concede or forfeit."; a spectator or coach target is removed; in Waiting and AwaitingResult any member but the host may be removed

### S8f-L7 A removal hands over the flags and frees the accounts (A68(6)(7))
**Given** a Waiting lobby where host #1 also holds the referee flag, members #2 (BluePlayer, joinSeq 2, offline), #3 (RedPlayer, joinSeq 3, online), #4 (Spectator)
**When** #1 calls `leave_lobby`
**Then** the host and the referee flag go to #3 (online first in the A22(5) order: Blue players, Red players, spectators, coaches by `joinSeq`); with nobody online they go to #2 (then any remaining member); #1's LobbyMember and LobbyMemberAccount rows are deleted; the same transfer runs for a spectator's or coach's leave in any stage, a kick, a ban and a user deletion; a kicked or banned member's LobbyMemberAccount rows are deleted

### S8f-L8 Spectators and coaches are free the moment they leave (A68(5))
**Given** spectator #4 in a lobby in Scoring
**When** #4 calls `leave_lobby`
**Then** the row is deleted (flags transferred if held) and #4 may create or join another lobby at once

### S8f-L9 New spectators may join a running match (A68(8))
**Given** a public lobby in Drafting, Equipping or Scoring with fewer than `maxSpectators` spectators
**When** a user who is in no lobby calls `join_lobby`
**Then** the user joins as Spectator; a lobby in AwaitingResult rejects: "Cannot join a lobby in stage: AwaitingResult"

### S8f-L10 The spectator count is a setting (A68(8))
**When** a host creates a lobby or edits its settings, or a preset is created or updated, with `maxSpectators`
**Then** a value 0-12 is stored (default 12 on create; omitted = unchanged on update); 13 is rejected: "maxSpectators must be between 0 and 12."; a tournament lobby copies it from the preset; a new Spectator join (or a `set_team_slot` into Spectator) beyond it is rejected: "Spectator slots are full (max N)."; members already in the Spectator slot are never removed by a lower value _Narrowed in Phase S8f execution (fix pass): the cap counts watchers only (S8f-L15)._

### S8f-L11 Waiting rooms survive while someone is online (A68(9))
**Given** a Waiting lobby idle for more than 30 minutes
**When** `run_lobby_gc` runs
**Then** it is kept while any member is online (away and abandoned rows count as offline) and hard-deleted once everyone is offline

### S8f-L12 The unheld referee flag can be taken (A68(7))
**Given** a lobby in which no member holds the referee flag
**When** any member calls `reclaim_referee`
**Then** the caller holds the flag; a non-member is rejected: "You are not a member of this lobby."

### S8f-L13 Account deletion follows the one-lobby test (A68(4))
**Given** a verified user who is away from a live match
**When** the user calls `delete_my_account`
**Then** rejected: "Leave your lobby before deleting your account."; a user whose only membership is abandoned (or in AwaitingResult) may delete

### S8f-L14 A DQ'd player plays the current game on (A68(6))
**Given** a tournament lobby in a live stage and a player DQ'd from a team that stays in the tournament
**When** `dq_participant` runs
**Then** the player's LobbyMember row is untouched; the DQ takes effect from the next lobby of the match (no team membership, so no seat); a DQ that takes the whole team out still settles the bracket and force-concedes the live lobby as before

### S8f-L15 maxSpectators caps watchers, not seat candidates (A68(8))
**Given** a casual lobby in Waiting with `maxSpectators = 0`
**When** a user who is in no lobby calls `join_lobby`
**Then** the user joins as Spectator (a seat candidate, D-27; the 20-member cap still applies), and the host may move a seated player back to Spectator with `set_team_slot`
**Given** the same lobby in Drafting, Equipping or Scoring, or a tournament lobby in Waiting whose auto-seat gives the joiner Spectator
**When** a user who is in no lobby calls `join_lobby`
**Then** rejected: "Spectator slots are full (max 0)."

## Acceptance Scenarios (Phase S9c execution)

### S9c-L1 Members are targeted by seat number (A74(1)(4))
**Given** an anonymous lobby #10 in Waiting: the host holds seat 1, b1 seat 2, r1 seat 3; `refereeCanKick` is off
**When** the host calls `kick_member(10, targetJoinSeq=3)`; then `kick_member(10, targetJoinSeq=9)`; then `ban_member`, `set_captain` or `transfer_referee` with `targetJoinSeq=9`
**Then** r1's row is removed exactly as a kick by user id was (flags, `LobbyMemberAccount` rows, count, the System chat line); every call naming seat 9 is rejected "No member sits at seat 9 of this lobby." The guard order is lobby → caller checks → seat: "Lobby not found." stays first, then the caller's membership and permission checks, then the seat, so a non-member caller meets the membership / permission rejection and learns nothing about which seats are occupied (`transfer_referee` has no Lobby lookup: caller membership and referee flag, then the seat; `set_team_slot` with a seat from a non-member: `ensureHostOrAbove`, then the seat). No argument or rejection names a user id; the self / host checks ("Cannot kick yourself.", "Cannot kick the host.", "You are already the referee.") run on the resolved seat

### S9c-L2 A self-move omits the seat (A74(1))
**Given** lobby #10 in Waiting, b1 (seat 2) is a Spectator and not the host
**When** b1 calls `set_team_slot(10, lobbySlot=BluePlayer)` with no `targetJoinSeq`; later `set_team_slot(10, targetJoinSeq=2, lobbySlot=Spectator)`
**Then** both are self-moves (membership only, no host check): b1 sits on BluePlayer, then on Spectator, unconfirmed each time. b1 naming another seat is rejected "Only the host, moderators, or admins can perform this action."

### S9c-L3 A ban records the seat; the unban names it (A74(2))
**Given** lobby #10, r1 holds seat 3 (present, or away in a live stage under the A68(6) rule)
**When** the host calls `ban_member(10, targetJoinSeq=3)`; then `unban_member(10, bannedJoinSeq=3)`; then the same unban again
**Then** the `LobbyBan` row carries `bannedJoinSeq = 3` and r1's row is removed as for a kick; `view_my_lobby_bans` and `view_admin_lobby_bans` show `bannedJoinSeq = 3`; the first unban deletes the ban and r1 may join again; the repeat is rejected "No ban is recorded for seat 3 of this lobby." A user who holds no row in the lobby cannot be banned (no seat to name)

### S9c-L4 Seat numbers are never reused (A74(3))
**Given** lobby #10 in Waiting with seats 1, 2, 3 taken (`Lobby.lastJoinSeq = 3`)
**When** the member on seat 3 leaves (or is kicked), then a new user joins
**Then** the new member gets seat 4 and `lastJoinSeq` becomes 4; seat 3 names the departed membership for the lobby's lifetime (a ban of seat 3 stays unambiguous). A member who returns through `join_lobby`'s reconnect path keeps their seat; the host's seat is 1 in a casual and a tournament lobby alike

## Phase History

| Decision | Source | Date |
|----------|--------|------|
| One lobby per user enforcement (D-22) | Phase 9 execution | 2026-03-29 |
| Guest restrictions: no Ranked, forced ClosedNoRating (D-23) | Phase 9 execution | 2026-03-29 |
| Host auto-referee (D-24) | Phase 9 execution | 2026-03-29 |
| All members join as Spectator (D-27) | Phase 9 execution | 2026-03-29 |
| Server-generated 6-char join codes (Jackbox-style, deterministic hash) | Phase 9 execution | 2026-03-29 |
| Private lobby password stored in LobbyPassword table (D-02) | Phase 9 execution | 2026-03-29 |
| Join by lobbyId or joinCode (D-03) | Phase 9 execution | 2026-03-29 |
| Stage-specific join: Waiting normal, Drafting reconnect/spectator, others rejected (D-04) | Phase 9 execution | 2026-03-29 |
| Close lobby only in Waiting or Finished (D-20) | Phase 9 execution | 2026-03-29 |
| Hard-delete cascade: Chat, Members, Bans, Password, Steps, Session, Lobby (D-19) | Phase 9 execution | 2026-03-29 |
| Kick/ban permission: host, admin, moderator, referee with refereeCanKick (D-21, D-32) | Phase 9 execution | 2026-03-29 |
| Settings locked during Drafting (D-28) | Phase 9 execution | 2026-03-29 |
| Tournament-controlled lobbies lock integrity fields, allow QoL fields (D-65) | Phase 9 execution | 2026-03-29 |
| Ranked forces allowMirrorPicks=false (D-42) | Phase 9 execution | 2026-03-29 |
| Settings change resets all members' isConfirmed (D-29) | Phase 9 execution | 2026-03-29 |
| LobbySlot enum: BluePlayer, BlueCoach, RedPlayer, RedCoach, Spectator | Phase 9 execution | 2026-03-29 |
| Coach slots: host/referee only can assign, max 1 per team | Phase 9 execution | 2026-03-29 |
| Cap enforcement: teamSize players/team, 1 coach/team, 12 spectators, 20 total | Phase 9 execution | 2026-03-29 |
| set_team_slot resets isConfirmed for moved member | Phase 9 execution | 2026-03-29 |
| confirm_ready / unconfirm_ready Waiting-only (D-29) | Phase 9 execution | 2026-03-29 |
| set_captain: host/referee(refereeCanSetCaptain)/admin, target must be player not coach/spectator (D-30) | Phase 9 execution | 2026-03-29 |
| Captain demoted when new captain assigned on same team | Phase 9 execution | 2026-03-29 |
| Preset system: TournamentHost+ create, D-31b permission hierarchy for edit/delete | Phase 9 execution | 2026-03-29 |
| System presets editable only by Admin | Phase 9 execution | 2026-03-29 |
| Preset name length: 1-50 characters | Phase 9 execution | 2026-03-29 |
| BanMode.Two removed — only None, Four, Six remain | Phase 9 execution | 2026-03-29 |
| Lobby GC: Waiting/Finished idle > 30min auto-deleted (D-25) | Phase 9 execution | 2026-03-29 |
| LobbyCursorEvent is event table — auto-deleted after broadcast, no cascade needed | Phase 9 execution | 2026-03-29 |
| Finalization cascade-deletes lobby (step 19 of runFinalization) — not set to Finished | Phase 9 execution | 2026-03-29 |
| AwaitingResult stage: players freed on submit, finalization cascade-deletes lobby, GC safety net for Waiting+Finished only | Phase 9 execution | 2026-03-29 |
| Added tournament lobby + stand-in + settings split + GC scenarios | Phase 9 execution | 2026-03-29 |
| DisconnectPolicy renamed: Pause->Deferred, TimerThenForfeit->Standard (D-04) | Phase 10 execution | 2026-04-03 |
| LobbyMember: voluntarilyLeft, disconnectedAt, disconnectPoolRemainingMs columns added (D-57) | Phase 10 execution | 2026-04-03 |
| Lobby: refereeExclusiveConcede column added (D-84, D-92), hostDisconnectTime/disconnectForfeitAt removed (D-60) | Phase 10 execution | 2026-04-03 |
| clientDisconnected: auto-pause drafting with isAutoPause=true, flag transfers permanent (D-08, D-34-36) | Phase 10 execution | 2026-04-03 |
| leave_lobby active match: voluntarilyLeft=true preserves row, last-player auto-concede via performConcede (D-31) | Phase 10 execution | 2026-04-03 |
| join_lobby reconnect extended to Equipping/Scoring/AwaitingResult with pool decrement (D-37) | Phase 10 execution | 2026-04-03 |
| concede_match/claim_forfeit/defer_match reducers added with 3rd party referee exclusive control (D-26, D-61-63, D-81) | Phase 10 execution | 2026-04-03 |
| lobby_gc extended for active stages: ALL members offline + 30min -> hard delete (D-47) | Phase 10 execution | 2026-04-03 |
| ensureMatchAlive guard in all draft/equip/score reducers (D-12) | Phase 10 execution | 2026-04-03 |
| LobbyMemberAccount auto-created at join_lobby for all lobby types — non-tournament uses active account, tournament validates against TPA (D-04, D-09) | Phase 10.4 execution | 2026-04-04 |
| LobbyMemberAccount cascade-deleted in all leave_lobby exit paths (Waiting normal, active voluntarilyLeft, AwaitingResult normal) (D-29) | Phase 10.4 execution | 2026-04-04 |
| hardDeleteLobby cascade extended with step 1.5: delete all LobbyMemberAccount rows for lobby before LobbyMember deletion (D-28) | Phase 10.4 execution | 2026-04-04 |
| Stand-in TPA snapshot at join_lobby: if TournamentStandIn row exists and no TPA entries yet, snapshot all accounts into TPA then create LMA (D-26) | Phase 10.4 execution | 2026-04-04 |
| Full hydration from codebase | Phase 13 normalization | 2026-04-09 |
| Phase 16 route-group rename: client-facing lobby URL remains `/lobby` (no URL change) but the file path moved `app/(authenticated)/lobby/` → `app/(authed)/lobby/`. No backend reducer, view, table, or behavior change. Acceptance scenarios and edge cases in this contract remain valid as-is | Phase 16 execution | 2026-04-18 |
| Doc-alignment correction (no new decisions): reconciled leave_lobby flow (active-stage voluntarilyLeft/concede/flag-transfer branch) and hardDeleteLobby cascade (MatchResult* + LobbyMemberAccount) with shipped code; fixed GC edge-case rows to match D-47/D-48; added missing create_lobby params (bestOf, refereeControlsShelving); corrected `_hardDeleteLobby` → `hardDeleteLobby`. Prose now matches code + this contract's own Phase 10/10.4 history | Doc correction | 2026-07-05 |
| F1: reconnect branch before `ensureNotInLobby`; Waiting is a reconnect stage; `client_connected` restores every membership and cancels pending checks | Phase S4 execution (DECISIONS.md A22(2), A22a) | 2026-11-06 |
| A22a / A48 / F5: `client_disconnected` marks offline and schedules `RefereeTransferCheck` (15 s) only when the user's last device dropped; `run_referee_transfer_check` decides referee (A22(5) order by joinSeq) / captain / host transfers and the player-only auto-pause; supersedes the Phase 10 row "clientDisconnected: auto-pause drafting…, flag transfers permanent" | Phase S4 execution (DECISIONS.md A22(5), A22a, A48) | 2026-11-06 |
| F6: `leave_lobby` spreads the re-read Lobby row after `transferHost` | Phase S4 execution (DECISIONS.md A22(2)) | 2026-11-06 |
| F7: `claim_forfeit(lobbyId, forfeitingTeamSide)`; the exclusive referee must name the team; section added to this contract | Phase S4 execution (DECISIONS.md A22(2)) | 2026-11-06 |
| R4: `LobbyMember.joinSeq` assigned at insert (host = 1, then max + 1) | Phase S4 execution (DECISIONS.md A22(5), A37) | 2026-11-06 _Superseded in Phase S9c execution (DECISIONS.md A74)._ |
| B-4: cursor bounds + per-member throttle (`cursorMinIntervalMs`); scenarios "Cursor Throttle", "Cursor Out of Bounds" added | Phase S5 execution (DECISIONS.md A43, D-B5) | 2026-11-06 |
| B-7 / A42: `create_lobby` hourly cap (guests included), guest kill switch, preset cap; scenarios "Lobby Creation Cap", "Guest Kill Switch", "Preset Cap" and two edge cases added | Phase S5 execution (DECISIONS.md A42, A43) | 2026-11-06 |
| Scenarios "Create Lobby With Series Settings", "bestOf Capped to 1 or 3", "Series Settings Editable in Waiting", "Tournament Lobby Locks bestOf and lineupFormat", "Cost Set Must Be Selectable and Cover the Mode", "Preset Stores the Series Fields", "System Preset", "Shuffle Teams", "Unban Member", "Guest Burst Trips the Kill Switch" added | Phase S6 execution (DECISIONS.md A27, A28, A33, A33a, A38, A40, A45, A57, A58, D-A8; backlog #2, #6-#9) | 2026-11-06 |
| Scenarios "The Lineup Format Is the Character Count", "Only the Captain or a Referee Arranges the Lineup" added | Phase S7 execution (DECISIONS.md A21; backlog #3) | 2026-11-06 |
| Scenarios S8d-L1..L3: auto-seat, seat enforcement, staff referee reclaim | Phase S8d execution (DECISIONS.md A26, A35; D.8.4) | 2026-11-07 |
| Scenarios S8e-L1..L4: one game per lobby, no series settings, live-stage lists, GC without the D-16 / D-17 rules; supersedes D-10, D-15, D-16, D-19, D-93 | Phase S8e execution (DECISIONS.md A67(1)(2)) | 2026-11-08 |
| Scenarios S8g-L1..L2: tournament seats follow the bracket match's colours (`set_match_sides`), shuffle guard message; S8d-L1 / L2 fixed mapping superseded | Phase S8g execution (DECISIONS.md A70) | 2026-11-08 |
| Scenarios S8f-L1..L14 and four edge cases: Leave is a disconnect, away / abandoned rows, return, no automatic forfeit, `abandonCurrentMatch`, spectator / coach leave, no player removal after the draft, flags always held (A22(5) order, online first then any), `reclaim_referee` on an unheld flag, spectator joins in the live stages and `maxSpectators`, GC presence test for Waiting, `delete_my_account`, `view_my_lobbies`; supersedes D-31, D-38, D-35, D-04 (Drafting only), D-25 (mid-match DQ kick), D-49 (unconditional Waiting rule) and the "kick at any stage" reading of D-21 / D-32 | Phase S8f execution (DECISIONS.md A68) | 2026-11-08 |
| Fix pass: S8f-L15 (`maxSpectators` caps watchers, not seat candidates; S8f-L10 narrowed); abandoning an away row with `abandonCurrentMatch` first hands any host / captain / referee flag still on it to a candidate in the A22(5) order, online first then any (A68(4)(7)) | Phase S8f execution (DECISIONS.md A68) | 2026-11-08 |
| Fix pass 2: user deletion is a row removal (A68(7)): a deleted user's membership in Waiting / AwaitingResult (and a spectator's or coach's in any stage) is removed as a leave; a player's row in a live stage is kept away and abandoned (A68(6)), offline for the forfeit test (A68(3)) and never a host / captain / referee candidate | Phase S8f execution (DECISIONS.md A68) | 2026-11-08 |
| S9a fix pass (A37): join / leave / away / return / kick / ban System chat lines carry `metadata {event, subjectUserId}` and the subject's seat label; `view_my_lobby_chat` renders them per reader, so an anonymized member is never named (chat contract "S9a fix: System Line About a Hidden Member"); `view_my_lobby_bans` masks a hidden banned user (0, "Banned player") | Phase S9a execution (DECISIONS.md A37) | 2026-11-08 |
| Scenarios S9c-L1..L4: `kick_member`, `ban_member`, `set_team_slot` (optional, omitted = self), `set_captain`, `transfer_referee` take `targetJoinSeq`, `unban_member` takes `bannedJoinSeq`; rejection "No member sits at seat N of this lobby." / "No ban is recorded for seat N of this lobby."; `LobbyBan.bannedJoinSeq`; `Lobby.lastJoinSeq` (seat numbers never reused; supersedes R4's max + 1); the `targetUserId` parameter rows and scenario calls and "Ban Non-Member" marked superseded | Phase S9c execution (DECISIONS.md A74) | 2026-11-08 |
| `broadcast_cursor` by a Spectator seat or by a non-member returns silently (no event, no error); coaches broadcast (D-34, as implemented since Phase 10 and documented here for the first time; tests `s10-chat`) | Phase S10 execution (DECISIONS.md A76) | 2026-11-09 |
| `start_draft` and `advance_stage` are referee powers: accepted from the lobby member holding the referee flag (any seat) or a Moderator / Admin; everyone else, the host included, gets "Only the referee, moderators, or admins can perform this action." with nothing changed. A host who gave the flag away takes it back with `reclaim_referee`. Scenarios that say "the host starts the draft" / "the host calls `advance_stage`" read "the referee" | Phase S10b execution (DECISIONS.md A80) | 2026-11-09 |
| Reconnect and auto-pause: the reconnect branch of `join_lobby` lifts an automatic pause only when the caller is a seated player (not a coach, not a spectator) and, after the caller's own return, no seated player of either team is offline, away or abandoned. A reload by an opponent, a coach or a spectator no longer resumes the draft. The pool, the forfeit grace and `claim_forfeit` are unchanged | Phase S10c execution (DECISIONS.md A85) | 2026-11-09 |
| Disconnect policies by lobby kind: `Deferred` only for tournaments and their lobbies ("The Deferred disconnect policy is only available for tournaments and their lobbies." in `create_lobby`, `update_lobby_settings` on a lobby that is not tournament-controlled, `create_lobby_preset`, `update_lobby_preset`); `NoAction` only for casual lobbies ("The NoAction disconnect policy is only available for casual lobbies." for a Ranked lobby, also on a `matchType` change, and for tournaments). `disconnectForfeitSeconds` is the grace before a forfeit claim or a defer, nothing is automatic: 30 to 600, and 0 or unset means the default 60 ("disconnectForfeitSeconds must be between 30 and 600 (0 keeps the default of 60).") | Phase S10d execution (DECISIONS.md A91, A92) | 2026-11-09 |
| `defer_match` needs a seated player (not a coach) who is offline, away or abandoned past the grace or with a spent pool: "Defer needs a seated player who has been disconnected past the forfeit grace or whose disconnect pool is spent."; the exclusive spectator referee (D-81) is exempt. The automatic park at an empty pool (Phase 10 D-10) is retired. A parked lobby is cleared by a Moderator or Admin, or by tournament staff through the result reducers; there is no automatic clean-up | Phase S10d execution (DECISIONS.md A91) | 2026-11-09 |
| A seated player whose row is away cannot `concede_match`, `claim_forfeit` or `defer_match` ("You are away from this match. Return to it first."); an abandoned row never can ("You left this match for another lobby and cannot act on it.") | Phase S10d execution (DECISIONS.md A92(4)) | 2026-11-09 |
| Forfeit and defer eligibility use the live pool: a player is past the threshold at the earlier of `disconnectedAt + grace` and `disconnectedAt + remaining pool`, without needing a reconnect. `view_my_lobby_members.disconnectActionAt` carries that instant for an offline, away or abandoned seated player in a live stage under Standard or Deferred | Phase S10d execution (DECISIONS.md A92(6), A92(9)) | 2026-11-09 |
| Waiting stage: a host or referee who disconnects is subject to the 15 s transfer check (A22(5) order, online first); no `disconnectedAt` stamp and no pause in Waiting; other members schedule nothing. This replaces "no RefereeTransferCheck" in the Phase S4 edge-case row for Waiting | Phase S10d execution (DECISIONS.md A92(5)) | 2026-11-09 _Superseded in Phase S10e execution (DECISIONS.md A93)._ |
| `client_connected` lifts an auto-pause under the same test as the `join_lobby` reconnect (a seated player returns and no seated player is still away); both paths share one helper and one clock write | Phase S10d execution (DECISIONS.md A92(7)) | 2026-11-09 |
| A disconnect during a manual pause adds no auto-pause; the pauser or the referee resumes by D-62 and the draft runs. Accepted behaviour: the forfeit clock and the pool still run for the away player, and the captain role moves to a present teammate | Phase S10d execution (DECISIONS.md A92(8)) | 2026-11-09 |
| Waiting stage, host and referee: a disconnect moves the referee flag only (15 s check, A22(5) order, online first); the host role does not move on a disconnect in Waiting and no room closes because its host is away (the clean-up stays: every member offline and 30 minutes idle). A host who presses Leave in Waiting still passes the role on; in the live stages the host role moves with the 15 s check, and `start_draft` schedules that check for a host or referee who is offline at the start | Phase S10e execution (DECISIONS.md A93) | 2026-11-09 |
| `transfer_host(lobbyId, targetJoinSeq)`: the host, a Moderator or an Admin hands the host role to a present member by seat, in any stage; the referee flag does not move. Rejections: "Only the host, moderators, or admins can hand over the host role.", "No member sits at seat N of this lobby.", "The member at seat N is already the host.", "The member at seat N has left the match and cannot become the host." | Phase S10e execution (DECISIONS.md A93) | 2026-11-09 |
| Lobby settings are range-checked in `create_lobby`, `update_lobby_settings` and both preset reducers: `teamSize` 1 to 3; `standardTurnSeconds` 10 to 600; `reserveBankSeconds` 0 to 1800; the three budgets and `minimumBidRaise` finite, 0 to 100000; the four signed handicaps -1000000 to 1000000 hundredths, `rosterThreshold` 0 to 1000000; team aliases at most 30 characters. `start_draft` rejects a team with more players than `teamSize`. Switching a lobby to Ranked while a guest is a member is rejected | Phase S10e execution (backend audit 2026-11-09, lobby findings 5, 10, 24) | 2026-11-09 |
| `set_team_slot` clears the captain flag when the member changes team, moves between player and coach, or moves to Spectator: no team can hold two captains | Phase S10e execution (backend audit 2026-11-09, lobby finding 3) | 2026-11-09 |
| Membership rate: at most 20 joins, returns and seat moves per user per 10 s window ("You are changing lobbies or seats too quickly. Please wait a moment."); a host moving other members is charged to the host; `leave_lobby` and a plain reconnect are never counted or rejected | Phase S10e execution (backend audit 2026-11-09, lobby finding 6) | 2026-11-09 |
| Account locks and abandoned matches: an abandoned membership keeps its `LobbyMemberAccount` rows (the team's ownership pool is unchanged mid-draft), and the roster guards ("Leave the lobby first") ignore memberships whose row is abandoned, so the player can change, edit or delete that account | Phase S10e execution (backend audit 2026-11-09, lobby finding 12) | 2026-11-09 |
| Away and abandoned members cannot act: every action reducer of the lobby rejects a caller whose row is away ("You are away from this lobby. Return to it before acting.") or abandoned ("You left this match for another lobby and can no longer act in it."): account selection, chat, seats and ready, captain, kick / ban / unban, referee and host transfers, settings and close, start and advance, every draft and Auction action including the timer expiries, undo, pause and resume, the package edits, score entry, adjustments, confirm and close, and a referee's `finalize_match_result`. `broadcast_cursor` drops the call silently. `join_lobby` and `leave_lobby` are unaffected; concede, claim and defer keep their A92(4) texts; Moderator and Admin powers never depend on presence; `dispute_match_result` stays open to the record's participants | Phase S10h execution (DECISIONS.md A98) | 2026-11-10 |
| `transfer_referee` and `set_captain` reject an away or abandoned target ("The member at seat N has left the match and cannot become the referee." / "… a captain."), as `transfer_host` does | Phase S10h execution (DECISIONS.md A98, S10h review F5) | 2026-11-10 |
| A private lobby needs a password: `create_lobby` with `isPublic = false` and an empty password is rejected ("A private lobby needs a password."), and so is switching a lobby to private while it has no password row. An empty password argument on a lobby that stays private keeps the current password; switching to public deletes the password, so going back to private needs a new one | Phase S10h execution (DECISIONS.md A99) | 2026-11-10 |
| `create_lobby` takes neither `joinCode` nor `presetId`, and `create_tournament_lobby` takes no `joinCode`: the server always generates the 6-character join code, and a preset is applied by the lobby form, which sends the final settings. A lobby is joined through `join_lobby` by its code or by its id (the lobby list); a private lobby needs its password on both paths. Tournament lobbies still take their settings from the tournament's preset | Phase S10n execution (DECISIONS.md A114, A116) | 2026-11-10 |
| The per-user membership allowance (20 per 10 s) also counts the calendar reducers and the player roster writes | Phase S10s execution (DECISIONS.md A122(4)) | 2026-11-10 |

---

*Last updated: 2026-11-06*
*Feature owner: Phase 10 / Phase 16*
