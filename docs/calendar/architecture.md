# Calendar & Scheduling -- Architecture

Last updated: 2026-04-09

## Overview

The calendar feature lets players set recurring or one-time availability slots, save other players' calendars as bookmarks, and create scheduled events with invites. Tournament organizers can link events to bracket matches, which auto-invites all active team members. Common-availability computation is client-side from subscribed slot data. All cascade deletions (tournament cancel, bracket rollback, user deletion) run in the same transaction as the triggering reducer.

## Table Relationships

```
User (id: u32 autoInc PK)
  +-- AvailabilitySlot (id: u32 autoInc PK)
  |     userId -> User.id  [btree: user_id]
  |     startAt: Timestamp (base window, always UTC)
  |     endAt: Timestamp
  |     isRecurring: bool
  |     recurrenceRule: RecurrenceRule struct
  |       .recurrenceType: RecurrenceType (Daily | Weekly | Monthly)
  |       .interval: u8 (1=every period; 0=sentinel for non-recurring)
  |       .dayOfWeek: u8? (0-6; 255=not set sentinel)
  |       .dayOfMonth: u8? (1-31; 0=not set sentinel)
  |       .endDate: Timestamp?
  |     expiresAt: Timestamp (6mo from creation for recurring; equals endAt for one-time)
  |     audit columns
  |
  +-- SavedCalendar (PK: [userId, targetUserId])
  |     userId -> User.id (subscriber)  [btree: user_id]
  |     targetUserId -> User.id (whose calendar)
  |     isVisible: bool (toggle without deleting, D-16)
  |     audit columns
  |     Indexes: user_id (btree), by_user_and_target (btree, [userId, targetUserId])
  |
  +-- CalendarEvent (id: u32 autoInc PK)
  |     organizerId -> User.id  [btree: organizer_id]
  |     title: string
  |     description: string? (optional, D-26)
  |     startAt: Timestamp
  |     endAt: Timestamp
  |     bracketMatchId: u32? -> BracketMatch.id  [btree: bracket_match_id]
  |     audit columns
  |
  +-- CalendarEventInvite (PK: [eventId, inviteeUserId])
        eventId -> CalendarEvent.id  [btree: event_id]
        inviteeUserId -> User.id  [btree: invitee_user_id]
        inviteStatus: InviteStatus (Pending | Accepted | Declined | Tentative)
        respondedAt: Timestamp? (D-02)
        audit columns
        Indexes: event_id, invitee_user_id, by_event_and_invitee (btree, [eventId, inviteeUserId])
```

## Reducer Flows

### create_availability_slot(startAt, endAt, isRecurring, recurrenceType, interval, dayOfWeek, dayOfMonth, endDate?)
1. `getAuthenticatedUser(ctx)` -- reject guests
2. `runCalendarCleanup(ctx, userId)` (Phase S10s execution: every calendar reducer, see below) -- lazy delete slots where `expiresAt + 1 week < now` (D-27) and events where `endAt + 90 days < now` (D-07)
3. Validate cap: <=10 slots per user (D-10)
4. Validate creation window: startAt must be within 6 months from now (D-28)
5. Build `RecurrenceRule` struct with sentinel values for unset optional u8 params:
   - `dayOfWeek=255` -> not set; `dayOfMonth=0` -> not set
6. Set `expiresAt`: 6 months from creation for recurring; equals `endAt` for one-time
7. Insert `AvailabilitySlot` row

### update_availability_slot(slotId, startAt, endAt, isRecurring, recurrenceType, interval, dayOfWeek, dayOfMonth, endDate?)
1. `getAuthenticatedUser(ctx)` -- reject guests
2. Find slot by `id` -- reject if not found; verify `userId === caller.id` (owner only)
3. `AvailabilitySlot.id.update()` with new values

### delete_availability_slot(slotId)
1. `getAuthenticatedUser(ctx)`
2. Find slot -- reject if not found
3. Verify owner OR Admin
4. Delete slot

### save_calendar(targetUserId)
1. `getAuthenticatedUser(ctx)` -- reject guests
2. Validate cap: <=5 saved calendars per user (D-15)
3. Insert `SavedCalendar` row with `isVisible=true`

### unsave_calendar(targetUserId)
1. `getAuthenticatedUser(ctx)`
2. Find `SavedCalendar` row by `[userId, targetUserId]` -- reject if not found; verify owner
3. Delete the row

### toggle_calendar_visibility(targetUserId)
1. `getAuthenticatedUser(ctx)`
2. Find existing `SavedCalendar` row -- reject if not found; verify owner
3. Delete + re-insert with flipped `isVisible` (composite PK requires delete+insert pattern, D-16)

### create_calendar_event(title, description?, startAt, endAt, bracketMatchId?, inviteeUserIds?)
1. `getAuthenticatedUser(ctx)` -- reject guests
2. `runCalendarCleanup(ctx, userId)` (Phase S10s execution: every calendar reducer) -- lazy delete events where `endAt + 90 days < now` (D-07) and slots where `expiresAt + 1 week < now` (D-27)
3. If `bracketMatchId > 0` (tournament-linked, D-17):
   - Verify TO/Admin/Mod/Assistant access for the bracket match's tournament (D-20)
   - Check no existing event for that `bracketMatchId` via `bracket_match_id` index (D-19)
4. Validate cap: <=40 active CalendarEvents per user (D-06)
   - Phase S10b execution (DECISIONS.md A79): `startAt < endAt`, then `endAt >= now` (`'Event end time must not be in the past.'`, now = `ctx.timestamp`). After the cleanup, two caps on the organizer's `CalendarEvent` rows (`organizer_id` index), checked in this order: events with `endAt >= now` < `MAX_ACTIVE_EVENTS_PER_USER` = 40 (`'Maximum 40 active calendar events per user.'`); all retained events < `MAX_RETAINED_EVENTS_PER_USER` = 100 (`'Maximum 100 calendar events per user.'`). Ended events count only against the 100 ceiling.
5. Insert `CalendarEvent` row
6. If tournament-linked: resolve `BracketMatch -> TournamentTeam -> TournamentTeamMember` for both teams; auto-insert `CalendarEventInvite` rows for all active participants (D-17, D-18)
7. Add manual invitees from `inviteeUserIds` (excluding already-auto-invited users); enforce cap of 9 total invitees (D-04)

### update_calendar_event(eventId, title?, description?, startAt?, endAt?)
1. `getAuthenticatedUser(ctx)`
2. Find event -- reject if not found; verify organizer OR Admin
3. `CalendarEvent.id.update()` -- cannot change `bracketMatchId` (D-08)
   - Phase S10b execution (DECISIONS.md A79): after `startAt < endAt`, a changed `endAt` must not lie in the past (`'Event end time must not be in the past.'`); an unchanged `endAt` passes (a finished event's title / description stays editable).
   - Phase S10d execution (DECISIONS.md A90): an update that revives an ended event (stored `endAt < now`, new `endAt >= now`) is rejected with `'Maximum 40 active calendar events per user.'` when the event's organizer (not the caller) already has 40 events with `endAt >= now` (`organizer_id` index, no cleanup: ended events never count as active). An event that stays active or stays ended is not counted again.
   - Phase S10d execution (DECISIONS.md A89): the caller check of step 2 is `ensureCanManageEvent` (below).

### delete_calendar_event(eventId)
1. `getAuthenticatedUser(ctx)`
2. Find event -- reject if not found; verify organizer OR Admin
3. Cascade-delete all `CalendarEventInvite` rows via `event_id` index
4. Delete `CalendarEvent` row

### invite_to_event(eventId, inviteeUserId)
1. `getAuthenticatedUser(ctx)`
2. Find event -- verify organizer OR Admin
3. Validate total invitee cap: <=9 (D-04)
4. Insert `CalendarEventInvite` row with `inviteStatus=Pending`

### remove_invite(eventId, inviteeUserId)
1. `getAuthenticatedUser(ctx)`
2. Find event -- verify organizer OR Admin
3. Delete `CalendarEventInvite` row by `[eventId, inviteeUserId]`

### respond_to_invite(eventId, status)
1. `getAuthenticatedUser(ctx)`
2. Find `CalendarEventInvite` by `[eventId, callerId]` -- reject if not found; verify caller is invitee
3. Reject if `status=Pending` (invitees cannot set back to Pending, D-01)
4. Delete + re-insert with new `inviteStatus` and `respondedAt=ctx.timestamp` (composite PK update pattern, D-02)

### Caller rule of update / delete / invite / remove_invite (Phase S10d execution, DECISIONS.md A89)
`ensureCanManageEvent(ctx, user, event, action)` (`reducers/calendar/calendarEvents.ts`), used by `update_calendar_event`, `delete_calendar_event`, `invite_to_event` and `remove_invite` (the "verify organizer OR Admin" steps above):
- the event's organizer or an Admin, always;
- for a tournament-linked event (`bracketMatchId` set): also `hasTournamentPermission(ctx, user, tournament, 'bracket')` on the bracket match's tournament (Moderator+, the tournament's organizer, an assistant with `canManageBracket`: the permission that creates such events);
- otherwise rejected: personal event `'Forbidden: Only the organizer or an Admin can <action>.'` (unchanged texts); tournament-linked event `'Forbidden: Only the organizer, an Admin or tournament staff with the bracket permission can <action>.'`. `<action>` is `update this event`, `delete this event`, `invite users to this event`, `remove invites from this event`. A link whose bracket match or tournament no longer exists falls back to the personal rule (with the tournament-linked text).

## Cross-Feature Cascades

All cascades run in the same transaction as the triggering reducer:

| Trigger | Helper | Decision |
|---------|--------|---------|
| `cancel_tournament` | `deleteCalendarEventsForTournament(ctx, tournamentId)` | D-21 -- runs before bracket match deletion |
| `rollback_bracket_match` | `deleteCalendarEventForBracketMatch(ctx, bracketMatchId)` | D-22 |
| `dq_participant` (auto-advance) | `deleteCalendarEventForBracketMatch(ctx, activeMatch.id)` | D-22 |
| `withdraw_from_tournament` | `deleteUserInvitesForTournament(ctx, userId, tournamentId)` | D-24 |
| `performUserDeletion` | `deleteAllCalendarDataForUser(ctx, userId)` | D-23 |
| `server_link_provider` moving a guest's tournament entry (`moveEntry`) | `moveUserInvitesForTournament(ctx, fromUserId, toUserId, tournamentId, actorId)` | A113(5), Phase S10m execution |

Cascade helper functions live in `spacetimedb/src/helpers/calendar/calendarCascade.ts`.

## Phase S9b execution (DECISIONS.md A37, A40, A43, A44, A48)

The four calendar tables are private since S3 (A37 calendar contexts); the calendar page reads them only through the
per-sender views of `views/calendarViews.ts` (index-only, no audit columns, labels via `resolveUserLabel`, so no calendar
route subscribes `User`, PAGE-MAP D2). Searches use `view_user_by_username(username)` (exact match, D7).

| View | Rows | Indexes |
|---|---|---|
| `view_my_calendar_events` | each once: (a) events the caller organizes; (b) events the caller is invited to; (c) events linked to a bracket match of the caller's team (both teams' members, with or without an invite row); (d) events organized by a saved calendar the caller shows (`isVisible`). Columns: id (PK), organizerId, organizerLabel, title, description?, startAt, endAt, bracketMatchId? | `CalendarEvent.organizer_id` / `id` / `bracket_match_id`, `CalendarEventInvite.invitee_user_id`, `TournamentEnrolled.user_id`, `TournamentTeamMember.by_tournament_and_user`, `BracketMatch.tournament_id`, `SavedCalendar.user_id` |
| `view_my_calendar_invites` | the caller's own invites, plus every invite of the events the caller organizes (the organizer's RSVP list; `remove_invite` takes the invitee id). Columns: inviteKey (PK = eventId << 32 \| inviteeUserId), eventId, inviteeUserId, inviteeLabel, inviteStatus, respondedAt?, inviterLabel (the invite's `createdById`, else the organizer) | `CalendarEventInvite.invitee_user_id` / `event_id`, `CalendarEvent.organizer_id` / `id` |
| `view_my_availability` | the caller's slots: id (PK), startAt, endAt, isRecurring, recurrenceRule, expiresAt | `AvailabilitySlot.user_id` |
| `view_saved_calendar_availability` | the slots of each saved calendar the caller shows: id (PK), userId, userLabel + the slot columns (A45(4): no consent flag) | `SavedCalendar.user_id`, `AvailabilitySlot.user_id` |
| `view_my_saved_calendars` | the caller's bookmarks: targetUserId (PK), targetLabel, targetAvatarCharacterName? (undefined for a deleted target), isVisible | `SavedCalendar.user_id`, `User.id` |

`isVisible` now filters server-side (events and availability of a hidden saved calendar are not sent; the bookmark row
still is), as the Phase 08 slot view did; toggling re-sends at most one user's rows. A match event is visible to
both teams' members whatever the invite rows (rule (c)), so `remove_invite` on a tournament-linked event removes the
RSVP row, not the event from a removed team member's calendar; a stand-in (`TournamentStandIn`) sees it only through an
invite row. An invitee never sees the other
invitees of an event (an anonymous tournament's match event would otherwise list the opposing players).

## Phase S10f execution (calendar audit #2, #3, #5; LOW #11, #13)

- **Duplicate manual invitees (#2).** `create_calendar_event` de-duplicates the manual ids among themselves
  (`[...new Set(manualInviteeIds)]`) before removing the auto-invite set; the 9-invitee cap counts each user once.
- **One "no end date" rule (#3).** `calendarAvailability.ts::hasEndDate(endDate)`: `''` and `'0'` both mean none (A76(2)).
  `create_availability_slot` and `update_availability_slot` use it for `expiresAt` (none: now + 6 months) and for
  `recurrenceRule.endDate` (none: the epoch sentinel), so `'0'` no longer stores a 1970 expiry.
- **Length caps (#5).** `create_calendar_event` / `update_calendar_event` (`eventTexts`): title trimmed, 1 to 100
  characters ("Event title cannot exceed 100 characters."), description trimmed, at most 1000 characters ("Event
  description cannot exceed 1000 characters."; empty stores none). In line with the tournament name (100) and the
  dispute / override reasons (1000).
- **LOW.** `create_calendar_event` attaches the invites to the row `insert` returns (no re-read by `createdDate`); the
  file headers say the lazy cleanups run in `create_calendar_event` / `create_availability_slot` (not "every call").
  **Superseded by Phase S10s execution:** every calendar reducer runs them.

## Phase S10m execution (DECISIONS.md A113(5))

`moveUserInvitesForTournament` (`helpers/calendar/calendarCascade.ts`), called by `moveEntry`
(`helpers/tournament/entryTransfer.ts`) when a guest's tournament entry moves to an existing user (A112): for each of
the guest's invites (`CalendarEventInvite.invitee_user_id`) whose event (`CalendarEvent.id`) has a `bracketMatchId`
whose match (`BracketMatch.id`) belongs to that tournament, the invite row is deleted and re-inserted for the existing
user (event, `inviteStatus`, `respondedAt`, `createdById` / `createdDate` kept; `lastModified*` = the link path's
`SYSTEM_USER_ID`), unless the existing user already has an invite for that event (`by_event_and_invitee`), in which case
the guest's row is only deleted. The event's invite count never grows, so `MAX_INVITEES_PER_EVENT` holds. Invites to
personal events and to other tournaments' events stay with the guest and go with its deletion (D-23).

## Phase S10s execution (DECISIONS.md A121, A122)

- **One order in every calendar reducer (A122(4), A122(22); fix pass F2, F11).** All twelve calendar reducers
  (`create_` / `update_` / `delete_availability_slot`, `save_calendar`, `unsave_calendar`, `toggle_calendar_visibility`,
  `respond_to_invite`, `create_` / `update_` / `delete_calendar_event`, `invite_to_event`, `remove_invite`) run:
  1. authentication (and the guest check where there is one);
  2. `consumeMembershipAllowance(ctx, user.id, MEMBERSHIP_ACTION_TEXT)`: the membership bucket of `UserRateState` (20
     calls per fixed 10 s window, shared with lobby joins, seat moves and the A122(4) lobby calls; refusal `You are doing
     that too quickly. Please wait a moment.`). First, so a refused flood does not pay for the clean-up reads (F11). No
     new column: `UserRateState` has no calendar bucket;
  3. `runCalendarCleanup(ctx, user.id, keep)` (`helpers/calendar/calendarCleanup.ts`): `cleanupExpiredSlots` then
     `cleanupOldEvents` for the caller, as the contract's "User calls any calendar reducer" says. `keep` names the call's
     own target, which the clean-up leaves alone (F2): `{ slotId }` for `update_` / `delete_availability_slot`,
     `{ eventId }` for `update_` / `delete_calendar_event`, `invite_to_event`, `remove_invite` and `respond_to_invite`.
     So a user still edits or deletes their own event ended over 90 days ago or slot expired over a week ago, as before
     S10s; a target left old is cleaned by the next calendar call;
  4. the main operation (unchanged; the create reducers' cap checks run after the clean-up, as A79 states).
  Bound of step 3: the caller's own rows only, through `AvailabilitySlot.user_id` (at most 10, the slot cap) and
  `CalendarEvent.organizer_id` (the caller's retained events, 100 by the create cap; rows moved to a new organizer by
  A121 can add to that), each deleted event with its invites (at most 9). Other users' rows are never read, so an
  inactive organizer's old events still wait for that organizer's next calendar call. A rejected call rolls the
  clean-up back with it.
- **Calendar view (A122(22), L87).** `view_my_calendar_events` skips Completed and Cancelled tournaments on the
  team-match path; [../views/architecture.md](../views/architecture.md) "Phase S10s execution".
- **New organizer (A121, L70).** When staff delete or ban a tournament's organizer, the tournament's bracket-match
  events that organizer created move to the new organizer instead of being deleted with the user's calendar data;
  [../tournament/architecture.md](../tournament/architecture.md) "Phase S10s execution".

## Phase S10v execution (DECISIONS.md A135; audit SI16)

- **Stand-ins get the match event like the members, never at the members' cost (review F4).** `create_calendar_event`
  for a bracket match invites the two teams' members and the manual invitees as before (the 9-invite cap,
  `MAX_INVITEES_PER_EVENT`, now exported for `approve_stand_in`, is checked on them only), then the match's approved
  stand-ins (`TournamentStandIn.bracket_match_id`, once each, not a member or manual invitee) while room is left under
  the cap. Approvals therefore never make the creation fail; the stand-ins left out see the event through path (c'). A stand-in approved after the event exists gets a Pending invite from `approve_stand_in` (actor
  the approver), skipped when the event is at the cap. Every removal of the approval (revoke, disqualification, the team
  leaving the match) deletes that invite unless the user is a member of one of the match's teams
  ([../tournament/architecture.md](../tournament/architecture.md) "Phase S10v execution").
- **Visibility.** `view_my_calendar_events` path (c') shows the events of the caller's approved matches
  ([../views/architecture.md](../views/architecture.md) "Phase S10v execution").

## Phase History

| Decision | Source | Date |
|----------|--------|------|
| InviteStatus enum: Pending/Accepted/Declined/Tentative (D-01) | Phase 08 CONTEXT.md | 2026-03-21 |
| respondedAt timestamp on CalendarEventInvite (D-02) | Phase 08 CONTEXT.md | 2026-03-21 |
| Cascade: delete CalendarEvent -> delete CalendarEventInvite (D-03) | Phase 08 CONTEXT.md | 2026-03-21 |
| Cap: 9 invitees per event -- 6 players + 2 coaches + 1 referee (D-04) | Phase 08 CONTEXT.md | 2026-03-21 |
| Cap: 10 AvailabilitySlot rows per user (D-10) | Phase 08 CONTEXT.md | 2026-03-21 |
| SavedCalendar: pure bookmark, 5-per-user cap (D-15) | Phase 08 CONTEXT.md | 2026-03-21 |
| isVisible on SavedCalendar -- toggle without deleting (D-16) | Phase 08 CONTEXT.md | 2026-03-21 |
| Auto-invite bracket participants on tournament-linked event creation (D-17, D-18) | Phase 08 CONTEXT.md | 2026-03-21 |
| One CalendarEvent per bracketMatchId enforced via bracket_match_id btree (D-19) | Phase 08 CONTEXT.md | 2026-03-21 |
| cancel_tournament cascades to CalendarEvents (D-21) -- calendar step before bracket match deletion | Phase 08 execution | 2026-03-28 |
| rollback_bracket_match and dq_participant cascade to CalendarEvent (D-22) | Phase 08 execution | 2026-03-28 |
| User deletion cascades all calendar data (D-23) | Phase 08 execution | 2026-03-28 |
| BigInt micros as strings for timestamp params -- avoids u64 encoding issues in SpacetimeDB SDK | Phase 08 execution | 2026-03-28 |
| Sentinel values for optional u8/u32 reducer params (dayOfWeek=255, dayOfMonth=0, bracketMatchId=0) | Phase 08 execution | 2026-03-28 |
| --clear-database required for CalendarEvent/CalendarEventInvite schema additions | Phase 08 execution | 2026-03-28 |
| TournamentParticipant split into TournamentEnrolled + TournamentTeamMember; create_calendar_event updated to use new tables | Phase 10.1 execution | 2026-03-25 |
| Optional description on CalendarEvent appended at end for safe migration (D-26) | Phase 08 execution | 2026-03-28 |
| Normalized to standard template | Phase 13 normalization | 2026-04-09 |
| Calendar views (five per-sender views, index-only, labels denormalized, `isVisible` filtered server-side, tournament match events visible to both teams' members, organizer sees the invite list) | Phase S9b execution (DECISIONS.md A37, A40, A43, A44, A48) | 2026-11-08 |
| Event caps: 40 not-yet-ended + 100 retained per organizer (after the cleanup); `endAt` in the past rejected on create and on a changed `endAt` in update | Phase S10b execution (DECISIONS.md A79) | 2026-11-09 |
| Tournament-linked events: update / delete / invite / remove_invite also accept the tournament's organizer and `bracket` staff (`ensureCanManageEvent`); `update_calendar_event` applies the 40-active cap when it revives an ended event | Phase S10d execution (DECISIONS.md A89, A90) | 2026-11-09 |
| Manual invitees de-duplicated; one `hasEndDate` rule for slots; title 100 / description 1000 caps; invites attach to the inserted row | Phase S10f execution (calendar audit #2, #3, #5) | 2026-11-09 |
| A guest's invites to a tournament's bracket-match events move to the existing user with the guest's entry (`moveUserInvitesForTournament`; dropped when that user is already invited) | Phase S10m execution (DECISIONS.md A113(5)) | 2026-11-10 |
| Every calendar reducer runs the caller's lazy clean-up (slots + events) and counts on the per-user membership allowance; `view_my_calendar_events` skips finished tournaments on the team-match path; an organizer's match events move with an A121 hand-over | Phase S10s execution (DECISIONS.md A121, A122) | 2026-11-10 |
| Fix pass: one order in all twelve calendar reducers (authenticate, allowance, clean-up sparing the call's own event or slot, main operation), so an own old event or expired slot can still be edited or deleted | Phase S10s execution (DECISIONS.md A122) | 2026-11-10 |
| A tournament match event invites the match's approved stand-ins at creation; `approve_stand_in` invites a stand-in to an existing event (within the 9-invite cap), every removal of the approval deletes that invite; `view_my_calendar_events` path (c') for the stand-in's matches | Phase S10v execution (DECISIONS.md A135; audit SI16) | 2026-11-10 |
| Fix pass: stand-ins are invited at event creation only while room is left under the cap (members and manual invitees first), so approvals never refuse the creation | Phase S10v execution (S10v review F4) | 2026-11-10 |

---

*Last updated: 2026-11-10 (S10v)*
*Feature owner: Phase 08*

**Behavior specification** (acceptance scenarios, edge cases, phase history): See [contract.md](contract.md)
