# Auth & Users -- Architecture

Last updated: 2026-11-14

## Overview

Authentication is built on SpacetimeDB identities with optional Discord OAuth linking. Every client gets a SpacetimeDB identity on first connection. `login_as_guest` creates a User row and UserIdentity mapping. The auth function (M5) upgrades guests to verified accounts after Discord OAuth completes: since M5a through a one-time link code (`request_link_code` by the guest, `linker_present_code` by the function, renamed from `server_link_by_code` in M5a3), and since M5a2 only when the requesting browser confirms with `confirm_link` and the one-time token the function gave it, so the browser's SpacetimeDB token never leaves the browser. Since M5a3 the function holds a Linker identity that can call no reducer but `linker_present_code` (its token is still enough to sign in as any Discord-linked account: "The link token" below), and the direct identity-hex link `server_link_provider` is removed: `confirm_link` is the only reducer that links, through the merge in `helpers/identity/providerLink.ts`. Since Phase S11a (A77) the `User` table is private and holds the provider link (formerly `UserPrivate`); no client subscribes it. The user reads their own row through `view_my_profile`, staff read users through `view_admin_users` and `view_admin_user_private`, and every other page gets names and avatars denormalized into the views that need them (PAGE-MAP D2).

Ban enforcement runs at three points: at link-time, at reconnect, and when a ban is created.

## Server Identity: Owner, Delegates and the Linker (Phase M2; Linker Phase M5a3)

`ServerIdentity` (private) holds the server identities. The Owner and Delegates may call the `server_*` reducers; since M5a3 a Linker may call only `linker_present_code`:

- **Owner**: the database publisher, inserted by `init` on the first publish (and on every `--delete-data` republish) together with the SYSTEM user. Only the owner may call `server_register_delegate` / `server_revoke_delegate`.
- **Delegate**: an identity the owner registered (label `vercel-auth-<target>`). `scripts/stdb/bootstrap.ts` mints it and writes its token as `STDB_SERVER_TOKEN` to `.env.<target>.local`; bootstrap, the seed and the manage-user scripts use it. Since M5a3 the Vercel function does not hold it: its secret is the link token (`STDB_LINK_TOKEN`, below). Each delegate is linked to the SYSTEM user through `UserIdentity`, so `ensureAdmin` passes for seeding.

- **Linker** (Phase M5a3): the auth function's identity (label `vercel-link-<target>`), registered by the owner with `server_register_linker` and revoked with `server_revoke_linker`. `scripts/stdb/bootstrap.ts` writes `STDB_LINK_TOKEN` and `STDB_LINK_IDENTITY` to `.env.<target>.local` the first time and keeps that linker on later runs (it mints a new one only with `--rotate-linker`; "Bootstrap and the linker" in "Phase M5a3 execution"); the token goes into the Vercel function secrets. The link token is a high-value secret: it is enough to sign in as any Discord-linked account ("The link token" in "Phase M5a2 execution"). A linker has no `UserIdentity` row and is not mapped to the SYSTEM user. It may call only `linker_present_code` (`requireLinker`: Owner and Delegates are refused there). Every other reducer refuses it: `requireServer`, the GC seeds and the maintenance gate use `trustedServerRow` (Owner or Delegate only), the admin and user reducers find no user for it, and `login_as_guest` refuses it outright ("Forbidden: a linker identity cannot sign in as a user.").

`server_set_role`, `server_delete_user` and the other `server_*` reducers accept the **trusted** server identities (`requireServer`: Owner or Delegate; a Linker is refused with the same text). Nothing in the module accepts an unregistered caller; there is no first-come registration. A leaked delegate token is revoked with `server_revoke_delegate` (or by re-running bootstrap, which revokes the previous delegate) without a wipe.

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
  login_as_guest (fresh guest), confirm_link case 1b (userId re-pointed; server_link_provider before M5a3), client_disconnected
  (isOnline=false, lastSeenAt), run_identity_gc and performUserDeletion (delete with the identity),
  server_set_online (test only, forces every row of the user). Reader: view_admin_presence (S9).
  Staleness rule (S3 review L3): a live row whose disconnect was missed is corrected only by that identity's
  next connect/disconnect, by identity GC when it removes the identity, or by server_set_online. There is no
  heartbeat (energy, A16); until one of those runs the user reads as online on that device and the A22a
  check does not fire.

LinkRequest (code: string PK)  [PRIVATE -- public: false]  (S3 table, written since Phase M5a execution)
  +-- code: string (32 base64url characters; the bearer secret)
  +-- identity: Identity (unique: one live request per identity)
  +-- userId -> User.id  [btree: user_id]
  +-- expiresAt: Timestamp (request time + 5 minutes; presentation time + 2 minutes once presented, M5a2)
  +-- usedAt: Timestamp? (M5a2: the time linker_present_code presented the code; one presentation per code)
  +-- audit columns (actor: the requesting user; SYSTEM for the presentation)
  +-- pendingProvider: string? / pendingProviderId: string? / pendingProviderName: string? (M5a2: the Discord account
      presented, the name cleaned as the merge stores it)
  +-- confirmHash: string? (M5a2: base64url SHA-256 of the confirm token's 32 bytes, 43 characters)
  The four M5a2 columns are appended last with a default (None): see "Phase M5a2 execution", publish note.
  Writers: request_link_code (insert), linker_present_code (the pending stage). Deleters: request_link_code (the
  caller's previous row, pending or not; the inline sweep), confirm_link (the row of a successful link),
  run_identity_gc (backstop sweep), performUserDeletion (user_id), server_nuke_test_data (clear).
  Reader: view_my_link_request (the caller's own row, without confirmHash or pendingProviderId).

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

### server_link_provider(identity, discordId, discordUsername, email?) -- server-only (REMOVED in Phase M5a3)
> Removed in M5a3 (user ruling 2026-11-13): no reducer links an identity by its hex any more. The three merge cases below live on in `planProviderLink` / `applyProviderLink`, run by `confirm_link` for the caller's own identity; Case 1c (the refresh of an already linked identity) is unreachable since M5a, because `request_link_code` refuses a linked user. The section is kept as the record of the merge rules.

1. `requireServer(ctx)` -- caller must have a ServerIdentity row (Owner or Delegate)
2. `rejectIfBanned(ctx, discordId)` -- check BanRecord via `ban_record_provider_id` index (D-08 point 1)
3. Look up `UserIdentity` by provided identity
4. Three merge cases:
   - **Case 1a**: Identity -> guest, no existing provider owner -- upgrade guest: `isGuest=false`, provider columns set (`linkedAt = now`), username=providerName
   - **Case 1b**: Identity -> guest, provider already linked to different user -- re-point identity to existing user, delete orphaned guest. Phase S4 execution (A48, S3 review M3): the identity's `UserPresence.userId` + `lastLoginAt` follow the re-point before `performUserDeletion` removes the guest's own presence rows. Phase S10l execution (A112): when the guest is about to be deleted (no other identity of the guest remains), `moveTournamentTiesToUser(ctx, guestId, existingUserId, SYSTEM_USER_ID)` (`helpers/tournament/entryTransfer.ts`) runs first and moves the guest's entries in unfinished tournaments to the existing user; the existing user must meet the tournament's gates as they stand at sign-in (enrolment, membership, `minimumMmr` by the `ensureMinimumMmr` rating test, `requireRoster`), the guest's recorded captaincies follow even without a membership, and the existing user's stand-in approvals for matches their new team plays are deleted; the full rules (move / do-not-move conditions, locks) are in [tournament/architecture.md](../tournament/architecture.md) "Phase S10l execution". What it does not move is settled by `performUserDeletion` as before (A94(2)). Phase S10m execution (A113(4)): on that deletion path, see "Phase S10m execution" below, the link is refused before any change while the guest plays a live game
   - **Case 1c**: Identity -> verified user, refresh -- update timestamps and the provider name; `linkedAt` kept when the login method and provider id are unchanged, set to now when they change
5. Phase S11a (A77): the provider columns are written on the `User` row (`loginMethod`, `providerId`, `providerUsername`, `linkedAt`); the provider owner of step 4 is found through `User.provider_id`

Phase S10e execution (identity audit #3): the actual arguments are `(callerIdentityHex, provider, providerId, providerName)`. `providerName` is trimmed and cut to 32 characters (the username length; empty after trim: "providerName is required"); the trimmed name is stored as `displayName` and `providerUsername`. Case 1a takes it as the username through `uniqueUsername`: the name itself when no other user holds it, else the first free `name_2`, `name_3`, ... (the base shortened to stay within 32), so a username taken by another account no longer aborts the link on the unique index. `callerIdentityHex` goes through the file's `parseIdentityHex` (same texts as before); Cases 2 and 3 share one terminal "Identity not registered. Call login_as_guest first."

### request_link_code(clientNonce) -- client (Phase M5a execution)
0. `checkClientNonce`: exactly 43 characters of `A-Z a-z 0-9 - _` (32 bytes from the browser's `crypto.getRandomValues` in base64url), else "clientNonce must be 43 base64url characters (32 random bytes)." The nonce is mixed into the code and never stored or logged
1. Resolve `UserIdentity` → `User` for `ctx.sender`; `ensureNotInMaintenance(ctx, user)` (A163(3), as `login_as_guest` and the profile reducers)
2. Refuse: no live user ("No account for this identity. Call login_as_guest first."); `deletedAt` set, i.e. deleted or banned pending the cascade ("Unauthorized: This account has been deleted."); not a guest, or a provider already linked ("This account is already linked.")
3. Delete the caller's previous `LinkRequest` row (unique `identity`): its code stops working
4. Inline sweep: examine at most `LINK_SWEEP_SCAN_LIMIT` (64) rows of the table, delete those whose `expiresAt` has passed (a code before presentation, or a pending row after its 2-minute window; M5a2)
5. Insert `{ code: generateLinkCode(...), identity: ctx.sender, userId, expiresAt: now + 5 min }` (audit actor: the user)

### linker_present_code(linkCode, provider, providerId, providerName, confirmHash) -- server-only (Phase M5a execution; presentation only since M5a2)
1. `requireLinker(ctx)` (M5a3: only the registered Linker; the Owner and Delegates are refused: "Forbidden: caller is not the registered linker identity."); then, for provider `discord`, `providerId` must be a Discord snowflake (digits only, 17 to 20 long), else "providerId is not a Discord id."; `confirmHash` must be the canonical base64url of 32 bytes (43 characters), else "confirmHash must be 43 base64url characters (a SHA-256 digest)." Both before the code is looked at (the removed `server_link_provider` had neither rule)
2. Find the row by `code`. Missing, already presented (`usedAt` set) or `expiresAt <= now`: throw "This link code is invalid or has expired." (one text for all of them; the reason goes to the module log as `[LINK] linker_present_code refused: ...`, never the code, token or hash). Nothing changes
3. Pre-check, as the link would run now: "This account changed since the sign-in started. Please start again." when the row's identity maps to another user than the row's `userId`, or that user is gone, not a guest, has a provider or has `deletedAt` (`ensureStillTheRequestingGuest`); then `planProviderLink`, whose own refusal is thrown unchanged (input validation, provider, the ban text, the A113(4) live-game text, no mapping). A refusal rolls back: the code stays live
4. Record the pending stage: `pendingProvider`, `pendingProviderId`, `pendingProviderName` (cleaned: `cleanProviderName`), `confirmHash`, `usedAt = now`, `expiresAt = now + 2 min` (audit actor SYSTEM). Nothing is written to `User`

### confirm_link(confirmToken) -- client (Phase M5a2 execution)
1. `confirmToken` must be the canonical base64url of 32 bytes (43 characters), else "confirmToken must be 43 base64url characters (32 bytes)."
2. Resolve `UserIdentity` → `User` for `ctx.sender`; `ensureNotInMaintenance` (a non-Admin is refused while maintenance is on); no live user: "No account for this identity. Call login_as_guest first."; `deletedAt` set (deleted or banned): "Unauthorized: This account has been deleted."
3. The caller's own row by the unique `identity` index. None, not presented, or its window has passed: "No sign-in is waiting for confirmation. Please start again."
4. `confirmHashOf(confirmToken)` compared with `confirmHash` (no early exit): a mismatch is "This sign-in could not be confirmed." No attempt counter: the token carries 256 bits, and an error rolls back, so a wrong token burns nothing
5. The account-changed check and `planProviderLink` again (state may have changed since the presentation: a ban, a live game, a link made another way); a refusal throws its own text to the caller
6. Delete the row, then `applyProviderLink` (Case 1a upgrade, or Case 1b re-point when the Discord user already exists), one transaction

### Shared merge: planProviderLink / applyProviderLink (Phase M5a execution)
`helpers/identity/providerLink.ts` holds the merge, moved out of `server_link_provider` in M5a without a behaviour change, except the provider name clean-up added in the M5a review pass ("Provider name clean-up" below): `planProviderLink(ctx, { provider, providerId, providerName }, resolveIdentity)` runs every check in the old order and writes nothing; `applyProviderLink(ctx, plan)` performs the writes of Case 1b (re-point) or Case 1a / 1c (upgrade / refresh). Since M5a3 `confirm_link` runs both (`resolveIdentity` returns `ctx.sender`) and `linker_present_code` runs `planProviderLink` as a pre-check (the row's identity); until M5a3 `server_link_provider` passed its identity-hex parse. Both reducers first require the live, unlinked guest that asked, so Case 1c and the non-guest sides of the re-point are no longer reached by any reducer; they are kept and pinned by direct tests (`__tests__/identity/provider-link-direct.test.ts`). Two refusals are still reached through `linker_present_code` only: "providerId is required" (a provider other than Discord with an empty id; a Discord id is shape-checked first) and "Identity not registered" (the requesting identity's mapping removed after the request, while the guest lives on through another identity).

### clientConnected() -- lifecycle hook (exported as `client_connected`)
> Both lifecycle hooks register only because `index.ts` exports them. Before 2026-11-05 they were bare `spacetimedb.clientConnected(...)` calls, which the SDK silently drops, so neither hook ever ran on a published database. Behavior below is the spec; it takes effect on the first publish that includes the fix.

1. B-8 (Phase S4 execution, ACCESS-SECURITY-OPS §B.5): if `AbuseConfig` row 1 has `maintenanceMode=true` and `ctx.sender` is not a trusted server identity (an Owner or Delegate `ServerIdentity` row, `trustedServerRow`; since M5a3 a Linker is not admitted), `throw` -- the socket is rejected. `AbuseConfig` is seeded in S5; until then this check is inert. S11a rulings pass (A163(3), triage L9): an identity mapped to a live Admin user (`UserIdentity` → `User`, role Admin, `deletedAt` unset) is also admitted; text unchanged (`Maintenance mode: connections are not accepted right now.`). A non-Admin who is still connected is refused on every action: see `docs/admin/architecture.md` "Maintenance mode".
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

A95(1) guest retention (Phase S10h execution): the weekly identity clean-up (`performIdentityGc`, `reducers/identity/identityGc.ts`; also `admin_gc_identities`) still never collects a guest's identities one by one (D-06), but deletes a **guest user** through `performUserDeletion` (actor SYSTEM for the scheduled run, the Moderator for the admin run) when `guestPastRetention` holds, every check an index read: the user is not scheduled for deletion (`deletedAt` unset); no live `UserPresence` row (`user_id`); for every identity of the user, the later of `UserIdentity.lastSeenAt` and that identity's `UserPresence.lastSeenAt` (identity PK) is 30 days or older (`GUEST_IDLE_DAYS`); no `LobbyMember` row in any lobby or stage (`user_id`); no `TournamentEnrolled` row (`user_id`) in a tournament that is not Completed or Cancelled (`Tournament.id`); no match history: no `MatchParticipantHistory` row (`by_user`, archived matches) and nothing `hasHistoryReferences` (`helpers/identity/userDeletionHelper.ts`) finds, one index probe each: `MatchResultParticipant` (live and pending records), `MmrHistory`, `PlayerStat`, `PlayerCharacterStat`, `PlayerRelationship`, `Leaderboard`, `TournamentEnrolled` (any stage, so a finished tournament's enrolment keeps the guest too), `UserAchievement` (S10h review F1: a casual concede or forfeit archives no participant row but writes `PlayerStat`, so stat rows count as match history). At most 500 guest users per run (`GUEST_DELETIONS_PER_RUN`); the scan visits every identity each run, so the rest are found again by the next run; no cursor. A scheduled run that reached the cap requeues its next run one hour out (`GC_BACKLOG_INTERVAL_MICROS`, review F4) instead of seven days, so a backlog drains in hourly runs; a run under the cap keeps the weekly interval. Each run queues exactly one next job; the admin run queues one only when `IdentityGcJob` holds no row (S11a, triage L6: it restarts a stopped chain, 7 days out) or its only row is more than 7 days past its time (S11a review M4: replaced, `helpers/admin/scheduledJobRearm.ts`). Each deletion counts in `itemsDeleted`; the `GcResult.details` JSON gains `guests`. A guest with no identity row left is not reached (the scan starts from `UserIdentity`).

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
| `view_my_link_request` | ctx.sender only | The caller's link request, at most one row, no primary key: `code?` (the live code; unset once presented), `expiresAt` (the 5-minute code expiry, or the 2-minute confirm window once presented), `awaitingConfirm` (presented, `confirm_link` is next), `pendingProviderName?` (the Discord name about to be linked, only while awaiting). Never `confirmHash` or `pendingProviderId`. A view has no clock (`ViewCtx` carries no timestamp), so an expired row is still returned until swept and the client compares `expiresAt` (Phase M5a execution; shape Phase M5a2 execution) |
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
        → S11a rulings pass (A163(1)): removeDeletedUserFromLeaderboard (helpers/stats/leaderboardRebuild.ts)
          deletes the user's Leaderboard rows of every season; when one was in the active season (0 when none is
          active) that season is rebuilt. Details and cost: docs/mmr/architecture.md "Phase S11a execution (A163(1))"
```

Every deletion path reaches this one function: `delete_my_account`, `run_user_deletion` (ban, `admin_delete_row('User')`, ban on reconnect), `server_delete_user`, `admin_delete_row('UserIdentity')` of a guest's last identity, `confirm_link` (the old guest, Case 1b; was `server_link_provider` before M5a3) and the identity GC (guests). The guest fast path holds no `Leaderboard` row (`hasHistoryReferences` checks it).

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

> Old-repo design, replaced by the M5 auth function and the link-code flow ("Phase M5a execution" below).

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
| Point 1 (link-time) | `linker_present_code` (pre-check) and `confirm_link` (M5a2/M5a3; `planProviderLink`) | `rejectIfBanned` before any user mutation |
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
  Identity GC (`performIdentityGc`) and `confirm_link` (case 1b, the replaced guest; `server_link_provider` before M5a3) also pass a SYSTEM actor but
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
  | identity GC, `confirm_link` case 1b (was `server_link_provider`) | SYSTEM | none |

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

## Phase M5a execution (DECISIONS.md A44(3), A46)

**Flow (M5a; the last step changed by M5a2 below).** (1) A connected guest calls `request_link_code(clientNonce)` with 32 bytes from `crypto.getRandomValues` in base64url, and reads its code from `view_my_link_request`. (2) The browser opens the auth function with that code only. (3) After Discord confirms the user, the function calls `linker_present_code({ linkCode, provider: 'discord', providerId, providerName })` (named `server_link_by_code` and called with the delegate token in M5a; since M5a3 with the linker token). (4) The module resolves the code to the identity that asked and runs the merge; the browser's `view_my_profile` row changes on the same connection. No identity hex and no SpacetimeDB token leaves the browser.

**The code.** `generateLinkCode` (`helpers/identity/linkCode.ts`): SHA-256 (in-module; FIPS 180-4 vectors, and a recomputation with the runtime's Web Crypto, in the tests) over, in this order: the domain tag `hsr-link-code/v1` (16 ASCII bytes), the client nonce (43 ASCII bytes), the caller's identity (32 bytes, `Identity.toUint8Array`), the connection id (16 bytes, `ConnectionId.toUint8Array`; zeros without a connection), the transaction timestamp (microseconds, 8 bytes little-endian), the caller's previous code (32 ASCII bytes, or nothing) and the attempt counter (1 byte): 116 bytes, or 148 with a previous code. The code is the first 24 bytes of the digest in base64url without padding: 32 characters of `A-Z a-z 0-9 - _`. **The secrecy of the code rests on the client nonce**: 32 bytes from the browser's `crypto.getRandomValues` (a CSPRNG), sent as the reducer argument, checked for shape, never stored or logged. The connection id is a second secret input (the caller's SDK picks it at connect; the 2.15.0 browser SDK draws it with `Math.random`; no table or view exposes it). `ctx.random` is not used: on the host it is seeded from the transaction timestamp (SDK 2.15.0 `dist/server/index.mjs`, `get random() { return this.#random ??= makeRandom(this.timestamp); }`), so it would add only a function of the timestamp, which is already hashed. A primary-key clash re-draws with the next attempt (at most four).

**Provider name clean-up (shared merge).** `planProviderLink` removes C0 control characters, DEL and C1 control characters (U+0000-U+001F, U+007F-U+009F) from `providerName`, then trims it, then cuts it to 32 UTF-16 units (`capOnCodePoint`: one unit fewer when the cut would leave a lone high surrogate), then refuses an empty result ("providerName is required"). This applies to the presentation (pre-check and the stored pending name) and to `confirm_link`.

**Argument visibility.** The nonce travels only from the caller to the host. In SDK 2.15.0 (`dist/sdk/index.mjs`) the client sends `CallReducer { requestId, flags, reducer, args }`; only the caller gets a `ReducerResult` (request id, timestamp, outcome), and the client rebuilds the reducer event from its own stored call (`#reducerCallInfo`); every other subscriber gets a `TransactionUpdate { querySets }`, row changes only, no reducer name, caller or arguments. The module does not store the nonce, no view returns it, and no `console.log` in the link code path prints it.

**Single use.** (M5a; since M5a2 `usedAt` marks the presentation and the row is deleted by `confirm_link`.) The row of a successful link is deleted in the same transaction, not marked `usedAt`: missing and used are then the same state with the same refusal, and no used row is left to clean up. A refused link (step 3 or 4 of `linker_present_code`) throws, so the row stays and the code can be used again once the cause is gone, until it expires.

**Clean-up.** Stale rows are deleted (a) by `request_link_code`: the caller's own previous row, plus the rows whose `expiresAt` has passed (M5a read "expired or used"; since M5a2 `usedAt` marks a live pending row, so only `expiresAt` counts) among at most 64 rows of the table examined per call (`LINK_SWEEP_SCAN_LIMIT`; the scan stops after 64 rows whatever it finds); (b) by the scheduled `run_identity_gc`: the same among at most 10,000 rows per run (`LINK_SWEEP_GC_SCAN_LIMIT`, log line `[LINK_GC]`, no `GcResult` row); (c) by `performUserDeletion` (every row of the user, `user_id` index) and `server_nuke_test_data` (clear). `LinkRequest` has no `expiresAt` index, so (a) cannot pick stale rows first; (b) is the backstop.

**Known behaviour, open for a ruling.**
- Signing in to an account whose deletion is pending (soft-deleted, not banned) succeeds when the Discord account belongs to it (Case 1b re-points to it), unchanged from before M5a (user ruling 2026-11-13: left as it is). The window is short: `admin_delete_row('User')`, `admin_ban_user` and the ban found on reconnect schedule the `UserDeletionJob` 5 seconds out (`deleteAt = now + 5_000_000` µs); `delete_my_account` deletes at once, with no window. A ban also puts the Discord id in `BanRecord`, so a banned account is refused at presentation.
- `view_my_link_request` returns no row when the caller's user is gone, no longer a guest, linked or soft-deleted (M5a2 review): such a row can be neither used nor replaced, and it is left to the sweep (no deletion on read).
- A code requested before maintenance mode was switched on can still be presented during it on a linker connection opened before: `linker_present_code` runs no maintenance check of its own (the linker maps to no user, so there is no role to test). Since M5a3 a new linker connection is refused under maintenance (the `client_connected` gate admits only the Owner, Delegates and live Admins), while a presentation on a connection already open is accepted. Since M5a2 no link completes during maintenance either way: `confirm_link` refuses a non-Admin, and the pending row expires after 2 minutes. The browser cannot request a new code while maintenance is on (`request_link_code` refuses a non-Admin).
- The guest creation switch (`AbuseConfig.guestCreationEnabled`, A95(2)) also blocks sign-ins from a new browser: a fresh identity must call `login_as_guest` before `request_link_code`, and `login_as_guest` refuses a new identity while the switch is off, so a verified user on a new device cannot sign in until the switch is back on. A returning browser (its identity already mapped) is not affected.

**Abuse.** No per-user rate window: the identity reducers have none (the `UserRateState` windows cover chat, lobby membership, results, tournaments and lobby creation), and the unique `identity` caps each identity at one row. An attacker with many identities needs one guest per identity, which `login_as_guest` counts in the guest creation breaker (default 300 per 10 minutes, then the switch trips; A95(2), A109). Cost per call: one row of about 150 bytes for at most 5 minutes, one SHA-256 over 116 bytes, up to 64 rows read by the sweep; only the caller receives the row (the view is per caller).

## Phase M5a2 execution (the second lock)

**Goal.** The database links only when one browser holds both the requesting identity's connection and a one-time token given to the browser that finished Discord. The auth function alone can no longer complete a link.

**Flow.** (1) The guest calls `request_link_code(clientNonce)` and reads its code from `view_my_link_request`. (2) The browser opens the auth function with the code. (3) After Discord confirms the user, the function draws a confirm token (32 random bytes), calls `linker_present_code({ linkCode, provider: 'discord', providerId, providerName, confirmHash })` with the linker token (the delegate token until M5a3) and `confirmHash` = the hash below, and redirects the browser with the token (the function keeps nothing). (4) The view now shows `awaitingConfirm` and `pendingProviderName` ("about to link Discord account X"). (5) The browser calls `confirm_link({ confirmToken })` on its own connection within 2 minutes; the module links.

**What each party holds.**

| Party | Holds | What the module enforces about it |
|---|---|---|
| Requesting browser | its SpacetimeDB identity (connection), the code (until presented), the confirm token (after the redirect) | `confirm_link` acts only on the caller's own row (found by `ctx.sender`) and only with the token whose hash was presented. Which Discord account that is depends on the function: the module trusts the presentation |
| Auth function | the Linker token (M5a3; not the delegate token); the code and the Discord account during the request; the token only while redirecting | `linker_present_code` accepts only the Linker and writes no `User` row; the Linker passes no other guard (no user, admin or `server_*` reducer). Holding the token is still enough to sign in as any Discord-linked account (below) |
| Module | the code, the pending account, `confirmHash` (never the token) | |

**What the lock guarantees.** Against a correct auth function, a link by code completes only on the connection that requested the code, with the token whose hash was presented: `linker_present_code` no longer writes `User`; only `confirm_link` does, it reads the row of `ctx.sender`, and it needs the token. A token taken from the redirect is useless on any connection but the requesting one.

**The link token (M5a3; was "open, with the user (A175/A176)").** The function no longer holds the delegate token; it holds a Linker token, and `server_link_provider` is removed. What the narrow identity removed are only the direct powers of the old token: role changes (`server_set_role`), the admin and other `server_*` reducers, re-pointing identities by their hex, and linking without the requester's `confirm_link`. It did not make the link token a low-value secret. A holder of the link token can sign in as any account that has a Discord link, staff included: it requests a code as a guest of its own on another connection, presents that code with the target account's Discord id, and confirms on its own connection; Case 1b re-points its identity to that account. From there it acts with that account's role, Admin included. So the link token is a high-value secret, equal to "sign in as anyone", and is kept like the delegate token (Vercel secret, `.env.<target>.local`, never logged). This residual is inherent while the function is the only witness of Discord's answer. Reducing it further (for example approval of a new device for staff accounts) is open, with the user (A177). The delegate (and owner) token is still an Admin-level credential (`server_set_role`, the SYSTEM mapping), held by bootstrap and the scripts, not by the function.

**Requirements for M5b (the auth function and the page; from the M5a2 security review).**
1. The confirm token comes from a CSPRNG (32 bytes), is fresh for every presentation, and is never logged or stored by the function.
2. The token reaches the page only through a short-lived `Secure` `SameSite` cookie set on the callback response, or a same-origin fetch; never in a URL query or fragment.
3. The OAuth `state` is bound to a cookie set at start.
4. Start is reachable only by a same-origin POST with an exact `Origin` check.
5. The Discord authorize request uses `prompt=consent`.
6. The code travels only inside sealed, short-lived state.
7. The page confirms only after an explicit user action that shows the pending name, only for a flow this browser started, only while the row is unexpired by the page's own clock and the profile is still a guest, and clears the token after one attempt.
8. The page treats the view change as an insert plus a delete (the view row has no primary key) and tolerates two rows inside one callback.
9. The function sends the Discord handle (`username`) as `providerName`.
10. A slow first Discord login can exceed the 5-minute code window; the UI must handle the refusal and offer to start again.

**The confirm hash.** `confirmHash = base64url_nopad(SHA-256(token_bytes))` where `token_bytes` are the 32 bytes the token encodes (the token is their canonical base64url without padding, 43 characters; the hash is computed over the decoded bytes, not over the 43 characters). Node, for the function: `createHash('sha256').update(Buffer.from(token, 'base64url')).digest('base64url')`. Vector: token `AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA` (32 zero bytes) → hash `Zmh6rfhivXdsj8GLjp-OIAiXFIVu4jOzkCpZHQ1fKSU` (hex 66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925). Both fields must be canonical: the last of the 43 characters encodes 2 unused bits, which must be 0 (`AEIMQUYcgkosw048`); a non-canonical value is refused (`isBase64Url32`).

**Windows.** The code: 5 minutes from the request until its presentation. The confirm window: 2 minutes from the presentation. A new `request_link_code` replaces the row, pending or not, so starting again abandons a pending link and its token stops working.

**Clean-up.** A row is stale once `expiresAt` passes, before or after presentation (the sweep no longer reads `usedAt`); the inline sweep, the `run_identity_gc` backstop, `performUserDeletion` and `server_nuke_test_data` cover pending rows as before.

**Logs.** No log line carries the code, the nonce, the token or the hash: `linker_present_code` logs only the refusal reason, `confirm_link` logs nothing.

**Publish note (schema change).** The four columns are appended at the end of `link_request` as `t.string().optional().default(undefined)`. Evidence it migrates in place:
- The repo skill (`.claude/skills/spacetimedb/SKILL.md`, "Dangerous schema changes", from the 2.14.1 automatic-migrations doc) lists adding a column at the end of a table as safe when it has a default value, and adding one in the middle as the data-destroying case.
- SDK 2.15.0 writes a column's default into the module definition when the column metadata has a `defaultValue` key (`node_modules/spacetimedb/dist/server/index.mjs`, the `Object.prototype.hasOwnProperty.call(meta, "defaultValue")` branch that fills `defaultValues`), and `.default(undefined)` on an option column sets that key (None).
- Not verified locally: migration rules are enforced by the server (maincloud's version), and there is no local server here. A plain publish should migrate in place; if the server refuses, the table holds only short-lived rows, so a wipe is not needed for data, but the publish would need the server's answer first.
- Also unverified: an add-column publish may disconnect connected clients (the skill notes that some migrations do; whether this one does is the server's behaviour).

## Phase M5a3 execution (the linker identity; the direct link removed)

User rulings 2026-11-13: "For #1 I agree" (a narrow server identity for the function) and "yeah lets just use the new way, the old sign in does not need to stay" (the direct link removed).

- **Kinds.** `ServerIdentityKind` gains the variant `Linker`, appended after `Owner` and `Delegate`. Register / revoke: the sibling pair `server_register_linker(identityHex, label)` / `server_revoke_linker(identityHex)`, owner only (a kind argument on `server_register_delegate` would have changed its signature and the bootstrap call; the delegate pair is unchanged). A linker gets no `UserIdentity` row. `server_revoke_delegate` refuses a linker ("Only delegates can be revoked.") and `server_revoke_linker` refuses a delegate ("Only linkers can be revoked here.").
- **Guards.** `helpers/identity/serverIdentities.ts`: `trustedServerRow` (Owner or Delegate) behind `requireServer`, `seed_identity_gc_job`, `seed_lobby_gc_job` and the maintenance gate of `client_connected`; `requireLinker` behind `linker_present_code` (renamed from `server_link_by_code`: the `server_` prefix named the guard it no longer uses).
- **Lifecycle hooks for a linker.** `client_connected` finds no `UserIdentity` for it and returns before any write (no presence, no last-seen, no ban check, no lobby work); `client_disconnected` returns the same way. Under maintenance mode a new linker connection is refused, like any non-trusted client ("Maintenance mode: connections are not accepted right now."); the function should show the maintenance message. `linker_present_code` itself has no maintenance check, so a presentation on a linker connection opened before maintenance was switched on is accepted; `confirm_link` then refuses a non-Admin, so no link completes and the pending row expires after 2 minutes. Over HTTP the same hooks are expected to run around the call (not verified locally).
- **Removed.** `server_link_provider` (reducer, export, binding); the merge stays in `providerLink.ts` and is run only by `confirm_link` (`linker_present_code` runs `planProviderLink` as a pre-check). `parseIdentityHex` stays (the register / revoke reducers use it).
- **Schema / publish.** A new variant appended at the end of a sum type used by a column (`server_identity.kind`). No local server can confirm the migration; the repo's migration notes cover columns, not enum variants. The table holds two or three rows (Owner, Delegate, and now the Linker), so a wipe would cost nothing but the bootstrap re-run; a plain publish is expected to work and needs the server's answer. After the publish, bootstrap must run (it registers the linker and writes `STDB_LINK_TOKEN` / `STDB_LINK_IDENTITY`), and the Vercel function's secret becomes `STDB_LINK_TOKEN`.
- **Bootstrap and the linker (fix pass).** `scripts/stdb/_delegate.ts` `bootstrapLinker`, three cases, which the dry run names:
  - **keep** (the default when `.env.<target>.local` holds both `STDB_LINK_IDENTITY` and `STDB_LINK_TOKEN`): `server_register_linker` of that same identity as the Owner. After a wipe this restores it, and the token the function holds keeps working (the identity comes from the token, not from the database). When it is still registered the refusal "Already registered." means kept. Any other refusal stops bootstrap. Nothing is written or revoked.
  - **mint** (the file holds no linker, or only one of the two keys): a fresh identity is registered, both keys are written, then the identity the file named (if any) is revoked.
  - **rotate** (`--rotate-linker`): the same as mint while a linker exists.
  The delegate is still rotated on every run; the function does not hold it.
- **Release step: rotating the linker.** A rotation revokes the old linker at the end of the bootstrap run, so the deployed function cannot present codes until it holds the new token: sign-in is down from the revoke to the redeploy. Steps: run `npm run stdb:bootstrap:<target> -- --rotate-linker`, copy the new `STDB_LINK_TOKEN` from `.env.<target>.local` into the Vercel function secret of that environment, and redeploy the function. For a leaked token, rotate at once and accept the outage. For a planned rotation with no outage, the old linker must stay registered until the redeploy: register the new one, update the secret and redeploy, then revoke the old one by hand with `server_revoke_linker` (bootstrap has no flag for that order today).
- **Depth: a linker never maps to a user (fix pass).** `getAuthenticatedUser` does not check for a linker: that would add a `ServerIdentity` read to every authenticated reducer call. Instead every writer that creates a `UserIdentity` row refuses a linker identity: `login_as_guest` ("Forbidden: a linker identity cannot sign in as a user."), `server_register_delegate` ("Already registered.") and `server_register_linker` (refuses an identity that already has a mapping). `init` maps only the publisher; `confirm_link` re-points only the caller's existing mapping. A row written by hand (restore, `spacetime sql`) is not caught at call time. Tests: `__tests__/identity/provider-link-direct.test.ts`.

## Phase M5b execution (the login function, the local runner, the sign-in page)

Brief: the orchestrator's M5b brief (A46, A173 to A177; "Requirements for M5b" above). Contract entries are the orchestrator's; nothing here changes the module.

**Files.** `api/auth/discord/start.ts` and `callback.ts` (thin route shells); `api/_lib/{handlers,config,cookies,seal,outbound}.ts` (the logic; `_` folders are not routes); `shared/auth-flow.ts` (cookie names, lifetimes, the return words and the code / token shapes, shared by the function and the page); `scripts/local-auth/localAuth.ts` (the local runner); `web/vite-plugin-local-auth.ts` (dev mount). `web/src` never imports from `api/` or `scripts/`, and `api/` never imports from `web/` or `scripts/` (a type-only `@bindings` import would be allowed; none exists); no static import chain from `web/vite.config.ts` reaches `scripts/`; no `VITE_` name containing `SECRET` or `TOKEN` under `web/` (built site included) or in a tracked non-`.local` env file (`.env*.local` files are never opened); check:patterns gate 10 (only relative or root-resolved specifiers point into a folder, so `some-package/api` passes; planted proofs in the M5b log).

**Export shape.** Each route file exports the Web-standard method handlers Vercel's Node runtime calls with a `Request` and whose returned `Response` it sends (`export { handle as GET, handle as POST, … }`, all seven methods, so the handler itself answers 405). Imports carry `.js` extensions (TypeScript's ESM convention): Vercel compiles each `.ts` file to `.js`, tsc and Vite/Vitest map `.js` to the `.ts` source, and the local preview loads the handlers through `tsx` (a pinned dev dependency), which does the same. Not proven until a real deploy: that Vercel's builder picks up the named method exports for a non-Next project with `framework: null`, compiles `shared/*.ts` imported from `api/`, and runs on the Node version of `engines` (26.x; whether Vercel offers 26 is unverified).

**The app origin (fix pass).** The deployed function never trusts the request's URL (its host comes from the proxy and the `Host` header): its origin is the config value `AUTH_ORIGIN` (`https://<host>`, nothing else). The local runner, which answers only a loopback `Host`, uses its own address. Both the `Origin` check of start and every `redirect_uri` (authorize and token exchange) use that origin; the callback's `Location` values are paths.

**start** (`POST /api/auth/discord/start`, body `{ linkCode }`): 405 (`Allow: POST`) for other methods; 500 when the config is missing (read before the origin check, since the origin is config); 403 unless `Origin` equals the app origin exactly (scheme, host and port as text; no list, no pattern); 415 unless `Content-Type` is `application/json` (parameters allowed); 400 unless the body (at most 1 KB) is JSON with a 32-character base64url `linkCode`. Then a fresh 32-byte `state`, the sealed cookie, and `200 { url }`: Discord's authorize address with `response_type=code`, `client_id`, `scope=identify`, `state`, `redirect_uri` (the app origin + `/api/auth/discord/callback`), `prompt=consent`. The code is in no URL. Two starts never share a `state` or a sealed value (fresh state, fresh IV; unit tests).

**The sealed state.** `api/_lib/seal.ts`: AES-256-GCM, key = HKDF-SHA256(`AUTH_SECRET`, empty salt, info `hsr-pvp/auth-state/v1`, 32 bytes), a random 12-byte IV per seal; the value is `v1.` + base64url(IV | ciphertext | 16-byte tag) of `{ state, linkCode, createdAt }`. Unseal answers `malformed`, `invalid` (tampered, or another key) or `expired` (older than 10 minutes, or more than a minute in the future).

**callback** (`GET /api/auth/discord/callback`): 405 for other methods; 500 when the config is missing. `error=access_denied` with a cookie that unseals and carries the query's `state` gives `/?login=1&status=cancelled`; any other `error` (or `access_denied` without that binding), a missing `code`, `state` or cookie, a cookie that does not unseal, is older than 10 minutes, or whose state differs (constant-time compare, `timingSafeEqual` on equal lengths) gives `/?login=1&status=failed`. None of these makes an outbound call. **Clearing the state cookie (fix pass):** only when the request's cookie unseals and matches the query's `state`, or fails to unseal or is expired (useless anyway). A request with no cookie, or a live cookie with a wrong or missing `state`, redirects to `failed` and leaves the cookie alone, so a request another site makes the browser send cannot cancel a sign-in in progress (unit test: a forged return, then the real one still completes). Otherwise: the token exchange (form body: `grant_type`, `code`, the same `redirect_uri` built from the app origin, `client_id`, `client_secret`), `users/@me` with the access token, the id (17 to 20 digits) and the handle `username` (never `global_name`), a fresh 32-byte confirm token, `confirmHash` as defined above (the doc's vector is a unit test), and the presentation. Redirects are `303` with fixed `Location` values; both routes send `Cache-Control: no-store`; error bodies are generic JSON (`{ "error": "forbidden" }` and the like).

**Cookies** (all `__Host-`: `Secure`, `Path=/`, no `Domain`):

| Cookie | Set by | Attributes | Holds | Cleared |
|---|---|---|---|---|
| `__Host-hsr-auth-state` | start | `HttpOnly; SameSite=Lax; Max-Age=600` | the sealed state | by a callback answer whose request carried it with the matching `state`, or carried it broken or expired |
| `__Host-hsr-auth-confirm` | callback (`confirm`) | readable; `SameSite=Strict; Max-Age=120` | the confirm token | by the page before `confirm_link` (one attempt), on Cancel, on "took too long" |
| `__Host-hsr-auth-refusal` | callback (`refused`) | readable; `SameSite=Strict; Max-Age=120` | the module's text, cut to 200 UTF-16 units on a code point boundary, percent-encoded | by the page when shown |

`SameSite=Strict` for the two readable cookies: checked in Edge (Chromium) on `http://localhost:5173` (stub on `127.0.0.1`, a cross-site redirect chain) and `http://127.0.0.1:4173` (stub on `localhost`): the Strict cookie set on the callback's 303 is stored and `document.cookie` reads it on the page the redirect lands on. Firefox was not checked (Playwright's Firefox build is not installed on this machine); until it is, `Lax` is the fallback if Firefox does not expose the Strict cookie (one constant, `READABLE_COOKIE_SAMESITE` in `shared/auth-flow.ts`). `Secure` and `__Host-` cookies work on plain-http `localhost` and `127.0.0.1` in Edge; the page deletes the readable cookies with `Max-Age=0; Path=/; Secure; SameSite=Strict`.

**Calling the module over HTTP.** `POST https://maincloud.spacetimedb.com/v1/database/<db>/call/linker_present_code` (`<db>` from `STDB_DATABASES`), `Authorization: Bearer <STDB_LINK_TOKEN>`, `Content-Type: application/json`, body the five arguments as a JSON array in parameter order (`[linkCode, "discord", providerId, providerName, confirmHash]`; an object with the parameter names is accepted too). One attempt, 5 s timeout (`AbortSignal.timeout` on every outbound fetch), default `confirmed=true`. Observed on test1 (2026-11-14, harmless refused calls):

| Case | Status | Body (`text/plain`) |
|---|---|---|
| unknown code, linker token | 530 | `This link code is invalid or has expired.` (a `SenderError`) |
| no bearer (a fresh anonymous identity) | 530 | `Forbidden: caller is not the registered linker identity.` |
| a bad bearer | 401 | `Invalid token: InvalidToken` |
| wrong argument count | 400 | `invalid arguments for reducer linker_present_code: …` |
| success | 200 | empty (seen through the stubbed browser flow, `[auth] callback: confirm`) |
| maintenance | not observed (switching maintenance on is a maincloud write) | |

The function maps 2xx to `confirm`; 530 to `refused` with the text only when the answer is `text/plain` (parameters allowed), one line, at most 200 characters after trimming, and does not start with `Forbidden` (the function's own key is wrong); any other 530 (empty, `Forbidden…`, HTML, JSON, no type, multi-line, longer) is `failed` (`stdb_forbidden` or `stdb_body`); 401 / 403 and every other status, a timeout or a network error to `failed`. Under maintenance the connect hook refuses the linker's call (expected 530 with the maintenance text, which would then show as the refusal; unverified). **Connect hook:** the module log shows `client_connected` and `client_disconnected` for the caller's identity around every HTTP call; for the linker (and an anonymous caller) both return before any write.

**Config and target.** `readAuthConfig(env, { target, requireOrigin })` (`api/_lib/config.ts`) reads `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `AUTH_SECRET`, `STDB_LINK_TOKEN`, `STDB_TARGET` and, on the deployed function, `AUTH_ORIGIN` from one record. Every value is trimmed; an absent or whitespace-only value is missing; `AUTH_SECRET` must be at least 32 characters after trimming and not one character repeated (a floor only: the check cannot detect every weak value, so generate it randomly, for example 32 random bytes in base64url, a separate value per environment); `AUTH_ORIGIN` must be a bare `https://` origin (no path, query, credentials or trailing slash). **Target:** `VITE_STDB_TARGET` is a browser key, so the function reads the Node-side key `STDB_TARGET` (CLAUDE.md §5), and the caller fixes the only target it accepts: the deployed shells (`defaultDeps`) accept `prod` only (A174: Vercel is production only), the local runner `test` only; any other value counts as missing `STDB_TARGET`. The database name comes from `STDB_DATABASES[target]`. A missing or invalid key is "not configured": the deployed function answers 500 `{ "error": "server_error" }` and logs `[auth] <route>: auth is not configured (missing <key names>)`; the local runner answers 500 `{ "error": "not_configured", "missing": [<key names>], "message": … }` (`deps.local`).

**Logs.** One line per outcome: `[auth] start: ok | refused (method|origin|content_type|body)`, `[auth] callback: confirm | refused (module) | cancelled (access_denied) | failed (<reason>)`, reasons `query`, `no_cookie`, `cookie_malformed|invalid|expired`, `state_mismatch`, `discord_error`, `access_denied_unbound` (a cancel without the matching state), `discord_token_status|body|timeout|unreachable`, `discord_user_status|body|timeout|unreachable`, `stdb_forbidden|auth|status|body|timeout|unreachable`. No secret, code, state, token, hash, cookie or Discord id (unit test with `console` captured). The local preview logs method, path and status of the two routes, never the callback's query.

**Local runner** (`scripts/local-auth/localAuth.ts`, A175 item 1): mounts exactly `/api/auth/discord/start` and `/callback`, runs the same handlers, loads the four keys from the repo root's `.env.test.local` into the handlers' config record only (not `process.env`, not `import.meta.env`), and forces `STDB_TARGET=test`. Any app target but `test` makes both routes answer 503. A request whose `Host` is not `localhost` or `127.0.0.1`, with or without a port (the code accepts both; a browser omits the port only on port 80), gets 400. Missing keys are named in the start banner and in start's answer. `npm run dev`: the Vite plugin (added by `vite.config.ts` for the dev server only, `apply: 'serve'`, build tooling, never in the bundle) reads the target from `VITE_STDB_TARGET` (process, then env files) and loads the runner with `tsx`'s `tsImport` inside `configureServer` (fix pass): `scripts/` is not uploaded to Vercel, so no import chain from `web/vite.config.ts` may reach it (unit test with Vite's config loader; check:patterns gate 10, which also follows literal `import()`, `require()` and `import.meta.glob`; the plugin's path is a plain argument to `tsImport`, not an import expression). `npm run preview`: `preview.mjs` loads the runner with `tsx`'s `tsImport` and hands it to `serve.mjs`, which answers the two routes (any method) before its rules and adds `vercel.json`'s header rules to them; every other `/api/*` path stays 404.

**The Discord stub fence (verification only).** `HSR_LOCAL_DISCORD_STUB=http://127.0.0.1:<port>` (or `http://localhost:<port>`) in the shell of `npm run dev` / `npm run preview` points the three Discord endpoints at a local stand-in and fills missing Discord keys and `AUTH_SECRET` with throwaway values (the module call stays real). Only `scripts/local-auth/localAuth.ts` reads the variable; any other value is ignored with a banner line. `scripts/` is in `.vercelignore` and not in the web bundle; the deployed function's shells pass the fixed `DISCORD_ENDPOINTS` and have no parameter for another set; check:patterns gate 10 fails when the variable's name appears in `web/dist`, `web/src` or `api/`. On the page side (fix pass), a production build leaves only for `https://discord.com`; the loopback rule that lets a dev build follow the stand-in sits inside `import.meta.env.DEV` and gate 3 fails if it appears in `web/dist`, so the stub flow runs on `npm run dev` only. The stand-in itself lived in `tmp/m5b/` (not committed).

**Requirements for M5b, where met:** 1 (fresh CSPRNG token, never logged or stored): `handleCallback`; 2 (token only in a short-lived `Secure` `SameSite` cookie): the confirm cookie; 3 (state bound to a cookie): the sealed state; 4 (same-origin POST with an exact Origin check): `handleStart`; 5 (`prompt=consent`): `authorizeUrl`; 6 (code only in sealed state): the state cookie; 7 (explicit click, own flow, unexpired by the page's clock, still a guest, one attempt): `web/src/pages/sign-in/useSignIn.ts`; since the fix pass the handle is rendered from the live rows, the click re-checks the live row (same handle and expiry as first shown, the handle on screen), its expiry and the guest state, and a row that changes or disappears while the panel is open ends the flow without a call ("The sign-in changed in another tab."); 8 (keyless view as insert + delete): `useRows`; 9 (handle as `providerName`): `fetchDiscordUser`; 10 (slow login): "took too long" on return, and the module's expired-code text as a refusal.

**Known residual window on the confirm click (accepted for now; orchestrator's call, to be confirmed by the user).** The click re-checks the row in the tab's own client cache, which is only as fresh as that tab's subscription. If the same user runs two sign-ins in two tabs and the first tab's connection has stopped receiving updates but can still send, the first tab still shows the first Discord name while the shared cookie and the module's row already belong to the second flow; a click there would link the second tab's account under the first name. It needs the user's own two Discord logins in one browser, and no attacker can cause it (the token and the row are the user's own). Closing it would mean `confirm_link` also taking the `expiresAt` the page saw and refusing when it differs (a module change, not made at M5b).

**Other notes (fix pass).** The page leaves only for `https:` on `https://discord.com` (a `blob:https://discord.com/…` address has Discord's origin and is refused); the dev-only loopback rule requires `http:`. The start POST gives up after 10 s (aborted; "failed"), so a hung function cannot leave the panel disabled. A 530 text is shown only without any C0 / C1 control character, U+2028 or U+2029, and a text starting with "forbidden" in any case, after whitespace or zero-width characters, counts as the guard refusal (`failed`).

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
| One-time link codes: `request_link_code` (guest only, one row per identity, 5-minute code, inline sweep of 64 rows), `view_my_link_request`, `server_link_by_code` (one refusal text for unknown / used / expired; a refused merge throws its own text and leaves the code live; a successful link deletes the row); `request_link_code(clientNonce)`: the browser's 32-byte CSPRNG nonce is the secret input of the code (no `ctx.random`); `server_link_by_code` requires a Discord snowflake id; the shared merge strips control characters from the provider name and cuts it on a code point boundary; the merge moved to `planProviderLink` / `applyProviderLink`, shared with `server_link_provider`; link rows cleaned by `run_identity_gc`, `performUserDeletion`, `server_nuke_test_data` | Phase M5a execution (DECISIONS.md A44(3), A46) | 2026-11-13 |
| The second lock: `server_link_by_code` presents only (pending account, `confirmHash`, `usedAt`, 2-minute window; a ban, the live-game rule or an account change refused with their own text); new `confirm_link(confirmToken)` by the requesting identity links and deletes the row; `link_request` gains `pendingProvider`, `pendingProviderId`, `pendingProviderName`, `confirmHash` (appended, default None); `view_my_link_request` adds `awaitingConfirm` and `pendingProviderName`, hides the code once presented, never shows the hash or the provider id; the sweep keys on `expiresAt` only | Phase M5a2 execution | 2026-11-13 |
| The Linker server identity (`server_register_linker` / `server_revoke_linker`, owner only; no UserIdentity; refused by every reducer but `linker_present_code`, by `login_as_guest` and by the maintenance gate); `server_link_by_code` renamed `linker_present_code`, linker only; `server_link_provider` removed (`confirm_link` is the only linking reducer); bootstrap writes `STDB_LINK_TOKEN` / `STDB_LINK_IDENTITY`; the A175/A176 Admin-token note resolved | Phase M5a3 execution (user rulings 2026-11-13) | 2026-11-13 |
| Fix pass: the link token documented as a high-value secret (enough to sign in as any Discord-linked account; further reduction open, A177); bootstrap keeps the linker by default (registered again, restored after a wipe) and mints one only without a linker or with `--rotate-linker`, with the release step for a rotation; a linker never gets a user mapping (checked where mappings are created, not in `getAuthenticatedUser`); the merge branches no reducer reaches are pinned by direct tests | Phase M5a3 execution (security review fix pass) | 2026-11-13 |
| The login function: `start` (same-origin JSON POST, exact Origin, sealed AES-256-GCM state in a `__Host-` HttpOnly Lax cookie, `prompt=consent`) and `callback` (state check before any outbound call, Discord handle as provider name, `linker_present_code` over HTTP with the link token, confirm token in a 2-minute readable Strict cookie, module refusal text in a second one); target from `STDB_TARGET`; local runner on dev and preview (test only); no module change | Phase M5b execution | 2026-11-14 |
| Fix pass: the deployed function accepts the prod target only and takes its origin from the new `AUTH_ORIGIN` (Origin check and `redirect_uri`), config values trimmed, `AUTH_SECRET` not one repeated character; the callback clears the state cookie only for a matching or broken one (a forged return cannot cancel a flow) and `access_denied` cancels only with the matching state; a 530 is a refusal only as one line of `text/plain` of at most 200 characters; the dev plugin loads the local runner lazily (no build path into `scripts/`); the page renders the handle from the live row, re-checks it at the click and drops to "changed in another tab" when it changes, shows only a `SenderError` as a refusal, waits for the profile before starting, follows only `https://discord.com` in production | Phase M5b execution | 2026-11-14 |
| Last pass: `https:` required besides Discord's origin; 10 s limit on the start POST; refusal texts with control or separator characters, and "forbidden" in any case or behind zero-width characters, are `failed`; gate 10 reads imports with comments and strings masked, follows literal `import()`, `require()`, `import.meta.glob` and the `@/`, `@shared/`, `@bindings/` aliases; the residual two-tab window on the confirm click recorded as known (to be confirmed by the user) | Phase M5b execution | 2026-11-14 |
| The scheduled `run_user_deletion` and `run_identity_gc` refuse any caller but the scheduler (`ensureScheduler`, `ctx.senderAuth.isInternal`; L11); `admin_gc_identities` restarts a stopped `IdentityGcJob` chain (L6); a user deletion also removes the user's `LobbyCursorStamp` rows (L19) | Phase S11a execution (part 2, closing-triage items) | 2026-11-11 |
| `performUserDeletion` ends with `removeDeletedUserFromLeaderboard` (the user's `Leaderboard` rows of every season go; the active season is rebuilt when it held one); `client_connected` admits a live Admin under maintenance mode; `login_as_guest` and the profile reducers (`resolveUser`) refuse a non-Admin under maintenance mode | Phase S11a execution (DECISIONS.md A163(1), A163(3)) | 2026-11-12 |

---

*Last updated: 2026-11-14 (M5b)*
*Feature owner: Phase 01 / Phase 12 / Phase 16*

**Behavior specification** (acceptance scenarios, edge cases, phase history): See [contract.md](contract.md)
