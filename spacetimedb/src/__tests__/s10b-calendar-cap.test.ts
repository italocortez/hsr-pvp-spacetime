// T-S10b: in-memory tests for A79, the calendar event caps and the end-time guards: 40 not-yet-ended events per
// organizer (ended ones do not count), a ceiling of 100 retained events (ended or not, after the 90-day cleanup), no
// endAt in the past on create, no changed endAt in the past on update, and the D-07 cleanup unchanged. Times are micros
// strings from the TestClock (s10-c2 fixtures); a rejection asserts the state first and the text last. No maincloud.
import { describe, expect, it } from 'vitest';
import { M, advance, newHarness, tx, type Actor, type Harness } from './s4-fixtures';
import { verified } from './s8-fixtures';
import { DAY_MS, HOUR_MS, createEvent, eventArgs, eventsOf, fromNow, invitesOf, rejection } from './s10-c2-fixtures';

const ACTIVE_CAP = 'Maximum 40 active calendar events per user.';
const RETAINED_CAP = 'Maximum 100 calendar events per user.';
const PAST_END = 'Event end time must not be in the past.';

function world(n = 1) {
    const test = newHarness();
    const users = Array.from({ length: n }, (_, i) => verified(test, `capcal${i + 1}`));
    return { test, users };
}

const event = (test: Harness, id: number) => test.db.CalendarEvent.id.find(id) ?? undefined; // find() returns null when absent
const tryCreate = (test: Harness, who: Actor, title: string) =>
    rejection(test, who, (ctx) => M.create_calendar_event(ctx, eventArgs(test, { title })));

/** `count` events by `who`, each one hour long, starting now (they end within the hour). */
function createShort(test: Harness, who: Actor, count: number, prefix: string) {
    for (let i = 0; i < count; i++) createEvent(test, who, { title: `${prefix}${i}`, startMs: 0, endMs: HOUR_MS });
}

// ─── A79(1): 40 not-yet-ended events ─────────────────────────────────────────────────────────────────────────────

describe('A79(1): the active cap counts events that have not ended', () => {
    it('40 not-ended events: the 41st is rejected; an event ending exactly now still counts; once one has ended a create succeeds (A79(1))', () => {
        const { test, users: [a] } = world();
        // E0 ends in one hour; E1..E39 end days later.
        createEvent(test, a, { title: 'E0', startMs: 0, endMs: HOUR_MS });
        for (let i = 1; i < 40; i++) createEvent(test, a, { title: `E${i}`, startMs: i * DAY_MS, endMs: i * DAY_MS + HOUR_MS });
        expect(eventsOf(test, a)).toHaveLength(40);

        const first = tryCreate(test, a, 'E40');
        expect(eventsOf(test, a)).toHaveLength(40);
        expect(first).toBe(ACTIVE_CAP);

        advance(test, HOUR_MS); // E0's endAt = now: not yet ended (endAt >= now)
        const atEnd = tryCreate(test, a, 'E40');
        expect(eventsOf(test, a)).toHaveLength(40);
        expect(atEnd).toBe(ACTIVE_CAP);

        advance(test, 1); // E0 has ended: 39 active
        createEvent(test, a, { title: 'E40' });
        expect(eventsOf(test, a)).toHaveLength(41); // the ended event is still retained
        expect(eventsOf(test, a).some((e) => e.title === 'E0')).toBe(true);

        const again = tryCreate(test, a, 'E41'); // 40 active again
        expect(eventsOf(test, a)).toHaveLength(41);
        expect(again).toBe(ACTIVE_CAP);
    });

    it('the cap is per organizer: another user still creates while the first one is at 40 (A79(1))', () => {
        const { test, users: [a, b] } = world(2);
        for (let i = 0; i < 40; i++) createEvent(test, a, { title: `E${i}`, startMs: (i + 1) * HOUR_MS * 3 });
        expect(tryCreate(test, a, 'E40')).toBe(ACTIVE_CAP);
        createEvent(test, b, { title: 'B0' });
        expect(eventsOf(test, b)).toHaveLength(1);
        expect(eventsOf(test, a)).toHaveLength(40);
    });
});

// ─── A79(2): the retained ceiling ────────────────────────────────────────────────────────────────────────────────

describe('A79(2): at most 100 retained events per organizer', () => {
    it('100 events (80 ended, 20 active) inside 90 days: the 101st is rejected; after the 90-day cleanup removes the ended ones a create succeeds (A79(2), A79(4))', () => {
        const { test, users: [a] } = world();
        createShort(test, a, 40, 'R1-');
        advance(test, 2 * HOUR_MS); // round 1 has ended
        createShort(test, a, 40, 'R2-');
        advance(test, 2 * HOUR_MS); // round 2 has ended
        for (let i = 0; i < 20; i++) createEvent(test, a, { title: `R3-${i}`, startMs: DAY_MS, endMs: 100 * DAY_MS });
        expect(eventsOf(test, a)).toHaveLength(100);

        const msg = tryCreate(test, a, 'over');
        expect(eventsOf(test, a)).toHaveLength(100);
        expect(msg).toBe(RETAINED_CAP);

        advance(test, 90 * DAY_MS + HOUR_MS); // rounds 1 and 2 ended more than 90 days ago; round 3 still runs
        createEvent(test, a, { title: 'after-cleanup' });
        const titles = eventsOf(test, a).map((e) => e.title);
        expect(titles).toHaveLength(21);
        expect(titles.filter((t) => t.startsWith('R3-'))).toHaveLength(20);
        expect(titles).toContain('after-cleanup');
    });
});

// ─── A79(3): end-time guards ─────────────────────────────────────────────────────────────────────────────────────

describe('A79(3): no endAt in the past', () => {
    it('create with endAt in the past is rejected "Event end time must not be in the past.", no row (A79(3))', () => {
        const { test, users: [a] } = world();
        const msg = rejection(test, a, (ctx) =>
            M.create_calendar_event(ctx, eventArgs(test, { title: 'Past', startMs: -2 * HOUR_MS, endMs: -HOUR_MS })));
        expect(eventsOf(test, a)).toHaveLength(0);
        expect(msg).toBe(PAST_END);

        // A start in the past with an end still ahead is accepted (only the end is guarded).
        createEvent(test, a, { title: 'Running', startMs: -HOUR_MS, endMs: HOUR_MS });
        expect(eventsOf(test, a).map((e) => e.title)).toEqual(['Running']);
    });

    it('update: a changed endAt in the past is rejected (row unchanged); a finished event keeps its endAt and edits its title; moving endAt to the future succeeds (A79(3))', () => {
        const { test, users: [a] } = world();
        const id = createEvent(test, a, { title: 'Match', startMs: HOUR_MS, endMs: 2 * HOUR_MS });
        advance(test, 3 * HOUR_MS); // the event has finished
        const row0 = event(test, id)!;
        const startAt = row0.startAt.microsSinceUnixEpoch;
        const endAt = row0.endAt.microsSinceUnixEpoch;
        const update = (title: string, end: bigint) => (ctx: any) =>
            M.update_calendar_event(ctx, { eventId: id, title, description: '', startAt: startAt.toString(), endAt: end.toString() });

        const msg = rejection(test, a, update('Moved', endAt - BigInt(30 * 60_000) * 1000n)); // still after startAt, in the past
        const after = event(test, id)!;
        expect(after.title).toBe('Match');
        expect(after.endAt.microsSinceUnixEpoch).toBe(endAt);
        expect(msg).toBe(PAST_END);

        tx(test, a, update('Match (final)', endAt)); // unchanged endAt, in the past: allowed
        expect(event(test, id)!.title).toBe('Match (final)');
        expect(event(test, id)!.endAt.microsSinceUnixEpoch).toBe(endAt);

        const future = BigInt(fromNow(test, HOUR_MS));
        tx(test, a, update('Match (replay)', future));
        expect(event(test, id)!.title).toBe('Match (replay)');
        expect(event(test, id)!.endAt.microsSinceUnixEpoch).toBe(future);
    });
});

// ─── A79(4): the D-07 cleanup is unchanged ───────────────────────────────────────────────────────────────────────

describe('A79(4): the 90-day cleanup (D-07)', () => {
    it('an event is kept up to 90 days after its end and deleted with its invites on the next create past that (A79(4))', () => {
        const { test, users: [a, b] } = world(2);
        const old = createEvent(test, a, { title: 'Old', startMs: 0, endMs: HOUR_MS, invitees: [b] });
        expect(invitesOf(test, old)).toHaveLength(1);

        advance(test, HOUR_MS + 90 * DAY_MS); // endAt + 90 days = now: not past it
        createEvent(test, a, { title: 'Kept' });
        expect(event(test, old)).toBeDefined();
        expect(invitesOf(test, old)).toHaveLength(1);

        advance(test, 1);
        createEvent(test, a, { title: 'Swept' });
        expect(event(test, old)).toBeUndefined();
        expect(invitesOf(test, old)).toEqual([]);
        expect(eventsOf(test, a).map((e) => e.title).sort()).toEqual(['Kept', 'Swept']);
    });
});
