// ─── Calendar Saved (Bookmarks) Reducers ─────────────────────────────────────
// Manages a user's list of saved/watched calendars.
//
// Permission model: non-guest users only (CAL-02)
// Cap (D-15): max 5 saved calendars per user
// Visibility toggle (D-16): per saved calendar, not global

import spacetimedb from '@module/schema';
import { t, SenderError } from 'spacetimedb/server';
import { getAuthenticatedUser } from '@module/helpers/identity/ensurePermissions';
import { insertWithAudit, updateWithAudit } from '@module/helpers/admin/auditHelpers';
import { runCalendarCleanup } from '@module/helpers/calendar/calendarCleanup';
import { consumeMembershipAllowance, MEMBERSHIP_ACTION_TEXT } from '@module/helpers/lobby/abuseControls';
import { ensureCalendarTarget } from '@module/helpers/calendar/calendarTargets';

const MAX_SAVED_CALENDARS = 5;

// ─── save_calendar ───────────────────────────────────────────────────────────
// Saves another user's calendar as a bookmark. Visible by default.

export const save_calendar = spacetimedb.reducer(
    { targetUserId: t.u32() },
    (ctx, { targetUserId }: { targetUserId: number }) => {
        const user = getAuthenticatedUser(ctx);
        if (user.isGuest) throw new SenderError('Guests cannot save calendars.');
        consumeMembershipAllowance(ctx, user.id, MEMBERSHIP_ACTION_TEXT); // S10s (A122(4), L93; fix pass F11): allowance first
        runCalendarCleanup(ctx, user.id); // S10s (A122(22), L86): clean-up before the main operation

        if (targetUserId === user.id) {
            throw new SenderError('Cannot save your own calendar.');
        }

        const target = ctx.db.User.id.find(targetUserId);
        if (!target) throw new SenderError('Target user not found.');
        ensureCalendarTarget(target, 'save'); // S10ac (A157(7)): no guest, no user pending deletion

        // Duplicate check
        const existing = [...ctx.db.SavedCalendar.by_user_and_target.filter([user.id, targetUserId])][0];
        if (existing) throw new SenderError('Already saved.');

        // Cap check
        const saved = [...ctx.db.SavedCalendar.user_id.filter(user.id)];
        if (saved.length >= MAX_SAVED_CALENDARS) {
            throw new SenderError(`Maximum ${MAX_SAVED_CALENDARS} saved calendars per user.`);
        }

        ctx.db.SavedCalendar.insert(insertWithAudit(ctx, {
            userId: user.id,
            targetUserId,
            isVisible: true,
        }, user.id));
    }
);

// ─── unsave_calendar ─────────────────────────────────────────────────────────
// Removes a saved calendar bookmark.

export const unsave_calendar = spacetimedb.reducer(
    { targetUserId: t.u32() },
    (ctx, { targetUserId }: { targetUserId: number }) => {
        const user = getAuthenticatedUser(ctx);
        if (user.isGuest) throw new SenderError('Guests cannot manage saved calendars.');
        consumeMembershipAllowance(ctx, user.id, MEMBERSHIP_ACTION_TEXT); // S10s (A122(4), L93; fix pass F11): allowance first
        runCalendarCleanup(ctx, user.id); // S10s (A122(22), L86): clean-up before the main operation

        const existing = [...ctx.db.SavedCalendar.by_user_and_target.filter([user.id, targetUserId])][0];
        if (!existing) throw new SenderError('Calendar not saved.');

        ctx.db.SavedCalendar.delete(existing);
    }
);

// ─── toggle_calendar_visibility ──────────────────────────────────────────────
// Toggles visibility of a saved calendar without unsaving it.
// Composite PK update: delete + re-insert.

export const toggle_calendar_visibility = spacetimedb.reducer(
    { targetUserId: t.u32(), isVisible: t.bool() },
    (ctx, { targetUserId, isVisible }: { targetUserId: number; isVisible: boolean }) => {
        const user = getAuthenticatedUser(ctx);
        if (user.isGuest) throw new SenderError('Guests cannot manage saved calendars.');
        consumeMembershipAllowance(ctx, user.id, MEMBERSHIP_ACTION_TEXT); // S10s (A122(4), L93; fix pass F11): allowance first
        runCalendarCleanup(ctx, user.id); // S10s (A122(22), L86): clean-up before the main operation

        const existing = [...ctx.db.SavedCalendar.by_user_and_target.filter([user.id, targetUserId])][0];
        if (!existing) throw new SenderError('Calendar not saved.');

        // Composite PK update: delete + re-insert
        ctx.db.SavedCalendar.delete(existing);
        ctx.db.SavedCalendar.insert(updateWithAudit(ctx, existing, {
            isVisible,
        }, user.id));
    }
);
