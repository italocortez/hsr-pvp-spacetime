// ─── Calendar Event Reducers ───────────────────────────────────────────────
// Manages calendar events: personal and tournament-linked.
//
// Permission model:
//   - create: non-guest; tournament-linked events require the bracket permission (D-20, A25)
//   - update/delete/invite/remove_invite: organizer OR Admin (D-08); a tournament-linked event also accepts the
//     tournament's organizer and staff holding the bracket permission (A89, ensureCanManageEvent)
//   - remove_invite: S10ac (A157(8)) an invitee may also remove their own invite
//
// Caps (D-04, D-06, A79), counted on the organizer's events after the lazy cleanup:
//   - 40 not-yet-ended events (endAt >= now) per user (MAX_ACTIVE_EVENTS_PER_USER)
//   - 100 retained events per user, ended or not (MAX_RETAINED_EVENTS_PER_USER)
//   - 9 invitees per event (MAX_INVITEES_PER_EVENT)
// Time rules (S10ac, A157(9), A157(11)): times through parseInterval (digits only, 2020..2100); an event lasts at most
// 7 days and starts at most 12 months ahead; a start in the past is refused on create and on an update that moves the
// start. A79: update rejects a changed endAt in the past (an unchanged endAt stays allowed, e.g. editing a finished
// event's title). A90: update rejects reviving an ended event when its organizer already has 40 not-yet-ended events.
// Blocked slots (S10ac, A157(1)): a personal event may not overlap one of its organizer's own Blocked slots (create,
// and an update that changes the time). A tournament match event is exempt (its organizer is staff scheduling other
// players' match; the staff member's own blocked time must not block the bracket).
// Reschedule (S10ac, A157(4)): an update that changes the start or end sets every invite back to Pending.
// Invitee set (S10ac, A157(12)): update_calendar_event takes the full invitee set (optional; omitted = unchanged).
// Bracket schedule (S10ac, A157(12)): a match event writes its start to BracketMatch.scheduledAt (create, a start
// change); every deletion of the event clears it (deleteCalendarEventWithInvites), except retention (S10ad, A160(6)).
// Targets (S10ac, A157(7)): manual invitees may not be guests or users pending deletion (ensureCalendarTarget).
// S10ad (A160(7)): nor the SYSTEM user, nor the event's organizer (create, added invitees of update, invite_to_event).
// S10ad (A160): a title needs at least one visible character (hasVisibleChar).
//
// Lazy cleanup (D-07, D-27): S10s (A122(22), L86): every calendar reducer first deletes the caller's events ended more
// than 90 days ago and slots ended more than a week ago (runCalendarCleanup). S10s (A122(4), L93): every calendar
// reducer counts on the per-user membership allowance (consumeMembershipAllowance: 20 calls per 10 s window).
// Fix pass (F2, F11): order = authenticate, allowance, clean-up sparing the call's own event, main operation.
// One event per bracket match enforced (D-19)
// Length caps (S10f, calendar audit #5; S10ac A157(11): counted in characters): title 1..100, description up to 1000
// (both trimmed)
// Auto-invite bracket match participants for tournament-linked events (D-17, D-18); S10v (audit SI16): the match's
// approved stand-ins too (approve_stand_in invites a stand-in approved after the event exists).

import spacetimedb from '@module/schema';
import { t, SenderError } from 'spacetimedb/server';
import { Timestamp } from 'spacetimedb';
import { getAuthenticatedUser, isRoleAtLeast } from '@module/helpers/identity/ensurePermissions';
import { ensureTournamentPermission, hasTournamentPermission } from '@module/helpers/tournament/tournamentPermissions';
import { insertWithAudit, updateWithAudit } from '@module/helpers/admin/auditHelpers';
import { runCalendarCleanup } from '@module/helpers/calendar/calendarCleanup';
import { consumeMembershipAllowance, MEMBERSHIP_ACTION_TEXT } from '@module/helpers/lobby/abuseControls';
import { deleteCalendarEventWithInvites, setBracketMatchSchedule } from '@module/helpers/calendar/calendarCascade';
import { ensureCalendarTarget } from '@module/helpers/calendar/calendarTargets';
import {
    MAX_EVENT_LEAD_MICROS,
    MAX_EVENT_LENGTH_MICROS,
    charCount,
    ensureStartNotPast,
    hasVisibleChar,
    intervalsOverlap,
    parseInterval,
} from '@module/helpers/calendar/calendarTime';

const MAX_ACTIVE_EVENTS_PER_USER = 40;
const MAX_RETAINED_EVENTS_PER_USER = 100;
export const MAX_INVITEES_PER_EVENT = 9; // S10v: also read by approve_stand_in (audit SI16)
const MAX_TITLE_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 1000;

/**
 * S10f (calendar audit #5): the title and description reach every invitee's view, so both are bounded.
 * S10ac (A157(11)): the limits count characters (code points), not UTF-16 units.
 * Returns the trimmed title and the stored description (undefined when empty).
 */
function eventTexts(title: string, description: string): { title: string; description: string | undefined } {
    const trimmedTitle = (title ?? '').trim();
    // S10ad (A160): a title with no visible character (only spaces, zero-width or control characters) counts as empty
    if (!hasVisibleChar(trimmedTitle)) throw new SenderError('Event title must not be empty.');
    if (charCount(trimmedTitle) > MAX_TITLE_LENGTH) {
        throw new SenderError(`Event title cannot exceed ${MAX_TITLE_LENGTH} characters.`);
    }
    const trimmedDescription = (description ?? '').trim();
    if (charCount(trimmedDescription) > MAX_DESCRIPTION_LENGTH) {
        throw new SenderError(`Event description cannot exceed ${MAX_DESCRIPTION_LENGTH} characters.`);
    }
    return { title: trimmedTitle, description: trimmedDescription !== '' ? trimmedDescription : undefined };
}

/**
 * S10ac (A157(9), A157(11)): length (at most 7 days), past start (create: always; update: only when the start moves,
 * `previousStart` given) and lead (start at most 12 months ahead; checked when the start is new or moves).
 */
function checkEventTimes(start: bigint, end: bigint, now: bigint, previousStart?: bigint): void {
    if (end - start > MAX_EVENT_LENGTH_MICROS) throw new SenderError('An event can last at most 7 days.');
    ensureStartNotPast(start, now, previousStart);
    if (start !== previousStart && start > now + MAX_EVENT_LEAD_MICROS) {
        throw new SenderError('Events cannot be scheduled more than 12 months in advance.');
    }
}

/**
 * S10ac (A157(1)): a personal event may not overlap one of its organizer's Blocked slots (AvailabilitySlot.user_id;
 * half-open intervals, so an event ending exactly when a blocked slot starts, or starting when it ends, passes).
 */
function ensureNoBlockedOverlap(ctx: any, organizerId: number, callerId: number, start: bigint, end: bigint): void {
    for (const slot of ctx.db.AvailabilitySlot.user_id.filter(organizerId)) {
        if (slot.kind.tag !== 'Blocked') continue;
        if (intervalsOverlap(start, end, slot.startAt.microsSinceUnixEpoch, slot.endAt.microsSinceUnixEpoch)) {
            throw new SenderError(organizerId === callerId
                ? 'This time overlaps one of your blocked slots.'
                : "This time overlaps one of the organizer's blocked slots.");
        }
    }
}

const MAX_U32 = 4294967295;

/**
 * Comma-separated user ids → user ids, de-duplicated (calendar audit #2). S10ac review M1: strict. An empty string
 * (or plain spaces only) is the empty set; otherwise every token, after trimming plain spaces, must be digits only and
 * a whole number from 1 to 4294967295 (an id above the u32 range would wrap to a real user). Any other token refuses
 * the whole call.
 */
function parseInviteeIds(inviteeUserIds: string): number[] {
    const ids: number[] = [];
    if (inviteeUserIds.replace(/ /g, '') === '') return ids;
    for (const raw of inviteeUserIds.split(',')) {
        const token = raw.replace(/^ +| +$/g, '');
        const id = /^[0-9]+$/.test(token) ? Number(token) : NaN;
        if (!Number.isSafeInteger(id) || id < 1 || id > MAX_U32) throw new SenderError('Invalid invitee list.');
        ids.push(id);
    }
    return [...new Set(ids)];
}

/** S10ad (A160(7)): the organizer is never in their own invitee set. */
function ensureNotOrganizer(inviteeId: number, organizerId: number, callerId: number): void {
    if (inviteeId !== organizerId) return;
    throw new SenderError(organizerId === callerId
        ? 'You cannot invite yourself to your own event.'
        : 'The organizer cannot be invited to their own event.');
}

/**
 * A manual invitee: not the organizer (S10ad, A160(7)), the user exists (`User <id> not found.`) and may be invited
 * (A157(7); S10ad: not the SYSTEM user).
 */
function ensureInvitable(ctx: any, inviteeId: number, organizerId: number, callerId: number): void {
    ensureNotOrganizer(inviteeId, organizerId, callerId);
    const invitee = ctx.db.User.id.find(inviteeId);
    if (!invitee) throw new SenderError(`User ${inviteeId} not found.`);
    ensureCalendarTarget(invitee, 'invite');
}

const pendingInvite = (ctx: any, eventId: number, inviteeUserId: number, actorId: number) =>
    insertWithAudit(ctx, {
        eventId,
        inviteeUserId,
        inviteStatus: { tag: 'Pending', value: {} } as any,
        respondedAt: undefined,
    }, actorId);

/**
 * D-08, A89: who may update, delete or manage the invites of an event. Personal events: the organizer or an Admin.
 * Tournament-linked events (bracketMatchId set) also accept the tournament's organizer and any staff holding the
 * `bracket` permission (hasTournamentPermission: Moderator+, the organizer, an assistant with canManageBracket),
 * the permission that creates such events. A link whose bracket match or tournament is gone falls back to the
 * personal rule.
 */
function ensureCanManageEvent(ctx: any, user: any, event: any, action: string): void {
    if (event.organizerId === user.id || isRoleAtLeast(user.role, 'Admin')) return;
    if (event.bracketMatchId != null) {
        const bracketMatch = ctx.db.BracketMatch.id.find(event.bracketMatchId);
        const tournament = bracketMatch ? ctx.db.Tournament.id.find(bracketMatch.tournamentId) : undefined;
        if (tournament && hasTournamentPermission(ctx, user, tournament, 'bracket')) return;
        throw new SenderError(`Forbidden: Only the organizer, an Admin or tournament staff with the bracket permission can ${action}.`);
    }
    throw new SenderError(`Forbidden: Only the organizer or an Admin can ${action}.`);
}

// ─── create_calendar_event ──────────────────────────────────────────────────
// Creates a calendar event (personal or tournament-linked).
// bracketMatchId=0 means personal event.
// inviteeUserIds is comma-separated user IDs or empty string.

export const create_calendar_event = spacetimedb.reducer(
    {
        title: t.string(),
        description: t.string(),   // Empty string for no description
        startAt: t.string(),       // BigInt micros as string
        endAt: t.string(),         // BigInt micros as string
        bracketMatchId: t.u32(),   // 0 = personal event (no bracket match link)
        inviteeUserIds: t.string(), // Comma-separated user IDs or empty
    },
    (ctx, { title, description, startAt, endAt, bracketMatchId, inviteeUserIds }: {
        title: string;
        description: string;
        startAt: string;
        endAt: string;
        bracketMatchId: number;
        inviteeUserIds: string;
    }) => {
        const user = getAuthenticatedUser(ctx);
        if (user.isGuest) throw new SenderError('Guests cannot create calendar events.');
        consumeMembershipAllowance(ctx, user.id, MEMBERSHIP_ACTION_TEXT); // S10s (A122(4), L93; fix pass F11): allowance first
        runCalendarCleanup(ctx, user.id); // S10s (A122(22), L86): clean-up before the main operation

        const texts = eventTexts(title, description);

        const now = ctx.timestamp.microsSinceUnixEpoch;
        const { start: startMicros, end: endMicros } = parseInterval(startAt, endAt);
        checkEventTimes(startMicros, endMicros, now); // A157(9), A157(11); the start is not past, so neither is the end (A79(3))

        // Tournament-linked event path
        let autoInviteCount = 0;
        let autoInviteeIds: number[] = [];
        let linkedBracketMatchId: number | undefined;
        let standInIds: number[] = [];

        if (bracketMatchId > 0) {
            const bracketMatch = ctx.db.BracketMatch.id.find(bracketMatchId);
            if (!bracketMatch) throw new SenderError('Bracket match not found.');

            // Verify TO/Admin/Mod/Assistant access for tournament-linked events (D-20)
            ensureTournamentPermission(ctx, bracketMatch.tournamentId, 'bracket');

            // Duplicate check (D-19): one event per bracket match
            const existingEvents = [...ctx.db.CalendarEvent.bracket_match_id.filter(bracketMatchId)];
            if (existingEvents.length > 0) {
                throw new SenderError('A calendar event already exists for this bracket match. Delete it first to reschedule.');
            }

            linkedBracketMatchId = bracketMatchId;

            // Auto-invite bracket match participants (D-17, D-18)
            // Use TournamentTeamMember.team_id to find team members (D-20)
            const team1MemberIds: number[] = [];
            const team2MemberIds: number[] = [];

            if (bracketMatch.team1Id !== undefined) {
                const team1Members = [...ctx.db.TournamentTeamMember.team_id.filter(bracketMatch.team1Id)];
                for (const m of team1Members) {
                    // Check enrolled status is not Withdrawn/Disqualified
                    const enrolled = [...ctx.db.TournamentEnrolled.by_tournament_and_user.filter([bracketMatch.tournamentId, m.userId])][0];
                    if (!enrolled || enrolled.status.tag === 'Withdrawn' || enrolled.status.tag === 'Disqualified') continue;
                    team1MemberIds.push(m.userId);
                }
            }

            if (bracketMatch.team2Id !== undefined) {
                const team2Members = [...ctx.db.TournamentTeamMember.team_id.filter(bracketMatch.team2Id)];
                for (const m of team2Members) {
                    const enrolled = [...ctx.db.TournamentEnrolled.by_tournament_and_user.filter([bracketMatch.tournamentId, m.userId])][0];
                    if (!enrolled || enrolled.status.tag === 'Withdrawn' || enrolled.status.tag === 'Disqualified') continue;
                    team2MemberIds.push(m.userId);
                }
            }

            // S10v (audit SI16): the match's approved stand-ins are invited after the members (once each).
            for (const s of ctx.db.TournamentStandIn.bracket_match_id.filter(bracketMatchId)) {
                if (!team1MemberIds.includes(s.userId) && !team2MemberIds.includes(s.userId) && !standInIds.includes(s.userId)) {
                    standInIds.push(s.userId);
                }
            }

            autoInviteeIds = [...team1MemberIds, ...team2MemberIds];
            autoInviteCount = autoInviteeIds.length;
        } else {
            // S10ac (A157(1)): a personal event may not overlap one of the organizer's Blocked slots.
            ensureNoBlockedOverlap(ctx, user.id, user.id, startMicros, endMicros);
        }

        // Cap checks (the lazy cleanup ran at the top, S10s) (post-cleanup, A79): not-yet-ended events first, then the retained ceiling
        const currentEvents = [...ctx.db.CalendarEvent.organizer_id.filter(user.id)];
        const activeCount = currentEvents.filter((e: any) => e.endAt.microsSinceUnixEpoch >= now).length;
        if (activeCount >= MAX_ACTIVE_EVENTS_PER_USER) {
            throw new SenderError(`Maximum ${MAX_ACTIVE_EVENTS_PER_USER} active calendar events per user.`);
        }
        if (currentEvents.length >= MAX_RETAINED_EVENTS_PER_USER) {
            throw new SenderError(`Maximum ${MAX_RETAINED_EVENTS_PER_USER} calendar events per user.`);
        }

        // Validate total invitee count (D-04). Calendar audit #2 (S10f): manual ids are de-duplicated among themselves
        // as well as against the auto-invite set (the invite table has no engine-enforced key).
        const autoSet = new Set(autoInviteeIds);
        const uniqueManual = parseInviteeIds(inviteeUserIds).filter(id => !autoSet.has(id));
        if (autoInviteCount + uniqueManual.length > MAX_INVITEES_PER_EVENT) {
            throw new SenderError(`Maximum ${MAX_INVITEES_PER_EVENT} invitees per event.`);
        }

        // S10v review F4: stand-ins never make the creation fail: they are invited only while room is left under the
        // cap (after the members and the manual invitees); the others see the event through view_my_calendar_events (c').
        const manualSet = new Set(uniqueManual);
        standInIds = standInIds.filter((id) => !manualSet.has(id))
            .slice(0, Math.max(0, MAX_INVITEES_PER_EVENT - autoInviteCount - uniqueManual.length));
        autoInviteeIds = [...autoInviteeIds, ...standInIds];

        // Validate manual invitees: they exist, and are neither guests nor pending deletion (S10ac, A157(7))
        for (const inviteeId of uniqueManual) ensureInvitable(ctx, inviteeId, user.id, user.id);

        // Insert event (calendar audit LOW #13: the inserted row, with its id, is the one insert returns)
        const newEvent = ctx.db.CalendarEvent.insert(insertWithAudit(ctx, {
            id: 0,
            organizerId: user.id,
            title: texts.title,
            startAt: new Timestamp(startMicros),
            endAt: new Timestamp(endMicros),
            bracketMatchId: linkedBracketMatchId,
            description: texts.description,
        }, user.id));

        // Insert auto-invites for tournament-linked events, then the manual invites
        for (const inviteeId of autoInviteeIds) ctx.db.CalendarEventInvite.insert(pendingInvite(ctx, newEvent.id, inviteeId, user.id));
        for (const inviteeId of uniqueManual) ctx.db.CalendarEventInvite.insert(pendingInvite(ctx, newEvent.id, inviteeId, user.id));

        // S10ac (A157(12)): the match's scheduled start
        setBracketMatchSchedule(ctx, linkedBracketMatchId, newEvent.startAt, user.id);
    }
);

// ─── update_calendar_event ──────────────────────────────────────────────────
// Updates event title, description, time window and (optionally) the full invitee set in one call.
// Does NOT allow changing bracketMatchId (D-19 — delete and recreate to reschedule).
// inviteeUserIds (S10ac, A157(12)): omitted = the invitee set is unchanged; given = the full set as comma-separated
// ids ('' = nobody): invitees not in it are removed, new ones get a Pending invite, kept ones keep their answer.
// S10ac (A157(4)): a change of start or end sets every remaining invite to Pending (respondedAt cleared).

export const update_calendar_event = spacetimedb.reducer(
    {
        eventId: t.u32(),
        title: t.string(),
        description: t.string(),
        startAt: t.string(),
        endAt: t.string(),
        inviteeUserIds: t.string().optional(),
    },
    (ctx, { eventId, title, description, startAt, endAt, inviteeUserIds }: {
        eventId: number;
        title: string;
        description: string;
        startAt: string;
        endAt: string;
        inviteeUserIds?: string;
    }) => {
        const user = getAuthenticatedUser(ctx);
        consumeMembershipAllowance(ctx, user.id, MEMBERSHIP_ACTION_TEXT); // S10s (A122(4), L93; fix pass F11): allowance first
        runCalendarCleanup(ctx, user.id, { eventId }); // S10s (A122(22), L86; fix pass F2): clean-up, sparing this call's target

        const event = ctx.db.CalendarEvent.id.find(eventId);
        if (!event) throw new SenderError('Calendar event not found.');
        ensureCanManageEvent(ctx, user, event, 'update this event');

        const texts = eventTexts(title, description);

        const now = ctx.timestamp.microsSinceUnixEpoch;
        const oldStart: bigint = event.startAt.microsSinceUnixEpoch;
        const oldEnd: bigint = event.endAt.microsSinceUnixEpoch;
        const { start: startMicros, end: endMicros } = parseInterval(startAt, endAt);
        checkEventTimes(startMicros, endMicros, now, oldStart); // A157(9): an unchanged start of a started event passes
        // A79: a changed endAt must not lie in the past; an unchanged one stays allowed
        if (endMicros !== oldEnd && endMicros < now) {
            throw new SenderError('Event end time must not be in the past.');
        }
        // A90: reviving an ended event (endAt moved back to now or later) counts against the organizer's active cap;
        // an event that stays active, or stays ended, is not counted again. Ended events never count as active, so
        // no cleanup is needed before counting.
        if (oldEnd < now && endMicros >= now) {
            const activeCount = [...ctx.db.CalendarEvent.organizer_id.filter(event.organizerId)]
                .filter((e: any) => e.endAt.microsSinceUnixEpoch >= now).length;
            if (activeCount >= MAX_ACTIVE_EVENTS_PER_USER) {
                throw new SenderError(`Maximum ${MAX_ACTIVE_EVENTS_PER_USER} active calendar events per user.`);
            }
        }
        const timeChanged = startMicros !== oldStart || endMicros !== oldEnd;
        // A157(1): a time change of a personal event may not overlap one of the organizer's Blocked slots
        if (timeChanged && event.bracketMatchId === undefined) {
            ensureNoBlockedOverlap(ctx, event.organizerId, user.id, startMicros, endMicros);
        }

        // A157(12): the full invitee set, checked before any write (cap on the final set; added invitees validated)
        const current = [...ctx.db.CalendarEventInvite.event_id.filter(eventId)];
        let removed: any[] = [];
        let added: number[] = [];
        if (inviteeUserIds !== undefined) {
            const desired = parseInviteeIds(inviteeUserIds);
            if (desired.length > MAX_INVITEES_PER_EVENT) {
                throw new SenderError(`Maximum ${MAX_INVITEES_PER_EVENT} invitees per event.`);
            }
            const desiredSet = new Set(desired);
            const currentIds = new Set(current.map((i: any) => i.inviteeUserId));
            removed = current.filter((i: any) => !desiredSet.has(i.inviteeUserId));
            added = desired.filter((id) => !currentIds.has(id));
            for (const inviteeId of added) ensureInvitable(ctx, inviteeId, event.organizerId, user.id);
        }

        ctx.db.CalendarEvent.id.update(updateWithAudit(ctx, event, {
            title: texts.title,
            description: texts.description,
            startAt: new Timestamp(startMicros),
            endAt: new Timestamp(endMicros),
        }, user.id));

        const removedIds = new Set(removed.map((i: any) => i.inviteeUserId));
        for (const invite of removed) ctx.db.CalendarEventInvite.delete(invite);
        // A157(4): a reschedule resets the kept invites (delete + re-insert: the invite table has no primary key)
        if (timeChanged) {
            for (const invite of current) {
                if (removedIds.has(invite.inviteeUserId)) continue;
                if (invite.inviteStatus.tag === 'Pending' && invite.respondedAt === undefined) continue;
                ctx.db.CalendarEventInvite.delete(invite);
                ctx.db.CalendarEventInvite.insert(updateWithAudit(ctx, invite, {
                    inviteStatus: { tag: 'Pending', value: {} } as any,
                    respondedAt: undefined,
                }, user.id));
            }
        }
        for (const inviteeId of added) ctx.db.CalendarEventInvite.insert(pendingInvite(ctx, eventId, inviteeId, user.id));

        // A157(12): the bracket match follows a moved start
        if (startMicros !== oldStart) setBracketMatchSchedule(ctx, event.bracketMatchId, new Timestamp(startMicros), user.id);
    }
);

// ─── delete_calendar_event ──────────────────────────────────────────────────
// Deletes a calendar event and cascades to all invites (D-03) and the bracket match's scheduledAt (A157(12)).

export const delete_calendar_event = spacetimedb.reducer(
    { eventId: t.u32() },
    (ctx, { eventId }: { eventId: number }) => {
        const user = getAuthenticatedUser(ctx);
        consumeMembershipAllowance(ctx, user.id, MEMBERSHIP_ACTION_TEXT); // S10s (A122(4), L93; fix pass F11): allowance first
        runCalendarCleanup(ctx, user.id, { eventId }); // S10s (A122(22), L86; fix pass F2): clean-up, sparing this call's target

        const event = ctx.db.CalendarEvent.id.find(eventId);
        if (!event) throw new SenderError('Calendar event not found.');
        ensureCanManageEvent(ctx, user, event, 'delete this event');

        deleteCalendarEventWithInvites(ctx, eventId);
    }
);

// ─── invite_to_event ────────────────────────────────────────────────────────
// Adds an invite for a user to a calendar event.

export const invite_to_event = spacetimedb.reducer(
    { eventId: t.u32(), inviteeUserId: t.u32() },
    (ctx, { eventId, inviteeUserId }: { eventId: number; inviteeUserId: number }) => {
        const user = getAuthenticatedUser(ctx);
        consumeMembershipAllowance(ctx, user.id, MEMBERSHIP_ACTION_TEXT); // S10s (A122(4), L93; fix pass F11): allowance first
        runCalendarCleanup(ctx, user.id, { eventId }); // S10s (A122(22), L86; fix pass F2): clean-up, sparing this call's target

        const event = ctx.db.CalendarEvent.id.find(eventId);
        if (!event) throw new SenderError('Calendar event not found.');
        ensureCanManageEvent(ctx, user, event, 'invite users to this event');

        ensureNotOrganizer(inviteeUserId, event.organizerId, user.id); // S10ad (A160(7))
        const invitee = ctx.db.User.id.find(inviteeUserId);
        if (!invitee) throw new SenderError('Invitee user not found.');
        ensureCalendarTarget(invitee, 'invite'); // S10ac (A157(7)); S10ad: not the SYSTEM user

        // Duplicate check
        const existingInvite = [...ctx.db.CalendarEventInvite.by_event_and_invitee.filter([eventId, inviteeUserId])][0];
        if (existingInvite) throw new SenderError('User is already invited to this event.');

        // Cap check (D-04)
        const currentInvites = [...ctx.db.CalendarEventInvite.event_id.filter(eventId)];
        if (currentInvites.length >= MAX_INVITEES_PER_EVENT) {
            throw new SenderError(`Maximum ${MAX_INVITEES_PER_EVENT} invitees per event.`);
        }

        ctx.db.CalendarEventInvite.insert(pendingInvite(ctx, eventId, inviteeUserId, user.id));
    }
);

// ─── remove_invite ──────────────────────────────────────────────────────────
// Removes an invite from a calendar event. S10ac (A157(8)): the invitee may remove their own invite (leave the event);
// anyone else needs ensureCanManageEvent.

export const remove_invite = spacetimedb.reducer(
    { eventId: t.u32(), inviteeUserId: t.u32() },
    (ctx, { eventId, inviteeUserId }: { eventId: number; inviteeUserId: number }) => {
        const user = getAuthenticatedUser(ctx);
        consumeMembershipAllowance(ctx, user.id, MEMBERSHIP_ACTION_TEXT); // S10s (A122(4), L93; fix pass F11): allowance first
        runCalendarCleanup(ctx, user.id, { eventId }); // S10s (A122(22), L86; fix pass F2): clean-up, sparing this call's target

        const event = ctx.db.CalendarEvent.id.find(eventId);
        if (!event) throw new SenderError('Calendar event not found.');
        if (inviteeUserId !== user.id) ensureCanManageEvent(ctx, user, event, 'remove invites from this event');

        const invite = [...ctx.db.CalendarEventInvite.by_event_and_invitee.filter([eventId, inviteeUserId])][0];
        if (!invite) throw new SenderError('Invite not found.');

        ctx.db.CalendarEventInvite.delete(invite);
    }
);
