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
| baseRev | u32 | Yes | the version of the caller's copy the save is based on: 0 creates (the slot must be free); above 0 updates (the slot must hold that loadout at exactly that version). *(Phase S14.3c-rev execution, A198: replaces `isNew: bool`, "true: the slot must be free; false: the slot must hold a loadout".)* |
| name | string | Yes | trimmed; 1 to 40 characters |
| note | string | Yes | 0 to 1,000 characters |
| code | string | Yes | the packed team text, at most 400 characters, version 1 |

**Flow:**
1. Resolve the caller from `ctx.sender`; refuse a guest with the loadout text.
2. (Superseded in S14.3s-limit, see Phase History: the save no longer counts on the membership allowance.)
3. Check the slot range, the name, the note and the packed text (it must read as a version 1 team, be the one text that team encodes to, and name only characters and light cones of the reference tables). *(Phase S14.3c-rev execution: the slot range stays first; the version check of step 4 now runs between the slot range and the name, note and text checks.)*
4. *(Superseded in S14.3c-rev, A198; was "`isNew` and the slot is taken: refuse. Not `isNew` and the slot is empty: refuse.")* Version check: `baseRev` 0 and the slot is taken: refuse. `baseRev` above 0 and the slot is empty, or holds a loadout created after that version (the one the caller saw was deleted): refuse as deleted. `baseRev` above 0 and the slot's loadout is at another version: refuse as changed.
4a. *(Phase S14.3c-rev execution.)* The name after trimming, the note and the text equal the stored row (the version matched): stop, write nothing, keep the version, count nothing.
4c. *(Phase S14.3c-rev execution.)* The version the save would write is past the u32 top: refuse.
4b. Count one save on the caller's loadout save limit (6 accepted saves per account per fixed 60 s window, its own count); refuse when the window is full. Still the last check before the write.
5. Insert the row, or update the row in that slot (name, note, code). *(Phase S14.3c-rev execution: an update sets the version to `baseRev + 1`; a new loadout gets one above the highest version the account was ever given, 1 for its first, and keeps that as its first version.)*

**Expected State Changes:**
- `UserLoadout`: one row inserted (userId = caller, slot, trimmed name, note, code) or the slot's row updated. *(Phase S14.3c-rev execution: with `rev` and, on insert, `firstRev`.)*
- `UserLoadoutRate`: the caller's save window counts one more save (or a new window opens with 1). *(Phase S14.3s execution, S14.3s-limit: replaces "`UserRateState`: the caller's membership window counts one more call.")* *(Phase S14.3c-rev execution: the same write raises `revFloor` to the version written when higher.)*
- An unchanged save writes nothing. *(Phase S14.3c-rev execution.)*

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Identity with no user | "Unauthorized: No user linked to this identity." |
| Account deleted (pending deletion) | "Unauthorized: This account has been deleted." |
| Maintenance mode, caller not Admin | "The site is in maintenance. Please try again later." |
| Guest | "Saving loadouts to your account needs a Discord-linked account. Your loadouts stay in this browser." |
| A seventh accepted save inside the caller's 60 s save window (S14.3s-limit) | "Your loadout was not saved yet: too many saves in a short time. It will be saved in a moment." |
| slot above 9 | "Loadout slot must be between 1 and 10." |
| name blank after trimming | "Loadout name cannot be empty." |
| name over 40 after trimming | "Loadout name cannot exceed 40 characters." |
| note over 1,000 | "Loadout note cannot exceed 1000 characters." |
| code over 400, unreadable, not canonical, a level out of range, bad settings | "This team could not be read. Reload the page and try again." |
| code holds the same character twice | "A team cannot hold the same character twice." |
| code names a character not in `HsrCharacter` | `Unknown character "<name>".` |
| code names a light cone not in `HsrLightcone` | `Unknown light cone "<name>".` |
| `baseRev` 0 and the slot is taken *(Phase S14.3c-rev execution: was "isNew and the slot is taken")* | "That loadout slot is already in use. Your list was refreshed; save again." |
| `baseRev` above 0 and the slot is empty, or holds a loadout created after that version *(Phase S14.3c-rev execution: was "not isNew and the slot is empty", text "That loadout no longer exists.")* | "That loadout was deleted on another device." |
| `baseRev` above 0 and the slot's loadout is at another version *(Phase S14.3c-rev execution)* | "That loadout was changed on another device." |
| the version would pass 4,294,967,295 *(Phase S14.3c-rev execution)* | "This loadout cannot be saved again. Save it as a new loadout." |

### delete_loadout

**Purpose:** Remove the caller's loadout in one slot.

**Permission:** As `save_loadout`.

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| slot | u8 | Yes | 0 to 9 |
| baseRev | u32 | Yes | *(Phase S14.3c-rev execution, A198.)* the version of the caller's copy the delete is based on |

**Flow:**
1. Resolve the caller; refuse a guest with the loadout text.
2. (Superseded in S14.3s-limit: a delete counts on no allowance.)
3. Check the slot range.
4. Delete the caller's row in that slot; an empty slot is a no-op. *(Phase S14.3c-rev execution: the row is deleted only at exactly `baseRev`; a slot that is empty or holds a loadout created after `baseRev` (0 included) is a no-op, since the loadout the caller meant is already gone; the same loadout at another version is refused as changed.)*

**Expected State Changes:**
- `UserLoadout`: the caller's row in that slot deleted, if any.
- Nothing else: a delete never touches `UserLoadoutRate`. *(Phase S14.3c-rev execution.)*

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Guest | "Saving loadouts to your account needs a Discord-linked account. Your loadouts stay in this browser." |
| slot above 9 | "Loadout slot must be between 1 and 10." |
| the slot's loadout is at a version other than `baseRev` *(Phase S14.3c-rev execution)* | "That loadout was changed on another device." |
| No user, deleted account, maintenance | as `save_loadout` (no rate limit since S14.3s-limit) |

### view_my_loadouts

**Purpose:** The caller's own loadouts: `slot`, `name`, `note`, `code` per row (no id, no user id, no timestamps). `slot` is the row's primary key, so a save reaches the client as an update. *(Phase S14.3c-rev execution, A198: each row also carries `rev`, the loadout's version, which a save or delete states as its base; `firstRev` stays private.)*

**Permission:** Any subscriber; a guest and an identity with no user get no rows.

## Acceptance Scenarios

### Save a new loadout

**Given:** a verified member with no loadouts
**When:** `save_loadout(0, true, "  Firefly Hyper ", "", <code>)`
**Then:** one row, slot 0, name "Firefly Hyper", the note and code as given; `view_my_loadouts` returns it.

*Call shape superseded in S14.3c-rev (A198): the call is now `save_loadout(0, 0, "  Firefly Hyper ", "", <code>)`, and the row and the view row carry version 1. See "Versions".*

### Update in place

**Given:** slot 0 holds a loadout
**When:** `save_loadout(0, false, ...)` with a new name, note and code
**Then:** the same row carries the new values; still one row; its creation audit is kept.

*Superseded in S14.3c-rev (A198): the update states the version it read, `save_loadout(0, <rev>, ...)`, and the row's version rises by 1. See "Versions".*

### Ten slots

**Given:** a verified member
**When:** slots 0 to 9 are saved, then slot 10
**Then:** ten rows; slot 10 is refused "Loadout slot must be between 1 and 10."

### Slot taken

**Given:** slot 3 holds a loadout
**When:** `save_loadout(3, true, ...)`
**Then:** refused "That loadout slot is already in use. Your list was refreshed; save again."; the row is unchanged.

*Call shape superseded in S14.3c-rev (A198): a create is `save_loadout(3, 0, ...)`; same refusal; the row also keeps its version.*

### Loadout gone

*Superseded in S14.3c-rev (A198) by "Deleted on another device" below: the text is now "That loadout was deleted on another device." The original scenario, kept for the record:*

> **Given:** slot 4 is empty
> **When:** `save_loadout(4, false, ...)`
> **Then:** refused "That loadout no longer exists."; nothing is written.

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

*Call shape superseded in S14.3c-rev (A198): `delete_loadout(2, <rev>)` with the version the caller saw. See "Delete with a version".*

### Delete twice

**Given:** slot 2 is empty
**When:** `delete_loadout(2)`
**Then:** no error, no change.

*Call shape superseded in S14.3c-rev (A198): `delete_loadout(2, <any version>)`; still no error, no change.*

### Other members

**Given:** A and B each have loadouts
**When:** B reads `view_my_loadouts`, B updates a slot only A uses, B deletes slot 0
**Then:** B sees only B's rows; the update is refused "That loadout no longer exists."; only B's slot 0 is deleted.

*Superseded text in S14.3c-rev (A198): B's update (based on a version above 0) is refused "That loadout was deleted on another device."; the rest holds.*

### Too fast

**Superseded in S14.3s-limit** (see Phase History) by "Too many saves", "Separate from the lobby and roster allowance" and "Delete has no rate limit" below: loadout writes no longer count on the 20-per-10-s membership allowance. The original scenario, kept for the record:

> **Given:** a member has made 20 roster, lobby or loadout writes in the current 10 s window
> **When:** a 21st `save_loadout` or `delete_loadout`
> **Then:** refused "You are doing that too quickly. Please wait a moment."; nothing is written; accepted again once the window has passed.

### Too many saves

*Phase S14.3s execution (S14.3s-limit; DECISIONS.md A194 item 6, closing A193 item 8; user ruling 2026-11-17).*

**Given:** a verified member whose save window is fresh
**When:** six accepted saves (new loadouts and updates alike) inside 60 s, then a seventh
**Then:** the six are written; the seventh is refused "Your loadout was not saved yet: too many saves in a short time. It will be saved in a moment." and writes nothing (neither the loadout nor the window). 60 s after the window opened, the next save is accepted and opens a new window. A save refused for another reason (slot taken, bad name) does not count. Another member's saves do not count on this member's window.

### Separate from the lobby and roster allowance

*Phase S14.3s execution (S14.3s-limit; DECISIONS.md A194 item 6).*

**Given:** a verified member
**When:** six saves, then twenty roster writes in the same 10 s; or twenty roster writes, then six saves
**Then:** all are accepted: saves do not count on the membership allowance (lobby, roster and calendar writes), and those writes do not count on the save limit. Each limit refuses with its own text.

### Delete has no rate limit

*Phase S14.3s execution (S14.3s-limit; DECISIONS.md A194 item 6).*

**Given:** a verified member whose save window is full
**When:** more than twenty `delete_loadout` calls at once, on full and empty slots
**Then:** all are accepted; the full slots are emptied; no window counts anything. A new save in a freed slot is still refused until the save window reopens, so a save, delete, save loop is held by its saves.

### Versions

*Phase S14.3c-rev execution (DECISIONS.md A198 item 1).*

**Given:** a verified member with no loadouts
**When:** `save_loadout(0, 0, ...)`, then updates `save_loadout(0, 1, ...)`, `save_loadout(0, 2, ...)`; later a new loadout in slot 3
**Then:** the first loadout is at version 1, then 2, then 3: each save that writes raises it by exactly 1, and `view_my_loadouts` sends it as `rev`. The new loadout in slot 3 starts one above the highest version the account was ever given (here 4), not at 1. Another account counts its own versions.

### Changed on another device

*Phase S14.3c-rev execution (A198 item 1).*

**Given:** slot 0 is at version 2
**When:** `save_loadout(0, 1, ...)` (a copy read at version 1), or a base the server never gave (above 2)
**Then:** refused "That loadout was changed on another device."; nothing is written, the save window is untouched. The page offers "Keep my changes" (resend based on the version the view now shows) or "Use the account copy".

### Deleted on another device

*Phase S14.3c-rev execution (A198 items 1, 3). Supersedes "Loadout gone".*

**Given:** slot 2's loadout was deleted (by this account on another device), or slot 8 never held one
**When:** `save_loadout(2, 2, ...)`, `save_loadout(8, 1, ...)`
**Then:** refused "That loadout was deleted on another device."; nothing is written. The page offers "Save as a new loadout" (a create, base 0, in a free slot) or "Discard my changes".

### Two devices

*Phase S14.3c-rev execution (A198 item 1).*

**Given:** one account on a laptop and a phone; both read slot 0 at version 2
**When:** the laptop saves based on 2, then the phone saves based on 2
**Then:** the laptop's save is written (version 3); the phone's is refused "That loadout was changed on another device."; the phone's resend based on 3 is written (version 4). One row.

### Slot reused

*Phase S14.3c-rev execution (A198 item 1).*

**Given:** a page holds slot 0 at version 3; another device deletes it and creates a different loadout in slot 0, then saves that a few times
**When:** the old page saves based on 3, or deletes based on 3
**Then:** the new loadout started above 3 (one above the highest version the account was ever given), so it never takes version 3; the save is refused "That loadout was deleted on another device."; the delete is a no-op and the new loadout stays.

### Unchanged save

*Phase S14.3c-rev execution.*

**Given:** slot 0 at version 1; the save window full
**When:** `save_loadout(0, 1, ...)` with the stored name (after trimming), note and code
**Then:** accepted; nothing is written, the version stays 1, the save window counts nothing. Any difference is a write (and here meets the full window). On a stale base the same content is a conflict.

### Version refusals do not count

*Phase S14.3c-rev execution.*

**Given:** the save window full
**When:** a conflict, a deleted, a slot-taken refusal, a version at its top, a delete refused as changed
**Then:** each is refused with its own text (never the too-fast text); no loadout row and no window row changes; once the window reopens all six saves are available.

### Check order

*Phase S14.3c-rev execution.*

**Given:** slot 0 at version 2
**When:** `save_loadout(0, 1, "   ", ...)`; then `save_loadout(0, 2, "   ", ...)`
**Then:** the first is refused as changed on another device (the version check comes before the content checks); the second "Loadout name cannot be empty.". A resend that carries the current version always reaches the content checks, so a conflict cannot repeat for ever.

### Delete with a version

*Phase S14.3c-rev execution (A198; first review of S14.3c, "delete in A while B has unsaved edits").*

**Given:** slot 3 at version 2 (the phone edited it after this page read version 1)
**When:** `delete_loadout(3, 1)`; `delete_loadout(3, 0)`; `delete_loadout(6, 4)` on an empty slot; `delete_loadout(3, 2)`; `delete_loadout(3, 2)` again
**Then:** the first is refused "That loadout was changed on another device." and the row stays; the second and third are no-ops; the fourth deletes; the fifth is a no-op. No delete touches the save window.

### Version at its top

*Phase S14.3c-rev execution.*

**Given:** a loadout at version 4,294,967,295, or an account whose highest version is that
**When:** an update of it, or a new loadout
**Then:** refused "This loadout cannot be saved again. Save it as a new loadout."; nothing is written. Never reached in practice (over 1,300 years of saves at the limit); the version never wraps.

### Maintenance

**Given:** maintenance mode is on
**When:** a non-Admin saves; an Admin saves
**Then:** the non-Admin is refused with the maintenance text; the Admin's save is written.

### Account deleted

**Given:** the member has loadouts
**When:** `delete_my_account`, `server_delete_user`, or a ban followed by the scheduled `run_user_deletion`
**Then:** no `UserLoadout` row of that user remains; other users keep theirs. Between the ban and the job, saves are refused "Unauthorized: This account has been deleted." Since S14.3s-limit (Phase S14.3s execution) the user's `UserLoadoutRate` row goes too.

### Test wipe

**Given:** loadouts exist on the test database
**When:** `server_nuke_test_data`
**Then:** the table is empty; since S14.3s-limit (Phase S14.3s execution) `UserLoadoutRate` is empty too.

### Reference removed later

**Given:** a loadout naming `kafka`
**When:** an Admin deletes `kafka` from `HsrCharacter`
**Then:** the loadout is unchanged and still readable; saving the same text again is refused `Unknown character "kafka".`

### Client: autosave after the wait

*Phase S14.3c execution (DECISIONS.md A194 items 3 to 5).*

**Given:** a verified member edits an account loadout on the team builder
**When:** no further edit for 60 s; or edits keep coming for 5 minutes; or the member switches loadout, leaves the page or hides the tab
**Then:** the page calls `save_loadout` once for that loadout (each edit restarts the 60 s; the 5 minute ceiling counts from the first unsaved edit; a switch, leave or hide sends at once). Every edit is written to a per-account draft in browser storage at once; the draft goes once the row from `view_my_loadouts` matches it. *(S14.3c-sync: each call sends the version the draft was made from, `baseRev`.)*

### Client: never more than the server's limit

*Phase S14.3c execution (A194 item 6).*

**Given:** seven account loadouts become due inside 60 s on one page
**When:** the page sends them
**Then:** it sends six and holds the seventh until the oldest send is 60 s old. A refusal "Your loadout was not saved yet: too many saves in a short time…" (two tabs, say) keeps the draft and retries after 10, 20, 40, then 60 s.

### Client: slot taken, deleted, changed

*Phase S14.3c execution, revised in S14.3c-sync (DECISIONS.md A198).*

**Given:** an account draft waits to be saved: a new loadout in slot 3 (`baseRev` 0), or edits of a loadout read at version 4
**When:** the save is refused "That loadout slot is already in use. Your list was refreshed; save again."; or "That loadout was deleted on another device."; or "That loadout was changed on another device."
**Then:** slot taken: the page moves the draft to the lowest slot free in the refreshed list and creates it again (base 0); with no free slot it keeps it unsent with "Your account already holds 10 loadouts. Delete one to save this one." Deleted: nothing is sent; the person is told "This loadout was deleted on another device." and chooses "Save as a new loadout" (base 0, a free slot) or "Discard my changes". Changed: nothing more is sent; the person chooses "Keep my changes" or "Use the account copy" (below). When the row now in the slot holds the draft (this page's own earlier save, or the same edit made elsewhere), there is nothing to choose: the draft is settled. Nothing the member wrote is lost or written over.

### Client: a draft left from last time

*Phase S14.3c execution, revised in S14.3c-sync (A198).*

**Given:** this browser holds a draft of an account loadout made on version 4 (the tab closed or the connection dropped before the save)
**When:** the member opens the team builder and the account list arrives
**Then:** the row at version 4: the draft is applied and saved at once with `baseRev` 4 (within the limit), no prompt. The row holds the draft: dropped. The row at another version: held for the choice, nothing sent. No row: the deleted choice. A save of this draft whose answer was lost and that did land (its row at version 5 holding what was sent, remembered in the draft) is this page's own: the draft is rebased on version 5 and the rest of its edits are sent, no choice.

### Client: the page never sends a blank name

*Phase S14.3c execution (A193 item 3).*

**Given:** the member clears the loadout's name
**When:** the field loses focus, or a save is due while it is blank
**Then:** the field shows "Untitled" and `save_loadout` receives "Untitled"; a name is always trimmed and at most 40 units before it is sent.

### Client: browser loadouts and the copy to the account

*Phase S14.3c execution (A190 items 1, 3); call shape revised in S14.3c-sync.*

**Given:** a guest or visitor; then the same browser after a Discord sign-in
**When:** they build teams; then pick "Copy to my account" on a browser loadout
**Then:** up to 5 loadouts are kept in browser storage with no reducer call and no `view_my_loadouts` subscription; after sign-in both lists show, and the copy is one `save_loadout` with `baseRev` 0 in the lowest free slot, sent at once; the browser copy stays. With 10 on the account the copy is refused on the page and nothing is sent.

### Client: subscription life

*Phase S14.3c execution.*

**Given:** the team builder page
**When:** the visitor is a verified member; then signs out, or leaves the page
**Then:** `SELECT * FROM view_my_loadouts` is subscribed on this route only while verified, and dropped on sign-out and on leave.

### Client: two devices create a loadout at the same time

*Phase S14.3c execution (fix pass, review B1), revised in S14.3c-sync.*

**Given:** one account with no loadout in slot 0, open on two or three devices (or tabs)
**When:** each makes a new loadout, which takes the lowest free slot on each; in any order: the others' rows arrive before this page sends, or the saves reach the server within one round trip
**Then:** a new loadout is always sent with `baseRev` 0, which the server only writes into an empty slot. A row from elsewhere in the slot of an unsent new loadout moves it at once to the lowest free slot (it keeps its wait); "That loadout slot is already in use" moves it the same way and it is created again at once. Every loadout exists on the server and in every list. With no free slot the new loadout waits unsent in this browser and is created when a slot frees. Tabs of one browser pick different slots (each counts every stored draft). Two new loadouts with exactly the same name, note and team are one loadout.

### Client: a stale draft

*Phase S14.3c execution (fix pass, review B2, S8), revised in S14.3c-sync (A198). Supersedes the conflict part of "Client: a draft left from last time" of the first version.*

**Given:** this browser holds unsaved edits of an account loadout made on version 4, and the account copy is now at version 6 (changed elsewhere)
**When:** the row arrives on load, live, or after a reconnect; or a save on version 4 is refused "That loadout was changed on another device." (the view not yet showing version 6)
**Then:** nothing more is sent. For the active loadout the page shows both copies and, line by line, what differs (name, note, team members, order, light cones, levels, modes, Auction figures), with "Keep my changes" and "Use the account copy". Keep: the draft is sent on its own version 4; refused "changed", it is sent again at once on the version the view shows (6) and written as 7; refused "deleted" (the slot now holds a different loadout), the deleted choice instead, and nothing is written over. Use the account copy: the edits go, nothing is sent. A loadout that is not active is marked in the menu and named on the card, and offers the same choice when opened. Edits made meanwhile stay held.

### Client: reconnect and the list not yet loaded

*Phase S14.3c-sync execution (second review N1, N2).*

**Given:** a draft waits while the connection is down, another device saves that loadout meanwhile; or the member edits the page before the account list (or the answer who they are) has arrived
**When:** the connection is back, its subscriptions replayed after it; or the list arrives
**Then:** no save is sent between "connected" and the replay's result (the old rows are still cached then); after it the draft meets the new version and is held for the choice. An edit made before the list arrived is written into the account loadout shown last on the version stored with it (the copy the page showed), so a newer copy elsewhere is a conflict, not an overwrite; until the list is here no account save is sent and no account loadout is created. Correctness does not depend on this wait: a save on an older version is refused by the server.

### Client: two tabs of one browser

*Phase S14.3c-sync execution (second review N3).*

**Given:** two tabs on one account; tab 1 edits a loadout, its draft waits
**When:** tab 2 opens, or shows the same loadout; tab 1 edits on, saves, or is closed
**Then:** only the tab that wrote a draft sends it; tab 2 shows it ("Being changed in another tab of this browser. That tab saves it.") and follows its edits. Tab 1 closed (or leaving the page) releases its drafts and tab 2 sends them at once; a tab that vanished without releasing them is taken over after 90 s. A tab never removes or rewrites another tab's stored draft; when its own save lands under the other's newer edits, the other's draft stays.

### Client: a dropped connection during a save

*Phase S14.3c execution (fix pass, review S1), revised in S14.3c-sync (second review N4, N7).*

**Given:** a `save_loadout` call is in flight
**When:** the connection drops before the answer (`UnknownCallResultError`); or the server's runtime fails (`InternalError`)
**Then:** answer lost: the draft stays with what was sent, the page says "Not saved yet" with the no-connection reason (not the SDK's text) and sends it again once the connection is back and the rows are fresh. If it did arrive, its row (version plus one, holding what was sent) settles it with no second call and no conflict, also after a reload; a retry refused "changed" while the row holds the draft is settled the same way. Runtime failure: "The server could not save this. Trying again in a moment.", retried after 10, 20, 40, 60 s, stopped after five tries in a row until the next edit or a reconnect.

### Client: an edit taken back

*Phase S14.3c execution (fix pass, review S6).*

**Given:** an account loadout with a pending save
**When:** an edit makes it equal to the account copy again (add a character, remove it)
**Then:** the pending save is cancelled; no call is made.

### Client: delete on a version

*Phase S14.3c-sync execution (A198).*

**Given:** the page shows a loadout at version 2, and another device has saved it as version 3
**When:** the member deletes it here
**Then:** `delete_loadout(slot, 2)` is refused "That loadout was changed on another device."; this browser's edits of it go, the newer copy is shown and the dialog asks again ("This loadout was changed on another device. The newer copy is on the page now."); a second Delete sends version 3 and removes it. A new loadout never sent is removed without a call; one already gone, or a slot now holding a different loadout, is removed here while the server changes nothing.

### Client: a loadout comes into being with its first character

*Phase S14.3e execution (DECISIONS.md A205).*

**Given:** the team builder shows an unsaved working loadout with an empty team (a visitor, a guest or a verified member)
**When:** the person changes the game mode, the draft mode, the cost set, an Auction budget, the name or the note; then picks a character
**Then:** before the pick nothing is stored: no browser list entry, no account draft, no `save_loadout` call, no slot taken, nothing counted on the 6 per minute limit; the state line reads "Pick a character to start a loadout." and the menu does not list it. The modes stay in the address, the budgets in the team draft, the name and note in the page's active key, so a reload keeps them. The pick creates the loadout with that name, note, modes and budgets: in the browser at once, on the account as one `save_loadout` with `baseRev` 0 after the autosave wait.

### Client: a loadout emptied of its characters

*Phase S14.3e execution (A205 item 3).*

**Given:** a stored loadout (browser or account)
**When:** every character is removed from it
**Then:** it stays stored and keeps saving as an empty team (one `save_loadout` on its version for an account loadout); it goes only when it is deleted.

### Client: New Loadout

*Phase S14.3e execution (A205; the implementer's choice).*

**Given:** any loadout on the page
**When:** the person presses "+ New Loadout", once or several times
**Then:** the loadout being left is saved at once (as a switch); the page shows an empty unsaved working loadout named "New Loadout", stored by its first character. Nothing is stored and no call is made by the presses themselves, so empty loadouts never pile up. A full store or a store not yet known refuses as before.

## Edge Cases

| Case | Expected Behavior | Notes |
|------|-------------------|-------|
| Two devices create in the same free slot at once | the second save is refused "That loadout slot is already in use..." | the page picks another slot |
| A loadout deleted on another device, then saved here | refused "That loadout no longer exists." | the page can save it again with isNew. *Superseded in S14.3c-rev (A198): refused "That loadout was deleted on another device."; the person chooses "Save as a new loadout" (base 0) or "Discard my changes".* |
| A save or delete based on an older version *(Phase S14.3c-rev execution)* | refused "That loadout was changed on another device." | the page offers "Keep my changes" (resend on the current version) or "Use the account copy"; for a delete, it shows the newer copy and asks again |
| A slot emptied and filled again elsewhere *(Phase S14.3c-rev execution)* | an old base never matches the new loadout | versions never repeat for an account; the save is told "deleted", the delete is a no-op |
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
| `save_loadout` | `UserLoadoutRate` (this feature, S14.3s-limit) | the save limit, 6 per account per 60 s; replaces the shared membership allowance on `UserRateState`, which loadouts no longer touch | both |
| `save_loadout` | `UserLoadoutRate.revFloor` (this feature, S14.3c-rev) | the highest version the account was ever given; a new loadout starts one above it; raised in the save's one window write | both |
| `save_loadout`, `delete_loadout` | `AbuseConfig.maintenanceMode` (admin) | Admin only while on | reads |
| `UserLoadout` | `performUserDeletion` (identity) | the user's rows are deleted with the account | writes |
| `UserLoadout` | `server_nuke_test_data` (identity) | the table is cleared | writes |
| `UserLoadoutRate` | `performUserDeletion`, `server_nuke_test_data` (identity) | the user's row deleted; the table cleared | writes |
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
| Supersedes "The loadout writes share the membership allowance (20 per 10 s)" and the scenario "Too fast": saves get a limit of their own, 6 accepted saves per account per fixed 60 s window (`UserLoadoutRate`), refusal "Your loadout was not saved yet: too many saves in a short time. It will be saved in a moment."; loadout writes no longer count on the membership allowance, and lobby, roster and calendar writes do not count on the save limit | DECISIONS.md A194 item 6 (closes A193 item 8; user ruling 2026-11-17: "6 saves per minute per account"); Phase S14.3s execution (S14.3s-limit) | 2026-11-17 |
| `delete_loadout` counts on no limit (a delete only removes a row a counted save made; an empty-slot delete writes nothing; a refused call costs the same as a no-op) | Phase S14.3s execution (S14.3s-limit) | 2026-11-17 |
| The save limit is the last check before the write, so its refusal reaches only a save that would otherwise succeed; a save refused for another reason does not count | Phase S14.3s execution (S14.3s-limit) | 2026-11-17 |
| The user's `UserLoadoutRate` row goes with the account; the test wipe clears the table | Phase S14.3s execution (S14.3s-limit) | 2026-11-17 |
| Edited in place by S14.3s-limit, after the first version of this contract (the original text is in git at `2d07e39`): `save_loadout` flow step 2 (was "Count one write on the caller's membership allowance (shared with the roster and lobby writes: 20 calls per 10 s)", now a superseded note) and step 4b added; `save_loadout` Expected State Changes (the `UserRateState` line replaced by the `UserLoadoutRate` line, tagged); `save_loadout` error table (the row "More than 20 roster, lobby or loadout writes in 10 s / You are doing that too quickly. Please wait a moment." replaced by the seventh-save row); `delete_loadout` flow step 2 (was "Count one write on the membership allowance", now a superseded note); `delete_loadout` error table (was "Allowance used up, no user, deleted account, maintenance / as `save_loadout`"); scenario "Too fast" (marked superseded, original text kept under it); scenarios "Account deleted" and "Test wipe" (one tagged sentence appended to each Then); Integration Points (the `UserRateState` row "the shared membership allowance" replaced by the `UserLoadoutRate` row, one row added) | Phase S14.3s execution (S14.3s-limit; review should-fix S2) | 2026-11-17 |
| Client behaviour on the team builder: autosave 60 s after the last edit with a 5 minute ceiling and a flush on switch, leave and tab hide; a per-account draft in browser storage on every edit, dropped when the view's row matches; never more than 6 sends in 60 s, a refusal retried with backoff; slot taken and loadout gone saved again as new; drafts applied on load; a blank name sent as "Untitled"; browser loadouts (5) with "Copy to my account"; `view_my_loadouts` subscribed only while verified, on this route | Phase S14.3c execution (DECISIONS.md A190 items 1, 3; A194 items 3 to 6) | 2026-11-17 |
| Client fix pass: `isNew` from the draft's own history (no confirmed copy: new), a new loadout moves out of a slot another device took (also before sending), never replaces it; a draft that conflicts with a newer account copy is held until the person chooses (supersedes "the page says so and offers 'Use the account copy'" in "Client: a draft left from last time", where the draft was sent at once); the draft's base follows each successful save; a lost answer is retried, not refused; an edit taken back sends nothing. Scenarios added: two devices create at once, a stale draft, a dropped connection during a save, an edit taken back | Phase S14.3c execution (fix pass after review: B1, B2, S1, S6, S8) | 2026-11-17 |
| Each loadout carries a version (`rev`, u32) that every save that writes raises by exactly 1; `view_my_loadouts` sends it; `save_loadout(slot, baseRev, name, note, code)` replaces `isNew`: base 0 creates, a base above 0 updates exactly that version; refusals "That loadout was changed on another device." and "That loadout was deleted on another device." (replaces "That loadout no longer exists."); slot taken unchanged | DECISIONS.md A198 items 1, 3; Phase S14.3c-rev execution | 2026-11-17 |
| A new loadout starts one above the highest version the account was ever given (`UserLoadoutRate.revFloor`, 1 for the first loadout), and keeps that as `firstRev` (private); a base below a loadout's `firstRev` belongs to a deleted loadout, so a reused slot is never mistaken for the old loadout | Phase S14.3c-rev execution (A198) | 2026-11-17 |
| `delete_loadout(slot, baseRev)`: deletes only at exactly that version; the same loadout at another version is refused as changed; an empty slot or a newer loadout in the slot is a no-op | Phase S14.3c-rev execution (A198; first review of S14.3c) | 2026-11-17 |
| Check order: caller, slot, version, content, unchanged, version top, save limit, write. An unchanged save writes nothing, keeps the version and does not count on the limit. At the u32 top a save is refused, never wrapped | Phase S14.3c-rev execution | 2026-11-17 |
| Edited in place by S14.3c-rev (the text before it is in git at `97ffe17` plus the uncommitted S14.3c additions): `save_loadout` Parameters (the `isNew` row replaced by `baseRev`, old text quoted in the row); `save_loadout` Flow steps 3 and 5 (a tagged sentence appended), step 4 (marked superseded, old text quoted, new text after it), steps 4a and 4c added; `save_loadout` Expected State Changes (a tagged sentence appended to both lines, one line added); `save_loadout` Error Cases (the two `isNew` rows rewritten with the old condition and text quoted, two rows added); `delete_loadout` Parameters (`baseRev` row added), Flow step 4 (a tagged sentence appended), Expected State Changes (one line added), Error Cases (one row added); `view_my_loadouts` Purpose (a tagged sentence appended); scenarios "Save a new loadout", "Update in place", "Slot taken", "Delete", "Delete twice", "Other members" (a superseded note appended to each); scenario "Loadout gone" (marked superseded, original kept as a quote); Edge Cases (one row given a superseded note, two rows added); Integration Points (one row added). The client scenarios of S14.3c ("Client: …") were not touched; several of them name `isNew` and "That loadout no longer exists." and are for the frontend step to revise | Phase S14.3c-rev execution | 2026-11-17 |
| Client sync on versions (S14.3c-sync): every draft records the version it was made from and every save and delete sends it; conflicts come from the server or from a row at another version, never from content guessing; Keep sends on the draft's own version first, so a reused slot is told as deleted; deleted elsewhere offers "Save as a new loadout" or "Discard my changes"; no send before the rows are fresh for the connection; one owner tab per draft with take-over on release or after 90 s; sends recorded in the draft to recognise its own save after a lost answer or a reload; `InternalError` retried at most 5 times in a row. Scenarios revised in place (this step's own entries, first versions in the S14.3c log and the step's history): "Client: slot taken, loadout gone" (renamed "slot taken, deleted, changed"), "a draft left from last time", "browser loadouts and the copy to the account" (`isNew` true became `baseRev` 0), "two devices create a loadout at the same time", "a stale draft", "a dropped connection during a save"; "autosave after the wait" given one appended sentence. Added: "reconnect and the list not yet loaded", "two tabs of one browser", "delete on a version" | DECISIONS.md A198 items 2 to 4; Phase S14.3c-sync execution | 2026-11-17 |
| Client: a working loadout is stored only once its team holds a character; mode, cost set, budget, name and note changes on an empty team store and send nothing; a stored loadout emptied of characters stays and saves as empty; "New Loadout" shows an unsaved working loadout instead of storing an empty one. Scenarios added: "a loadout comes into being with its first character", "a loadout emptied of its characters", "New Loadout". No earlier client scenario of this contract said that a mode, name or note change alone stores a loadout (that rule was written in `docs/frontend/pages.md`, where it is now marked superseded, and in the S14.3c log) | DECISIONS.md A205; Phase S14.3e execution | 2026-11-17 |

---

*Last updated: 2026-11-17*
*Feature owner: Step S14.3s*
