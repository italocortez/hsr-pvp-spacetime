# Calendar & Scheduling -- Architecture

Last updated: 2026-11-11 (S10ad)

## Overview

The calendar feature lets players set dated availability slots (Available or Blocked; S10ac, A157(1), A157(3):
recurrence removed), save other players' calendars as bookmarks, and create scheduled events with invites. Tournament organizers can link events to bracket matches, which auto-invites all active team members and writes the match's `scheduledAt` (A157(12)). Common-availability computation is client-side from subscribed slot data. All cascade deletions (tournament cancel, bracket rollback, user deletion) run in the same transaction as the triggering reducer; the scheduled identity GC sweeps rows past retention (A157(10)).

## Table Relationships

```
User (id: u32 autoInc PK)
  +-- AvailabilitySlot (id: u32 autoInc PK)
  |     userId -> User.id  [btree: user_id]
  |     startAt: Timestamp (UTC)
  |     endAt: Timestamp (startAt < endAt, at most 24 h later; the slot ends here, no expiresAt)
  |     kind: SlotKind (Available | Blocked)  -- S10ac, A157(1)
  |     audit columns
  |
  +-- SavedCalendar (logical key [userId, targetUserId]: the `primaryKey` table option is decorative,
  |     not engine-enforced; save_calendar's duplicate check keeps it unique)
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
  |     endAt: Timestamp (at most 7 days after startAt, A157(11))
  |     bracketMatchId: u32? -> BracketMatch.id  [btree: bracket_match_id]
  |     audit columns
  |
  +-- CalendarEventInvite (logical key [eventId, inviteeUserId]: decorative `primaryKey` option, not engine-enforced;
        uniqueness comes from the reducers' duplicate checks)
        eventId -> CalendarEvent.id  [btree: event_id]
        inviteeUserId -> User.id  [btree: invitee_user_id]
        inviteStatus: InviteStatus (Pending | Accepted | Declined | Tentative)
        respondedAt: Timestamp? (D-02)
        audit columns
        Indexes: event_id, invitee_user_id, by_event_and_invitee (btree, [eventId, inviteeUserId])
```

Time arguments of every calendar reducer are micros strings parsed by `parseCalendarTime` / `parseInterval`
(`helpers/calendar/calendarTime.ts`, A157(11)): see "Phase S10ac execution".

## Reducer Flows

Every calendar reducer starts with: authenticate (and the guest check where there is one), the membership allowance,
the caller's lazy clean-up (Phase S10s execution, below). The numbered steps list what follows, in code order.

### create_availability_slot(startAt, endAt, kind)
1. Reject guests (`'Guests cannot manage availability slots.'`)
2. `kind` must be `Available` or `Blocked` (`'Invalid slot kind. Must be Available or Blocked.'`)
3. `parseInterval`: `'Invalid start time.'` / `'Invalid end time.'`, then `'Start time must be before end time.'`
4. Length at most 24 h (`'An availability slot can last at most 24 hours.'`)
5. Start not in the past (`"You can't schedule something in the past."`)
6. Start within 6 months from now (D-28, `'Availability slots cannot be scheduled more than 6 months in advance.'`)
7. Weekly cap (S10ad, A160(1)): fewer than 10 of the caller's slots **of the same kind** start in the UTC week (Monday
   00:00 UTC) of the new start, ended slots included (`'You can set at most 10 available slots per week.'` /
   `'You can set at most 10 blocked slots per week.'`)
8. S10ad (A160(3)): a Blocked slot may not overlap a personal event the caller organizes whose `endAt > now`
   (`'This blocked slot overlaps one of your events.'`; half-open intervals, touching passes; match events exempt)
9. Insert `AvailabilitySlot`

### update_availability_slot(slotId, startAt, endAt, kind)
1. Reject guests; find slot (`'Availability slot not found.'`); owner only (`'Not your availability slot.'`)
2. Steps 2-8 of create, with three differences: the past check applies only when the start moves (a started slot keeps
   its start and may change its end or kind); the weekly cap does not count the slot itself (its new week and new kind
   are checked); the Blocked-overlap check runs only when the result is Blocked and the start or end moved or the kind
   switched from Available (S10ad, A160(3))
3. `AvailabilitySlot.id.update()` (same id)

### delete_availability_slot(slotId)
1. Find slot -- reject if not found
2. Verify owner OR Admin (`'Forbidden: You can only delete your own availability slots.'`)
3. Delete slot

### save_calendar(targetUserId)
1. Reject guests (`'Guests cannot save calendars.'`)
2. Not oneself (`'Cannot save your own calendar.'`)
3. Target exists (`'Target user not found.'`); S10ad (A160(7)): not the SYSTEM user (`"The SYSTEM user's calendar
   cannot be saved."`); S10ac (A157(7)): not a guest (`"A guest's calendar cannot be saved."`), not pending deletion
   (`"This user's account is being deleted; their calendar cannot be saved."`)
4. Not already saved (`'Already saved.'`)
5. Cap: fewer than 5 saved calendars (D-15, `'Maximum 5 saved calendars per user.'`)
6. Insert `SavedCalendar` row with `isVisible=true`

### unsave_calendar(targetUserId)
1. Reject guests (`'Guests cannot manage saved calendars.'`)
2. Find the caller's `SavedCalendar` row by `[userId, targetUserId]` (`'Calendar not saved.'`)
3. Delete the row

### toggle_calendar_visibility(targetUserId, isVisible)
1. Reject guests (`'Guests cannot manage saved calendars.'`)
2. Find the caller's row (`'Calendar not saved.'`)
3. Delete + re-insert with `isVisible` set to the argument (not flipped; the table has no engine primary key, D-16)

### create_calendar_event(title, description, startAt, endAt, bracketMatchId, inviteeUserIds)
1. Reject guests (`'Guests cannot create calendar events.'`)
2. Texts (`eventTexts`): title trimmed, 1..100 characters; description trimmed, at most 1000 characters; counted in
   code points (A157(11)). S10ad (A160): the title needs at least one visible character (`hasVisibleChar`: not
   whitespace or a separator, a control, a format character such as a zero-width space or a direction override, a
   lone surrogate or another default-ignorable code point); otherwise `'Event title must not be empty.'`
3. `parseInterval` (`'Invalid start time.'` / `'Invalid end time.'`, `'Start time must be before end time.'`); length
   at most 7 days (`'An event can last at most 7 days.'`); start not in the past (`"You can't schedule something in
   the past."`, A157(9); since the start is not past, neither is the end: A79(3)'s end check is implied); start at
   most 365 days ahead (`'Events cannot be scheduled more than 12 months in advance.'`)
4. If `bracketMatchId > 0` (tournament-linked, D-17): the match exists (`'Bracket match not found.'`); the `bracket`
   permission on its tournament (D-20, A25); no event for that match yet (D-19); collect the two teams' active members
   and the match's approved stand-ins. Otherwise (personal event): no overlap with one of the caller's Blocked slots
   (`'This time overlaps one of your blocked slots.'`, A157(1); half-open intervals, touching passes). A match event is
   exempt from the Blocked check (its organizer is staff scheduling other players).
5. Caps after the clean-up (A79): events with `endAt >= now` < 40 (`'Maximum 40 active calendar events per user.'`);
   all retained events < 100 (`'Maximum 100 calendar events per user.'`)
6. Manual invitees: comma-separated ids parsed strictly by `parseInviteeIds` (S10ac review M1): `''` (or plain spaces
   only) = nobody; otherwise every token, after trimming plain spaces, is digits only and a whole number from 1 to
   4294967295, and any other token (letters, `3abc`, `3.9`, `1e3`, `-3`, `0`, an empty token such as a trailing comma,
   an id above u32 that would wrap to a real user) refuses the whole call with `'Invalid invitee list.'`;
   then de-duplicated, minus the auto-invitees; members + manual <= 9
   (`'Maximum 9 invitees per event.'`, D-04); stand-ins fill the room left (S10v review F4); each manual invitee is
   not the organizer (S10ad, A160(7): `'You cannot invite yourself to your own event.'`; an Admin or staff caller adding
   the organizer gets `'The organizer cannot be invited to their own event.'`), exists (`'User <id> not found.'`), is
   not the SYSTEM user (`'The SYSTEM user cannot be invited to calendar events.'`, A160(7)), is not a guest (`'Guests cannot be invited to calendar events.'`) and not pending
   deletion (`"This user's account is being deleted; they cannot be invited."`) (A157(7)); server-written invites
   (members, stand-ins) are not checked
7. Insert `CalendarEvent`, then the Pending invites (auto first, then manual)
8. Match event: `BracketMatch.scheduledAt` = the start (A157(12), `setBracketMatchSchedule`)

### update_calendar_event(eventId, title, description, startAt, endAt, inviteeUserIds?)
1. Find event (`'Calendar event not found.'`); `ensureCanManageEvent` (below)
2. Texts as in create
3. `parseInterval`; length at most 7 days; past start refused only when the start moves (A157(9); a started event keeps
   its start and edits the rest); 12-month lead when the start moves
4. A79: a changed `endAt` must not lie in the past (`'Event end time must not be in the past.'`)
5. A90: reviving an ended event (stored `endAt < now`, new `endAt >= now`) is refused with
   `'Maximum 40 active calendar events per user.'` when the organizer (not the caller) already has 40 active events
6. A personal event whose start or end changes may not overlap one of the organizer's Blocked slots (`'This time
   overlaps one of your blocked slots.'` for the organizer, `"This time overlaps one of the organizer's blocked
   slots."` for an Admin)
7. `inviteeUserIds` (A157(12), optional): omitted = the set is unchanged; given = the full set, comma-separated ids
   (`''` = nobody), parsed strictly as in create step 6 (a junk list is refused, it never empties the set). The final
   set has at most 9 (`'Maximum 9 invitees per event.'`); added ids are validated as in
   create step 6. All checks run before any write
8. Update the event row (`bracketMatchId` never changes, D-19); delete the removed invites; when the start or end
   changed (A157(4)) every kept invite that is not already a fresh Pending goes back to Pending with `respondedAt`
   cleared (delete + re-insert, creator kept, `lastModified*` = the caller); insert the added invites as Pending
9. Match event whose start moved: `BracketMatch.scheduledAt` follows (an end-only change leaves it)

### delete_calendar_event(eventId)
1. Find event; `ensureCanManageEvent`
2. `deleteCalendarEventWithInvites`: invites via `event_id`, the event row, and the bracket match's `scheduledAt`
   (cleared, A157(12))

### invite_to_event(eventId, inviteeUserId)
1. Find event; `ensureCanManageEvent`
2. Not the organizer (A160(7) texts above); invitee exists (`'Invitee user not found.'`); not the SYSTEM user, a
   guest or pending deletion (A160(7), A157(7) texts above)
3. Not already invited (`'User is already invited to this event.'`); fewer than 9 invites (D-04)
4. Insert a Pending `CalendarEventInvite`

### remove_invite(eventId, inviteeUserId)
1. Find event (`'Calendar event not found.'`)
2. S10ac (A157(8)): when `inviteeUserId` is the caller, no further permission (an invitee leaves the event);
   otherwise `ensureCanManageEvent`
3. Find the invite (`'Invite not found.'`) and delete it

### respond_to_invite(eventId, status)
1. Reject guests (`'Guests cannot respond to event invites.'`)
2. `status` must be Accepted, Declined or Tentative (`'Cannot respond with Pending status.'`; otherwise
   `'Invalid status. Must be one of: Accepted, Declined, Tentative.'`, D-01)
3. Find the caller's invite (`'You have no invite for this event.'`)
4. Delete + re-insert with the new `inviteStatus` and `respondedAt=ctx.timestamp` (no engine primary key, D-02)

### Caller rule of update / delete / invite / remove_invite (Phase S10d execution, DECISIONS.md A89)
`ensureCanManageEvent(ctx, user, event, action)` (`reducers/calendar/calendarEvents.ts`), used by `update_calendar_event`, `delete_calendar_event`, `invite_to_event` and `remove_invite` (the "verify organizer OR Admin" steps above):
- the event's organizer or an Admin, always;
- for a tournament-linked event (`bracketMatchId` set): also `hasTournamentPermission(ctx, user, tournament, 'bracket')` on the bracket match's tournament (Moderator+, the tournament's organizer, an assistant with `canManageBracket`: the permission that creates such events);
- otherwise rejected: personal event `'Forbidden: Only the organizer or an Admin can <action>.'` (unchanged texts); tournament-linked event `'Forbidden: Only the organizer, an Admin or tournament staff with the bracket permission can <action>.'`. `<action>` is `update this event`, `delete this event`, `invite users to this event`, `remove invites from this event`. A link whose bracket match or tournament no longer exists falls back to the personal rule (with the tournament-linked text).
- **Superseded in part by Phase S11a execution (A162(1)):** on a tournament-linked event the organizer is no longer accepted "always"; see below.

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
| `resolve_bracket_match` on a Ready match, `deleteBracket` (regeneration) | `deleteCalendarEventForBracketMatch(ctx, bracketMatchId)` | D-22 |
| `run_identity_gc` (weekly) | `sweepExpiredCalendarRows(ctx)` (`calendarCleanup.ts`) | A157(10), Phase S10ac execution |

Cascade helper functions live in `spacetimedb/src/helpers/calendar/calendarCascade.ts`. Every event deletion goes
through `deleteCalendarEventWithInvites`, which also clears the match's `BracketMatch.scheduledAt` (Phase S10ac
execution, A157(12)), except retention: the lazy clean-up and the sweep pass `{ keepSchedule: true }`, so the match
keeps its time (Phase S10ad execution, A160(6)). The bracket cascades (`deleteCalendarEventForBracketMatch`, and so
`deleteCalendarEventsForTournament`) clear a set `scheduledAt` also when no event is left (Phase S10ad execution,
A161(3)).

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
**Superseded by Phase S10ac execution (A157(1), (3), (5), (6), (12)):** slot rows carry `kind` instead of the
recurrence columns; invitees read the attendee list (not of an anonymous tournament's match event, staff excepted);
path (d) sends busy blocks; avatars next to labels ([../views/architecture.md](../views/architecture.md) "Phase S10ac
execution"). **Superseded by Phase S10ad execution (A161(1)):** `view_my_calendar_invites` again sends an invitee
their own row only; the attendee list comes from `view_event_attendees(eventId)` for the opened event.

## Phase S10f execution (calendar audit #2, #3, #5; LOW #11, #13)

- **Duplicate manual invitees (#2).** `create_calendar_event` de-duplicates the manual ids among themselves
  (`[...new Set(manualInviteeIds)]`) before removing the auto-invite set; the 9-invitee cap counts each user once.
- **One "no end date" rule (#3).** `calendarAvailability.ts::hasEndDate(endDate)`: `''` and `'0'` both mean none (A76(2)).
  `create_availability_slot` and `update_availability_slot` use it for `expiresAt` (none: now + 6 months) and for
  `recurrenceRule.endDate` (none: the epoch sentinel), so `'0'` no longer stores a 1970 expiry. **Superseded by Phase
  S10ac execution (A157(3)):** recurrence, `expiresAt` and `hasEndDate` are removed.
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
  clean-up back with it. **Phase S10ac execution:** the slot count is no longer capped in total (10 per UTC week that
  have not ended, A157(2)); slots are deleted one week after `endAt`; the weekly `run_identity_gc` sweep removes the
  rows of owners who do not come back (A157(10)).
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

## Phase S10ac execution (DECISIONS.md A157)

The backend follows the calendar mockup (`design/mockups/calendar.html`); review
`notes/audit-2026-11-09/calendar-review.md`. Reducer steps are in "Reducer Flows" above; views in
[../views/architecture.md](../views/architecture.md) "Phase S10ac execution".

- **Time validator (A157(11), review B1, B6).** `helpers/calendar/calendarTime.ts`: `parseCalendarTime(value, label)`
  accepts 1 to 19 digits only, inside [2020-01-01, 2100-01-01) UTC, else `SenderError('Invalid <label>.')` ("start
  time" / "end time"), so `''`, signs, decimals, spaces, letters, values above i64 and far dates never reach `BigInt`
  wrap or a stored row. `parseInterval` adds `startAt < endAt`. Bounds: slot at most 24 h, event at most 7 days, event
  start at most 365 days ahead (only checked when the start is new or moves); the 6-month slot window stays.
  `charCount` counts code points for the title (100) and description (1000) caps. The invitee id list is parsed
  strictly by `parseInviteeIds` (S10ac review M1, `create_calendar_event` step 6). Every other argument is typed (user,
  event, slot and match ids are `u32`) or checked against a list (slot kind, invite status), so no raw `SyntaxError` / `TypeError` leaves a calendar reducer.
- **Slot kind (A157(1)).** `AvailabilitySlot.kind: SlotKind` (Available | Blocked), in both slot reducers and both
  availability views. A personal event (create, or an update that changes its time) may not overlap one of its
  organizer's Blocked slots (`[start, end)` intervals; touching passes). **Exempt:** tournament match events, whose
  organizer is the staff member scheduling other players' match: their own blocked time must not stop bracket
  scheduling.
- **Weekly cap (A157(2)).** At most 10 slots (both kinds) per user per UTC week (Monday 00:00 UTC, `utcWeekStart`),
  counted by start; slots with `endAt <= now` do not count; update counts the new week without the slot itself. The old
  total cap (10 rows) and the 7-day count of ended slots are gone (a slot ended less than a week ago still exists until
  the clean-up but no longer counts). **Superseded by Phase S10ad execution (A160(1)):** one cap per kind, ended slots
  count.
- **Recurrence removed (A157(3)).** Columns `isRecurring`, `recurrenceRule`, `expiresAt`; reducer arguments
  `isRecurring`, `recurrenceType`, `interval`, `dayOfWeek`, `dayOfMonth`, `endDate`; the `RecurrenceRule` struct, the
  `RecurrenceType` enum and `hasEndDate`; the view columns. A slot is one dated interval; the clean-up reads `endAt`
  (D-27: deleted one week after its end).
- **Reschedule (A157(4)).** `update_calendar_event` sets every kept invite to Pending (`respondedAt` cleared) when the
  start or end changes; a text-only edit keeps the answers. No notification exists beyond the view update.
- **Targets (A157(7)).** `ensureCalendarTarget` (`helpers/calendar/calendarTargets.ts`): `save_calendar`, the manual
  invitees of `create_calendar_event`, the added invitees of `update_calendar_event` and `invite_to_event` refuse a
  guest and a user with `deletedAt` set. Server-written invites (match teams, stand-ins) are not checked. Rows that
  already point at such a user stay until that user's deletion (`deleteAllCalendarDataForUser`; idle guests without
  match history are deleted by the identity GC, A95(1); pending deletions run 5 s later).
- **Leaving (A157(8)).** `remove_invite` accepts the invitee on their own invite. The events view then no longer
  reaches the event through the invite path (a match team member still sees the match event through the team path
  (c), as before; a saver still gets a busy block). A Declined invitee keeps the event row without the notes.
- **Past starts (A157(9)).** Create of a slot or an event refuses `start < now` (`"You can't schedule something in the
  past."`, the mockup's text); an update refuses it only when the start moves. Supersedes the end-only check of A79(3)
  on create; the A79(3) update rule on a changed end stays.
- **Sweep (A157(10), review B4).** The existing weekly scheduled job `run_identity_gc` (`reducers/identity/
  identityGc.ts`) calls `sweepExpiredCalendarRows` (`helpers/calendar/calendarCleanup.ts`) after its identity pass:
  the same retention as the lazy clean-up, for every owner (slots ended more than 7 days ago, events ended more than
  90 days ago with their invites and their match's `scheduledAt`; superseded by Phase S10ad execution (A160(6)):
  retention keeps the time). Batch: at most 500 slots and 500 events per run,
  oldest `endAt` first (ties by id). Both tables are scanned once per run (`iter()`: there is no `endAt` index; a
  weekly job). When rows are left over the batch the next run comes after one hour instead of 7 days (the job's
  existing backlog interval). A `GcResult` row with `gcType: 'calendar'`, `details: {slots, events}` is written only
  when something was deleted; the identity row and its details are unchanged. `admin_gc_identities` does not sweep.
- **One-call invitee edit (A157(12)).** `update_calendar_event` takes `inviteeUserIds` (optional string): omitted =
  unchanged; given = the full set (adds and removals in one call, the 9 cap on the final set, new invitees Pending, kept
  ones keep their answer unless the time changed). `invite_to_event` / `remove_invite` are unchanged otherwise.
- **Bracket schedule (A157(12)).** `BracketMatch.scheduledAt` = the match event's start (create, a start change),
  cleared by every deletion of the event ([../tournament/architecture.md](../tournament/architecture.md) "Phase S10ac
  execution"). **Superseded in part by Phase S10ad execution (A160(6)):** retention keeps it.
- **Avatars (A157(12)).** The event and invite views carry the avatar character name next to each label.

## Phase S10ad execution (DECISIONS.md A160)

Note from the second S10ad review: up to and including end + 7 days an ended event that is moved to the future keeps every invitee. After day 7 the result depends on which clean-up ran first: with none, the move keeps all (the update spares its own target); after an invitee's calendar call that invitee is gone; after the organizer's call or the sweep every Pending invitee is gone. For a match event the members still see the event through the team path but hold no invite. The cascade on a staff resolve applies to a Ready match; resolving an already Decided match to the other team keeps the event and the time.

Rulings on the S10ac review (`notes/audit-2026-11-09/s10ac-review.md`, M2, M3, L2, L5, L6, L9, L10). Reducer steps are
in "Reducer Flows" above. "Ended" means `endAt <= now` for slots and events alike.

- **Weekly cap per kind (A160(1), review M2).** `checkSlotTimes` counts the user's slots **of the same kind** whose
  start falls in the UTC week of the new start, ended or not, the slot under update excluded: 10 Available and 10
  Blocked per week. Texts name the kind. Interplay with retention: an ended slot is deleted 7 days after its end
  (lazy clean-up or sweep). A slot that starts in week W ends after its start, so it is deleted no earlier than 7
  days after its start, when W is over; and no new slot can start in a past week. So a week's
  count never drops through retention while slots can still be placed in it: only `delete_availability_slot` frees a
  place. Bound: at most 20 slot rows per user per week; slots start at most 6 months (about 26 weeks) ahead and are
  kept 7 days past their end, so at most about 28 weeks x 20 = 560 slot rows per user. The S10ac probe (600
  momentary slots accepted) now stores 10.
- **Blocked slot onto an event (A160(3), review L2).** `ensureBlockedSlotFree` (`calendarAvailability.ts`):
  `create_availability_slot` and `update_availability_slot` refuse a Blocked slot (new; moved; or switched from
  Available) that overlaps a personal event the caller organizes (`CalendarEvent.organizer_id`) with `endAt > now`
  (`'This blocked slot overlaps one of your events.'`). Half-open intervals: touching passes. Match events are exempt
  in both directions. Events one is only invited to, and other users' events, do not block. With both directions
  checked, the S10ac case "a time edit that only shortens an event a Blocked slot overlaps is refused" no longer
  arises from new data (a slot overlapping a not-ended own personal event cannot be stored; an ended event can only
  be edited in time by moving its end to now or later, which is not a pure shortening and is checked as before). The
  event-side check is unchanged; rows stored before S10ad can still hit it.
- **Pending invites 7 days after the end (A160(4), Q4; timing by A161(2)).** No scheduled reducer per event; the
  existing clean-ups remove a `Pending` invite once its event ended **more than 7 days ago** (`endAt + 7 days < now`;
  kept at exactly 7 days), for every invitee (guests and server-written invites included), so an event or match moved
  to a later time within a week of its end keeps every invitee (review F2). Answered invites (Accepted, Declined,
  Tentative) stay until the event's own 90-day retention.
  - Lazy clean-up (`runCalendarCleanup`, every calendar reducer): `cleanupOldEvents` deletes the Pending invites of
    the caller's events ended more than 7 days ago (`CalendarEvent.organizer_id`, then `CalendarEventInvite.event_id`);
    `cleanupEndedPendingInvites` deletes the caller's own Pending invites whose event ended more than 7 days ago
    (`CalendarEventInvite.invitee_user_id`, `CalendarEvent.id`). The call's own target event is spared, as before
    (so an invitee can still answer, and an organizer still edit, such an event's invites in that call). Bound: the
    caller's retained events (100) with at most 9 invites each, plus one event lookup per invite the caller holds.
  - Sweep (`sweepExpiredCalendarRows`, `run_identity_gc`): after the retention batch, the Pending invites of the
    stored events that ended more than 7 days ago, oldest end first, at most **500 invite rows per run**
    (`CALENDAR_SWEEP_BATCH`), read through `CalendarEventInvite.event_id` per such event (the `CalendarEvent` scan is
    the one already made). More left over brings the next run forward to one hour. The calendar `GcResult` row counts
    them in `itemsDeleted` and adds `pendingInvites` to `details` only when some were deleted (`{slots, events}`
    otherwise, as before).
  - Worst case: a Pending invite is gone at the latest at the first `run_identity_gc` run after end + 7 days, i.e.
    **at most end + 7 days + the sweep interval (7 days) = 14 days after the end** while each run's backlog is at most
    500 rows; a larger backlog adds one hour per further 500 rows. It goes sooner on the organizer's or that invitee's
    next calendar call after end + 7 days. The guarantee assumes the job is running (seeded by bootstrap,
    `seed_identity_gc_job`).
  - Not changed: `invite_to_event` and the invitee set of `update_calendar_event` still accept new invites on an
    ended event; those are Pending and follow the same rule. A reschedule still resets the answers (A157(4)); once
    the moved event has ended, those Pending invites go 7 days later (A161(4), accepted).
- **Attendee list per opened event (A161(1); replaces the delivery of A157(5) and A160(5)).** A view cannot read the
  time (`ViewCtx` is `{ sender, db, env, from }`, SDK 2.14.1 `dist/server/views.d.ts:15-25`), so the A160(5) cut-off at
  the end is not built. Instead:
  - `view_my_calendar_invites` sends an invitee their own row only (the S10ac path that sent an invitee every invite
    of the event is removed); the organizer still gets every invite of their events.
  - `view_event_attendees(eventId)` (new, a view with an argument) returns the invites of one event: inviteeUserId,
    inviteeLabel, inviteeAvatarCharacterName?, inviteStatus, respondedAt?. Readers: the event's organizer; an invitee
    of a personal event (any answer); for a match event every invitee unless the tournament is anonymous
    (`Tournament.isAnonymousDefault`), then nobody but holders of the `bracket` permission; a holder of the `bracket`
    permission of the match's tournament (Moderator+, the tournament organizer, an assistant with `canManageBracket`)
    also without an invite. Anyone else, an unknown id or a deleted event: no rows, no error. Full rule and sizes in
    [../views/architecture.md](../views/architecture.md) "Phase S10ad execution".
  - **Calendar page:** subscribe `view_my_calendar_invites` always (with the other calendar views); subscribe
    `SELECT * FROM view_event_attendees(<id>)` only for the event that is open and drop it when the event closes (one
    argument set at a time: unsubscribe the old id before subscribing the next). Tiles of events one is invited to
    show the organizer's avatar only (`view_my_calendar_events` carries it); the attendee avatars appear in the open
    event (A161(1), accepted by the user).
- **Bracket time kept by retention (A160(6), review L6).** `deleteCalendarEventWithInvites(ctx, id, { keepSchedule })`:
  the lazy clean-up and the sweep pass `keepSchedule: true`, so `BracketMatch.scheduledAt` stays when a match event
  goes 90 days after its end. `delete_calendar_event`, a move and a user's deletion (`deleteAllCalendarDataForUser`)
  behave as in S10ac, and clear or move the time only while the event exists.
- **Bracket cascades clear the time (A161(3), review F1).** `deleteCalendarEventForBracketMatch` (staff resolve of a
  Ready match, rollback, `cancel_tournament` through `deleteCalendarEventsForTournament`, a disqualification that
  settles a Ready match, bracket regeneration through `deleteBracket`) clears `BracketMatch.scheduledAt` when it is set,
  whether or not an event was found, so a time kept by retention does not outlive a cascade (a rolled-back match is
  Ready again with no time). A match without a time is not written. Regeneration deletes the match rows anyway.
- **Targets (A160(7), review L5).** `ensureNotOrganizer` (`calendarEvents.ts`): the organizer cannot be a manual
  invitee of `create_calendar_event`, an added invitee of `update_calendar_event` or the target of `invite_to_event`
  (`'You cannot invite yourself to your own event.'`; an Admin or staff caller on someone else's event gets `'The
  organizer cannot be invited to their own event.'`). `ensureCalendarTarget` refuses the SYSTEM user (found by its
  unique username `'SYSTEM'`) for saving and inviting. Server-written invites (a staff organizer who is also a team
  member) are not checked; a self-invite stored before S10ad stays while it is listed in the set.
- **Title (A160, review L9).** `hasVisibleChar` (`calendarTime.ts`, regex `[^\s\p{Z}\p{Cc}\p{Cf}\p{Cs}
  \p{Default_Ignorable_Code_Point}]` with the `u` flag); a title without one gets the empty-title text. The
  description is not checked.

## Phase S11a execution (DECISIONS.md A162)

- **Caller rule (A162(1))**, `ensureCanManageEvent` (`reducers/calendar/calendarEvents.ts`; `update_calendar_event`,
  `delete_calendar_event`, `invite_to_event`, `remove_invite` on someone else's invite):
  - an Admin, always;
  - a tournament-linked event whose bracket match and tournament exist: a holder of that tournament's `bracket`
    permission (`hasTournamentPermission`: Moderator+, the tournament organizer, an assistant with `canManageBracket`).
    The event's organizer has no right of their own here: a creator who left the staff (assistant removed or the
    bracket flag turned off, Moderator demoted) is refused like any other user;
  - a tournament-linked event whose match or tournament is gone: the event's organizer (the personal rule, as before);
  - a personal event: the organizer (unchanged);
  - otherwise rejected: personal event `'Forbidden: Only the organizer or an Admin can <action>.'` (unchanged);
    tournament-linked event `'Forbidden: Only an Admin or tournament staff with the bracket permission can <action>.'`
    (the text drops "the organizer", which no longer passes on their own).
  - An invitee may still remove their own invite (A157(8)), the former-staff creator included when invited (e.g. a team
    member auto-invited at creation).
  - `create_calendar_event` already required the `bracket` permission for a match event (D-20); unchanged.
- **Views (A162(1), A162(3))**: `view_event_attendees` and `view_my_calendar_invites` path (b) follow the same rule on
  match events; an Admin reads the attendee list of every event. Details and sizes:
  [../views/architecture.md](../views/architecture.md) "Phase S11a execution".
- A162(2) (moving an event more than 7 days after its end stays allowed; unanswered invitees may already be gone) and
  A162(4) (a team member without an invite row does not read the list) need no change.

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
| The backend follows the calendar mockup: slot kind Available / Blocked and the blocked-overlap rule for personal events; 10 slots per UTC week; recurrence removed; reschedule resets answers; attendee list for invitees; busy blocks for savers; guests and pending-deletion users refused as targets; invitees may leave; past starts refused; weekly sweep in `run_identity_gc`; one time validator with length and lead bounds; avatars in rows; one-call invitee edit; `BracketMatch.scheduledAt` written. Doc fixes: `toggle_calendar_visibility` sets `isVisible`; the composite keys are not engine-enforced; check orders and `save_calendar` checks listed | Phase S10ac execution (DECISIONS.md A157) | 2026-11-11 |
| Rulings on the S10ac review: 10 Available + 10 Blocked slots per UTC week, ended slots counted; a Blocked slot may not overlap an own personal event that has not ended; Pending invites of ended events removed by the lazy clean-up and the sweep (500 per run); retention keeps `BracketMatch.scheduledAt`; organizer and SYSTEM refused as targets; titles need a visible character. Attendee-list cut-off not built (views have no clock) | Phase S10ad execution (DECISIONS.md A160) | 2026-11-11 |
| Fix pass: attendee list per opened event (`view_event_attendees(eventId)`; `view_my_calendar_invites` sends an invitee their own row only); Pending invites removed 7 days after the end (worst case end + 14 days); bracket cascades clear `scheduledAt` also after retention | Phase S10ad execution (DECISIONS.md A161) | 2026-11-11 |
| A match event's organizer edits it, reads its attendee list and its invite rows only with the tournament's bracket permission (linked rejection text without "the organizer"); an Admin reads every attendee list | Phase S11a execution (DECISIONS.md A162) | 2026-11-11 |

---

*Last updated: 2026-11-11 (S11a)*
*Feature owner: Phase 08*

**Behavior specification** (acceptance scenarios, edge cases, phase history): See [contract.md](contract.md)
