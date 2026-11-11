/**
 * Cleanup helpers for calendar data: the lazy clean-up every calendar reducer runs for its caller, and (S10ac,
 * A157(10)) the bounded sweep of the scheduled identity GC for rows whose owner does not come back.
 *
 * Per D-07 and D-27:
 *  - AvailabilitySlot: delete 1 week after endAt (S10ac: a slot is one dated interval; expiresAt was removed)
 *  - CalendarEvent: delete 90 days after endAt (S10ad, A160(6): the bracket match keeps its scheduledAt)
 *  - CalendarEventInvite: S10ad (A160(4), A161(2)): a Pending invite is deleted 7 days after its event's end; answered
 *    ones stay with the event
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
 * S10ad (A160(4), A161(2)): the Pending invites of an event go once endAt + 7 days < now (kept at exactly 7 days), so an
 * event moved to a later time within a week of its end keeps every invitee.
 */
const pendingInvitesExpired = (event: any, now: bigint) => event.endAt.microsSinceUnixEpoch + ONE_WEEK_MICROS < now;
const isPending = (invite: any) => invite.inviteStatus.tag === 'Pending';

/** S10ad (A160(4), A161(2)): deletes the Pending invites of an event ended more than 7 days ago; returns how many. */
function deletePendingInvites(ctx: any, eventId: number): number {
    let n = 0;
    for (const invite of [...ctx.db.CalendarEventInvite.event_id.filter(eventId)]) {
        if (!isPending(invite)) continue;
        ctx.db.CalendarEventInvite.delete(invite);
        n++;
    }
    return n;
}

/**
 * Deletes old CalendarEvent rows for a user (as organizer).
 * An event is eligible for deletion if: endAt + 90 days < now.
 * Per D-07: 90-day retention window; cascade-deletes invites first. S10ad (A160(6)): the match keeps its
 * `scheduledAt`. S10ad (A160(4), A161(2)): an event inside retention that ended more than 7 days ago loses its Pending
 * invites (every invitee, guests too); answered invites (Accepted, Declined, Tentative) stay until the event's own
 * retention.
 */
export function cleanupOldEvents(ctx: any, userId: number, keepEventId?: number): void {
    const now = ctx.timestamp.microsSinceUnixEpoch;
    const events = [...ctx.db.CalendarEvent.organizer_id.filter(userId)];
    for (const event of events) {
        if (event.id === keepEventId) continue; // S10s fix pass F2: the call's own target
        if (eventPastRetention(event, now)) {
            deleteCalendarEventWithInvites(ctx, event.id, { keepSchedule: true });
        } else if (pendingInvitesExpired(event, now)) {
            deletePendingInvites(ctx, event.id);
        }
    }
}

/**
 * S10ad (A160(4), A161(2)): deletes the caller's own Pending invites to events that ended more than 7 days ago,
 * whoever organizes them
 * (CalendarEventInvite.invitee_user_id, then CalendarEvent.id). The call's own target event is spared, as above.
 */
export function cleanupEndedPendingInvites(ctx: any, userId: number, keepEventId?: number): void {
    const now = ctx.timestamp.microsSinceUnixEpoch;
    for (const invite of [...ctx.db.CalendarEventInvite.invitee_user_id.filter(userId)]) {
        if (invite.eventId === keepEventId || !isPending(invite)) continue;
        const event = ctx.db.CalendarEvent.id.find(invite.eventId);
        if (event && pendingInvitesExpired(event, now)) ctx.db.CalendarEventInvite.delete(invite);
    }
}

/**
 * S10s (A122(22), L86): the lazy clean-up every calendar reducer runs for its caller before the main operation (the
 * contract's "User calls any calendar reducer"): the caller's slots ended more than a week ago and the caller's
 * events ended more than 90 days ago, with their invites. Bounded work per call: the caller's own rows only, read
 * through AvailabilitySlot.user_id and CalendarEvent.organizer_id (the caller's slots: at most 10 Available and 10
 * Blocked per week, ended or not, S10ad; the caller's retained events, 100 by the create cap, each with at most 9 invites). Other users'
 * rows are never scanned here; the scheduled sweep below covers owners who do not come back.
 * S10s fix pass (F2, F11): one order in all calendar reducers: authenticate (and the guest check), count the
 * allowance, run this clean-up, then the main operation. `keep` names the call's own target (the slot or event id the
 * arguments name), which the clean-up leaves alone, so a user can still edit or delete their own old event or expired
 * slot (as before S10s); the next calendar call cleans it if it is still old.
 * S10ad (A160(4), A161(2)): also the Pending invites of events ended more than 7 days ago, of the events the caller
 * organizes (cleanupOldEvents)
 * and the caller's own (cleanupEndedPendingInvites; at most one row per invite the caller holds).
 */
export function runCalendarCleanup(ctx: any, userId: number, keep: { eventId?: number; slotId?: number } = {}): void {
    cleanupExpiredSlots(ctx, userId, keep.slotId);
    cleanupOldEvents(ctx, userId, keep.eventId);
    cleanupEndedPendingInvites(ctx, userId, keep.eventId);
}

/** S10ac (A157(10)): at most this many slots and this many events are deleted per sweep. */
export const CALENDAR_SWEEP_BATCH = 500;

/**
 * S10ac (A157(10)): the sweep of the scheduled identity GC (run_identity_gc). Same retention rules as the lazy
 * clean-up, for every owner, so the rows of users who never make another calendar call (B4) go too: slots ended more
 * than a week ago, events ended more than 90 days ago (with their invites; the match keeps its `scheduledAt`, below).
 * Bounded: at most CALENDAR_SWEEP_BATCH slots and CALENDAR_SWEEP_BATCH events per run, oldest end first (endAt
 * ascending, then id). The two tables have no endAt index, so each is scanned once per run (`iter()`, weekly);
 * what is left over the batch is found again by the next run, which the caller brings forward (one hour) when a batch
 * was full. Returns the counts for the GcResult row.
 * S10ad (A160(6)): an event removed here keeps its match's `scheduledAt`. S10ad (A160(4), A161(2)): then the Pending
 * invites of the stored events that ended more than 7 days ago, oldest end first, at most CALENDAR_SWEEP_BATCH invite rows per run (read
 * through CalendarEventInvite.event_id per ended event); more left over also brings the next run forward.
 */
export function sweepExpiredCalendarRows(ctx: any): {
    scanned: number; slotsDeleted: number; eventsDeleted: number; pendingInvitesDeleted: number; batchFull: boolean;
} {
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
    const ended: any[] = [];
    for (const event of ctx.db.CalendarEvent.iter()) { // full scan: no endAt index (weekly job)
        scanned++;
        if (eventPastRetention(event, now)) events.push(event);
        if (pendingInvitesExpired(event, now)) ended.push(event);
    }
    slots.sort(byEnd);
    events.sort(byEnd);
    ended.sort(byEnd);
    const slotBatch = slots.slice(0, CALENDAR_SWEEP_BATCH);
    const eventBatch = events.slice(0, CALENDAR_SWEEP_BATCH);
    for (const slot of slotBatch) ctx.db.AvailabilitySlot.id.delete(slot.id);
    for (const event of eventBatch) deleteCalendarEventWithInvites(ctx, event.id, { keepSchedule: true });

    // A160(4), A161(2): Pending invites of the stored events that ended more than 7 days ago (the batch above took its own invites with it)
    const deleted = new Set<number>(eventBatch.map((e: any) => e.id));
    let pendingInvitesDeleted = 0;
    let pendingLeft = false;
    for (const event of ended) {
        if (deleted.has(event.id)) continue;
        for (const invite of [...ctx.db.CalendarEventInvite.event_id.filter(event.id)]) {
            if (!isPending(invite)) continue;
            if (pendingInvitesDeleted >= CALENDAR_SWEEP_BATCH) { pendingLeft = true; break; }
            ctx.db.CalendarEventInvite.delete(invite);
            pendingInvitesDeleted++;
        }
        if (pendingLeft) break;
    }
    return {
        scanned,
        slotsDeleted: slotBatch.length,
        eventsDeleted: eventBatch.length,
        pendingInvitesDeleted,
        batchFull: slots.length > CALENDAR_SWEEP_BATCH || events.length > CALENDAR_SWEEP_BATCH || pendingLeft,
    };
}
