/**
 * Cleanup helpers for calendar data: the lazy clean-up every calendar reducer runs for its caller, and (S10ac,
 * A157(10)) the bounded sweep of the scheduled identity GC for rows whose owner does not come back.
 *
 * Per D-07 and D-27:
 *  - AvailabilitySlot: delete 1 week after endAt (S10ac: a slot is one dated interval; expiresAt was removed)
 *  - CalendarEvent: delete 90 days after endAt
 */

import { deleteCalendarEventWithInvites } from './calendarCascade';

const ONE_WEEK_MICROS = BigInt(7 * 24 * 60 * 60) * BigInt(1_000_000);
const NINETY_DAYS_MICROS = BigInt(90 * 24 * 60 * 60) * BigInt(1_000_000);

/** D-27: a slot is past retention once endAt + 1 week < now. */
const slotPastRetention = (slot: any, now: bigint) => slot.endAt.microsSinceUnixEpoch + ONE_WEEK_MICROS < now;
/** D-07: an event is past retention once endAt + 90 days < now. */
const eventPastRetention = (event: any, now: bigint) => event.endAt.microsSinceUnixEpoch + NINETY_DAYS_MICROS < now;

/**
 * Deletes expired AvailabilitySlot rows for a user.
 * A slot is eligible for deletion if: endAt + 1 week < now.
 * Per D-27: 1-week grace period after the end before hard deletion.
 */
export function cleanupExpiredSlots(ctx: any, userId: number, keepSlotId?: number): void {
    const now = ctx.timestamp.microsSinceUnixEpoch;
    const slots = [...ctx.db.AvailabilitySlot.user_id.filter(userId)];
    for (const slot of slots) {
        if (slot.id === keepSlotId) continue; // S10s fix pass F2: the call's own target
        if (slotPastRetention(slot, now)) {
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
        if (eventPastRetention(event, now)) {
            deleteCalendarEventWithInvites(ctx, event.id);
        }
    }
}

/**
 * S10s (A122(22), L86): the lazy clean-up every calendar reducer runs for its caller before the main operation (the
 * contract's "User calls any calendar reducer"): the caller's slots ended more than a week ago and the caller's
 * events ended more than 90 days ago, with their invites. Bounded work per call: the caller's own rows only, read
 * through AvailabilitySlot.user_id and CalendarEvent.organizer_id (the caller's slots: at most 10 per week that have
 * not ended, S10ac; the caller's retained events, 100 by the create cap, each with at most 9 invites). Other users'
 * rows are never scanned here; the scheduled sweep below covers owners who do not come back.
 * S10s fix pass (F2, F11): one order in all calendar reducers: authenticate (and the guest check), count the
 * allowance, run this clean-up, then the main operation. `keep` names the call's own target (the slot or event id the
 * arguments name), which the clean-up leaves alone, so a user can still edit or delete their own old event or expired
 * slot (as before S10s); the next calendar call cleans it if it is still old.
 */
export function runCalendarCleanup(ctx: any, userId: number, keep: { eventId?: number; slotId?: number } = {}): void {
    cleanupExpiredSlots(ctx, userId, keep.slotId);
    cleanupOldEvents(ctx, userId, keep.eventId);
}

/** S10ac (A157(10)): at most this many slots and this many events are deleted per sweep. */
export const CALENDAR_SWEEP_BATCH = 500;

/**
 * S10ac (A157(10)): the sweep of the scheduled identity GC (run_identity_gc). Same retention rules as the lazy
 * clean-up, for every owner, so the rows of users who never make another calendar call (B4) go too: slots ended more
 * than a week ago, events ended more than 90 days ago (with their invites, and the match's `scheduledAt`).
 * Bounded: at most CALENDAR_SWEEP_BATCH slots and CALENDAR_SWEEP_BATCH events per run, oldest end first (endAt
 * ascending, then id). The two tables have no endAt index, so each is scanned once per run (`iter()`, weekly);
 * what is left over the batch is found again by the next run, which the caller brings forward (one hour) when a batch
 * was full. Returns the counts for the GcResult row.
 */
export function sweepExpiredCalendarRows(ctx: any): { scanned: number; slotsDeleted: number; eventsDeleted: number; batchFull: boolean } {
    const now: bigint = ctx.timestamp.microsSinceUnixEpoch;
    const byEnd = (a: any, b: any) => {
        const d = a.endAt.microsSinceUnixEpoch - b.endAt.microsSinceUnixEpoch;
        return d < 0n ? -1 : d > 0n ? 1 : a.id - b.id;
    };
    let scanned = 0;
    const slots: any[] = [];
    for (const slot of ctx.db.AvailabilitySlot.iter()) { // full scan: no endAt index (weekly job)
        scanned++;
        if (slotPastRetention(slot, now)) slots.push(slot);
    }
    const events: any[] = [];
    for (const event of ctx.db.CalendarEvent.iter()) { // full scan: no endAt index (weekly job)
        scanned++;
        if (eventPastRetention(event, now)) events.push(event);
    }
    slots.sort(byEnd);
    events.sort(byEnd);
    const slotBatch = slots.slice(0, CALENDAR_SWEEP_BATCH);
    const eventBatch = events.slice(0, CALENDAR_SWEEP_BATCH);
    for (const slot of slotBatch) ctx.db.AvailabilitySlot.id.delete(slot.id);
    for (const event of eventBatch) deleteCalendarEventWithInvites(ctx, event.id);
    return {
        scanned,
        slotsDeleted: slotBatch.length,
        eventsDeleted: eventBatch.length,
        batchFull: slots.length > CALENDAR_SWEEP_BATCH || events.length > CALENDAR_SWEEP_BATCH,
    };
}
