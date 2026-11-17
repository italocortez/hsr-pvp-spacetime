# Team Builder Loadouts

**Architecture:** [architecture.md](architecture.md)

## Feature Overview

A verified (Discord-linked) member keeps up to 10 named team builder loadouts on the account. Each loadout holds a name, a note and the packed team text of `shared/teambuilder` (the four slots with eidolon, light cone, superimposition and Auction extra bid, plus the game mode, draft mode, cost set and Auction budgets), so reopening a loadout shows exactly what was saved. Guests and visitors keep up to 5 loadouts in browser storage; that part has no backend. Members read their loadouts only through `view_my_loadouts` (DECISIONS.md A190 items 1, 3, 15).

## Reducers

### save_loadout

**Purpose:** Create or update the caller's loadout in one slot.

**Permission:** A verified (non-guest) user, the account not deleted; while maintenance mode is on, an Admin only.

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| slot | u8 | Yes | 0 to 9 (the page shows 1 to 10) |
| isNew | bool | Yes | true: the slot must be free; false: the slot must hold a loadout |
| name | string | Yes | trimmed; 1 to 40 characters |
| note | string | Yes | 0 to 1,000 characters |
| code | string | Yes | the packed team text, at most 400 characters, version 1 |

**Flow:**
1. Resolve the caller from `ctx.sender`; refuse a guest with the loadout text.
2. Count one write on the caller's membership allowance (shared with the roster and lobby writes: 20 calls per 10 s).
3. Check the slot range, the name, the note and the packed text (it must read as a version 1 team, be the one text that team encodes to, and name only characters and light cones of the reference tables).
4. `isNew` and the slot is taken: refuse. Not `isNew` and the slot is empty: refuse.
5. Insert the row, or update the row in that slot (name, note, code).

**Expected State Changes:**
- `UserLoadout`: one row inserted (userId = caller, slot, trimmed name, note, code) or the slot's row updated.
- `UserRateState`: the caller's membership window counts one more call.

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Identity with no user | "Unauthorized: No user linked to this identity." |
| Account deleted (pending deletion) | "Unauthorized: This account has been deleted." |
| Maintenance mode, caller not Admin | "The site is in maintenance. Please try again later." |
| Guest | "Saving loadouts to your account needs a Discord-linked account. Your loadouts stay in this browser." |
| More than 20 roster, lobby or loadout writes in 10 s | "You are doing that too quickly. Please wait a moment." |
| slot above 9 | "Loadout slot must be between 1 and 10." |
| name blank after trimming | "Loadout name cannot be empty." |
| name over 40 after trimming | "Loadout name cannot exceed 40 characters." |
| note over 1,000 | "Loadout note cannot exceed 1000 characters." |
| code over 400, unreadable, not canonical, a level out of range, bad settings | "This team could not be read. Reload the page and try again." |
| code holds the same character twice | "A team cannot hold the same character twice." |
| code names a character not in `HsrCharacter` | `Unknown character "<name>".` |
| code names a light cone not in `HsrLightcone` | `Unknown light cone "<name>".` |
| isNew and the slot is taken | "That loadout slot is already in use. Your list was refreshed; save again." |
| not isNew and the slot is empty | "That loadout no longer exists." |

### delete_loadout

**Purpose:** Remove the caller's loadout in one slot.

**Permission:** As `save_loadout`.

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| slot | u8 | Yes | 0 to 9 |

**Flow:**
1. Resolve the caller; refuse a guest with the loadout text.
2. Count one write on the membership allowance.
3. Check the slot range.
4. Delete the caller's row in that slot; an empty slot is a no-op.

**Expected State Changes:**
- `UserLoadout`: the caller's row in that slot deleted, if any.

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Guest | "Saving loadouts to your account needs a Discord-linked account. Your loadouts stay in this browser." |
| slot above 9 | "Loadout slot must be between 1 and 10." |
| Allowance used up, no user, deleted account, maintenance | as `save_loadout` |

### view_my_loadouts

**Purpose:** The caller's own loadouts: `slot`, `name`, `note`, `code` per row (no id, no user id, no timestamps). `slot` is the row's primary key, so a save reaches the client as an update.

**Permission:** Any subscriber; a guest and an identity with no user get no rows.

## Acceptance Scenarios

### Save a new loadout

**Given:** a verified member with no loadouts
**When:** `save_loadout(0, true, "  Firefly Hyper ", "", <code>)`
**Then:** one row, slot 0, name "Firefly Hyper", the note and code as given; `view_my_loadouts` returns it.

### Update in place

**Given:** slot 0 holds a loadout
**When:** `save_loadout(0, false, ...)` with a new name, note and code
**Then:** the same row carries the new values; still one row; its creation audit is kept.

### Ten slots

**Given:** a verified member
**When:** slots 0 to 9 are saved, then slot 10
**Then:** ten rows; slot 10 is refused "Loadout slot must be between 1 and 10."

### Slot taken

**Given:** slot 3 holds a loadout
**When:** `save_loadout(3, true, ...)`
**Then:** refused "That loadout slot is already in use. Your list was refreshed; save again."; the row is unchanged.

### Loadout gone

**Given:** slot 4 is empty
**When:** `save_loadout(4, false, ...)`
**Then:** refused "That loadout no longer exists."; nothing is written.

### Guest

**Given:** a guest
**When:** `save_loadout(...)` or `delete_loadout(...)`
**Then:** refused with the loadout text; no row. The roster reducers keep their own guest text.

### Unknown identity

**Given:** an identity that never logged in
**When:** `save_loadout(...)` or `delete_loadout(...)`
**Then:** refused "Unauthorized: No user linked to this identity."

### Name rules

**Given:** a verified member
**When:** names of 40 characters, 40 with surrounding spaces, 41, blank, and a name another loadout already has
**Then:** 40 passes (trimmed first); 41 is refused; blank is refused; duplicate names are allowed.

### Note cap

**Given:** a verified member
**When:** notes of 1,000 and 1,001 characters
**Then:** 1,000 passes; 1,001 is refused.

### Code checks

**Given:** a verified member
**When:** a code over 400 characters, unreadable text, an unknown version, eidolon 7, superimposition 0 or 6, an unknown game mode, three slots, the same character twice, an all-empty team
**Then:** each bad code is refused with its text and nothing is written; the all-empty team is saved.

### Unknown character or light cone

**Given:** the code names `nobody` as a character, or `nocone` as a light cone
**When:** `save_loadout`
**Then:** refused `Unknown character "nobody".` / `Unknown light cone "nocone".`; nothing is written.

### Canonical text

**Given:** a team saved with its canonical text
**When:** the same team spelled differently (a leading zero, a zero bid written out, upper case, a surrounding space)
**Then:** refused with the unreadable-team text; only the canonical text is ever stored.

### All or nothing

**Given:** slot 0 holds a loadout
**When:** an update whose fourth slot names an unknown character
**Then:** refused; the row keeps its old name, note and code.

### Delete

**Given:** slot 2 holds a loadout
**When:** `delete_loadout(2)`
**Then:** the row is gone; slot 2 can take a new loadout.

### Delete twice

**Given:** slot 2 is empty
**When:** `delete_loadout(2)`
**Then:** no error, no change.

### Other members

**Given:** A and B each have loadouts
**When:** B reads `view_my_loadouts`, B updates a slot only A uses, B deletes slot 0
**Then:** B sees only B's rows; the update is refused "That loadout no longer exists."; only B's slot 0 is deleted.

### Too fast

**Given:** a member has made 20 roster, lobby or loadout writes in the current 10 s window
**When:** a 21st `save_loadout` or `delete_loadout`
**Then:** refused "You are doing that too quickly. Please wait a moment."; nothing is written; accepted again once the window has passed.

### Maintenance

**Given:** maintenance mode is on
**When:** a non-Admin saves; an Admin saves
**Then:** the non-Admin is refused with the maintenance text; the Admin's save is written.

### Account deleted

**Given:** the member has loadouts
**When:** `delete_my_account`, `server_delete_user`, or a ban followed by the scheduled `run_user_deletion`
**Then:** no `UserLoadout` row of that user remains; other users keep theirs. Between the ban and the job, saves are refused "Unauthorized: This account has been deleted."

### Test wipe

**Given:** loadouts exist on the test database
**When:** `server_nuke_test_data`
**Then:** the table is empty.

### Reference removed later

**Given:** a loadout naming `kafka`
**When:** an Admin deletes `kafka` from `HsrCharacter`
**Then:** the loadout is unchanged and still readable; saving the same text again is refused `Unknown character "kafka".`

## Edge Cases

| Case | Expected Behavior | Notes |
|------|-------------------|-------|
| Two devices create in the same free slot at once | the second save is refused "That loadout slot is already in use..." | the page picks another slot |
| A loadout deleted on another device, then saved here | refused "That loadout no longer exists." | the page can save it again with isNew |
| A note of exactly 1,000 characters | accepted | |
| A cost set id that is no longer published | kept as stored | the page falls back to Default when it opens the loadout |
| A character or light cone deleted from the reference data later | kept in the stored text | the page shows it as unavailable; a new save of that text is refused |
| `EMPTY` or `SKIP` in a code | refused as unreadable | the packed text uses lower-case key names only; an empty slot is `_` |
| Lengths | counted as JavaScript string length | the page's counter and the module agree |

## Integration Points

| This Feature | Connects To | How | Direction |
|-------------|------------|-----|-----------|
| `save_loadout`, `delete_loadout` | `User`, `UserIdentity` (identity) | caller from `ctx.sender`; guest and deleted refusal | reads |
| `save_loadout` | `HsrCharacter`, `HsrLightcone` (roster reference) | name lookups of the packed text | reads |
| `save_loadout`, `delete_loadout` | `UserRateState` (lobby abuse controls) | the shared membership allowance | both |
| `save_loadout`, `delete_loadout` | `AbuseConfig.maintenanceMode` (admin) | Admin only while on | reads |
| `UserLoadout` | `performUserDeletion` (identity) | the user's rows are deleted with the account | writes |
| `UserLoadout` | `server_nuke_test_data` (identity) | the table is cleared | writes |
| `code` column | `shared/teambuilder` (`decodeTeam`, `encodeTeam`) | one codec for the module, the share link and browser storage | reads |

## Phase History

| Decision | Source | Date |
|----------|--------|------|
| Loadouts on the account for verified accounts only; guests and visitors use browser storage | DECISIONS.md A190 item 1, step S14.3s | 2026-11-16 |
| At most 10 loadouts on the account (5 in the browser, no backend) | DECISIONS.md A190 item 3, step S14.3s | 2026-11-16 |
| A loadout remembers its team, game mode, draft mode, cost set and Auction budgets (all in the packed text); the note is capped at 1,000 characters; the name at 40 | DECISIONS.md A190 item 15, step S14.3s | 2026-11-16 |
| Slots 0 to 9 with an upsert on (user, slot) and the `isNew` flag; the limit of 10 is the slot range | Phase S14.3s execution | 2026-11-17 |
| A blank name is refused ("Loadout name cannot be empty.") rather than stored as "Untitled"; the page supplies a default name | Phase S14.3s execution | 2026-11-17 |
| The packed text must be canonical (re-encoding the decoded team gives the same text); a level out of range is refused with the general unreadable-team text (the codec does not tell the levels apart), a character twice with its own text | Phase S14.3s execution | 2026-11-17 |
| The guest refusal has its own text; the roster reducers keep theirs | Phase S14.3s execution | 2026-11-17 |
| The loadout writes share the membership allowance of the roster and lobby writes (20 per 10 s) | Phase S14.3s execution | 2026-11-17 |
| `delete_loadout` refuses a slot above 9 and is a no-op on an empty slot | Phase S14.3s execution | 2026-11-17 |
| `view_my_loadouts` returns no rows to a guest (checked on the User row) and to an identity with no user | Phase S14.3s execution | 2026-11-17 |
| A character or light cone deleted later is not cascaded into loadouts | Phase S14.3s execution | 2026-11-17 |

---

*Last updated: 2026-11-17*
*Feature owner: Step S14.3s*
