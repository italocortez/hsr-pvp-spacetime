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
import { M, newHarness, tx, type Actor, type Harness } from '../fixtures/harness';
import { verified, displayName } from '../fixtures/identity';
import { addSlotAt, createTitledEvent, saveCalendar } from '../fixtures/calendar';
import { AUDIT_KEYS, keysOf, sorted, view, type Reader } from '../fixtures/views';
import { duel } from '../fixtures/tournament-matches';
import { assignAssistant } from '../fixtures/tournaments';

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

    it('S9b-C2 (re-aligned T-S10ac, A157(5)): Dave reads his own invites with the inviter\'s name, and the other invites only of the events he is invited to; Carol reads every invite of E1; a response updates the row in place', () => {
        const w = world();
        const mine = w.invites(w.dave);
        for (const r of mine) expect(keysOf(r)).toEqual(sorted('calInvite'));
        const daveEvents = new Set(mine.filter((r) => r.inviteeUserId === w.dave.userId).map((r) => r.eventId));
        expect(mine.every((r) => daveEvents.has(r.eventId))).toBe(true); // other invitees only of Dave's own events
        expect(mine.filter((r) => r.eventId === w.e1).map((r) => r.inviteeUserId).sort((a, b) => a - b))
            .toEqual([w.dave.userId, w.gina.userId].sort((a, b) => a - b));
        const e1 = mine.find((r) => r.eventId === w.e1 && r.inviteeUserId === w.dave.userId)!;
        expect(e1).toMatchObject({
            inviteKey: key(w.e1, w.dave.userId), inviteeLabel: displayName(w.test, w.dave), inviteStatus: { tag: 'Pending' },
            respondedAt: undefined, inviterLabel: displayName(w.test, w.carol),
        });
        expect(mine.find((r) => r.eventId === w.e3 && r.inviteeUserId === w.dave.userId)!.inviterLabel).toBe(displayName(w.test, w.org));

        const carols = w.invites(w.carol).filter((r) => r.eventId === w.e1);
        expect(carols.map((r) => [r.inviteeUserId, r.inviteeLabel]).sort()).toEqual(
            [[w.dave.userId, displayName(w.test, w.dave)], [w.gina.userId, displayName(w.test, w.gina)]].sort());

        tx(w.test, w.dave, (ctx) => M.respond_to_invite(ctx, { eventId: w.e1, status: 'Accepted' }));
        const after = w.invites(w.dave).find((r) => r.eventId === w.e1)!;
        expect(after.inviteKey).toBe(key(w.e1, w.dave.userId));
        expect(after.inviteStatus.tag).toBe('Accepted');
        expect(after.respondedAt).toBeDefined();
        expect(w.invites(w.carol).find((r) => r.inviteKey === key(w.e1, w.dave.userId))!.inviteStatus.tag).toBe('Accepted');
        expect(w.invites(w.gina).map((r) => r.inviteeUserId).sort((a, b) => a - b)).toEqual([w.dave.userId, w.gina.userId].sort((a, b) => a - b));
        expect(w.invites(w.gina).find((r) => r.inviteeUserId === w.dave.userId)!.inviteStatus.tag).toBe('Accepted');
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

    it('no calendar row carries an audit column, and the only user ids are the ones the contract names (organizer, invitees of the events the caller is invited to or organizes, saved target) (re-aligned T-S10ac, A157(5))', () => {
        const w = world();
        const names = ['view_my_calendar_events', 'view_my_calendar_invites', 'view_my_availability', 'view_saved_calendar_availability', 'view_my_saved_calendars'];
        for (const name of names) {
            for (const r of view(w.test, name, w.dave)) expect(noAudit(r), name).toEqual([]);
        }
        const allowed = new Set([w.dave, w.carol, w.org, w.erin, w.frank].map((a) => a.userId));
        for (const r of w.events(w.dave)) expect(allowed.has(r.organizerId)).toBe(true);
        const daveInvited = new Set([...w.test.db.CalendarEventInvite.invitee_user_id.filter(w.dave.userId)].map((i) => i.eventId));
        for (const r of w.invites(w.dave)) {
            expect(daveInvited.has(r.eventId)).toBe(true);
            expect([...w.test.db.CalendarEventInvite.by_event_and_invitee.filter([r.eventId, r.inviteeUserId])]).toHaveLength(1);
        }
    });
});

const test_avatar = (test: Harness, who: Actor) => test.db.User.id.find(who.userId)!.avatarCharacterName;

// ════════════════════════════════════════════════════════════════════════════
// T-S10ac (A157(5), (6), (8), (12)): attendee list per viewer, busy blocks, leaving, avatars
// ════════════════════════════════════════════════════════════════════════════

describe('A157: the calendar views per viewer (S10ac)', () => {
    /**
     * Carol organizes P (personal, notes "P notes") inviting Bob, Dora (declines) and Leo (leaves); Sam saved and shows
     * Carol's calendar; Otto is an outsider. Avatars are set on Carol and Bob.
     */
    function personal() {
        const test = newHarness();
        const [carol, bob, dora, leo, sam, otto] = ['carol', 'bob', 'dora', 'leo', 'sam', 'otto'].map((n) => verified(test, n));
        test.db.User.id.update({ ...test.db.User.id.find(carol.userId)!, avatarCharacterName: 'Kafka' });
        test.db.User.id.update({ ...test.db.User.id.find(bob.userId)!, avatarCharacterName: 'Bronya' });
        const p = createTitledEvent(test, carol, 'P', [bob, dora, leo]);
        tx(test, dora, (ctx) => M.respond_to_invite(ctx, { eventId: p, status: 'Declined' }));
        tx(test, leo, (ctx) => M.remove_invite(ctx, { eventId: p, inviteeUserId: leo.userId }));
        saveCalendar(test, sam, carol);
        const events = (who: Actor) => view<MyCalendarEventRow>(test, 'view_my_calendar_events', who);
        const invites = (who: Actor) => view<MyCalendarInviteRow>(test, 'view_my_calendar_invites', who);
        return { test, carol, bob, dora, leo, sam, otto, p, events, invites };
    }
    const ids = (rows: Array<{ inviteeUserId: number }>) => rows.map((r) => r.inviteeUserId).sort((a, b) => a - b);

    it('A157(5): the organizer and every remaining invitee (the decliner too) read all invites of the personal event with their answers; the leaver, the saver and an outsider read none', () => {
        const w = personal();
        const all = ids([w.bob, w.dora].map((u) => ({ inviteeUserId: u.userId })));
        for (const reader of [w.carol, w.bob, w.dora]) {
            const rows = w.invites(reader).filter((r) => r.eventId === w.p);
            expect(ids(rows), displayName(w.test, reader)).toEqual(all);
            expect(rows.find((r) => r.inviteeUserId === w.dora.userId)!.inviteStatus.tag).toBe('Declined');
            expect(rows.find((r) => r.inviteeUserId === w.bob.userId)!.inviteStatus.tag).toBe('Pending');
        }
        for (const reader of [w.leo, w.sam, w.otto]) expect(w.invites(reader)).toEqual([]);
    });

    it('A157(8): the decliner still reads the event row, without the notes; the invitee reads it with the notes; the leaver and the outsider read nothing of it', () => {
        const w = personal();
        expect(w.events(w.bob).find((r) => r.id === w.p)).toMatchObject({ title: 'P', description: 'P notes', isBusyBlock: false });
        const declined = w.events(w.dora).find((r) => r.id === w.p)!;
        expect(declined).toMatchObject({ title: 'P', isBusyBlock: false });
        expect(declined.description).toBeUndefined();
        expect(w.events(w.carol).find((r) => r.id === w.p)!.description).toBe('P notes');
        expect(w.events(w.leo)).toEqual([]);
        expect(w.events(w.otto)).toEqual([]);
        // the answer can still change: Dora accepts and the notes come back
        tx(w.test, w.dora, (ctx) => M.respond_to_invite(ctx, { eventId: w.p, status: 'Accepted' }));
        expect(w.events(w.dora).find((r) => r.id === w.p)!.description).toBe('P notes');
    });

    it('A157(6): the saver receives the saved player\'s events as busy blocks only: owner, start, end; no title, notes, match link or invitees', () => {
        const w = personal();
        const rows = w.events(w.sam);
        expect(rows).toHaveLength(1);
        const p = w.test.db.CalendarEvent.id.find(w.p)!;
        expect(rows[0]).toEqual({
            id: w.p, organizerId: w.carol.userId, organizerLabel: displayName(w.test, w.carol), organizerAvatarCharacterName: 'Kafka',
            title: '', description: undefined, startAt: p.startAt, endAt: p.endAt, bracketMatchId: undefined, isBusyBlock: true,
        });
        expect(w.invites(w.sam)).toEqual([]);
        // a saver who is also invited reads the full row once
        tx(w.test, w.carol, (ctx) => M.invite_to_event(ctx, { eventId: w.p, inviteeUserId: w.sam.userId }));
        const both = w.events(w.sam).filter((r) => r.id === w.p);
        expect(both).toHaveLength(1);
        expect(both[0]).toMatchObject({ title: 'P', description: 'P notes', isBusyBlock: false });
    });

    it('A157(6): a saved staff member\'s match event reaches the saver as a busy block without the match link', () => {
        const f = duel();
        const { test, org } = f;
        const m = [...test.db.BracketMatch.tournament_id.filter(f.id)][0];
        const id = createTitledEvent(test, org, 'Final', [], m.id);
        const saver = verified(test, 'saver');
        saveCalendar(test, saver, org);
        expect(view<MyCalendarEventRow>(test, 'view_my_calendar_events', saver)).toEqual([
            expect.objectContaining({ id, title: '', bracketMatchId: undefined, isBusyBlock: true }),
        ]);
    });

    it('A157(12): avatars next to the labels: organizer in the event row, invitee and inviter in the invite row; a deleted invitee\'s row goes with the account', () => {
        const w = personal();
        expect(w.events(w.bob).find((r) => r.id === w.p)!.organizerAvatarCharacterName).toBe('Kafka');
        const bobsRow = w.invites(w.dora).find((r) => r.inviteeUserId === w.bob.userId)!;
        expect(bobsRow).toMatchObject({
            inviteeLabel: displayName(w.test, w.bob), inviteeAvatarCharacterName: 'Bronya',
            inviterLabel: displayName(w.test, w.carol), inviterAvatarCharacterName: 'Kafka',
        });
        const dorasRow = w.invites(w.carol).find((r) => r.inviteeUserId === w.dora.userId)!;
        expect(dorasRow.inviteeAvatarCharacterName).toBe(test_avatar(w.test, w.dora));
        const username = w.test.db.User.id.find(w.bob.userId)!.username;
        tx(w.test, 'internal', (ctx) => M.server_delete_user(ctx, { username }));
        expect(w.invites(w.dora).map((r) => r.inviteeUserId)).toEqual([w.dora.userId]);
    });

    it('A157(5): a match event of a tournament that is not anonymous: an invited player reads all invites; of an anonymous tournament (isAnonymousDefault): only their own, while the organizer and an invited bracket assistant read all', () => {
        const f = duel();
        const { test, org } = f;
        const m = [...test.db.BracketMatch.tournament_id.filter(f.id)][0];
        const id = createTitledEvent(test, org, 'Final', [], m.id);
        const player = f.ts[0].captain;
        const allInvites = [...test.db.CalendarEventInvite.event_id.filter(id)].map((i) => i.inviteeUserId).sort((a, b) => a - b);
        expect(allInvites.length).toBeGreaterThan(1);
        const readIds = (who: Actor) => view<MyCalendarInviteRow>(test, 'view_my_calendar_invites', who)
            .filter((r) => r.eventId === id).map((r) => r.inviteeUserId).sort((a, b) => a - b);
        expect(readIds(player)).toEqual(allInvites);

        // engineered: the anonymity flag set on the row (update_tournament changes it only in Draft)
        test.db.Tournament.id.update({ ...test.db.Tournament.id.find(f.id)!, isAnonymousDefault: true });
        expect(readIds(player)).toEqual([player.userId]);
        expect(readIds(org)).toEqual(allInvites);
        const asst = verified(test, 'bracketasst');
        assignAssistant(test, org, f.id, asst, { bracket: true });
        tx(test, org, (ctx) => M.invite_to_event(ctx, { eventId: id, inviteeUserId: asst.userId }));
        expect(readIds(asst)).toEqual([...allInvites, asst.userId].sort((a, b) => a - b));
        const plain = verified(test, 'plainasst');
        assignAssistant(test, org, f.id, plain, { participants: true });
        tx(test, org, (ctx) => M.invite_to_event(ctx, { eventId: id, inviteeUserId: plain.userId }));
        expect(readIds(plain)).toEqual([plain.userId]);
    });
});
