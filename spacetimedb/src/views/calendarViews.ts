// ─── Calendar Views ───────────────────────────────────────────────────────────
// S9b (A37 calendar contexts, A45(4), PAGE-MAP calendar + D2 / D7): the four calendar tables are private since S3;
// the calendar page reads them through these per-sender views. Names and avatars are denormalized (labels through
// resolveUserLabel), so no calendar route subscribes `User` (D2); a player is found by exact username through
// view_user_by_username (D7). No audit columns in any row.
//
// 1. view_my_calendar_events            — own events, events the caller is invited to, events of the caller's
//                                         tournament matches, events organized by the visible saved calendars
// 2. view_my_calendar_invites           — the caller's invites + the invites of the events the caller organizes
// 3. view_my_availability               — the caller's AvailabilitySlot rows
// 4. view_saved_calendar_availability   — the slots of the players whose calendars the caller saved (visible ones)
// 5. view_my_saved_calendars            — the caller's SavedCalendar rows with the target's label and avatar
//
// Index-only: no table scan in any view body.

import spacetimedb from '@module/schema';
import { t } from 'spacetimedb/server';
import { InviteStatus } from '@module/types/enums';
import { RecurrenceRule } from '@module/types/structs';
import { resolveUserLabel } from '@module/helpers/identity/userLabel';
import { callerUserId } from '@module/helpers/identity/viewAnonymity';

/** The caller's visible saved calendars' target ids (SavedCalendar.user_id; isVisible is the page's show / hide toggle, D-16). */
function visibleSavedTargets(ctx: any, me: number): number[] {
    const targets: number[] = [];
    for (const saved of ctx.db.SavedCalendar.user_id.filter(me)) {
        if (saved.isVisible) targets.push(saved.targetUserId);
    }
    return targets;
}

// ---------------------------------------------------------------------------
// 1. view_my_calendar_events — the CalendarEvent rows the caller may see, each once:
//    (a) events the caller organizes (organizer_id);
//    (b) events the caller is invited to (CalendarEventInvite.invitee_user_id);
//    (c) tournament-linked events of the bracket matches of the caller's teams (both teams' members see the
//        match event even without an invite row: TournamentEnrolled.user_id → TournamentTeamMember
//        .by_tournament_and_user → BracketMatch.tournament_id → CalendarEvent.bracket_match_id);
//    (d) events organized by a player whose calendar the caller saved and shows (A45(4): calendars are public
//        between players; isVisible = shown).
//    Row: id, organizerId, organizerLabel, title, description?, startAt, endAt, bracketMatchId?. The organizer is
//    identified (a personal event's organizer chose the invitees; a tournament event's organizer is staff); no
//    invitee list here (an anonymous tournament's players stay hidden from each other). PK `id` (edits update it).
// ---------------------------------------------------------------------------
const MyCalendarEventRow = t.row('MyCalendarEventRow', {
    id: t.u32().primaryKey(),
    organizerId: t.u32(),
    organizerLabel: t.string(),
    title: t.string(),
    description: t.string().optional(),
    startAt: t.timestamp(),
    endAt: t.timestamp(),
    bracketMatchId: t.u32().optional(),
});

export const view_my_calendar_events = spacetimedb.view(
    { name: 'view_my_calendar_events', public: true },
    t.array(MyCalendarEventRow),
    (ctx) => {
        const me = callerUserId(ctx);
        if (me === undefined) return [];
        const events = new Map<number, any>();
        const add = (event: any) => {
            if (event && !events.has(event.id)) events.set(event.id, event);
        };

        // (a) own
        for (const event of ctx.db.CalendarEvent.organizer_id.filter(me)) add(event);
        // (b) invited
        for (const invite of ctx.db.CalendarEventInvite.invitee_user_id.filter(me)) {
            add(ctx.db.CalendarEvent.id.find(invite.eventId));
        }
        // (c) the caller's teams' bracket matches
        for (const enrolled of ctx.db.TournamentEnrolled.user_id.filter(me)) {
            const myTeamId = [...ctx.db.TournamentTeamMember.by_tournament_and_user.filter([enrolled.tournamentId, me])][0]?.teamId;
            if (myTeamId === undefined) continue;
            for (const match of ctx.db.BracketMatch.tournament_id.filter(enrolled.tournamentId)) {
                if (match.team1Id !== myTeamId && match.team2Id !== myTeamId) continue;
                for (const event of ctx.db.CalendarEvent.bracket_match_id.filter(match.id)) add(event);
            }
        }
        // (d) visible saved calendars
        for (const targetUserId of visibleSavedTargets(ctx, me)) {
            for (const event of ctx.db.CalendarEvent.organizer_id.filter(targetUserId)) add(event);
        }

        const labels = new Map<number, string>();
        const rows: any[] = [];
        for (const event of events.values()) {
            let organizerLabel = labels.get(event.organizerId);
            if (organizerLabel === undefined) {
                organizerLabel = resolveUserLabel(ctx, event.organizerId).displayName;
                labels.set(event.organizerId, organizerLabel);
            }
            rows.push({
                id: event.id,
                organizerId: event.organizerId,
                organizerLabel,
                title: event.title,
                description: event.description,
                startAt: event.startAt,
                endAt: event.endAt,
                bracketMatchId: event.bracketMatchId,
            });
        }
        return rows;
    }
);

// ---------------------------------------------------------------------------
// 2. view_my_calendar_invites — CalendarEventInvite rows of (a) the caller (the inbox and RSVP) and (b) the events
//    the caller organizes (the organizer's invitee list and responses; remove_invite takes the invitee's id).
//    Row: inviteKey (PK = eventId << 32 | inviteeUserId; respond_to_invite updates the row in place), eventId,
//    inviteeUserId, inviteeLabel, inviteStatus, respondedAt?, inviterLabel (the invite's creator: the organizer,
//    or the Admin who added it). Another invitee's invite is never listed to an invitee.
//    Index-only: CalendarEventInvite.invitee_user_id / event_id, CalendarEvent.organizer_id, User.id, DeletedUser.id.
// ---------------------------------------------------------------------------
const MyCalendarInviteRow = t.row('MyCalendarInviteRow', {
    inviteKey: t.u64().primaryKey(),
    eventId: t.u32(),
    inviteeUserId: t.u32(),
    inviteeLabel: t.string(),
    inviteStatus: InviteStatus,
    respondedAt: t.timestamp().optional(),
    inviterLabel: t.string(),
});

export const view_my_calendar_invites = spacetimedb.view(
    { name: 'view_my_calendar_invites', public: true },
    t.array(MyCalendarInviteRow),
    (ctx) => {
        const me = callerUserId(ctx);
        if (me === undefined) return [];
        const labels = new Map<number, string>();
        const label = (userId: number): string => {
            let l = labels.get(userId);
            if (l === undefined) {
                l = resolveUserLabel(ctx, userId).displayName;
                labels.set(userId, l);
            }
            return l;
        };
        const rows = new Map<bigint, any>();
        const add = (invite: any, organizerId: number | undefined) => {
            const inviteKey = (BigInt(invite.eventId) << 32n) | BigInt(invite.inviteeUserId);
            if (rows.has(inviteKey)) return;
            const inviterId = invite.createdById !== 0 ? invite.createdById : organizerId;
            rows.set(inviteKey, {
                inviteKey,
                eventId: invite.eventId,
                inviteeUserId: invite.inviteeUserId,
                inviteeLabel: label(invite.inviteeUserId),
                inviteStatus: invite.inviteStatus,
                respondedAt: invite.respondedAt,
                inviterLabel: inviterId !== undefined ? label(inviterId) : '',
            });
        };

        // (a) the caller's own invites
        for (const invite of ctx.db.CalendarEventInvite.invitee_user_id.filter(me)) {
            add(invite, ctx.db.CalendarEvent.id.find(invite.eventId)?.organizerId);
        }
        // (b) the invites of the caller's events
        for (const event of ctx.db.CalendarEvent.organizer_id.filter(me)) {
            for (const invite of ctx.db.CalendarEventInvite.event_id.filter(event.id)) add(invite, event.organizerId);
        }
        return [...rows.values()];
    }
);

// ---------------------------------------------------------------------------
// 3. view_my_availability — the caller's AvailabilitySlot rows (AvailabilitySlot.user_id): id (PK, updates in
//    place), startAt, endAt, isRecurring, recurrenceRule, expiresAt.
// ---------------------------------------------------------------------------
const MyAvailabilityRow = t.row('MyAvailabilityRow', {
    id: t.u32().primaryKey(),
    startAt: t.timestamp(),
    endAt: t.timestamp(),
    isRecurring: t.bool(),
    recurrenceRule: RecurrenceRule,
    expiresAt: t.timestamp(),
});

export const view_my_availability = spacetimedb.view(
    { name: 'view_my_availability', public: true },
    t.array(MyAvailabilityRow),
    (ctx) => {
        const me = callerUserId(ctx);
        if (me === undefined) return [];
        const rows: any[] = [];
        for (const slot of ctx.db.AvailabilitySlot.user_id.filter(me)) {
            rows.push({
                id: slot.id,
                startAt: slot.startAt,
                endAt: slot.endAt,
                isRecurring: slot.isRecurring,
                recurrenceRule: slot.recurrenceRule,
                expiresAt: slot.expiresAt,
            });
        }
        return rows;
    }
);

// ---------------------------------------------------------------------------
// 4. view_saved_calendar_availability — the AvailabilitySlot rows of every player whose calendar the caller saved
//    and shows (A45(4): no consent flag; isVisible = shown, as the Phase 08 slot view filtered), with the owner's
//    id and label. Index-only: SavedCalendar.user_id, AvailabilitySlot.user_id, User.id, DeletedUser.id.
// ---------------------------------------------------------------------------
const SavedCalendarAvailabilityRow = t.row('SavedCalendarAvailabilityRow', {
    id: t.u32().primaryKey(),
    userId: t.u32(),
    userLabel: t.string(),
    startAt: t.timestamp(),
    endAt: t.timestamp(),
    isRecurring: t.bool(),
    recurrenceRule: RecurrenceRule,
    expiresAt: t.timestamp(),
});

export const view_saved_calendar_availability = spacetimedb.view(
    { name: 'view_saved_calendar_availability', public: true },
    t.array(SavedCalendarAvailabilityRow),
    (ctx) => {
        const me = callerUserId(ctx);
        if (me === undefined) return [];
        const rows: any[] = [];
        for (const targetUserId of visibleSavedTargets(ctx, me)) {
            const userLabel = resolveUserLabel(ctx, targetUserId).displayName;
            for (const slot of ctx.db.AvailabilitySlot.user_id.filter(targetUserId)) {
                rows.push({
                    id: slot.id,
                    userId: targetUserId,
                    userLabel,
                    startAt: slot.startAt,
                    endAt: slot.endAt,
                    isRecurring: slot.isRecurring,
                    recurrenceRule: slot.recurrenceRule,
                    expiresAt: slot.expiresAt,
                });
            }
        }
        return rows;
    }
);

// ---------------------------------------------------------------------------
// 5. view_my_saved_calendars — the caller's SavedCalendar rows (max 5) with the target's label and avatar (D2):
//    targetUserId (PK; toggle_calendar_visibility updates the row), targetLabel, targetAvatarCharacterName?
//    (undefined for a deleted target), isVisible. Index-only: SavedCalendar.user_id, User.id, DeletedUser.id.
// ---------------------------------------------------------------------------
const MySavedCalendarRow = t.row('MySavedCalendarRow', {
    targetUserId: t.u32().primaryKey(),
    targetLabel: t.string(),
    targetAvatarCharacterName: t.string().optional(),
    isVisible: t.bool(),
});

export const view_my_saved_calendars = spacetimedb.view(
    { name: 'view_my_saved_calendars', public: true },
    t.array(MySavedCalendarRow),
    (ctx) => {
        const me = callerUserId(ctx);
        if (me === undefined) return [];
        const rows: any[] = [];
        for (const saved of ctx.db.SavedCalendar.user_id.filter(me)) {
            const user = ctx.db.User.id.find(saved.targetUserId);
            rows.push({
                targetUserId: saved.targetUserId,
                targetLabel: user ? user.displayName : resolveUserLabel(ctx, saved.targetUserId).displayName,
                targetAvatarCharacterName: user?.avatarCharacterName,
                isVisible: saved.isVisible,
            });
        }
        return rows;
    }
);
