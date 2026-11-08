/**
 * Lazy cleanup helpers for calendar data.
 * Called on every calendar reducer call to clean up expired entries without
 * running a scheduled reducer (reducers must be deterministic).
 *
 * Per D-07 and D-27:
 *  - AvailabilitySlot: delete 1 week after expiresAt
 *  - CalendarEvent: delete 90 days after endAt
 */

import { deleteCalendarEventWithInvites } from './calendarCascade';

const ONE_WEEK_MICROS = BigInt(7 * 24 * 60 * 60) * BigInt(1_000_000);
const NINETY_DAYS_MICROS = BigInt(90 * 24 * 60 * 60) * BigInt(1_000_000);

/**
 * Deletes expired AvailabilitySlot rows for a user.
 * A slot is eligible for deletion if: expiresAt + 1 week < now.
 * Per D-27: 1-week grace period after expiry before hard deletion.
 */
export function cleanupExpiredSlots(ctx: any, userId: number): void {
    const now = ctx.timestamp.microsSinceUnixEpoch;
    const slots = [...ctx.db.AvailabilitySlot.user_id.filter(userId)];
    for (const slot of slots) {
        if (slot.expiresAt.microsSinceUnixEpoch + ONE_WEEK_MICROS < now) {
            ctx.db.AvailabilitySlot.id.delete(slot.id);
        }
    }
}

/**
 * Deletes old CalendarEvent rows for a user (as organizer).
 * An event is eligible for deletion if: endAt + 90 days < now.
 * Per D-07: 90-day retention window; cascade-deletes invites first.
 */
export function cleanupOldEvents(ctx: any, userId: number): void {
    const now = ctx.timestamp.microsSinceUnixEpoch;
    const events = [...ctx.db.CalendarEvent.organizer_id.filter(userId)];
    for (const event of events) {
        if (event.endAt.microsSinceUnixEpoch + NINETY_DAYS_MICROS < now) {
            deleteCalendarEventWithInvites(ctx, event.id);
        }
    }
}
