// ─── Calendar Invite Response Reducer ─────────────────────────────────────────
// Allows an invitee to respond to a calendar event invite.
//
// Permission model: invitee only (D-01, D-02, D-08)
// Valid statuses: Accepted, Declined, Tentative (NOT Pending)
// respondedAt is set to ctx.timestamp on response (D-02)

import spacetimedb from '@module/schema';
import { t, SenderError } from 'spacetimedb/server';
import { getAuthenticatedUser } from '@module/helpers/identity/ensurePermissions';
import { updateWithAudit } from '@module/helpers/admin/auditHelpers';
import { runCalendarCleanup } from '@module/helpers/calendar/calendarCleanup';
import { consumeMembershipAllowance, MEMBERSHIP_ACTION_TEXT } from '@module/helpers/lobby/abuseControls';

// ─── respond_to_invite ───────────────────────────────────────────────────────
// Sets the invitee's response status on a calendar event invite.
// Composite PK update: delete + re-insert (eventId + inviteeUserId).

export const respond_to_invite = spacetimedb.reducer(
    {
        eventId: t.u32(),
        status: t.string(), // Accepted | Declined | Tentative
    },
    (ctx, { eventId, status }: { eventId: number; status: string }) => {
        const user = getAuthenticatedUser(ctx);
        if (user.isGuest) throw new SenderError('Guests cannot respond to event invites.');
        consumeMembershipAllowance(ctx, user.id, MEMBERSHIP_ACTION_TEXT); // S10s (A122(4), L93; fix pass F11): allowance first
        runCalendarCleanup(ctx, user.id, { eventId }); // S10s (A122(22), L86; fix pass F2): clean-up, sparing this call's target

        // Validate status — Pending is not a valid response
        const validStatuses = ['Accepted', 'Declined', 'Tentative'];
        if (!validStatuses.includes(status)) {
            if (status === 'Pending') {
                throw new SenderError('Cannot respond with Pending status.');
            }
            throw new SenderError(`Invalid status. Must be one of: ${validStatuses.join(', ')}.`);
        }

        const invite = [...ctx.db.CalendarEventInvite.by_event_and_invitee.filter([eventId, user.id])][0];
        if (!invite) throw new SenderError('You have no invite for this event.');

        // Composite PK update: delete + re-insert
        ctx.db.CalendarEventInvite.delete(invite);
        ctx.db.CalendarEventInvite.insert(updateWithAudit(ctx, invite, {
            inviteStatus: { tag: status, value: {} } as any,
            respondedAt: ctx.timestamp,
        }, user.id));
    }
);
