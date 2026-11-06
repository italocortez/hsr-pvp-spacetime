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
  |     startAt: Timestamp  [btree: start_at]
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
2. `cleanupExpiredSlots(ctx, userId)` -- lazy delete slots where `expiresAt + 1 week < now` (D-27)
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
2. `cleanupOldEvents(ctx, userId)` -- lazy delete events where `endAt + 90 days < now` (D-07)
3. If `bracketMatchId > 0` (tournament-linked, D-17):
   - Verify TO/Admin/Mod/Assistant access for the bracket match's tournament (D-20)
   - Check no existing event for that `bracketMatchId` via `bracket_match_id` index (D-19)
4. Validate cap: <=40 active CalendarEvents per user (D-06)
5. Insert `CalendarEvent` row
6. If tournament-linked: resolve `BracketMatch -> TournamentTeam -> TournamentTeamMember` for both teams; auto-insert `CalendarEventInvite` rows for all active participants (D-17, D-18)
7. Add manual invitees from `inviteeUserIds` (excluding already-auto-invited users); enforce cap of 9 total invitees (D-04)

### update_calendar_event(eventId, title?, description?, startAt?, endAt?)
1. `getAuthenticatedUser(ctx)`
2. Find event -- reject if not found; verify organizer OR Admin
3. `CalendarEvent.id.update()` -- cannot change `bracketMatchId` (D-08)

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

## Cross-Feature Cascades

All cascades run in the same transaction as the triggering reducer:

| Trigger | Helper | Decision |
|---------|--------|---------|
| `cancel_tournament` | `deleteCalendarEventsForTournament(ctx, tournamentId)` | D-21 -- runs before bracket match deletion |
| `rollback_bracket_match` | `deleteCalendarEventForBracketMatch(ctx, bracketMatchId)` | D-22 |
| `dq_participant` (auto-advance) | `deleteCalendarEventForBracketMatch(ctx, activeMatch.id)` | D-22 |
| `withdraw_from_tournament` | `deleteUserInvitesForTournament(ctx, userId, tournamentId)` | D-24 |
| `performUserDeletion` | `deleteAllCalendarDataForUser(ctx, userId)` | D-23 |

Cascade helper functions live in `spacetimedb/src/helpers/calendarCascade.ts`.

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

---

*Last updated: 2026-04-09*
*Feature owner: Phase 08*

**Behavior specification** (acceptance scenarios, edge cases, phase history): See [contract.md](contract.md)
