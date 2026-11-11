// Fixtures: TestClock time helpers, availability slots, calendar events and invites.
// From S10 (s10-c2-fixtures.ts).
//
// T-S10 batch C2: builders shared by the calendar tests. Not a test file. State is built through the module's
// reducers. Calendar reducers take micros strings derived from the TestClock (START = 2026-01-01), never Date.now().
// `test.db` is read only outside `tx` bodies. Nothing reaches maincloud.
import { M, tx, type Actor, type Harness } from './harness';

// ─── Time ────────────────────────────────────────────────────────────────────

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;
const MICROS_PER_MS = 1_000n;

/** Micros since the epoch, `ms` from the TestClock's now, as the micros string the calendar reducers take. */
export const fromNow = (test: Harness, ms: number) => (test.clock.now().microsSinceUnixEpoch + BigInt(ms) * MICROS_PER_MS).toString();
export const micros = (ms: number) => BigInt(ms) * MICROS_PER_MS;
/** Micros since the epoch, `hours` from the TestClock's now, as a micros string. */
export const at = (test: Harness, hours: number) => (test.clock.now().microsSinceUnixEpoch + BigInt(hours) * 3_600_000_000n).toString();

// ─── Availability slots ──────────────────────────────────────────────────────

export interface SlotOpts {
    startMs?: number;
    endMs?: number;
    isRecurring?: boolean;
    recurrenceType?: string;
    interval?: number;
    dayOfWeek?: number;
    dayOfMonth?: number;
    endDate?: string;
}

/** create_availability_slot arguments; a one-time 2-hour slot one day out unless overridden. */
export function slotArgs(test: Harness, o: SlotOpts = {}) {
    const startMs = o.startMs ?? DAY_MS;
    return {
        startAt: fromNow(test, startMs),
        endAt: fromNow(test, o.endMs ?? startMs + 2 * HOUR_MS),
        isRecurring: o.isRecurring ?? false,
        recurrenceType: o.recurrenceType ?? '',
        interval: o.interval ?? 0,
        dayOfWeek: o.dayOfWeek ?? 255,
        dayOfMonth: o.dayOfMonth ?? 0,
        endDate: o.endDate ?? '',
    };
}

export function addSlot(test: Harness, who: Actor, o: SlotOpts = {}): number {
    const before = new Set(slotsOf(test, who).map((s) => s.id));
    const args = slotArgs(test, o);
    tx(test, who, (ctx) => M.create_availability_slot(ctx, args));
    return slotsOf(test, who).find((s) => !before.has(s.id))!.id;
}

/** A one-time 2-hour slot starting `startHours` from now (the view tests' builder; returns nothing). */
export function addSlotAt(test: Harness, who: Actor, startHours: number) {
    tx(test, who, (ctx) => M.create_availability_slot(ctx, {
        startAt: at(test, startHours), endAt: at(test, startHours + 2), isRecurring: false, recurrenceType: '',
        interval: 0, dayOfWeek: 255, dayOfMonth: 0, endDate: '',
    }));
}

export const slotsOf = (test: Harness, who: Actor) => [...test.db.AvailabilitySlot.user_id.filter(who.userId)];

// ─── Calendar events ─────────────────────────────────────────────────────────

export interface EventOpts {
    title?: string;
    description?: string;
    startMs?: number;
    endMs?: number;
    bracketMatchId?: number;
    invitees?: Array<Actor | number>;
}

/** create_calendar_event arguments: a 2-hour event one day out, comma-separated invitee ids. */
export function eventArgs(test: Harness, o: EventOpts = {}) {
    const startMs = o.startMs ?? DAY_MS;
    return {
        title: o.title ?? 'Scrim',
        description: o.description ?? '',
        startAt: fromNow(test, startMs),
        endAt: fromNow(test, o.endMs ?? startMs + 2 * HOUR_MS),
        bracketMatchId: o.bracketMatchId ?? 0,
        inviteeUserIds: (o.invitees ?? []).map((i) => (typeof i === 'number' ? i : i.userId)).join(','),
    };
}

/**
 * S10s re-alignment (A122(4), L93): calendar reducers count on the per-user membership allowance (20 calls per 10 s).
 * Seeding helpers that create dozens of rows in one instant empty the caller's count first, so cap tests keep testing
 * the caps; the allowance itself is tested in calendar/event-rules-and-cleanup.test.ts through direct reducer calls.
 */
export function clearMembershipCount(test: Harness, who: Actor): void {
    const row = test.db.UserRateState.userId.find(who.userId);
    if (row) test.db.UserRateState.userId.update({ ...row, membershipCount: 0 });
}

/** Creates the event as `who`; returns the new event's id (a seeding helper: clears the allowance count first). */
export function createEvent(test: Harness, who: Actor, o: EventOpts = {}): number {
    clearMembershipCount(test, who);
    const before = new Set(eventsOf(test, who).map((e) => e.id));
    const args = eventArgs(test, o);
    tx(test, who, (ctx) => M.create_calendar_event(ctx, args));
    return eventsOf(test, who).find((e) => !before.has(e.id))!.id;
}

/**
 * The view tests' builder: an event titled `title` (description "<title> notes") from 24 h to 26 h out; returns its id
 * (found by title; the allowance count is not cleared).
 */
export function createTitledEvent(test: Harness, who: Actor, title: string, invitees: Actor[] = [], bracketMatchId = 0): number {
    tx(test, who, (ctx) => M.create_calendar_event(ctx, {
        title, description: `${title} notes`, startAt: at(test, 24), endAt: at(test, 26), bracketMatchId,
        inviteeUserIds: invitees.map((i) => i.userId).join(','),
    }));
    return [...test.db.CalendarEvent.organizer_id.filter(who.userId)].find((e) => e.title === title)!.id;
}

export const event = (test: Harness, id: number) => test.db.CalendarEvent.id.find(id) ?? undefined; // find() returns null when absent
export const eventsOf = (test: Harness, who: Actor) => [...test.db.CalendarEvent.organizer_id.filter(who.userId)];
export const invitesOf = (test: Harness, eventId: number) => [...test.db.CalendarEventInvite.event_id.filter(eventId)];
export const invite = (test: Harness, eventId: number, userId: number) =>
    [...test.db.CalendarEventInvite.by_event_and_invitee.filter([eventId, userId])][0];
export const savedOf = (test: Harness, who: Actor) => [...test.db.SavedCalendar.user_id.filter(who.userId)];
export const saveCalendar = (test: Harness, who: Actor, target: Actor) =>
    tx(test, who, (ctx) => M.save_calendar(ctx, { targetUserId: target.userId }));
