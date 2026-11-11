// Views: the calendar views.
// Contracts: docs/views/contract.md
// From S9b (s9b-views.test.ts).
import { describe, expect, it } from 'vitest';
import type {
    MyAvailabilityRow,
    MyCalendarEventRow,
    MyCalendarInviteRow,
    MySavedCalendarRow,
    SavedCalendarAvailabilityRow,
} from '@bindings/types';
import { M, tx, type Actor, type Harness } from '../fixtures/harness';
import { verified, displayName } from '../fixtures/identity';
import { addSlotAt, createTitledEvent, saveCalendar } from '../fixtures/calendar';
import { AUDIT_KEYS, keysOf, sorted, view, type Reader } from '../fixtures/views';
import { duel } from '../fixtures/tournament-matches';

const noAudit = (row: object) => AUDIT_KEYS.filter((k) => k in row);
const showCalendar = (test: Harness, who: Actor, target: Actor, isVisible: boolean) =>
    tx(test, who, (ctx) => M.toggle_calendar_visibility(ctx, { targetUserId: target.userId, isVisible }));

// ════════════════════════════════════════════════════════════════════════════
// Calendar (S9b-C1..C4, S9b-V8; A37 calendar contexts, A45(4))
// ════════════════════════════════════════════════════════════════════════════

describe('calendar views (S9b-C1..C3, S9b-V8)', () => {
    /**
     * Carol organizes E1 inviting Dave and Gina; Dave organizes E2; the organizer created E3 for the bracket match of
     * Dave's team; Erin organizes E4, Frank E5; Dave saved Erin's calendar (shown) and Frank's (hidden). Slots: Dave 1,
     * Erin 2, Frank 1.
     */
    function world() {
        const f = duel();
        const { test, org } = f;
        const dave = f.ts[0].captain;
        const opponent = f.ts[1].captain;
        const [carol, erin, frank, gina, outsider] = ['carol', 'erin', 'frank', 'gina', 'calout'].map((n) => verified(test, n));
        test.db.User.id.update({ ...test.db.User.id.find(erin.userId)!, avatarCharacterName: 'Kafka' });
        const m = [...test.db.BracketMatch.tournament_id.filter(f.id)][0];
        const e1 = createTitledEvent(test, carol, 'E1', [dave, gina]);
        const e2 = createTitledEvent(test, dave, 'E2');
        const e3 = createTitledEvent(test, org, 'E3', [], m.id);
        const e4 = createTitledEvent(test, erin, 'E4');
        const e5 = createTitledEvent(test, frank, 'E5');
        saveCalendar(test, dave, erin);
        saveCalendar(test, dave, frank);
        showCalendar(test, dave, frank, false);
        addSlotAt(test, dave, 30);
        addSlotAt(test, erin, 30);
        addSlotAt(test, erin, 40);
        addSlotAt(test, frank, 30);
        const events = (who: Reader) => view<MyCalendarEventRow>(test, 'view_my_calendar_events', who);
        const invites = (who: Reader) => view<MyCalendarInviteRow>(test, 'view_my_calendar_invites', who);
        return { f, test, org, m, dave, opponent, carol, erin, frank, gina, outsider, e1, e2, e3, e4, e5, events, invites };
    }
    const key = (eventId: number, userId: number) => (BigInt(eventId) << 32n) | BigInt(userId);

    it('S9b-C1: Dave reads E1..E4 once each with the organizer\'s name, not E5; the documented columns; an outsider reads none', () => {
        const w = world();
        const rows = w.events(w.dave);
        expect(rows.map((r) => r.id).sort((a, b) => a - b)).toEqual([w.e1, w.e2, w.e3, w.e4].sort((a, b) => a - b));
        const organizerOf: Record<number, Actor> = { [w.e1]: w.carol, [w.e2]: w.dave, [w.e3]: w.org, [w.e4]: w.erin };
        for (const r of rows) {
            expect(keysOf(r)).toEqual(sorted('calEvent'));
            expect(r.organizerId).toBe(organizerOf[r.id].userId);
            expect(r.organizerLabel).toBe(displayName(w.test, organizerOf[r.id]));
        }
        expect(rows.find((r) => r.id === w.e3)!.bracketMatchId).toBe(w.m.id);
        expect(rows.find((r) => r.id === w.e1)!.description).toBe('E1 notes');
        expect(w.events(w.outsider)).toEqual([]);
    });

    it('S9b-C1: the tournament-linked event is visible to both teams\' members, and stays visible to Dave once his invite row is removed', () => {
        const w = world();
        expect(w.events(w.opponent).map((r) => r.id)).toContain(w.e3);
        expect(w.events(w.f.ts[0].mate).map((r) => r.id)).toContain(w.e3);
        tx(w.test, w.org, (ctx) => M.remove_invite(ctx, { eventId: w.e3, inviteeUserId: w.dave.userId }));
        expect([...w.test.db.CalendarEventInvite.by_event_and_invitee.filter([w.e3, w.dave.userId])]).toEqual([]);
        expect(w.events(w.dave).filter((r) => r.id === w.e3)).toHaveLength(1);
    });

    it('S9b-C3: showing Frank\'s calendar again sends his events and slots', () => {
        const w = world();
        showCalendar(w.test, w.dave, w.frank, true);
        expect(w.events(w.dave).map((r) => r.id)).toContain(w.e5);
        expect(view<SavedCalendarAvailabilityRow>(w.test, 'view_saved_calendar_availability', w.dave).some((r) => r.userId === w.frank.userId)).toBe(true);
    });

    it('S9b-C2: Dave reads his own invites with the inviter\'s name, never another invitee\'s; Carol reads every invite of E1; a response updates the row in place', () => {
        const w = world();
        const mine = w.invites(w.dave);
        for (const r of mine) expect(keysOf(r)).toEqual(sorted('calInvite'));
        expect(mine.every((r) => r.inviteeUserId === w.dave.userId)).toBe(true); // no other invitee id (Gina, the opponent team)
        const e1 = mine.find((r) => r.eventId === w.e1)!;
        expect(e1).toMatchObject({
            inviteKey: key(w.e1, w.dave.userId), inviteeLabel: displayName(w.test, w.dave), inviteStatus: { tag: 'Pending' },
            respondedAt: undefined, inviterLabel: displayName(w.test, w.carol),
        });
        expect(mine.find((r) => r.eventId === w.e3)!.inviterLabel).toBe(displayName(w.test, w.org));

        const carols = w.invites(w.carol).filter((r) => r.eventId === w.e1);
        expect(carols.map((r) => [r.inviteeUserId, r.inviteeLabel]).sort()).toEqual(
            [[w.dave.userId, displayName(w.test, w.dave)], [w.gina.userId, displayName(w.test, w.gina)]].sort());

        tx(w.test, w.dave, (ctx) => M.respond_to_invite(ctx, { eventId: w.e1, status: 'Accepted' }));
        const after = w.invites(w.dave).find((r) => r.eventId === w.e1)!;
        expect(after.inviteKey).toBe(key(w.e1, w.dave.userId));
        expect(after.inviteStatus.tag).toBe('Accepted');
        expect(after.respondedAt).toBeDefined();
        expect(w.invites(w.carol).find((r) => r.inviteKey === key(w.e1, w.dave.userId))!.inviteStatus.tag).toBe('Accepted');
        expect(w.invites(w.gina).map((r) => r.inviteeUserId)).toEqual([w.gina.userId]);
        expect(w.invites(w.outsider)).toEqual([]);
    });

    it('S9b-C3: own slots; Erin\'s slots with her id and name, none of Frank\'s (hidden); both bookmarks with label, avatar and isVisible', () => {
        const w = world();
        const own = view<MyAvailabilityRow>(w.test, 'view_my_availability', w.dave);
        expect(own).toHaveLength(1);
        expect(keysOf(own[0])).toEqual(sorted('availability'));
        expect(own[0].id).toBe([...w.test.db.AvailabilitySlot.user_id.filter(w.dave.userId)][0].id);

        const saved = view<SavedCalendarAvailabilityRow>(w.test, 'view_saved_calendar_availability', w.dave);
        expect(saved).toHaveLength(2);
        for (const r of saved) {
            expect(keysOf(r)).toEqual(sorted('savedAvailability'));
            expect(r).toMatchObject({ userId: w.erin.userId, userLabel: displayName(w.test, w.erin) });
        }

        const marks = view<MySavedCalendarRow>(w.test, 'view_my_saved_calendars', w.dave);
        for (const r of marks) expect(keysOf(r)).toEqual(sorted('savedCalendar'));
        expect(marks.sort((a, b) => a.targetUserId - b.targetUserId)).toEqual([
            { targetUserId: w.erin.userId, targetLabel: displayName(w.test, w.erin), targetAvatarCharacterName: 'Kafka', isVisible: true },
            { targetUserId: w.frank.userId, targetLabel: displayName(w.test, w.frank), targetAvatarCharacterName: test_avatar(w.test, w.frank), isVisible: false },
        ].sort((a, b) => a.targetUserId - b.targetUserId));
        // Erin did not save Dave: nothing flows the other way
        expect(view(w.test, 'view_saved_calendar_availability', w.erin)).toEqual([]);
    });

    it('no calendar row carries an audit column, and the only user ids are the ones the contract names (organizer, own invitee id / organizer\'s invitees, saved target)', () => {
        const w = world();
        const names = ['view_my_calendar_events', 'view_my_calendar_invites', 'view_my_availability', 'view_saved_calendar_availability', 'view_my_saved_calendars'];
        for (const name of names) {
            for (const r of view(w.test, name, w.dave)) expect(noAudit(r), name).toEqual([]);
        }
        const allowed = new Set([w.dave, w.carol, w.org, w.erin, w.frank].map((a) => a.userId));
        for (const r of w.events(w.dave)) expect(allowed.has(r.organizerId)).toBe(true);
        expect(w.invites(w.dave).map((r) => r.inviteeUserId).every((id) => id === w.dave.userId)).toBe(true);
    });
});

const test_avatar = (test: Harness, who: Actor) => test.db.User.id.find(who.userId)!.avatarCharacterName;
