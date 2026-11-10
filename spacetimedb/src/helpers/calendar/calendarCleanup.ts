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
export function cleanupExpiredSlots(ctx: any, userId: number, keepSlotId?: number): void {
    const now = ctx.timestamp.microsSinceUnixEpoch;
    const slots = [...ctx.db.AvailabilitySlot.user_id.filter(userId)];
    for (const slot of slots) {
        if (slot.id === keepSlotId) continue; // S10s fix pass F2: the call's own target
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
export function cleanupOldEvents(ctx: any, userId: number, keepEventId?: number): void {
    const now = ctx.timestamp.microsSinceUnixEpoch;
    const events = [...ctx.db.CalendarEvent.organizer_id.filter(userId)];
    for (const event of events) {
        if (event.id === keepEventId) continue; // S10s fix pass F2: the call's own target
        if (event.endAt.microsSinceUnixEpoch + NINETY_DAYS_MICROS < now) {
            deleteCalendarEventWithInvites(ctx, event.id);
        }
    }
}

/**
 * S10s (A122(22), L86): the lazy clean-up every calendar reducer runs for its caller before the main operation (the
 * contract's "User calls any calendar reducer"): the caller's slots expired more than a week ago and the caller's
 * events ended more than 90 days ago, with their invites. Bounded work per call: the caller's own rows only, read
 * through AvailabilitySlot.user_id and CalendarEvent.organizer_id (at most 10 slots, the slot cap, and the caller's
 * retained events, 100 by the create cap, each with at most 9 invites). Other users' rows are never scanned.
 * S10s fix pass (F2, F11): one order in all twelve calendar reducers: authenticate (and the guest check), count the
 * allowance, run this clean-up, then the main operation. `keep` names the call's own target (the slot or event id the
 * arguments name), which the clean-up leaves alone, so a user can still edit or delete their own old event or expired
 * slot (as before S10s); the next calendar call cleans it if it is still old.
 */
export function runCalendarCleanup(ctx: any, userId: number, keep: { eventId?: number; slotId?: number } = {}): void {
    cleanupExpiredSlots(ctx, userId, keep.slotId);
    cleanupOldEvents(ctx, userId, keep.eventId);
}
