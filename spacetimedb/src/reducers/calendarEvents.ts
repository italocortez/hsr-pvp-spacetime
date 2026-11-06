// ─── Calendar Event Reducers ───────────────────────────────────────────────
// Manages calendar events: personal and tournament-linked.
//
// Permission model:
//   - create: non-guest; tournament-linked events require ensureTournamentAccess (D-20)
//   - update/delete/invite/remove_invite: organizer OR Admin (D-08)
//
// Caps (D-04, D-06):
//   - 40 events per user (MAX_EVENTS_PER_USER)
//   - 9 invitees per event (MAX_INVITEES_PER_EVENT)
//
// Lazy cleanup (D-07): events older than 90 days are deleted on every call
// One event per bracket match enforced (D-19)
// Auto-invite bracket match participants for tournament-linked events (D-17, D-18)

import spacetimedb from '../schema';
import { t, SenderError } from 'spacetimedb/server';
import { Timestamp } from 'spacetimedb';
import { getAuthenticatedUser, isRoleAtLeast } from '../helpers/ensurePermissions';
import { ensureTournamentAccess } from '../helpers/tournamentHelpers';
import { insertWithAudit, updateWithAudit } from '../helpers/auditHelpers';
import { cleanupOldEvents } from '../helpers/calendarCleanup';
import { deleteCalendarEventWithInvites } from '../helpers/calendarCascade';

const MAX_EVENTS_PER_USER = 40;
const MAX_INVITEES_PER_EVENT = 9;

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

        if (!title || title.trim() === '') throw new SenderError('Event title must not be empty.');

        const startMicros = BigInt(startAt);
        const endMicros = BigInt(endAt);
        if (startMicros >= endMicros) throw new SenderError('Start time must be before end time.');

        // Tournament-linked event path
        let autoInviteCount = 0;
        let autoInviteeIds: number[] = [];
        let linkedBracketMatchId: number | undefined;

        if (bracketMatchId > 0) {
            const bracketMatch = ctx.db.BracketMatch.id.find(bracketMatchId);
            if (!bracketMatch) throw new SenderError('Bracket match not found.');

            // Verify TO/Admin/Mod/Assistant access for tournament-linked events (D-20)
            ensureTournamentAccess(ctx, bracketMatch.tournamentId);

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

            autoInviteeIds = [...team1MemberIds, ...team2MemberIds];
            autoInviteCount = autoInviteeIds.length;
        }

        // Lazy cleanup
        cleanupOldEvents(ctx, user.id);

        // Cap check (post-cleanup)
        const currentEvents = [...ctx.db.CalendarEvent.organizer_id.filter(user.id)];
        if (currentEvents.length >= MAX_EVENTS_PER_USER) {
            throw new SenderError(`Maximum ${MAX_EVENTS_PER_USER} calendar events per user.`);
        }

        // Parse manual invitees
        const manualInviteeIds: number[] = [];
        if (inviteeUserIds && inviteeUserIds.trim() !== '') {
            for (const idStr of inviteeUserIds.split(',')) {
                const id = parseInt(idStr.trim(), 10);
                if (!isNaN(id) && id > 0) {
                    manualInviteeIds.push(id);
                }
            }
        }

        // Validate total invitee count (D-04)
        const autoSet = new Set(autoInviteeIds);
        const uniqueManual = manualInviteeIds.filter(id => !autoSet.has(id));
        if (autoInviteCount + uniqueManual.length > MAX_INVITEES_PER_EVENT) {
            throw new SenderError(`Maximum ${MAX_INVITEES_PER_EVENT} invitees per event.`);
        }

        // Validate manual invitees exist
        for (const inviteeId of uniqueManual) {
            if (!ctx.db.User.id.find(inviteeId)) {
                throw new SenderError(`User ${inviteeId} not found.`);
            }
        }

        // Insert event
        ctx.db.CalendarEvent.insert(insertWithAudit(ctx, {
            id: 0,
            organizerId: user.id,
            title: title.trim(),
            startAt: new Timestamp(startMicros),
            endAt: new Timestamp(endMicros),
            bracketMatchId: linkedBracketMatchId,
            description: description && description.trim() !== '' ? description.trim() : undefined,
        }, user.id));

        // Retrieve the newly inserted event by finding the most recent one for this user
        // (within the same transaction, no race condition)
        const allOrganizerEvents = [...ctx.db.CalendarEvent.organizer_id.filter(user.id)];
        const newEvent = allOrganizerEvents.sort((a: any, b: any) =>
            Number(b.createdDate.microsSinceUnixEpoch - a.createdDate.microsSinceUnixEpoch)
        )[0];
        if (!newEvent) return;

        // Insert auto-invites for tournament-linked events
        for (const inviteeId of autoInviteeIds) {
            ctx.db.CalendarEventInvite.insert(insertWithAudit(ctx, {
                eventId: newEvent.id,
                inviteeUserId: inviteeId,
                inviteStatus: { tag: 'Pending', value: {} } as any,
                respondedAt: undefined,
            }, user.id));
        }

        // Insert manual invites
        for (const inviteeId of uniqueManual) {
            ctx.db.CalendarEventInvite.insert(insertWithAudit(ctx, {
                eventId: newEvent.id,
                inviteeUserId: inviteeId,
                inviteStatus: { tag: 'Pending', value: {} } as any,
                respondedAt: undefined,
            }, user.id));
        }
    }
);

// ─── update_calendar_event ──────────────────────────────────────────────────
// Updates event title, description, and time window.
// Does NOT allow changing bracketMatchId (D-19 — delete and recreate to reschedule).

export const update_calendar_event = spacetimedb.reducer(
    {
        eventId: t.u32(),
        title: t.string(),
        description: t.string(),
        startAt: t.string(),
        endAt: t.string(),
    },
    (ctx, { eventId, title, description, startAt, endAt }: {
        eventId: number;
        title: string;
        description: string;
        startAt: string;
        endAt: string;
    }) => {
        const user = getAuthenticatedUser(ctx);

        const event = ctx.db.CalendarEvent.id.find(eventId);
        if (!event) throw new SenderError('Calendar event not found.');
        if (event.organizerId !== user.id && !isRoleAtLeast(user.role, 'Admin')) {
            throw new SenderError('Forbidden: Only the organizer or an Admin can update this event.');
        }

        if (!title || title.trim() === '') throw new SenderError('Event title must not be empty.');

        const startMicros = BigInt(startAt);
        const endMicros = BigInt(endAt);
        if (startMicros >= endMicros) throw new SenderError('Start time must be before end time.');

        ctx.db.CalendarEvent.id.update(updateWithAudit(ctx, event, {
            title: title.trim(),
            description: description && description.trim() !== '' ? description.trim() : undefined,
            startAt: new Timestamp(startMicros),
            endAt: new Timestamp(endMicros),
        }, user.id));
    }
);

// ─── delete_calendar_event ──────────────────────────────────────────────────
// Deletes a calendar event and cascades to all invites (D-03).

export const delete_calendar_event = spacetimedb.reducer(
    { eventId: t.u32() },
    (ctx, { eventId }: { eventId: number }) => {
        const user = getAuthenticatedUser(ctx);

        const event = ctx.db.CalendarEvent.id.find(eventId);
        if (!event) throw new SenderError('Calendar event not found.');
        if (event.organizerId !== user.id && !isRoleAtLeast(user.role, 'Admin')) {
            throw new SenderError('Forbidden: Only the organizer or an Admin can delete this event.');
        }

        deleteCalendarEventWithInvites(ctx, eventId);
    }
);

// ─── invite_to_event ────────────────────────────────────────────────────────
// Adds an invite for a user to a calendar event.

export const invite_to_event = spacetimedb.reducer(
    { eventId: t.u32(), inviteeUserId: t.u32() },
    (ctx, { eventId, inviteeUserId }: { eventId: number; inviteeUserId: number }) => {
        const user = getAuthenticatedUser(ctx);

        const event = ctx.db.CalendarEvent.id.find(eventId);
        if (!event) throw new SenderError('Calendar event not found.');
        if (event.organizerId !== user.id && !isRoleAtLeast(user.role, 'Admin')) {
            throw new SenderError('Forbidden: Only the organizer or an Admin can invite users to this event.');
        }

        const invitee = ctx.db.User.id.find(inviteeUserId);
        if (!invitee) throw new SenderError('Invitee user not found.');

        // Duplicate check
        const existingInvite = [...ctx.db.CalendarEventInvite.by_event_and_invitee.filter([eventId, inviteeUserId])][0];
        if (existingInvite) throw new SenderError('User is already invited to this event.');

        // Cap check (D-04)
        const currentInvites = [...ctx.db.CalendarEventInvite.event_id.filter(eventId)];
        if (currentInvites.length >= MAX_INVITEES_PER_EVENT) {
            throw new SenderError(`Maximum ${MAX_INVITEES_PER_EVENT} invitees per event.`);
        }

        ctx.db.CalendarEventInvite.insert(insertWithAudit(ctx, {
            eventId,
            inviteeUserId,
            inviteStatus: { tag: 'Pending', value: {} } as any,
            respondedAt: undefined,
        }, user.id));
    }
);

// ─── remove_invite ──────────────────────────────────────────────────────────
// Removes an invite from a calendar event.

export const remove_invite = spacetimedb.reducer(
    { eventId: t.u32(), inviteeUserId: t.u32() },
    (ctx, { eventId, inviteeUserId }: { eventId: number; inviteeUserId: number }) => {
        const user = getAuthenticatedUser(ctx);

        const event = ctx.db.CalendarEvent.id.find(eventId);
        if (!event) throw new SenderError('Calendar event not found.');
        if (event.organizerId !== user.id && !isRoleAtLeast(user.role, 'Admin')) {
            throw new SenderError('Forbidden: Only the organizer or an Admin can remove invites from this event.');
        }

        const invite = [...ctx.db.CalendarEventInvite.by_event_and_invitee.filter([eventId, inviteeUserId])][0];
        if (!invite) throw new SenderError('Invite not found.');

        ctx.db.CalendarEventInvite.delete(invite);
    }
);
