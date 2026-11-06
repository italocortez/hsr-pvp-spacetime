# Calendar & Scheduling

**Architecture:** [architecture.md](architecture.md)

## Feature Overview

Players can record recurring availability windows, bookmark other players' calendars to find common free time, and create calendar events with invites. Tournament organizers can schedule matches by creating events linked to bracket matches, with auto-invite of match participants. All calendar data is public. Common availability computation happens client-side from subscription data.

## Reducers

### create_availability_slot

**Purpose:** Create a new recurring or one-time availability window

**Permission:** Any authenticated user

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| startAt | Timestamp | Yes | Start of the availability window (UTC) |
| endAt | Timestamp | Yes | End of the availability window (UTC) |
| isRecurring | bool | Yes | Whether this slot repeats |
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
8. Lazy cleanup: delete any expired slots for this user (endAt/expiresAt + 1 week past)
9. Insert AvailabilitySlot row

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Guest caller | "Guests cannot create availability slots." |
| startAt >= endAt | "Start time must be before end time." |
| startAt > 6 months ahead | "Cannot create availability more than 6 months in the future." |
| isRecurring but no recurrenceType | "Recurrence type is required for recurring slots." |
| Slot cap reached (10) | "Maximum of 10 availability slots reached." |

### update_availability_slot

**Purpose:** Edit an existing availability slot

**Permission:** Owner only

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| slotId | u32 | Yes | Target slot ID |
| startAt | Timestamp? | No | New start time |
| endAt | Timestamp? | No | New end time |
| isRecurring | bool? | No | Change recurrence |
| recurrenceType | RecurrenceType? | No | Change type |
| interval | u8? | No | Change interval |
| dayOfWeek | u8? | No | Change day of week |
| dayOfMonth | u8? | No | Change day of month |
| endDate | Timestamp? | No | Change recurrence end date |

**Flow:**
1. Find slot by ID
2. Verify caller owns the slot (userId match)
3. Apply provided fields, preserve unchanged fields
4. Validate updated startAt < endAt
5. Update row via id.update()

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Slot not found | "Availability slot #{id} not found." |
| Not owner | "You can only edit your own availability slots." |
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
| Slot not found | "Availability slot #{id} not found." |
| Not owner and not Admin | "You can only delete your own availability slots." |

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
| Target user not found | "User #{id} not found." |
| Cap reached (5) | "Maximum of 5 saved calendars reached." |
| Already saved | "Calendar already saved." |

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
| description | string? | No | Optional event notes |
| startAt | Timestamp | Yes | Event start (UTC) |
| endAt | Timestamp | Yes | Event end (UTC) |
| bracketMatchId | u32? | No | Optional link to bracket match |
| inviteeUserIds | u32[] | No | Users to invite (max 9) |

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
5. Check cap: organizer has < 40 active CalendarEvents
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
| bracketMatchId not found | "Bracket match #{id} not found." |
| Caller lacks tournament permission | "Forbidden: Requires Tournament Host, Admin, Moderator, or Assistant privileges for this tournament." |
| Duplicate bracketMatchId | "A calendar event already exists for this bracket match." |
| Event cap reached (40) | "Maximum of 40 active calendar events reached." |
| Too many invitees (> 9) | "Maximum of 9 invitees per event." |
| Invitee not found | "User #{id} not found." |

### update_calendar_event

**Purpose:** Edit an existing calendar event

**Permission:** Organizer or Admin

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| eventId | u32 | Yes | Target event ID |
| title | string? | No | New title |
| description | string? | No | New description |
| startAt | Timestamp? | No | New start time |
| endAt | Timestamp? | No | New end time |

**Flow:**
1. Find event by ID
2. Verify caller is organizer or Admin
3. Apply provided fields, preserve unchanged
4. Validate updated startAt < endAt
5. Update row via id.update()

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Event not found | "Calendar event #{id} not found." |
| Not organizer and not Admin | "Only the event organizer or an admin can edit this event." |
| startAt >= endAt after update | "Start time must be before end time." |

### delete_calendar_event

**Purpose:** Delete a calendar event and cascade-delete all invites

**Permission:** Organizer or Admin

**Flow:**
1. Find event by ID
2. Verify caller is organizer or Admin
3. Delete all CalendarEventInvite rows for this event
4. Delete the CalendarEvent row

**Error Cases:**
| Condition | Error Message |
|-----------|--------------|
| Event not found | "Calendar event #{id} not found." |
| Not organizer and not Admin | "Only the event organizer or an admin can delete this event." |

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
| Invite not found | "You have no invite for event #{id}." |
| Status is Pending | "Cannot respond with Pending status." |

### invite_to_event

**Purpose:** Add additional invitees to an existing event

**Permission:** Organizer or Admin

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| eventId | u32 | Yes | Target event |
| inviteeUserIds | u32[] | Yes | Users to invite |

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
| Event not found | "Calendar event #{id} not found." |
| Not organizer and not Admin | "Only the event organizer or an admin can invite to this event." |
| Total invites > 9 | "Maximum of 9 invitees per event." |
| User not found | "User #{id} not found." |
| Already invited | "User #{id} is already invited." |

### remove_invite

**Purpose:** Remove an invitee from a calendar event

**Permission:** Organizer or Admin

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
| Invite not found | "Invite not found for user #{id} on event #{eventId}." |
| Not organizer and not Admin | "Only the event organizer or an admin can remove invites." |

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
**When:** User calls `create_availability_slot` with startAt/endAt and isRecurring=true, Weekly
**Then:** AvailabilitySlot row created with recurrenceRule populated, expiresAt set to 6 months ahead

### Availability Slot Cap Enforcement

**Given:** User already has 10 availability slots
**When:** User calls `create_availability_slot`
**Then:** Rejected with "Maximum of 10 availability slots reached."

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
**Then:** Rejected with "Maximum of 5 saved calendars reached."

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
**Then:** Rejected with "A calendar event already exists for this bracket match."

### Non-TO Cannot Create Tournament Event

**Given:** Regular user exists, bracket match exists
**When:** User calls `create_calendar_event` with bracketMatchId
**Then:** Rejected with permission error

### Event Cap Enforcement

**Given:** User has 40 active calendar events
**When:** User calls `create_calendar_event`
**Then:** Rejected with "Maximum of 40 active calendar events reached."

### Invite Cap Enforcement

**Given:** Event exists with 8 invitees
**When:** Organizer calls `invite_to_event` with 2 more userIds
**Then:** Rejected with "Maximum of 9 invitees per event."

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
**Then:** CalendarEvent updated, invites unaffected

### Non-Organizer Cannot Edit Event

**Given:** User A organized event 1, User B is an invitee
**When:** User B calls `update_calendar_event` on event 1
**Then:** Rejected with "Only the event organizer or an admin can edit this event."

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
| Monthly recurrence on day 31 | Client clamps to last day of month (e.g., Feb 28/29) | Server stores original dayOfMonth=31 |
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

## Phase History

| Decision | Source | Date |
|----------|--------|------|
| 4-state InviteStatus enum (Pending/Accepted/Declined/Tentative) | Phase 08 CONTEXT.md (D-01) | 2026-03-28 |
| respondedAt timestamp on CalendarEventInvite | Phase 08 CONTEXT.md (D-02) | 2026-03-28 |
| Cascade delete events → invites | Phase 08 CONTEXT.md (D-03) | 2026-03-28 |
| 9-invitee cap (6 players + 2 coaches + 1 referee) | Phase 08 CONTEXT.md (D-04) | 2026-03-28 |
| All CalendarEvent data fully public | Phase 08 CONTEXT.md (D-05) | 2026-03-28 |
| 40-event cap per user | Phase 08 CONTEXT.md (D-06) | 2026-03-28 |
| 90-day auto-cleanup for events (lazy) | Phase 08 CONTEXT.md (D-07) | 2026-03-28 |
| Organizer + Admin edit permissions only | Phase 08 CONTEXT.md (D-08) | 2026-03-28 |
| Client-side availability computation | Phase 08 CONTEXT.md (D-09) | 2026-03-28 |
| 10-slot cap per user (configuration rows) | Phase 08 CONTEXT.md (D-10) | 2026-03-28 |
| Monthly recurrence clamps to last day | Phase 08 CONTEXT.md (D-11) | 2026-03-28 |
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

---

*Last updated: 2026-04-09*
*Feature owner: Phase 8*
