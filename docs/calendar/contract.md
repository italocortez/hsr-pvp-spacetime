# Calendar & Scheduling

**Architecture:** [architecture.md](architecture.md)

## Feature Overview

Players can record recurring availability windows, bookmark other players' calendars to find common free time, and create calendar events with invites. Tournament organizers can schedule matches by creating events linked to bracket matches, with auto-invite of match participants. All calendar data is public. Common availability computation happens client-side from subscription data. _Superseded in Phase S10ac execution (DECISIONS.md A157: recurrence removed; slots are dated intervals of kind Available or Blocked)._

## Reducers

### create_availability_slot

**Purpose:** Create a new recurring or one-time availability window _Superseded in Phase S10ac execution (DECISIONS.md A157: recurrence removed)._

**Permission:** Any authenticated user

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| startAt | Timestamp | Yes | Start of the availability window (UTC) |
| endAt | Timestamp | Yes | End of the availability window (UTC) |
| isRecurring _Superseded in Phase S10ac execution (DECISIONS.md A157: recurrence arguments removed; the arguments are startAt, endAt, kind)._ | bool | Yes | Whether this slot repeats |
| recurrenceType | RecurrenceType | No | Daily, Weekly, or Monthly (required if isRecurring) |
| interval | u8 | No | Recurrence interval (e.g., every 2 weeks) |
| dayOfWeek | u8? | No | 0-6 for Weekly recurrence |
| dayOfMonth | u8? | No | 1-31 for Monthly recurrence (clamped to last day of month by client) |
| endDate | Timestamp? | No | When recurrence stops (defaults to 6 months from now) |

**Flow:**
1. Verify caller is authenticated (not guest)
2. Validate startAt < endAt
3. Validate startAt is not more than 6 months in the future
4. If isRecurring, validate recurrenceType is provided
5. Check cap: user has < 10 AvailabilitySlot rows
6. If endDate not provided and isRecurring, set expiresAt to 6 months from now
7. If not recurring, set expiresAt to endAt
8. Lazy cleanup: delete any expired slots for this user (endAt/expiresAt + 1 week past) _Superseded in Phase S10ac execution (DECISIONS.md A157: clean-up uses endAt plus 1 week; a weekly sweep covers absent users)._
9. Insert AvailabilitySlot row

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Guest caller | "Guests cannot create availability slots." _Superseded in Phase S10 execution (DECISIONS.md A76)._ |
| startAt >= endAt | "Start time must be before end time." |
| startAt > 6 months ahead | "Cannot create availability more than 6 months in the future." _Superseded in Phase S10 execution (DECISIONS.md A76)._ |
| isRecurring but no recurrenceType | "Recurrence type is required for recurring slots." _Superseded in Phase S10 execution (DECISIONS.md A76)._ |
| Slot cap reached (10) | "Maximum of 10 availability slots reached." _Superseded in Phase S10 execution (DECISIONS.md A76)._ |

### update_availability_slot

**Purpose:** Edit an existing availability slot

**Permission:** Owner only

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| slotId | u32 | Yes | Target slot ID |
| startAt | Timestamp? | No | New start time _Superseded in Phase S10 execution (DECISIONS.md A76)._ |
| endAt | Timestamp? | No | New end time _Superseded in Phase S10 execution (DECISIONS.md A76)._ |
| isRecurring | bool? | No | Change recurrence _Superseded in Phase S10 execution (DECISIONS.md A76)._ |
| recurrenceType | RecurrenceType? | No | Change type _Superseded in Phase S10 execution (DECISIONS.md A76)._ |
| interval | u8? | No | Change interval _Superseded in Phase S10 execution (DECISIONS.md A76)._ |
| dayOfWeek | u8? | No | Change day of week _Superseded in Phase S10 execution (DECISIONS.md A76)._ |
| dayOfMonth | u8? | No | Change day of month _Superseded in Phase S10 execution (DECISIONS.md A76)._ |
| endDate | Timestamp? | No | Change recurrence end date _Superseded in Phase S10 execution (DECISIONS.md A76)._ |

**Flow:**
1. Find slot by ID
2. Verify caller owns the slot (userId match)
3. Apply provided fields, preserve unchanged fields
4. Validate updated startAt < endAt
5. Update row via id.update()

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Slot not found | "Availability slot #{id} not found." _Superseded in Phase S10 execution (DECISIONS.md A76)._ |
| Not owner | "You can only edit your own availability slots." _Superseded in Phase S10 execution (DECISIONS.md A76)._ |
| startAt >= endAt after update | "Start time must be before end time." |

### delete_availability_slot

**Purpose:** Delete an availability slot

**Permission:** Owner or Admin

**Flow:**
1. Find slot by ID
2. Verify caller owns the slot or is Admin
3. Delete the row

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Slot not found | "Availability slot #{id} not found." _Superseded in Phase S10 execution (DECISIONS.md A76)._ |
| Not owner and not Admin | "You can only delete your own availability slots." _Superseded in Phase S10 execution (DECISIONS.md A76)._ |

### save_calendar

**Purpose:** Bookmark another player's calendar for availability viewing

**Permission:** Any authenticated user

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| targetUserId | u32 | Yes | User whose calendar to bookmark |

**Flow:**
1. Verify caller is authenticated
2. Verify targetUserId is not self
3. Verify target user exists
4. Check cap: user has < 5 SavedCalendar rows
5. Check for duplicate (userId + targetUserId composite PK)
6. Insert SavedCalendar row with isVisible = true

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Guest caller | "Guests cannot save calendars." |
| Saving own calendar | "Cannot save your own calendar." |
| Target user not found | "User #{id} not found." _Superseded in Phase S10 execution (DECISIONS.md A76)._ |
| Cap reached (5) | "Maximum of 5 saved calendars reached." _Superseded in Phase S10 execution (DECISIONS.md A76)._ |
| Already saved | "Calendar already saved." _Superseded in Phase S10 execution (DECISIONS.md A76)._ |

### unsave_calendar

**Purpose:** Remove a saved calendar bookmark

**Permission:** Owner only

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| targetUserId | u32 | Yes | User whose calendar to unsave |

**Flow:**
1. Find SavedCalendar row by composite PK [callerId, targetUserId]
2. Delete the row

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Not saved | "Calendar not saved." |

### toggle_calendar_visibility

**Purpose:** Show or hide a saved calendar in the frontend view without removing the bookmark

**Permission:** Owner only

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| targetUserId | u32 | Yes | Target calendar |
| isVisible | bool | Yes | New visibility state |

**Flow:**
1. Find SavedCalendar row by composite PK [callerId, targetUserId]
2. Update isVisible field

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Not saved | "Calendar not saved." |

### create_calendar_event

**Purpose:** Create a calendar event, optionally linked to a bracket match with auto-invite

**Permission:** Any authenticated user for personal events; TO/Admin/Moderator/Tournament Assistant for tournament-linked events

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| title | string | Yes | Event title |
| description | string? | No | Optional event notes _Superseded in Phase S10 execution (DECISIONS.md A76)._ |
| startAt | Timestamp | Yes | Event start (UTC) |
| endAt | Timestamp | Yes | Event end (UTC) |
| bracketMatchId | u32? | No | Optional link to bracket match _Superseded in Phase S10 execution (DECISIONS.md A76)._ |
| inviteeUserIds | u32[] | No | Users to invite (max 9) _Superseded in Phase S10 execution (DECISIONS.md A76)._ |

**Flow:**
1. Verify caller is authenticated
2. Validate title is non-empty
3. Validate startAt < endAt
4. If bracketMatchId provided:
   a. Verify caller is TO (tournament organizer), Admin, Moderator, or Tournament Assistant for that tournament
   b. Verify bracketMatchId exists
   c. Verify no other CalendarEvent already links to this bracketMatchId (one event per match)
   d. Look up match participants: BracketMatch → TournamentTeam → TournamentTeamMember → TournamentEnrolled
   e. Auto-create CalendarEventInvite rows for all players (InviteStatus.Pending)
5. Check cap: organizer has < 40 active CalendarEvents _Superseded in Phase S10b execution (DECISIONS.md A79)._
6. Insert CalendarEvent row with organizerId = caller
7. If inviteeUserIds provided (manual invites):
   a. Validate total invitees (auto + manual) ≤ 9
   b. Validate each invitee user exists
   c. Create CalendarEventInvite rows for each (InviteStatus.Pending)
8. Lazy cleanup: delete CalendarEvents older than 90 days for this user (+ cascade invites)

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Guest caller | "Guests cannot create calendar events." |
| Empty title | "Event title must not be empty." |
| startAt >= endAt | "Start time must be before end time." |
| bracketMatchId not found | "Bracket match #{id} not found." _Superseded in Phase S10 execution (DECISIONS.md A76)._ |
| Caller lacks tournament permission | "Forbidden: Requires Tournament Host, Admin, Moderator, or Assistant privileges for this tournament." _Superseded in Phase S10 execution (DECISIONS.md A76)._ |
| Duplicate bracketMatchId | "A calendar event already exists for this bracket match." _Superseded in Phase S10 execution (DECISIONS.md A76)._ |
| Event cap reached (40) | "Maximum of 40 active calendar events reached." _Superseded in Phase S10 execution (DECISIONS.md A76)._ |
| Too many invitees (> 9) | "Maximum of 9 invitees per event." _Superseded in Phase S10 execution (DECISIONS.md A76)._ |
| Invitee not found | "User #{id} not found." _Superseded in Phase S10 execution (DECISIONS.md A76)._ |

### update_calendar_event

**Purpose:** Edit an existing calendar event

**Permission:** Organizer or Admin _Superseded in Phase S10d execution (DECISIONS.md A89)._

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| eventId | u32 | Yes | Target event ID |
| title | string? | No | New title _Superseded in Phase S10 execution (DECISIONS.md A76)._ |
| description | string? | No | New description _Superseded in Phase S10 execution (DECISIONS.md A76)._ |
| startAt | Timestamp? | No | New start time _Superseded in Phase S10 execution (DECISIONS.md A76)._ |
| endAt | Timestamp? | No | New end time _Superseded in Phase S10 execution (DECISIONS.md A76)._ |

**Flow:**
1. Find event by ID
2. Verify caller is organizer or Admin
3. Apply provided fields, preserve unchanged
4. Validate updated startAt < endAt
5. Update row via id.update()

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Event not found | "Calendar event #{id} not found." _Superseded in Phase S10 execution (DECISIONS.md A76)._ |
| Not organizer and not Admin | "Only the event organizer or an admin can edit this event." _Superseded in Phase S10 execution (DECISIONS.md A76)._ |
| startAt >= endAt after update | "Start time must be before end time." |

### delete_calendar_event

**Purpose:** Delete a calendar event and cascade-delete all invites

**Permission:** Organizer or Admin _Superseded in Phase S10d execution (DECISIONS.md A89)._

**Flow:**
1. Find event by ID
2. Verify caller is organizer or Admin
3. Delete all CalendarEventInvite rows for this event
4. Delete the CalendarEvent row

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Event not found | "Calendar event #{id} not found." _Superseded in Phase S10 execution (DECISIONS.md A76)._ |
| Not organizer and not Admin | "Only the event organizer or an admin can delete this event." _Superseded in Phase S10 execution (DECISIONS.md A76)._ |

### respond_to_invite

**Purpose:** Accept, decline, or tentatively accept a calendar event invite

**Permission:** Invitee only

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| eventId | u32 | Yes | Target event |
| status | InviteStatus | Yes | Accepted, Declined, or Tentative |

**Flow:**
1. Find CalendarEventInvite by composite PK [eventId, callerId]
2. Verify caller is the invitee
3. Update inviteStatus and set respondedAt to current timestamp
4. Update audit columns

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Invite not found | "You have no invite for event #{id}." _Superseded in Phase S10 execution (DECISIONS.md A76)._ |
| Status is Pending | "Cannot respond with Pending status." |

### invite_to_event

**Purpose:** Add additional invitees to an existing event

**Permission:** Organizer or Admin _Superseded in Phase S10d execution (DECISIONS.md A89)._

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| eventId | u32 | Yes | Target event |
| inviteeUserIds | u32[] | Yes | Users to invite _Superseded in Phase S10 execution (DECISIONS.md A76)._ |

**Flow:**
1. Find event by ID
2. Verify caller is organizer or Admin
3. Count existing invites for this event
4. Validate total (existing + new) ≤ 9
5. For each new invitee:
   a. Verify user exists
   b. Check for duplicate invite
   c. Insert CalendarEventInvite row with InviteStatus.Pending

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Event not found | "Calendar event #{id} not found." _Superseded in Phase S10 execution (DECISIONS.md A76)._ |
| Not organizer and not Admin | "Only the event organizer or an admin can invite to this event." _Superseded in Phase S10 execution (DECISIONS.md A76)._ |
| Total invites > 9 | "Maximum of 9 invitees per event." _Superseded in Phase S10 execution (DECISIONS.md A76)._ |
| User not found | "User #{id} not found." _Superseded in Phase S10 execution (DECISIONS.md A76)._ |
| Already invited | "User #{id} is already invited." _Superseded in Phase S10 execution (DECISIONS.md A76)._ |

### remove_invite

**Purpose:** Remove an invitee from a calendar event

**Permission:** Organizer or Admin _Superseded in Phase S10d execution (DECISIONS.md A89)._

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| eventId | u32 | Yes | Target event |
| inviteeUserId | u32 | Yes | User to uninvite |

**Flow:**
1. Find CalendarEventInvite by composite PK [eventId, inviteeUserId]
2. Verify caller is event organizer or Admin
3. Delete the invite row

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Invite not found | "Invite not found for user #{id} on event #{eventId}." _Superseded in Phase S10 execution (DECISIONS.md A76)._ |
| Not organizer and not Admin | "Only the event organizer or an admin can remove invites." _Superseded in Phase S10 execution (DECISIONS.md A76)._ |

## Cascade Cleanup (Cross-Feature)

These are NOT standalone reducers — they are cleanup steps added to existing reducers in other features.

### cancel_tournament (extend)

When a tournament is cancelled, delete all CalendarEvents linked to that tournament's bracket matches, plus their invites.

**Flow addition:**
1. Find all BracketMatch rows for this tournament
2. For each bracketMatchId, find CalendarEvent where bracketMatchId matches
3. Delete CalendarEventInvite rows for each found event
4. Delete CalendarEvent rows

### rollback_bracket_match / dq_participant (extend)

When a bracket match is rolled back or a participant is DQ'd, delete the linked CalendarEvent + invites if one exists.

### withdraw_from_tournament (extend)

When a player withdraws from a tournament, delete their CalendarEventInvite rows for any CalendarEvents linked to that tournament's bracket matches.

### UserDeletionJob (extend)

When a user account is deleted, cascade-delete all calendar data:
1. Delete user's AvailabilitySlot rows
2. Delete SavedCalendar rows where userId = user (bookmarks they created)
3. Delete SavedCalendar rows where targetUserId = user (bookmarks of them)
4. Delete CalendarEventInvite rows where inviteeUserId = user
5. Delete CalendarEvents where organizerId = user (+ cascade their invites)

## Acceptance Scenarios

### Create and Manage Availability Slots

**Given:** Authenticated user exists
**When:** User calls `create_availability_slot` with startAt/endAt and isRecurring=true, Weekly _Superseded in Phase S10ac execution (DECISIONS.md A157: recurrence removed)._
**Then:** AvailabilitySlot row created with recurrenceRule populated, expiresAt set to 6 months ahead

### Availability Slot Cap Enforcement

**Given:** User already has 10 availability slots
**When:** User calls `create_availability_slot`
**Then:** Rejected with "Maximum of 10 availability slots reached." _Superseded in Phase S10 execution (DECISIONS.md A76)._

### Update Availability Slot

**Given:** User has an availability slot
**When:** User calls `update_availability_slot` with new startAt/endAt
**Then:** Slot updated via id.update(), times changed

### Delete Availability Slot

**Given:** User has an availability slot
**When:** User calls `delete_availability_slot`
**Then:** Slot row deleted

### Another User Cannot Edit/Delete Your Slot

**Given:** User A has a slot, User B exists
**When:** User B calls `update_availability_slot` or `delete_availability_slot` on User A's slot
**Then:** Rejected with ownership error

### Save and Unsave Calendar

**Given:** User A and User B exist
**When:** User A calls `save_calendar` with targetUserId = User B
**Then:** SavedCalendar row created with isVisible=true
**When:** User A calls `unsave_calendar` with targetUserId = User B
**Then:** SavedCalendar row deleted

### Saved Calendar Cap Enforcement

**Given:** User A already has 5 saved calendars
**When:** User A calls `save_calendar` for a 6th user
**Then:** Rejected with "Maximum of 5 saved calendars reached." _Superseded in Phase S10 execution (DECISIONS.md A76)._

### Cannot Save Own Calendar

**Given:** User A exists
**When:** User A calls `save_calendar` with targetUserId = self
**Then:** Rejected with "Cannot save your own calendar."

### Toggle Calendar Visibility

**Given:** User A has saved User B's calendar (isVisible=true)
**When:** User A calls `toggle_calendar_visibility` with isVisible=false
**Then:** SavedCalendar.isVisible updated to false (bookmark persists)

### Create Personal Calendar Event

**Given:** Authenticated user exists
**When:** User calls `create_calendar_event` with title, times, and 2 invitee userIds
**Then:** CalendarEvent created, 2 CalendarEventInvite rows with InviteStatus.Pending

### Create Tournament-Linked Event with Auto-Invite

**Given:** TO exists, bracket match 42 has Team A (2 players) vs Team B (2 players)
**When:** TO calls `create_calendar_event` with bracketMatchId=42, title, times
**Then:** CalendarEvent created with bracketMatchId=42; 4 CalendarEventInvite rows auto-created for match players

### One Event Per Bracket Match

**Given:** CalendarEvent already exists for bracketMatchId=42
**When:** TO calls `create_calendar_event` with bracketMatchId=42
**Then:** Rejected with "A calendar event already exists for this bracket match." _Superseded in Phase S10 execution (DECISIONS.md A76)._

### Non-TO Cannot Create Tournament Event

**Given:** Regular user exists, bracket match exists
**When:** User calls `create_calendar_event` with bracketMatchId
**Then:** Rejected with permission error

### Event Cap Enforcement

**Given:** User has 40 active calendar events
**When:** User calls `create_calendar_event`
**Then:** Rejected with "Maximum of 40 active calendar events reached." _Superseded in Phase S10 execution (DECISIONS.md A76)._

### Invite Cap Enforcement

**Given:** Event exists with 8 invitees
**When:** Organizer calls `invite_to_event` with 2 more userIds
**Then:** Rejected with "Maximum of 9 invitees per event." _Superseded in Phase S10 execution (DECISIONS.md A76)._

### Respond to Invite

**Given:** User B has a pending invite to event 1
**When:** User B calls `respond_to_invite` with status=Accepted
**Then:** CalendarEventInvite.inviteStatus updated to Accepted, respondedAt set

### Change Invite Response

**Given:** User B previously accepted invite to event 1
**When:** User B calls `respond_to_invite` with status=Declined
**Then:** InviteStatus updated to Declined, respondedAt updated

### Organizer Edits Event

**Given:** User A organized event 1
**When:** User A calls `update_calendar_event` with new title and times
**Then:** CalendarEvent updated, invites unaffected _Superseded in Phase S10ac execution (DECISIONS.md A157: a time change sets every invite to Pending)._

### Non-Organizer Cannot Edit Event

**Given:** User A organized event 1, User B is an invitee
**When:** User B calls `update_calendar_event` on event 1
**Then:** Rejected with "Only the event organizer or an admin can edit this event." _Superseded in Phase S10 execution (DECISIONS.md A76)._

### Delete Event Cascades Invites

**Given:** Event 1 has 5 invitees
**When:** Organizer calls `delete_calendar_event`
**Then:** All 5 CalendarEventInvite rows deleted, CalendarEvent row deleted

### Tournament Cancellation Cascades

**Given:** Tournament has 4 bracket matches, 2 have CalendarEvents with invites
**When:** Admin calls `cancel_tournament`
**Then:** Both CalendarEvents and all their invites deleted in same transaction

### Bracket Match Rollback Cascades

**Given:** Bracket match 42 has a linked CalendarEvent with 4 invites
**When:** Admin calls `rollback_bracket_match` on match 42
**Then:** CalendarEvent and 4 invites deleted

### Tournament Withdrawal Cleanup

**Given:** Player B is in tournament, has invites for 3 scheduled matches
**When:** Player B calls `withdraw_from_tournament`
**Then:** Player B's 3 CalendarEventInvite rows for that tournament's matches deleted

### User Deletion Cascades Calendar Data

**Given:** User A has 5 slots, 3 saved calendars, 2 organized events, 4 received invites
**When:** Admin deletes User A's account
**Then:** All AvailabilitySlots, SavedCalendars (both directions), CalendarEvents (+ their invites), CalendarEventInvites deleted

### Lazy Cleanup of Old Events

**Given:** User has CalendarEvents older than 90 days
**When:** User calls any calendar reducer (create event, create slot, etc.)
**Then:** Old events + their invites silently deleted before the main operation

### Lazy Cleanup of Expired Slots

**Given:** User has AvailabilitySlots expired more than 1 week ago
**When:** User calls any calendar reducer
**Then:** Expired slots silently deleted before the main operation

## Edge Cases

| Case | Expected Behavior | Notes |
|------|-------------------|-------|
| Guest creates slot/event/save | Rejected with guest-specific error | All calendar reducers require authentication |
| Invitee responds with Pending status | Rejected | Pending is initial state, not a valid response |
| Organizer invites self | Allowed but unusual | No explicit guard — organizer may want to track their own RSVP |
| bracketMatchId points to deleted match | Rejected: match not found | Validated at creation time |
| Monthly recurrence on day 31 _Superseded in Phase S10ac execution (DECISIONS.md A157: recurrence removed)._ | Client clamps to last day of month (e.g., Feb 28/29) | Server stores original dayOfMonth=31 |
| Overlapping availability slots | Allowed | Slots are advisory, no server-side overlap validation |
| Event with 0 invitees | Allowed — treated as blocked/personal time | No invites required |
| Update event with bracketMatchId | bracketMatchId is immutable after creation | Delete and recreate to change link |
| All timestamps | UTC — frontend handles timezone conversion | Consistent with all other tables |
| Changing all caps (10 slots, 40 events, 5 calendars, 9 invites) | Update reducer logic and republish | No --clear-database needed |

## Integration Points

| This Feature | Connects To | How | Direction |
|-------------|------------|-----|-----------|
| CalendarEvent.bracketMatchId | BracketMatch.id | FK reference | Reads |
| CalendarEvent.organizerId | User.id | FK reference | Reads |
| CalendarEventInvite.inviteeUserId | User.id | FK reference | Reads |
| Auto-invite | BracketMatch → TournamentTeam → TournamentTeamMember → TournamentEnrolled | Participant lookup chain | Reads |
| cancel_tournament cascade | CalendarEvent + CalendarEventInvite | Cleanup linked events | Writes (delete) |
| rollback_bracket_match cascade | CalendarEvent + CalendarEventInvite | Cleanup linked event | Writes (delete) |
| dq_participant cascade | CalendarEvent + CalendarEventInvite | Cleanup linked event | Writes (delete) |
| withdraw_from_tournament cascade | CalendarEventInvite | Cleanup player's invites | Writes (delete) |
| UserDeletionJob cascade | All 4 calendar tables | Full user data cleanup | Writes (delete) |
| SavedCalendar | AvailabilitySlot (client-side) | Subscription routing: client reads saved userIds, subscribes to their slots | Reads (client) |

## Acceptance Scenarios (Phase S9b execution)

The calendar tables are private (A37 calendar contexts; supersedes the Phase 08 D-05 "All CalendarEvent data fully public"); A45(4) keeps calendars public between players: a saved player's availability and own events are visible to every saver.

### S9b-C1 Events the caller sees
**Given** Carol organizes event E1 inviting Dave; Dave organizes E2; a TO created E3 for the bracket match of Dave's team; Dave saved Erin's calendar (shown) and Frank's (hidden); Erin organizes E4, Frank E5
**When** Dave reads `view_my_calendar_events`
**Then** E1, E2, E3 and E4 arrive once each with the organizer's display name as `organizerLabel`; E5 does not. E3 stays visible to Dave if his invite row is removed, as long as his team plays the match. An outsider reads none of them.

### S9b-C2 Invites and RSVPs
**When** Dave reads `view_my_calendar_invites`
**Then** his invite to E1 arrives with `inviterLabel` = Carol's name, its status and `respondedAt`; the other invitees of E1 do not. **When** Carol reads it, every invite of E1 arrives with the invitee's id, name and response. Responding updates the row in place. _Superseded in Phase S10ac execution (DECISIONS.md A157: an invitee of a personal event receives all invite rows of that event)._

### S9b-C3 Availability and saved calendars
**When** Dave reads `view_my_availability`, `view_saved_calendar_availability` and `view_my_saved_calendars`
**Then** he gets his own slots; Erin's slots with her id and name, none of Frank's (hidden); and both bookmarks with the target's name, avatar and `isVisible`. Showing Frank's calendar again sends his slots and events. No row carries an audit column; no calendar page subscribes the `User` table.

### S9b-C4 Finding a player
**When** Dave enters Erin's exact username in "Add calendar" or "Invite players"
**Then** `view_user_by_username('<username>')` returns Erin's id, name and avatar; a prefix or an unknown name returns nothing.

## Phase History

| Decision | Source | Date |
|----------|--------|------|
| 4-state InviteStatus enum (Pending/Accepted/Declined/Tentative) | Phase 08 CONTEXT.md (D-01) | 2026-03-28 |
| respondedAt timestamp on CalendarEventInvite | Phase 08 CONTEXT.md (D-02) | 2026-03-28 |
| Cascade delete events → invites | Phase 08 CONTEXT.md (D-03) | 2026-03-28 |
| 9-invitee cap (6 players + 2 coaches + 1 referee) | Phase 08 CONTEXT.md (D-04) | 2026-03-28 |
| All CalendarEvent data fully public | Phase 08 CONTEXT.md (D-05) | 2026-03-28 |
| 40-event cap per user | Phase 08 CONTEXT.md (D-06) | 2026-03-28 _Superseded in Phase S10b execution (DECISIONS.md A79)._ |
| 90-day auto-cleanup for events (lazy) | Phase 08 CONTEXT.md (D-07) | 2026-03-28 |
| Organizer + Admin edit permissions only | Phase 08 CONTEXT.md (D-08) | 2026-03-28 |
| Client-side availability computation | Phase 08 CONTEXT.md (D-09) | 2026-03-28 |
| 10-slot cap per user (configuration rows) _Superseded in Phase S10ac execution (DECISIONS.md A157: 10 slots per UTC week)._ | Phase 08 CONTEXT.md (D-10) | 2026-03-28 |
| Monthly recurrence clamps to last day _Superseded in Phase S10ac execution (DECISIONS.md A157: recurrence removed)._ | Phase 08 CONTEXT.md (D-11) | 2026-03-28 |
| Full CRUD on availability slots | Phase 08 CONTEXT.md (D-12) | 2026-03-28 |
| All timestamps UTC | Phase 08 CONTEXT.md (D-13) | 2026-03-28 |
| Overlapping slots allowed | Phase 08 CONTEXT.md (D-14) | 2026-03-28 |
| SavedCalendar is pure bookmark, no approval | Phase 08 CONTEXT.md (D-15) | 2026-03-28 |
| isVisible kept as frontend UI filter | Phase 08 CONTEXT.md (D-16) | 2026-03-28 |
| Auto-invite match participants on bracketMatchId | Phase 08 CONTEXT.md (D-17) | 2026-03-28 |
| Auto-invite players only (not coaches/referees) | Phase 08 CONTEXT.md (D-18) | 2026-03-28 |
| One CalendarEvent per bracketMatchId | Phase 08 CONTEXT.md (D-19) | 2026-03-28 |
| TO + Admin + Moderator + Assistant permissions for tournament events | Phase 08 CONTEXT.md (D-20) | 2026-03-28 |
| Tournament cancellation cascades CalendarEvents | Phase 08 CONTEXT.md (D-21) | 2026-03-28 |
| Rollback and DQ cascade-delete linked events | Phase 08 CONTEXT.md (D-22) | 2026-03-28 |
| User deletion cascades all calendar data | Phase 08 CONTEXT.md (D-23) | 2026-03-28 |
| Tournament withdrawal deletes player's invites | Phase 08 CONTEXT.md (D-24) | 2026-03-28 |
| Any user can create personal events | Phase 08 CONTEXT.md (D-25) | 2026-03-28 |
| Optional description field on CalendarEvent | Phase 08 CONTEXT.md (D-26) | 2026-03-28 |
| 1-week auto-cleanup for expired availability slots | Phase 08 CONTEXT.md (D-27) | 2026-03-28 |
| 6-month creation window for slots | Phase 08 CONTEXT.md (D-28) | 2026-03-28 |

---

| TournamentParticipant renamed to TournamentEnrolled + TournamentTeamMember | Phase 10.1 execution | 2026-04-03 |
| Full hydration from codebase | Phase 13 normalization | 2026-04-09 |
| Scenarios S9b-C1..C4: the calendar tables are private (supersedes D-05) and read through five per-sender views; events visible to organizer, invitees, both teams of a linked match and visible savers; invite lists for organizers; availability and bookmarks with labels; exact username search | Phase S9b execution (DECISIONS.md A37, A40, A43, A44, A48) | 2026-11-08 |
| A tournament-linked event stays visible to both teams' members whatever the invite rows: `remove_invite` on a match event deletes the RSVP row only and cannot hide the event from a removed team member; stand-ins see it only through an invite row | Phase S9b execution (DECISIONS.md A37, A40) | 2026-11-08 |
| Rejection texts as implemented (tests `s10-calendar`). Availability: "Guests cannot manage availability slots.", "Availability slots cannot be scheduled more than 6 months in advance.", "Recurring slots require a recurrence type (Daily, Weekly, or Monthly).", "Maximum 10 availability slots per user.", "Availability slot not found.", "Not your availability slot." (update by a non-owner), "Forbidden: You can only delete your own availability slots.". Saved calendars: "Target user not found.", "Maximum 5 saved calendars per user.", "Already saved.". Events: "Bracket match not found.", "This action needs the bracket permission." (A25: an Assistant needs the bracket permission), "A calendar event already exists for this bracket match. Delete it first to reschedule.", "Maximum 40 calendar events per user." (counts every event the caller organizes after the 90-day cleanup), "Maximum 9 invitees per event.", "User <id> not found." (`create_calendar_event`), "Invitee user not found." (`invite_to_event`), "User is already invited to this event.", "Calendar event not found.", "Forbidden: Only the organizer or an Admin can update this event." / "… can delete this event." / "… can invite users to this event." / "… can remove invites from this event.", "Invite not found.". RSVP: "You have no invite for this event." _Superseded in Phase S10ac execution (DECISIONS.md A157: recurrence and total-cap texts are gone; new texts in the S10ac rows)._ | Phase S10 execution (DECISIONS.md A76) | 2026-11-09 |
| Parameter shapes as implemented: `invite_to_event(eventId, inviteeUserId)` invites one user per call; `create_calendar_event(title, description, startAt, endAt, bracketMatchId, inviteeUserIds)` takes every field (`''` = no description, `0` = no bracket link, `inviteeUserIds` a comma-separated string whose non-numeric parts are ignored); `update_availability_slot` and `update_calendar_event` take every field and replace the row (no partial update) | Phase S10 execution (DECISIONS.md A76) | 2026-11-09 |
| Event caps: `create_calendar_event` rejects when the caller organizes 40 events that have not ended (`endAt >= now`, after the lazy cleanup): "Maximum 40 active calendar events per user."; then when the caller organizes 100 events in total, ended or not: "Maximum 100 calendar events per user.". Finished events no longer count against the 40. This replaces the text "Maximum 40 calendar events per user." of the Phase S10 row above | Phase S10b execution (DECISIONS.md A79) | 2026-11-09 |
| Past-date guards: `create_calendar_event` rejects an `endAt` in the past and `update_calendar_event` rejects a changed `endAt` in the past, both with "Event end time must not be in the past."; an update that keeps `endAt` (title or description of a finished event) is accepted. The 90-day event cleanup (D-07) and the one-week slot cleanup (D-27) are unchanged _Superseded in Phase S10ac execution (DECISIONS.md A157: a start in the past is refused on create and when the start moves)._ | Phase S10b execution (DECISIONS.md A79) | 2026-11-09 |
| Tournament-linked events (`bracketMatchId` set): `update_calendar_event`, `delete_calendar_event`, `invite_to_event` and `remove_invite` also accept anyone holding the tournament's `bracket` permission (the tournament organizer, an assistant with the bracket flag, a Moderator, an Admin); others get "Forbidden: Only the organizer, an Admin or tournament staff with the bracket permission can <action>.". Personal events keep "Organizer or Admin" | Phase S10d execution (DECISIONS.md A89) | 2026-11-09 |
| `update_calendar_event` rejects moving an ended event's `endAt` to now or later when the event's organizer already has 40 not-yet-ended events: "Maximum 40 active calendar events per user." | Phase S10d execution (DECISIONS.md A90) | 2026-11-09 |
| Event texts: title 1 to 100 characters after trimming, description at most 1000. Duplicate manual invitee ids produce one invite. An `endDate` of '' or '0' means no end date for both `expiresAt` and the recurrence rule _Superseded in Phase S10ac execution (DECISIONS.md A157: limits count characters; the invitee list is parsed strictly; no endDate)._ | Phase S10f execution (backend audit 2026-11-09, calendar findings 2, 3, 5) | 2026-11-09 |
| When a guest's tournament entry moves to an existing user at sign-in (A112), the guest's invites for events linked to that tournament's bracket matches are re-pointed to that user with their status kept; if the user already holds an invite for the event the guest's is only removed. Invites of other tournaments and personal events are deleted with the guest as before | Phase S10m execution (DECISIONS.md A113) | 2026-11-10 |
| Every calendar reducer runs, in order: authentication, the per-user allowance (20 per 10 s, "You are doing that too quickly. Please wait a moment."), the clean-up of the caller's own old events and expired slots (sparing the call's own target), then the operation. `view_my_calendar_events` skips Completed and Cancelled tournaments | Phase S10s execution (DECISIONS.md A122(4), (22)) | 2026-11-10 |
| A match event invites the team members first and approved stand-ins while room is left under the 9-invite cap; a stand-in approved later is invited if room is left; the invite goes with the approval; a stand-in sees the event of their match in `view_my_calendar_events` either way | Phase S10v execution (DECISIONS.md A135) | 2026-11-10 |
| Slot kind: `create_availability_slot(startAt, endAt, kind)` and `update_availability_slot(slotId, startAt, endAt, kind)` take `Available` or `Blocked` ("Invalid slot kind. Must be Available or Blocked."); both availability views carry the kind. A personal event may not overlap the organizer's own Blocked slot on create or on a time change ("This time overlaps one of your blocked slots."; for an Admin edit "This time overlaps one of the organizer's blocked slots."); touching intervals pass; tournament match events are exempt | Phase S10ac execution (DECISIONS.md A157) | 2026-11-11 |
| Slot cap: at most 10 slots per UTC week (Monday 00:00 UTC), counted by start, both kinds, slots that have ended not counted; an update checks the new week without counting itself ("You can set at most 10 availability slots per week."). The 6-month window stays _Superseded in Phase S10ad execution (DECISIONS.md A160(1): 10 per kind, ended slots count)._ | Phase S10ac execution (DECISIONS.md A157) | 2026-11-11 |
| Recurrence is removed: no recurrence columns, arguments, rules or view fields; every slot is one dated interval | Phase S10ac execution (DECISIONS.md A157) | 2026-11-11 |
| A change of an event's start or end sets every kept invite to Pending and clears `respondedAt`, whoever makes the change; a title or notes edit keeps the answers | Phase S10ac execution (DECISIONS.md A157) | 2026-11-11 |
| `view_my_calendar_invites`: an invitee of a personal event receives all invite rows of that event. For a match event the full list goes to every invitee unless the tournament is anonymous; then only to an invitee holding the bracket permission, and to the event's organizer _Superseded in Phase S10ad execution (DECISIONS.md A161(1): the list comes from `view_event_attendees`)._ | Phase S10ac execution (DECISIONS.md A157) | 2026-11-11 |
| `view_my_calendar_events`: a saver receives a saved player's events as busy blocks (`isBusyBlock`, organizer id, label and avatar, start, end; empty title, no notes, no match id); an event the saver also reaches another way arrives once, in full | Phase S10ac execution (DECISIONS.md A157) | 2026-11-11 |
| Targets: a guest or a user pending deletion cannot be saved ("A guest's calendar cannot be saved.", "This user's account is being deleted; their calendar cannot be saved.") or invited ("Guests cannot be invited to calendar events.", "This user's account is being deleted; they cannot be invited."). Invites written by the server for team members and stand-ins are not checked | Phase S10ac execution (DECISIONS.md A157) | 2026-11-11 |
| `remove_invite` accepts the invitee on their own invite; the personal event then stops arriving. A Declined invitee still receives the event, without notes. A team member or stand-in of a match event keeps seeing it through the team path | Phase S10ac execution (DECISIONS.md A157) | 2026-11-11 |
| A start in the past is refused on create and when an update moves the start, for slots and events ("You can't schedule something in the past.") | Phase S10ac execution (DECISIONS.md A157) | 2026-11-11 |
| The weekly `run_identity_gc` also removes slots ended more than 7 days ago and events ended more than 90 days ago with their invites, for every owner, at most 500 of each per run, oldest first; leftovers bring the next run forward to 1 hour _Superseded in Phase S10ad execution (DECISIONS.md A161(2): it also removes Pending invites of events ended more than 7 days ago, 500 per run)._ | Phase S10ac execution (DECISIONS.md A157) | 2026-11-11 |
| Time arguments: 1 to 19 digits within 2020-01-01 to 2100-01-01 ("Invalid start time." / "Invalid end time."); a slot lasts at most 24 hours ("An availability slot can last at most 24 hours."), an event at most 7 days ("An event can last at most 7 days.") and starts at most 365 days ahead ("Events cannot be scheduled more than 12 months in advance."); title and notes limits count characters | Phase S10ac execution (DECISIONS.md A157) | 2026-11-11 |
| Event and invite rows carry avatar character names (organizer, invitee, inviter). `update_calendar_event` takes an optional `inviteeUserIds`: omitted leaves the set, an empty string removes everyone, otherwise it is the full set with the cap of 9 on the final set. The list is parsed strictly: comma-separated whole numbers from 1 to 4294967295, anything else refuses the call ("Invalid invitee list."), duplicates collapse. A match event writes its start to `BracketMatch.scheduledAt`, moves it on a time change and clears it when the event is deleted _Superseded in Phase S10ad execution (DECISIONS.md A160(6), A161(3): retention keeps the time; bracket cascades clear it)._ | Phase S10ac execution (DECISIONS.md A157) | 2026-11-11 |
| Corrections of older statements: `toggle_calendar_visibility(targetUserId, isVisible)` sets the flag given; calendar data is not public (views scope every row); the caller's own slots arrive through `view_my_availability`; further texts: "Guests cannot manage saved calendars.", "Guests cannot respond to event invites.", "Invalid status. Must be one of: Accepted, Declined, Tentative." | Phase S10ac execution (DECISIONS.md A157) | 2026-11-11 |
| Slot cap per kind: at most 10 Available and 10 Blocked slots per user per UTC week, counted separately by start; a slot that has ended still counts; an update checks the target week and kind without counting itself; only a delete frees a place ("You can set at most 10 available slots per week." / "You can set at most 10 blocked slots per week."). At most about 560 slot rows per user | Phase S10ad execution (DECISIONS.md A160(1)) | 2026-11-11 |
| A Blocked slot (created, moved, or switched from Available) is refused when it overlaps a personal event the caller organizes that has not ended ("This blocked slot overlaps one of your events."); touching intervals pass; match events are exempt | Phase S10ad execution (DECISIONS.md A160(3)) | 2026-11-11 |
| Pending invites of an event are removed once it ended more than 7 days ago: by the organizer's and the invitee's lazy clean-up and by the weekly sweep (500 invite rows per run). Answered invites stay until the event's retention. The event a call targets is spared in that call. Worst case: end + 14 days | Phase S10ad execution (DECISIONS.md A160(4), A161(2)) | 2026-11-11 |
| `view_event_attendees(eventId)` returns one event's invites (invitee id, label, avatar, status, `respondedAt`) to: the event's organizer; any invitee of a personal event; for a match event a holder of the bracket permission (with or without an invite) and, unless the tournament is anonymous, every invitee. Anyone else, an unknown or deleted event: no rows. `view_my_calendar_invites` gives an invitee only their own row and the organizer all rows of their events | Phase S10ad execution (DECISIONS.md A161(1)) | 2026-11-11 |
| Retention (lazy clean-up and sweep) keeps `BracketMatch.scheduledAt` when it removes an old match event; a deletion by a person clears it; a bracket cascade (staff resolve, rollback, cancel, disqualification, regeneration) clears it whether or not the event still exists | Phase S10ad execution (DECISIONS.md A160(6), A161(3)) | 2026-11-11 |
| The organizer cannot be among their own invitees ("You cannot invite yourself to your own event."; for an Admin or staff edit "The organizer cannot be invited to their own event."); the SYSTEM user cannot be invited or saved ("The SYSTEM user cannot be invited to calendar events.", "The SYSTEM user's calendar cannot be saved."). A title needs at least one visible character ("Event title must not be empty.") | Phase S10ad execution (DECISIONS.md A160(7)) | 2026-11-11 |
| Accepted as is: a team member or stand-in keeps seeing their match event after leaving its invite; guests are invited automatically to match events and cannot answer; a time change resets answers also when only the end moves; received invites have no cap per user; the week of the cap is UTC | Phase S10ad execution (DECISIONS.md A160(2)(4)(8), A161(4)) | 2026-11-11 |

---

*Last updated: 2026-04-09*
*Feature owner: Phase 8*
