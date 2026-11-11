# Auth & Users -- Architecture

Last updated: 2026-11-11

## Overview

Authentication is built on SpacetimeDB identities with optional Discord OAuth linking. Every client gets a SpacetimeDB identity on first connection. `login_as_guest` creates a User row and UserIdentity mapping. A trusted server identity (the auth function, M5) calls `server_link_provider` to upgrade guests to verified accounts after Discord OAuth completes. Since Phase S11a (A77) the `User` table is private and holds the provider link (formerly `UserPrivate`); no client subscribes it. The user reads their own row through `view_my_profile`, staff read users through `view_admin_users` and `view_admin_user_private`, and every other page gets names and avatars denormalized into the views that need them (PAGE-MAP D2).

Ban enforcement runs at three points: at link-time, at reconnect, and when a ban is created.

## Server Identity: Owner and Delegates (Phase M2)

`ServerIdentity` (private) holds every identity allowed to call the `server_*` reducers:

- **Owner**: the database publisher, inserted by `init` on the first publish (and on every `--delete-data` republish) together with the SYSTEM user. Only the owner may call `server_register_delegate` / `server_revoke_delegate`.
- **Delegate**: an identity the owner registered (label `vercel-auth-<target>`). `scripts/stdb/bootstrap.ts` mints it and writes its token as `STDB_SERVER_TOKEN` to `.env.<target>.local`; the same value goes into the Vercel function secrets (M5). Each delegate is linked to the SYSTEM user through `UserIdentity`, so `ensureAdmin` passes for seeding.

`server_link_provider`, `server_set_role` and `server_delete_user` accept **any** registered server identity (`requireServer`: Owner or Delegate). Nothing in the module accepts an unregistered caller; there is no first-come registration. A leaked delegate token is revoked with `server_revoke_delegate` (or by re-running bootstrap, which revokes the previous delegate) without a wipe.

## Table Relationships

```
User (id: u32 autoInc PK)  [PRIVATE -- public: false since Phase S11a, A77]
  +-- username: string (unique)
  +-- displayName: string
  +-- isGuest: bool
  +-- (isOnline / lastLoginAt moved to UserPresence in S3, A48; see below)
  +-- role: Role (User | TournamentHost | Moderator | Admin)
  +-- avatarCharacterName: string -> HsrCharacter.name
  +-- displayedAchievementId: u32? -> Achievement.id
  +-- deletedAt: Timestamp? (transient pending-deletion flag — at most ~1 row set during 5s cascade window)
  +-- loginMethod: string? / providerId: string? / providerUsername: string? (A46 claim shape; unset for a guest)
  +-- linkedAt: Timestamp? (when the current provider account was linked)
  +-- audit columns
  Indexes: id (PK), username (unique), provider_id (btree, providerId),
           by_method_and_provider (btree, [loginMethod, providerId])
  (S11a, A77: hasDiscordLinked dropped, derived as loginMethod = 'discord' in view_my_profile / view_admin_users;
   the four provider columns and the two indexes merged from UserPrivate, which is removed)

DeletedUser (id: u32 PK)  [PRIVATE -- public: false]
  +-- id: u32 (same as was User.id — preserves FK semantics for history tables)
  +-- displayName: string (preserved from User.displayName at eviction time)
  +-- isGuest: bool
  +-- deletedAt: Timestamp
  No audit columns (write-once archive; no update path).
  No btree indexes (resolveUserLabel uses PK lookup only).
  Writer: performUserDeletion non-guest-with-history branch only.
  Reader: resolveUserLabel helper (see §resolveUserLabel below).

UserIdentity (identity: Identity PK)  [PRIVATE -- public: false]
  +-- identity -> SpacetimeDB sender identity (hex)
  +-- userId -> User.id
  +-- lastSeenAt: Timestamp
  Indexes: identity (PK), user_id (btree, userId)

UserPresence (identity: Identity PK)  [PRIVATE -- public: false]  (S3 table; behaviour from Phase S4 execution; A48, D-A1)
  +-- identity -> the connected SpacetimeDB identity (one row per device)
  +-- userId -> User.id  [btree: user_id]
  +-- isOnline: bool / lastLoginAt: Timestamp / lastSeenAt: Timestamp
  +-- audit columns
  "User online" = any row of the user with isOnline=true. Writers: client_connected (upsert online),
  login_as_guest (fresh guest), server_link_provider case 1b (userId re-pointed), client_disconnected
  (isOnline=false, lastSeenAt), run_identity_gc and performUserDeletion (delete with the identity),
  server_set_online (test only, forces every row of the user). Reader: view_admin_presence (S9).
  Staleness rule (S3 review L3): a live row whose disconnect was missed is corrected only by that identity's
  next connect/disconnect, by identity GC when it removes the identity, or by server_set_online. There is no
  heartbeat (energy, A16); until one of those runs the user reads as online on that device and the A22a
  check does not fire.

BanRecord (id: u32 autoInc PK)  [PRIVATE -- public: false]
  +-- banType: BanType (DiscordId)
  +-- providerId: string (Discord snowflake)
  +-- reason: string
  +-- bannedByUserId -> User.id
  +-- audit columns
  Indexes: ban_record_provider_id (btree, providerId)
```

## Reducer Flows

### login_as_guest()
1. Check `UserIdentity.identity.find(ctx.sender)` for existing mapping
2. If found: update `UserIdentity.lastSeenAt` -- return (presence was written by `client_connected`; Phase S4 execution)
3. If not found (or the mapping's `User` row is gone): A95(2) (Phase S10h execution) `recordGuestCreation(ctx)`: rejected with "New guest accounts are temporarily disabled. Please try again later." while `AbuseConfig.guestCreationEnabled` is off; otherwise counted in `AbuseCounter['guest_create']`, and the creation that crosses `guestCreationBurstThreshold` (default 300 in 10 minutes since A109; 100 under A95(2)) trips the switch with one `AdminAlert` (`docs/admin/architecture.md`). Phase S10i execution (A109): besides an Admin (`admin_set_guest_creation`) a server identity can turn the switch back on with `server_set_guest_creation(true)` (`docs/admin/architecture.md`), so a locked-out Admin is not needed. Step 2 never reaches it, so a returning guest always logs back in. Then generate `guestUsername = uniqueUsername("Guest_" + the last 8 hex characters of the identity)` (Phase S10h execution, `helpers/identity/usernames.ts`: an identity's hex starts with the fixed tag `c200` and a 4-byte checksum, so its first 8 characters carry only 16 varying bits and collided on the unique `User.username`; the trailing characters come from the BLAKE3 hash; a taken name falls back to the first free `_2`, `_3`, ... variant, so a guest login never aborts on the index)
4. Insert `User` row (isGuest=true, role=User, avatarCharacterName='march7th')
5. Insert `UserIdentity` row linking `ctx.sender -> newUser.id`; identity audit #10 (S10h): an orphan mapping (its `User` row is gone) is updated to the new user instead, so the call no longer aborts on the primary key
6. A48 (Phase S4 execution): upsert `UserPresence { identity: ctx.sender, userId, isOnline: true, lastLoginAt, lastSeenAt }` -- the guest's connect ran before the mapping existed, so `client_connected` could not write it

### server_link_provider(identity, discordId, discordUsername, email?) -- server-only
1. `requireServer(ctx)` -- caller must have a ServerIdentity row (Owner or Delegate)
2. `rejectIfBanned(ctx, discordId)` -- check BanRecord via `ban_record_provider_id` index (D-08 point 1)
3. Look up `UserIdentity` by provided identity
4. Three merge cases:
   - **Case 1a**: Identity -> guest, no existing provider owner -- upgrade guest: `isGuest=false`, provider columns set (`linkedAt = now`), username=providerName
   - **Case 1b**: Identity -> guest, provider already linked to different user -- re-point identity to existing user, delete orphaned guest. Phase S4 execution (A48, S3 review M3): the identity's `UserPresence.userId` + `lastLoginAt` follow the re-point before `performUserDeletion` removes the guest's own presence rows. Phase S10l execution (A112): when the guest is about to be deleted (no other identity of the guest remains), `moveTournamentTiesToUser(ctx, guestId, existingUserId, SYSTEM_USER_ID)` (`helpers/tournament/entryTransfer.ts`) runs first and moves the guest's entries in unfinished tournaments to the existing user; the existing user must meet the tournament's gates as they stand at sign-in (enrolment, membership, `minimumMmr` by the `ensureMinimumMmr` rating test, `requireRoster`), the guest's recorded captaincies follow even without a membership, and the existing user's stand-in approvals for matches their new team plays are deleted; the full rules (move / do-not-move conditions, locks) are in [tournament/architecture.md](../tournament/architecture.md) "Phase S10l execution". What it does not move is settled by `performUserDeletion` as before (A94(2)). Phase S10m execution (A113(4)): on that deletion path, see "Phase S10m execution" below, the link is refused before any change while the guest plays a live game
   - **Case 1c**: Identity -> verified user, refresh -- update timestamps and the provider name; `linkedAt` kept when the login method and provider id are unchanged, set to now when they change
5. Phase S11a (A77): the provider columns are written on the `User` row (`loginMethod`, `providerId`, `providerUsername`, `linkedAt`); the provider owner of step 4 is found through `User.provider_id`

Phase S10e execution (identity audit #3): the actual arguments are `(callerIdentityHex, provider, providerId, providerName)`. `providerName` is trimmed and cut to 32 characters (the username length; empty after trim: "providerName is required"); the trimmed name is stored as `displayName` and `providerUsername`. Case 1a takes it as the username through `uniqueUsername`: the name itself when no other user holds it, else the first free `name_2`, `name_3`, ... (the base shortened to stay within 32), so a username taken by another account no longer aborts the link on the unique index. `callerIdentityHex` goes through the file's `parseIdentityHex` (same texts as before); Cases 2 and 3 share one terminal "Identity not registered. Call login_as_guest first."

### clientConnected() -- lifecycle hook (exported as `client_connected`)
> Both lifecycle hooks register only because `index.ts` exports them. Before 2026-11-05 they were bare `spacetimedb.clientConnected(...)` calls, which the SDK silently drops, so neither hook ever ran on a published database. Behavior below is the spec; it takes effect on the first publish that includes the fix.

1. B-8 (Phase S4 execution, ACCESS-SECURITY-OPS §B.5): if `AbuseConfig` row 1 has `maintenanceMode=true` and `ctx.sender` has no `ServerIdentity` row, `throw` -- the socket is rejected. `AbuseConfig` is seeded in S5; until then this check is inert.
2. Find `UserIdentity.identity.find(ctx.sender)`; return if none (a fresh guest: see `login_as_guest`)
3. A48 (Phase S4 execution): upsert `UserPresence` for this identity (`userId`, `isOnline=true`, `lastLoginAt=now`, `lastSeenAt=now`); update `UserIdentity.lastSeenAt`
4. F1 (Phase S4 execution): for every `LobbyMember` of the user: delete pending `RefereeTransferCheck` rows (`by_lobby_and_user`); if the row is offline, delete+reinsert with `isOnline=true`, `disconnectedAt` cleared and `disconnectPoolRemainingMs` decremented by the offline time (`handleDisconnectPoolUpdate`). Idempotent.
5. D-08 point 2: if the user's `loginMethod/providerId` (on `User` since S11a, A77) is banned -> soft-delete user immediately
6. Phase 15.2 D-10: insert `UserDeletionJob` (scheduled 5s out) after ban-reconnect soft-delete (R1 fix)

### clientDisconnected() -- lifecycle hook (exported as `client_disconnected`)
1. Find `UserIdentity.identity.find(ctx.sender)`; return if none
2. A48 (Phase S4 execution): set this identity's `UserPresence.isOnline=false`, `lastSeenAt=now`
3. If the user still has another live `UserPresence` row: stop -- the other device keeps every membership online
4. A22a (Phase S4 execution, ACCESS-SECURITY-OPS D.8.2): for every `LobbyMember` of the user: `isOnline=false`; in an active stage (Drafting, Equipping, Scoring, BetweenGames, Shelved) insert `RefereeTransferCheck { lobbyId, userId, scheduledAt: now + 15 s }` (a stale pending row for the pair is replaced); `disconnectedAt=now` only in Drafting, Equipping, Scoring (the D-08 forfeit clock; never in BetweenGames or Shelved, never under NoAction). Nothing else: no flag transfer, no pause

### run_referee_transfer_check(arg: RefereeTransferCheck) -- scheduled (Phase S4 execution, A22a)
Fires 15 s after the user's last disconnect; no-op when the lobby or the member is gone. "Still offline" = `LobbyMember.isOnline=false` and no live `UserPresence` row. Moves the referee flag in the A22(5) order, runs the captain/host transfers, and auto-pauses the draft for an offline team player. Full rules: `docs/lobby/architecture.md` (Flag-transfer priority) and `shared/lobby-rules/refereeTransfer.ts`.

### run_identity_gc / performUserDeletion -- presence cascade (Phase S4 execution, A48)
Identity GC deletes the `UserPresence` row together with each identity it removes (orphaned or stale) and treats "online" as any live row of the user. `performUserDeletion` deletes every `UserPresence` row of the user before the `UserIdentity` rows.

Phase S10e execution (identity audit #1): `performIdentityGc` never collects an identity that has a `ServerIdentity` row or maps to the SYSTEM user (found by username 'SYSTEM'): those mappings are filtered out before the orphan, guest, online and newest-identity rules run. Identity audit #5: `server_revoke_delegate` and `admin_delete_row('UserIdentity')` delete the identity's `UserPresence` row with the mapping (details in `docs/admin/architecture.md`). Lobby audit #12, as revised by the S10e fix pass (review F3): a live-stage player row abandoned by `performUserDeletion` keeps its `LobbyMemberAccount` rows, as before S10e (the roster guards ignore abandoned rows, `docs/lobby/architecture.md`). Fix pass (review F5, N9): `admin_delete_row('UserIdentity')` refuses a `ServerIdentity` identity and a SYSTEM mapping, and, when the user has no live presence left afterwards, takes the user's online memberships offline as `client_disconnected` does (`markMemberOffline`).

A95(1) guest retention (Phase S10h execution): the weekly identity clean-up (`performIdentityGc`, `reducers/identity/identityGc.ts`; also `admin_gc_identities`) still never collects a guest's identities one by one (D-06), but deletes a **guest user** through `performUserDeletion` (actor SYSTEM for the scheduled run, the Moderator for the admin run) when `guestPastRetention` holds, every check an index read: the user is not scheduled for deletion (`deletedAt` unset); no live `UserPresence` row (`user_id`); for every identity of the user, the later of `UserIdentity.lastSeenAt` and that identity's `UserPresence.lastSeenAt` (identity PK) is 30 days or older (`GUEST_IDLE_DAYS`); no `LobbyMember` row in any lobby or stage (`user_id`); no `TournamentEnrolled` row (`user_id`) in a tournament that is not Completed or Cancelled (`Tournament.id`); no match history: no `MatchParticipantHistory` row (`by_user`, archived matches) and nothing `hasHistoryReferences` (`helpers/identity/userDeletionHelper.ts`) finds, one index probe each: `MatchResultParticipant` (live and pending records), `MmrHistory`, `PlayerStat`, `PlayerCharacterStat`, `PlayerRelationship`, `Leaderboard`, `TournamentEnrolled` (any stage, so a finished tournament's enrolment keeps the guest too), `UserAchievement` (S10h review F1: a casual concede or forfeit archives no participant row but writes `PlayerStat`, so stat rows count as match history). At most 500 guest users per run (`GUEST_DELETIONS_PER_RUN`); the scan visits every identity each run, so the rest are found again by the next run; no cursor. A scheduled run that reached the cap requeues its next run one hour out (`GC_BACKLOG_INTERVAL_MICROS`, review F4) instead of seven days, so a backlog drains in hourly runs; a run under the cap keeps the weekly interval. Each run queues exactly one next job; the admin run queues one only when `IdentityGcJob` holds no row (S11a, triage L6: it restarts a stopped chain, 7 days out). Each deletion counts in `itemsDeleted`; the `GcResult.details` JSON gains `guests`. A guest with no identity row left is not reached (the scan starts from `UserIdentity`).

### admin_ban_user(banTypeTag, providerId, reason)
1. `ensureAdmin(ctx)` -- requires Admin role
2. Validate inputs; check for existing ban (single-column index + in-memory filter)
3. Insert `BanRecord`
4. Find user via `User.provider_id.filter(providerId)` (same login method; S11a, A77), soft-delete if found (D-08 point 3)
5. Phase 15.2 D-10: insert `UserDeletionJob` (scheduled 5s out) to complete the two-phase delete (R1 fix)

### admin_unban_user(banRecordId)
1. `ensureAdmin(ctx)` -- requires Admin role
2. Find `BanRecord` by id -- reject if not found
3. Hard-delete the `BanRecord` row

## View Definitions

| View | Scope | Returns |
|------|-------|---------|
| `view_my_profile` | ctx.sender only | The caller's User row incl. the provider fields (MyProfileRow; an array of at most one row, PK `id`, since Phase S9b execution; row shape kept by A77) |
| `view_my_identity` | ctx.sender only | Caller's identity mapping: `{ identity, userId }` (Phase S9b execution) |
| `view_admin_user_private` | Moderator+ only | One row per linked user: userId, loginMethod, providerId, providerUsername (Phase S9b execution: staff-only full read after the role check, no audit columns; since S11a read from `User`, A77) |
| `view_admin_users` | Moderator+ only | Every User row without the provider columns: id (PK), username, displayName, isGuest, role, hasDiscordLinked (derived), avatarCharacterName, displayedAchievementId?, deletedAt?, the four audit columns (Phase S11a execution, A77(1)) |
| `view_user_by_username(username)` | anonymous arg view | At most one `User` projection for the exact username (Phase S9b execution, PAGE-MAP D7) |
| `view_public_hsr_accounts` | Anonymous (projection-based privacy) | HsrAccount rows where `isRosterPublic=true`; rating included when `isRatingPublic=true`. Flat rows (one per character). Renamed from `view_public_accounts` in Phase 15.5 (D-04) — `hsr_` names the source table explicitly. Stays `anonymousView` per Phase 15.5 D-05 (projection body is the privacy gate, not subscription timing). |

### MyProfileRow fields (view_my_profile)
Phase S9b execution (S3 hand-off, PAGE-MAP profile, A46, A48):
```
id (PK), username, displayName, avatarCharacterName, displayedAchievementId?,
hasDiscordLinked, isGuest, role,
loginMethod?, providerId?, providerUsername?
```
Presence lives on `UserPresence` (A48, staff-only through `view_admin_presence`); `email`, `discordId`,
`discordUsername` left the schema in S3 (A46, D-B4); `deletedAt` and the audit columns are not projected.
Note: `isPrivate` removed from schema (Phase 15.2 D-02 -- dead code, never gated).

## performUserDeletion Flow (Phase 15.2 D-09)

`performUserDeletion(ctx, userId, actorId)` is the single entry point for cascade deletion, called by the `UserDeletionJob` scheduled reducer.

```
performUserDeletion
  ├─ S10s (A121 / A124): handOverOrganizedTournaments, first: a staff deletion or ban hands each unfinished tournament
  │   the user organizes to the longest-serving full assistant, else the acting Moderator+; a server deletion
  │   (opts.serverDeletion) cancels them instead (cancelOrganizedTournaments). See "Phase S10s execution"
  ├─ A94(2) (S10g): settleTournamentTiesForDeletion (helpers/tournament/disqualification.ts), first: per tournament
  │   that is not Completed / Cancelled where the user holds a non-Disqualified enrolment, removeEnrolment (the
  │   withdraw_from_tournament path) while bracketGeneratedAt is unset, disqualifyParticipant (the dq_participant path:
  │   team, captaincy, bracket settlement, lobby voiding / force-concede) once it is set; then every TournamentTeamRequest,
  │   TournamentAssistant, TournamentStandIn, TournamentPlayerAccount and TournamentWaitlistAccount row of the user.
  │   Audit actor = the actorId passed in (the user, an admin, or SYSTEM_USER_ID). See docs/tournament/architecture.md.
  ├─ A68(6)(7) (S8f fix pass 2): per LobbyMember row of the user: Waiting / AwaitingResult, spectator / coach,
  │   or lobby gone → removeMemberRow (as a leave); a player row in Drafting / Equipping / Scoring → flags
  │   transferred, row kept as away + abandoned (offline for the forfeit test, never a flag candidate).
  │   See docs/lobby/architecture.md "User deletion".
  ├─ Cascade: hard-delete calendar data, UserIdentity rows, HsrAccount + characters (the provider link goes with the User row, S11a)
  ├─ S10r (A122(6)): the user's unreferenced lobby presets and unpublished cost sets (deleteOwnedPresetsAndCostSets)
  │
  ├─ [isGuest && !hasHistoryReferences(ctx, userId)]
  │     → hard-delete User row (fast path, no archive)
  │
  └─ [non-guest OR has history references]
        → insert DeletedUser { id, displayName, isGuest, deletedAt }
        → hard-delete User row
        (Ghost accumulation eliminated — User table contains only live users)
```

**Two-phase soft-delete pattern (uniform across all three writers, Phase 15.2 D-10):**

| Writer | File | Step 1 | Step 2 |
|--------|------|--------|--------|
| `admin_delete_row` | `admin.ts` | Set `User.deletedAt` | Insert `UserDeletionJob` (5s) |
| `admin_ban_user` | `banAdmin.ts` | Set `User.deletedAt` | Insert `UserDeletionJob` (5s) ← D-10 R1 fix |
| `clientConnected` ban-on-reconnect | `index.ts` | Set `User.deletedAt` | Insert `UserDeletionJob` (5s) ← D-10 R1 fix |

**delete_my_account organizer guard (A94(1), Phase S10g execution).** Before either branch, the caller is rejected when
they organize a tournament that is not Completed or Cancelled (`Tournament.organizer_id` index): "You organize a
tournament that has not finished. Cancel it, or wait until it ends, before deleting your account." The verified
branch keeps its lobby guard only ("Leave your lobby before deleting your account.", `membershipHold` not free); its
old enrolment guard ("You are enrolled in a tournament that has not finished. Withdraw first, or wait until it ends.")
is removed (S10g review F1, A94(2)): a live enrolment is settled by `performUserDeletion` (withdrawn before the
bracket exists, disqualified once it exists), the same as for a guest. Admin, ban and server deletions have no organizer guard (A94 does not
decide one): the tournament keeps its `organizerId`, and Moderator+ still hold every owner permission.

Prior to Phase 15.2, `admin_ban_user` and `clientConnected` set `deletedAt` but never scheduled the cascade job — the `UserDeletionJob.insert` was missing at both sites (R1 latent bug).

## resolveUserLabel Helper (Phase 15.2 D-12)

`resolveUserLabel(ctx, userId) → { displayName: string; isDeleted: boolean }`

Three-path lookup for display names at history render sites where the referenced user may have been evicted:

1. `ctx.db.User.id.find(userId)` → live user → `{ displayName: user.displayName, isDeleted: false }`
2. `ctx.db.DeletedUser.id.find(userId)` → archived user → `{ displayName: archive.displayName, isDeleted: true }`
3. Fallback → `{ displayName: \`User #${userId}\`, isDeleted: true }`

**Location:** `spacetimedb/src/helpers/identity/userLabel.ts`

**Call sites (5):** `lobbyViews.ts:view_my_lobby_members`, `finalizationHelpers.ts:actorDisplayName`, `finalizationHelpers.ts:participantDisplayName`, `lobbyLifecycle.ts:kick_member`, `lobbyLifecycle.ts:ban_member`.

Do NOT use at sites where the user is the caller (`ctx.sender` is always live by construction).

## API Route: /api/auth/link-discord (D-09, D-10)

The Next.js API route performs ephemeral identity verification before calling `server_link_provider`:

1. Read NextAuth session JWT directly from cookies (bypasses `getServerSession` -- known next-auth 4.x bug in App Router POST handlers)
2. Decode JWT via `next-auth/jwt decode()` with `NEXTAUTH_SECRET` -- extract `discordId` (token.sub), `discordUsername` (token.name)
3. Parse `spacetimeToken` from request body
4. Create ephemeral SpacetimeDB connection using client's token -- extract server-verified identity hex (WR-02: fail-fast on disconnect)
5. Call `server_link_provider` via trusted server connection with verified identity

Key details: supports chunked cookies; cookie name derived from `NEXTAUTH_URL` protocol (`__Secure-next-auth.session-token` for https, `next-auth.session-token` for http).

## Ban Enforcement (D-08: Three-Point Enforcement)

| Point | Where | Trigger |
|-------|-------|---------|
| Point 1 (link-time) | `server_link_provider` | `rejectIfBanned` before any user mutation |
| Point 2 (reconnect) | `clientConnected` | Ban check on every reconnect; soft-delete if banned |
| Point 3 (ban-time) | `admin_ban_user` | Soft-deletes the currently linked user on ban creation |

## Frontend Auth Flow (useAuth.ts)

`readProfileFromConnection` resolves the current user via three strategies in order:

| Strategy | Lookup | When it wins |
|----------|--------|-------------|
| 1. Cached userId | `localStorage` -> `User.id.find()` | Returning user, same browser |
| 2. Guest username | `Guest_{identity_hex8}` -> `User.username.find()` (legacy; since S10h the module names a guest from the last 8 hex characters, with a `_n` suffix on a collision, so this strategy needs re-alignment when the auth page is ported in M3) | Just created guest |
| 3. Session name | `session.user.name` -> `User.username.find()` | Post-merge recovery |

Reactive callbacks: `conn.db.User.onInsert` and `conn.db.User.onUpdate` trigger re-reads, filtered by `event.tag` (`'Reducer'`, `'Transaction'`, skip `'SubscribeApplied'`).

`hasDiscordIntent` (sessionStorage flag, 5-minute TTL) gates Discord linking to prevent stale NextAuth sessions from auto-linking.

## Subscription Lifecycle (Phase 15.5 D-05, Phase 16 reshuffle)

SpacetimeDB offers two complementary privacy tools for client-facing data:

| Privacy Gate | Where It Runs | What It Closes |
|--------------|---------------|----------------|
| **Projection-based** (anonymous views) | Server — inside the view body | What a caller *sees* (field masking, row filtering by opt-in flags) |
| **Subscription-based** (client gating) | Client — inside the route-group render tree | When a subscription *fires* (anonymous visitors cause zero pre-auth egress on sensitive tables) |
| **Route-group mount** (structural gating) | Client — via `app/(authed)/layout.tsx` | Whether the subscribing effect even mounts (authed-only layout never renders for unauth'd visitors) |

These three gates layer. Projection-based privacy is authoritative for any data the user has opted to share anonymously. Subscription-based gating is how the client decides when to incur the bandwidth cost of a raw table subscription. Route-group mount is the structural gate Phase 16 introduced — some subscriptions don't need runtime ref bookkeeping because their owner component is only ever reachable after auth by construction.

### The Two-Stage Rule (post-Phase-16)

Phase 16 relocated the two subscribe effects from `useAuth.ts` (Phase 15.5's runtime-gated pattern) to their architectural owners. The Stage split is identical; the ownership differs.

- **Stage 1 — always on, owned by `components/features/auth/components/AuthProvider.tsx`:** `SELECT * FROM view_my_profile` subscribes as soon as the SpacetimeDB connection is active. The effect was moved out of `useAuth.ts:72-111` (Phase 15.5 location) into `AuthProvider` during Phase 16 Plan 02 (D-03). `AuthProvider` is already a child of `SpacetimeDBProvider` in `app/providers.tsx`, so the "providers.tsx owns view_my_profile" architectural intent is satisfied structurally without touching `providers.tsx` itself. The server still applies the `ctx.sender` filter — anonymous callers receive 0 rows, authenticated callers receive their single merged User + UserPrivate row. The `onInsert` / `onUpdate` callbacks on `view_my_profile` call `triggerReadProfile` (exposed on the useAuth context as `@internal`) so useAuth remains the single authoritative reader via `readProfileFromConnection`.

- **Stage 2 — gated by route-group mount, owned by `app/(authed)/layout.tsx`:** `SELECT * FROM user` subscribes only when `(authed)/layout.tsx` mounts. The effect was moved out of `useAuth.ts:115-181` (Phase 15.5 location) into the authed layout during Phase 16 Plan 02 (D-07). The route-group mount IS the new privacy gate: anonymous visitors never reach the authed layout (middleware redirects them — see "Middleware is UX-only" below — and more importantly, no authed-route render path terminates for an unauthenticated client). The 15.5 runtime ref-based `stage2Gate` check (`currentUser != null || hadUserIdOnMount.current || hadSessionCookie.current`) is retired; the structural mount IS the gate. `onInsert` / `onUpdate` callbacks on `User` call `triggerReadProfile` to refresh useAuth's resolved-user state on row changes.

`useAuth.ts` retains `readProfileFromConnection` (the 3-fallback reader), login / logout / Discord-link / guest-login / soft-delete state, `guestLoginPending` UX state, and the `hadSessionCookie` + `hadUserIdOnMount` refs (now driving only the `isWaitingForData` spinner — Phase 16 D-09). It lost ONLY the two subscribe effects (Phase 16 D-10). `setProfileReady` + `triggerReadProfile` are exposed on the useAuth return shape tagged `@internal` in JSDoc — consumers outside `AuthProvider` and `(authed)/layout.tsx` MUST NOT call them.

A truly anonymous visitor (no cached identity, no session cookie, no resolved User) causes zero egress on the User table. The bandwidth leak that Phase 15.2 UAT Test 4 exposed — unconditional `SELECT * FROM user` pre-auth — stays closed; Phase 16 reshuffles ownership without changing the behavior contract.

### Regression Guard

`test/backend/auth/auth-subscriptions.test.ts` (the Phase 15.5 D-12 harness) remains the canonical regression guard for the Stage 1 / Stage 2 contract. Phase 16 D-12 required it passes unmodified after the Plan 02 reshuffle — confirmed green 2/2 at Plan 02 landing commit and at every subsequent Phase 16 plan commit (Plans 03, 04, 05, 06).

### Middleware is UX-only, not an auth trust boundary

Phase 16 Plan 03 introduced `middleware.ts` with a positive-list matcher (`/profile`, `/admin-view`, `/lobby`, `/draft/:path*`) that redirects cookie-less visitors to `/`. This is UX optimization — a friendlier "please log in" nudge than letting an authed page render a logged-out shell. It is NOT an authorization gate. Real access control lives in SpacetimeDB reducer-level checks (`ensureVerifiedUser`, `ensureAdmin`) and view-level projection / anonymousView boundaries. Middleware is bypassable by any client with a stale cookie; SpacetimeDB RLS is not. See `REQUIREMENTS.md` §Out of Scope → "Middleware as auth trust boundary" for the explicit non-commitment.

### Intentional Anonymous Exceptions

Two views stay `anonymousView` by design. Their privacy gate is the projection body, not subscription timing:

- **`view_lobby_browser`** — filters out config details (timers, budgets, penalties, audit columns, hostId) and filters to active stages only. Anonymous BY DESIGN so visitors can browse lobbies pre-auth.
- **`view_public_hsr_accounts`** — filters to `isRosterPublic=true` rows; rating field only emitted when `isRatingPublic=true`. Anonymous BY DESIGN so pre-auth profile browsing works.

These do NOT need Stage 2 gating — applying it would regress intentional pre-auth UX.

### Rule for Future Subscriptions

Any new frontend subscription to a raw table (no projection view body) OR a per-user view MUST be owned by `(authed)/layout.tsx` or a deeper authed-route layout (e.g., `(authed)/(match)/layout.tsx` at Phase 28), not by `useAuth` or `AuthProvider`. The route-group-mount gate is the structural default; runtime ref-based gates are only justifiable for a subscription that must fire before an authed layout mounts (no current case). If a new anonymous projection view is added whose body performs the privacy filtering, it may remain `anonymousView` at the `providers.tsx` level alongside the 7 public HSR reference tables — document that decision in this section alongside the two existing exceptions.

### Accepted Tradeoff (from 15.2 D-01 / 15.5 CONTEXT)

**Closed by Phase S11a (A77):** `User` is private, so `SELECT * FROM user` is refused. Historical text: `User.public = true` means a malicious actor subscribing directly to `SELECT * FROM user` (not via our frontend) still receives rows. Closing that requires `User.public = false` + on-demand read reducers — explicitly deferred in Phase 15.5 CONTEXT deferred ideas. This phase's scope is "our frontend does not auto-subscribe anonymous," not "adversarial clients cannot query User."

## Phase S10m execution (DECISIONS.md A113(4))

`server_link_provider` case 1b, when the caller's user is a guest that has no other identity (`UserIdentity.user_id`
returns only the caller's mapping, so the guest would be deleted after the re-point): before the mapping is touched,
`isSeatedInLiveGame(ctx, guestId)` (`reducers/identity/server.ts`) reads the guest's `LobbyMember.user_id` rows and the
`Lobby.id` of each; a row counts when its seat is a player seat (not `slotIsSpectator`, not `slotIsCoach`), it is not
abandoned (`abandonedAt` unset; an away row still counts, its holder may return, A68(2)), and the lobby stage is in
`LIVE_STAGES` (Drafting, Equipping, Scoring). Any such row throws `Finish your current game before signing in to an
existing account.`; nothing changes (identity mapping, presence, guest, entries). Waiting and AwaitingResult lobbies,
spectator and coach seats do not block; the first-time link (case 1a, the guest upgraded in place) is not checked.
The calendar invites of a moved tournament entry move with it (A113(5)):
[../tournament/architecture.md](../tournament/architecture.md) "Phase S10m execution".

## Phase S10r execution (DECISIONS.md A122)

- **Presets and cost sets in the deletion cascade (A122(6), L22, L89).** `performUserDeletion` (`helpers/identity/userDeletionHelper.ts`) runs `deleteOwnedPresetsAndCostSets` after the HSR accounts, before the User row:
  - **Lobby presets** (`LobbyPreset.creator_user_id`; the system preset is owned by SYSTEM and never matches): deleted unless an unfinished tournament (stage not Completed / Cancelled) has the preset as `lobbyPresetId`. Lobbies hold no preset reference (a preset's values are copied at creation, A116), so a lobby never keeps one. Tournament has no `lobbyPresetId` index: one `Tournament` scan per deletion that has presets. A preset kept for an unfinished tournament is not removed later (no clean-up revisits it when the tournament ends); with its creator gone only an Admin can edit or delete it.
  - **Cost sets** (`CostSet.creator_id`): every set with `isPublished` false (a draft, or a set unpublished later) is deleted with its live and draft rows through `deleteCostSetRows` (`helpers/draft/costSetGuards.ts`, shared with `delete_cost_set`), unless `isCostSetInUse` holds it (any `Lobby` row on the set, or an unfinished tournament), as `delete_cost_set` checks. `isCostSetInUse` scans `Lobby` and `Tournament` once per unpublished set of the deleted user (neither table has a `costSetId` index); guests own no sets or presets, so the guest clean-up path does index probes only. A set kept this way is not removed later either. Published sets stay. Set 0 is never touched.

## Phase S10s execution (DECISIONS.md A121, A124)

- **Organizer hand-over, staff path (A121, L70).** `performUserDeletion(ctx, userId, actorId, opts?)` starts with
  `handOverOrganizedTournaments(ctx, userId, actorId)` (`helpers/identity/userDeletionHelper.ts`) unless
  `opts.serverDeletion` is set (below). For every tournament the user organizes (`Tournament.organizer_id`) that is not
  Completed or Cancelled:
  1. the heir is the assistant row (`TournamentAssistant.tournament_id`) holding `canManageParticipants`,
     `canManageBracket` and `canResolveResults`, whose user exists, is not a guest and has no `deletedAt`, with the
     earliest `createdDate` (equal dates: the lower user id; never the row id, CLAUDE.md §3.4); its row is deleted;
  2. no heir: the actor, when the actor's `User` row exists, has no `deletedAt` and is Moderator or above;
  3. neither: the tournament is left as before (Moderator+ manage it).
  The new organizer's own assistant row in that tournament is deleted; `CalendarEvent` rows of the tournament's bracket
  matches whose `organizerId` is the deleted user move to the new organizer (audit actor = `actorId`). An heir enrolled
  as a player keeps the enrolment.
- **Server deletion (A124).** `opts.serverDeletion` makes `performUserDeletion` run `cancelOrganizedTournaments`
  instead: each of the user's tournaments that is not Completed or Cancelled goes through `cancelTournament`
  (`helpers/tournament/tournamentHelpers.ts`, the one cancel path), with no hand-over. The flag is an explicit argument,
  not read from the actor id inside the helper. It is set at three call sites:
  - `server_delete_user` (`reducers/identity/server.ts`): always;
  - `run_user_deletion` (`reducers/identity/userDeletion.ts`): when the job's `createdById` is the SYSTEM user's id.
    Only `admin_ban_user` and `admin_delete_row('User')` write a job whose creator is not the deleted user, and their
    actor is the SYSTEM user exactly when the caller is a server identity (the Owner and Delegates map to SYSTEM).
    `UserDeletionJob` has no other free field and the step adds no column, so the job creator is the only carrier;
  - `admin_delete_row('UserIdentity')` (`reducers/admin/admin.ts`) when the caller is the SYSTEM user and the guest left
    without identity is deleted at once.
  Identity GC (`performIdentityGc`) and `server_link_provider` (case 1b, the replaced guest) also pass a SYSTEM actor but
  never pass the flag, so they cancel nothing (guests cannot organize in practice either).
- **Which deletions hand over, cancel, or do nothing.**

  | Path | Actor | Effect on the organizer's unfinished tournaments |
  |---|---|---|
  | `admin_ban_user`, `admin_delete_row('User')` by a staff Admin (job, `run_user_deletion`) | the Admin | A121 hand-over |
  | the same reducers sent by the Owner or a Delegate | the SYSTEM user | A124 cancel |
  | `server_delete_user` | `SYSTEM_USER_ID` | A124 cancel |
  | `admin_delete_row('UserIdentity')` (guest without identity) | the Admin / the SYSTEM user | hand-over / cancel |
  | `delete_my_account` | the user | none (A94(1) refuses an organizer) |
  | ban found on reconnect (`client_connected`, `index.ts`, D-08 point 2) | the banned user (job creator) | none |
  | identity GC, `server_link_provider` case 1b | SYSTEM | none |

  Review F4: the reconnect-ban path schedules the job with the banned user as creator, so the hand-over sees a
  self-deletion and changes nothing, and the A124 flag is not set either; the tournament keeps the deleted organizer
  (Moderator+ manage it). It is kept as a guard for restored or hand-edited rows (S10e log), so it is rarely reachable;
  giving that job `BanRecord.bannedByUserId` as creator would bring it under A121 or A124 (not done, no decision).
  Both ban and admin deletion require Admin today (`ensureAdmin`), so the Moderator fallback of A121 is reachable only
  if a Moderator path is added. No schema change.


## Phase S11a execution (DECISIONS.md A77)

`User` is private (`public: false`) and `UserPrivate` is merged into it (`tables/identity/user.ts`; the file
`tables/identity/userPrivate.ts` is deleted). Schema (clear-publish): `User` loses `hasDiscordLinked` and gains, after
`deletedAt`, `loginMethod?`, `providerId?`, `providerUsername?` (strings) and `linkedAt?` (timestamp), all unset for a
guest, plus the two provider indexes `provider_id` and `by_method_and_provider` (the latter still unused, as before).
`linkedAt` carries the link time that `UserPrivate.createdDate` carried: set on the first link and when the login
method or provider id changes; a refresh of the same link keeps it.

- Writers: `init` (SYSTEM) and `login_as_guest` write the provider columns unset; `server_link_provider` Case 1a / 1c
  writes them on the user row (no second table); Case 1b finds the provider owner through `User.provider_id`.
- Readers: `client_connected` (reconnect ban check), `admin_ban_user` (soft-delete of the linked user),
  `view_my_profile` (row shape kept, `hasDiscordLinked` derived), `view_admin_user_private` (row shape kept: one row per
  user with a provider linked), `view_admin_users` (new, Moderator+). `performUserDeletion` and `server_nuke_test_data`
  no longer have a second table to clear.
- Clients: no generated accessor for `user` (`web/src/module_bindings/user_table.ts` deleted by `npm run stdb:generate`);
  a `SELECT * FROM user` subscription is refused by the server. Server scripts never read `User` (bootstrap, seed and
  manage-user call reducers by username); the live harness resolves a guest's id through `view_my_identity` (A77(3)).
  `spacetime sql` as the database owner still reads the table (`queryPrivateTable`, `getTestDiscordId`).
- Where the data a page needs comes from now: [../views/architecture.md](../views/architecture.md) "Phase S11a execution".

## Phase History

| Decision | Source | Date |
|----------|--------|------|
| login_as_guest creates User + UserIdentity; identity is SpacetimeDB sender | Phase 01 execution | 2026-02-01 |
| server_link_provider three merge cases (1a guest upgrade, 1b re-point, 1c refresh) | Phase 02 execution | 2026-02-10 |
| ctx.sender is always the authenticated principal -- never trust identity args | Phase 01 CONTEXT.md | 2026-02-01 |
| discordId removed from public User table; hasDiscordLinked bool replaces it | Phase 12 execution | 2026-04-05 |
| UserIdentity made private (public: false); clients use view_my_identity | Phase 12 execution | 2026-04-05 |
| UserPrivate table added for sensitive provider data (discordId, email) | Phase 12 execution | 2026-04-05 |
| BanRecord table added; three-point ban enforcement (D-08) | Phase 12 execution | 2026-04-05 |
| view_user_directory added as safe D-16 subset for client consumption | Phase 12 execution | 2026-04-05 |
| Link-discord API route uses ephemeral connection identity verification (replaces trusting client-supplied hex) (SEC-04) | Phase 12 execution | 2026-04-05 |
| Multi-column index on BanRecord causes PANIC; use single-column index + in-memory filter (WR-01) | Phase 12 execution | 2026-04-05 |
| Normalized to standard template | Phase 13 normalization | 2026-04-09 |
| ServerIdentity gains `kind` (Owner \| Delegate) + `label`; `init` registers the publisher as Owner; owner-only `server_register_delegate` / `server_revoke_delegate`; `server_link_provider` accepts Owner or Delegate | Phase M2 execution | 2026-11-06 |
| User.isPrivate removed (D-02 dead code); DeletedUser private archive table added (D-05); view_user_directory flipped to authenticated-only spacetimedb.view() (D-06); performUserDeletion eviction rewrite (D-09); R1 fix — all three soft-delete writers now insert UserDeletionJob (D-10); resolveUserLabel helper added (D-12) | Phase 15.2 execution | 2026-04-15 |
| UAT verify-work confirmed all 9 cascade + archive behaviors on live maincloud. Two issues surfaced for follow-up (scoped to Phase 15.5 via seed `.planning/seeds/phase-15.5-auth-gated-user-subscription.md`): (1) D-06's `spacetimedb.view()` does NOT reject anonymous subscribers at the framework level — per SpacetimeDB docs, `view` vs `anonymousView` only differs in whether `ctx.sender()` is exposed, not in who can call; the runtime flip is a no-op without an explicit body-level auth check. (2) The actual bandwidth-leak surface is `useAuth.ts:38`'s unconditional `SELECT * FROM user` subscription pre-auth — no client ever subscribes to `view_user_directory`. Phase 15.5 will delete the dead view and gate the raw `user` subscription behind auth state | Phase 15.2 execution | 2026-04-16 |
| Phase 15.5: `view_user_directory` deleted (dead code — zero client subscribers, cosmetic 15.2 D-06 flip retired); `view_public_accounts` renamed to `view_public_hsr_accounts` (D-04) — underlying table is HsrAccount, name now explicit; `useAuth.ts` subscription split into Stage 1 (`view_my_profile`, always) and Stage 2 (`SELECT * FROM user`, gated on `currentUser != null \|\| hadUserIdOnMount.current \|\| hadSessionCookie.current`) — closes the UAT Test 4 bandwidth leak; gate signal swapped from `hadTokenOnMount` (SDK auto-persists anonymous identity token, false-positive) to `hadUserIdOnMount` (`spacetimedb_user_id`, only written by `setResolvedUser`) per Plan 02 D-01 deviation `790a39c`; new `guestLoginPending` state drives a narrow Login-button spinner scoped strictly to the `loginAsGuest` pending window (D-03); `docs/auth/architecture.md` Subscription Lifecycle section codifies the projection-vs-subscription privacy distinction (D-05) with `view_lobby_browser` and `view_public_hsr_accounts` named as intentional anonymous exceptions | Phase 15.5 execution | 2026-04-16 |
| Phase 15.5 verify-work harmonization: doc wording aligned with shipped `useAuth.ts` identifier `hadUserIdOnMount` (was `hadTokenOnMount` in pre-execution drafts); Subscription Lifecycle Stage 2 gate description expanded with the SDK token-auto-persist rationale and the `useAuth.ts:116` `if (!isActive) return;` first-guard reference | Phase 15.5 verify-work | 2026-04-17 |
| Phase 16 reshuffle: Subscription Lifecycle ownership relocated — Stage 1 (`view_my_profile`) moved from `useAuth.ts:72-111` to `components/features/auth/components/AuthProvider.tsx` (D-03); Stage 2 (`SELECT * FROM user`) moved from `useAuth.ts:115-181` to `app/(authed)/layout.tsx` (D-07); route-group mount replaces 15.5's ref-based `stage2Gate` check as the structural gate (D-07). `useAuth.ts` retains `readProfileFromConnection` + login/logout/Discord-link/guest-login/soft-delete state only; `setProfileReady` + `triggerReadProfile` exposed as `@internal` on the auth context. D-12 regression guard `test/backend/auth/auth-subscriptions.test.ts` confirmed green unmodified across all Phase 16 plan commits. `middleware.ts` (Plan 03 new) clarified as UX-only redirect — NOT an auth trust boundary (real access control remains at SpacetimeDB reducer/view level). | Phase 16 execution | 2026-04-18 |
| Phase 16 post-execution perf pass: `useAuth()` return object memoized so context consumers re-render only when their used subset changes; collapsed duplicate auth-context reads in the `(authed)/layout.tsx` mount path. No public API change — memoization only. Commit `42944fa` | Phase 16 execution | 2026-04-19 |
| Phase 16 verify-work infrastructure fixes (no auth-API change, but prerequisites for the auth + SDK pipeline to function in prod): (a) CSP `script-src 'unsafe-eval'` required in BOTH dev AND prod — SpacetimeDB SDK generates BSATN codecs at runtime via `Function()` constructor (~7 call sites in `spacetimedb/dist/index.browser.mjs`); original WR-04 assumption that only dev needed it was wrong, prod builds crash at SDK init without it (commit `c6ce7e1`). (b) CSP `connect-src` extended with `https://*.ufs.sh` so the Service Worker's CDN-intercept fetch passes CSP — otherwise any authed page loading UploadThing-hosted profile assets fails the SW round-trip (commit `6ad7ba0`). Neither change touches auth logic; both are required for auth to render any profile picture or character art without errors | Phase 16 verify-work | 2026-04-19 |
| Per-identity presence goes live: `client_connected` upserts `UserPresence`, restores lobby memberships (F1) and deletes pending `RefereeTransferCheck` rows; `client_disconnected` marks the identity offline and, only when no other device is live, marks memberships offline and schedules the 15 s check; `login_as_guest` writes the fresh guest's row; `server_link_provider` case 1b re-points the row; identity GC and `performUserDeletion` delete rows with the identity; staleness rule recorded (no heartbeat) | Phase S4 execution (DECISIONS.md A22a, A48, A16; S3 review L3/M3) | 2026-11-06 |
| B-8 maintenance-mode rejection in `client_connected` (`AbuseConfig.maintenanceMode`, server identities exempt); inert until S5 seeds the row | Phase S4 execution (ACCESS-SECURITY-OPS §B.5) | 2026-11-06 |
| `performUserDeletion` hands over the user's lobby flags first (A68(7)); `client_connected` / `client_disconnected` skip away / abandoned lobby rows (A68(2), details in `docs/lobby/architecture.md`) | Phase S8f execution (DECISIONS.md A68) | 2026-11-08 |
| `view_my_profile` row re-shaped for the profile page (PK `id`; no presence, deletedAt or audit columns; provider fields per A46); `view_my_identity` = `{ identity, userId }`; `view_admin_user_private` a staff-only full read; new `view_user_by_username` | Phase S9b execution (DECISIONS.md A37, A40, A43, A44, A48) | 2026-11-08 |
| Identity GC exempts server identities and SYSTEM mappings; provider link trims / caps the name and derives a free username on a collision; revoking a delegate deletes its presence row; `server_set_role` / `server_delete_user` reject the SYSTEM user ("The SYSTEM user cannot be changed." / "... cannot be deleted.") | Phase S10e execution (identity audit #1, #3, #5, #9) | 2026-11-09 |
| Fix pass: `performUserDeletion` no longer releases an abandoned row's `LobbyMemberAccount` rows; `admin_delete_row('UserIdentity')` refuses server identities and SYSTEM mappings and runs the disconnect path for a user left with no live presence | Phase S10e execution (review F3, F5, N9) | 2026-11-09 |
| `performUserDeletion` settles tournament ties first (withdrawal before the bracket, DQ after it; requests, assistant, stand-in, lock and waitlist-account rows deleted); `delete_my_account` rejects the organizer of a live tournament in both branches | Phase S10g execution (DECISIONS.md A94) | 2026-11-09 |
| Identity GC deletes a guest user idle 30 days with no match history (`performUserDeletion`, 500 per run); `login_as_guest` counts new guests in the guest creation breaker (switch, threshold, alert) and repoints an orphan mapping | Phase S10h execution (DECISIONS.md A95; identity audit #7, #10) | 2026-11-10 |
| Match history for guest retention also covers `hasHistoryReferences` (PlayerStat and the other stat / rating tables, review F1); a scheduled run that hits the 500 cap requeues in one hour (review F4); `login_as_guest` names a guest `Guest_` + the last 8 identity hex characters, made unique (`uniqueUsername` moved to `helpers/identity/usernames.ts`) | Phase S10h execution (S10h review fix pass) | 2026-11-10 |
| Default guest creation threshold 300 per 10 minutes; `server_set_guest_creation(enabled)` (server identity) turns the switch on or off without an Admin session, resetting the counter on re-enable | Phase S10i execution (DECISIONS.md A109) | 2026-11-10 |
| `server_link_provider` case 1b moves the guest's entries in unfinished tournaments to the existing user (`moveTournamentTiesToUser`) before the guest is deleted; entries the existing user cannot hold are settled by the deletion | Phase S10l execution (DECISIONS.md A112) | 2026-11-10 |
| `server_link_provider` case 1b refuses the sign-in (`Finish your current game before signing in to an existing account.`) while the guest that would be deleted holds a non-abandoned player seat in a Drafting, Equipping or Scoring lobby | Phase S10m execution (DECISIONS.md A113(4)) | 2026-11-10 |
| `performUserDeletion` deletes the user's lobby presets (kept while an unfinished tournament points at one) and unpublished cost sets with their rows (kept while `isCostSetInUse`); published sets stay | Phase S10r execution (DECISIONS.md A122) | 2026-11-10 |
| `performUserDeletion` first hands the unfinished tournaments of an organizer deleted or banned by staff to the longest-serving full assistant, else the acting Moderator+ (organizerId and the tournament's match calendar events); server-identity and self deletions unchanged | Phase S10s execution (DECISIONS.md A121) | 2026-11-10 |
| A server deletion or ban of an organizer (`server_delete_user`, or a ban / delete sent as the SYSTEM user) cancels the unfinished tournaments through `cancelTournament` (explicit `serverDeletion` option); the reconnect-ban path documented as no hand-over | Phase S10s execution (DECISIONS.md A124) | 2026-11-10 |
| `User` private; `UserPrivate` merged into it (provider columns + `linkedAt`, two indexes); `hasDiscordLinked` derived; `view_admin_users` for the Users tab | Phase S11a execution (DECISIONS.md A77) | 2026-11-11 |
| The scheduled `run_user_deletion` and `run_identity_gc` refuse any caller but the scheduler (`ensureScheduler`, `ctx.senderAuth.isInternal`; L11); `admin_gc_identities` restarts a stopped `IdentityGcJob` chain (L6); a user deletion also removes the user's `LobbyCursorStamp` rows (L19) | Phase S11a execution (part 2, closing-triage items) | 2026-11-11 |

---

*Last updated: 2026-11-11 (S11a part 2)*
*Feature owner: Phase 01 / Phase 12 / Phase 16*

**Behavior specification** (acceptance scenarios, edge cases, phase history): See [contract.md](contract.md)
