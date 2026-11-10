# Admin & Server Operations -- Architecture

Last updated: 2026-11-06

## Overview

The admin feature covers privileged server operations: server identity bootstrapping, user management, ban enforcement, and generic row deletion/bulk upsert for game data tables. Trusted server identities gate all `server_*` reducers: the **Owner** (the publisher, registered by `init`) and the **Delegates** the owner registers with `server_register_delegate` (the bootstrap / auth-function token). Admin match tools (`admin_force_finalize`, `admin_void_match`) provide override capabilities for stuck or disputed matches; for tournament bracket matches the staff tools are `resolve_bracket_match` and `rollback_bracket_match` (`results` permission, Phase S8c execution, see below).

The SYSTEM user (`username='SYSTEM'`, id from autoInc, usually 1) is created by `init` and serves as the audit trail identity for bootstrap and server-initiated operations. Owner and delegates are linked to it through `UserIdentity`.

## Table Relationships

```
ServerIdentity (identity: Identity PK)  [PRIVATE -- public: false]
  +-- identity -> SpacetimeDB sender identity (hex)
  +-- kind: ServerIdentityKind (Owner | Delegate)
  +-- label: string
  +-- registeredAt: Timestamp

UserDeletionJob (scheduledId: u64 autoInc PK)  -- scheduled table
  +-- scheduledAt: ScheduleAt
  +-- userId -> User.id (user to cascade-delete)
  +-- audit columns

BanRecord (id: u32 autoInc PK)  [PRIVATE -- public: false]
  +-- banType: BanType (DiscordId)
  +-- providerId: string (the banned Discord snowflake)
  +-- reason: string
  +-- bannedByUserId -> User.id (admin who issued ban)
  +-- audit columns
  Indexes: ban_record_provider_id (btree, providerId)
```

## Reducer Flows

### init (lifecycle hook)
1. Runs on the first publish and every `--delete-data` republish; `ctx.sender` is the publisher
2. If `ServerIdentity` is empty: insert `ctx.sender` as `kind=Owner`, `label='owner'`
3. Create SYSTEM user: `username="SYSTEM"`, role=Admin, id from autoInc (audit actor `SYSTEM_USER_ID=0`)
4. Insert `UserIdentity` linking the owner identity -> SYSTEM user.id
5. Abuse controls (Phase S5 execution, D-B5 / A42), on every init, only when absent: `AbuseConfig` id 1 with the defaults (`seedAbuseConfigDefaults`, SYSTEM actor). Phase S6 execution (A57): no breaker job is seeded any more; the breaker runs inline in `create_lobby`
6. System lobby preset (Phase S6 execution, A33a / CH-S4), on every init, only when absent: one `LobbyPreset` with `isSystemPreset = true`, `creatorUserId = SYSTEM_USER_ID (0)`, name "Tournament default" (`seedSystemLobbyPreset`, helpers/lobby/systemPreset.ts; values in docs/lobby/architecture.md)

### server_register_delegate(identityHex, label) / server_revoke_delegate(identityHex)
1. `requireOwner(ctx)` -- only the Owner row may manage delegates
2. Register: insert `ServerIdentity` (`kind=Delegate`) + `UserIdentity` -> SYSTEM user; rejects duplicates
3. Revoke: delete the delegate's `ServerIdentity` and `UserIdentity` rows; the Owner cannot be revoked. Phase S10e execution (identity audit #5): the identity's `UserPresence` row is deleted too (a live row would otherwise keep the SYSTEM user online, since `client_disconnected` stops at the missing mapping)
4. Phase S10e execution (identity audit #1): identity GC never collects a `ServerIdentity` identity or a SYSTEM mapping (`docs/auth/architecture.md`)

### server_link_provider(identity, discordId, discordUsername, email?)
1. `requireServer(ctx)` -- validate caller has a ServerIdentity row (Owner or Delegate)
2. Look up `UserIdentity` by provided identity
3. Check ban: `rejectIfBanned(ctx, discordId)` -- reject if BanRecord exists
4. Three merge cases based on current state (see auth/architecture.md for case details)
5. Write `UserPrivate` (discordId, discordUsername, email), set `User.hasDiscordLinked=true`

### server_set_role(username, roleTag)
1. `requireServer(ctx)` -- validate caller has a ServerIdentity row (Owner or Delegate)
2. Find user by `User.username.find(username)` -- reject if not found
3. Validate roleTag against Role enum variants
4. `User.id.update()` with new role
Phase S10e execution (identity audit #9): the SYSTEM user is rejected after the lookup ("The SYSTEM user cannot be changed."); the server identities' admin rights come from its role.

### server_delete_user(username)
1. `requireServer(ctx)` -- validate caller has a ServerIdentity row (Owner or Delegate)
2. Find user by `User.username.find(username)` -- reject if not found; the SYSTEM user is rejected ("The SYSTEM user cannot be deleted.", Phase S10e execution, identity audit #9)
3. Call `performUserDeletion(ctx, userId, callerId)` -- same cascade as scheduled path

### server_set_mmr(userId, gameModeTag, rating) -- test databases only
1. `requireTestDatabase(ctx)` -- module env `STDB_TARGET` must be `test` ("Not a test database.")
2. `requireServer(ctx)` -- validate caller is in ServerIdentity table
2. Validate gameModeTag against GameMode enum variants
3. Upsert `MmrRating` row for userId + gameMode

### admin_delete_row(tableName, primaryKeyJson)
1. `ensureAdmin(ctx)` -- requires Admin role
2. Switch on `tableName` with table-specific guards:
   - `User`: soft-delete (set `deletedAt`), block if hosting/in active lobby or match step, schedule `UserDeletionJob` for 5s cascade. Phase S10e: the SYSTEM user is rejected ("The SYSTEM user cannot be deleted.")
   - `UserIdentity`: Phase S10e execution (identity audit #5): the key is the identity hex, parsed with `Identity.fromString` ("Invalid primary key for UserIdentity: expected an identity hex string") and found by PK; the mapping and the identity's `UserPresence` row are deleted; a guest left with no identity goes through `performUserDeletion` (admin actor). Fix pass (review N9): an identity with a `ServerIdentity` row is refused ("A server identity mapping cannot be deleted."), as is any mapping of the SYSTEM user ("A mapping of the SYSTEM user cannot be deleted."), the rows identity GC also keeps. Fix pass (review F5): when the user is not deleted and has no live `UserPresence` row left, each of the user's memberships that is online and not away / abandoned goes through `markMemberOffline` (admin actor): `isOnline = false`, `disconnectedAt` in a live stage under Standard / Deferred, the 15 s `RefereeTransferCheck` as for a disconnect (`client_disconnected` never runs for the deleted identity)
   - `HsrCharacter`, `HsrLightcone`: delete by name PK
   - `HsrCharacterCost`, `HsrLightconeCost`: iter-find by composite key
   - `HsrSynergyCost`: delete by autoInc id
   - `Archetype`: cascade-delete `HsrCharacterArchetype` junction rows first
   - `HsrCharacterArchetype`: delete single junction row by composite key
   - `Lobby`, `MatchSession`, `MatchSessionStep`, `MatchSessionHistory`, `MatchSessionStepHistory`: direct delete. **Changed in Phase S10e execution (identity audit #4):**
     - `Lobby`: `hardDeleteLobby` (the D-19 cascade close_lobby runs: result rows, lineups, chat, account selections, members, bans, password, steps, session, lobby). Fix pass (review F1, the `admin_void_match` guards, D.8.3 / D-56): a tournament-controlled lobby is refused ("This is a tournament lobby: use rollback_bracket_match or the tournament result reducers (results permission)."), and so is a lobby whose `MatchResultRecord` is Validated or has `mmrProcessedAt` ("This lobby's match result is Validated or already processed: use admin_void_match or override_match_result."); nothing is deleted. Other lobbies keep the full cascade
     - `LobbyMember` (key `{"lobbyId","userId"}`): `removeMemberRow` (flags handed over in the A22(5) order, `LobbyMemberAccount` rows deleted, `currentPlayerCount` decremented; an emptied Waiting lobby is hard-deleted). Fix pass (review F4, A68(6)): a seated player row (a team player seat, not a coach, not a spectator) is refused while the lobby is in Drafting, Equipping, Scoring or AwaitingResult ("Players cannot be removed once the draft has started; the match ends by result, concede or forfeit.", the `kick_member` text); coach and spectator rows, and every row in Waiting, still go through `removeMemberRow`
     - `MatchSession` / `MatchSessionStep`: refused while the lobby exists ("Cannot delete a {table} row of lobby #N while the lobby exists. Delete the Lobby row instead."); allowed for orphans
     - `MatchSessionHistory`: key through `parseNumericPk`
   - Identity audit #14: a malformed JSON key is a `SenderError` ("Invalid primary key for {table}: expected JSON"; fix pass, review N3: also valid JSON that is not an object or array, e.g. `null`, `5`, `"x"`); `admin_bulk_upsert` answers unparsable `jsonData` with "jsonData must be a JSON array"
   - Unknown table: `SenderError`

### admin_update_user(userId, displayName, username, roleTag)
Phase S10e execution (identity audit #9): rejects the SYSTEM user ("The SYSTEM user cannot be changed."). Otherwise unchanged (no field validation and no solo team-name sync yet: identity audit #11, open).

### admin_bulk_upsert(tableName, jsonData)
1. `ensureAdmin(ctx)` -- requires Admin role
2. Parse `jsonData` as JSON array
3. `validateKeys(rows, tableName)` -- every row must have exactly expected keys (audit cols excluded)
4. Switch on `tableName`:
   - `HsrCharacter`: validate path/element/role enums, upsert by name PK. If `maxPossible` changes, auto-recompute all account ratings (D-33)
   - `HsrLightcone`: validate path enum, upsert by name PK
   - `HsrCharacterCost`, `HsrLightconeCost`: validate gameMode enum, delete+insert (composite PK)
   - `HsrSynergyCost`: validate gameMode enum, upsert via id.update() on existing or insert new. Phase S10c execution (audit 2026-11-09): each row's `characterA` and `characterB` must be `HsrCharacter` rows, else `'Character <name> not found.'` (the whole payload is rejected); the seed (`scripts/stdb/_seed.ts`) upserts `HsrCharacter` in an earlier call
   - `Archetype`: upsert by name unique index
   - Unknown table: `SenderError`

### admin_update_user(userId, displayName, username, roleTag)
1. `ensureAdmin(ctx)` -- requires Admin role
2. Find user by id -- reject if not found
3. Validate `roleTag` against Role enum variants
4. If username changing: check uniqueness via `User.username.find()`
5. `User.id.update()` with new display name, username, role

### admin_ban_user(banTypeTag, providerId, reason)
1. `ensureAdmin(ctx)` -- requires Admin role
2. Validate `banTypeTag` is `'DiscordId'`; validate providerId non-empty and <=32 chars; validate reason non-empty and <=500 chars
3. Check for existing ban: `ban_record_provider_id.filter(providerId)` + in-memory banType filter (D-WR-01: multi-column index causes PANIC)
4. Insert `BanRecord` row
5. Find user via `UserPrivate.user_private_discord_id.filter(providerId)`, soft-delete if found (D-08 enforcement point 3)

### admin_unban_user(banRecordId)
1. `ensureAdmin(ctx)` -- requires Admin role
2. Find `BanRecord` by id -- reject if not found
3. Hard-delete the `BanRecord` row

### admin_force_finalize(lobbyId, winnerTeamId)
1. `getAuthenticatedUser(ctx)` + `ensureAdminOrOrganizer(ctx, user, lobby)` -- Moderator+ or tournament organizer/assistant
2. Find lobby -- reject if not in `AwaitingResult` stage (D-52)
3. Find `MatchResultRecord` via `lobby_id` index -- reject if not found
4. Reject if `mmrProcessedAt` already set (D-56)
5. Map `winnerTeamId` to `winnerTeamSide` (Blue/Red) via bracket match team slots
6. Update `MatchResultRecord` with winner and `Validated` status
7. Call `runFinalization(ctx, updatedResult, userId)` -- archives, writes stats/MMR, hard-deletes lobby

### admin_void_match(lobbyId)
1. `getAuthenticatedUser(ctx)` + `ensureAdminOrOrganizer(ctx, user, lobby)` -- Moderator+ or tournament organizer/assistant
2. Find lobby -- reject if not in `AwaitingResult` stage (D-53)
3. Find `MatchResultRecord` -- reject if `mmrProcessedAt` set (D-56)
4. Call `hardDeleteLobby(ctx, lobbyId)` -- erases match result and lobby without finalization

### Bracket corrections: resolve_bracket_match / rollback_bracket_match (Phase S8c execution, A24(3), A25, D.8.3)
`admin_set_bracket_winner` was removed (A23). Staff correct a tournament bracket with `resolve_bracket_match(bracketMatchId, winnerTeamId, reason)` (a Ready match is decided for the team, decidedBy Staff; a Decided match with another winner is rolled back, then decided) and `rollback_bracket_match(bracketMatchId, reason)` (a Decided match returns to Ready). Both need the tournament `results` permission (organizer, Moderator+, or an assistant with `canResolveResults`), an InProgress tournament, and refuse while a downstream match is Decided. They go through the single writer (`helpers/tournament/bracketResults.ts`); the parked record / lobby side (D.8.3) is S8d's. Reference: [brackets/architecture.md](../brackets/architecture.md) "Phase S8c execution".

### run_user_deletion(job) -- scheduled
1. Scheduled reducer, fires 5 seconds after `UserDeletionJob` inserted
2. Calls `performUserDeletion(ctx, job.userId, job.createdById)`:
   - Hard-delete active-state rows: UserIdentity, HsrAccountCharacter, HsrAccount, AvailabilitySlot, SavedCalendar, CalendarEventInvite, CalendarEvent
   - Lobby memberships (S8f fix pass 2, A68(6)(7)): removed as a leave, except a player's row in a live stage, which is kept away + abandoned; see [lobby/architecture.md](../lobby/architecture.md) "User deletion"
   - If user has history references: soft-delete (set username='deleted_\<id\>', clear discordId, preserve displayName)
   - If guest with no history references: hard-delete User row

### Abuse controls (reducers/admin/abuse.ts, helpers/lobby/abuseControls.ts; Phase S5 execution, DECISIONS.md A42, A43)
Tables: `AbuseConfig` (private singleton id 1, tunables + `maintenanceMode` + `guestLobbyCreationEnabled`), `UserRateState` (private, one row per user: chat and lobby-create windows), `AdminAlert` (**public**, counts only, no user ids, audit columns always SYSTEM), `AbuseCounter` (private, Phase S6 execution / A57: `key: string` PK, `windowStart`, `count: u32`, audit columns always SYSTEM; one row `'guest_lobby_create'`).
Defaults (D-B5): cursor 50 ms, chat 700 ms / 30 per minute, lineup 250 ms (no decided value; applied by `arrange_lineup` in S7), 10 lobby creates per hour, 10 presets, 5 cost sets, maintenance off, guest creation on, breaker 50 guest creations in 10 minutes (A58; was 20).
- `admin_update_abuse_config(...every column optional)`: `ensureAdmin`; omitted fields keep their value; at least one field required; `cursorMinIntervalMs`, `chatMinIntervalMs`, `lineupMinIntervalMs`, `guestLobbyBurstWindowMinutes` must be > 0 (a 0 would switch the guard off); `updateWithAudit` with the admin's id. Readers pick the change up on their next call.
- `admin_set_guest_lobby_creation(enabled)`: `ensureAdmin`; flips `guestLobbyCreationEnabled` (the admin-panel button; also re-enables after a breaker trip). Phase S10e execution (identity audit #6): a false -> true change (here or through `admin_update_abuse_config`) deletes `AbuseCounter['guest_lobby_create']` (`resetGuestLobbyCounter`), so the next guest creation opens a new window instead of re-tripping the breaker on the old count.
- Phase S10e execution (lobby audit #6): `UserRateState` gains `membershipWindowStart` / `membershipCount` (the per-user membership-change window, 20 changes per 10 s; joins, returns and seat moves; a leave is not counted since the fix pass, review N8; `docs/lobby/architecture.md`).
- `admin_acknowledge_alert(alertId)`: `ensureAdmin`; "Alert N not found." when absent; no-op when already acknowledged; sets `isAcknowledged=true`, `acknowledgedAt=now` with **SYSTEM** audit columns (public row, no user ids); the admin's id goes only to the module log.
- Inline circuit breaker (Phase S6 execution, A57 / A58; replaces the S5 scheduled breaker, which is deleted): `recordGuestLobbyCreation(ctx)` (helpers/lobby/abuseControls.ts) runs inside `create_lobby` for a **guest** caller after the kill-switch check passed. It bumps the fixed window `AbuseCounter['guest_lobby_create']` (a new window, count 1, opens when the stored one is `guestLobbyBurstWindowMinutes` old). When the new count exceeds `guestLobbyBurstThreshold` while the switch is on, the creation still succeeds, `guestLobbyCreationEnabled=false` (SYSTEM actor) and one `AdminAlert { kind: 'guest_lobby_burst', windowStartAt: counter.windowStart, windowEndAt: now, count, threshold, isAcknowledged: false }` is inserted, all in the same transaction. Later guest creations are rejected by the kill switch, so a trip writes one alert. Counts creations, not surviving lobbies; a rejected creation rolls its bump back. Cost: one PK read + one write per guest creation, nothing when idle.
- Cleanup: `performUserDeletion` deletes the user's `UserRateState` row; `server_nuke_test_data` clears `UserRateState`, `AbuseCounter` and `AdminAlert` and keeps `AbuseConfig`.
- Not here: the GitHub Actions notifier that reads `AdminAlert` (S13 companion). `view_admin_abuse_config` landed in Phase S9b execution (below).

### Game close and closed-game edits (Phase S7b execution, DECISIONS.md A60(4)(7))
Two admin-side tools of the game package; the full reference is `docs/match-results/architecture.md` "Game package".
- **Staff close** `close_game(lobbyId, winnerOverride?, winnerOverrideReason?)`: lobby referee, Moderator+, or tournament organizer / assistant with `canResolveResults` (`resultAuthority`) closes the current game at any time, with or without the captains' ready flags; since DECISIONS.md A63 `close_game` is also the captains' submit once both flags are set, but only the staff set may pass `winnerOverride` to decide a level-4 tie (A39 seating rule at the close).
- **Admin edit of a closed game**: role Admin exactly (`isAdminRole`; Moderators are rejected with "This game is closed.") may call `record_group_scores`, `set_score_adjustment`, `set_eidolon`, `equip_lightcone`, `arrange_lineup` on the current game while the record is Pending or Submitted; no stage check, no throttle, confirmations untouched, then `recomputeSeriesAfterAdminEdit` (tie or undone series → reject; Submitted winner follows the tally). _Phase S10b execution (DECISIONS.md A78): `equip_lightcone` and `unequip_lightcone` take `teamSide` on this path too._

## Phase 15 -- Backend pre-work

<!-- Phase 15 D-05, D-05a: Spine + positioning columns on hsr_character -->

### HsrCharacter schema additions (D-05, D-05a)

Six new columns on `hsr_character` support Spine rigs (Phase 31 Pedestal) and card positioning (image_url rendering):

| Column | Type | Semantics |
|--------|------|-----------|
| `skelUrl` | `string optional` | Spine skeleton URL; `null` = no Spine for this character |
| `atlasUrl` | `string optional` | Spine atlas URL; `null` = no Spine |
| `atlasImgUrls` | `array<string>` | Atlas page image URLs; `[]` = no Spine (arrays cannot be optional in SpacetimeDB) |
| `posX` | `i32` | Card positioning X offset (required, default `0`) |
| `posY` | `i32` | Card positioning Y offset (required, default `0`) |
| `width` | `i32` | Card positioning width (required, default `0`) |

Bindings expose all six columns in `src/module_bindings/hsr_character_type.ts` after `spacetime generate`. `HsrLightcone` already had `posX`/`posY`/`width` — no schema change there; router partial-update fix applies.

### admin_bulk_upsert -- partial-update wire convention (D-08, D-10, D-12)

<!-- Phase 15 D-08: null-preserve semantics on existing rows -->

The router reducer `admin_bulk_upsert` reworked for **true partial updates** across all 5 game-data cases (`HsrCharacter`, `HsrLightcone`, `HsrCharacterCost`, `HsrLightconeCost`, `HsrSynergyCost`). Wire convention:

- Every `EXPECTED_KEYS` entry must appear in the incoming JSON row (strict `validateKeys` contract -- preserved).
- **`null` on an EXISTING row** = "preserve this field" (do not overwrite).
- **`null` on an INSERT row** = "apply schema default" (required columns) OR "stay null" (optional columns like `skelUrl`, `atlasUrl`).
- **Non-null value** = "set to this value".

Implementation: `mergeForUpdate<T>()` (in `admin.ts`) returns a new row with existing values preserved where incoming is `null` or `undefined`, and asserts every expected key is present (validateKeys defensive guard). `validateEnumIfPresent()` (in `admin.ts`) skips enum validation for null-valued fields on update (preserve-existing path). The insert branch retains its default-injection logic (per D-12) so schema-required fields still get sensible defaults on new rows.

**Before (pre-Plan-03 bug):** the router built full rows with aggressive default injection (`r.imageUrl || ''`) and spread them over existing rows, silently zeroing every unsent field. The reworked router only merges keys whose value is non-null/non-undefined on the update branch.

### Cost-set PK tuple match fix (D-09)

<!-- Phase 15 D-09: full composite tuple on existence check -->

For the three cost tables, the existence check now matches on the full composite tuple including `costSetId`:

- `HsrCharacterCost`: `(characterName, gameMode.tag, costSetId)` -- see `admin.ts` HsrCharacterCost case
- `HsrLightconeCost`: `(lightconeName, gameMode.tag, costSetId)` -- see `admin.ts` HsrLightconeCost case
- `HsrSynergyCost`: `(sourceName, targetName, gameMode.tag, costSetId)` -- see `admin.ts` HsrSynergyCost case

Previous behavior matched on `(characterName, gameMode)` only, silently overwriting non-default cost sets (e.g. `costSetId=5`) when the default set (`costSetId=0`) was upserted. The fix preserves the `costSetId=0` default-set sentinel (v0.5 convention) while allowing an arbitrary number of custom cost sets per `(name, mode)` pair to coexist.

`HsrCharacterCost` / `HsrLightconeCost` use a delete+insert pattern (no direct composite-PK update accessor in the generated bindings) -- audit columns cascade via `auditUpdate`. `HsrSynergyCost` uses `id.update()` because its PK is auto-inc `id`.

### Regression coverage (D-21)

- `test/backend/reducers/admin/partial-update.test.ts` -- asserts unsent null fields on `HsrCharacter` / `HsrLightcone` partial updates preserve originally-seeded values.
- `test/backend/reducers/admin/cost-set-pk.test.ts` -- asserts distinct `costSetId` rows coexist for all three cost tables; specific regression for the "default-set-overwrites-custom-set" live bug.
- `test/backend/seed/round-trip.test.ts` -- D-21a clean-DB reseed round-trip; asserts Spine + positioning columns populate on `hsr_character` and all three cost tables contain all 3 game modes.

## Phase S8d execution (ACCESS-SECURITY-OPS §D.8.3, DECISIONS.md A24)

`admin_force_finalize` and `admin_void_match` reject tournament-controlled lobbies before any other check, pointing
at `resolve_bracket_match` / `validate_match_result` (force-finalize) and `rollback_bracket_match` (void), all
`results`. Standalone lobbies keep their behaviour; the force-finalize `winnerTeamId` is 1 = Blue, 2 = Red. Both read
the lobby's one record (`findLobbyResult`, A54). `process_tournament_mmr` is deleted (tournament MMR runs in the
finalize job). New staff reducer: `validate_match_result` (see [../match-results/architecture.md](../match-results/architecture.md)).
New Moderator+ reducer: `admin_restart_tournament_finalize(tournamentId)` re-inserts a stopped finalize job (a tick
that threw); rules in [../tournament/architecture.md](../tournament/architecture.md).


## Phase S8e execution (DECISIONS.md A67(3)(4))

- **override_match_result on a tournament record** (rule as implemented). Preconditions as in S8d (tournament
  InProgress; record Submitted, Disputed or Validated; its lobby present). A Decided bracket match is first reverted by
  `rollbackBracketResult(…, voidDeciding = false, redecide = false)` (every Validated game record and its lobby stay;
  refused while a downstream match is Decided: "<key> is decided; roll that back first."). Then the record is updated as
  before (Validated(winner): status, `winnerTeamSide`, `matchEndReason = Completed`, `settledAt`; Rejected: lobby voided,
  status kept Rejected) and `recordGameSettled(ctx, record, 'Staff', actor)` recomputes the derived tally and re-runs
  the decide check: a Ready match is decided (decidedBy Staff) when a side reaches ceil(bestOf / 2); otherwise only
  the tally changes (TD-13/14: override = revert + re-apply through the single writer). Standalone records unchanged. The Ranked screenshot
  check names "the game" (one game per record).
- **admin_delete_row(MatchSessionStepHistory)**: the key is the JSON pair `[matchHistoryId, sequence]` (A67(3)).
- **Admin edits of a closed game (A60(7))**: the edit reducers take no game number; the record's one game is edited
  while the record is Pending or Submitted ([../match-results/architecture.md](../match-results/architecture.md)).

## Phase S9b execution (DECISIONS.md A37, A40, A43, A44, A48)

Staff views for the admin panel (`views/adminViews.ts`; PAGE-MAP D6 and adminpanel "after S9"). Each is per-sender and
returns `[]` unless the caller's role is Moderator or above (`staffCaller` in `helpers/identity/viewAnonymity.ts`); staff
are never an anonymous context, so ids and names are real. Each listing reads its whole table with `.iter()` only after
the role check (A37 exemption for admin views: small tables, tab-gated), so a non-staff caller gets `[]` without touching
the table; the panel subscribes each view while its tab is open. No `.iter()` in any view a non-staff client can subscribe.

| View | Row | Index |
|---|---|---|
| `view_admin_user_identities` | identity (PK), userId, lastSeenAt (UserIdentity has no kind column; the Owner and Delegate server identities appear under the SYSTEM user's id) | full read |
| `view_admin_ban_records` | id (PK), loginMethod, providerId, reason, bannedByUserId, bannedByLabel, createdDate | full read |
| `view_admin_deleted_users` | id (PK), displayName, isGuest, deletedAt | full read |
| `view_admin_presence` | identity (PK), userId, isOnline, lastLoginAt, lastSeenAt (A48: replaces `User.isOnline` / `lastLoginAt`; "online" = any live row of the user) | full read |
| `view_admin_lobby_bans` | lobbyId, bannedUserId, bannedJoinSeq, bannedUserLabel, bannedByUserId, bannedByLabel, createdDate (the In-Cell `lobby_ban` grid lifts a ban with `unban_member(lobbyId, bannedJoinSeq)`, A74(2)) | full read |
| `view_admin_abuse_config` | the `AbuseConfig` singleton (PK `id`), every column but the audit ones, incl. `guestLobbyCreationEnabled` (A42 kill switch) and `maintenanceMode`; Moderator+ reads, only an Admin writes | `AbuseConfig.id` |
| `view_admin_user_private` (identityViews, re-checked) | userId (PK), loginMethod, providerId, providerUsername; no audit columns | full read |
| `view_admin_stuck_games` (matchResultViews, S9a) | unchanged | — |

Not built: `view_admin_lobbies`, `view_admin_match_results`, `view_admin_match_history` (ACCESS-SECURITY-OPS Appendix B
lists them as trimmable; PAGE-MAP's adminpanel section, authoritative by A44(1), does not use them). The Users tab's
public `User` subscription is the only `User` subscription in the app (PAGE-MAP D2).

## Phase History

| Decision | Source | Date |
|----------|--------|------|
| Server registration is first-come-first-served; SYSTEM user id=1 created on bootstrap (replaced in M2) | Phase 01 execution | 2026-02-01 |
| User deletion is always async (5s delay via UserDeletionJob) to avoid blocking transaction | Phase 01 execution | 2026-02-01 |
| admin_bulk_upsert validates field keys per table (EXPECTED_KEYS map) and rejects unknown fields | Phase 02 execution | 2026-02-10 |
| admin_delete_row guards User deletion: blocks if hosting/in active lobby or match | Phase 02 execution | 2026-02-10 |
| admin_force_finalize, admin_void_match, admin_set_bracket_winner added (D-52, D-53, D-54) | Phase 09 execution | 2026-03-28 |
| BanRecord table added [PRIVATE]; ban enforcement at three points (link, reconnect, ban-time) (D-08) | Phase 12 execution | 2026-04-05 |
| Multi-column index on BanRecord causes PANIC in SpacetimeDB TS SDK; use single-column index + in-memory filter (D-WR-01) | Phase 12 execution | 2026-04-05 |
| HsrCharacter bulk upsert auto-triggers account rating recalc if maxPossible changes (D-33) | Phase 11 execution | 2026-04-01 |
| Normalized to standard template | Phase 13 normalization | 2026-04-09 |
| hsr_character: added 6 columns (skelUrl, atlasUrl, atlasImgUrls, posX, posY, width) for Spine + card positioning (D-05, D-05a) | Phase 15 execution | 2026-04-13 |
| admin_bulk_upsert: null-preserve partial-update wire convention across 5 cases; mergeForUpdate + validateEnumIfPresent helpers (D-08, D-10, D-12) | Phase 15 execution | 2026-04-13 |
| Cost-table existence checks match on full composite tuple including costSetId; fixes silent default-set overwrite (D-09) | Phase 15 execution | 2026-04-13 |
| `init` registers the Owner + SYSTEM user; owner-only `server_register_delegate` / `server_revoke_delegate`; `server_set_*` test utilities and `server_nuke_test_data` gated by `requireTestDatabase` | Phase M2 execution | 2026-11-06 |
| Abuse controls: `init` seeds `AbuseConfig` + `AbuseBreakerJob`; `admin_update_abuse_config`, `admin_set_guest_lobby_creation`, `admin_acknowledge_alert`; scheduled `run_abuse_breaker` (5 min) trips the guest kill switch and writes one `AdminAlert`; `performUserDeletion` / `server_nuke_test_data` clean the new tables | Phase S5 execution (DECISIONS.md A42, A43) | 2026-11-06 |
| Breaker inline in `create_lobby` on the private `AbuseCounter` fixed window (default 50 in 10 minutes); the S5 scheduled breaker reducer, its job table and its `init` seed deleted; `init` seeds the system lobby preset; `server_nuke_test_data` clears `AbuseCounter` and re-seeds the system preset | Phase S6 execution (DECISIONS.md A57, A58, A33a) | 2026-11-06 |
| Staff close (`close_game`) and Admin edits of a closed game (role Admin, record Pending or Submitted, current game) as admin tools; cross-reference to match-results "Game package" | Phase S7b execution (DECISIONS.md A60) | 2026-11-07 |
| Staff close restated for A63: `close_game` is the submit (captains once both are ready, staff at any time); only staff decide a tie | Phase S7b follow-up (DECISIONS.md A63) | 2026-11-07 |
| `admin_set_bracket_winner` removed; `resolve_bracket_match` / `rollback_bracket_match` (`results`) are the staff bracket tools | Phase S8c execution (DECISIONS.md A23, A24(3), A25) | 2026-11-07 |
| `admin_force_finalize` / `admin_void_match` reject tournament lobbies with a pointer; `process_tournament_mmr` deleted; `validate_match_result` added (D.8.3, A24) | Phase S8d execution | 2026-11-07 |
| `override_match_result` on a tournament record: Decided match rejected ("roll back first"), then `recordGameSettled` recomputes the derived tally (decidedBy Staff); `admin_delete_row` step-history key `[matchHistoryId, sequence]` (A67(3)(4)) | Phase S8e execution | 2026-11-08 |
| Six Moderator+ admin views (`view_admin_user_identities`, `_ban_records`, `_deleted_users`, `_presence`, `_lobby_bans`, `_abuse_config`); `view_admin_user_private` without audit columns (staff-only full reads after the role check); three Appendix B admin views not built | Phase S9b execution (DECISIONS.md A37, A40, A43, A44, A48) | 2026-11-08 |
| `view_admin_lobby_bans` carries `bannedJoinSeq`; the In-Cell `lobby_ban` grid passes it to `unban_member` | Phase S9c execution (DECISIONS.md A74) | 2026-11-08 |
| `admin_delete_row`: Lobby through `hardDeleteLobby`, LobbyMember through `removeMemberRow`, MatchSession / MatchSessionStep only for orphans, UserIdentity by PK with its presence row (guest left without identity deleted), SYSTEM user protected, JSON keys guarded; re-enabling guest lobby creation resets the breaker counter; revoking a delegate deletes its presence row | Phase S10e execution (identity audit #4, #5, #6, #9, #14) | 2026-11-09 |
| Fix pass: `admin_delete_row('Lobby')` refuses tournament lobbies and Validated / processed records; `admin_delete_row('LobbyMember')` refuses a seated player in the live stages and AwaitingResult; `admin_delete_row('UserIdentity')` refuses server identities and SYSTEM mappings and takes a user left with no live presence offline in their lobbies; non-object JSON keys rejected; `admin_delete_hsr_account`'s lobby guard ignores abandoned memberships | Phase S10e execution (review F1, F3, F4, F5, N3, N9; DECISIONS.md A68(6)) | 2026-11-09 |

---

*Last updated: 2026-11-09*
*Feature owner: Phase 01 / Phase 09 / Phase 12 / Phase 15*

**Behavior specification** (acceptance scenarios, edge cases, phase history): See [contract.md](contract.md)
