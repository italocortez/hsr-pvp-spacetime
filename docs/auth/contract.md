# Auth

**Architecture:** [architecture.md](architecture.md)

## Feature Overview

Authentication manages how users connect to the SpacetimeDB module, create accounts (guest or Discord-linked), and maintain online presence. The auth system is minimal by design — a single `login_as_guest` reducer handles account creation and reconnection. Discord linking and role management are server-side operations.

## Reducers

### login_as_guest

**Purpose:** Create a guest user or reconnect an existing one

**Permission:** Any (no auth required — this IS the auth entry point)

**Parameters:** None (uses `ctx.sender` identity)

**Flow:**
1. Look up `ctx.sender` in UserIdentity table
2. If found → find linked User → update `lastLoginAt`, `isOnline=true`, `lastSeenAt` → return
3. If not found → generate guest username from identity hex (`Guest_{first8chars}`)
4. Insert new User row (isGuest=true, isOnline=true, role=User, avatarCharacterName='march7th', hasDiscordLinked=false)
5. Insert UserIdentity row linking `ctx.sender` → new User

**Expected State Changes:**
- Existing user: `User.lastLoginAt` = ctx.timestamp, `User.isOnline` = true, `UserIdentity.lastSeenAt` = ctx.timestamp
- New user: `User` row inserted (hasDiscordLinked=false), `UserIdentity` row inserted

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| None — reducer always succeeds | — |

### server_link_provider

**Purpose:** Link a provider (Discord) to a User; upgrade guest to verified; create UserPrivate record

**Permission:** Server identity only (requireServer)

**Parameters:** `callerIdentityHex`, `provider` ('discord'), `providerId`, `providerName`

**Flow:**
1. Resolve UserIdentity from callerIdentityHex
2. `rejectIfBanned(ctx, 'DiscordId', providerId)` — D-08 enforcement point 1
3. Case 1a: Guest user → update User (isGuest=false, hasDiscordLinked=true, username=providerName)
4. Case 1b: Verified user with different identity → redirect existing user to this identity
5. Case 1c: Upgrade existing mapping
6. Upsert UserPrivate with discordId + discordUsername

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Provider is banned | "Discord ID \<id\> is banned" |
| Identity not registered | "Identity not registered. Call login_as_guest first" |

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
| Caller is not Admin | Unauthorized |
| Duplicate ban exists | "A ban for this provider ID already exists" |

### admin_unban_user

**Purpose:** Remove a ban by BanRecord ID (permanent ban model — D-07)

**Permission:** Admin only

**Parameters:** `banRecordId` (u32)

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| BanRecord not found | "BanRecord \<id\> not found" |
| Caller is not Admin | Unauthorized |

## Acceptance Scenarios

### Guest Login (First Time)
**Given:** No UserIdentity exists for the caller's SpacetimeDB identity
**When:** `login_as_guest` is called
**Then:** User row inserted with `isGuest=true`, `role=User`, `username=Guest_{hex8}`, `avatarCharacterName='march7th'`, `hasDiscordLinked=false`. UserIdentity row inserted linking identity to user.

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
**Then:** User row updated: `isGuest=false`, `hasDiscordLinked=true`, `username=providerName`. UserPrivate row inserted with `discordId`, `discordUsername`.

### Ban Enforcement at Link-Time — Phase 12
**Given:** A BanRecord exists for a Discord ID
**When:** `server_link_provider` called with the banned Discord ID
**Then:** Reducer throws with "Discord ID \<id\> is banned". No UserPrivate written. User unchanged.

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
**Then:** Step A auto-creates guest via `loginAsGuest`. Step B calls `/api/auth/link-discord` → `server_link_provider` upgrades guest to verified user. NavBar shows Discord username.

### Logout and Re-Login via Discord (identity merge) — Phase 12 execution
**Given:** User "nathyron" (id=2) exists with Discord linked. User logs out (clears localStorage). New SpacetimeDB identity is generated.
**When:** User clicks "Login with Discord", completes OAuth
**Then:** Step A creates a temporary guest (id=3). Strategy 3 finds "nathyron" by session username. Step B calls link API. `server_link_provider` Case 1b: re-points new identity to user id=2, deletes orphaned guest id=3. NavBar shows "nathyron". Both old and new identities map to user id=2 in UserIdentity.

### Cross-Browser Discord Login (identity merge) — Phase 12 execution
**Given:** User "nathyron" exists on browser A. User opens browser B (new SpacetimeDB identity).
**When:** User clicks "Login with Discord" on browser B
**Then:** Same merge flow as logout/re-login. New identity mapped to existing user. Orphaned guest deleted.

### Stale NextAuth Session Does Not Auto-Link — Phase 12 execution
**Given:** User has a stale NextAuth session cookie (from previous Discord login). User clicks "Login as Guest".
**When:** Guest is created, `nextAuthStatus` is "authenticated"
**Then:** Discord linking does NOT auto-trigger. `hasDiscordIntent` is false (no explicit "Login with Discord" click). User stays as guest.

## Edge Cases

| Case | Expected Behavior | Notes |
|------|-------------------|-------|
| Identity hex collision in guest username | Extremely unlikely (8 hex chars = 4 billion combinations) | If it happened, autoInc id makes User rows unique regardless |
| Rapid connect/disconnect | Each lifecycle hook is its own transaction — no race condition | SpacetimeDB serializes reducer calls |
| Guest calls privileged reducer | `ensureVerifiedUser` rejects with error | Per-reducer guard, not auth-level |
| Banned user tries to link again | `rejectIfBanned` blocks at link-time | BanRecord + hasDiscordLinked=false prevents re-entry |
| Stale cached userId after DB clear | Strategy 1 miss → clears cache → falls through to Strategy 2/3 | Self-healing: no manual localStorage clear needed |
| Multiple identities for same user | All map to same User.id in UserIdentity | Accumulate over logouts/new browsers; GC implemented in Phase 12.1 (see [smoke/contract.md](../smoke/contract.md#identity-garbage-collection-phase-121)) |
| `getServerSession` returns null in POST handler | Direct cookie read + JWT decode bypasses next-auth pipeline | Known next-auth 4.x bug in App Router POST routes |
| Client/server database name mismatch | Server imports from shared `lib/spacetimedb.ts` | Single source of truth prevents silent WebSocket failures |
| DiscordLink component bypasses intent flag | Uses `loginDiscord()` from auth context (not direct `signIn`) | Ensures `hasDiscordIntent` is set for Step B |

## Integration Points

| This Feature | Connects To | How | Direction |
|-------------|------------|-----|-----------|
| `User.id` | All features | FK from virtually every table | reads |
| `UserIdentity.identity` | `getAuthenticatedUser` helper | ctx.sender → User resolution | reads |
| `UserPrivate.discordId` | `checkProviderBan` helper | Ban enforcement at link/reconnect | reads |
| `clientDisconnected` | Lobby disconnect handling | Triggers disconnect policy | writes |
| `User.isOnline` | Lobby browser, cursor tracking | Online presence indicator | reads |
| `User.hasDiscordLinked` | Frontend components | Link status display (replaces discordId) | reads |

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
| server_link_provider replaces server_link_discord (unified provider linking) | Phase 12 discussion | 2026-04-08 |
| hasDiscordLinked bool replaces discordId on public User table (D-02) | Phase 12 execution | 2026-04-08 |
| Ephemeral connection for identity verification in API route (D-09, SEC-04) | Phase 12 execution | 2026-04-08 |
| view_my_profile merges User + UserPrivate for caller's own data | Phase 12 execution | 2026-04-08 |
| view_admin_user_private for Moderator+ access to UserPrivate data | Phase 12 execution | 2026-04-08 |
| view_user_directory projects to UserDirectoryRow safe subset (D-16) | Phase 12 execution | 2026-04-08 |
| D-08 three-point ban enforcement: link-time + reconnect + ban-time | Phase 12 execution | 2026-04-08 |
| ViewMyProfile not generated by spacetime generate (views not in codegen) — useAuth.ts uses User table fallback (Strategy B) | Phase 12 execution | 2026-04-08 |
| getServerSession replaced with direct cookie read + JWT decode (next-auth 4.x App Router POST bug) | Phase 12 execution | 2026-04-08 |
| spacetimedb-server.ts imports HOST/DB_NAME from shared lib/spacetimedb.ts (prevents database name mismatch) | Phase 12 execution | 2026-04-08 |
| Reactive User table callbacks (onInsert/onUpdate) replace setTimeout-based profile re-reads | Phase 12 execution | 2026-04-08 |
| Strategy 3 (NextAuth session username lookup) handles post-merge identity recovery | Phase 12 execution | 2026-04-08 |
| hasDiscordIntent gates Discord linking — stale NextAuth sessions don't auto-link | Phase 12 execution | 2026-04-08 |
| DiscordLink.tsx uses loginDiscord() instead of direct signIn("discord") | Phase 12 execution | 2026-04-08 |
| server_link_provider Case 1b: identity merge (re-point identity, delete orphaned guest) verified across all 4 auth paths | Phase 12 execution | 2026-04-08 |
| Phase 12.1 implemented: Identity GC with 90-day TTL, guards (guests, online, preserve-newest, orphans), GcResult audit — see [smoke/contract.md](../smoke/contract.md#identity-garbage-collection-phase-121) | Phase 12.1 execution | 2026-04-08 |
| Full hydration from codebase | Phase 13 normalization | 2026-04-09 |
| User deletion cascade branches on `isGuest && !hasHistoryReferences` — only clean guests hard-delete, all other cases archive to `DeletedUser` (D-09); `admin_ban_user` + `clientConnected` ban-on-reconnect now insert `UserDeletionJob` (D-10 R1 fix); `resolveUserLabel` helper resolves displayName across live/archive/synthetic fallback (D-12); `server_nuke_test_data` also clears `deleted_user` (D-11); `User.isPrivate` column removed (D-02 dead code) | Phase 15.2 execution | 2026-04-15 |
| UAT verify-work (Test 6) surfaced doc wording oversimplification — "guest fast-path / non-guest eviction only" framing is incorrect. Actual rule: hard-delete only when `isGuest=true` AND `hasHistoryReferences=false`; a guest that has played a match will be archived, not hard-deleted. Scenario block above corrected | Phase 15.2 execution | 2026-04-16 |
| `useAuth.ts` subscription split into Stage 1 (always-on `view_my_profile`) + Stage 2 (gated `SELECT * FROM user`) — closes the Phase 15.2 UAT Test 4 bandwidth leak. Behavior contract: anonymous visitors (no resolved User, no `spacetimedb_user_id` in localStorage, no `stdb_session` cookie) MUST receive zero rows in the User table cache; Stage 2 fires only when the gate condition `currentUser != null \|\| hadUserIdOnMount.current \|\| hadSessionCookie.current` is true AND the WS handshake has succeeded (`isActive` true). Stale token / cookie cannot open Stage 2 because the handshake fails first (defense-in-depth, T-15.5-03 mitigation) | Phase 15.5 execution | 2026-04-16 |
| `guestLoginPending` UX state drives the inline Login-button spinner ("Signing in…"). Behavior contract: spinner SHOWS only while `loginAsGuest` reducer promise is unresolved AND `currentUser` is null; clears on either successful `currentUser` resolution or reducer rejection (`useAuth.ts:427-431` `.catch` handler). Spinner MUST NOT activate during returning-user reconnect (Stage 2 opens via `userId`/`cookie` signal, not via `loginGuest` callback), Discord login click (Discord flow's internal `loginAsGuest` bypasses the wrapper), or initial WS connect. Spinner state has zero auth significance (T-15.5-02 cosmetic-only) — DevTools manipulation cannot elevate privilege | Phase 15.5 execution | 2026-04-16 |
| `view_user_directory` retired — was a dead-code projection with zero client subscribers; the cosmetic Phase 15.2 D-06 `view`/`anonymousView` flip turned out to be a no-op at the framework level. Removing the view + bindings reduces module-publish surface and prevents future devs from re-introducing it as a "safe anonymous bookmark" without a concrete use case (YAGNI). Behavior contract change: any code or doc referencing `view_user_directory` is now incorrect — clients must subscribe to `SELECT * FROM user` (post-auth, via Stage 2) for User directory data | Phase 15.5 execution | 2026-04-16 |
| `view_public_accounts` renamed to `view_public_hsr_accounts` — keeps the `public` prefix marking anonymous intent and adds `hsr_` to make the projected source table (`HsrAccount`) explicit in the name. Behavior contract: anonymous subscription to `view_public_hsr_accounts` continues to return rows where `isRosterPublic=true`, with rating field projected only when `isRatingPublic=true`. The view's `anonymousView` registration and projection body are unchanged from the Phase 10.4 implementation — this is a pure identifier rename with provenance documented in `docs/views/architecture.md` and `docs/auth/architecture.md` Subscription Lifecycle / Intentional Anonymous Exceptions | Phase 15.5 execution | 2026-04-16 |
| Subscription Lifecycle pattern codified in `docs/auth/architecture.md` (Phase 15.5 D-05). Names two intentional anonymous-view exceptions (`view_lobby_browser`, `view_public_hsr_accounts`) where the projection body IS the privacy gate; states the rule for any future subscription work; documents the accepted tradeoff that `User.public=true` means adversarial direct subscriptions remain possible (deferred per 15.2 D-01) | Phase 15.5 execution | 2026-04-16 |
| Phase 15.5 verify-work harmonized doc wording — `hadTokenOnMount` references in `docs/auth/architecture.md` Subscription Lifecycle aligned with the shipped `hadUserIdOnMount` identifier (Plan 02 D-01 deviation `790a39c`); rationale + `useAuth.ts:116` first-guard reference added to the Stage 2 description. Test surface: `test/backend/auth/auth-subscriptions.test.ts` (anonymous + authenticated paths) is the regression guard | Phase 15.5 verify-work | 2026-04-17 |
| Phase 16 subscription reshuffle behavior contract: Stage 1 (`view_my_profile`) moves to `components/features/auth/components/AuthProvider.tsx` (always-on); Stage 2 (`SELECT * FROM user`) moves to `app/(authed)/layout.tsx` (route-group mount IS the gate). Route-group rename: `(authenticated)` → `(authed)`, `(landing-page)` → `(public)`, `(game)/draft` collapsed into `(authed)/(match)/draft`. Anonymous visitors receive zero User rows because the authed layout never mounts for them (middleware is UX-only redirect, not an auth trust boundary) | Phase 16 execution | 2026-04-18 |
| Phase 16 useAuth performance pass: collapsed redundant auth-context reads and memoized the `useAuth()` return object so callers re-render only when their used subset changes. Public auth API unchanged (`currentUser`, `isActive`, `profileReady`, `nextAuthStatus`, `hasUser`, etc.) — this is a pure memoization refactor, no behavior change | Phase 16 execution | 2026-04-19 |
| Phase 16 UAT findings (CSP, SW, image handling) — `next.config.ts` CSP `script-src` requires `'unsafe-eval'` in both dev AND prod because the SpacetimeDB SDK uses `Function()` constructor at runtime for BSATN codec generation; dropping it at build-time breaks auth (and all reducer calls) in CSP-enforcing browsers. `next.config.ts` `connect-src` requires `https://*.ufs.sh` so the Service Worker can re-issue allowlisted CDN fetches without CSP rejection. Neither finding changes the auth API surface — both are infrastructure prerequisites for auth + SDK to work in prod | Phase 16 verify-work | 2026-04-19 |
