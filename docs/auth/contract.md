# Auth

**Architecture:** [architecture.md](architecture.md)

## Feature Overview

Authentication manages how users connect to the SpacetimeDB module, create accounts (guest or Discord-linked), and maintain online presence. The auth system is minimal by design — a single `login_as_guest` reducer handles account creation and reconnection. Discord linking and role management are server-side operations. _Superseded in Phase M5a3 execution (DECISIONS.md A177): Discord sign-in is the link-code flow. A guest asks for a code (`request_link_code`), the auth function presents it with the Discord account (`linker_present_code`, Linker identity only), and the same browser confirms with a one-time token (`confirm_link`). No reducer links an identity named by its hex. See "Discord Sign-In by Link Code" below and [architecture.md](architecture.md) "Phase M5a execution" to "Phase M5b execution"._

## Reducers

### login_as_guest

**Purpose:** Create a guest user or reconnect an existing one

**Permission:** Any (no auth required — this IS the auth entry point)

**Parameters:** None (uses `ctx.sender` identity)

**Flow:**
1. Look up `ctx.sender` in UserIdentity table
2. If found → find linked User → update `lastLoginAt`, `isOnline=true`, `lastSeenAt` → return
3. If not found → generate guest username from identity hex (`Guest_{first8chars}`) _Superseded in Phase S10h execution (S10h review, guest name collision)._
4. Insert new User row (isGuest=true, isOnline=true, role=User, avatarCharacterName='march7th', hasDiscordLinked=false)
5. Insert UserIdentity row linking `ctx.sender` → new User

**Expected State Changes:**
- Existing user: `User.lastLoginAt` = ctx.timestamp, `User.isOnline` = true, `UserIdentity.lastSeenAt` = ctx.timestamp
- New user: `User` row inserted (hasDiscordLinked=false), `UserIdentity` row inserted

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| None — reducer always succeeds | — _Superseded in Phase M5a3 execution (DECISIONS.md A177(1)): a Linker identity is refused ("Forbidden: a linker identity cannot sign in as a user."). The guest-creation and maintenance refusals are in Phase History (A95, A163(3))._ |

### server_link_provider

_Superseded in Phase M5a3 execution (DECISIONS.md A177(2)): `server_link_provider` no longer exists. Its merge cases 1a and 1b run only inside `confirm_link`, for the caller's own identity; case 1c is no longer reached (a linked user cannot request a code). The section is kept as history._

**Purpose:** Link a provider (Discord) to a User; upgrade guest to verified; create UserPrivate record

**Permission:** Server identity only (requireServer)

**Parameters:** `callerIdentityHex`, `provider` ('discord'), `providerId`, `providerName`

**Flow:**
1. Resolve UserIdentity from callerIdentityHex
2. `rejectIfBanned(ctx, 'DiscordId', providerId)` — D-08 enforcement point 1
3. Case 1a: Guest user → update User (isGuest=false, hasDiscordLinked=true, username=providerName) _Superseded in Phase S10e execution (backend audit 2026-11-09, identity finding 3)._
4. Case 1b: Verified user with different identity → redirect existing user to this identity
5. Case 1c: Upgrade existing mapping
6. Upsert UserPrivate with discordId + discordUsername

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Provider is banned | "Discord ID \<id\> is banned" _Superseded in Phase S10 execution (DECISIONS.md A76)._ |
| Identity not registered | "Identity not registered. Call login_as_guest first" _Superseded in Phase M5a3 execution (DECISIONS.md A177(2)): the reducer is removed. The text (with a final period) is now reached only at presentation, when the requesting identity's mapping was removed after the request._ |

### clientConnected (lifecycle hook)

**Purpose:** Mark user as online when their WebSocket connects; enforce bans on reconnect

**Permission:** System (lifecycle hook, not user-callable)

**Flow:**
1. Look up `ctx.sender` in UserIdentity table
2. If found → set `User.isOnline = true`
3. Check UserPrivate for discordId → if banned → soft-delete user (D-08 point 2)
4. If not found → no-op (user hasn't called login_as_guest yet)

### clientDisconnected (lifecycle hook)

**Purpose:** Mark user as offline, handle disconnect policies for active lobbies

**Permission:** System (lifecycle hook, not user-callable)

**Flow:**
1. Look up `ctx.sender` in UserIdentity table
2. If found → set `User.isOnline = false`
3. Check for active lobby membership → trigger disconnect handling (see [docs/lobby/contract.md](../lobby/contract.md))

### admin_ban_user

**Purpose:** Ban a provider ID; soft-delete affected users; prevent future linking

**Permission:** Admin only

**Parameters:** `banTypeTag` ('DiscordId'), `providerId`, `reason`

**Flow:**
1. Verify caller is Admin
2. Check for duplicate ban (single-col index + in-memory banType filter)
3. Insert BanRecord
4. Find User with matching discordId in UserPrivate
5. Soft-delete affected user (deletedAt = ctx.timestamp) — D-08 enforcement point 3

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Caller is not Admin | Unauthorized _Superseded in Phase S10 execution (DECISIONS.md A76)._ |
| Duplicate ban exists | "A ban for this provider ID already exists" _Superseded in Phase S10 execution (DECISIONS.md A76)._ |

### admin_unban_user

**Purpose:** Remove a ban by BanRecord ID (permanent ban model — D-07)

**Permission:** Admin only

**Parameters:** `banRecordId` (u32)

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| BanRecord not found | "BanRecord \<id\> not found" _Superseded in Phase S10 execution (DECISIONS.md A76)._ |
| Caller is not Admin | Unauthorized _Superseded in Phase S10 execution (DECISIONS.md A76)._ |

### request_link_code (Phase M5a execution, A46, A175)

**Purpose:** A guest asks for a one-time sign-in code.

**Permission:** The caller's own live guest with no provider linked (`ctx.sender`). A non-Admin is refused during maintenance.

**Parameters:** `clientNonce`: 43 base64url characters (32 random bytes from the browser).

**Flow:** [architecture.md](architecture.md) "request_link_code".

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Nonce not 43 base64url characters | "clientNonce must be 43 base64url characters (32 random bytes)." |
| Maintenance on, caller not an Admin | "The site is in maintenance. Please try again later." |
| No live user for the identity | "No account for this identity. Call login_as_guest first." |
| User deleted, or banned with the deletion pending | "Unauthorized: This account has been deleted." |
| User not a guest, or a provider already linked | "This account is already linked." |
| Four code clashes in a row | "Could not create a link code. Please try again." |

### linker_present_code (Phase M5a execution as `server_link_by_code`; presentation only since Phase M5a2 execution; renamed, Linker only, since Phase M5a3 execution; A175, A176, A177)

**Purpose:** The auth function presents a code with the Discord account Discord confirmed and the hash of a one-time confirm token. It stores a pending link and changes no account.

**Permission:** The registered Linker identity only. The Owner and Delegates are refused.

**Parameters:** `linkCode`, `provider` ('discord'), `providerId`, `providerName` (the Discord handle), `confirmHash` (base64url SHA-256 of the token's 32 bytes).

**Flow:** [architecture.md](architecture.md) "linker_present_code".

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Caller is not the registered Linker | "Forbidden: caller is not the registered linker identity." |
| Provider `discord` and an id that is not 17 to 20 digits | "providerId is not a Discord id." |
| `confirmHash` not the canonical base64url of 32 bytes | "confirmHash must be 43 base64url characters (a SHA-256 digest)." |
| Code unknown, already presented, or expired | "This link code is invalid or has expired." |
| The requesting identity maps to another user, or its user is gone, not a guest, linked or soft-deleted | "This account changed since the sign-in started. Please start again." |
| The Discord id is banned | "This discord account is banned and cannot be linked." |
| The guest would be deleted (case 1b) while seated as a player in a live game | "Finish your current game before signing in to an existing account." |
| Name empty after the clean-up | "providerName is required" |
| Provider other than `discord` | "Invalid provider \"\<provider\>\". Must be one of: discord" |
| Provider other than `discord` with an empty id | "providerId is required" |
| The requesting identity's mapping was removed after the request | "Identity not registered. Call login_as_guest first." |

### confirm_link (Phase M5a2 execution, A176(1))

**Purpose:** The requesting browser confirms the pending Discord account with its one-time token. The link happens here and only here.

**Permission:** The identity that requested the code; it acts on its own row only.

**Parameters:** `confirmToken`: 43 base64url characters (32 bytes), canonical.

**Flow:** [architecture.md](architecture.md) "confirm_link".

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Token malformed or not canonical | "confirmToken must be 43 base64url characters (32 bytes)." |
| Maintenance on, caller not an Admin | "The site is in maintenance. Please try again later." |
| No live user for the identity | "No account for this identity. Call login_as_guest first." |
| User deleted, or banned with the deletion pending | "Unauthorized: This account has been deleted." |
| No row for the caller, not presented, or the 2-minute window has passed | "No sign-in is waiting for confirmation. Please start again." |
| The token's hash does not match | "This sign-in could not be confirmed." |
| The account changed since the request | "This account changed since the sign-in started. Please start again." |
| A merge refusal, checked again (ban, live game, name) | the texts of `linker_present_code` above |

### server_register_linker / server_revoke_linker (Phase M5a3 execution, A177(1))

**Purpose:** The Owner registers or revokes the auth function's Linker identity.

**Permission:** Owner only.

**Parameters:** `identityHex`, `label` (register); `identityHex` (revoke).

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Caller is not an Owner or Delegate (a Linker included) | "Forbidden: caller is not a registered server identity." |
| Caller is a Delegate | "Forbidden: only the owner server identity may do this." |
| Register: label empty | "label is required" |
| Register: identity already a server identity | "Already registered." |
| Register: identity already mapped to a user | "Identity is already linked to a user; mint a fresh identity for the linker." |
| Revoke: identity not registered | "Not a registered server identity." |
| Revoke: identity is not a Linker | "Only linkers can be revoked here." |
| `server_revoke_delegate` on a Linker | "Only delegates can be revoked." |

## Acceptance Scenarios

### Guest Login (First Time)
**Given:** No UserIdentity exists for the caller's SpacetimeDB identity
**When:** `login_as_guest` is called
**Then:** User row inserted with `isGuest=true`, `role=User`, `username=Guest_{hex8}`, `avatarCharacterName='march7th'`, `hasDiscordLinked=false`. UserIdentity row inserted linking identity to user. _Superseded in Phase S10h execution (S10h review, guest name collision)._

### Guest Login (Reconnect)
**Given:** UserIdentity exists for caller, linked to User with id=5
**When:** `login_as_guest` is called
**Then:** `User.lastLoginAt` updated to current timestamp, `User.isOnline=true`, `UserIdentity.lastSeenAt` updated. No new rows created.

### Soft-Deleted User Reconnect
**Given:** UserIdentity exists for caller, linked User has `deletedAt` set
**When:** Any reducer calls `getAuthenticatedUser(ctx)`
**Then:** Throws error — soft-deleted users are rejected

### Connection Lifecycle
**Given:** User is registered (UserIdentity exists)
**When:** Client WebSocket connects
**Then:** `User.isOnline = true`
**When:** Client WebSocket disconnects
**Then:** `User.isOnline = false`

### Unregistered Connection
**Given:** No UserIdentity exists for the connecting identity
**When:** Client WebSocket connects
**Then:** No-op — `clientConnected` silently skips unknown identities

### Provider Linking (Discord) — Phase 12
**Given:** Guest user exists, UserIdentity maps identity to User
**When:** `server_link_provider` called by server identity with provider='discord', valid providerId
**Then:** User row updated: `isGuest=false`, `hasDiscordLinked=true`, `username=providerName`. UserPrivate row inserted with `discordId`, `discordUsername`. _Superseded in Phase S10e execution (backend audit 2026-11-09, identity finding 3)._ _Superseded in Phase M5a3 execution (DECISIONS.md A177(2)): `server_link_provider` is removed; see "Confirm the Link, First Sign-In"._

### Ban Enforcement at Link-Time — Phase 12
**Given:** A BanRecord exists for a Discord ID
**When:** `server_link_provider` called with the banned Discord ID
**Then:** Reducer throws with "Discord ID \<id\> is banned". No UserPrivate written. User unchanged. _Superseded in Phase S10 execution (DECISIONS.md A76)._ _Superseded in Phase M5a3 execution (DECISIONS.md A176(1), A177(2)): the link-time ban check runs at presentation and again at `confirm_link`; see "Presentation Pre-Checks" and "Confirm Re-Checks"._

### Ban Enforcement at Reconnect — Phase 12
**Given:** A BanRecord exists for a Discord ID; user with that discordId in UserPrivate reconnects
**When:** Client WebSocket connects (`clientConnected`)
**Then:** User soft-deleted immediately (deletedAt set). User cannot interact with the system.

### Ban Enforcement at Ban-Time — Phase 12 / Phase 15.2 D-10
**Given:** A verified user has UserPrivate with discordId='abc123'
**When:** `admin_ban_user` called with providerId='abc123'
**Then:** BanRecord inserted. User soft-deleted (`deletedAt` set) AND `UserDeletionJob` row inserted scheduled 5s in the future. After 5s elapse, `performUserDeletion` cascade runs (route per D-09 branching below). Pre-D-10 the UserDeletionJob row was never inserted — the cascade silently never ran (R1 latent bug).

### User Deletion — Cascade Branching (Phase 15.2 D-09)
**Given:** A user exists with `deletedAt` set (via soft-delete writer: `admin_delete_row`, `admin_ban_user`, or `clientConnected` ban-on-reconnect) AND a matching `UserDeletionJob` row is scheduled
**When:** The scheduled reducer fires `performUserDeletion(ctx, userId, actorId)` after 5s elapse
**Then:** Cascade proceeds as follows:

| Case | `isGuest` | Has history references? | Outcome |
|------|-----------|-------------------------|---------|
| 1 | `true` | **false** | **Hard-delete fast path** — `User` row removed; NO `DeletedUser` row created |
| 2 | `true` | true | **Archive** — `DeletedUser` row inserted (preserves `displayName`, `isGuest=true`, `deletedAt`); `User` row removed |
| 3 | `false` | any | **Archive** — `DeletedUser` row inserted (preserves `displayName`, `isGuest=false`, `deletedAt`); `User` row removed |

History tables scanned by `hasHistoryReferences` (any row present triggers archive): `MatchResultParticipant`, `MmrHistory`, `PlayerStat`, `PlayerCharacterStat`, `PlayerRelationship`, `Leaderboard`, `TournamentEnrolled`, `UserAchievement`.

Cascade also hard-deletes `UserPrivate`, all `UserIdentity` rows, all `HsrAccount` + `HsrAccountCharacter` rows, and all calendar data for the user — regardless of branch. Ghost accumulation in `User` eliminated: soft-deleted non-guests no longer remain in the live table with `username='deleted_<id>'`. History FK references stay intact by id (SpacetimeDB does not enforce FK — references remain pointing at the archived id).

### Display Name Resolution for Deleted Users (Phase 15.2 D-12)
**Given:** A render site (lobby members, match history step actor, match finalization participant, kick/ban target label) calls `resolveUserLabel(ctx, userId)`
**When:** The helper looks up the id
**Then:** Three-path resolution:
1. Live user → `{ displayName: user.displayName, isDeleted: false }`
2. Archived user (in `DeletedUser`) → `{ displayName: archive.displayName, isDeleted: true }`
3. Unknown id (not in either table) → `{ displayName: 'User #${id}', isDeleted: true }` synthetic fallback

Pre-15.2, path 2 did not exist — archived users were soft-deleted in `User` with `username='deleted_<id>'`, producing a ghost string at render sites. Post-15.2 the real displayName is preserved.

### Test Data Nuke Preserves SYSTEM (Phase 15.2 D-11)
**Given:** `deleted_user` has archived rows from prior deletions; `user` contains SYSTEM (id=1) plus test users
**When:** `server_nuke_test_data({ confirmation: 'NUKE_TEST_DATA' })` called with the server token
**Then:** All `deleted_user` rows removed; all non-SYSTEM `User`/`UserIdentity`/`UserPrivate` rows removed; SYSTEM (id=1) untouched in `User` and `UserIdentity`.

### UserIdentity Privacy — Phase 12
**Given:** Client subscribes to all tables
**When:** Client iterates UserIdentity from subscription cache
**Then:** Empty — UserIdentity is private (public:false). Client must use `view_my_identity` SQL subscription to see own mapping.

### Direct Discord Login (no guest first) — Phase 12 execution
**Given:** Fresh browser, no SpacetimeDB user exists for this identity
**When:** User clicks "Login with Discord", completes OAuth
**Then:** Step A auto-creates guest via `loginAsGuest`. Step B calls `/api/auth/link-discord` → `server_link_provider` upgrades guest to verified user. NavBar shows Discord username. _Superseded in Phase M5b execution (DECISIONS.md A177(2), A178): the `/api/auth/link-discord` route and `server_link_provider` no longer exist. The page still becomes a guest first, then runs the link-code flow; see "Start the Discord Sign-In" and "Confirm on the Page"._

### Logout and Re-Login via Discord (identity merge) — Phase 12 execution
**Given:** User "nathyron" (id=2) exists with Discord linked. User logs out (clears localStorage). New SpacetimeDB identity is generated.
**When:** User clicks "Login with Discord", completes OAuth
**Then:** Step A creates a temporary guest (id=3). Strategy 3 finds "nathyron" by session username. Step B calls link API. `server_link_provider` Case 1b: re-points new identity to user id=2, deletes orphaned guest id=3. NavBar shows "nathyron". Both old and new identities map to user id=2 in UserIdentity. _Superseded in Phase M5a3 execution (DECISIONS.md A177(2)) and Phase M5b execution (A178): no session username lookup ("Strategy 3") and no `server_link_provider`. The re-point is case 1b of `confirm_link`; see "Confirm the Link, Existing Account"._

### Cross-Browser Discord Login (identity merge) — Phase 12 execution
**Given:** User "nathyron" exists on browser A. User opens browser B (new SpacetimeDB identity).
**When:** User clicks "Login with Discord" on browser B
**Then:** Same merge flow as logout/re-login. New identity mapped to existing user. Orphaned guest deleted. _Superseded in Phase M5a3 execution (DECISIONS.md A177(2)): the merge now runs in `confirm_link`; see "Confirm the Link, Existing Account"._

### Stale NextAuth Session Does Not Auto-Link — Phase 12 execution
**Given:** User has a stale NextAuth session cookie (from previous Discord login). User clicks "Login as Guest".
**When:** Guest is created, `nextAuthStatus` is "authenticated"
**Then:** Discord linking does NOT auto-trigger. `hasDiscordIntent` is false (no explicit "Login with Discord" click). User stays as guest. _Superseded in Phase M5b execution (DECISIONS.md A176(1), A178): there is no NextAuth session and no `hasDiscordIntent`. A link needs a flow started in this tab and an explicit "Link this account" click; see "Confirm on the Page"._

### Delete My Account (Phase S6 execution, A45(3))
**Given:** A verified (Discord-linked) user in no lobby and in no live tournament _Superseded in Phase S10g execution (DECISIONS.md A94)._
**When:** They call `delete_my_account()`
**Then:** `performUserDeletion` runs at once: UserPrivate, calendars, presence, rate state, every `UserIdentity` and every HSR account are deleted; the `User` row is archived to `DeletedUser` (display name kept for history labels). Rejected while they sit in a lobby (any stage but AwaitingResult / Finished, not voluntarily left): "Leave your lobby before deleting your account."; rejected while enrolled (not Withdrawn / Disqualified) in a tournament that is not Completed / Cancelled: "You are enrolled in a tournament that has not finished. Withdraw first, or wait until it ends."

_Superseded in Phase S8f execution (DECISIONS.md A68)._ The lobby guard is the D-22 test: see "Delete My Account While Away".

### Delete My Account While Away (Phase S8f execution, A68(4))
**Given:** A verified user who pressed Leave in a lobby in Drafting / Equipping / Scoring (an away row, `leftAt` set)
**When:** They call `delete_my_account()`
**Then:** Rejected: "Leave your lobby before deleting your account." (an away membership counts for the one-lobby rule). A user whose only membership is abandoned (they took another lobby with `abandonCurrentMatch`) or in an AwaitingResult lobby is not blocked. Any lobby flag (host, referee, captain) the deleted user still holds moves to the next member (A68(7)).

### Delete My Account as a Guest (Phase S6 execution, A45(3); replaces delete_guest_account)
**Given:** A guest
**When:** They call `delete_my_account()`
**Then:** Same as the old `delete_guest_account`: the caller's `UserIdentity` row is deleted, and the `User` row too once no other identity points at it. `delete_guest_account` no longer exists.

### Discord Sign-In by Link Code

The entries below describe the sign-in rebuilt in M5a to M5b. Flow, windows and the code itself: [architecture.md](architecture.md) "Phase M5a execution" to "Phase M5b execution". Refusal texts: the error tables of `request_link_code`, `linker_present_code`, `confirm_link` above.

#### Request a Link Code (Phase M5a execution, A46, A175(4))
**Given:** A connected live guest with no provider linked; maintenance off
**When:** It calls `request_link_code({ clientNonce })` with 43 base64url characters
**Then:** One `LinkRequest` row for the identity: a 32-character code, `expiresAt` = now + 5 minutes. The nonce is mixed into the code and never stored or logged.

#### Request a Link Code Again (Phase M5a execution; pending row Phase M5a2 execution, A176(1))
**Given:** The guest already holds a row: live, expired, or presented and awaiting confirmation
**When:** It calls `request_link_code` again
**Then:** The old row is deleted, so its code and any pending confirm token stop working. A new row with a new code and a fresh 5-minute expiry is inserted. An identity never holds more than one row.

#### Request a Link Code Refused (Phase M5a execution)
**Given:** One of: a malformed nonce; maintenance on and the caller not an Admin; no live user for the identity; a deleted or banned user; a user that is not a guest or has a provider
**When:** It calls `request_link_code`
**Then:** Refused with the text of that case (error table above). Nothing is written.

#### Link Request View (Phase M5a execution; shape Phase M5a2 execution)
**Given:** Guest A and guest B each hold a row
**When:** A subscribes `view_my_link_request`
**Then:** A sees its own row only, at most one, with no primary key: `code` (unset once presented), `expiresAt`, `awaitingConfirm`, `pendingProviderName` (only while awaiting). Never `confirmHash`, never `pendingProviderId`, never B's row. An expired row is still returned until swept (a view has no clock); the client compares `expiresAt`. No row at all once A's user is gone, not a guest, linked or soft-deleted.

#### Link Request Clean-Up (Phase M5a execution)
**Given:** Rows whose `expiresAt` has passed (before or after presentation)
**When:** `request_link_code` runs; the weekly `run_identity_gc` runs; a user is deleted; `server_nuke_test_data` runs
**Then:** `request_link_code` examines at most 64 rows and deletes the expired ones among them; the identity GC examines up to 10,000; `performUserDeletion` deletes every row of the user; the test wipe clears the table.

#### Present a Code (Phase M5a2 execution, A176(1))
**Given:** Guest G holds a live code not yet presented; Discord account D is not banned
**When:** The Linker calls `linker_present_code({ linkCode, provider: 'discord', providerId: D's id, providerName: D's handle, confirmHash })`
**Then:** G's row records the pending provider, id and cleaned name, `confirmHash`, `usedAt` = now and `expiresAt` = now + 2 minutes. No `User`, `UserIdentity` or presence row changes. G's view shows `awaitingConfirm` true, `pendingProviderName`, no code.

#### Present a Code Twice, Unknown or Expired (Phase M5a execution, A175(5); one presentation per code since Phase M5a2 execution)
**Given:** A code that does not exist, was already presented, or has expired
**When:** The Linker presents it
**Then:** "This link code is invalid or has expired." for all three. Nothing changes. The module log names the reason only, never the code, token or hash.

#### Presentation Pre-Checks (Phase M5a execution, A175(5); at presentation since Phase M5a2 execution)
**Given:** A live code, and one of: D's id is banned; G would be deleted by the re-point (D already has a user, G has no other identity) while G holds a player seat, not abandoned, in a Drafting, Equipping or Scoring lobby; G's identity now maps to another user, or G is gone, no longer a guest, linked or soft-deleted; the name is empty after the clean-up
**When:** The Linker presents it
**Then:** Refused with the text of that case. The row is unchanged and the code stays live until it expires or is replaced.

#### Discord Id and Hash Shape (Phase M5a execution, A175(7); hash Phase M5a2 execution)
**Given:** Provider `discord` with an id that is not 17 to 20 digits, or a `confirmHash` that is not the canonical base64url of 32 bytes
**When:** The Linker presents a code
**Then:** "providerId is not a Discord id." or "confirmHash must be 43 base64url characters (a SHA-256 digest).", checked before the code is looked up. The code is untouched.

#### Provider Name Clean-Up (Phase M5a execution, A175(7); bidi and zero-width characters Phase M5a2 execution)
**Given:** A presented name with C0 or C1 control characters, DEL, bidi controls or zero-width format characters, or longer than 32 UTF-16 units
**When:** It is presented, and later linked
**Then:** Those characters are removed, the name is trimmed and cut to 32 units without splitting a surrogate pair. The cleaned name is the pending name, the provider name and, for a first sign-in, the username base. Empty after the clean-up: "providerName is required".

#### Confirm the Link, First Sign-In (Phase M5a2 execution, A176(1))
**Given:** G's row is presented with D, no user holds D, the 2-minute window is open
**When:** G's own identity calls `confirm_link({ confirmToken })` with the token whose hash was presented
**Then:** The row is deleted and G is upgraded in place in the same transaction: `isGuest` false, `loginMethod` 'discord', `providerId`, `providerUsername`, `linkedAt` = now; username = the handle, or the first free `_2`, `_3`, ... variant. G's `view_my_profile` row changes on the same connection; `view_my_link_request` returns nothing.

#### Confirm the Link, Existing Account (Phase M5a2 execution, A176(1))
**Given:** D already belongs to user U; G's row is presented with D
**When:** G confirms with the right token in time
**Then:** Case 1b: G's identity is re-pointed to U and its presence row follows; G's entries in unfinished tournaments move to U (A112); G is deleted when no other identity points at it; the row is deleted. Proven with module tests and the stub; not yet with real Discord (M5b log).

#### Confirm Refused (Phase M5a2 execution, A176(1))
**Given:** G's identity, and one of: a malformed token; maintenance on (G not an Admin); no live user; a deleted or banned user; no presented row, or its window has passed; a token whose hash does not match
**When:** G calls `confirm_link`
**Then:** Refused with the text of that case. Every refusal rolls back: a wrong token does not burn the row, and there is no attempt counter (the token carries 256 bits). The right token still confirms while the window is open.

#### Confirm on Another Connection (Phase M5a2 execution, A176(1))
**Given:** G's row is presented; another live guest H holds G's token
**When:** H calls `confirm_link` with it
**Then:** Only H's own row is read. H has none presented: "No sign-in is waiting for confirmation. Please start again."; H has its own presented row: "This sign-in could not be confirmed." G's row is unchanged.

#### Confirm Re-Checks (Phase M5a2 execution, A176(1))
**Given:** Since the presentation D was banned, or G took a player seat in a live game (re-point case), or G's account changed
**When:** G confirms with the right token
**Then:** Refused with that case's text. Nothing is linked; the row stays until it expires or is replaced.

#### No Link During Maintenance (Phase M5a2 execution, A176(1), settles A175(9); Linker part Phase M5a3 execution)
**Given:** Maintenance mode is on
**When:** A non-Admin guest requests a code or confirms; the Linker opens a new connection
**Then:** `request_link_code` and `confirm_link` refuse ("The site is in maintenance. Please try again later."); the Linker's connection is refused at connect ("Maintenance mode: connections are not accepted right now."). A presentation on a Linker connection opened before is accepted, but no link completes and the pending row expires after 2 minutes.

#### The Linker Identity (Phase M5a3 execution, A177(1))
**Given:** The Owner registered identity L with `server_register_linker`
**When:** L calls `linker_present_code`; the Owner or a Delegate calls it
**Then:** L is accepted. The Owner and Delegates are refused ("Forbidden: caller is not the registered linker identity."). L has a `ServerIdentity` row of kind Linker and no `UserIdentity` row.

#### Linker Refused Everywhere Else (Phase M5a3 execution, A177(1))
**Given:** The registered Linker L
**When:** L calls a `server_*` reducer, `login_as_guest`, or an admin or user reducer
**Then:** `server_*`: "Forbidden: caller is not a registered server identity."; `login_as_guest`: "Forbidden: a linker identity cannot sign in as a user."; admin and user reducers find no user for L and refuse as for any unknown identity. Nothing is written.

#### Linker Connect and Disconnect (Phase M5a3 execution)
**Given:** The registered Linker L, maintenance off
**When:** L connects and disconnects (each HTTP reducer call does both)
**Then:** `client_connected` and `client_disconnected` write nothing: no presence, no last-seen, no ban check, no lobby work.

#### Revoke the Linker (Phase M5a3 execution, A177(1))
**Given:** The registered Linker L
**When:** The Owner calls `server_revoke_linker(L)`
**Then:** L's `ServerIdentity` row is deleted (it has no other row). L's next presentation is refused ("Forbidden: caller is not the registered linker identity.").

#### Direct Link Removed (Phase M5a3 execution, A177(2))
**Given:** Any caller
**When:** It looks for a reducer that links an identity named by its hex
**Then:** None exists: `server_link_provider` is removed. `confirm_link` is the only reducer that links, and only for the caller's own identity.

#### Second Sign-In on a Linked Account (Phase M5a3 execution, A177(2))
**Given:** A user already linked to Discord
**When:** Its identity calls `request_link_code`
**Then:** "This account is already linked." No code; the account is unchanged.

#### What the Link Token Allows (Phase M5a3 execution, A177(5); accepted for test1 by A179(2))
**Given:** Someone holds the link token
**When:** They request a code as a guest of their own, present it with a target account's Discord id, and confirm on their own connection
**Then:** Case 1b re-points their identity to the target account, staff included. Known limit, open: new-device approval for staff accounts is to be built before the first prod publish.

#### Start the Discord Sign-In (Phase M5b execution, A178)
**Given:** The page of a guest holding a live code
**When:** It sends `POST /api/auth/discord/start` with the exact app `Origin`, `Content-Type: application/json` and body `{ linkCode }`
**Then:** `200 { url }`: Discord's authorize address (`scope=identify`, `prompt=consent`, a fresh `state`). A sealed HttpOnly state cookie holding the state and the code is set for 10 minutes. The code is in no URL.

#### Start Refused (Phase M5b execution, A178(4))
**Given:** A start request with another method, an `Origin` that is not exactly the app origin, a non-JSON content type, or a body that is not JSON with a 32-character base64url `linkCode` (or is over 1 KB)
**When:** It reaches `start`
**Then:** 405, 403, 415 or 400 with a generic JSON body. No cookie is set; nothing is called.

#### Callback Fails Closed (Phase M5b execution)
**Given:** A return with no `code` or `state`, no state cookie, a cookie that does not unseal or is older than 10 minutes, or a state that does not match
**When:** It reaches `callback`
**Then:** 303 to `/?login=1&status=failed` before any call to Discord or the database. The state cookie is cleared only when it matched or was broken or expired; with no cookie or a mismatched state it is left alone, so a request another site makes cannot cancel a sign-in in progress.

#### Cancelled at Discord (Phase M5b execution)
**Given:** The visitor declines on Discord
**When:** The return carries `error=access_denied`
**Then:** With the matching state: `status=cancelled`, state cookie cleared. Without it: `status=failed`, cookie left alone.

#### Callback Presents the Code (Phase M5b execution, A176, A177)
**Given:** A matching return
**When:** The function exchanges the code with Discord and reads the user
**Then:** It takes the id and the handle (`username`, never the display name), draws a fresh 32-byte confirm token and presents the code with the token's hash over HTTP with the link token. Success: 303 to `/?login=1&status=confirm`, the token in a 2-minute readable `__Host-` cookie with `SameSite=Strict`. The function keeps nothing.

#### A Module Refusal Reaches the Page (Phase M5b execution, A178(6))
**Given:** `linker_present_code` refuses
**When:** The function reads the answer
**Then:** It is a refusal only when the body is one line of `text/plain`, at most 200 characters, with no control or line-separator character, not starting with "forbidden" in any case. Then `status=refused` and the text in a 2-minute readable cookie; the panel shows "Sign-in refused." and that line. Any other answer, status, timeout or network error: "Sign-in failed." with a fixed line.

#### Confirm on the Page (Phase M5b execution, A176(1), A178(3))
**Given:** A return with `status=confirm` in the tab that started the flow, the profile still a guest, the view showing a pending row unexpired by the page's clock
**When:** The panel opens
**Then:** "Link account." shows the pending handle with "Link this account" and "Cancel". Nothing is called until the click. On the click the page re-reads the live row: same handle and expiry as first shown, the handle still on screen, unexpired, still a guest. Only then it reads and deletes the token cookie (one attempt) and calls `confirm_link`. Linked: the profile turns into the signed-in user on the same connection and the page moves on.

#### Confirm Not Offered (Phase M5b execution)
**Given:** One of: the return lands in a tab without the flow marker; no pending row on return; the row expired by the page's clock, at return or at the click; the profile is no longer a guest at the click
**When:** The page handles it
**Then:** No `confirm_link`. A tab without the marker shows "Sign-in failed." and leaves the cookie to expire. A missing or expired row shows "The sign-in took too long. Please try again." and drops the token. A non-guest at the click fails and drops the token.

#### Changed in Another Tab (Phase M5b execution, A178(3))
**Given:** The confirm panel is open
**When:** The live row's handle or expiry changes, or the row disappears (another tab started a flow)
**Then:** "The sign-in changed in another tab. Please try again." No `confirm_link`; the cookie is left alone (it may hold the other flow's token).

#### Signed-In User on the Sign-In Address (Phase M5b execution)
**Given:** A signed-in (non-guest) user
**When:** They open `/?login=1`, or return there with a status
**Then:** They are sent on to the safe `next` path, else `/`. A returned confirm token is discarded. They are never made a guest.

#### Sign-In to an Account Pending Deletion (Phase M5a execution; decided A177(3))
**Given:** User U is soft-deleted by staff (not banned), its deletion job 5 seconds out; a guest signs in with U's Discord account
**When:** The guest confirms
**Then:** The sign-in succeeds (case 1b re-points to U). Left as it is. A banned account is refused at presentation, because the ban puts the Discord id in `BanRecord`.

#### Guest Creation Off Blocks a New Browser (Phase M5a execution; decided A177(4))
**Given:** `AbuseConfig.guestCreationEnabled` is off
**When:** A verified user signs in from a browser whose identity is not mapped yet
**Then:** `login_as_guest` refuses the new identity, so no code can be requested and the sign-in cannot start until the switch is back on. A returning browser is not affected. Left for now; revisit at launch preparation.

#### Same-User Two-Tab Window (Phase M5b execution; accepted A178(8), A179(2))
**Given:** The same user runs two sign-ins with two Discord accounts in two tabs, and the first tab's connection no longer receives updates but can still send
**When:** They click "Link this account" in the first tab
**Then:** The click checks that tab's stale cache, so it can link the second flow's account under the first handle. Accepted as documented: no attacker can cause it. Closing it needs `confirm_link` to take the expiry the page saw.

## Edge Cases

| Case | Expected Behavior | Notes |
|------|-------------------|-------|
| Identity hex collision in guest username | Extremely unlikely (8 hex chars = 4 billion combinations) | If it happened, autoInc id makes User rows unique regardless |
| Rapid connect/disconnect | Each lifecycle hook is its own transaction — no race condition | SpacetimeDB serializes reducer calls |
| Guest calls privileged reducer | `ensureVerifiedUser` rejects with error | Per-reducer guard, not auth-level |
| Banned user tries to link again | `rejectIfBanned` blocks at link-time | BanRecord + hasDiscordLinked=false prevents re-entry _Superseded in Phase M5a3 execution (DECISIONS.md A176(1), A177(2)): checked at presentation and again at `confirm_link`._ |
| Stale cached userId after DB clear | Strategy 1 miss → clears cache → falls through to Strategy 2/3 | Self-healing: no manual localStorage clear needed _Superseded in Phase M5b execution (DECISIONS.md A178): the page reads its user from `view_my_profile`; no cached-id or session-name strategies._ |
| Multiple identities for same user | All map to same User.id in UserIdentity | Accumulate over logouts/new browsers; GC implemented in Phase 12.1 (see [smoke/contract.md](../smoke/contract.md#identity-garbage-collection-phase-121)) |
| `getServerSession` returns null in POST handler | Direct cookie read + JWT decode bypasses next-auth pipeline | Known next-auth 4.x bug in App Router POST routes _Superseded in Phase M5b execution (DECISIONS.md A178): no next-auth; the function keeps its state in a sealed cookie of its own._ |
| Client/server database name mismatch | Server imports from shared `lib/spacetimedb.ts` | Single source of truth prevents silent WebSocket failures _Superseded in Phase M5b execution (DECISIONS.md A178(4)): the function takes the database name from `STDB_DATABASES` in `shared/stdb-targets.ts` for its one accepted target._ |
| DiscordLink component bypasses intent flag | Uses `loginDiscord()` from auth context (not direct `signIn`) | Ensures `hasDiscordIntent` is set for Step B _Superseded in Phase M5b execution (DECISIONS.md A178): no `hasDiscordIntent`; a flow marker in the tab and the explicit click gate the link._ |
| Two `request_link_code` calls in one microsecond | Different codes: the previous code is hashed in; a primary-key clash re-draws, at most 4 times | _Phase M5a execution._ |
| No rate limit on `request_link_code` | One row per identity; new identities are bounded by the guest-creation breaker | _Phase M5a execution._ Same as the other identity reducers |
| Expired row still in the view | The page compares `expiresAt` with its own clock; the reducers refuse an expired row anyway | _Phase M5a execution._ A view has no clock |
| Keyless view row changes | The page treats a change as a delete plus an insert and tolerates two rows in one callback | _Phase M5b execution._ |
| Wrong confirm token | Refused; the row survives; the right token still works in the window | _Phase M5a2 execution._ No attempt counter: 256-bit token |
| Slow first Discord login (over 5 minutes) | Presentation refused with the expired-code text; the page shows it as "Sign-in refused." | _Phase M5b execution._ |
| Start request hangs | The page gives up after 10 seconds: "Sign-in failed." | _Phase M5b execution._ |
| `UserIdentity` row written by hand for a Linker | Not refused at call time | _Phase M5a3 execution._ Documented, not pinned; every reducer that creates a mapping refuses a Linker |
| Discord return address not registered exactly | Discord refuses with "Invalid OAuth2 redirect_uri"; nothing on the site changes | _Phase M5b execution (real Discord test, A179(3))._ |

## Integration Points

| This Feature | Connects To | How | Direction |
|-------------|------------|-----|-----------|
| `User.id` | All features | FK from virtually every table | reads |
| `UserIdentity.identity` | `getAuthenticatedUser` helper | ctx.sender → User resolution | reads |
| `UserPrivate.discordId` | `checkProviderBan` helper | Ban enforcement at link/reconnect _Superseded in Phase S11a execution (DECISIONS.md A77): `UserPrivate` is gone; the provider id is `User.loginMethod` + `User.providerId` on the private `User` row, checked against `BanRecord` by `checkProviderBan` at reconnect and through `rejectIfBanned` at presentation and `confirm_link`._ | reads |
| `clientDisconnected` | Lobby disconnect handling | Triggers disconnect policy | writes |
| `User.isOnline` | Lobby browser, cursor tracking | Online presence indicator | reads |
| `User.hasDiscordLinked` | Frontend components | Link status display (replaces discordId) | reads |
| `request_link_code`, `view_my_link_request` | Sign-in page (`web/src/pages/sign-in/`) | The page asks for the code and subscribes the view only during a flow. _Phase M5a execution; page Phase M5b execution._ | both |
| `linker_present_code` | Auth function (`api/auth/discord/callback`) | HTTP reducer call with the link token. _Phase M5a3 execution; caller Phase M5b execution._ | writes |
| `confirm_link` | Sign-in page | Called on the requesting connection after the click. _Phase M5a2 execution._ | writes |
| `confirm_link` case 1b | `performUserDeletion`, tournament entry transfer (A112) | The replaced guest's entries move, then the guest is deleted. _Phase M5a3 execution (was `server_link_provider`)._ | writes |
| `LinkRequest` | `run_identity_gc`, `performUserDeletion`, `server_nuke_test_data` | Clean-up of stale and deleted users' rows. _Phase M5a execution._ | writes |
| `ServerIdentity` kind Linker | Bootstrap script (`scripts/stdb/bootstrap.ts`) | Registers or keeps the Linker and writes its token for the function's secret. _Phase M5a3 execution (A177(6))._ | writes |
| `AbuseConfig.maintenanceMode` | `request_link_code`, `confirm_link`, `client_connected` | A non-Admin and a new Linker connection are refused. _Phase M5a2 and M5a3 execution._ | reads |
| `AbuseConfig.guestCreationEnabled` | Sign-in from a new browser | `login_as_guest` must succeed before `request_link_code`. _Phase M5a execution (A177(4))._ | reads |

## Phase History

| Decision | Source | Date |
|----------|--------|------|
| Guest login creates User + UserIdentity | Phase 1 execution | 2026-03-16 |
| Soft-delete pattern (deletedAt check in getAuthenticatedUser) | Phase 2 discussion | 2026-03-16 |
| clientDisconnected disconnect handling | Phase 10 execution | 2026-04-03 |
| Auth/Admin doc separation | Pre-Phase 11 cleanup | 2026-04-06 |
| UserPrivate private table stores discordId/email (replaces public User.discordId) | Phase 12 discussion | 2026-04-08 |
| BanRecord private table for ban infrastructure | Phase 12 discussion | 2026-04-08 |
| UserIdentity made private (public:false); clients use view_my_identity | Phase 12 discussion | 2026-04-08 |
| server_link_provider replaces server_link_discord (unified provider linking) | Phase 12 discussion | 2026-04-08 _Superseded in Phase M5a3 execution (DECISIONS.md A177(2))._ |
| hasDiscordLinked bool replaces discordId on public User table (D-02) | Phase 12 execution | 2026-04-08 |
| Ephemeral connection for identity verification in API route (D-09, SEC-04) | Phase 12 execution | 2026-04-08 _Superseded in Phase M5a execution (DECISIONS.md A46, A175): the browser's token never leaves it; the code names the identity._ |
| view_my_profile merges User + UserPrivate for caller's own data | Phase 12 execution | 2026-04-08 |
| view_admin_user_private for Moderator+ access to UserPrivate data | Phase 12 execution | 2026-04-08 |
| view_user_directory projects to UserDirectoryRow safe subset (D-16) | Phase 12 execution | 2026-04-08 |
| D-08 three-point ban enforcement: link-time + reconnect + ban-time | Phase 12 execution | 2026-04-08 |
| ViewMyProfile not generated by spacetime generate (views not in codegen) — useAuth.ts uses User table fallback (Strategy B) | Phase 12 execution | 2026-04-08 |
| getServerSession replaced with direct cookie read + JWT decode (next-auth 4.x App Router POST bug) | Phase 12 execution | 2026-04-08 _Superseded in Phase M5b execution (DECISIONS.md A178)._ |
| spacetimedb-server.ts imports HOST/DB_NAME from shared lib/spacetimedb.ts (prevents database name mismatch) | Phase 12 execution | 2026-04-08 _Superseded in Phase M5b execution (DECISIONS.md A178(4)): `STDB_DATABASES` in `shared/stdb-targets.ts`._ |
| Reactive User table callbacks (onInsert/onUpdate) replace setTimeout-based profile re-reads | Phase 12 execution | 2026-04-08 |
| Strategy 3 (NextAuth session username lookup) handles post-merge identity recovery | Phase 12 execution | 2026-04-08 _Superseded in Phase M5b execution (DECISIONS.md A178)._ |
| hasDiscordIntent gates Discord linking — stale NextAuth sessions don't auto-link | Phase 12 execution | 2026-04-08 _Superseded in Phase M5b execution (DECISIONS.md A176(1), A178): the tab's flow marker and the explicit click._ |
| DiscordLink.tsx uses loginDiscord() instead of direct signIn("discord") | Phase 12 execution | 2026-04-08 _Superseded in Phase M5b execution (DECISIONS.md A178)._ |
| server_link_provider Case 1b: identity merge (re-point identity, delete orphaned guest) verified across all 4 auth paths | Phase 12 execution | 2026-04-08 _Superseded in Phase M5a3 execution (DECISIONS.md A177(2)): case 1b runs in `confirm_link`._ |
| Phase 12.1 implemented: Identity GC with 90-day TTL, guards (guests, online, preserve-newest, orphans), GcResult audit — see [smoke/contract.md](../smoke/contract.md#identity-garbage-collection-phase-121) | Phase 12.1 execution | 2026-04-08 |
| Full hydration from codebase | Phase 13 normalization | 2026-04-09 |
| User deletion cascade branches on `isGuest && !hasHistoryReferences` — only clean guests hard-delete, all other cases archive to `DeletedUser` (D-09); `admin_ban_user` + `clientConnected` ban-on-reconnect now insert `UserDeletionJob` (D-10 R1 fix); `resolveUserLabel` helper resolves displayName across live/archive/synthetic fallback (D-12); `server_nuke_test_data` also clears `deleted_user` (D-11); `User.isPrivate` column removed (D-02 dead code) | Phase 15.2 execution | 2026-04-15 |
| UAT verify-work (Test 6) surfaced doc wording oversimplification — "guest fast-path / non-guest eviction only" framing is incorrect. Actual rule: hard-delete only when `isGuest=true` AND `hasHistoryReferences=false`; a guest that has played a match will be archived, not hard-deleted. Scenario block above corrected | Phase 15.2 execution | 2026-04-16 |
| `useAuth.ts` subscription split into Stage 1 (always-on `view_my_profile`) + Stage 2 (gated `SELECT * FROM user`) — closes the Phase 15.2 UAT Test 4 bandwidth leak. Behavior contract: anonymous visitors (no resolved User, no `spacetimedb_user_id` in localStorage, no `stdb_session` cookie) MUST receive zero rows in the User table cache; Stage 2 fires only when the gate condition `currentUser != null \|\| hadUserIdOnMount.current \|\| hadSessionCookie.current` is true AND the WS handshake has succeeded (`isActive` true). Stale token / cookie cannot open Stage 2 because the handshake fails first (defense-in-depth, T-15.5-03 mitigation) | Phase 15.5 execution | 2026-04-16 |
| `guestLoginPending` UX state drives the inline Login-button spinner ("Signing in…"). Behavior contract: spinner SHOWS only while `loginAsGuest` reducer promise is unresolved AND `currentUser` is null; clears on either successful `currentUser` resolution or reducer rejection (`useAuth.ts:427-431` `.catch` handler). Spinner MUST NOT activate during returning-user reconnect (Stage 2 opens via `userId`/`cookie` signal, not via `loginGuest` callback), Discord login click (Discord flow's internal `loginAsGuest` bypasses the wrapper), or initial WS connect. Spinner state has zero auth significance (T-15.5-02 cosmetic-only) — DevTools manipulation cannot elevate privilege | Phase 15.5 execution | 2026-04-16 _Superseded: the Next.js frontend and its `useAuth.ts` were replaced by the Vite app (M3, DECISIONS.md A3); the sign-in panel and its states since Phase M5b execution (A178)._ |
| `view_user_directory` retired — was a dead-code projection with zero client subscribers; the cosmetic Phase 15.2 D-06 `view`/`anonymousView` flip turned out to be a no-op at the framework level. Removing the view + bindings reduces module-publish surface and prevents future devs from re-introducing it as a "safe anonymous bookmark" without a concrete use case (YAGNI). Behavior contract change: any code or doc referencing `view_user_directory` is now incorrect — clients must subscribe to `SELECT * FROM user` (post-auth, via Stage 2) for User directory data | Phase 15.5 execution | 2026-04-16 |
| `view_public_accounts` renamed to `view_public_hsr_accounts` — keeps the `public` prefix marking anonymous intent and adds `hsr_` to make the projected source table (`HsrAccount`) explicit in the name. Behavior contract: anonymous subscription to `view_public_hsr_accounts` continues to return rows where `isRosterPublic=true`, with rating field projected only when `isRatingPublic=true`. The view's `anonymousView` registration and projection body are unchanged from the Phase 10.4 implementation — this is a pure identifier rename with provenance documented in `docs/views/architecture.md` and `docs/auth/architecture.md` Subscription Lifecycle / Intentional Anonymous Exceptions | Phase 15.5 execution | 2026-04-16 |
| Subscription Lifecycle pattern codified in `docs/auth/architecture.md` (Phase 15.5 D-05). Names two intentional anonymous-view exceptions (`view_lobby_browser`, `view_public_hsr_accounts`) where the projection body IS the privacy gate; states the rule for any future subscription work; documents the accepted tradeoff that `User.public=true` means adversarial direct subscriptions remain possible (deferred per 15.2 D-01) | Phase 15.5 execution | 2026-04-16 |
| Phase 15.5 verify-work harmonized doc wording — `hadTokenOnMount` references in `docs/auth/architecture.md` Subscription Lifecycle aligned with the shipped `hadUserIdOnMount` identifier (Plan 02 D-01 deviation `790a39c`); rationale + `useAuth.ts:116` first-guard reference added to the Stage 2 description. Test surface: `test/backend/auth/auth-subscriptions.test.ts` (anonymous + authenticated paths) is the regression guard | Phase 15.5 verify-work | 2026-04-17 |
| Phase 16 subscription reshuffle behavior contract: Stage 1 (`view_my_profile`) moves to `components/features/auth/components/AuthProvider.tsx` (always-on); Stage 2 (`SELECT * FROM user`) moves to `app/(authed)/layout.tsx` (route-group mount IS the gate). Route-group rename: `(authenticated)` → `(authed)`, `(landing-page)` → `(public)`, `(game)/draft` collapsed into `(authed)/(match)/draft`. Anonymous visitors receive zero User rows because the authed layout never mounts for them (middleware is UX-only redirect, not an auth trust boundary) | Phase 16 execution | 2026-04-18 |
| Phase 16 useAuth performance pass: collapsed redundant auth-context reads and memoized the `useAuth()` return object so callers re-render only when their used subset changes. Public auth API unchanged (`currentUser`, `isActive`, `profileReady`, `nextAuthStatus`, `hasUser`, etc.) — this is a pure memoization refactor, no behavior change | Phase 16 execution | 2026-04-19 _Superseded: the Next.js frontend (`nextAuthStatus` included) was replaced by the Vite app (M3, DECISIONS.md A3) and the M5b sign-in (A178); the page reads its user from `view_my_profile`._ |
| Phase 16 UAT findings (CSP, SW, image handling) — `next.config.ts` CSP `script-src` requires `'unsafe-eval'` in both dev AND prod because the SpacetimeDB SDK uses `Function()` constructor at runtime for BSATN codec generation; dropping it at build-time breaks auth (and all reducer calls) in CSP-enforcing browsers. `next.config.ts` `connect-src` requires `https://*.ufs.sh` so the Service Worker can re-issue allowlisted CDN fetches without CSP rejection. Neither finding changes the auth API surface — both are infrastructure prerequisites for auth + SDK to work in prod | Phase 16 verify-work | 2026-04-19 |

| `delete_my_account()` for every user (verified: lobby + live-tournament guards, cascades through `performUserDeletion`; guest: the old `delete_guest_account` behaviour); `delete_guest_account` removed | Phase S6 execution (DECISIONS.md A45(3)) | 2026-11-06 _Superseded in Phase S10g execution (DECISIONS.md A94)._ |
| Scenario "Delete My Account While Away": the lobby guard is the D-22 test (away blocks, abandoned / AwaitingResult do not); `performUserDeletion` hands over the user's lobby flags | Phase S8f execution (DECISIONS.md A68) | 2026-11-08 |
| Rejection texts as implemented (tests `s10-identity`): `admin_ban_user` on a provider id already banned — "Provider <BanType>:<providerId> is already banned."; unban of an unknown record — "BanRecord #<id> not found."; the Admin-only gates — "Forbidden: Requires Admin privileges."; link-time ban (SEC-03a, `server_link_provider`) — "This <provider> account is banned and cannot be linked." | Phase S10 execution (DECISIONS.md A76) | 2026-11-09 _Superseded in part in Phase M5a3 execution (DECISIONS.md A177(2)): the link-time ban text is unchanged but raised by `linker_present_code` and `confirm_link`._ |
| Provider link, guest upgrade: `providerName` is trimmed and cut to 32 characters (empty: "providerName is required"); when the name is taken the username becomes the first free `name_2`, `name_3`, … within 32 characters, so the link never fails on a name collision | Phase S10e execution (backend audit 2026-11-09, identity finding 3) | 2026-11-09 |
| Account deletion and tournaments: the organizer of a tournament that is not Completed or Cancelled cannot delete their own account ("You organize a tournament that has not finished. Cancel it, or wait until it ends, before deleting your account."), verified or guest. A live enrolment no longer blocks `delete_my_account`: every deletion path first settles the user's tournament ties (withdrawn while the bracket does not exist, disqualified once it does) and deletes their team requests, assistant rows, stand-in approvals, account locks and waitlist choices. The verified branch keeps its lobby guard ("Leave your lobby before deleting your account.") | Phase S10g execution (DECISIONS.md A94) | 2026-11-09 |
| Guest names: a new guest is "Guest_" plus the last 8 hex characters of the identity (the first 4 are a fixed tag on every identity), with a `_2`, `_3`, … suffix when taken, so a guest login never fails on the unique username. An orphan identity mapping is repointed to the new guest user | Phase S10h execution (S10h review, identity LOW 10) | 2026-11-10 |
| Guest creation limit: new guest users are counted per window (`AbuseConfig.guestCreationBurstThreshold` 100, `guestCreationBurstWindowMinutes` 10); the creation that crosses the threshold succeeds, turns `guestCreationEnabled` off and writes one `guest_create_burst` admin alert; while off, a new guest is refused ("New guest accounts are temporarily disabled. Please try again later.") and a returning guest still logs in. `admin_set_guest_creation(true)` or `admin_update_abuse_config` re-enables it and resets the counter | Phase S10h execution (DECISIONS.md A95) | 2026-11-10 |
| Guest creation limit: the default threshold is 300 new guests per 10 minutes (a database that already holds its settings row keeps the stored value). The switch stays off after a trip until it is turned on again by `admin_set_guest_creation`, `admin_update_abuse_config`, or the server reducer `server_set_guest_creation(enabled)` | Phase S10i execution (DECISIONS.md A109) | 2026-11-10 |
| Sign-in to an existing account: when a guest signs in with a provider account that already has a user and the guest is deleted, each of the guest's tournament entries in an unfinished tournament first moves to the existing user (A112, see the tournament contract); everything else of the guest is deleted as before, lobby memberships included | Phase S10l execution (DECISIONS.md A112) | 2026-11-10 _Superseded in Phase S10m execution (DECISIONS.md A113)._ |
| Sign-in to an existing account is refused while the guest is seated as a player (not a coach, not a spectator, not an abandoned seat) in a lobby that is in Drafting, Equipping or Scoring: "Finish your current game before signing in to an existing account."; nothing changes. The first-time link, which upgrades the guest in place, is not affected. Stats of games the guest played before signing in stay on the guest account | Phase S10m execution (DECISIONS.md A113) | 2026-11-10 |
| User deletion settles the tournaments the user organizes first: hand-over on a staff action (A121), cancel on a server action (A124); a self-deletion by an organizer stays refused (A94); the ban enforced at reconnect does neither | Phase S10s execution (DECISIONS.md A121, A124) | 2026-11-10 |
| `User` is a private table; `UserPrivate` no longer exists: its columns (`loginMethod`, `providerId`, `providerUsername`, plus `linkedAt`) are on `User`, and `hasDiscordLinked` is derived from `loginMethod`. No client reads `User`: a user reads their own data through `view_my_profile`, other players get names and avatars through the views that carry them and a username only through `view_user_by_username` (exact match), staff read `view_admin_users` and `view_admin_user_private`. Every earlier statement in this contract about `UserPrivate` or a stored `hasDiscordLinked` reads accordingly | Phase S11a execution (DECISIONS.md A77) | 2026-11-12 |
| Maintenance mode: an identity mapped to a live Admin connects; every other client is refused at connect ("Maintenance mode: connections are not accepted right now."); a non-Admin who is still connected is refused on every client reducer ("The site is in maintenance. Please try again later."), `broadcast_cursor` drops the call silently; server-identity and scheduled reducers keep running | Phase S11a execution (DECISIONS.md A163(3)) | 2026-11-12 |
| The five scheduled reducers (`run_user_deletion`, `run_identity_gc`, `run_lobby_gc`, `run_referee_transfer_check`, `run_tournament_finalize`) refuse every caller that is not the scheduler ("Forbidden: <name> is a scheduled reducer and runs only from the scheduler."). `admin_gc_identities` and `admin_gc_lobbies` re-create their job row when the table is empty or the only row is overdue by more than one interval (at least 1 hour) | Phase S11a execution (DECISIONS.md A163(6); triage L11, L6) | 2026-11-12 |
| Link codes: `request_link_code` (live unlinked guest, one row per identity, 5 minutes, a new request replaces the old), `view_my_link_request` (own row only), presentation by code with one text for unknown, used and expired codes, clean-up (inline sweep of 64 rows, weekly GC, user deletion, test wipe). User decisions: A46 (the function and the link-code flow), A175 items 1 to 3 (login on localhost, one Discord application, `.env.example`). Execution choices: A175 item 4 (browser nonce), item 5 (a refused merge keeps the code live, its own text), item 7 (Discord id shape, name clean-up); item 6 (keep `server_link_provider`) later superseded by A177(2) | Phase M5a execution (DECISIONS.md A44(3), A46, A175) | 2026-11-13 |
| The second lock: presentation stores a pending link and the token hash and changes no account; one presentation per code; 2-minute confirm window; `confirm_link` by the requesting identity links; no link during maintenance (settles A175(9)). User decision: A176 item 1 (the two-step link). Execution choices (A176 item 1): the 2-minute window, no attempt counter, a new request drops a pending one, the view shows the pending name but never the id or hash and hides unusable rows; bidi and zero-width characters stripped from names | Phase M5a2 execution (DECISIONS.md A176) | 2026-11-13 |
| The Linker identity (Owner registers and revokes; only it presents; refused by every other reducer and at connect under maintenance; connect and disconnect write nothing); `server_link_provider` removed; a second sign-in on a linked account refused. User decisions: A177 items 1 to 4 (narrow key, direct link removed, sign-in to an account pending deletion left as is, guest-creation switch left for now). Execution choice: A177 item 6 (bootstrap keeps the Linker). Open: A177 item 5 (the link token can sign in as any Discord-linked account) | Phase M5a3 execution (DECISIONS.md A177) | 2026-11-13 |
| The login function and the sign-in page: `start` and `callback` rules, cancelled, refused and failed outcomes, the confirm step on an explicit click, the changed-in-another-tab and too-long states, a signed-in user sent on. User decisions: A178 items 1 and 2, A179 (the panel lede; the orchestrator's recommendations accepted, including the two-tab window and the link-token limit for test1). Execution choices, confirmed by A179(2): A178 items 3 to 8 (wording, fixed `AUTH_ORIGIN` and prod-only target, `SameSite=Strict`, refusal display rule, lobby id rule, two-tab window). The lobby id rule (A178(7)) is not an auth behaviour and is left out of this contract. Contract entries for M5a to M5b written after the real Discord test | Phase M5b execution (DECISIONS.md A178, A179) | 2026-11-14 |
