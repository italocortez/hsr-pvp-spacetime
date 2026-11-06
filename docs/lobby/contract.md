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
| joinCode | string | Yes | Ignored — server generates a 6-char code |
| presetId | u32 | Yes | Preset to copy config from (0 = no preset) |
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
| disconnectForfeitSeconds | u32 | Yes | Auto-forfeit timeout (0 = not set) |
| teamBlueAlias | string | Yes | Blue team display name |
| teamRedAlias | string | Yes | Red team display name |
| bestOf | u8 | Yes | Series length (0 → 1; 1 = single game, 3/5/7 = series) |
| refereeControlsShelving | bool | Yes | Referee controls shelve/continue in BetweenGames |

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
7. D-02: Password check for private lobbies — compare against LobbyPassword row
8. Cap enforcement: max 20 total members, max 12 spectators
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
| Non-Waiting/non-Drafting stage (D-04) | "Cannot join a lobby in stage: {stage}" |
| Wrong password (D-02) | "Incorrect lobby password." |
| 20 members already | "Lobby is full (max 20 members)." |
| 12 spectators already | "Spectator slots are full (max 12)." |

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
   - D-29 spectators & coaches: delete their LobbyMemberAccount rows, delete LobbyMember row, decrement `currentPlayerCount`, return
   - D-31 players: delete LobbyMemberAccount rows; delete + reinsert LobbyMember with `voluntarilyLeft=true`, `isOnline=false` — **row is kept for finalization, count NOT decremented**
   - D-34/35/36: `transferCaptain`, `transferReferee`, `transferHost` to the next eligible online team member
   - D-31/D-82: if the leaver's team has no remaining non-left members, `performConcede` (their team loses, reason VoluntaryLeave) — UNLESS `refereeExclusiveConcede` + a third-party referee is present (then blocked; referee decides)
   - Insert system ChatMessage "{name} left the match."; return
3. **Normal branch** (Waiting / AwaitingResult / Finished): delete LobbyMemberAccount rows; delete LobbyMember row; compute new count
4. If new count reaches 0 and stage is Waiting: auto-close via `hardDeleteLobby`
5. D-19: if new count reaches 0 and stage is Shelved: set count to 0, do NOT delete (preserved for return)
6. Otherwise: update Lobby activity timestamp and insert system ChatMessage "{name} left the lobby."

**Expected State Changes:**
- Normal branch: LobbyMember + LobbyMemberAccount rows deleted, `currentPlayerCount` decremented, `lastActivityAt` updated, system ChatMessage inserted
- Active-stage player leave: LobbyMember row kept (`voluntarilyLeft=true`, `isOnline=false`), LobbyMemberAccount rows deleted, captain/referee/host flags transferred, count unchanged; possible auto-concede
- (If empty + Waiting: full cascade delete of lobby and all associated rows via `hardDeleteLobby`)
- (If empty + Shelved: count set to 0, lobby preserved for later return)

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Lobby not found | "Lobby not found." |
| Not a member | "You are not a member of this lobby." |

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
| Stage not Waiting or Finished (D-20) | "This action is not allowed in the current lobby stage ({stage})." |

---

### kick_member

**Purpose:** Removes a member from a lobby without banning them.

**Permission:** Host / Admin / Moderator / Referee (if refereeCanKick=true)

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| lobbyId | u32 | Yes | Lobby |
| targetUserId | u32 | Yes | User to kick |

**Flow:**
1. Authenticate caller
2. Find lobby
3. `ensureLobbyMember` for caller — get their LobbyMember row
4. `canKickOrBan` permission check (host, admin, moderator, or referee with refereeCanKick)
5. Cannot kick self or the host
6. Validate target is a member
7. Delete target's LobbyMember row
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
| Target not a member | "Target user is not a member of this lobby." |

---

### ban_member

**Purpose:** Bans a user from a lobby, creating a LobbyBan row and removing current membership.

**Permission:** Host / Admin / Moderator / Referee (if refereeCanKick=true)

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| lobbyId | u32 | Yes | Lobby |
| targetUserId | u32 | Yes | User to ban |

**Flow:**
1. Authenticate caller
2. Find lobby
3. `ensureLobbyMember` for caller
4. `canKickOrBan` permission check
5. Cannot ban self or the host
6. Insert LobbyBan row (lobbyId, bannedUserId, bannedByUserId)
7. If target is currently a member: delete LobbyMember, decrement `currentPlayerCount`
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
| targetUserId | u32 | Yes | User to move (can be self) |
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
   - **Spectator:** max 12 spectators
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
| Spectator slots full | "Spectator slots are full (max 12)." |

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
| targetUserId | u32 | Yes | User to designate as captain |

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
**Given:** Lobby #10 in Finished stage
**When:** Host calls `close_lobby(lobbyId=10)`
**Then:** Cascade delete succeeds.

### Close Lobby (Drafting Stage — Blocked)
**Given:** Lobby #10 in Drafting stage
**When:** Host calls `close_lobby(lobbyId=10)`
**Then:** Throws "This action is not allowed in the current lobby stage (Drafting)."

### Kick Member
**Given:** Lobby #10, user #5 is host, user #7 is a member
**When:** User #5 calls `kick_member(lobbyId=10, targetUserId=7)`
**Then:** User #7's LobbyMember deleted. currentPlayerCount decremented. System chat: "{name} was kicked from the lobby."

### Kick by Referee (refereeCanKick=true)
**Given:** Lobby #10 with refereeCanKick=true, user #6 is referee (not host)
**When:** User #6 calls `kick_member(lobbyId=10, targetUserId=7)`
**Then:** Kick succeeds.

### Kick by Referee (refereeCanKick=false)
**Given:** Lobby #10 with refereeCanKick=false, user #6 is referee (not host, not mod/admin)
**When:** User #6 calls `kick_member(lobbyId=10, targetUserId=7)`
**Then:** Throws "Only the host, moderators, admins, or an authorized referee can kick members."

### Kick Self (Blocked)
**Given:** Lobby #10, user #5 is host
**When:** User #5 calls `kick_member(lobbyId=10, targetUserId=5)`
**Then:** Throws "Cannot kick yourself."

### Kick Host (Blocked)
**Given:** Lobby #10, user #5 is host, user #6 is admin
**When:** User #6 calls `kick_member(lobbyId=10, targetUserId=5)`
**Then:** Throws "Cannot kick the host."

### Ban Member
**Given:** Lobby #10, user #5 is host, user #7 is a member
**When:** User #5 calls `ban_member(lobbyId=10, targetUserId=7)`
**Then:** LobbyBan row inserted. User #7's LobbyMember deleted. currentPlayerCount decremented. System chat: "{name} was banned from the lobby."

### Ban Non-Member
**Given:** Lobby #10, user #5 is host, user #7 is NOT a current member
**When:** User #5 calls `ban_member(lobbyId=10, targetUserId=7)`
**Then:** LobbyBan row inserted (preventive ban). No LobbyMember deletion (nothing to delete). currentPlayerCount unchanged.

### Set Team Slot (Self-Move to BluePlayer)
**Given:** Lobby #10 (teamSize=3, Waiting), user #5 is Spectator
**When:** User #5 calls `set_team_slot(lobbyId=10, targetUserId=5, lobbySlot=BluePlayer)`
**Then:** User #5's lobbySlot changed to BluePlayer. isConfirmed reset to false.

### Set Team Slot (Host Moves Other to RedPlayer)
**Given:** Lobby #10, user #5 is host, user #7 is Spectator
**When:** User #5 calls `set_team_slot(lobbyId=10, targetUserId=7, lobbySlot=RedPlayer)`
**Then:** User #7 moved to RedPlayer. isConfirmed=false.

### Set Team Slot (Coach Assignment by Host)
**Given:** Lobby #10, user #5 is host, user #7 is Spectator, no existing Blue coach
**When:** User #5 calls `set_team_slot(lobbyId=10, targetUserId=7, lobbySlot=BlueCoach)`
**Then:** User #7 moved to BlueCoach.

### Set Team Slot (Coach Self-Assignment Blocked)
**Given:** Lobby #10, user #7 is a regular member (not host, not referee)
**When:** User #7 calls `set_team_slot(lobbyId=10, targetUserId=7, lobbySlot=BlueCoach)`
**Then:** Throws "Only the lobby host or referee can assign the coach role."

### Set Team Slot (Team Full)
**Given:** Lobby #10 (teamSize=1), Blue team already has 1 player
**When:** `set_team_slot(lobbyId=10, targetUserId=7, lobbySlot=BluePlayer)`
**Then:** Throws "Blue team is full (max 1 players)."

### Set Team Slot (Duplicate Coach)
**Given:** Lobby #10, Red team already has a coach
**When:** Host calls `set_team_slot(lobbyId=10, targetUserId=7, lobbySlot=RedCoach)`
**Then:** Throws "Red team already has a coach."

### Set Team Slot (Spectator Slots Full)
**Given:** Lobby #10 with 12 spectators
**When:** `set_team_slot(lobbyId=10, targetUserId=7, lobbySlot=Spectator)` (user #7 is BluePlayer)
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
**When:** Host calls `set_captain(lobbyId=10, targetUserId=7)`
**Then:** User #7's isCaptain set to true.

### Set Captain (Demotes Existing)
**Given:** Lobby #10, user #6 is Blue captain (isCaptain=true), user #7 is BluePlayer
**When:** Host calls `set_captain(lobbyId=10, targetUserId=7)`
**Then:** User #6's isCaptain set to false. User #7's isCaptain set to true.

### Set Captain (Spectator Blocked)
**Given:** Lobby #10, user #7 is Spectator
**When:** Host calls `set_captain(lobbyId=10, targetUserId=7)`
**Then:** Throws "Captain must be a team member (Blue or Red), not a spectator."

### Set Captain (Coach Blocked)
**Given:** Lobby #10, user #7 is BlueCoach
**When:** Host calls `set_captain(lobbyId=10, targetUserId=7)`
**Then:** Throws "A coach cannot be assigned as captain."

### Set Captain (Referee Without Power)
**Given:** Lobby #10 with refereeCanSetCaptain=false, user #6 is referee (not host, not admin)
**When:** User #6 calls `set_captain(lobbyId=10, targetUserId=7)`
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
**When:** TO calls `create_tournament_lobby(bracketMatchId=42, joinCode="")`
**Then:** Throws "A lobby already exists for this bracket match."

### Create Tournament Lobby (Finished Lobby Allows Recreation)
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

## Edge Cases

| Case | Expected Behavior | Notes |
|------|-------------------|-------|
| Create lobby with presetId=0 | Preset validation skipped, config from args | 0 is sentinel for "no preset" |
| Create private lobby with empty password | No LobbyPassword row inserted | Password length check: `password.length > 0` |
| Join code collision after 10 retries | Throws "Could not generate a unique join code" | Extremely unlikely with 36^6 = ~2.2B codes |
| Reconnect to Drafting lobby when already online | No-op (silently returns) | Prevents duplicate member rows |
| Leave active-stage lobby (last non-left player on a team) | Auto-concede via `performConcede` (team loses, VoluntaryLeave) unless a 3rd-party referee holds exclusive concede | D-31/D-82: no hardDelete; row kept with voluntarilyLeft=true |
| Leave Shelved lobby (last member) | Count set to 0, lobby preserved (no auto-close) | D-19: Shelved lobbies persist for later return |
| Ban user who is already banned | Duplicate LobbyBan insert (may fail on PK) | Edge: should check existing ban first |
| set_team_slot during Drafting | Rejected by stage guard | Slots frozen once draft begins |
| unconfirm_ready during Drafting | Rejected by stage guard | Ready state locked during draft |
| Guest calls update_lobby_settings with Ranked | Forced to Casual server-side | Guest override applies regardless of input |
| disconnectForfeitSeconds=0 in create/update | Stored as undefined (not set) | 0 is sentinel for "no timeout" |
| Tournament lobby update_lobby_settings | Locked fields silently retain values | No error — free fields still update |
| Preset name exactly 50 chars | Accepted | Boundary: 1-50 inclusive |
| Preset name 51 chars | Rejected | "Preset name must be between 1 and 50 characters." |
| Moderator editing another moderator's preset | Allowed | Mods can edit mod/TO presets (not system) |
| Host is auto-referee | LobbyMember.isReferee=true at creation | No explicit set_referee reducer needed |
| lobby_gc on Waiting lobby idle > 30 min | Hard-deleted via `hardDeleteLobby` | `lastActivityAt` compared to current time |
| lobby_gc on Finished lobby idle > 30 min | Hard-deleted via `hardDeleteLobby` | Safety net for abandoned closed lobbies |
| lobby_gc on Drafting/Equipping/Scoring while any member online | NOT touched — skipped while a member is `isOnline && !voluntarilyLeft` | D-17/D-47 |
| lobby_gc on Drafting/Equipping/Scoring with ALL members offline > 30 min | Hard-deleted via `hardDeleteLobby` | D-47: active stages ARE collected once fully offline |
| lobby_gc on AwaitingResult | NOT touched — always skipped | D-48: finalization cascade owns this stage, not GC |
| Tournament with countTowardsMmr=true | Lobby matchType=Ranked | D-67: matchType derived from tournament flag |
| Tournament with countTowardsMmr=false | Lobby matchType=Casual | D-67: matchType derived from tournament flag |
| Duplicate bracketMatchId (non-Finished lobby exists) | Throws "A lobby already exists for this bracket match." | D-45: iterates all lobbies checking bracketMatchId + stage |
| Duplicate bracketMatchId (only Finished lobby exists) | New lobby created successfully | Finished lobbies do not block recreation |

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

---

*Last updated: 2026-07-05*
*Feature owner: Phase 10 / Phase 16*
