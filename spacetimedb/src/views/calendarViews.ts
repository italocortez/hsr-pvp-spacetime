// ─── Calendar Views ───────────────────────────────────────────────────────────
// S9b (A37 calendar contexts, A45(4), PAGE-MAP calendar + D2 / D7): the four calendar tables are private since S3;
// the calendar page reads them through these per-sender views. Names and avatars are denormalized (labels through
// userCard: User.displayName / avatarCharacterName, else the archived label with no avatar), so no calendar route
// subscribes `User` (D2); a player is found by exact username through view_user_by_username (D7). No audit columns in
// any row.
//
// 1. view_my_calendar_events            — own events, events the caller is invited to, events of the caller's
//                                         tournament matches; busy blocks of the visible saved calendars (S10ac)
// 2. view_my_calendar_invites           — the caller's invites + the invites of the events the caller organizes
// 3. view_my_availability               — the caller's AvailabilitySlot rows
// 4. view_saved_calendar_availability   — the slots of the players whose calendars the caller saved (visible ones)
// 5. view_my_saved_calendars            — the caller's SavedCalendar rows with the target's label and avatar
// 6. view_event_attendees(eventId)      — the invites of one event, for the readers A161(1) names (S10ad)
//
// Index-only: no table scan in any view body.

import spacetimedb from '@module/schema';
import { t } from 'spacetimedb/server';
import { InviteStatus, SlotKind } from '@module/types/enums';
import { resolveUserLabel } from '@module/helpers/identity/userLabel';
import { callerUserId } from '@module/helpers/identity/viewAnonymity';
import { hasTournamentPermission } from '@module/helpers/tournament/tournamentPermissions';

/** The caller's visible saved calendars' target ids (SavedCalendar.user_id; isVisible is the page's show / hide toggle, D-16). */
function visibleSavedTargets(ctx: any, me: number): number[] {
    const targets: number[] = [];
    for (const saved of ctx.db.SavedCalendar.user_id.filter(me)) {
        if (saved.isVisible) targets.push(saved.targetUserId);
    }
    return targets;
}

/**
 * S10ac (A157(12)): a user's label and avatar character name, cached per view call. A live user: displayName and
 * avatarCharacterName (User.id); a deleted one: the archived or synthetic label (resolveUserLabel) and no avatar, as
 * view_my_saved_calendars does.
 */
function userCards(ctx: any): (userId: number) => { label: string; avatar: string | undefined } {
    const cache = new Map<number, { label: string; avatar: string | undefined }>();
    return (userId: number) => {
        let card = cache.get(userId);
        if (card === undefined) {
            const user = ctx.db.User.id.find(userId);
            card = user
                ? { label: user.displayName, avatar: user.avatarCharacterName }
                : { label: resolveUserLabel(ctx, userId).displayName, avatar: undefined };
            cache.set(userId, card);
        }
        return card;
    };
}

// ---------------------------------------------------------------------------
// 1. view_my_calendar_events — the CalendarEvent rows the caller may see, each once:
//    (a) events the caller organizes (organizer_id);
//    (b) events the caller is invited to (CalendarEventInvite.invitee_user_id); S10ac (A157(8)): when the caller's
//        invite is Declined the row goes out without the notes (description undefined), so the answer can still
//        change; an invitee who removed their own invite no longer reaches the event through this path;
//    (c) tournament-linked events of the bracket matches of the caller's teams (both teams' members see the
//        match event even without an invite row: TournamentEnrolled.user_id → TournamentTeamMember
//        .by_tournament_and_user → BracketMatch.tournament_id → CalendarEvent.bracket_match_id); S10s (L87): only
//        tournaments that are not Completed or Cancelled (Tournament.id lookup per enrolment);
//    (c') S10v (audit SI16): the events of the bracket matches the caller is an approved stand-in for (same stage rule);
//    (d) S10ac (A157(6)): events organized by a player whose calendar the caller saved and shows, as busy blocks
//        only: isBusyBlock true, the owner (organizerId, label, avatar), startAt and endAt; title '', no description,
//        no bracketMatchId. An event the caller also reaches through (a)..(c') goes out once, in full.
//    Row: id, organizerId, organizerLabel, organizerAvatarCharacterName?, title, description?, startAt, endAt,
//    bracketMatchId?, isBusyBlock. The organizer is identified (a personal event's organizer chose the invitees; a
//    tournament event's organizer is staff); the attendees are in view_event_attendees (S10ad, A161(1)). PK `id`
//    (edits update it).
// ---------------------------------------------------------------------------
const MyCalendarEventRow = t.row('MyCalendarEventRow', {
    id: t.u32().primaryKey(),
    organizerId: t.u32(),
    organizerLabel: t.string(),
    organizerAvatarCharacterName: t.string().optional(),
    title: t.string(),
    description: t.string().optional(),
    startAt: t.timestamp(),
    endAt: t.timestamp(),
    bracketMatchId: t.u32().optional(),
    isBusyBlock: t.bool(),
});

export const view_my_calendar_events = spacetimedb.view(
    { name: 'view_my_calendar_events', public: true },
    t.array(MyCalendarEventRow),
    (ctx) => {
        const me = callerUserId(ctx);
        if (me === undefined) return [];
        const events = new Map<number, any>();
        const declined = new Set<number>();
        const add = (event: any) => {
            if (event && !events.has(event.id)) events.set(event.id, event);
        };

        // (a) own
        for (const event of ctx.db.CalendarEvent.organizer_id.filter(me)) add(event);
        // (b) invited
        for (const invite of ctx.db.CalendarEventInvite.invitee_user_id.filter(me)) {
            add(ctx.db.CalendarEvent.id.find(invite.eventId));
            if (invite.inviteStatus.tag === 'Declined') declined.add(invite.eventId);
        }
        // (c) the caller's teams' bracket matches
        for (const enrolled of ctx.db.TournamentEnrolled.user_id.filter(me)) {
            // S10s (A122(22), L87): a Completed or Cancelled tournament's brackets are not read.
            const stage = ctx.db.Tournament.id.find(enrolled.tournamentId)?.stage.tag;
            if (stage === undefined || stage === 'Completed' || stage === 'Cancelled') continue;
            const myTeamId = [...ctx.db.TournamentTeamMember.by_tournament_and_user.filter([enrolled.tournamentId, me])][0]?.teamId;
            if (myTeamId === undefined) continue;
            for (const match of ctx.db.BracketMatch.tournament_id.filter(enrolled.tournamentId)) {
                if (match.team1Id !== myTeamId && match.team2Id !== myTeamId) continue;
                for (const event of ctx.db.CalendarEvent.bracket_match_id.filter(match.id)) add(event);
            }
        }
        // (c') S10v (audit SI16): the bracket matches the caller is an approved stand-in for (TournamentStandIn.user_id →
        //      BracketMatch.id → CalendarEvent.bracket_match_id), same tournament-stage rule as (c).
        for (const standIn of ctx.db.TournamentStandIn.user_id.filter(me)) {
            const match = ctx.db.BracketMatch.id.find(standIn.bracketMatchId);
            if (!match) continue;
            const stage = ctx.db.Tournament.id.find(match.tournamentId)?.stage.tag;
            if (stage === undefined || stage === 'Completed' || stage === 'Cancelled') continue;
            for (const event of ctx.db.CalendarEvent.bracket_match_id.filter(match.id)) add(event);
        }
        // (d) visible saved calendars: busy blocks of the events not already reached above
        const busy = new Map<number, any>();
        for (const targetUserId of visibleSavedTargets(ctx, me)) {
            for (const event of ctx.db.CalendarEvent.organizer_id.filter(targetUserId)) {
                if (!events.has(event.id)) busy.set(event.id, event);
            }
        }

        const card = userCards(ctx);
        const rows: any[] = [];
        for (const event of events.values()) {
            const organizer = card(event.organizerId);
            rows.push({
                id: event.id,
                organizerId: event.organizerId,
                organizerLabel: organizer.label,
                organizerAvatarCharacterName: organizer.avatar,
                title: event.title,
                description: event.organizerId !== me && declined.has(event.id) ? undefined : event.description,
                startAt: event.startAt,
                endAt: event.endAt,
                bracketMatchId: event.bracketMatchId,
                isBusyBlock: false,
            });
        }
        for (const event of busy.values()) {
            const organizer = card(event.organizerId);
            rows.push({
                id: event.id,
                organizerId: event.organizerId,
                organizerLabel: organizer.label,
                organizerAvatarCharacterName: organizer.avatar,
                title: '',
                description: undefined,
                startAt: event.startAt,
                endAt: event.endAt,
                bracketMatchId: undefined,
                isBusyBlock: true,
            });
        }
        return rows;
    }
);

// ---------------------------------------------------------------------------
// 2. view_my_calendar_invites — CalendarEventInvite rows of (a) the caller (the inbox and RSVP) and (b) the events the
//    caller organizes (the organizer's invitee list and responses; remove_invite takes the invitee's id). S10ad
//    (A161(1)): an invitee no longer receives the other invitees' rows here (the S10ac path (c), A157(5)); the
//    attendee list of one event comes from view_event_attendees(eventId) (6. below).
//    Row: inviteKey (PK = eventId << 32 | inviteeUserId; respond_to_invite updates the row in place), eventId,
//    inviteeUserId, inviteeLabel, inviteeAvatarCharacterName?, inviteStatus, respondedAt?, inviterLabel,
//    inviterAvatarCharacterName? (the invite's creator: the organizer, or the Admin / staff member who added it).
//    Index-only: CalendarEventInvite.invitee_user_id / event_id, CalendarEvent.organizer_id / id, User.id,
//    DeletedUser.id.
// ---------------------------------------------------------------------------
const MyCalendarInviteRow = t.row('MyCalendarInviteRow', {
    inviteKey: t.u64().primaryKey(),
    eventId: t.u32(),
    inviteeUserId: t.u32(),
    inviteeLabel: t.string(),
    inviteeAvatarCharacterName: t.string().optional(),
    inviteStatus: InviteStatus,
    respondedAt: t.timestamp().optional(),
    inviterLabel: t.string(),
    inviterAvatarCharacterName: t.string().optional(),
});

export const view_my_calendar_invites = spacetimedb.view(
    { name: 'view_my_calendar_invites', public: true },
    t.array(MyCalendarInviteRow),
    (ctx) => {
        const me = callerUserId(ctx);
        if (me === undefined) return [];
        const card = userCards(ctx);
        const rows = new Map<bigint, any>();
        const add = (invite: any, organizerId: number | undefined) => {
            const inviteKey = (BigInt(invite.eventId) << 32n) | BigInt(invite.inviteeUserId);
            if (rows.has(inviteKey)) return;
            const inviterId = invite.createdById !== 0 ? invite.createdById : organizerId;
            const invitee = card(invite.inviteeUserId);
            const inviter = inviterId !== undefined ? card(inviterId) : { label: '', avatar: undefined };
            rows.set(inviteKey, {
                inviteKey,
                eventId: invite.eventId,
                inviteeUserId: invite.inviteeUserId,
                inviteeLabel: invitee.label,
                inviteeAvatarCharacterName: invitee.avatar,
                inviteStatus: invite.inviteStatus,
                respondedAt: invite.respondedAt,
                inviterLabel: inviter.label,
                inviterAvatarCharacterName: inviter.avatar,
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
//    place), startAt, endAt, kind (S10ac, A157(1): Available | Blocked; recurrence and expiresAt removed, A157(3)).
// ---------------------------------------------------------------------------
const MyAvailabilityRow = t.row('MyAvailabilityRow', {
    id: t.u32().primaryKey(),
    startAt: t.timestamp(),
    endAt: t.timestamp(),
    kind: SlotKind,
});

export const view_my_availability = spacetimedb.view(
    { name: 'view_my_availability', public: true },
    t.array(MyAvailabilityRow),
    (ctx) => {
        const me = callerUserId(ctx);
        if (me === undefined) return [];
        const rows: any[] = [];
        for (const slot of ctx.db.AvailabilitySlot.user_id.filter(me)) {
            rows.push({ id: slot.id, startAt: slot.startAt, endAt: slot.endAt, kind: slot.kind });
        }
        return rows;
    }
);

// ---------------------------------------------------------------------------
// 4. view_saved_calendar_availability — the AvailabilitySlot rows of every player whose calendar the caller saved
//    and shows (A45(4): no consent flag; isVisible = shown, as the Phase 08 slot view filtered), with the owner's
//    id and label: id (PK), userId, userLabel, startAt, endAt, kind (S10ac: Blocked slots too, the mockup's "Other's
//    Blocked"). Index-only: SavedCalendar.user_id, AvailabilitySlot.user_id, User.id, DeletedUser.id.
// ---------------------------------------------------------------------------
const SavedCalendarAvailabilityRow = t.row('SavedCalendarAvailabilityRow', {
    id: t.u32().primaryKey(),
    userId: t.u32(),
    userLabel: t.string(),
    startAt: t.timestamp(),
    endAt: t.timestamp(),
    kind: SlotKind,
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
                    kind: slot.kind,
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

/**
 * S10ad (A161(1), after A157(5)): whether `me` may read the attendee list of `event`. The organizer: yes. A personal
 * event: an invitee (any answer; one who removed their own invite is no longer one). A match event: a holder of the
 * `bracket` permission of its tournament (hasTournamentPermission: Moderator+, the tournament organizer, an assistant
 * with canManageBracket), with or without an invite; an invitee when the tournament is not anonymous
 * (`Tournament.isAnonymousDefault` false). A match event whose match or tournament is gone: the organizer only.
 */
function canReadAttendees(ctx: any, event: any, me: number): boolean {
    if (event.organizerId === me) return true;
    const invited = [...ctx.db.CalendarEventInvite.by_event_and_invitee.filter([event.id, me])].length > 0;
    if (event.bracketMatchId === undefined) return invited;
    const match = ctx.db.BracketMatch.id.find(event.bracketMatchId);
    const tournament = match ? ctx.db.Tournament.id.find(match.tournamentId) : undefined;
    if (!tournament) return false;
    const user = ctx.db.User.id.find(me);
    if (user && hasTournamentPermission(ctx, user, tournament, 'bracket')) return true;
    return invited && !tournament.isAnonymousDefault;
}

// ---------------------------------------------------------------------------
// 6. view_event_attendees(eventId) — S10ad (A161(1)): the CalendarEventInvite rows of one event, the attendee list of
//    the event the page has open (subscribed only for that event and dropped on close; one argument set at a time).
//    Readers: canReadAttendees above. Anyone else, an unknown id, a deleted event: no rows (no error).
//    Row: inviteeUserId, inviteeLabel, inviteeAvatarCharacterName?, inviteStatus, respondedAt? (the invitee columns of
//    MyCalendarInviteRow; the event id is the argument). No primary key (a view with arguments cannot have one): an
//    answer arrives as a delete plus an insert. Subscribe as `SELECT * FROM view_event_attendees(42)`.
//    Index-only: CalendarEvent.id, CalendarEventInvite.by_event_and_invitee / event_id, BracketMatch.id, Tournament.id,
//    TournamentAssistant.by_tournament_and_user, User.id, DeletedUser.id.
// ---------------------------------------------------------------------------
const EventAttendeeRow = t.row('EventAttendeeRow', {
    inviteeUserId: t.u32(),
    inviteeLabel: t.string(),
    inviteeAvatarCharacterName: t.string().optional(),
    inviteStatus: InviteStatus,
    respondedAt: t.timestamp().optional(),
});

export const view_event_attendees = spacetimedb.view(
    { name: 'view_event_attendees', public: true },
    { eventId: t.u32() },
    t.array(EventAttendeeRow),
    (ctx, { eventId }) => {
        const me = callerUserId(ctx);
        if (me === undefined) return [];
        const event = ctx.db.CalendarEvent.id.find(eventId);
        if (!event || !canReadAttendees(ctx, event, me)) return [];
        const card = userCards(ctx);
        const rows: any[] = [];
        for (const invite of ctx.db.CalendarEventInvite.event_id.filter(eventId)) {
            const invitee = card(invite.inviteeUserId);
            rows.push({
                inviteeUserId: invite.inviteeUserId,
                inviteeLabel: invitee.label,
                inviteeAvatarCharacterName: invitee.avatar,
                inviteStatus: invite.inviteStatus,
                respondedAt: invite.respondedAt,
            });
        }
        return rows;
    }
);
