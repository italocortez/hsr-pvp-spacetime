# Roster Management

**Architecture:** [architecture.md](architecture.md)

## Feature Overview

Players create HSR account entries (up to 5 per user), add owned characters with eidolon levels, control roster/rating visibility, and migrate character rosters between accounts. Admins can proxy all operations. Archetype tagging enables frontend diversity scoring.

## Reducers

### create_hsr_account

**Purpose:** Create a new HSR account linked to the caller's user

**Permission:** Any verified (non-guest) user

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| uid | string | Yes | 9-digit HSR UID (first digit = region) |
| displayLabel | string | Yes | User-chosen label (auto-defaults if empty) |

**Flow:**
1. ensureVerifiedUser — reject guests
2. validateUid — 9 digits, first digit must be 6/7/8/9
3. deriveRegion — map first digit to region string
4. Check 5-account limit per user
5. Auto-default label to "Account N" if empty/blank
6. First account auto-activates (isActive = true)
7. Insert HsrAccount
8. recalcDuplicateUid — update isDuplicateUid for all accounts sharing this UID

**Expected State Changes:**
- HsrAccount row inserted (userId, uid, region, displayLabel, isActive, isRosterPublic=false, isRatingPublic=false, isDuplicateUid=calculated)

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Guest caller | "Verified user required" (or similar) |
| UID not 9 digits | "UID must be exactly 9 digits" |
| UID first digit not 6/7/8/9 | "first digit must be 6, 7, 8, or 9" |
| Already 5 accounts | "Maximum 5" |

### update_hsr_account

**Purpose:** Update display label and visibility flags on an existing account

**Permission:** Account owner (verified user)

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| hsrAccountId | u32 | Yes | Target account ID |
| displayLabel | string | Yes | New label |
| isRosterPublic | bool | Yes | Roster visibility toggle |
| isRatingPublic | bool | Yes | Rating visibility toggle |

**Flow:**
1. ensureVerifiedUser — ownership check (account.userId === user.id)
2. Validate displayLabel not empty after trim
3. Update label and visibility flags

**Expected State Changes:**
- HsrAccount.displayLabel, isRosterPublic, isRatingPublic updated

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Not account owner | Permission error |
| Empty/blank displayLabel | "cannot be empty" |

### set_active_hsr_account

**Purpose:** Designate one account as the user's active account

**Permission:** Account owner (verified user)

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| hsrAccountId | u32 | Yes | Account to activate |

**Flow:**
1. ensureVerifiedUser — ownership check
2. No-op if account is already active
3. Phase 12.3 D-G-01 (WIDE guard): reject if target account OR any of caller's currently-active accounts is bound to a live LobbyMemberAccount row
4. Deactivate all other accounts for this user
5. Activate the target account

**Expected State Changes:**
- Target HsrAccount.isActive = true
- All other user HsrAccounts.isActive = false

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Not account owner | Permission error |
| Target or any active account bound to a live lobby (ROST-GUARD-01) | Error citing the conflicting lobby's joinCode |

### delete_hsr_account

**Purpose:** Delete an account and cascade-delete its character rows

**Permission:** Account owner (verified user)

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| hsrAccountId | u32 | Yes | Account to delete |

**Flow:**
1. ensureVerifiedUser — ownership check
2. Cascade: delete all HsrAccountCharacter rows for this account
3. Delete HsrAccount
4. If was active: auto-activate oldest remaining (sort by createdDate ascending)
5. recalcDuplicateUid for the deleted UID

**Expected State Changes:**
- HsrAccount row deleted
- All HsrAccountCharacter rows for this account deleted
- If active was deleted: oldest remaining account becomes active

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Not account owner | Permission error |

### batch_upsert_characters

**Purpose:** Add or update multiple characters on an account atomically

**Permission:** Account owner (verified user)

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| hsrAccountId | u32 | Yes | Target account |
| charactersJson | string | Yes | JSON array of {characterName, eidolonLevel} |

**Flow:**
1. ensureVerifiedUser — ownership check
2. Phase 12.3 D-G-01 (NARROW guard): reject if the target hsrAccountId is bound to a live LobbyMemberAccount row
3. Parse JSON array
4. Phase 1: Validate ALL — character exists in HsrCharacter table, eidolon 0-6 (via applyBatchUpsert helper)
5. Phase 2: Upsert ALL — composite PK find → delete + insert pattern, then updateAccountRating (via applyBatchUpsert helper)
6. Atomic: any validation failure rejects entire batch

**Expected State Changes:**
- HsrAccountCharacter rows inserted or updated (delete+insert for existing)
- HsrAccount.accountRating recalculated

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Empty batch | "non-empty" |
| Unknown character name | "Invalid character" |
| Eidolon level > 6 | "eidolon level" |
| Any invalid entry | Entire batch rejected (no partial writes) |
| Target account bound to a live lobby (ROST-GUARD-01) | Error citing the conflicting lobby's joinCode |

### batch_remove_characters

**Purpose:** Remove multiple characters from an account atomically

**Permission:** Account owner (verified user)

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| hsrAccountId | u32 | Yes | Target account |
| characterNamesJson | string | Yes | JSON array of character name strings |

**Flow:**
1. ensureVerifiedUser — ownership check
2. Phase 12.3 D-G-01 (NARROW guard): reject if the target hsrAccountId is bound to a live LobbyMemberAccount row
3. Parse JSON array of names
4. Phase 1: Validate ALL names exist on this account (via applyBatchRemove helper)
5. Phase 2: Delete ALL, then updateAccountRating (via applyBatchRemove helper)
6. Atomic: any name not found rejects entire batch

**Expected State Changes:**
- HsrAccountCharacter rows deleted
- HsrAccount.accountRating recalculated

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Character not on account | "not found" |
| Any missing entry | Entire batch rejected (no partial deletes) |
| Target account bound to a live lobby (ROST-GUARD-01) | Error citing the conflicting lobby's joinCode |

### migrate_roster

**Purpose:** Copy or move characters between two accounts owned by the same user

**Permission:** Owner of both accounts (verified user)

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| sourceAccountId | u32 | Yes | Source account |
| targetAccountId | u32 | Yes | Target account |
| mode | string | Yes | "copy" or "move" |

**Flow:**
1. ensureVerifiedUser — both accounts must belong to caller
2. Validate source !== target
3. Phase 12.3 D-G-01: reject if EITHER source OR target account is bound to a live LobbyMemberAccount row
4. Copy mode: call applyBatchUpsert on target (validates + upserts all source chars + recomputes target accountRating)
5. Move mode: same as copy, then call applyBatchRemove on source (deletes source chars + recomputes source accountRating)
6. Phase 12.3 D-D-04 (latent bug fix): previously never called updateAccountRating on either account, leaving stale ratings. Helper-based implementation closes this gap.

**Expected State Changes:**
- Copy: target gains source's characters (eidolon levels overwritten if conflicts); target accountRating recalculated
- Move: same as copy + source HsrAccountCharacter rows deleted; both source and target accountRating recalculated

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| source === target | "same account" |
| Invalid mode | Must contain "copy" (or similar) |
| Not owner of both | Permission error |
| Source or target account bound to a live lobby (ROST-GUARD-01) | Error citing the conflicting lobby's joinCode |

### rosterMutations.ts helpers (Phase 12.3 D-D-01/02/03)

New file `spacetimedb/src/helpers/rosterMutations.ts` extracts the "mutate characters + recompute accountRating" sequence that was previously duplicated across `batch_upsert_characters`, `batch_remove_characters`, and `migrate_roster`:

- `applyBatchUpsert(ctx, accountId, items, actingUserId)` — validates items (character exists, eidolon 0-6), upserts HsrAccountCharacter rows via composite-PK delete+insert with audit columns, calls `updateAccountRating`
- `applyBatchRemove(ctx, accountId, names, actingUserId)` — validates all names exist, deletes HsrAccountCharacter rows, calls `updateAccountRating`

The calling reducer owns auth and account-ownership checks; helpers own content validation and the mutate+recompute sequence. Admin variants (`admin_batch_upsert_characters`, `admin_batch_remove_characters`) also delegate to these helpers.

### Admin proxy reducers

All admin_* reducers mirror user reducers: admin_create_hsr_account, admin_update_hsr_account, admin_delete_hsr_account, admin_batch_upsert_characters, admin_batch_remove_characters.

**Differences from user reducers:**
- Use ensureAdmin(ctx) — require Admin role
- Accept targetUserId for create (proxy on behalf of another user)
- No ownership checks — admins can operate on any account
- Audit trail uses admin's user ID

### Archetype admin reducers

admin_upsert_archetype, admin_delete_archetype, admin_assign_character_archetypes, admin_remove_character_archetypes.

**Permission:** Admin only

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Non-admin caller | "Admin" |

## Acceptance Scenarios

### Account Creation (happy path)
**Given:** Verified user with 0 accounts
**When:** `create_hsr_account(uid="800000099", displayLabel="Asia Account")`
**Then:** Account inserted with region="Asia", isActive=true, isRatingPublic=false, isDuplicateUid=false

### Auto-Label on Empty Display Name
**Given:** Verified user
**When:** `create_hsr_account(uid=valid, displayLabel="")`
**Then:** Account created with displayLabel matching pattern "Account N"

### Account Limit Enforcement
**Given:** User with 5 accounts
**When:** `create_hsr_account(uid=valid, displayLabel="Sixth")`
**Then:** Throws "Maximum 5"

### UID Validation — Too Short
**Given:** Verified user
**When:** `create_hsr_account(uid="8001234", displayLabel="Bad")`
**Then:** Throws "UID must be exactly 9 digits"

### UID Validation — Bad Region
**Given:** Verified user
**When:** `create_hsr_account(uid="100000001", displayLabel="Bad")`
**Then:** Throws "first digit must be 6, 7, 8, or 9"

### Update Account Fields
**Given:** User owns an account
**When:** `update_hsr_account(id, displayLabel="Updated", isRosterPublic=true, isRatingPublic=true)`
**Then:** All three fields updated

### Update Rejects Blank Label
**Given:** User owns an account
**When:** `update_hsr_account(id, displayLabel="   ", ...)`
**Then:** Throws "cannot be empty"

### Set Active — D-G Guard (Phase 12.3)
**Given:** User with account A that is currently selected in an active lobby (LobbyMemberAccount row exists for A)
**When:** `set_active_hsr_account(A.id)` or `set_active_hsr_account(B.id)` where B is the caller's currently-active account
**Then:** Throws error identifying the conflicting lobby's joinCode. Switch blocked while account is in active use. (ROST-GUARD-01)

### Set Active — Switch
**Given:** User with accounts A (active) and B (inactive)
**When:** `set_active_hsr_account(B.id)`
**Then:** B.isActive=true, A.isActive=false

### Set Active — No-Op
**Given:** User with account A (active)
**When:** `set_active_hsr_account(A.id)`
**Then:** Succeeds without error, A remains active

### Delete with Cascade
**Given:** Account with characters (not used in any lobby or active tournament)
**When:** `delete_hsr_account(account.id)`
**Then:** Account deleted, all HsrAccountCharacter rows for that account deleted, no orphans

### Delete Blocked by Active Lobby Usage
**Given:** Account is selected in an active lobby (`LobbyMemberAccount` row exists)
**When:** `delete_hsr_account(account.id)`
**Then:** Throws error — cannot delete an account while it is in active use in a lobby. User must leave the lobby first. (D-24, Phase 10.4 execution)

### Delete Blocked by Active Tournament
**Given:** Account is locked in a tournament (TournamentPlayerAccount row exists) and the tournament is not Completed or Cancelled
**When:** `delete_hsr_account(account.id)`
**Then:** Throws error — cannot delete an account while it is locked in an active tournament. Withdraw from the tournament first. (D-24, Phase 10.4 execution)

### Admin Delete Blocked by Same Guards
**Given:** Account selected in lobby or locked in active tournament
**When:** `admin_delete_hsr_account(account.id)` called by admin
**Then:** Same deletion guard applies — throws same error. Admins must remove lobby/tournament references before deleting. (D-25, Phase 10.4 execution)

### Batch Upsert — D-G Guard (Phase 12.3)
**Given:** Account is currently selected in an active lobby (LobbyMemberAccount row exists for that hsrAccountId)
**When:** `batch_upsert_characters(hsrAccountId, [...])`
**Then:** Throws error identifying the conflicting lobby's joinCode. Mutation blocked while account is in active use. (ROST-GUARD-01)

### Batch Upsert — Insert
**Given:** Account with no characters
**When:** `batch_upsert_characters(id, [{acheron, e2}, {aglaea, e0}])`
**Then:** Two HsrAccountCharacter rows created with correct eidolon levels

### Batch Upsert — Update Eidolon
**Given:** Account with acheron at e2
**When:** `batch_upsert_characters(id, [{acheron, e6}])`
**Then:** acheron eidolon updated to 6

### Batch Upsert — Atomic Reject
**Given:** Account
**When:** `batch_upsert_characters(id, [{valid_char, e0}, {NonExistentCharacter, e0}])`
**Then:** Throws "Invalid character", valid_char is NOT inserted (all-or-nothing)

### Batch Upsert — Eidolon Out of Range
**Given:** Account
**When:** `batch_upsert_characters(id, [{acheron, e7}])`
**Then:** Throws "eidolon level"

### Batch Upsert — Empty Array
**Given:** Account
**When:** `batch_upsert_characters(id, [])`
**Then:** Throws "non-empty"

### Batch Remove — D-G Guard (Phase 12.3)
**Given:** Account is currently selected in an active lobby (LobbyMemberAccount row exists for that hsrAccountId)
**When:** `batch_remove_characters(hsrAccountId, [...])`
**Then:** Throws error identifying the conflicting lobby's joinCode. Removal blocked while account is in active use. (ROST-GUARD-01)

### Batch Remove — Happy Path
**Given:** Account with aglaea
**When:** `batch_remove_characters(id, ["aglaea"])`
**Then:** aglaea row deleted

### Batch Remove — Atomic Reject
**Given:** Account with acheron but NOT "GhostCharacter"
**When:** `batch_remove_characters(id, ["acheron", "GhostCharacter"])`
**Then:** Throws "not found", acheron is NOT deleted (all-or-nothing)

### Migrate — D-G Guard (Phase 12.3)
**Given:** Source or target account is currently selected in an active lobby (LobbyMemberAccount row exists)
**When:** `migrate_roster(sourceAccountId, targetAccountId, "copy")`
**Then:** Throws error identifying the conflicting lobby's joinCode. Migration blocked while either account is in active use. (ROST-GUARD-01)

### Migrate — Copy
**Given:** Source account with acheron (e3) and aglaea (e1), empty target account
**When:** `migrate_roster(source, target, "copy")`
**Then:** Target has acheron (e3) and aglaea (e1). Source unchanged.

### Migrate — Move
**Given:** Source with characters, target account
**When:** `migrate_roster(source, target, "move")`
**Then:** Target has source's characters. Source has 0 characters.

### Migrate — Same Account Rejected
**Given:** Account A
**When:** `migrate_roster(A, A, "copy")`
**Then:** Throws "same account"

### Migrate — Invalid Mode
**Given:** Two accounts
**When:** `migrate_roster(source, target, "invalid")`
**Then:** Throws error containing "copy"

### Duplicate UID Detection (recalcDuplicateUid)
**Given:** User A has HSR account with UID "800000099"
**When:** User B calls `create_hsr_account(uid="800000099", ...)`
**Then:** Both User A's and User B's accounts with that UID have isDuplicateUid=true
**When:** User B later calls `delete_hsr_account` on their "800000099" account
**Then:** recalcDuplicateUid recalculates — User A's account isDuplicateUid reverts to false (only one account remains with that UID)

### Admin Permission Guards
**Given:** Non-admin (guest) user
**When:** Any admin_* reducer called
**Then:** Throws "Admin"

## Edge Cases

| Case | Expected Behavior | Notes |
|------|-------------------|-------|
| UID with spaces ("800 12345") | Rejected — "9 digits" | Tested in unit tests |
| UID starting with 0 | Rejected — "first digit" | Region 0 invalid |
| Delete active account when others exist | Oldest remaining auto-activates | Sort by createdDate ascending |
| Duplicate UID across users | isDuplicateUid=true on all accounts sharing that UID | recalcDuplicateUid runs on create and delete |
| Batch upsert with duplicate names in same batch | Last entry wins (or deduped) | Implementation-dependent |
| HsrAccountLightcone rows on deletion | NOT cascaded yet | Lightcone reducers descoped from Phase 2 |
| User soft-deletion cascade (performUserDeletion) | Deletes UserIdentity rows, HsrAccountCharacter rows, HsrAccount rows, calendar data (AvailabilitySlot, SavedCalendar, CalendarEventInvite, CalendarEvent). Guest with no history refs: hard-delete User row. Otherwise: soft-delete (username='deleted_&lt;id&gt;', discordId cleared, displayName preserved). TournamentPlayerAccount and LobbyMember rows are NOT cascaded by deletion — they are cleaned up by their own domain reducers (withdrawal, lobby leave). | See architecture.md User Deletion Cascade |

## Integration Points

| This Feature | Connects To | How | Direction |
|-------------|------------|-----|-----------|
| HsrAccount.userId | User.id | FK (application-enforced) | Reads |
| HsrAccountCharacter.characterName | HsrCharacter.name | Validated on write | Reads |
| HsrCharacterArchetype.archetypeId | Archetype.id | FK (application-enforced) | Reads |
| HsrAccount.id | LobbyMemberAccount.hsrAccountId | Phase 10.4 deletion guard | Reads |
| HsrAccount.id | TournamentPlayerAccount.hsrAccountId | Phase 10.4 deletion guard | Reads |
| HsrCharacterCost.costSetId | CostSet.id | Phase 3 default=0 | Read by cost system |
| run_user_deletion | HsrAccount + HsrAccountCharacter | Cascade delete | Writes |
| view_my_roster | HsrAccount.user_id + HsrAccountCharacter.hsr_account_id | Private table view | Reads |
| view_public_hsr_accounts | HsrAccount.iter() + HsrAccountCharacter.hsr_account_id | Public roster view | Reads |

## Phase History

| Decision | Source | Date |
|----------|--------|------|
| 5-account limit per user | Phase 2 CONTEXT.md | 2026-03-16 |
| Atomic validate-then-write for all batch ops | Phase 2 review (STATE.md) | 2026-03-16 |
| id.update() for Archetype upsert | Phase 2 review (STATE.md) | 2026-03-16 |
| HsrAccountLightcone NOT cascaded in deletion | Phase 2 review (STATE.md) | 2026-03-16 |
| costSetId=0 sentinel for default cost set | Phase 2 review (STATE.md) | 2026-03-16 |
| Number() cast on BigInt sort comparator | Phase 2 review (STATE.md) | 2026-03-16 |
| UID validation: 9 digits, region 6/7/8/9 | Phase 1 schema | 2026-03-16 |
| recalcDuplicateUid bidirectional flag sync on create and delete | Phase 9 execution | 2026-03-29 |
| User soft-deletion cascade documented (performUserDeletion) | Phase 9 execution | 2026-03-29 |
| delete_hsr_account blocked by LobbyMemberAccount rows (active lobby) | Phase 10.4 execution | 2026-04-04 |
| delete_hsr_account blocked by TournamentPlayerAccount rows for non-terminal tournaments | Phase 10.4 execution | 2026-04-04 |
| admin_delete_hsr_account has identical deletion guards (D-25) | Phase 10.4 execution | 2026-04-04 |
| HsrAccount and HsrAccountCharacter made private — view_my_roster and view_public_accounts replace raw subscriptions (D-20) | Phase 10.4 execution | 2026-04-04 |
| Full hydration from codebase | Phase 13 normalization | 2026-04-09 |
| Phase 12.3 execution | D-G lobby guards (ROST-GUARD-01) on set_active_hsr_account (WIDE), batch_upsert_characters (NARROW), batch_remove_characters (NARROW), migrate_roster (source+target); rosterMutations.ts helper extraction (D-D-01/02/03) with applyBatchUpsert + applyBatchRemove; migrate_roster rating-recompute fix (D-D-04 latent bug) | 2026-04-12 |
| Integration Surface row identifier updated: `view_public_accounts` → `view_public_hsr_accounts` (matches Phase 15.5 D-04 view rename — `hsr_` names the underlying HsrAccount table). View body, projection, and `isRosterPublic` / `isRatingPublic` filtering are unchanged from Phase 10.4. Historical Phase 10.4 row at line 451 left verbatim per the no-historical-rewrite rule | Phase 15.5 execution | 2026-04-16 |
| Phase 15.5 verify-work: provenance entry added documenting that the `view_public_hsr_accounts` identifier propagated to the Integration Surface table during Plan 04 (commit `28d59f9`). No roster code or behavior change in Phase 15.5 — pure identifier follow-through | Phase 15.5 verify-work | 2026-04-17 |

---

*Last updated: 2026-04-17*
*Feature owner: Phase 2 / Phase 12.3*
