# Account Suspension -- Architecture

Last updated: 2026-11-17 (suspension-s1: backend and the command line script, fix pass included; no client screen, no admin page)

## Overview

An Admin, or the server through the script, can suspend a verified account by hand and lift it by hand (DECISIONS.md A195, A213, A214; A215 on Admin targets). A suspended account cannot write (every user reducer is refused), cannot read its own data (every per-caller view answers as for a visitor), and cannot sign in with Discord. Public data stays readable by any connection, the module cannot close a live connection or cancel a token, and a cleared browser is a fresh visitor (A214(6)). Behaviour, texts and scenarios: [contract.md](contract.md).

## Table

```
User (id: u32 autoInc PK)
  +-- UserSuspension (userId: u32 PK)  [PRIVATE, name 'user_suspension']  (suspension-s1)
        userId -> User.id (one row per suspended user; row exists = suspended)
        reason: string (0-500 UTF-16 units; the admins' record only, never sent to the person)
        suspendedById: u32 (the Admin, or SYSTEM_USER_ID 0 for a server call)
        audit columns (createdById, createdDate, lastModifiedById, lastModifiedDate)
```

- File: `spacetimedb/src/tables/identity/userSuspension.ts`, registered in `schema.ts`. Additive: a new private table, no column change on any published table.
- No end time and no scheduled job (A214(1)): a view has no clock, and a suspension is lifted by hand only.
- No history table: lifting deletes the row; the module log keeps one line per suspend and lift (`[SUSPEND]`, `[UNSUSPEND]`; the reason is never logged).
- Cleared by `performUserDeletion` (a ban after its 5 s job, an Admin or server deletion) and by `server_nuke_test_data`.

## The check

`spacetimedb/src/helpers/identity/suspension.ts` holds the read side only (no lobby imports, so the permission helper and the view helper can import it): `isSuspended(ctx, userId)` (one primary-key read, `UserSuspension.userId.find`), `ensureNotSuspended(ctx, user)`, `SUSPENDED_TEXT`, `SUSPENDED_SIGN_IN_TEXT`.

| Where | Effect |
|---|---|
| `getAuthenticatedUser` (`helpers/identity/ensurePermissions.ts`) | after the `deletedAt` check, before the maintenance check: covers every reducer behind `getAuthenticatedUser`, `ensureAdmin`, `ensureModerator`, `ensureTournamentHost`, `ensureVerifiedUser`, `ensureTournamentPermission`. A suspended Admin is refused during maintenance too, with the suspension text |
| `resolveUser` (`reducers/identity/profile.ts`) | `delete_my_account`, `update_display_name`, `update_username`, `update_avatar` (A214(2): no self-deletion) |
| `login_as_guest` (`reducers/identity/auth.ts`) | an existing mapping to a suspended user is refused (one rule for every user reducer; a guest is never suspended) |
| `request_link_code`, `confirm_link` | the caller's own suspension, for a live user (`deletedAt` unset), before the maintenance check, as in `getAuthenticatedUser`; then maintenance, the missing user and the deleted user as before |
| `broadcast_cursor` (`reducers/lobby/cursor.ts`) | dropped silently, before the maintenance drop |
| `planProviderLink` (`helpers/identity/providerLink.ts`) | after the ban check: refuses when any user holding the Discord id (every row of `existingByProvider`, not only `providerOwner`) or the requesting user is suspended (`SUSPENDED_SIGN_IN_TEXT`); runs in `linker_present_code` (pre-check) and in `confirm_link` |

Reducers that resolve the caller outside `getAuthenticatedUser` and are not covered on purpose: the server reducers (`requireServer` / `requireOwner`: the SYSTEM user, which cannot be suspended), `linker_present_code` (`requireLinker`; covered through `planProviderLink`), the scheduled reducers (`ensureScheduler`) and the lifecycle hooks. `client_connected` does not refuse a suspended identity (A213(1): the person may still use the site as a visitor, and must connect to read `view_my_suspension`; a refused socket would only show as a dropped connection); their live rows already carry `leftAt`, which its restore loop skips. The one exception is maintenance: then only server identities and live Admins connect, and a suspended Admin is refused like a non-Admin (`isSuspended` added to the refusal condition).

The rule "only the shared helpers resolve the caller" is pinned by `spacetimedb/src/__tests__/identity/suspension-structure.test.ts`: it reads the module source and allows `.sender` under `views/`, `helpers/` and `reducers/` only in the listed files and counts (the helpers above, the self-resolving reducers, the server gates, two log lines). A new view or reducer that resolves its caller itself fails it, with a message naming the helpers to use.

## Views

`helpers/identity/viewAnonymity.ts`: `callerUserId(ctx)` and the new `callerMapping(ctx)` return undefined for an unmapped identity and for a suspended user. `callerMemberships` and `staffCaller` go through `callerUserId`. Every per-caller view resolves its caller through one of these four, so a suspended caller reads what a visitor reads. Changes in this step: the two local `callerUserId` copies (`views/tournamentViews.ts`, `views/matchHistoryViews.ts`) are removed in favour of the shared one, and the inline `UserIdentity.identity.find(ctx.sender)` reads in `identityViews` (3), `tournamentViews` (4), `costSetViews` (5), `lobbyViews` (1) and `matchResultViews` (1, now `staffCaller`) go through it. The anonymous views (`spacetimedb.anonymousView`) never see the caller and stay public. The full list: [contract.md](contract.md) "View audit".

`shouldAnonymize` (`helpers/identity/anonymousHelpers.ts`) still reads the caller's mapping directly; every view that reaches it has already returned `[]` for a suspended caller through `callerMemberships`.

### view_my_suspension

`views/identityViews.ts`. Per caller, `MySuspensionRow { userId: u32 PK }`: one row while the caller's account is suspended, none otherwise. It reads `UserIdentity.identity` and `UserSuspension.userId` directly (the one view that must answer a suspended caller). No reason, no staff id, no date (A213(5), A214(1)(5)): the client screen needs only "suspended or not". Egress: nothing for a caller who is not suspended.

### view_admin_suspensions

`views/identityViews.ts`, Admin only. `AdminSuspensionRow { userId: u32 PK, username, displayName, reason, suspendedById: u32, suspendedByUsername?: string, suspendedAt: timestamp }`.
- Caller: `staffCaller` (so `callerUserId`: a suspended Admin gets nothing, and the list holds their own reason), then `isRoleAtLeast(role, 'Admin')` (a Moderator gets nothing). The script's delegate maps to the SYSTEM user (Admin, never suspended) and passes; the Linker has no mapping.
- Read: only after the role check, a full read of `UserSuspension` (A37 exemption for admin views: small, tab-gated), one `User.id.find` per row for the name, one more for the suspending account.
- `suspendedByUsername`: "SYSTEM" for `suspendedById` 0 (a server call); the staff account's username otherwise; unset when that account no longer exists. The script, not the data, labels 0 as "server".
- `suspendedAt` is the row's `createdDate`. A target pending deletion (`deletedAt` set, or the `User` row gone) gives no row; the deletion removes the suspension within seconds.
- Not in Layer 0: the `manage-user suspended` command subscribes it, and the later admin tab will.
- Egress: nothing for anyone below Admin; for an Admin one short row per suspended account (the reason is at most 500 characters).

## Reducers

Shared logic: `spacetimedb/src/helpers/identity/suspensionActions.ts` (`suspendUser`, `liftSuspension`, the texts).

### admin_suspend_user(userId: u32, reason: string)

File `reducers/admin/suspensionAdmin.ts`. `ensureAdmin`; the target by `User.id.find` ("User #N not found."); `suspendUser(ctx, target, reason, admin.id, { fromApp: true })`.

### admin_lift_suspension(userId: u32)

Same file. `ensureAdmin`; the target; `liftSuspension` (deletes the row; "This user is not suspended." otherwise). Open to any Admin for any suspended user, an Admin included.

### server_suspend_user(username: string, reason: string), server_lift_suspension(username: string)

File `reducers/identity/server.ts`, behind `requireServer` (Owner or Delegate; a Linker and any user are refused). The target by `User.username.find`; actor `SYSTEM_USER_ID`. `fromApp: false`: an Admin target is accepted (the only way to suspend an Admin).

### suspendUser: checks, in order

1. `reason.length > 500`.
2. Target pending deletion (`deletedAt` set).
3. Target is the SYSTEM user.
4. Target is the actor.
5. Target is a guest or has no Discord link (`isGuest`, `loginMethod !== 'discord'`; A213(7)).
6. `fromApp` and the target's role is Admin (A215).
7. Already suspended.

### suspendUser: writes, one transaction

1. `UserSuspension` row (`insertWithAudit`, actor = the Admin or 0).
2. Every `LobbyMember` row of the target that is not abandoned, through `leaveMembership` (`helpers/lobby/memberLeave.ts`, the body of `leave_lobby` moved there unchanged, so the Leave rules live in one place):
   - Waiting, AwaitingResult, and any spectator or coach seat: `removeMemberRow` (flags handed over in the A22(5) order, accounts released, count decremented, an emptied Waiting lobby hard-deleted) and, outside the live stages, the "left the lobby" line;
   - a player in Drafting, Equipping or Scoring: `markMemberOffline` with `leftAt` (away, `disconnectedAt` under Standard / Deferred, the 15 s `RefereeTransferCheck`), the "left the match" line, the lobby's `lastActivityAt`. Then, unlike a Leave, `transferFlagsOnRemoval` at once (host, captain, referee) and `deleteCursorStamps`. An already away player gets the flag hand-over only.
   The actor passed to `leaveMembership` is `SYSTEM_USER_ID`, not the Admin: lobby, member and chat rows reach the other members, who must not learn which staff member acted. The `UserSuspension` row and the log line keep the real actor.
   No automatic forfeit (A68(3)); the forfeit claim, defer, pause and timer rules run unchanged. After a lift the player may return through `join_lobby` while the lobby lives (the A68(1)(2) return branch).
3. `deleteLinkRequestsOfUser`.
4. Log line.

Untouched: tournament entries, teams, captaincy, assistant and organizer roles (A214(3)); the leaderboard, public profile and shared views (A213(6)).

`leave_lobby` (`reducers/lobby/lobbyLifecycle.ts`) now calls `leaveMembership(ctx, lobby, member, user, user.id)` and keeps its two log lines; behaviour unchanged.

## Script

`scripts/stdb/manage-user.ts`: `suspend <username> [--reason "<text>"]` (`server_suspend_user`) and `unsuspend <username>` (`server_lift_suspension`), with `--dry-run` as the other commands (the dry run prints the reason's length, not its text). `--reason` is parsed by the script itself (the shared `_args.ts` parser knows boolean flags only) and is refused on any other command, when given twice, and when longer than 500 UTF-16 units (checked before the dry run, so the dry run reports it). A reason that starts with `--` must be written `--reason=<text>`. Every command takes an exact number of positional arguments (`set-role` 2, `delete` / `suspend` / `unsuspend` 1, `suspended` none); an extra word is refused with the usage text, so an unquoted reason (`--reason spam in chat`) or a second username fails instead of half-working.

`suspended`: connects as the delegate, subscribes `SELECT * FROM view_admin_suspensions` (`subscribeOnly` in `_connection.ts`), prints the rows as a text table on applied (user id, username, display name, suspended by, set at in UTC, reason; `suspendedById` 0 shown as "server"), and closes. `--dry-run` prints the subscription, the database and the env key name only.

## Cost

- Per reducer call: one extra primary-key read. Per view evaluation: one extra primary-key read.
- Storage: one short row per suspended account.
- Egress: `view_my_suspension` sends one 4-byte row to a suspended caller and nothing to anyone else.

## Cross-references

- Permission chain and sign-in: [auth architecture](../auth/architecture.md).
- Per-caller views: [views architecture](../views/architecture.md).
- Leave, away and flag hand-over: [lobby architecture](../lobby/architecture.md).
- Admin reducers: [admin architecture](../admin/architecture.md).
