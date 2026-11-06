/**
 * Integration tests for calendar event, invite, and cascade reducers.
 *
 * Tests event CRUD, invite management, invite response, permission guards,
 * invite cap enforcement, delete cascade, and user deletion cascade.
 *
 * Requires: SPACETIMEDB_SERVER_TOKEN in .env.local (post-publish bootstrap)
 *
 * Contract: docs/calendar/contract.md — Calendar Event + Invite scenarios
 * UAT: .planning/phases/08-calendar-and-scheduling/08-UAT.md — Tests 9-15, 17
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
    createTestHarness,
    createVerifiedTestHarness,
    expectReducerError,
    type TestHarness,
} from '../../shared/connection';
import { DbConnection } from '../../../src/module_bindings';
import { promoteUser } from '../../shared/helpers/promoteUser';

const DB = process.env.SPACETIMEDB_DB ?? 'hsrpvp-spacetimedb-nextjs-test1';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Generate BigInt micros timestamp string offset from now */
function tsStr(offsetMs: number): string {
    return (BigInt(Date.now() + offsetMs) * 1000n).toString();
}

/** Default event args */
function eventArgs(overrides: Record<string, unknown> = {}) {
    return {
        title: `Test Event ${Math.random().toString(36).slice(2, 6)}`,
        description: '',
        startAt: tsStr(3600_000),
        endAt: tsStr(7200_000),
        bracketMatchId: 0,
        inviteeUserIds: '',
        ...overrides,
    };
}

/** Get this user's organized events from subscription cache */
function myEvents(h: TestHarness) {
    return [...h.conn.db.CalendarEvent.iter()].filter(e => e.organizerId === h.userId);
}

/** Get invites for a specific event */
function eventInvites(h: TestHarness, eventId: number) {
    return [...h.conn.db.CalendarEventInvite.iter()].filter(i => i.eventId === eventId);
}

/** Get this user's received invites */
function myInvites(h: TestHarness) {
    return [...h.conn.db.CalendarEventInvite.iter()].filter(i => i.inviteeUserId === h.userId);
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Calendar Events & Invites', () => {
    let organizer: TestHarness;
    let inviteeA: TestHarness;
    let inviteeB: TestHarness;
    let bystander: TestHarness;
    let guest: TestHarness;

    // Track event IDs for use across tests
    let mainEventId: number;
    const createdCalendarEventIds: number[] = [];

    beforeAll(async () => {
        organizer = await createVerifiedTestHarness();
        inviteeA = await createVerifiedTestHarness();
        inviteeB = await createVerifiedTestHarness();
        bystander = await createVerifiedTestHarness();
        guest = await createTestHarness();

        await organizer.sync();
        await inviteeA.sync();
        await inviteeB.sync();
        await bystander.sync();
        await guest.sync();
    }, 30000);

    afterAll(async () => {
        // D-03: strict cleanup per resource opened
        for (const id of createdCalendarEventIds) {
            try {
                await organizer.call.deleteCalendarEvent({ eventId: id });
                await organizer.sync(300);
            } catch (_) { /* already deleted */ }
        }
        await organizer?.disconnect();
        await inviteeA?.disconnect();
        await inviteeB?.disconnect();
        await bystander?.disconnect();
        await guest?.disconnect();
    });

    // ─── Create Event ───────────────────────────────────────────────────

    it('creates a personal event with 2 invitees', async () => {
        const ids = `${inviteeA.userId},${inviteeB.userId}`;
        await organizer.call.createCalendarEvent(eventArgs({
            title: 'Team Practice',
            description: 'Weekly practice session',
            inviteeUserIds: ids,
        }));
        await organizer.sync(1500);

        const events = myEvents(organizer);
        expect(events.length).toBeGreaterThanOrEqual(1);

        const event = events[events.length - 1];
        expect(event.title).toBe('Team Practice');
        mainEventId = event.id;
        createdCalendarEventIds.push(mainEventId);

        // Check invites created with Pending status
        const invites = eventInvites(organizer, mainEventId);
        expect(invites.length).toBe(2);
        const inviteeIds = invites.map(i => i.inviteeUserId).sort();
        expect(inviteeIds).toEqual([inviteeA.userId, inviteeB.userId].sort());
        for (const inv of invites) {
            expect(inv.inviteStatus.tag).toBe('Pending');
        }
    });

    it('creates an event with 0 invitees (personal/blocked time)', async () => {
        await organizer.call.createCalendarEvent(eventArgs({
            title: 'Personal Time',
        }));
        await organizer.sync(1500);

        const events = myEvents(organizer);
        const event = events.find(e => e.title === 'Personal Time');
        expect(event).toBeDefined();
        createdCalendarEventIds.push(event!.id);

        const invites = eventInvites(organizer, event!.id);
        expect(invites.length).toBe(0);
    });

    it('rejects empty title', async () => {
        const err = await expectReducerError(
            organizer.call.createCalendarEvent(eventArgs({ title: '' }))
        );
        expect(err).toContain('Event title must not be empty');
    });

    it('rejects guest creating event', async () => {
        const err = await expectReducerError(
            guest.call.createCalendarEvent(eventArgs())
        );
        expect(err).toContain('Guests cannot create calendar events');
    });

    // ─── Invite Management ──────────────────────────────────────────────

    it('adds an invite to an existing event', async () => {
        // Create a fresh event with no invites
        await organizer.call.createCalendarEvent(eventArgs({ title: 'Invite Test' }));
        await organizer.sync(1500);
        const event = myEvents(organizer).find(e => e.title === 'Invite Test')!;
        createdCalendarEventIds.push(event.id);

        await organizer.call.inviteToEvent({
            eventId: event.id,
            inviteeUserId: inviteeA.userId,
        });
        await organizer.sync();

        const invites = eventInvites(organizer, event.id);
        expect(invites.length).toBe(1);
        expect(invites[0].inviteeUserId).toBe(inviteeA.userId);
        expect(invites[0].inviteStatus.tag).toBe('Pending');
    });

    it('rejects duplicate invite', async () => {
        const event = myEvents(organizer).find(e => e.title === 'Invite Test')!;

        const err = await expectReducerError(
            organizer.call.inviteToEvent({
                eventId: event.id,
                inviteeUserId: inviteeA.userId,
            })
        );
        expect(err).toContain('already invited');
    });

    it('removes an invite', async () => {
        const event = myEvents(organizer).find(e => e.title === 'Invite Test')!;

        await organizer.call.removeInvite({
            eventId: event.id,
            inviteeUserId: inviteeA.userId,
        });
        await organizer.sync();

        const invites = eventInvites(organizer, event.id);
        expect(invites.length).toBe(0);
    });

    // ─── Invite Cap (9) ─────────────────────────────────────────────────

    it('enforces 9-invitee cap', async () => {
        // Create event, add 9 invitees via CSV in create call
        // We need 9 unique user IDs — use existing + create extras
        const extraUsers: TestHarness[] = [];
        for (let i = 0; i < 7; i++) {
            extraUsers.push(await createVerifiedTestHarness());
        }
        for (const u of extraUsers) await u.sync();

        const allInviteeIds = [
            inviteeA.userId,
            inviteeB.userId,
            ...extraUsers.map(u => u.userId),
        ].slice(0, 9);

        await organizer.call.createCalendarEvent(eventArgs({
            title: 'Cap Test',
            inviteeUserIds: allInviteeIds.join(','),
        }));
        await organizer.sync(1500);
        const event = myEvents(organizer).find(e => e.title === 'Cap Test')!;
        createdCalendarEventIds.push(event.id);
        expect(eventInvites(organizer, event.id).length).toBe(9);

        // 10th invite via invite_to_event should fail
        const oneMore = await createVerifiedTestHarness();
        await oneMore.sync();
        const err = await expectReducerError(
            organizer.call.inviteToEvent({
                eventId: event.id,
                inviteeUserId: oneMore.userId,
            })
        );
        expect(err).toContain('Maximum 9 invitees per event');

        // Cleanup
        for (const u of extraUsers) await u.disconnect();
        await oneMore.disconnect();
    }, 60000);

    // ─── Invite Response ────────────────────────────────────────────────

    it('invitee accepts invite — status and respondedAt updated', async () => {
        await inviteeA.sync(1000);

        await inviteeA.call.respondToInvite({
            eventId: mainEventId,
            status: 'Accepted',
        });
        await inviteeA.sync();

        const invite = myInvites(inviteeA).find(i => i.eventId === mainEventId);
        expect(invite).toBeDefined();
        expect(invite!.inviteStatus.tag).toBe('Accepted');
        expect(invite!.respondedAt).toBeDefined();
    });

    it('invitee changes response from Accepted to Declined', async () => {
        await inviteeA.call.respondToInvite({
            eventId: mainEventId,
            status: 'Declined',
        });
        await inviteeA.sync();

        const invite = myInvites(inviteeA).find(i => i.eventId === mainEventId);
        expect(invite!.inviteStatus.tag).toBe('Declined');
    });

    it('rejects responding with Pending', async () => {
        const err = await expectReducerError(
            inviteeB.call.respondToInvite({
                eventId: mainEventId,
                status: 'Pending',
            })
        );
        expect(err).toContain('Cannot respond with Pending status');
    });

    // ─── Update Event ───────────────────────────────────────────────────

    it('organizer updates event title and times', async () => {
        await organizer.call.updateCalendarEvent({
            eventId: mainEventId,
            title: 'Updated Practice',
            description: 'Rescheduled',
            startAt: tsStr(10800_000),
            endAt: tsStr(14400_000),
        });
        await organizer.sync();

        const event = myEvents(organizer).find(e => e.id === mainEventId);
        expect(event!.title).toBe('Updated Practice');

        // Invites should be unaffected
        const invites = eventInvites(organizer, mainEventId);
        expect(invites.length).toBe(2);
    });

    it('non-organizer cannot update event', async () => {
        const err = await expectReducerError(
            bystander.call.updateCalendarEvent({
                eventId: mainEventId,
                title: 'Hijacked',
                description: '',
                startAt: tsStr(3600_000),
                endAt: tsStr(7200_000),
            })
        );
        expect(err).toContain('Only the organizer or an Admin can update this event');
    });

    // ─── Delete Event (Cascade) ─────────────────────────────────────────

    it('delete event cascades all invites', async () => {
        // Create a fresh event with invitees to cleanly test cascade
        await organizer.call.createCalendarEvent(eventArgs({
            title: 'Cascade Delete Test',
            inviteeUserIds: `${inviteeA.userId},${inviteeB.userId}`,
        }));
        await organizer.sync(1500);

        const event = myEvents(organizer).find(e => e.title === 'Cascade Delete Test')!;
        createdCalendarEventIds.push(event.id);
        expect(eventInvites(organizer, event.id).length).toBe(2);

        await organizer.call.deleteCalendarEvent({ eventId: event.id });
        await organizer.sync();

        // Event gone
        expect(myEvents(organizer).find(e => e.id === event.id)).toBeUndefined();
        // Invites gone
        expect(eventInvites(organizer, event.id).length).toBe(0);
    });

    it('non-organizer cannot delete event', async () => {
        const err = await expectReducerError(
            bystander.call.deleteCalendarEvent({ eventId: mainEventId })
        );
        expect(err).toContain('Only the organizer or an Admin can delete this event');
    });

    // ─── User Deletion Cascade ──────────────────────────────────────────

    it('user deletion cascades all calendar data', async () => {
        // Create a disposable user with calendar data across all tables
        const victim = await createVerifiedTestHarness();
        const target = await createVerifiedTestHarness();
        await victim.sync();
        await target.sync();

        // 1. Create an availability slot
        await victim.call.createAvailabilitySlot({
            startAt: tsStr(3600_000),
            endAt: tsStr(7200_000),
            isRecurring: false,
            recurrenceType: '',
            interval: 0,
            dayOfWeek: 255,
            dayOfMonth: 0,
            endDate: '',
        });

        // 2. Save another user's calendar
        await victim.call.saveCalendar({ targetUserId: target.userId });

        // 3. Create an event with an invite
        await victim.call.createCalendarEvent(eventArgs({
            title: 'Victim Event',
            inviteeUserIds: `${target.userId}`,
        }));

        await victim.sync(1500);

        // Verify data exists
        const slots = [...victim.conn.db.AvailabilitySlot.iter()].filter(s => s.userId === victim.userId);
        const saved = [...victim.conn.db.SavedCalendar.iter()].filter(s => s.userId === victim.userId);
        const events = [...victim.conn.db.CalendarEvent.iter()].filter(e => e.organizerId === victim.userId);
        expect(slots.length).toBeGreaterThanOrEqual(1);
        expect(saved.length).toBeGreaterThanOrEqual(1);
        expect(events.length).toBeGreaterThanOrEqual(1);

        // Promote an admin to delete the user
        const admin = await createVerifiedTestHarness();
        await admin.sync();
        const adminUser = [...admin.conn.db.User.iter()].find(u => u.id === admin.userId)!;
        await promoteUser(adminUser.username, 'Admin');
        await admin.sync(1500);

        // Delete the victim user — serverDeleteUser takes username, uses server token
        const victimUser = [...admin.conn.db.User.iter()].find(u => u.id === victim.userId);
        expect(victimUser).toBeDefined();

        // Need server-token connection to call serverDeleteUser
        const host = process.env.SPACETIMEDB_URI ?? 'wss://maincloud.spacetimedb.com';
        const token = process.env.SPACETIMEDB_SERVER_TOKEN!;
        await new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Delete timeout')), 10000);
            DbConnection.builder()
                .withUri(host)
                .withDatabaseName(DB)
                .withToken(token)
                .withConfirmedReads(false)
                .onConnect((conn) => {
                    conn.reducers.serverDeleteUser({ username: victimUser!.username });
                    setTimeout(() => { clearTimeout(timeout); resolve(); }, 2000);
                })
                .onConnectError((_ctx, err) => { clearTimeout(timeout); reject(err); })
                .build();
        });
        await admin.sync(2000);

        // Verify all calendar data is gone
        const slotsAfter = [...admin.conn.db.AvailabilitySlot.iter()].filter(s => s.userId === victim.userId);
        const savedAfter = [...admin.conn.db.SavedCalendar.iter()].filter(s => s.userId === victim.userId);
        const eventsAfter = [...admin.conn.db.CalendarEvent.iter()].filter(e => e.organizerId === victim.userId);
        const invitesAfter = [...admin.conn.db.CalendarEventInvite.iter()].filter(i => i.inviteeUserId === victim.userId);

        expect(slotsAfter.length).toBe(0);
        expect(savedAfter.length).toBe(0);
        expect(eventsAfter.length).toBe(0);
        expect(invitesAfter.length).toBe(0);

        await admin.disconnect();
        await target.disconnect();
        // victim already deleted, connection likely dead
        try { await victim.disconnect(); } catch { /* expected */ }
    }, 45000);
});
