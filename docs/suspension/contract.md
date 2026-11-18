# Account Suspension

## Feature Overview

Staff can lock an account without deleting it. An Admin (from the app, later from the admin page) or the server (the `manage-user` script) suspends a verified account by hand and lifts the suspension by hand; there is no end date. While suspended, the account cannot write anything, cannot read its own data, and cannot sign in with Discord; the person may still use the site as a visitor, like anyone without an account. A reason may be recorded for the admins' own record; it is never shown to the person. Nothing is deleted: tournament entries and public traces stay; a player in a live match becomes away as if they had pressed Leave, with no automatic forfeit. Decisions: DECISIONS.md A195, A213, A214, and A215 (the user's ruling of 2026-11-17 on Admin targets). Implementation: [architecture.md](architecture.md).

## Reducers

### admin_suspend_user

**Purpose:** suspend a verified account from the app.

**Permission:** Admin only.

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| userId | u32 | Yes | the account to suspend |
| reason | string | Yes (may be empty) | the admins' note, 0 to 500 characters (UTF-16 units) |

**Flow:**
1. The caller must be a live Admin who is not suspended.
2. The target must exist, and pass the checks in the table below, in that order.
3. A suspension row is written (reason, the Admin as `suspendedById`).
4. Each lobby seat of the target is handled as below ("Lobbies and matches").
5. The target's pending sign-in link requests are deleted; one log line is written (no reason).

**Expected State Changes:**
- `user_suspension` + one row (`userId`, `reason`, `suspendedById` = the Admin, audit columns).
- `lobby_member`, `lobby`, `chat_message`, `referee_transfer_check`, `lobby_cursor_stamp` as a Leave changes them, plus the immediate flag hand-over for a kept player row.
- `link_request` rows of the target deleted.

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Caller below Admin | "Forbidden: Requires Admin privileges." |
| Caller suspended | "Your account is suspended." |
| Unknown user id | "User #<id> not found." |
| Reason over 500 characters | "The reason must be 500 characters or fewer." |
| Target pending deletion | "This account is already pending deletion." |
| Target is the SYSTEM user | "The SYSTEM user cannot be suspended." |
| Target is the caller | "You cannot suspend yourself." |
| Target is a guest (no Discord link) | "Only a verified (Discord-linked) account can be suspended." |
| Target is an Admin | "An Admin cannot be suspended from the app." |
| Target already suspended | "This user is already suspended." |

### admin_lift_suspension

**Purpose:** lift a suspension.

**Permission:** Admin only; any suspended account, an Admin's included.

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| userId | u32 | Yes | the suspended account |

**Flow:** the caller is checked as above; the target must exist and be suspended; the row is deleted; one log line.

**Expected State Changes:** `user_suspension` row of the target deleted. Nothing else: an away player returns through `join_lobby` themselves.

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Caller below Admin | "Forbidden: Requires Admin privileges." |
| Caller suspended | "Your account is suspended." |
| Unknown user id | "User #<id> not found." |
| Target not suspended | "This user is not suspended." |

### server_suspend_user

**Purpose:** the server twin of `admin_suspend_user`, for `manage-user suspend`; the only way to suspend an Admin.

**Permission:** a registered server identity (Owner or Delegate). A Linker and every user are refused.

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| username | string | Yes | the account's username |
| reason | string | Yes (may be empty) | as above |

**Flow:** as `admin_suspend_user`, with the SYSTEM user as the actor (`suspendedById` 0); an Admin target is accepted.

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Caller not a server identity | "Forbidden: caller is not a registered server identity." |
| Empty username | "username is required" |
| Unknown username | "User \"<username>\" not found" |
| The other target and reason checks | as `admin_suspend_user`, without the Admin row |

### server_lift_suspension

**Purpose:** the server twin of `admin_lift_suspension`, for `manage-user unsuspend`.

**Permission:** a registered server identity.

**Parameters:** `username: string`.

**Error Cases:** "Forbidden: caller is not a registered server identity.", "username is required", "User \"<username>\" not found", "This user is not suspended."

### Every other user reducer

A suspended caller is refused with **"Your account is suspended."** and nothing changes. This covers every reducer behind the permission helpers, the four profile reducers (`delete_my_account` included: staff delete on request, A214(2)), `login_as_guest`, `request_link_code` and `confirm_link`. The check runs before the maintenance check, so a suspended Admin gets the suspension text during maintenance too (in `request_link_code` and `confirm_link` as well: there the suspension of a live user is checked first, then maintenance, then the missing and deleted account). `broadcast_cursor` is dropped silently (no event, no stamp).

### Discord sign-in

`linker_present_code` and `confirm_link` refuse a sign-in to a suspended account with **"This account is suspended."** (one short line, no date; the sign-in panel shows it after "Sign-in refused."). The guest that tried stays a guest.

## Views

### view_my_suspension

One row `{ userId }` for a caller whose account is suspended; no rows for anyone else (a visitor, a guest, any account that is not suspended). It never carries the reason, the staff member or a date. The client step shows the suspended screen while the row exists.

### view_admin_suspensions

The suspended accounts, for Admins (the `manage-user suspended` command, later the admin page). One row per suspended account: `userId` (primary key), `username`, `displayName`, `reason`, `suspendedById` (0 for a server call), `suspendedByUsername` ("SYSTEM" for 0; unset when the staff account no longer exists), `suspendedAt`. No rows for a Moderator, a user, a guest, a visitor, or a suspended Admin. An account pending deletion gives no row. Not part of the session-wide subscriptions.

### Every other per-caller view

A suspended caller reads exactly what a visitor with no account reads. Shared views and public tables are unchanged (A213(6), A214(6)).

### View audit

How each of the 80 views is covered. "callerUserId" means the shared helper in `helpers/identity/viewAnonymity.ts`; `callerMapping`, `callerMemberships` and `staffCaller` go through it.

| File | View | Resolves the caller through |
|---|---|---|
| identityViews | view_my_identity | callerMapping |
| identityViews | view_my_profile, view_my_link_request | callerUserId |
| identityViews | view_admin_user_private, view_admin_users | staffCaller |
| identityViews | view_public_hsr_accounts, view_user_by_username, view_user_achievements | anonymous (no caller) |
| identityViews | view_my_suspension | its own read (the exception) |
| identityViews | view_admin_suspensions | staffCaller, then an Admin role |
| lobbyViews | view_my_lobbies, view_my_lobby, view_my_lobby_chat, view_my_lobby_members, view_my_lobby_bans | callerMemberships |
| lobbyViews | view_lobby_presets | callerUserId |
| lobbyViews | view_lobby_browser | anonymous |
| matchViews | view_my_match_session, view_my_match_steps, view_my_match_participants, view_my_lineups | callerMemberships |
| matchResultViews | view_my_match_result, view_my_match_result_games | callerMemberships |
| matchResultViews | view_admin_stuck_games | staffCaller |
| matchHistoryViews | view_my_match_history, view_my_match_history_count, view_my_mmr_history | callerUserId |
| matchHistoryViews | view_my_match_history_participants, _steps, _games, _lineups | callerUserId (`callerPlayedIn`) |
| statsViews | view_my_player_stats, view_my_character_stats, view_my_mmr_ratings | callerUserId |
| socialViews | view_my_relationships, view_my_roster | callerUserId |
| socialViews | view_my_roster_visibility | callerMemberships |
| loadoutViews | view_my_loadouts | callerUserId |
| costSetViews | view_my_cost_sets, view_my_draft_character_costs, view_my_draft_lightcone_costs, view_my_draft_synergy_costs, view_cost_set_missing | callerUserId |
| costSetViews | view_published_cost_sets | anonymous |
| calendarViews | view_my_calendar_events, view_my_calendar_invites, view_my_availability, view_saved_calendar_availability, view_my_saved_calendars, view_event_attendees | callerUserId |
| adminViews | view_admin_user_identities, view_admin_ban_records, view_admin_deleted_users, view_admin_presence, view_admin_lobby_bans, view_admin_abuse_config | staffCaller |
| tournamentViews | view_my_tournaments, _enrolled, _teams, _team_members, _matches, _match_results, _lobbies, view_my_tournament_stand_ins | callerUserId (`staffTournamentIds`) |
| tournamentViews | view_admin_tournament and its six twins | callerUserId (`adminTournamentIds`) |
| tournamentViews | view_tournament_registrant_accounts, view_my_tournament_enrollment, view_my_team_requests, view_my_stand_ins, view_tournament_matches_for_me | callerUserId |
| tournamentViews | view_tournament_participants, view_tournament_teams, view_tournament_team_members, view_tournament_staff | anonymous |

## Lobbies and matches

At the moment of suspension, in the same transaction, each lobby seat of the account is handled as a Leave would handle it (A213(2), A214(6)):

| Seat | Outcome |
|---|---|
| Any seat in Waiting or AwaitingResult; a spectator or coach seat in any stage | the row is removed; host, captain and referee pass on; an emptied Waiting lobby is deleted; outside the live stages the "left the lobby" line is written |
| A player in Drafting, Equipping or Scoring | the row stays, marked away (as Leave: offline, the forfeit clock under Standard / Deferred, the "left the match" line); host, captain and referee pass on at once, not after 15 s |

No automatic forfeit (A68(3)): the existing absent-player rules (forfeit claim after the grace, defer, pause, timers) run unchanged. After a lift, the player may return through `join_lobby` while the lobby still exists.

The lobby rows written here (lobby, member rows, chat lines) carry the SYSTEM actor (0) in their audit columns, never the suspending Admin: the other members must not learn which staff member acted. The suspension row keeps the real Admin in `suspendedById`.

## Acceptance Scenarios

### Suspend from the app

**Given:** an Admin and a verified user.
**When:** the Admin calls `admin_suspend_user(userId, "spam in chat")`.
**Then:** a `user_suspension` row exists with that reason and the Admin as `suspendedById`.

### Lift from the app

**Given:** a suspended user.
**When:** an Admin calls `admin_lift_suspension(userId)`.
**Then:** the row is gone; the user writes and reads again.

### Suspend and lift from the server

**Given:** a verified user.
**When:** the delegate calls `server_suspend_user(username, "")`, then `server_lift_suspension(username)`.
**Then:** the row exists with `suspendedById` 0, then is gone.

### An Admin is suspended only through the server

**Given:** two Admins.
**When:** one calls `admin_suspend_user` on the other.
**Then:** refused, "An Admin cannot be suspended from the app."; through `server_suspend_user` the same target is suspended; an Admin lifts it with `admin_lift_suspension`.

### Refused write

**Given:** a suspended user.
**When:** they call any user reducer (lobby, draft, results, tournament, calendar, roster, stats, profile, sign-in).
**Then:** "Your account is suspended."; nothing changes. A cursor call is dropped silently.

### No reading

**Given:** a suspended user with rows in many per-caller views.
**When:** their views evaluate.
**Then:** each returns exactly what a visitor gets; `view_my_suspension` returns one row with their user id only. After a lift every view returns their rows again.

### Sign-in refused

**Given:** a suspended Discord-linked account.
**When:** a new browser signs in with that Discord account (`linker_present_code`), or a sign-in presented before the suspension is confirmed after it (`confirm_link`).
**Then:** refused with "This account is suspended."; the guest stays a guest.

### Waiting lobby

**Given:** the suspended user hosts a Waiting lobby.
**When:** they are suspended.
**Then:** their row is gone; the host and referee flags passed to another member; the "left" line is written; a lobby with no other member is deleted.

### Live match

**Given:** the suspended user is the host, referee and Blue captain in Drafting.
**When:** they are suspended.
**Then:** their row stays, away; host, referee and captain are held by others at once; the lobby stays in Drafting with no conceded result. After a lift, `join_lobby` returns them (no longer away).

### Tournament ties

**Given:** a suspended team captain in a tournament in progress.
**Then:** the entry, the team membership and the captaincy are unchanged.

### Ban, deletion, test wipe

**Given:** a suspended user.
**When:** they are banned (after the deletion job), deleted by the server, or `server_nuke_test_data` runs.
**Then:** the suspension row is gone with them.

### No staff id reaches the lobby (Phase suspension-s1 execution)

**Given:** a non-host player in a Waiting or Drafting lobby.
**When:** an Admin suspends them.
**Then:** no lobby, member or chat row of that lobby carries the Admin's id; the lobby's `lastModifiedById` is 0; the suspension row records the Admin.

### The suspended list (Phase suspension-s1 execution)

**Given:** two suspended accounts, one by an Admin with a reason, one by the server.
**When:** an Admin reads `view_admin_suspensions`.
**Then:** two rows with username, display name, reason, the suspending account (the Admin's username, or "SYSTEM" for 0) and the time; a Moderator, a user, a suspended Admin and a visitor read none. After a lift that row is gone; an account pending deletion gives no row.

### Listing from the script (Phase suspension-s1 execution)

**Given:** the delegate token of a target.
**When:** `manage-user --target <t> suspended` runs.
**Then:** it subscribes `view_admin_suspensions`, prints the rows as a table (a server suspension labelled "server") and closes.

## Edge Cases

| Case | Expected Behavior | Notes |
|------|-------------------|-------|
| Guest target | refused | A213(7): a guest is deleted as today |
| Target pending deletion (banned or deleted, before the 5 s job) | refused | the deletion removes everything anyway |
| SYSTEM user | refused, in both variants | the server identities act as SYSTEM |
| Admin suspends themself | refused ("You cannot suspend yourself.") | self is checked before the Admin rule |
| Admin target through the server | accepted | DECISIONS.md A215 |
| Reason empty | accepted | A214(5): optional |
| Suspended Admin during maintenance | "Your account is suspended." | the suspension check runs first |
| Already away player suspended | flags pass on at once; no second chat line | the Leave changes nothing on an away row |
| Abandoned seat | untouched | it never acts or returns (A68(4)) |
| Connection | not refused | A213(1): the person may browse as a visitor; the module cannot close a socket |
| Suspended Admin connecting during maintenance | refused at connect, as a non-Admin | Phase suspension-s1 execution; outside maintenance the connection is accepted |
| Two users holding one Discord id (should never exist) | the sign-in is refused when any of them is suspended | Phase suspension-s1 execution |
| `manage-user` with extra words (`suspend bob --reason spam in chat`, `suspend bob alice`) | refused with the usage text, nothing called | Phase suspension-s1 execution |
| `manage-user` with `--reason` twice, or a reason over 500 characters | refused by the script, the dry run too | Phase suspension-s1 execution |
| A reason that starts with `--` | must be written `--reason=<text>` | Phase suspension-s1 execution |

## Integration Points

| This Feature | Connects To | How | Direction |
|-------------|------------|-----|-----------|
| `user_suspension` | `getAuthenticatedUser` and the self-resolving reducers | one primary-key read | reads |
| `user_suspension` | per-caller views (`callerUserId`) | one primary-key read | reads |
| `suspendUser` | `leave_lobby` rules (`leaveMembership`), flag hand-over | shared helper | writes |
| `planProviderLink` | the Discord sign-in | refusal | reads |
| `performUserDeletion`, `server_nuke_test_data` | `user_suspension` | delete / clear | writes |
| `manage-user suspend / unsuspend` | `server_suspend_user`, `server_lift_suspension` | delegate token | calls |
| `manage-user suspended` | `view_admin_suspensions` | delegate token, subscription | reads |

## Open question

- Listing the suspended accounts from the script: no script reads a private table today (the scripts subscribe to public tables). Smallest options: (a) a staff view `view_admin_suspensions` (Admin only: user id, username, reason, suspendedById, date) that the script subscribes as the delegate, and that the admin page will need anyway; (b) a raw `spacetime sql` call by the database owner, outside the scripts. Resolved in the fix pass: option (a) (Phase suspension-s1 execution).

## Phase History

| Decision | Source | Date |
|----------|--------|------|
| A suspension feature as its own step; a suspended account can neither read nor write | DECISIONS.md A195 | 2026-11-17 |
| Visitor use allowed; live seats treated as a disconnect / Leave; Admin only from the app; public traces stay; guests cannot be suspended; script and admin page | DECISIONS.md A213 | 2026-11-17 |
| No end date, lifted by hand; no self-deletion while suspended; tournament entries untouched; reason optional, never shown; flags pass on at once; a ban or deletion removes the suspension | DECISIONS.md A214 | 2026-11-17 |
| An Admin cannot be suspended from the app; the server reducers can suspend any verified user except SYSTEM; `admin_lift_suspension` is open to any Admin for any suspended user | DECISIONS.md A215 (user ruling 2026-11-17) | 2026-11-17 |
| The exact texts; the check order in `getAuthenticatedUser` (after `deletedAt`, before maintenance); `login_as_guest` refused for a suspended mapping | Phase suspension-s1 execution (brief) | 2026-11-17 |
| `view_my_suspension` carries the user id only (no date: none is needed and the client shows none) | Phase suspension-s1 execution | 2026-11-17 |
| `suspendedById` is 0 (`SYSTEM_USER_ID`, the audit sentinel) for a server call, as the other server reducers' audit actor | Phase suspension-s1 execution | 2026-11-17 |
| "Verified" means not a guest and `loginMethod` 'discord'; checked after SYSTEM and self, before the Admin rule; reason length checked first | Phase suspension-s1 execution | 2026-11-17 |
| The Leave body moved to `leaveMembership` and shared with the suspension; an already away player gets only the flag hand-over; abandoned and orphan rows are left alone | Phase suspension-s1 execution | 2026-11-17 |
| `planProviderLink` also refuses a suspended requesting user (never true for a guest; one rule) | Phase suspension-s1 execution | 2026-11-17 |
| `client_connected` does not refuse a suspended identity | Phase suspension-s1 execution (research §1.3, A213(1)) | 2026-11-17 |
| `manage-user suspend` parses `--reason` itself and refuses it on other commands; the dry run prints the reason's length only; no `suspended` listing (open question) | Phase suspension-s1 execution | 2026-11-17 |
| Fix pass: the lobby-side writes of a suspension carry the SYSTEM actor, not the Admin (review M1) | Phase suspension-s1 execution | 2026-11-17 |
| Fix pass: `request_link_code` and `confirm_link` check a live user's suspension before maintenance (review M2) | Phase suspension-s1 execution | 2026-11-17 |
| Fix pass: during maintenance `client_connected` refuses a suspended Admin; outside maintenance a suspended identity still connects (review M3) | Phase suspension-s1 execution | 2026-11-17 |
| Fix pass: the sign-in refusal tests every user holding the Discord id (review M9) | Phase suspension-s1 execution | 2026-11-17 |
| Fix pass: `view_admin_suspensions` (Admin only, through `staffCaller`; an account pending deletion gives no row; "SYSTEM" as the username for actor 0) and `manage-user suspended`; the open question closed with option (a) | Phase suspension-s1 execution | 2026-11-17 |
| Fix pass: `manage-user` refuses extra positional arguments, a repeated `--reason` and a reason over 500 UTF-16 units (the dry run too) (review S1, M4) | Phase suspension-s1 execution | 2026-11-17 |
| Fix pass: a structural test pins where the module source reads `.sender` (review S2) | Phase suspension-s1 execution | 2026-11-17 |

---

*Last updated: 2026-11-17*
*Feature owner: step suspension-s1*
