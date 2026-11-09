// T-S10 batch C2: the calendar live suite (test/backend/calendar/*) ported to the in-memory harness (SpacetimeDB
// test-utils; nothing reaches maincloud). Every it cites its clause of docs/calendar/contract.md ("Error Cases" table
// rows, "Acceptance Scenarios", "Edge Cases", the Phase 08 D-ids in its Phase History). Where the contract and the code
// disagree the test follows the contract (T-S10 brief): a rejection test checks the state first and the contract's
// exact text last, so a failing text reads as a text mismatch. Exception, A76 (user triage, T-S10 align): the contract
// adopts the code's wording, so an it tagged "(text per A76)" asserts the code's exact text while its name still cites
// the contract line it replaces. Times are micros strings from the TestClock.
import { describe, expect, it } from 'vitest';
import { M, advance, guest, newHarness, tx, type Actor, type Harness } from './s4-fixtures';
import { setUserRole, verified } from './s8-fixtures';
import { duel } from './s8d-fixtures';
import {
    DAY_MS,
    HOUR_MS,
    addSlot,
    createEvent,
    eventArgs,
    eventsOf,
    fromNow,
    invite,
    invitesOf,
    micros,
    rejection,
    savedOf,
    slotArgs,
    slotsOf,
} from './s10-c2-fixtures';

const SIX_MONTHS_MS = 180 * DAY_MS;

function world(n = 3) {
    const test = newHarness();
    const users = Array.from({ length: n }, (_, i) => verified(test, `cal${i + 1}`));
    return { test, users };
}

function admin(test: Harness, name = 'caladmin'): Actor {
    const a = verified(test, name);
    setUserRole(test, a.userId, 'Admin');
    return a;
}

const slot = (test: Harness, id: number) => test.db.AvailabilitySlot.id.find(id) ?? undefined; // find() returns null when absent
const event = (test: Harness, id: number) => test.db.CalendarEvent.id.find(id) ?? undefined;

// ─── Availability slots ──────────────────────────────────────────────────────

describe('availability slots (create / update / delete)', () => {
    it('scenario "Create and Manage Availability Slots": a recurring Weekly slot stores its rule and expires 6 months (180 d) ahead (flow 6, D-28)', () => {
        const { test, users: [a] } = world(1);
        const id = addSlot(test, a, { isRecurring: true, recurrenceType: 'Weekly', interval: 2, dayOfWeek: 3 });
        const row = slot(test, id)!;
        expect(row.userId).toBe(a.userId);
        expect(row.isRecurring).toBe(true);
        expect(row.recurrenceRule.recurrenceType.tag).toBe('Weekly');
        expect(row.recurrenceRule.interval).toBe(2);
        expect(row.recurrenceRule.dayOfWeek).toBe(3);
        expect(row.expiresAt.microsSinceUnixEpoch).toBe(test.clock.now().microsSinceUnixEpoch + micros(SIX_MONTHS_MS));
    });

    it('create_availability_slot flow 6: a recurring slot with an endDate expires at that endDate', () => {
        const { test, users: [a] } = world(1);
        const endDate = fromNow(test, 30 * DAY_MS);
        const id = addSlot(test, a, { isRecurring: true, recurrenceType: 'Daily', interval: 1, endDate });
        expect(slot(test, id)!.expiresAt.microsSinceUnixEpoch).toBe(BigInt(endDate));
    });

    it('create_availability_slot flow 7: a one-time slot expires at its endAt', () => {
        const { test, users: [a] } = world(1);
        const id = addSlot(test, a, { startMs: 3 * HOUR_MS, endMs: 5 * HOUR_MS });
        const row = slot(test, id)!;
        expect(row.isRecurring).toBe(false);
        expect(row.expiresAt.microsSinceUnixEpoch).toBe(row.endAt.microsSinceUnixEpoch);
        expect(row.endAt.microsSinceUnixEpoch).toBe(BigInt(fromNow(test, 5 * HOUR_MS)));
    });

    it('edge case "Overlapping availability slots": allowed (D-14)', () => {
        const { test, users: [a] } = world(1);
        addSlot(test, a, { startMs: DAY_MS, endMs: DAY_MS + 4 * HOUR_MS });
        addSlot(test, a, { startMs: DAY_MS + HOUR_MS, endMs: DAY_MS + 2 * HOUR_MS });
        expect(slotsOf(test, a)).toHaveLength(2);
    });

    it('scenario "Update Availability Slot": the owner changes the times in place (same id, D-12)', () => {
        const { test, users: [a] } = world(1);
        const id = addSlot(test, a);
        const args = slotArgs(test, { startMs: 2 * DAY_MS, endMs: 2 * DAY_MS + 3 * HOUR_MS });
        tx(test, a, (ctx) => M.update_availability_slot(ctx, { slotId: id, ...args }));
        const row = slot(test, id)!;
        expect(row.startAt.microsSinceUnixEpoch).toBe(BigInt(args.startAt));
        expect(row.endAt.microsSinceUnixEpoch).toBe(BigInt(args.endAt));
        expect(slotsOf(test, a)).toHaveLength(1);
    });

    it('update_availability_slot error "startAt >= endAt after update": "Start time must be before end time."', () => {
        const { test, users: [a] } = world(1);
        const id = addSlot(test, a);
        const before = slot(test, id)!;
        const bad = slotArgs(test, { startMs: 3 * DAY_MS, endMs: 3 * DAY_MS });
        const msg = rejection(test, a, (ctx) => M.update_availability_slot(ctx, { slotId: id, ...bad }));
        expect(slot(test, id)!.startAt).toEqual(before.startAt);
        expect(msg).toContain('Start time must be before end time.');
    });

    it('scenario "Another User Cannot Edit/Delete Your Slot" (update): "You can only edit your own availability slots." (text per A76)', () => {
        const { test, users: [a, b] } = world(2);
        const id = addSlot(test, a);
        const before = slot(test, id)!;
        const msg = rejection(test, b, (ctx) => M.update_availability_slot(ctx, { slotId: id, ...slotArgs(test, { startMs: 2 * DAY_MS }) }));
        expect(slot(test, id)!.startAt).toEqual(before.startAt);
        expect(msg).toBe('Not your availability slot.');
    });

    it('update_availability_slot error "Slot not found": "Availability slot #{id} not found." (text per A76)', () => {
        const { test, users: [a] } = world(1);
        const msg = rejection(test, a, (ctx) => M.update_availability_slot(ctx, { slotId: 9999, ...slotArgs(test) }));
        expect(msg).toBe('Availability slot not found.');
    });

    it('scenario "Delete Availability Slot": the owner deletes; an Admin deletes another user\'s slot (Permission: Owner or Admin)', () => {
        const { test, users: [a, b] } = world(2);
        const own = addSlot(test, a);
        tx(test, a, (ctx) => M.delete_availability_slot(ctx, { slotId: own }));
        expect(slot(test, own)).toBeUndefined();

        const other = addSlot(test, b);
        tx(test, admin(test), (ctx) => M.delete_availability_slot(ctx, { slotId: other }));
        expect(slot(test, other)).toBeUndefined();
    });

    it('scenario "Another User Cannot Edit/Delete Your Slot" (delete): "You can only delete your own availability slots."', () => {
        const { test, users: [a, b] } = world(2);
        const id = addSlot(test, a);
        const msg = rejection(test, b, (ctx) => M.delete_availability_slot(ctx, { slotId: id }));
        expect(slot(test, id)).toBeDefined();
        expect(msg).toContain('You can only delete your own availability slots.');
    });

    it('delete_availability_slot error "Slot not found": "Availability slot #{id} not found." (text per A76)', () => {
        const { test, users: [a] } = world(1);
        const msg = rejection(test, a, (ctx) => M.delete_availability_slot(ctx, { slotId: 9999 }));
        expect(msg).toBe('Availability slot not found.');
    });
});

describe('availability slots (rules, caps, cleanup)', () => {
    it('scenario "Availability Slot Cap Enforcement": the 11th slot is rejected with "Maximum of 10 availability slots reached." (D-10) (text per A76)', () => {
        const { test, users: [a] } = world(1);
        for (let i = 0; i < 10; i++) addSlot(test, a, { startMs: (i + 1) * DAY_MS });
        const msg = rejection(test, a, (ctx) => M.create_availability_slot(ctx, slotArgs(test, { startMs: 20 * DAY_MS })));
        expect(slotsOf(test, a)).toHaveLength(10);
        expect(msg).toBe('Maximum 10 availability slots per user.');
    });

    it('create_availability_slot error "Guest caller": "Guests cannot create availability slots." (text per A76)', () => {
        const test = newHarness();
        const g = guest(test, 'calguest');
        const msg = rejection(test, g, (ctx) => M.create_availability_slot(ctx, slotArgs(test)));
        expect(slotsOf(test, g)).toHaveLength(0);
        expect(msg).toBe('Guests cannot manage availability slots.');
    });

    it('create_availability_slot error "startAt >= endAt": "Start time must be before end time."', () => {
        const { test, users: [a] } = world(1);
        const msg = rejection(test, a, (ctx) => M.create_availability_slot(ctx, slotArgs(test, { startMs: DAY_MS, endMs: DAY_MS - HOUR_MS })));
        expect(slotsOf(test, a)).toHaveLength(0);
        expect(msg).toContain('Start time must be before end time.');
    });

    it('create_availability_slot error "startAt > 6 months ahead": "Cannot create availability more than 6 months in the future." (D-28) (text per A76)', () => {
        const { test, users: [a] } = world(1);
        const msg = rejection(test, a, (ctx) => M.create_availability_slot(ctx, slotArgs(test, { startMs: SIX_MONTHS_MS + DAY_MS })));
        expect(slotsOf(test, a)).toHaveLength(0);
        expect(msg).toBe('Availability slots cannot be scheduled more than 6 months in advance.');
    });

    it('create_availability_slot error "isRecurring but no recurrenceType": "Recurrence type is required for recurring slots." (text per A76)', () => {
        const { test, users: [a] } = world(1);
        const msg = rejection(test, a, (ctx) => M.create_availability_slot(ctx, slotArgs(test, { isRecurring: true, recurrenceType: '' })));
        expect(slotsOf(test, a)).toHaveLength(0);
        expect(msg).toBe('Recurring slots require a recurrence type (Daily, Weekly, or Monthly).');
    });

    it('scenario "Lazy Cleanup of Expired Slots": a slot expired more than 1 week ago is deleted on the next create; one inside the grace week stays (D-27)', () => {
        const { test, users: [a] } = world(1);
        const old = addSlot(test, a, { startMs: HOUR_MS, endMs: 2 * HOUR_MS }); // expiresAt = endAt
        advance(test, 2 * HOUR_MS + 6 * DAY_MS); // expired 6 days ago: inside the grace week
        addSlot(test, a);
        expect(slot(test, old)).toBeDefined();

        advance(test, DAY_MS + 60_000); // expired 7 days + 1 minute ago
        addSlot(test, a);
        expect(slot(test, old)).toBeUndefined();
        expect(slotsOf(test, a)).toHaveLength(2);
    });

    it('recurring expiry at +180 d (flow 6) then the 1-week grace (D-27): the default-expiry recurring slot survives to +186 d and is gone at +188 d', () => {
        const { test, users: [a] } = world(1);
        const rec = addSlot(test, a, { isRecurring: true, recurrenceType: 'Weekly', interval: 1, dayOfWeek: 1 });
        advance(test, SIX_MONTHS_MS + 6 * DAY_MS);
        addSlot(test, a);
        expect(slot(test, rec)).toBeDefined();

        advance(test, 2 * DAY_MS);
        addSlot(test, a);
        expect(slot(test, rec)).toBeUndefined();
    });
});

// ─── Saved calendars ─────────────────────────────────────────────────────────

describe('saved calendars', () => {
    it('scenario "Save and Unsave Calendar": save creates the bookmark with isVisible = true; unsave deletes it (D-15)', () => {
        const { test, users: [a, b] } = world(2);
        tx(test, a, (ctx) => M.save_calendar(ctx, { targetUserId: b.userId }));
        expect(savedOf(test, a)).toEqual([expect.objectContaining({ userId: a.userId, targetUserId: b.userId, isVisible: true })]);
        tx(test, a, (ctx) => M.unsave_calendar(ctx, { targetUserId: b.userId }));
        expect(savedOf(test, a)).toEqual([]);
    });

    it('scenario "Toggle Calendar Visibility": false then true; the bookmark persists (D-16)', () => {
        const { test, users: [a, b] } = world(2);
        tx(test, a, (ctx) => M.save_calendar(ctx, { targetUserId: b.userId }));
        tx(test, a, (ctx) => M.toggle_calendar_visibility(ctx, { targetUserId: b.userId, isVisible: false }));
        expect(savedOf(test, a).map((s) => s.isVisible)).toEqual([false]);
        tx(test, a, (ctx) => M.toggle_calendar_visibility(ctx, { targetUserId: b.userId, isVisible: true }));
        expect(savedOf(test, a).map((s) => s.isVisible)).toEqual([true]);
    });

    it('scenario "Cannot Save Own Calendar": "Cannot save your own calendar."', () => {
        const { test, users: [a] } = world(1);
        const msg = rejection(test, a, (ctx) => M.save_calendar(ctx, { targetUserId: a.userId }));
        expect(savedOf(test, a)).toEqual([]);
        expect(msg).toContain('Cannot save your own calendar.');
    });

    it('save_calendar error "Already saved": "Calendar already saved." (text per A76)', () => {
        const { test, users: [a, b] } = world(2);
        tx(test, a, (ctx) => M.save_calendar(ctx, { targetUserId: b.userId }));
        const msg = rejection(test, a, (ctx) => M.save_calendar(ctx, { targetUserId: b.userId }));
        expect(savedOf(test, a)).toHaveLength(1);
        expect(msg).toBe('Already saved.');
    });

    it('scenario "Saved Calendar Cap Enforcement": the 6th save is rejected with "Maximum of 5 saved calendars reached." (text per A76)', () => {
        const { test, users } = world(7);
        const [a, ...others] = users;
        for (const t of others.slice(0, 5)) tx(test, a, (ctx) => M.save_calendar(ctx, { targetUserId: t.userId }));
        const msg = rejection(test, a, (ctx) => M.save_calendar(ctx, { targetUserId: others[5].userId }));
        expect(savedOf(test, a)).toHaveLength(5);
        expect(msg).toBe('Maximum 5 saved calendars per user.');
    });

    it('save_calendar error "Target user not found": "User #{id} not found." (text per A76)', () => {
        const { test, users: [a] } = world(1);
        const msg = rejection(test, a, (ctx) => M.save_calendar(ctx, { targetUserId: 9999 }));
        expect(msg).toBe('Target user not found.');
    });

    it('unsave_calendar / toggle_calendar_visibility error "Not saved": "Calendar not saved."', () => {
        const { test, users: [a, b] } = world(2);
        expect(rejection(test, a, (ctx) => M.unsave_calendar(ctx, { targetUserId: b.userId }))).toContain('Calendar not saved.');
        expect(rejection(test, a, (ctx) => M.toggle_calendar_visibility(ctx, { targetUserId: b.userId, isVisible: false }))).toContain('Calendar not saved.');
    });

    it('save_calendar error "Guest caller": "Guests cannot save calendars."', () => {
        const { test, users: [b] } = world(1);
        const g = guest(test, 'calguest');
        const msg = rejection(test, g, (ctx) => M.save_calendar(ctx, { targetUserId: b.userId }));
        expect(msg).toContain('Guests cannot save calendars.');
    });
});

// ─── Events ──────────────────────────────────────────────────────────────────

describe('calendar events (create / invites / RSVP)', () => {
    it('scenario "Create Personal Calendar Event": 2 invitees → 2 Pending invite rows (D-25)', () => {
        const { test, users: [a, b, c] } = world(3);
        const id = createEvent(test, a, { title: 'Scrim', description: 'notes', invitees: [b, c] });
        const row = event(test, id)!;
        expect(row.organizerId).toBe(a.userId);
        expect(row.title).toBe('Scrim');
        expect(row.description).toBe('notes');
        expect(row.bracketMatchId).toBeUndefined();
        const invites = invitesOf(test, id);
        expect(invites.map((i) => i.inviteeUserId).sort((x, y) => x - y)).toEqual([b.userId, c.userId].sort((x, y) => x - y));
        expect(invites.every((i) => i.inviteStatus.tag === 'Pending' && i.respondedAt === undefined)).toBe(true);
    });

    it('edge case "Event with 0 invitees": allowed (blocked / personal time)', () => {
        const { test, users: [a] } = world(1);
        const id = createEvent(test, a);
        expect(event(test, id)).toBeDefined();
        expect(invitesOf(test, id)).toEqual([]);
    });

    it('create_calendar_event errors: "Guests cannot create calendar events.", "Event title must not be empty.", "Start time must be before end time."', () => {
        const { test, users: [a] } = world(1);
        const g = guest(test, 'calguest');
        expect(rejection(test, g, (ctx) => M.create_calendar_event(ctx, eventArgs(test)))).toContain('Guests cannot create calendar events.');
        expect(rejection(test, a, (ctx) => M.create_calendar_event(ctx, eventArgs(test, { title: '   ' })))).toContain('Event title must not be empty.');
        expect(rejection(test, a, (ctx) => M.create_calendar_event(ctx, eventArgs(test, { startMs: DAY_MS, endMs: DAY_MS }))))
            .toContain('Start time must be before end time.');
        expect(eventsOf(test, a)).toEqual([]);
    });

    it('create_calendar_event error "Invitee not found": "User #{id} not found." (text per A76)', () => {
        const { test, users: [a] } = world(1);
        const msg = rejection(test, a, (ctx) => M.create_calendar_event(ctx, eventArgs(test, { invitees: [9999] })));
        expect(eventsOf(test, a)).toEqual([]);
        expect(msg).toBe('User 9999 not found.');
    });

    it('invite_to_event adds a Pending invite; re-inviting is rejected with "User #{id} is already invited." (text per A76)', () => {
        const { test, users: [a, b] } = world(2);
        const id = createEvent(test, a);
        tx(test, a, (ctx) => M.invite_to_event(ctx, { eventId: id, inviteeUserId: b.userId }));
        expect(invite(test, id, b.userId)?.inviteStatus.tag).toBe('Pending');
        const msg = rejection(test, a, (ctx) => M.invite_to_event(ctx, { eventId: id, inviteeUserId: b.userId }));
        expect(invitesOf(test, id)).toHaveLength(1);
        expect(msg).toBe('User is already invited to this event.');
    });

    it('scenario "Invite Cap Enforcement": 9 invitees fit, the 10th is rejected with "Maximum of 9 invitees per event." (D-04) (text per A76)', () => {
        const { test, users } = world(11);
        const [a, ...others] = users;
        const id = createEvent(test, a, { invitees: others.slice(0, 8) });
        tx(test, a, (ctx) => M.invite_to_event(ctx, { eventId: id, inviteeUserId: others[8].userId }));
        expect(invitesOf(test, id)).toHaveLength(9);
        const msg = rejection(test, a, (ctx) => M.invite_to_event(ctx, { eventId: id, inviteeUserId: others[9].userId }));
        expect(invitesOf(test, id)).toHaveLength(9);
        expect(msg).toBe('Maximum 9 invitees per event.');
    });

    it('create_calendar_event error "Too many invitees (> 9)": "Maximum of 9 invitees per event." (text per A76)', () => {
        const { test, users } = world(11);
        const [a, ...others] = users;
        const msg = rejection(test, a, (ctx) => M.create_calendar_event(ctx, eventArgs(test, { invitees: others })));
        expect(eventsOf(test, a)).toEqual([]);
        expect(msg).toBe('Maximum 9 invitees per event.');
    });

    it('remove_invite deletes the row; a missing invite is rejected with "Invite not found for user #{id} on event #{eventId}." (text per A76)', () => {
        const { test, users: [a, b, c] } = world(3);
        const id = createEvent(test, a, { invitees: [b] });
        tx(test, a, (ctx) => M.remove_invite(ctx, { eventId: id, inviteeUserId: b.userId }));
        expect(invite(test, id, b.userId)).toBeUndefined();
        const msg = rejection(test, a, (ctx) => M.remove_invite(ctx, { eventId: id, inviteeUserId: c.userId }));
        expect(msg).toBe('Invite not found.');
    });

    it('invite_to_event / remove_invite by a non-organizer non-Admin: "Only the event organizer or an admin can invite to this event." / "... can remove invites." (text per A76)', () => {
        const { test, users: [a, b, c] } = world(3);
        const id = createEvent(test, a, { invitees: [b] });
        const inv = rejection(test, b, (ctx) => M.invite_to_event(ctx, { eventId: id, inviteeUserId: c.userId }));
        const rem = rejection(test, b, (ctx) => M.remove_invite(ctx, { eventId: id, inviteeUserId: b.userId }));
        expect(invitesOf(test, id).map((i) => i.inviteeUserId)).toEqual([b.userId]);
        expect(inv).toBe('Forbidden: Only the organizer or an Admin can invite users to this event.');
        expect(rem).toBe('Forbidden: Only the organizer or an Admin can remove invites from this event.');
    });

    it('scenarios "Respond to Invite" + "Change Invite Response": Accepted sets respondedAt; Declined updates status and respondedAt (D-01, D-02)', () => {
        const { test, users: [a, b] } = world(2);
        const id = createEvent(test, a, { invitees: [b] });
        tx(test, b, (ctx) => M.respond_to_invite(ctx, { eventId: id, status: 'Accepted' }));
        const first = invite(test, id, b.userId)!;
        expect(first.inviteStatus.tag).toBe('Accepted');
        expect(first.respondedAt?.microsSinceUnixEpoch).toBe(test.clock.now().microsSinceUnixEpoch);

        advance(test, HOUR_MS);
        tx(test, b, (ctx) => M.respond_to_invite(ctx, { eventId: id, status: 'Declined' }));
        const second = invite(test, id, b.userId)!;
        expect(second.inviteStatus.tag).toBe('Declined');
        expect(second.respondedAt!.microsSinceUnixEpoch).toBe(first.respondedAt!.microsSinceUnixEpoch + micros(HOUR_MS));
        expect(invitesOf(test, id)).toHaveLength(1);
    });

    it('respond_to_invite errors: "Cannot respond with Pending status." and "You have no invite for event #{id}." (text per A76)', () => {
        const { test, users: [a, b, c] } = world(3);
        const id = createEvent(test, a, { invitees: [b] });
        const pending = rejection(test, b, (ctx) => M.respond_to_invite(ctx, { eventId: id, status: 'Pending' }));
        expect(invite(test, id, b.userId)!.respondedAt).toBeUndefined();
        expect(pending).toContain('Cannot respond with Pending status.');
        expect(rejection(test, c, (ctx) => M.respond_to_invite(ctx, { eventId: id, status: 'Accepted' }))).toBe('You have no invite for this event.');
    });
});

describe('calendar events (organizer rules, caps, cleanup)', () => {
    it('scenario "Organizer Edits Event": title and times change, invites unaffected; an Admin may edit too (D-08)', () => {
        const { test, users: [a, b] } = world(2);
        const id = createEvent(test, a, { invitees: [b] });
        const args = { eventId: id, title: 'Renamed', description: 'new', startAt: fromNow(test, 2 * DAY_MS), endAt: fromNow(test, 2 * DAY_MS + HOUR_MS) };
        tx(test, a, (ctx) => M.update_calendar_event(ctx, args));
        const row = event(test, id)!;
        expect([row.title, row.description]).toEqual(['Renamed', 'new']);
        expect(row.startAt.microsSinceUnixEpoch).toBe(BigInt(args.startAt));
        expect(row.endAt.microsSinceUnixEpoch).toBe(BigInt(args.endAt));
        expect(invitesOf(test, id).map((i) => i.inviteeUserId)).toEqual([b.userId]);

        tx(test, admin(test), (ctx) => M.update_calendar_event(ctx, { ...args, title: 'By admin' }));
        expect(event(test, id)!.title).toBe('By admin');
    });

    it('scenario "Non-Organizer Cannot Edit Event": "Only the event organizer or an admin can edit this event." (text per A76)', () => {
        const { test, users: [a, b] } = world(2);
        const id = createEvent(test, a, { title: 'Mine', invitees: [b] });
        const msg = rejection(test, b, (ctx) => M.update_calendar_event(ctx, {
            eventId: id, title: 'Hijack', description: '', startAt: fromNow(test, DAY_MS), endAt: fromNow(test, DAY_MS + HOUR_MS),
        }));
        expect(event(test, id)!.title).toBe('Mine');
        expect(msg).toBe('Forbidden: Only the organizer or an Admin can update this event.');
    });

    it('scenario "Delete Event Cascades Invites": 5 invites and the event are deleted; an Admin may delete (D-03, D-08)', () => {
        const { test, users } = world(7);
        const [a, ...others] = users;
        const id = createEvent(test, a, { invitees: others.slice(0, 5) });
        expect(invitesOf(test, id)).toHaveLength(5);
        tx(test, a, (ctx) => M.delete_calendar_event(ctx, { eventId: id }));
        expect(event(test, id)).toBeUndefined();
        expect(invitesOf(test, id)).toEqual([]);

        const other = createEvent(test, others[5], { invitees: [a] });
        tx(test, admin(test), (ctx) => M.delete_calendar_event(ctx, { eventId: other }));
        expect(event(test, other)).toBeUndefined();
        expect(invitesOf(test, other)).toEqual([]);
    });

    it('delete_calendar_event error "Not organizer and not Admin": "Only the event organizer or an admin can delete this event." (text per A76)', () => {
        const { test, users: [a, b] } = world(2);
        const id = createEvent(test, a, { invitees: [b] });
        const msg = rejection(test, b, (ctx) => M.delete_calendar_event(ctx, { eventId: id }));
        expect(event(test, id)).toBeDefined();
        expect(invitesOf(test, id)).toHaveLength(1);
        expect(msg).toBe('Forbidden: Only the organizer or an Admin can delete this event.');
    });

    it('update / delete / invite_to_event error "Event not found": "Calendar event #{id} not found." (text per A76)', () => {
        const { test, users: [a, b] } = world(2);
        const upd = rejection(test, a, (ctx) => M.update_calendar_event(ctx, {
            eventId: 9999, title: 'x', description: '', startAt: fromNow(test, DAY_MS), endAt: fromNow(test, DAY_MS + HOUR_MS),
        }));
        const del = rejection(test, a, (ctx) => M.delete_calendar_event(ctx, { eventId: 9999 }));
        const inv = rejection(test, a, (ctx) => M.invite_to_event(ctx, { eventId: 9999, inviteeUserId: b.userId }));
        for (const msg of [upd, del, inv]) expect(msg).toBe('Calendar event not found.');
    });

    it('scenario "Event Cap Enforcement": the 41st active event is rejected with "Maximum of 40 active calendar events reached." (D-06) (text per A79)', () => {
        const { test, users: [a] } = world(1);
        for (let i = 0; i < 40; i++) createEvent(test, a, { title: `E${i}`, startMs: (i + 1) * HOUR_MS * 3 });
        const msg = rejection(test, a, (ctx) => M.create_calendar_event(ctx, eventArgs(test, { title: 'E40' })));
        expect(eventsOf(test, a)).toHaveLength(40);
        expect(msg).toBe('Maximum 40 active calendar events per user.');
    });

    it('scenario "Lazy Cleanup of Old Events": an event that ended more than 90 days ago is deleted with its invites on the next create (D-07)', () => {
        const { test, users: [a, b] } = world(2);
        const old = createEvent(test, a, { title: 'Old', startMs: HOUR_MS, endMs: 2 * HOUR_MS, invitees: [b] });
        advance(test, 2 * HOUR_MS + 89 * DAY_MS);
        createEvent(test, a, { title: 'Recent' });
        expect(event(test, old)).toBeDefined();

        advance(test, DAY_MS + 60_000);
        createEvent(test, a, { title: 'Newer' });
        expect(event(test, old)).toBeUndefined();
        expect(invitesOf(test, old)).toEqual([]);
        expect(eventsOf(test, a).map((e) => e.title).sort()).toEqual(['Newer', 'Recent']);
    });
});

describe('tournament-linked events', () => {
    function linked() {
        const f = duel();
        const m = [...f.test.db.BracketMatch.tournament_id.filter(f.id)].find((r) => r.team1Id !== undefined && r.team2Id !== undefined)!;
        const players = f.ts.flatMap((t) => [t.captain, t.mate]);
        return { ...f, m, players };
    }

    it('scenario "Create Tournament-Linked Event with Auto-Invite": the organizer links the match; its 4 players get Pending invites (D-17, D-18)', () => {
        const { test, org, m, players } = linked();
        const id = createEvent(test, org, { title: 'Round 1', bracketMatchId: m.id });
        expect(event(test, id)!.bracketMatchId).toBe(m.id);
        const invites = invitesOf(test, id);
        expect(invites.map((i) => i.inviteeUserId).sort((x, y) => x - y)).toEqual(players.map((p) => p.userId).sort((x, y) => x - y));
        expect(invites.every((i) => i.inviteStatus.tag === 'Pending')).toBe(true);
    });

    it('scenario "One Event Per Bracket Match": "A calendar event already exists for this bracket match." (D-19)', () => {
        const { test, org, m } = linked();
        createEvent(test, org, { title: 'Round 1', bracketMatchId: m.id });
        const msg = rejection(test, org, (ctx) => M.create_calendar_event(ctx, eventArgs(test, { title: 'Again', bracketMatchId: m.id })));
        expect([...test.db.CalendarEvent.bracket_match_id.filter(m.id)]).toHaveLength(1);
        expect(msg).toContain('A calendar event already exists for this bracket match.');
    });

    it('scenario "Non-TO Cannot Create Tournament Event": "Forbidden: Requires Tournament Host, Admin, Moderator, or Assistant privileges for this tournament." (D-20) (text per A76)', () => {
        const { test, m } = linked();
        const stranger = verified(test, 'calstranger');
        const msg = rejection(test, stranger, (ctx) => M.create_calendar_event(ctx, eventArgs(test, { bracketMatchId: m.id })));
        expect(eventsOf(test, stranger)).toEqual([]);
        expect(msg).toBe('This action needs the bracket permission.');
    });

    it('create_calendar_event error "bracketMatchId not found": "Bracket match #{id} not found." (text per A76)', () => {
        const { test, org } = linked();
        const msg = rejection(test, org, (ctx) => M.create_calendar_event(ctx, eventArgs(test, { bracketMatchId: 9999 })));
        expect(msg).toBe('Bracket match not found.');
    });
});

describe('user deletion cascade (UserDeletionJob extend, D-23)', () => {
    it('scenario "User Deletion Cascades Calendar Data": slots, bookmarks both ways, organized events with their invites and received invites go; other rows stay', () => {
        const { test, users: [a, b, c] } = world(3);
        addSlot(test, a);
        addSlot(test, a, { startMs: 2 * DAY_MS });
        const bSlot = addSlot(test, b);
        tx(test, a, (ctx) => M.save_calendar(ctx, { targetUserId: b.userId }));
        tx(test, a, (ctx) => M.save_calendar(ctx, { targetUserId: c.userId }));
        tx(test, b, (ctx) => M.save_calendar(ctx, { targetUserId: a.userId }));
        tx(test, b, (ctx) => M.save_calendar(ctx, { targetUserId: c.userId }));
        const aEvent = createEvent(test, a, { title: 'A event', invitees: [b, c] });
        const bEvent = createEvent(test, b, { title: 'B event', invitees: [a, c] });

        const username = test.db.User.id.find(a.userId)!.username;
        tx(test, 'internal', (ctx) => M.server_delete_user(ctx, { username }));

        expect(slotsOf(test, a)).toEqual([]);
        expect(slot(test, bSlot)).toBeDefined();
        const saved = [...test.db.SavedCalendar.iter()];
        expect(saved.filter((s) => s.userId === a.userId || s.targetUserId === a.userId)).toEqual([]);
        expect(saved.map((s) => [s.userId, s.targetUserId])).toEqual([[b.userId, c.userId]]);
        expect(event(test, aEvent)).toBeUndefined();
        expect(invitesOf(test, aEvent)).toEqual([]);
        expect(event(test, bEvent)).toBeDefined();
        expect(invitesOf(test, bEvent).map((i) => i.inviteeUserId)).toEqual([c.userId]);
    });
});
