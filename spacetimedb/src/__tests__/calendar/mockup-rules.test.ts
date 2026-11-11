// Calendar: the backend follows the calendar mockup (blocked slots, the weekly slot cap, no recurrence, reschedule
//   reset, guest and pending-deletion targets, leaving an event, past starts, the scheduled sweep, the time
//   validator, the one-call invitee edit, the bracket match's scheduledAt).
// Decisions: A157
// Contracts: docs/calendar/contract.md (entries for A157 pending, see docs/log)
// From S10ac (T-S10ac).
//
// In-memory harness only (SpacetimeDB test-utils; nothing reaches maincloud). Times are micros strings from the
// TestClock: START is Thursday 2026-01-01 00:00 UTC, so the next UTC week starts Monday 2026-01-05 00:00 (+96 h).
import { describe, expect, it } from 'vitest';
import { ScheduleAt, Timestamp } from 'spacetimedb';
import { SenderError } from 'spacetimedb/server';
import { M, advance, guest, newHarness, tx, type Actor, type Harness, snap } from '../fixtures/harness';
import { admin, verified } from '../fixtures/identity';
import {
    DAY_MS,
    HOUR_MS,
    addSlot,
    clearMembershipCount,
    createEvent,
    event,
    eventArgs,
    fromNow,
    invite,
    invitesOf,
    slotArgs,
    slotsOf,
} from '../fixtures/calendar';
import { duel } from '../fixtures/tournament-matches';
import { resolveMatch } from '../fixtures/tournaments';

// ─── Texts ───────────────────────────────────────────────────────────────────

const PAST = "You can't schedule something in the past.";
const WEEK_CAP = 'You can set at most 10 availability slots per week.';
const BLOCKED_OWN = 'This time overlaps one of your blocked slots.';
const BLOCKED_ORG = "This time overlaps one of the organizer's blocked slots.";
const BAD_KIND = 'Invalid slot kind. Must be Available or Blocked.';
const SLOT_TOO_LONG = 'An availability slot can last at most 24 hours.';
const EVENT_TOO_LONG = 'An event can last at most 7 days.';
const EVENT_TOO_FAR = 'Events cannot be scheduled more than 12 months in advance.';
const BAD_START = 'Invalid start time.';
const BAD_END = 'Invalid end time.';
const GUEST_SAVE = "A guest's calendar cannot be saved.";
const DELETING_SAVE = "This user's account is being deleted; their calendar cannot be saved.";
const GUEST_INVITE = 'Guests cannot be invited to calendar events.';
const DELETING_INVITE = "This user's account is being deleted; they cannot be invited.";
const INVITE_CAP = 'Maximum 9 invitees per event.';
const BAD_INVITEES = 'Invalid invitee list.';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const NEXT_MONDAY_MS = 96 * HOUR_MS; // 2026-01-05 00:00 UTC
const WEEK_MS = 7 * DAY_MS;

function world(n = 3) {
    const test = newHarness();
    const users = Array.from({ length: n }, (_, i) => verified(test, `mk${i + 1}`));
    return { test, users };
}

const slot = (test: Harness, id: number) => test.db.AvailabilitySlot.id.find(id) ?? undefined;

/** Runs the call, expects a SenderError (never a raw SyntaxError / TypeError) and returns its message. */
function senderRejection(test: Harness, who: Actor, body: (ctx: any) => unknown): string {
    let error: unknown;
    try {
        tx(test, who, body);
    } catch (e) {
        error = e;
    }
    expect(error, 'the call was expected to be rejected').toBeDefined();
    expect(error).toBeInstanceOf(SenderError);
    return (error as Error).message;
}

/** update_calendar_event with the stored values, overridden by `o` (`inviteeUserIds` omitted unless given). */
function updateEvent(id: number, o: { title?: string; description?: string; startAt?: string; endAt?: string; inviteeUserIds?: string } = {}) {
    return (ctx: any) => {
        const e = ctx.db.CalendarEvent.id.find(id);
        return M.update_calendar_event(ctx, {
            eventId: id,
            title: o.title ?? e.title,
            description: o.description ?? e.description ?? '',
            startAt: o.startAt ?? e.startAt.microsSinceUnixEpoch.toString(),
            endAt: o.endAt ?? e.endAt.microsSinceUnixEpoch.toString(),
            ...(o.inviteeUserIds !== undefined ? { inviteeUserIds: o.inviteeUserIds } : {}),
        });
    };
}

function updateSlot(id: number, o: { startAt?: string; endAt?: string; kind?: string } = {}) {
    return (ctx: any) => {
        const s = ctx.db.AvailabilitySlot.id.find(id);
        return M.update_availability_slot(ctx, {
            slotId: id,
            startAt: o.startAt ?? s.startAt.microsSinceUnixEpoch.toString(),
            endAt: o.endAt ?? s.endAt.microsSinceUnixEpoch.toString(),
            kind: o.kind ?? s.kind.tag,
        });
    };
}

const respond = (test: Harness, who: Actor, eventId: number, status: string) =>
    tx(test, who, (ctx) => M.respond_to_invite(ctx, { eventId, status }));

const markPendingDeletion = (test: Harness, who: Actor) =>
    test.db.User.id.update({ ...test.db.User.id.find(who.userId)!, deletedAt: test.clock.now() });

// ════════════════════════════════════════════════════════════════════════════
// A157(1): slot kind and the blocked-slot overlap
// ════════════════════════════════════════════════════════════════════════════

describe('A157(1): availability slots are Available or Blocked; a personal event may not overlap the organizer\'s Blocked slot', () => {
    it('create stores the kind; update changes it; an unknown kind is refused with its text and nothing is written', () => {
        const { test, users: [a] } = world(1);
        const blocked = addSlot(test, a, { kind: 'Blocked' });
        expect(slot(test, blocked)!.kind.tag).toBe('Blocked');
        tx(test, a, updateSlot(blocked, { kind: 'Available' }));
        expect(slot(test, blocked)!.kind.tag).toBe('Available');

        const before = snap(slotsOf(test, a));
        const create = senderRejection(test, a, (ctx) => M.create_availability_slot(ctx, slotArgs(test, { startMs: 2 * DAY_MS, kind: 'Busy' })));
        const update = senderRejection(test, a, updateSlot(blocked, { kind: 'blocked' }));
        expect(snap(slotsOf(test, a))).toBe(before);
        expect([create, update]).toEqual([BAD_KIND, BAD_KIND]);
    });

    it('an event overlapping the organizer\'s own Blocked slot is refused; touching intervals, an Available slot and another user\'s Blocked slot do not block', () => {
        const { test, users: [a, b] } = world(2);
        // a's blocked slot: day 1, 10:00..12:00 (from now)
        const from = DAY_MS + 10 * HOUR_MS;
        const to = DAY_MS + 12 * HOUR_MS;
        addSlot(test, a, { startMs: from, endMs: to, kind: 'Blocked' });
        addSlot(test, a, { startMs: 3 * DAY_MS, endMs: 3 * DAY_MS + 2 * HOUR_MS, kind: 'Available' });
        addSlot(test, b, { startMs: 4 * DAY_MS, endMs: 4 * DAY_MS + 2 * HOUR_MS, kind: 'Blocked' });

        for (const [s, e] of [[from + HOUR_MS / 2, from + HOUR_MS], [from - HOUR_MS, from + 1], [to - 1, to + HOUR_MS], [from - HOUR_MS, to + HOUR_MS]]) {
            clearMembershipCount(test, a);
            const msg = senderRejection(test, a, (ctx) => M.create_calendar_event(ctx, eventArgs(test, { startMs: s, endMs: e })));
            expect(msg).toBe(BLOCKED_OWN);
        }
        expect([...test.db.CalendarEvent.organizer_id.filter(a.userId)]).toEqual([]);

        createEvent(test, a, { title: 'ends at the block', startMs: from - HOUR_MS, endMs: from });
        createEvent(test, a, { title: 'starts at its end', startMs: to, endMs: to + HOUR_MS });
        createEvent(test, a, { title: 'over the available slot', startMs: 3 * DAY_MS, endMs: 3 * DAY_MS + HOUR_MS });
        createEvent(test, a, { title: 'over b\'s block', startMs: 4 * DAY_MS, endMs: 4 * DAY_MS + HOUR_MS });
        expect([...test.db.CalendarEvent.organizer_id.filter(a.userId)]).toHaveLength(4);
    });

    it('update: moving into a Blocked slot is refused (row unchanged); a title edit of an event a later block overlaps passes; an Admin moving it is refused with the organizer text', () => {
        const { test, users: [a] } = world(1);
        const id = createEvent(test, a, { startMs: DAY_MS, endMs: DAY_MS + HOUR_MS });
        addSlot(test, a, { startMs: 2 * DAY_MS, endMs: 2 * DAY_MS + 4 * HOUR_MS, kind: 'Blocked' });
        const before = snap(event(test, id));
        const move = updateEvent(id, { startAt: fromNow(test, 2 * DAY_MS + HOUR_MS), endAt: fromNow(test, 2 * DAY_MS + 2 * HOUR_MS) });
        const msg = senderRejection(test, a, move);
        expect(snap(event(test, id))).toBe(before);
        expect(msg).toBe(BLOCKED_OWN);

        // a block added over the event later does not freeze the event's other fields
        addSlot(test, a, { startMs: DAY_MS, endMs: DAY_MS + 2 * HOUR_MS, kind: 'Blocked' });
        tx(test, a, updateEvent(id, { title: 'Renamed' }));
        expect(event(test, id)!.title).toBe('Renamed');

        const adm = admin(test, 'mkadmin');
        expect(senderRejection(test, adm, move)).toBe(BLOCKED_ORG);
    });

    it('a tournament match event created by staff is exempt: the organizer\'s Blocked slot does not stop bracket scheduling (create and move)', () => {
        const f = duel();
        const { test, org } = f;
        const m = [...test.db.BracketMatch.tournament_id.filter(f.id)][0];
        addSlot(test, org, { startMs: DAY_MS - HOUR_MS, endMs: DAY_MS + 4 * HOUR_MS, kind: 'Blocked' });
        const id = createEvent(test, org, { bracketMatchId: m.id, startMs: DAY_MS, endMs: DAY_MS + HOUR_MS });
        expect(event(test, id)!.bracketMatchId).toBe(m.id);
        tx(test, org, updateEvent(id, { startAt: fromNow(test, DAY_MS + HOUR_MS), endAt: fromNow(test, DAY_MS + 2 * HOUR_MS) }));
        expect(event(test, id)!.startAt.microsSinceUnixEpoch).toBe(BigInt(fromNow(test, DAY_MS + HOUR_MS)));
    });
});

// ════════════════════════════════════════════════════════════════════════════
// A157(2): 10 slots per UTC week
// ════════════════════════════════════════════════════════════════════════════

describe('A157(2): at most 10 slots per UTC week (Monday 00:00 UTC), counted by start; ended slots do not count', () => {
    /** 10 one-hour slots in the week of Monday 2026-01-05, 3 hours apart. */
    const fillNextWeek = (test: Harness, who: Actor) =>
        Array.from({ length: 10 }, (_, i) => addSlot(test, who, { startMs: NEXT_MONDAY_MS + i * 3 * HOUR_MS, endMs: NEXT_MONDAY_MS + i * 3 * HOUR_MS + HOUR_MS }));

    it('week boundary: a slot starting Sunday 23:59:59 UTC counts in the full week and is refused; one starting Monday 00:00 UTC is in the next week and passes', () => {
        const { test, users: [a] } = world(1);
        fillNextWeek(test, a);
        const sunday = NEXT_MONDAY_MS + WEEK_MS - 1000;
        const msg = senderRejection(test, a, (ctx) => M.create_availability_slot(ctx, slotArgs(test, { startMs: sunday, endMs: sunday + HOUR_MS })));
        expect(slotsOf(test, a)).toHaveLength(10);
        expect(msg).toBe(WEEK_CAP);
        addSlot(test, a, { startMs: NEXT_MONDAY_MS + WEEK_MS, endMs: NEXT_MONDAY_MS + WEEK_MS + HOUR_MS });
        expect(slotsOf(test, a)).toHaveLength(11);
    });

    it('a slot crossing midnight into Monday counts in the week of its start; the cap is per user', () => {
        const { test, users: [a, b] } = world(2);
        fillNextWeek(test, a);
        const lateSunday = NEXT_MONDAY_MS + WEEK_MS - HOUR_MS;
        expect(senderRejection(test, a, (ctx) => M.create_availability_slot(ctx, slotArgs(test, { startMs: lateSunday, endMs: lateSunday + 2 * HOUR_MS })))).toBe(WEEK_CAP);
        addSlot(test, b, { startMs: NEXT_MONDAY_MS, endMs: NEXT_MONDAY_MS + HOUR_MS });
        expect(slotsOf(test, b)).toHaveLength(1);
    });

    it('ended slots do not count: 10 slots in the current week, the 11th is refused, then accepted once the first has ended', () => {
        const { test, users: [a] } = world(1);
        for (let i = 0; i < 10; i++) addSlot(test, a, { startMs: i * 2 * HOUR_MS, endMs: i * 2 * HOUR_MS + HOUR_MS });
        const eleventh = () => (ctx: any) => M.create_availability_slot(ctx, slotArgs(test, { startMs: 2 * DAY_MS, endMs: 2 * DAY_MS + HOUR_MS }));
        expect(senderRejection(test, a, eleventh())).toBe(WEEK_CAP);
        advance(test, HOUR_MS); // the first slot ends exactly now: ended (endAt <= now)
        clearMembershipCount(test, a);
        tx(test, a, eleventh());
        expect(slotsOf(test, a)).toHaveLength(11);
    });

    it('update across weeks: moving a slot into a full week is refused; moving a slot inside its full week passes (it does not count itself); moving one out of the full week passes', () => {
        const { test, users: [a] } = world(1);
        const full = fillNextWeek(test, a);
        const other = addSlot(test, a, { startMs: NEXT_MONDAY_MS + WEEK_MS, endMs: NEXT_MONDAY_MS + WEEK_MS + HOUR_MS });
        const before = snap(slot(test, other));
        const into = senderRejection(test, a, updateSlot(other, { startAt: fromNow(test, NEXT_MONDAY_MS + 2 * DAY_MS), endAt: fromNow(test, NEXT_MONDAY_MS + 2 * DAY_MS + HOUR_MS) }));
        expect(snap(slot(test, other))).toBe(before);
        expect(into).toBe(WEEK_CAP);

        tx(test, a, updateSlot(full[0], { startAt: fromNow(test, NEXT_MONDAY_MS + 5 * DAY_MS), endAt: fromNow(test, NEXT_MONDAY_MS + 5 * DAY_MS + HOUR_MS) }));
        expect(slot(test, full[0])!.startAt.microsSinceUnixEpoch).toBe(BigInt(fromNow(test, NEXT_MONDAY_MS + 5 * DAY_MS)));

        tx(test, a, updateSlot(full[1], { startAt: fromNow(test, NEXT_MONDAY_MS + WEEK_MS + DAY_MS), endAt: fromNow(test, NEXT_MONDAY_MS + WEEK_MS + DAY_MS + HOUR_MS) }));
        tx(test, a, updateSlot(other, { startAt: fromNow(test, NEXT_MONDAY_MS + 2 * DAY_MS), endAt: fromNow(test, NEXT_MONDAY_MS + 2 * DAY_MS + HOUR_MS) }));
        expect(slotsOf(test, a)).toHaveLength(11);
    });

    it('Blocked and Available slots share the cap', () => {
        const { test, users: [a] } = world(1);
        for (let i = 0; i < 10; i++) addSlot(test, a, { startMs: NEXT_MONDAY_MS + i * 3 * HOUR_MS, endMs: NEXT_MONDAY_MS + i * 3 * HOUR_MS + HOUR_MS, kind: i % 2 ? 'Blocked' : 'Available' });
        expect(senderRejection(test, a, (ctx) => M.create_availability_slot(ctx, slotArgs(test, { startMs: NEXT_MONDAY_MS + 2 * DAY_MS, kind: 'Blocked' })))).toBe(WEEK_CAP);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// A157(3): recurrence removed
// ════════════════════════════════════════════════════════════════════════════

describe('A157(3): a slot is one dated interval', () => {
    it('the stored slot carries no recurrence column and no expiresAt', () => {
        const { test, users: [a] } = world(1);
        const id = addSlot(test, a);
        expect(Object.keys(slot(test, id)!).sort()).toEqual(
            ['createdById', 'createdDate', 'endAt', 'id', 'kind', 'lastModifiedById', 'lastModifiedDate', 'startAt', 'userId']);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// A157(4): a reschedule resets the answers
// ════════════════════════════════════════════════════════════════════════════

describe('A157(4): changing an event\'s start or end sets every invite back to Pending', () => {
    function answered() {
        const { test, users: [a, b, c, d] } = world(4);
        const id = createEvent(test, a, { invitees: [b, c, d] });
        respond(test, b, id, 'Accepted');
        respond(test, c, id, 'Declined');
        respond(test, d, id, 'Tentative');
        return { test, a, b, c, d, id };
    }
    const statuses = (test: Harness, id: number) =>
        invitesOf(test, id).map((i) => [i.inviteeUserId, i.inviteStatus.tag, i.respondedAt === undefined] as const).sort((x, y) => x[0] - y[0]);

    it('a title / notes edit keeps the answers; a moved start resets all to Pending with respondedAt cleared', () => {
        const { test, a, b, c, d, id } = answered();
        tx(test, a, updateEvent(id, { title: 'Renamed', description: 'new notes' }));
        expect(statuses(test, id)).toEqual([[b.userId, 'Accepted', false], [c.userId, 'Declined', false], [d.userId, 'Tentative', false]].sort((x, y) => (x[0] as number) - (y[0] as number)));

        tx(test, a, updateEvent(id, { startAt: fromNow(test, 2 * DAY_MS), endAt: fromNow(test, 2 * DAY_MS + HOUR_MS) }));
        expect(statuses(test, id)).toEqual([b, c, d].map((u) => [u.userId, 'Pending', true]).sort((x, y) => (x[0] as number) - (y[0] as number)));
    });

    it('a changed end alone resets too; the invites keep their rows (same invitees) and their creator', () => {
        const { test, a, id } = answered();
        const creators = invitesOf(test, id).map((i) => i.createdById);
        tx(test, a, updateEvent(id, { endAt: fromNow(test, DAY_MS + 3 * HOUR_MS) }));
        expect(invitesOf(test, id).every((i) => i.inviteStatus.tag === 'Pending' && i.respondedAt === undefined)).toBe(true);
        expect(invitesOf(test, id).map((i) => i.createdById)).toEqual(creators);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// A157(7): guests and users pending deletion are not targets
// ════════════════════════════════════════════════════════════════════════════

describe('A157(7): guests and users pending deletion cannot be saved or invited', () => {
    it('save_calendar refuses a guest and a pending-deletion user with their texts; no bookmark', () => {
        const { test, users: [a, del] } = world(2);
        const g = guest(test, 'mkguest');
        markPendingDeletion(test, del);
        const msgs = [
            senderRejection(test, a, (ctx) => M.save_calendar(ctx, { targetUserId: g.userId })),
            senderRejection(test, a, (ctx) => M.save_calendar(ctx, { targetUserId: del.userId })),
        ];
        expect([...test.db.SavedCalendar.user_id.filter(a.userId)]).toEqual([]);
        expect(msgs).toEqual([GUEST_SAVE, DELETING_SAVE]);
    });

    it('create_calendar_event (manual invitee), invite_to_event and update_calendar_event (added invitee) refuse both; nothing is written', () => {
        const { test, users: [a, b, del] } = world(3);
        const g = guest(test, 'mkguest');
        markPendingDeletion(test, del);
        const msgs = [
            senderRejection(test, a, (ctx) => M.create_calendar_event(ctx, eventArgs(test, { invitees: [b, g] }))),
            senderRejection(test, a, (ctx) => M.create_calendar_event(ctx, eventArgs(test, { invitees: [del] }))),
        ];
        expect([...test.db.CalendarEvent.organizer_id.filter(a.userId)]).toEqual([]);
        const id = createEvent(test, a, { invitees: [b] });
        const before = snap(event(test, id), invitesOf(test, id));
        msgs.push(
            senderRejection(test, a, (ctx) => M.invite_to_event(ctx, { eventId: id, inviteeUserId: g.userId })),
            senderRejection(test, a, (ctx) => M.invite_to_event(ctx, { eventId: id, inviteeUserId: del.userId })),
            senderRejection(test, a, updateEvent(id, { title: 'x', inviteeUserIds: `${b.userId},${g.userId}` })),
            senderRejection(test, a, updateEvent(id, { title: 'x', inviteeUserIds: `${del.userId}` })),
        );
        expect(snap(event(test, id), invitesOf(test, id))).toBe(before);
        expect(msgs).toEqual([GUEST_INVITE, DELETING_INVITE, GUEST_INVITE, DELETING_INVITE, GUEST_INVITE, DELETING_INVITE]);
    });

    it('a guest who is a member of a match team is still invited automatically to the match event (server-written invites are not checked)', () => {
        const f = duel();
        const m = [...f.test.db.BracketMatch.tournament_id.filter(f.id)][0];
        const member = f.ts[0].captain;
        f.test.db.User.id.update({ ...f.test.db.User.id.find(member.userId)!, isGuest: true });
        const id = createEvent(f.test, f.org, { bracketMatchId: m.id });
        expect(invite(f.test, id, member.userId)).toBeTruthy();
    });
});

// ════════════════════════════════════════════════════════════════════════════
// A157(8): an invitee may leave
// ════════════════════════════════════════════════════════════════════════════

describe('A157(8): remove_invite on one\'s own invite', () => {
    it('the invitee removes their own invite (personal and match event); the other invites stay', () => {
        const { test, users: [a, b, c] } = world(3);
        const id = createEvent(test, a, { invitees: [b, c] });
        tx(test, b, (ctx) => M.remove_invite(ctx, { eventId: id, inviteeUserId: b.userId }));
        expect(invite(test, id, b.userId)).toBeUndefined();
        expect(invite(test, id, c.userId)).toBeTruthy();
        expect(senderRejection(test, b, (ctx) => M.remove_invite(ctx, { eventId: id, inviteeUserId: b.userId }))).toBe('Invite not found.');

        const f = duel();
        const m = [...f.test.db.BracketMatch.tournament_id.filter(f.id)][0];
        const matchEvent = createEvent(f.test, f.org, { bracketMatchId: m.id });
        const player = f.ts[0].captain;
        tx(f.test, player, (ctx) => M.remove_invite(ctx, { eventId: matchEvent, inviteeUserId: player.userId }));
        expect(invite(f.test, matchEvent, player.userId)).toBeUndefined();
    });
});

// ════════════════════════════════════════════════════════════════════════════
// A157(9): no start in the past
// ════════════════════════════════════════════════════════════════════════════

describe('A157(9): a start in the past is refused on create and on a move; an update that keeps a started item\'s start passes', () => {
    it('slots: create with a past start is refused; a start exactly now passes; moving the start into the past is refused; a started slot keeps its start and changes its end', () => {
        const { test, users: [a] } = world(1);
        const msg = senderRejection(test, a, (ctx) => M.create_availability_slot(ctx, slotArgs(test, { startMs: -HOUR_MS, endMs: HOUR_MS })));
        expect(slotsOf(test, a)).toEqual([]);
        expect(msg).toBe(PAST);

        const id = addSlot(test, a, { startMs: 0, endMs: 2 * HOUR_MS });
        advance(test, HOUR_MS); // started
        const before = snap(slot(test, id));
        expect(senderRejection(test, a, updateSlot(id, { startAt: fromNow(test, -30 * 60_000) }))).toBe(PAST);
        expect(snap(slot(test, id))).toBe(before);
        tx(test, a, updateSlot(id, { endAt: fromNow(test, 3 * HOUR_MS), kind: 'Blocked' }));
        expect(slot(test, id)!.endAt.microsSinceUnixEpoch).toBe(BigInt(fromNow(test, 3 * HOUR_MS)));
    });

    it('events: create with a past start is refused; moving the start into the past is refused; a started event keeps its start and edits title and end', () => {
        const { test, users: [a] } = world(1);
        expect(senderRejection(test, a, (ctx) => M.create_calendar_event(ctx, eventArgs(test, { startMs: -1, endMs: HOUR_MS })))).toBe(PAST);
        expect([...test.db.CalendarEvent.organizer_id.filter(a.userId)]).toEqual([]);

        const id = createEvent(test, a, { startMs: 0, endMs: 2 * HOUR_MS });
        advance(test, HOUR_MS);
        const before = snap(event(test, id));
        expect(senderRejection(test, a, updateEvent(id, { startAt: fromNow(test, -10 * 60_000) }))).toBe(PAST);
        expect(snap(event(test, id))).toBe(before);
        tx(test, a, updateEvent(id, { title: 'Still running', endAt: fromNow(test, 2 * HOUR_MS) }));
        expect(event(test, id)!.title).toBe('Still running');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// A157(10): the scheduled sweep
// ════════════════════════════════════════════════════════════════════════════

describe('A157(10): run_identity_gc sweeps calendar rows past retention of users who do not return', () => {
    const runGc = (test: Harness) => {
        const jobs = [...test.db.IdentityGcJob.iter()];
        const arg = jobs[0] ?? { scheduledId: 1n, scheduledAt: ScheduleAt.time(test.clock.now().microsSinceUnixEpoch) };
        tx(test, 'internal', (ctx) => M.run_identity_gc(ctx, { arg } as any));
    };
    const calendarGc = (test: Harness) => [...test.db.GcResult.iter()].filter((r) => r.gcType === 'calendar');

    it('an organizer absent 400 days: the events (with invites) and the slot are deleted by the next run; a saver\'s and an invitee\'s views no longer get them; a recent event of another user stays; one GcResult row', () => {
        const { test, users: [absent, invitee, saver, active] } = world(4);
        const e1 = createEvent(test, absent, { title: 'Old 1', invitees: [invitee] });
        const e2 = createEvent(test, absent, { title: 'Old 2', startMs: 2 * DAY_MS, endMs: 2 * DAY_MS + HOUR_MS, invitees: [invitee] });
        const s1 = addSlot(test, absent);
        tx(test, saver, (ctx) => M.save_calendar(ctx, { targetUserId: absent.userId }));
        advance(test, 400 * DAY_MS);
        const recent = createEvent(test, active, { title: 'Recent' });

        runGc(test);
        expect(event(test, e1)).toBeUndefined();
        expect(event(test, e2)).toBeUndefined();
        expect(invitesOf(test, e1)).toEqual([]);
        expect(invitesOf(test, e2)).toEqual([]);
        expect(slot(test, s1)).toBeUndefined();
        expect(event(test, recent)).toBeTruthy();
        const rows = calendarGc(test);
        expect(rows).toHaveLength(1);
        expect(JSON.parse(rows[0].details)).toEqual({ slots: 1, events: 2 });
        expect(rows[0].itemsDeleted).toBe(3);
    });

    it('retention edges: an event ended 90 days ago and a slot ended 7 days ago stay; past that they go; nothing deleted writes no calendar GcResult', () => {
        const { test, users: [a] } = world(1);
        const e = createEvent(test, a, { startMs: 0, endMs: HOUR_MS });
        const s = addSlot(test, a, { startMs: 0, endMs: HOUR_MS });
        advance(test, HOUR_MS + 7 * DAY_MS);
        runGc(test);
        expect(slot(test, s)).toBeTruthy();
        expect(calendarGc(test)).toEqual([]);
        advance(test, 1);
        runGc(test);
        expect(slot(test, s)).toBeUndefined();
        expect(event(test, e)).toBeTruthy();
        advance(test, 83 * DAY_MS);
        runGc(test);
        expect(event(test, e)).toBeUndefined();
    });

    it('bounded: 501 old slots → 500 deleted oldest end first, the next run is brought forward to one hour, and that run takes the last one', () => {
        const { test, users: [a] } = world(1);
        const ts = test.clock.now();
        const base = ts.microsSinceUnixEpoch;
        for (let i = 0; i < 501; i++) {
            const start = base + BigInt(i) * 60_000_000n;
            test.db.AvailabilitySlot.insert({
                id: 0, userId: a.userId, startAt: new Timestamp(start), endAt: new Timestamp(start + 30_000_000n),
                kind: { tag: 'Available' } as any,
                createdById: a.userId, createdDate: ts, lastModifiedById: a.userId, lastModifiedDate: ts,
            } as any);
        }
        const newest = Math.max(...slotsOf(test, a).map((s) => Number(s.endAt.microsSinceUnixEpoch)));
        advance(test, 30 * DAY_MS);
        runGc(test);
        const left = slotsOf(test, a);
        expect(left).toHaveLength(1);
        expect(Number(left[0].endAt.microsSinceUnixEpoch)).toBe(newest);
        expect(JSON.parse(calendarGc(test)[0].details)).toEqual({ slots: 500, events: 0 });
        expect([...test.db.IdentityGcJob.iter()].map((j) => j.scheduledAt)).toEqual([ScheduleAt.time(test.clock.now().microsSinceUnixEpoch + 3_600_000_000n)]);
        runGc(test);
        expect(slotsOf(test, a)).toEqual([]);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// A157(11): one validator for time arguments; length and distance bounds; characters
// ════════════════════════════════════════════════════════════════════════════

describe('A157(11): every time argument is validated; slot 24 h, event 7 days, event start 12 months ahead; texts count characters', () => {
    const BAD: Array<[string, string]> = [
        ['empty', ''],
        ['negative', '-5'],
        ['above i64', '99999999999999999999999'],
        ['i64 max (year 294247)', '9223372036854775807'],
        ['letters', 'abc'],
        ['decimal', '1.5'],
        ['spaces', ' 1767225600000000'],
        ['before 2020', '1500000000000000'],
        ['year 2100', '4102444800000000'],
    ];

    it.each(BAD)('%s: create / update of slots and events refuse it as a start and as an end with a SenderError; nothing is written', (_name, bad) => {
        const { test, users: [a] } = world(1);
        const sid = addSlot(test, a);
        const eid = createEvent(test, a);
        const before = snap(slotsOf(test, a), [...test.db.CalendarEvent.organizer_id.filter(a.userId)]);
        const good = { startAt: fromNow(test, 2 * DAY_MS), endAt: fromNow(test, 2 * DAY_MS + HOUR_MS) };
        const calls: Array<[string, (ctx: any) => unknown]> = [
            [BAD_START, (ctx) => M.create_availability_slot(ctx, { ...good, startAt: bad, kind: 'Available' })],
            [BAD_END, (ctx) => M.create_availability_slot(ctx, { ...good, endAt: bad, kind: 'Available' })],
            [BAD_START, updateSlot(sid, { startAt: bad })],
            [BAD_END, updateSlot(sid, { endAt: bad })],
            [BAD_START, (ctx) => M.create_calendar_event(ctx, { ...eventArgs(test), startAt: bad })],
            [BAD_END, (ctx) => M.create_calendar_event(ctx, { ...eventArgs(test), endAt: bad })],
            [BAD_START, updateEvent(eid, { startAt: bad })],
            [BAD_END, updateEvent(eid, { endAt: bad })],
        ];
        for (const [text, body] of calls) {
            clearMembershipCount(test, a);
            expect(senderRejection(test, a, body)).toBe(text);
        }
        expect(snap(slotsOf(test, a), [...test.db.CalendarEvent.organizer_id.filter(a.userId)])).toBe(before);
    });

    it('far future: an event 50 years out (and 12 months + 1 ms) is refused; exactly 365 days passes; a slot past 6 months keeps its text', () => {
        const { test, users: [a] } = world(1);
        expect(senderRejection(test, a, (ctx) => M.create_calendar_event(ctx, eventArgs(test, { startMs: 50 * 365 * DAY_MS })))).toBe(EVENT_TOO_FAR);
        expect(senderRejection(test, a, (ctx) => M.create_calendar_event(ctx, eventArgs(test, { startMs: 365 * DAY_MS + 1 })))).toBe(EVENT_TOO_FAR);
        createEvent(test, a, { startMs: 365 * DAY_MS });
        expect(senderRejection(test, a, (ctx) => M.create_availability_slot(ctx, slotArgs(test, { startMs: 181 * DAY_MS }))))
            .toBe('Availability slots cannot be scheduled more than 6 months in advance.');
    });

    it('too long: a slot of 24 h passes, 24 h + 1 ms is refused; an event of 7 days passes, 7 days + 1 ms is refused (create and update)', () => {
        const { test, users: [a] } = world(1);
        const sid = addSlot(test, a, { startMs: DAY_MS, endMs: 2 * DAY_MS });
        expect(senderRejection(test, a, (ctx) => M.create_availability_slot(ctx, slotArgs(test, { startMs: 3 * DAY_MS, endMs: 4 * DAY_MS + 1 })))).toBe(SLOT_TOO_LONG);
        expect(senderRejection(test, a, updateSlot(sid, { endAt: fromNow(test, 2 * DAY_MS + 1) }))).toBe(SLOT_TOO_LONG);
        const eid = createEvent(test, a, { startMs: DAY_MS, endMs: 8 * DAY_MS });
        expect(senderRejection(test, a, (ctx) => M.create_calendar_event(ctx, eventArgs(test, { startMs: DAY_MS, endMs: 8 * DAY_MS + 1 })))).toBe(EVENT_TOO_LONG);
        expect(senderRejection(test, a, updateEvent(eid, { endAt: fromNow(test, 8 * DAY_MS + 1) }))).toBe(EVENT_TOO_LONG);
    });

    it('title and notes count characters: 100 emoji pass as a title (200 UTF-16 units), 101 are refused; 1000 CJK notes pass, 1001 are refused', () => {
        const { test, users: [a] } = world(1);
        const id = createEvent(test, a, { title: '😀'.repeat(100), description: '漢'.repeat(1000) });
        expect(event(test, id)!.title).toBe('😀'.repeat(100));
        expect(senderRejection(test, a, (ctx) => M.create_calendar_event(ctx, eventArgs(test, { title: '😀'.repeat(101) }))))
            .toBe('Event title cannot exceed 100 characters.');
        expect(senderRejection(test, a, (ctx) => M.create_calendar_event(ctx, eventArgs(test, { description: '漢'.repeat(1001) }))))
            .toBe('Event description cannot exceed 1000 characters.');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// A157(12): the one-call invitee edit and the bracket match's scheduledAt
// ════════════════════════════════════════════════════════════════════════════

describe('A157(12): update_calendar_event takes the full invitee set', () => {
    it('adds and removals in one call: removed ones go, kept ones keep their answer, new ones are Pending; omitted keeps the set; \'\' removes everyone', () => {
        const { test, users: [a, b, c, d] } = world(4);
        const id = createEvent(test, a, { invitees: [b, c] });
        respond(test, c, id, 'Declined');
        tx(test, a, updateEvent(id, { title: 'Edited', inviteeUserIds: `${c.userId},${d.userId}` }));
        expect(invite(test, id, b.userId)).toBeUndefined();
        expect(invite(test, id, c.userId)!.inviteStatus.tag).toBe('Declined');
        expect(invite(test, id, d.userId)!.inviteStatus.tag).toBe('Pending');

        tx(test, a, updateEvent(id, { title: 'Edited again' }));
        expect(invitesOf(test, id)).toHaveLength(2);

        tx(test, a, updateEvent(id, { inviteeUserIds: '' }));
        expect(invitesOf(test, id)).toEqual([]);
    });

    it('with a time change the kept invitees are reset to Pending as well', () => {
        const { test, users: [a, b, c] } = world(3);
        const id = createEvent(test, a, { invitees: [b] });
        respond(test, b, id, 'Accepted');
        tx(test, a, updateEvent(id, { startAt: fromNow(test, 2 * DAY_MS), endAt: fromNow(test, 2 * DAY_MS + HOUR_MS), inviteeUserIds: `${b.userId},${c.userId}` }));
        expect(invitesOf(test, id).map((i) => i.inviteStatus.tag)).toEqual(['Pending', 'Pending']);
    });

    it('the cap is checked on the final set: with 9 invitees one is swapped for another in one call; 10 ids are refused and nothing changes', () => {
        const { test, users } = world(12);
        const [a, ...others] = users;
        const id = createEvent(test, a, { invitees: others.slice(0, 9) });
        const swapped = [...others.slice(1, 9), others[9]].map((u) => u.userId);
        tx(test, a, updateEvent(id, { inviteeUserIds: swapped.join(',') }));
        expect(invitesOf(test, id).map((i) => i.inviteeUserId).sort((x, y) => x - y)).toEqual([...swapped].sort((x, y) => x - y));

        const before = snap(event(test, id), invitesOf(test, id));
        const msg = senderRejection(test, a, updateEvent(id, { title: 'too many', inviteeUserIds: others.slice(0, 10).map((u) => u.userId).join(',') }));
        expect(snap(event(test, id), invitesOf(test, id))).toBe(before);
        expect(msg).toBe(INVITE_CAP);
    });

    it('invite_to_event and remove_invite still work one at a time', () => {
        const { test, users: [a, b] } = world(2);
        const id = createEvent(test, a);
        tx(test, a, (ctx) => M.invite_to_event(ctx, { eventId: id, inviteeUserId: b.userId }));
        expect(invite(test, id, b.userId)).toBeTruthy();
        tx(test, a, (ctx) => M.remove_invite(ctx, { eventId: id, inviteeUserId: b.userId }));
        expect(invite(test, id, b.userId)).toBeUndefined();
    });
});

describe('S10ac review M1: the invitee id list is parsed strictly (create and update)', () => {
    const U32 = 4294967296;
    const ids = (test: Harness, id: number) => invitesOf(test, id).map((i) => i.inviteeUserId).sort((x, y) => x - y);
    const eventsBy = (test: Harness, who: Actor) => [...test.db.CalendarEvent.organizer_id.filter(who.userId)];

    it('an alias id above the u32 range is refused on create and on update; nothing is stored', () => {
        const { test, users: [a, b] } = world(2);
        const alias = `${b.userId},${b.userId + U32}`;
        expect(senderRejection(test, a, (ctx) => M.create_calendar_event(ctx, { ...eventArgs(test), inviteeUserIds: alias }))).toBe(BAD_INVITEES);
        expect(eventsBy(test, a)).toEqual([]);

        const id = createEvent(test, a, { invitees: [b] });
        respond(test, b, id, 'Accepted');
        const before = snap(event(test, id), invitesOf(test, id));
        expect(senderRejection(test, a, updateEvent(id, { title: 'x', inviteeUserIds: alias }))).toBe(BAD_INVITEES);
        expect(senderRejection(test, a, updateEvent(id, { title: 'x', inviteeUserIds: `${b.userId + U32}` }))).toBe(BAD_INVITEES);
        expect(snap(event(test, id), invitesOf(test, id))).toBe(before);
        expect(invitesOf(test, id)).toHaveLength(1);
    });

    it('a junk-only list on update is refused and removes nobody', () => {
        const { test, users: [a, b, c] } = world(3);
        const id = createEvent(test, a, { invitees: [b, c] });
        const before = snap(event(test, id), invitesOf(test, id));
        expect(senderRejection(test, a, updateEvent(id, { inviteeUserIds: 'abc' }))).toBe(BAD_INVITEES);
        expect(snap(event(test, id), invitesOf(test, id))).toBe(before);
        expect(ids(test, id)).toEqual([b.userId, c.userId].sort((x, y) => x - y));
    });

    const BAD_TOKENS: Array<[string, (id: number) => string]> = [
        ['digits then letters', (id) => `${id}abc`],
        ['decimal', (id) => `${id}.9`],
        ['exponent', () => '1e3'],
        ['negative', (id) => `-${id}`],
        ['zero', () => '0'],
        ['trailing comma', (id) => `${id},`],
    ];

    it.each(BAD_TOKENS)('%s: refused on create and on update; nothing is written', (_name, list) => {
        const { test, users: [a, b] } = world(2);
        const bad = list(b.userId);
        expect(senderRejection(test, a, (ctx) => M.create_calendar_event(ctx, { ...eventArgs(test), inviteeUserIds: bad }))).toBe(BAD_INVITEES);
        expect(eventsBy(test, a)).toEqual([]);
        const id = createEvent(test, a);
        const before = snap(event(test, id), invitesOf(test, id));
        expect(senderRejection(test, a, updateEvent(id, { title: 'x', inviteeUserIds: bad }))).toBe(BAD_INVITEES);
        expect(snap(event(test, id), invitesOf(test, id))).toBe(before);
    });

    it('plain spaces around ids are trimmed (create and update); a duplicate id is stored once', () => {
        const { test, users: [a, b, c, d] } = world(4);
        clearMembershipCount(test, a);
        tx(test, a, (ctx) => M.create_calendar_event(ctx, { ...eventArgs(test), inviteeUserIds: ` ${b.userId} , ${c.userId} ` }));
        const id = eventsBy(test, a)[0].id;
        expect(ids(test, id)).toEqual([b.userId, c.userId].sort((x, y) => x - y));

        tx(test, a, updateEvent(id, { inviteeUserIds: ` ${d.userId} , ${d.userId} ` }));
        expect(ids(test, id)).toEqual([d.userId]);

        clearMembershipCount(test, a);
        tx(test, a, (ctx) => M.create_calendar_event(ctx, { ...eventArgs(test, { title: 'Dup' }), inviteeUserIds: `${b.userId},${b.userId}` }));
        const dup = eventsBy(test, a).find((e) => e.title === 'Dup')!.id;
        expect(ids(test, dup)).toEqual([b.userId]);
    });

    it('omitted keeps the set; an empty string removes every invitee', () => {
        const { test, users: [a, b, c] } = world(3);
        const id = createEvent(test, a, { invitees: [b, c] });
        tx(test, a, updateEvent(id, { title: 'Renamed' }));
        expect(ids(test, id)).toEqual([b.userId, c.userId].sort((x, y) => x - y));
        tx(test, a, updateEvent(id, { inviteeUserIds: '' }));
        expect(invitesOf(test, id)).toEqual([]);
    });
});

describe('A157(12): a match event writes its start to BracketMatch.scheduledAt', () => {
    const scheduled = (test: Harness, matchId: number) => test.db.BracketMatch.id.find(matchId)!.scheduledAt?.microsSinceUnixEpoch;

    it('written on create, moved with the start, unchanged by an end-only change, cleared on delete', () => {
        const f = duel();
        const { test, org } = f;
        const m = [...test.db.BracketMatch.tournament_id.filter(f.id)][0];
        expect(scheduled(test, m.id)).toBeUndefined();
        const id = createEvent(test, org, { bracketMatchId: m.id, startMs: DAY_MS, endMs: DAY_MS + HOUR_MS });
        expect(scheduled(test, m.id)).toBe(BigInt(fromNow(test, DAY_MS)));

        tx(test, org, updateEvent(id, { startAt: fromNow(test, 2 * DAY_MS), endAt: fromNow(test, 2 * DAY_MS + HOUR_MS) }));
        expect(scheduled(test, m.id)).toBe(BigInt(fromNow(test, 2 * DAY_MS)));
        tx(test, org, updateEvent(id, { endAt: fromNow(test, 2 * DAY_MS + 2 * HOUR_MS) }));
        expect(scheduled(test, m.id)).toBe(BigInt(fromNow(test, 2 * DAY_MS)));

        tx(test, org, (ctx) => M.delete_calendar_event(ctx, { eventId: id }));
        expect(scheduled(test, m.id)).toBeUndefined();
    });

    it('cleared by the cascade: a staff resolve of the Ready match deletes the event (D-22) and clears scheduledAt', () => {
        const f = duel();
        const { test, org } = f;
        const m = [...test.db.BracketMatch.tournament_id.filter(f.id)][0];
        createEvent(test, org, { bracketMatchId: m.id });
        expect(scheduled(test, m.id)).toBeDefined();
        resolveMatch(test, org, m.id, m.team1Id!);
        expect([...test.db.CalendarEvent.bracket_match_id.filter(m.id)]).toEqual([]);
        expect(scheduled(test, m.id)).toBeUndefined();
    });

    it('a personal event touches no bracket match', () => {
        const f = duel();
        const { test, org } = f;
        const m = [...test.db.BracketMatch.tournament_id.filter(f.id)][0];
        createEvent(test, org, { title: 'Personal' });
        expect(scheduled(test, m.id)).toBeUndefined();
    });
});
