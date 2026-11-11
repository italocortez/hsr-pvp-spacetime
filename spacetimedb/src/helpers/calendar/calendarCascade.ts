/**
 * Cascade deletion helpers for calendar entities.
 * Used by calendar reducers and cross-feature integrations (Plan 02).
 *
 * All functions operate within the same reducer transaction as the caller.
 */

import { updateWithAudit } from '@module/helpers/admin/auditHelpers';

/**
 * S10ac (A157(12)): writes a match event's start to its bracket match (`BracketMatch.scheduledAt`), or clears it
 * (`startAt` undefined). With `actorId` (create / update_calendar_event) the audit columns are stamped; the deletion
 * cascades have no actor and change the column only. A missing match is ignored.
 */
export function setBracketMatchSchedule(ctx: any, bracketMatchId: number | undefined, startAt: any | undefined, actorId?: number): void {
    if (bracketMatchId === undefined) return;
    const match = ctx.db.BracketMatch.id.find(bracketMatchId);
    if (!match) return;
    ctx.db.BracketMatch.id.update(actorId !== undefined
        ? updateWithAudit(ctx, match, { scheduledAt: startAt }, actorId)
        : { ...match, scheduledAt: startAt });
}

/**
 * Deletes all CalendarEventInvite rows for an event, then deletes the CalendarEvent itself.
 * Per D-03: event deletion must cascade to invites. S10ac (A157(12)): a match event's bracket match loses its
 * `scheduledAt` (every path that deletes an event comes here: delete_calendar_event, the tournament cascades, user
 * deletion, the lazy clean-up and the scheduled sweep).
 */
export function deleteCalendarEventWithInvites(ctx: any, eventId: number): void {
    const event = ctx.db.CalendarEvent.id.find(eventId);
    for (const invite of [...ctx.db.CalendarEventInvite.event_id.filter(eventId)]) {
        ctx.db.CalendarEventInvite.delete(invite);
    }
    ctx.db.CalendarEvent.id.delete(eventId);
    if (event) setBracketMatchSchedule(ctx, event.bracketMatchId, undefined);
}

/**
 * Finds all CalendarEvents linked to a bracket match and deletes them with their invites.
 * Per D-22: when a bracket match is deleted, its linked calendar event must also be deleted.
 */
export function deleteCalendarEventForBracketMatch(ctx: any, bracketMatchId: number): void {
    const events = [...ctx.db.CalendarEvent.bracket_match_id.filter(bracketMatchId)];
    for (const event of events) {
        deleteCalendarEventWithInvites(ctx, event.id);
    }
}

/**
 * Finds all bracket matches for a tournament and deletes linked calendar events.
 * Per D-21: when a tournament is deleted/cancelled, its bracket match calendar events must go too.
 */
export function deleteCalendarEventsForTournament(ctx: any, tournamentId: number): void {
    const bracketMatches = [...ctx.db.BracketMatch.tournament_id.filter(tournamentId)];
    for (const match of bracketMatches) {
        deleteCalendarEventForBracketMatch(ctx, match.id);
    }
}

/**
 * Removes a user's invite rows for all calendar events linked to a tournament's bracket matches.
 * Per D-24: when a participant withdraws from a tournament, their tournament match invites are removed.
 */
export function deleteUserInvitesForTournament(ctx: any, userId: number, tournamentId: number): void {
    const bracketMatches = [...ctx.db.BracketMatch.tournament_id.filter(tournamentId)];
    const matchIdSet = new Set<number>(bracketMatches.map((m: any) => m.id));

    const userInvites = [...ctx.db.CalendarEventInvite.invitee_user_id.filter(userId)];
    for (const invite of userInvites) {
        const event = ctx.db.CalendarEvent.id.find(invite.eventId);
        if (event && event.bracketMatchId !== undefined && matchIdSet.has(event.bracketMatchId)) {
            ctx.db.CalendarEventInvite.delete(invite);
        }
    }
}

/**
 * A113(5) (S10m): when a guest's tournament entry moves to an existing user (A112, moveEntry), the guest's invites to
 * events linked to bracket matches of that tournament are re-pointed to `toUserId` (same event, status and responded
 * time kept; audit columns updated). When `toUserId` already holds an invite for the event, the guest's invite is
 * deleted instead (one row per event and invitee). The event's invite count never grows, so the per-event cap
 * (MAX_INVITEES_PER_EVENT) holds. Invites to personal events and to other tournaments' events stay with the guest
 * (the deletion removes them). Index reads: invites by invitee, event by id, bracket match by id.
 */
export function moveUserInvitesForTournament(ctx: any, fromUserId: number, toUserId: number, tournamentId: number, actorId: number): void {
    for (const invite of [...ctx.db.CalendarEventInvite.invitee_user_id.filter(fromUserId)]) {
        const event = ctx.db.CalendarEvent.id.find(invite.eventId);
        if (!event || event.bracketMatchId === undefined) continue;
        const match = ctx.db.BracketMatch.id.find(event.bracketMatchId);
        if (!match || match.tournamentId !== tournamentId) continue;
        ctx.db.CalendarEventInvite.delete(invite);
        if ([...ctx.db.CalendarEventInvite.by_event_and_invitee.filter([invite.eventId, toUserId])].length === 0) {
            ctx.db.CalendarEventInvite.insert(updateWithAudit(ctx, invite, { inviteeUserId: toUserId }, actorId));
        }
    }
}

/**
 * Deletes all calendar data for a user account.
 * Per D-23: called during user deletion to clean up all calendar-related rows.
 *
 * Order:
 * 1. All AvailabilitySlot rows (user's own)
 * 2. All SavedCalendar rows where userId matches (subscriptions)
 * 3. All SavedCalendar rows where targetUserId matches (being watched by others)
 * 4. All CalendarEvent rows organized by the user, with cascaded invite deletion
 * 5. All CalendarEventInvite rows where the user is an invitee
 */
export function deleteAllCalendarDataForUser(ctx: any, userId: number): void {
    // 1. Availability slots
    for (const slot of [...ctx.db.AvailabilitySlot.user_id.filter(userId)]) {
        ctx.db.AvailabilitySlot.id.delete(slot.id);
    }

    // 2. SavedCalendar rows as subscriber
    for (const saved of [...ctx.db.SavedCalendar.user_id.filter(userId)]) {
        ctx.db.SavedCalendar.delete(saved);
    }

    // 3. SavedCalendar rows as target (others watching this user — iter is required here,
    //    no targetUserId-only index exists on SavedCalendar)
    for (const saved of [...ctx.db.SavedCalendar.iter()]) {
        if (saved.targetUserId === userId) {
            ctx.db.SavedCalendar.delete(saved);
        }
    }

    // 4. Organized CalendarEvents with cascaded invite deletion
    for (const event of [...ctx.db.CalendarEvent.organizer_id.filter(userId)]) {
        deleteCalendarEventWithInvites(ctx, event.id);
    }

    // 5. CalendarEventInvite rows where user is an invitee
    for (const invite of [...ctx.db.CalendarEventInvite.invitee_user_id.filter(userId)]) {
        ctx.db.CalendarEventInvite.delete(invite);
    }
}
