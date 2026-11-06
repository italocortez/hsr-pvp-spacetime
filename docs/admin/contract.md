# Admin & Server Operations

**Architecture:** [architecture.md](architecture.md)

## Feature Overview

Admin and server operations handle privileged actions: server identity registration, Discord account linking, user role management, bulk game data seeding, user deletion cascades, and field-level user updates. All admin reducers require `ensureAdmin(ctx)`, all server reducers require `requireServer(ctx)`.

## Reducers

### register_server

**Purpose:** Register the server's SpacetimeDB identity (first-come-first-served) and create the SYSTEM user

**Permission:** First caller only (subsequent calls rejected)

**Parameters:** None (uses `ctx.sender`)

**Flow:**
1. Check if any ServerIdentity row exists
2. If exists → reject
3. Insert ServerIdentity row with `ctx.sender`
4. Create SYSTEM user (id=autoInc, discordId="1", role=Admin)
5. Link ServerIdentity → UserIdentity for SYSTEM user

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Server identity already registered | "Server identity already registered. To re-register, clear the database first." |

### server_link_discord

**Purpose:** Link a Discord account to a user — upgrades guest to verified, re-points identity for returning users

**Permission:** Server identity

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| discordId | string | Yes | Discord user ID |
| discordUsername | string | Yes | Discord username |
| callerIdentityHex | string | Yes | Hex string of the client's SpacetimeDB identity |

**Flow:**
1. Validate required params (discordId, discordUsername, callerIdentityHex)
2. Parse caller identity from hex
3. Look up existing user by discordId
4. If returning user → re-point their UserIdentity to the new caller identity, clean orphaned guest
5. If new user → find guest user by caller identity → upgrade (set discordId, username, isGuest=false)
6. If no guest found → create new verified user

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Missing discordId | "discordId is required" |
| Missing discordUsername | "discordUsername is required" |
| Missing callerIdentityHex | "callerIdentityHex is required" |
| Caller identity not registered | "Identity not registered. Call login_as_guest first." |

### server_set_role

**Purpose:** Set a user's role by username

**Permission:** Server identity

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| username | string | Yes | Target user's username |
| roleTag | string | Yes | Role name (User, Moderator, TournamentHost, Admin) |

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Missing username | "username is required" |
| Invalid role | "Invalid role \"{roleTag}\". Must be one of: User, Moderator, TournamentHost, Admin" |
| User not found | "User \"{username}\" not found" |

### server_delete_user

**Purpose:** Delete a user by username via `performUserDeletion`

**Permission:** Server identity

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| username | string | Yes | Target user's username |

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Missing username | "username is required" |
| User not found | "User \"{username}\" not found" |

### server_set_mmr

**Purpose:** Upsert an MmrRating row for a user + game mode

**Permission:** Server identity

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| userId | u32 | Yes | Target user ID |
| gameMode | string | Yes | Game mode (MemoryOfChaos, ApocalypticShadow, AnomalyArbitration) |
| rating | f64 | Yes | New MMR rating value |

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| User not found | "User #{userId} not found" |
| Invalid game mode | "Invalid gameMode \"{gameMode}\". Must be one of: MemoryOfChaos, ApocalypticShadow, AnomalyArbitration" |

### admin_delete_row

**Purpose:** Generic row deletion with table-specific guards

**Permission:** Admin

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| tableName | string | Yes | Target table name |
| primaryKeyJson | string | Yes | JSON-encoded primary key value |

**Flow:**
1. `ensureAdmin(ctx)`
2. Switch on tableName — each table has its own deletion logic
3. User: soft-delete (sets deletedAt, schedules UserDeletionJob)
4. Lobby/MatchSession: blocking guard if active
5. All others: direct delete by PK

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Not admin | ensureAdmin throws |
| Row not found | "Row not found" |
| User already pending deletion | "User #{id} is already pending deletion." |
| Active lobby blocking | "Cannot delete lobby #{id}: lobby is currently active..." |
| Active match blocking | "Cannot delete match session for lobby #{id}: match is active..." |
| Unknown table | "Unknown table: {tableName}" |

### admin_bulk_upsert

**Purpose:** Bulk upsert rows into game data tables (HsrCharacter, HsrLightcone, costs, archetypes)

**Permission:** Admin

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| tableName | string | Yes | Target table (HsrCharacter, HsrLightcone, HsrCharacterCost, HsrLightconeCost, HsrSynergyCost, Archetype, HsrCharacterArchetype) |
| jsonData | string | Yes | JSON array of row objects |

**Flow:**
1. `ensureAdmin(ctx)`
2. Parse jsonData as JSON array
3. Validate each row's keys against `EXPECTED_KEYS[tableName]`
4. For each row: find existing by PK → update if exists, insert if not
5. Table-specific side effects (e.g., HsrCharacter upsert triggers accountRating recomputation)
6. Phase 15.4 shape for cost tables (HsrCharacterCost, HsrLightconeCost, HsrSynergyCost): each row object in jsonData must include the new `draftMode` key ("Classic" or "Auction") and the unified `costs` struct (replacing the prior separate `classicCosts` + `auctionBaseBid` keys). `EXPECTED_KEYS` enforcement rejects rows missing `draftMode`; `ENUM_VARIANTS.draftMode` is validated against `Object.keys(DraftMode.variants)`. Existence match for upsert uses a full tuple comparison: character/lightcone = `(name, gameMode.tag, draftMode.tag, costSetId)`, synergy = `(sourceName, targetName, gameMode.tag, draftMode.tag, costSetId)`. Tuple-filter with tagged-union enum values is unsupported by current bindings (A2_FALLBACK_ITER, extends Phase 15.1 precedent) so the match is implemented via `ctx.db.<Table>.iter()` with an extended predicate, not via multi-column btree filter. Character/lightcone upserts use delete+insert on the composite tuple; synergy upsert uses `id.update()` (autoInc PK) after the tuple-iter predicate match.

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Not admin | ensureAdmin throws |
| jsonData not an array | "jsonData must be a JSON array" |
| Unsupported table | "Bulk upsert not supported for table: {tableName}" |

### admin_update_user

**Purpose:** Field-level user updates (role, displayName, avatarCharacterName, etc.)

**Permission:** Admin

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| userId | u32 | Yes | Target user ID |
| fieldsJson | string | Yes | JSON object with fields to update |

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Not admin | ensureAdmin throws |
| User not found | "User not found" |
| Username taken | "Username \"{username}\" is already taken" |

### run_user_deletion (scheduled)

**Purpose:** Execute the user deletion cascade after the 5-second delay

**Permission:** Scheduled (not user-callable)

**Flow:**
1. Find UserDeletionJob for userId
2. Call `performUserDeletion` — cascade-delete UserIdentity, HsrAccountCharacter, HsrAccount, AvailabilitySlot, SavedCalendar, CalendarEventInvite, CalendarEvent
3. If user has history references → soft-delete (username='deleted_{id}', discordId=undefined, displayName preserved)
4. If guest with no history → hard-delete User row
5. Delete the UserDeletionJob row

## Acceptance Scenarios

### Server Registration (First Time)
**Given:** No ServerIdentity row exists
**When:** `register_server` is called
**Then:** ServerIdentity inserted. SYSTEM user created with discordId="1", role=Admin. UserIdentity links server identity to SYSTEM user.

### Server Registration (Already Registered)
**Given:** ServerIdentity row exists
**When:** `register_server` is called again
**Then:** Throws "Server identity already registered. To re-register, clear the database first."

### Discord Link (New User from Guest)
**Given:** Guest user exists with identity matching callerIdentityHex
**When:** `server_link_discord(discordId="123", discordUsername="player1", callerIdentityHex="{hex}")`
**Then:** Guest user upgraded: `discordId="123"`, `username="player1"`, `isGuest=false`

### Discord Link (Returning User)
**Given:** Verified user exists with discordId="123", connecting from a new device (new identity)
**When:** `server_link_discord(discordId="123", discordUsername="player1", callerIdentityHex="{newHex}")`
**Then:** UserIdentity re-pointed to new identity. Old orphaned guest (if any) cleaned up.

### Role Assignment
**Given:** User "player1" exists with role=User
**When:** `server_set_role(username="player1", roleTag="TournamentHost")`
**Then:** `User.role = TournamentHost`

### Role Assignment (Invalid Role)
**Given:** User "player1" exists
**When:** `server_set_role(username="player1", roleTag="SuperAdmin")`
**Then:** Throws "Invalid role \"SuperAdmin\". Must be one of: User, Moderator, TournamentHost, Admin"

### Bulk Upsert (HsrCharacter)
**Given:** HsrCharacter table has 80 rows
**When:** `admin_bulk_upsert(tableName="HsrCharacter", jsonData="[{name:'newchar',...}]")`
**Then:** New character inserted (81 rows). Existing characters with matching name updated.

### Bulk Upsert (Unsupported Table)
**Given:** Admin user
**When:** `admin_bulk_upsert(tableName="User", jsonData="[...]")`
**Then:** Throws "Bulk upsert not supported for table: User"

### User Deletion (Verified User with History)
**Given:** Verified user id=5 with MatchParticipantHistory references
**When:** `admin_delete_row(tableName="User", primaryKeyJson="5")`
**Then:** `User.deletedAt` set. UserDeletionJob scheduled for 5s. After job runs: UserIdentity, HsrAccountCharacter, HsrAccount, calendar rows cascade-deleted. User soft-deleted: `username="deleted_5"`, `discordId=undefined`, `displayName` preserved.

### User Deletion (Guest with No History)
**Given:** Guest user id=10 with no history references
**When:** `admin_delete_row(tableName="User", primaryKeyJson="10")`
**Then:** `User.deletedAt` set. UserDeletionJob scheduled. After job runs: all linked rows cascade-deleted. User row hard-deleted (removed entirely).

### User Deletion (Already Pending)
**Given:** User id=5 already has `deletedAt` set
**When:** `admin_delete_row(tableName="User", primaryKeyJson="5")`
**Then:** Throws "User #5 is already pending deletion."

### Admin Update User (Role Change)
**Given:** User id=5, role=User
**When:** `admin_update_user(userId=5, fieldsJson='{"role":"TournamentHost"}')`
**Then:** `User.role = TournamentHost`

### Admin Update User (Username Conflict)
**Given:** User id=5 username="alice", User id=6 username="bob"
**When:** `admin_update_user(userId=5, fieldsJson='{"username":"bob"}')`
**Then:** Throws "Username \"bob\" is already taken"

### MMR Override
**Given:** User id=5 exists, no MmrRating for MemoryOfChaos
**When:** `server_set_mmr(userId=5, gameMode="MemoryOfChaos", rating=1500)`
**Then:** MmrRating row inserted with userId=5, gameMode=MemoryOfChaos, rating=1500

### MMR Override (Invalid Mode)
**Given:** User id=5 exists
**When:** `server_set_mmr(userId=5, gameMode="InvalidMode", rating=1500)`
**Then:** Throws "Invalid gameMode \"InvalidMode\". Must be one of: MemoryOfChaos, ApocalypticShadow, AnomalyArbitration"

## Edge Cases

| Case | Expected Behavior | Notes |
|------|-------------------|-------|
| Bulk upsert with empty array | No-op — no rows inserted or updated | jsonData="[]" is valid |
| Bulk upsert with unknown fields | SenderError — EXPECTED_KEYS validation rejects | Per-table key allowlist |
| Delete user who owns active lobby | Blocked — "Cannot delete lobby" guard | Must close lobby first |
| server_link_discord for already-verified user | Re-links identity, updates discordUsername | Supports account migration |
| run_user_deletion for non-existent job | No-op — UserDeletionJob not found | Race condition safe |

## Integration Points

| This Feature | Connects To | How | Direction |
|-------------|------------|-----|-----------|
| `admin_bulk_upsert` | HsrCharacter, HsrLightcone, costs, archetypes | Direct table writes | writes |
| `admin_bulk_upsert` (HsrCharacter) | accountRating recomputation | Auto-triggers rating update when maxPossible changes | writes |
| `performUserDeletion` | HsrAccount, Calendar, UserIdentity | Cascade deletes | writes |
| `server_link_discord` | Auth (User, UserIdentity) | Upgrades guest → verified | writes |
| `server_set_mmr` | MMR (MmrRating) | Direct upsert | writes |
| `ensureAdmin` / `ensureTournamentHost` | All privileged reducers | Permission gate | reads |

## Phase History

| Decision | Source | Date |
|----------|--------|------|
| register_server first-come-first-served + SYSTEM user | Phase 1 execution | 2026-03-16 |
| server_link_discord with guest upgrade + returning user re-point | Phase 1 execution | 2026-03-16 |
| admin_bulk_upsert with EXPECTED_KEYS validation | Phase 1 execution | 2026-03-16 |
| User deletion soft-delete pattern with 5s scheduled cascade | Phase 2 execution | 2026-03-16 |
| admin_update_user field-level updates | Phase 3 execution | 2026-03-17 |
| Calendar cascade in performUserDeletion | Phase 8 execution | 2026-03-28 |
| Auth/Admin doc separation | Pre-Phase 11 cleanup | 2026-04-06 |
| Full hydration from codebase | Phase 13 normalization | 2026-04-09 |
| `admin_bulk_upsert` HsrCharacterCost/HsrLightconeCost/HsrSynergyCost EXPECTED_KEYS updated: new `draftMode` key, unified `costs` struct replaces separate `classicCosts`+`auctionBaseBid` keys | Phase 15.4 execution | 2026-04-15 |
| HsrCharacterCost+HsrLightconeCost upsert branches: delete+insert pattern retained; A2_FALLBACK_ITER (SpacetimeDB 2.1.0 enum-struct btree limitation) extends Phase 15.1 precedent | Phase 15.4 execution | 2026-04-15 |
| HsrSynergyCost upsert uses `id.update()` (autoInc PK) — tuple match via iter()+predicate follows the Phase 15.4 reducer pattern | Phase 15.4 execution | 2026-04-15 |
