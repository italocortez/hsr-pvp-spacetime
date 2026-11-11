// Views: the calendar views.
// Contracts: docs/views/contract.md
// From S9b (s9b-views.test.ts).
import { describe, expect, it } from 'vitest';
import type {
    EventAttendeeRow,
    MyAvailabilityRow,
    MyCalendarEventRow,
    MyCalendarInviteRow,
    MySavedCalendarRow,
    SavedCalendarAvailabilityRow,
} from '@bindings/types';
import { M, guest, newHarness, tx, type Actor, type Harness } from '../fixtures/harness';
import { admin, setUserRole, verified, displayName } from '../fixtures/identity';
import { addSlotAt, createTitledEvent, saveCalendar } from '../fixtures/calendar';
import { AUDIT_KEYS, keysOf, profileGhost, sorted, view, type Reader } from '../fixtures/views';
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

    it('S9b-C2 (re-aligned T-S10ac, A157(5); re-aligned T-S10ad fix pass, A161(1)): Dave reads only his own invites with the inviter\'s name (no other invitee\'s row); Carol reads every invite of E1; a response updates the row in place', () => {
        const w = world();
        const mine = w.invites(w.dave);
        for (const r of mine) expect(keysOf(r)).toEqual(sorted('calInvite'));
        expect(mine.every((r) => r.inviteeUserId === w.dave.userId)).toBe(true); // A161(1): own rows only
        expect(mine.filter((r) => r.eventId === w.e1).map((r) => r.inviteeUserId)).toEqual([w.dave.userId]);
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
        expect(w.invites(w.gina).map((r) => r.inviteeUserId)).toEqual([w.gina.userId]); // A161(1): own row only
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
        const attendees = (who: Actor) => view<EventAttendeeRow>(test, 'view_event_attendees', who, { eventId: p });
        return { test, carol, bob, dora, leo, sam, otto, p, events, invites, attendees };
    }
    const ids = (rows: Array<{ inviteeUserId: number }>) => rows.map((r) => r.inviteeUserId).sort((a, b) => a - b);

    it('A157(5) (re-aligned T-S10ad fix pass, A161(1): was "every remaining invitee reads all invites in view_my_calendar_invites"): there the organizer reads all invites of the personal event, each invitee only their own; view_event_attendees gives the organizer and every remaining invitee (the decliner too) the full list with answers; the leaver, the saver and an outsider read none in either', () => {
        const w = personal();
        const all = ids([w.bob, w.dora].map((u) => ({ inviteeUserId: u.userId })));
        expect(ids(w.invites(w.carol).filter((r) => r.eventId === w.p))).toEqual(all);
        for (const reader of [w.bob, w.dora]) {
            expect(ids(w.invites(reader).filter((r) => r.eventId === w.p)), displayName(w.test, reader)).toEqual([reader.userId]);
        }
        for (const reader of [w.carol, w.bob, w.dora]) {
            const rows = w.attendees(reader);
            expect(ids(rows), displayName(w.test, reader)).toEqual(all);
            expect(rows.find((r) => r.inviteeUserId === w.dora.userId)!.inviteStatus.tag).toBe('Declined');
            expect(rows.find((r) => r.inviteeUserId === w.bob.userId)!.inviteStatus.tag).toBe('Pending');
        }
        for (const reader of [w.leo, w.sam, w.otto]) {
            expect(w.invites(reader)).toEqual([]);
            expect(w.attendees(reader)).toEqual([]);
        }
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

    it('A157(12) (re-aligned T-S10ad fix pass, A161(1): Bob\'s row was read from Dora\'s view_my_calendar_invites, now from her attendee list): avatars next to the labels: organizer in the event row, invitee and inviter in the invite row, invitee in the attendee row; a deleted invitee\'s row goes with the account', () => {
        const w = personal();
        expect(w.events(w.bob).find((r) => r.id === w.p)!.organizerAvatarCharacterName).toBe('Kafka');
        expect(w.invites(w.bob).find((r) => r.inviteeUserId === w.bob.userId)!).toMatchObject({
            inviteeLabel: displayName(w.test, w.bob), inviteeAvatarCharacterName: 'Bronya',
            inviterLabel: displayName(w.test, w.carol), inviterAvatarCharacterName: 'Kafka',
        });
        const bobsRow = w.attendees(w.dora).find((r) => r.inviteeUserId === w.bob.userId)!;
        expect(bobsRow).toMatchObject({ inviteeLabel: displayName(w.test, w.bob), inviteeAvatarCharacterName: 'Bronya' });
        const dorasRow = w.invites(w.carol).find((r) => r.inviteeUserId === w.dora.userId)!;
        expect(dorasRow.inviteeAvatarCharacterName).toBe(test_avatar(w.test, w.dora));
        const username = w.test.db.User.id.find(w.bob.userId)!.username;
        tx(w.test, 'internal', (ctx) => M.server_delete_user(ctx, { username }));
        expect(w.invites(w.dora).map((r) => r.inviteeUserId)).toEqual([w.dora.userId]);
        expect(w.attendees(w.dora).map((r) => r.inviteeUserId)).toEqual([w.dora.userId]);
    });

    it('A157(5) (re-aligned T-S10ad fix pass, A161(1): the full list moved from view_my_calendar_invites to view_event_attendees): a match event of a tournament that is not anonymous: an invited player reads all invites; of an anonymous tournament (isAnonymousDefault): none, while the organizer and an invited bracket assistant read all; view_my_calendar_invites gives each invitee their own row only', () => {
        const f = duel();
        const { test, org } = f;
        const m = [...test.db.BracketMatch.tournament_id.filter(f.id)][0];
        const id = createTitledEvent(test, org, 'Final', [], m.id);
        const player = f.ts[0].captain;
        const allInvites = [...test.db.CalendarEventInvite.event_id.filter(id)].map((i) => i.inviteeUserId).sort((a, b) => a - b);
        expect(allInvites.length).toBeGreaterThan(1);
        const readIds = (who: Actor) => view<EventAttendeeRow>(test, 'view_event_attendees', who, { eventId: id })
            .map((r) => r.inviteeUserId).sort((a, b) => a - b);
        const ownIds = (who: Actor) => view<MyCalendarInviteRow>(test, 'view_my_calendar_invites', who)
            .filter((r) => r.eventId === id).map((r) => r.inviteeUserId);
        expect(readIds(player)).toEqual(allInvites);
        expect(ownIds(player)).toEqual([player.userId]);

        // engineered: the anonymity flag set on the row (update_tournament changes it only in Draft)
        test.db.Tournament.id.update({ ...test.db.Tournament.id.find(f.id)!, isAnonymousDefault: true });
        expect(readIds(player)).toEqual([]);
        expect(ownIds(player)).toEqual([player.userId]);
        expect(readIds(org)).toEqual(allInvites);
        const asst = verified(test, 'bracketasst');
        assignAssistant(test, org, f.id, asst, { bracket: true });
        tx(test, org, (ctx) => M.invite_to_event(ctx, { eventId: id, inviteeUserId: asst.userId }));
        expect(readIds(asst)).toEqual([...allInvites, asst.userId].sort((a, b) => a - b));
        expect(ownIds(asst)).toEqual([asst.userId]);
        const plain = verified(test, 'plainasst');
        assignAssistant(test, org, f.id, plain, { participants: true });
        tx(test, org, (ctx) => M.invite_to_event(ctx, { eventId: id, inviteeUserId: plain.userId }));
        expect(readIds(plain)).toEqual([]);
        expect(ownIds(plain)).toEqual([plain.userId]);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// T-S10ad fix pass (A161(1)): view_event_attendees(eventId), the attendee list of one event, per reader
// ════════════════════════════════════════════════════════════════════════════

describe('A161(1): view_event_attendees(eventId) returns one event\'s invites to the readers A157(5) names', () => {
    const COLS_ATTENDEE = ['inviteStatus', 'inviteeAvatarCharacterName', 'inviteeLabel', 'inviteeUserId', 'respondedAt'];
    const read = (test: Harness, who: Reader, eventId: number) =>
        view<EventAttendeeRow>(test, 'view_event_attendees', who, { eventId });
    const idsOf = (rows: EventAttendeeRow[]) => rows.map((r) => r.inviteeUserId).sort((a, b) => a - b);

    /**
     * Carol organizes P inviting Bob (Pending), Ana (Accepted), Dora (Declined), Tom (Tentative) and Leo (leaves); Sam
     * saved Carol's calendar; Otto is a verified outsider, Gus a guest outsider, Ada an Admin who is not invited.
     */
    function personalWorld() {
        const test = newHarness();
        const [carol, bob, ana, dora, tom, leo, sam, otto] = ['pcarol', 'pbob', 'pana', 'pdora', 'ptom', 'pleo', 'psam', 'potto']
            .map((n) => verified(test, n));
        const gus = guest(test, 'pgus');
        const ada = admin(test, 'pada');
        const p = createTitledEvent(test, carol, 'P', [bob, ana, dora, tom, leo]);
        tx(test, ana, (ctx) => M.respond_to_invite(ctx, { eventId: p, status: 'Accepted' }));
        tx(test, dora, (ctx) => M.respond_to_invite(ctx, { eventId: p, status: 'Declined' }));
        tx(test, tom, (ctx) => M.respond_to_invite(ctx, { eventId: p, status: 'Tentative' }));
        tx(test, leo, (ctx) => M.remove_invite(ctx, { eventId: p, inviteeUserId: leo.userId }));
        saveCalendar(test, sam, carol);
        const all = [bob, ana, dora, tom].map((u) => u.userId).sort((a, b) => a - b);
        return { test, carol, bob, ana, dora, tom, leo, sam, otto, gus, ada, p, all };
    }

    it('personal event: the organizer and every invitee in each answer state read the full list with answers and the documented columns only', () => {
        const w = personalWorld();
        for (const reader of [w.carol, w.bob, w.ana, w.dora, w.tom]) {
            const rows = read(w.test, reader, w.p);
            expect(idsOf(rows), displayName(w.test, reader)).toEqual(w.all);
            for (const r of rows) {
                expect(keysOf(r)).toEqual(COLS_ATTENDEE);
                expect(r.inviteeLabel).toBe(w.test.db.User.id.find(r.inviteeUserId)!.displayName);
            }
            const status = Object.fromEntries(rows.map((r) => [r.inviteeUserId, r.inviteStatus.tag]));
            expect(status).toEqual({
                [w.bob.userId]: 'Pending', [w.ana.userId]: 'Accepted', [w.dora.userId]: 'Declined', [w.tom.userId]: 'Tentative',
            });
            expect(rows.find((r) => r.inviteeUserId === w.bob.userId)!.respondedAt).toBeUndefined();
            expect(rows.find((r) => r.inviteeUserId === w.ana.userId)!.respondedAt).toBeDefined();
        }
    });

    it('personal event: the leaver, the saver, an outsider, a guest and a client that never logged in read nothing; an Admin who is not invited reads the full list (re-aligned T-S11a, A162(3): was "an Admin who is not invited reads nothing")', () => {
        const w = personalWorld();
        expect(idsOf(read(w.test, w.ada, w.p))).toEqual(w.all); // A162(3)
        for (const reader of [w.leo, w.sam, w.otto, w.gus]) {
            expect(read(w.test, reader, w.p), displayName(w.test, reader)).toEqual([]);
        }
        expect(read(w.test, profileGhost(), w.p)).toEqual([]);
    });

    it('an unknown event id and a deleted event give no rows (no error); an answer is visible to the other readers at once', () => {
        const w = personalWorld();
        expect(read(w.test, w.carol, 999_999)).toEqual([]);
        tx(w.test, w.bob, (ctx) => M.respond_to_invite(ctx, { eventId: w.p, status: 'Accepted' }));
        expect(read(w.test, w.dora, w.p).find((r) => r.inviteeUserId === w.bob.userId)!.inviteStatus.tag).toBe('Accepted');
        tx(w.test, w.carol, (ctx) => M.delete_calendar_event(ctx, { eventId: w.p }));
        for (const reader of [w.carol, w.bob, w.ana, w.dora, w.tom]) expect(read(w.test, reader, w.p)).toEqual([]);
    });

    /**
     * A duel's final with a match event by the organizer: the four team members are invited by the server, plus an
     * approved stand-in for team 1; a bracket assistant with an invite and one without; a plain assistant with an invite
     * and one without; a member who removed their own invite; a saver of the organizer's calendar; an outsider; a guest;
     * an Admin. `anonymous` sets Tournament.isAnonymousDefault on the row (update_tournament changes it only in Draft).
     */
    function matchWorld(anonymous: boolean) {
        const f = duel();
        const { test, org } = f;
        const m = [...test.db.BracketMatch.tournament_id.filter(f.id)][0];
        const sub = verified(test, 'msub');
        tx(test, org, (ctx) => M.approve_stand_in(ctx, { bracketMatchId: m.id, teamId: m.team1Id!, userId: sub.userId }));
        const id = createTitledEvent(test, org, 'Final', [], m.id);
        const [bInv, bNo, pInv, pNo, saver, outsider] = ['mbinv', 'mbno', 'mpinv', 'mpno', 'msaver', 'mout'].map((n) => verified(test, n));
        assignAssistant(test, org, f.id, bInv, { bracket: true });
        assignAssistant(test, org, f.id, bNo, { bracket: true });
        assignAssistant(test, org, f.id, pInv, { participants: true });
        assignAssistant(test, org, f.id, pNo, { participants: true });
        tx(test, org, (ctx) => M.invite_to_event(ctx, { eventId: id, inviteeUserId: bInv.userId }));
        tx(test, org, (ctx) => M.invite_to_event(ctx, { eventId: id, inviteeUserId: pInv.userId }));
        const leaver = f.ts[1].mate;
        tx(test, leaver, (ctx) => M.remove_invite(ctx, { eventId: id, inviteeUserId: leaver.userId }));
        saveCalendar(test, saver, org);
        const gus = guest(test, 'mgus');
        const ada = admin(test, 'mada');
        if (anonymous) test.db.Tournament.id.update({ ...test.db.Tournament.id.find(f.id)!, isAnonymousDefault: true });
        const all = [...test.db.CalendarEventInvite.event_id.filter(id)].map((i) => i.inviteeUserId).sort((a, b) => a - b);
        const members = [f.ts[0].captain, f.ts[0].mate, f.ts[1].captain];
        expect(all).toEqual(expect.arrayContaining([...members, sub, bInv, pInv].map((u) => u.userId)));
        expect(all).not.toContain(leaver.userId);
        return { test, org, id, sub, bInv, bNo, pInv, pNo, leaver, saver, outsider, gus, ada, members, all };
    }

    it('match event of a tournament that is not anonymous: every invitee (team members, stand-in, invited assistants of any kind), the organizer, bracket permission holders without an invite and an Admin read the full list; the leaver, a plain assistant without an invite, the saver, an outsider and a guest read nothing', () => {
        const w = matchWorld(false);
        for (const reader of [w.org, ...w.members, w.sub, w.bInv, w.pInv, w.bNo, w.ada]) {
            expect(idsOf(read(w.test, reader, w.id)), displayName(w.test, reader)).toEqual(w.all);
        }
        for (const reader of [w.leaver, w.pNo, w.saver, w.outsider, w.gus]) {
            expect(read(w.test, reader, w.id), displayName(w.test, reader)).toEqual([]);
        }
    });

    it('match event of an anonymous tournament: only the organizer and holders of the bracket permission (assistant with or without an invite, Admin) read the list; team members, the stand-in and an invited plain assistant read nothing here and keep their own row in view_my_calendar_invites', () => {
        const w = matchWorld(true);
        for (const reader of [w.org, w.bInv, w.bNo, w.ada]) {
            expect(idsOf(read(w.test, reader, w.id)), displayName(w.test, reader)).toEqual(w.all);
        }
        for (const reader of [...w.members, w.sub, w.pInv, w.pNo, w.leaver, w.saver, w.outsider, w.gus]) {
            expect(read(w.test, reader, w.id), displayName(w.test, reader)).toEqual([]);
        }
        for (const reader of [...w.members, w.sub, w.pInv]) {
            expect(view<MyCalendarInviteRow>(w.test, 'view_my_calendar_invites', reader).filter((r) => r.eventId === w.id)
                .map((r) => r.inviteeUserId)).toEqual([reader.userId]);
        }
    });

    it('a personal event against a match event: a bracket assistant reads the match event\'s list but not a personal event of the same organizer they are not invited to; an Admin reads both (re-aligned T-S11a, A162(3): the Admin was refused the personal list)', () => {
        const w = matchWorld(false);
        const p = createTitledEvent(w.test, w.org, 'Personal', [w.members[0]]);
        expect(idsOf(read(w.test, w.members[0], p))).toEqual([w.members[0].userId]);
        expect(idsOf(read(w.test, w.org, p))).toEqual([w.members[0].userId]);
        for (const reader of [w.bInv, w.bNo]) {
            expect(idsOf(read(w.test, reader, w.id)).length).toBeGreaterThan(0);
            expect(read(w.test, reader, p), displayName(w.test, reader)).toEqual([]);
        }
        expect(idsOf(read(w.test, w.ada, w.id))).toEqual(w.all);
        expect(idsOf(read(w.test, w.ada, p))).toEqual([w.members[0].userId]); // A162(3)
    });
});

// ════════════════════════════════════════════════════════════════════════════
// T-S11a (A162): the creator of a match event reads its list only while holding the bracket permission; an Admin
// reads every list
// ════════════════════════════════════════════════════════════════════════════

describe('A162: a match event\'s creator needs the bracket permission to read the attendee list; an Admin reads every list', () => {
    const read = (test: Harness, who: Reader, eventId: number) =>
        view<EventAttendeeRow>(test, 'view_event_attendees', who, { eventId }).map((r) => r.inviteeUserId).sort((a, b) => a - b);
    const ownInviteRows = (test: Harness, who: Actor, eventId: number) =>
        view<MyCalendarInviteRow>(test, 'view_my_calendar_invites', who).filter((r) => r.eventId === eventId)
            .map((r) => r.inviteeUserId).sort((a, b) => a - b);

    /** A duel's final; `creator` (a bracket assistant) schedules its match event; the four members are invited. */
    function world(anonymous: boolean) {
        const f = duel();
        const { test, org } = f;
        const m = [...test.db.BracketMatch.tournament_id.filter(f.id)][0];
        const creator = verified(test, 'a162creator');
        assignAssistant(test, org, f.id, creator, { bracket: true });
        const id = createTitledEvent(test, creator, 'Final', [], m.id);
        if (anonymous) test.db.Tournament.id.update({ ...test.db.Tournament.id.find(f.id)!, isAnonymousDefault: true });
        const all = [...test.db.CalendarEventInvite.event_id.filter(id)].map((i) => i.inviteeUserId).sort((a, b) => a - b);
        return { f, test, org, m, creator, id, all };
    }

    it('A162(1): a bracket assistant who created the event reads the list and every invite row while staff; removed from the staff, they read neither (view_event_attendees, view_my_calendar_invites)', () => {
        const w = world(false);
        expect(read(w.test, w.creator, w.id)).toEqual(w.all);
        expect(ownInviteRows(w.test, w.creator, w.id)).toEqual(w.all);
        tx(w.test, w.org, (ctx) => M.remove_tournament_assistant(ctx, { tournamentId: w.f.id, userId: w.creator.userId }));
        expect(read(w.test, w.creator, w.id)).toEqual([]);
        expect(ownInviteRows(w.test, w.creator, w.id)).toEqual([]);
        // the event itself stays in their calendar (path (a) of view_my_calendar_events, unchanged)
        expect(view<MyCalendarEventRow>(w.test, 'view_my_calendar_events', w.creator).map((e) => e.id)).toContain(w.id);
        // the tournament organizer still reads the list
        expect(read(w.test, w.org, w.id)).toEqual(w.all);
    });

    it('A162(1): a Moderator who created the event loses the list when demoted to User, and gets it back when promoted again', () => {
        const w = world(true);
        const mod = verified(w.test, 'a162mod');
        setUserRole(w.test, mod.userId, 'Moderator');
        tx(w.test, w.creator, (ctx) => M.delete_calendar_event(ctx, { eventId: w.id }));
        const id = createTitledEvent(w.test, mod, 'Final', [], w.m.id);
        const all = [...w.test.db.CalendarEventInvite.event_id.filter(id)].map((i) => i.inviteeUserId).sort((a, b) => a - b);
        expect(read(w.test, mod, id)).toEqual(all);
        setUserRole(w.test, mod.userId, 'User');
        expect(read(w.test, mod, id)).toEqual([]);
        expect(ownInviteRows(w.test, mod, id)).toEqual([]);
        setUserRole(w.test, mod.userId, 'Moderator');
        expect(read(w.test, mod, id)).toEqual(all);
    });

    it('A162(1): a former-staff creator who is invited to the match event is treated as any invitee: their own row; the full list only when the tournament is not anonymous', () => {
        for (const anonymous of [false, true]) {
            const f = duel();
            const { test, org } = f;
            const m = [...test.db.BracketMatch.tournament_id.filter(f.id)][0];
            const member = f.ts[0].captain; // a team member of the match: auto-invited at creation
            assignAssistant(test, org, f.id, member, { bracket: true });
            const id = createTitledEvent(test, member, 'Final', [], m.id);
            if (anonymous) test.db.Tournament.id.update({ ...test.db.Tournament.id.find(f.id)!, isAnonymousDefault: true });
            const all = [...test.db.CalendarEventInvite.event_id.filter(id)].map((i) => i.inviteeUserId).sort((a, b) => a - b);
            expect(all).toContain(member.userId);
            tx(test, org, (ctx) => M.remove_tournament_assistant(ctx, { tournamentId: f.id, userId: member.userId }));
            expect(ownInviteRows(test, member, id), `anonymous ${anonymous}`).toEqual([member.userId]);
            expect(read(test, member, id), `anonymous ${anonymous}`).toEqual(anonymous ? [] : all);
        }
    });

    it('A162(3): an Admin who is neither organizer nor invitee reads the attendee list of a personal event and of a match event of an anonymous tournament', () => {
        const w = world(true);
        const ada = admin(w.test, 'a162ada');
        const carol = verified(w.test, 'a162carol');
        const bob = verified(w.test, 'a162bob');
        const p = createTitledEvent(w.test, carol, 'Tea', [bob]);
        expect(read(w.test, ada, p)).toEqual([bob.userId]);
        expect(read(w.test, ada, w.id)).toEqual(w.all);
        // an Admin's own view_my_calendar_invites is unchanged: no rows of events they neither organize nor are invited to
        expect(ownInviteRows(w.test, ada, p)).toEqual([]);
    });

    it('A162: nothing changes for the organizer of a personal event: the full list in both views, before and after any role change', () => {
        const test = newHarness();
        const carol = verified(test, 'a162pcarol');
        const bob = verified(test, 'a162pbob');
        const p = createTitledEvent(test, carol, 'Lunch', [bob]);
        expect(read(test, carol, p)).toEqual([bob.userId]);
        expect(ownInviteRows(test, carol, p)).toEqual([bob.userId]);
        setUserRole(test, carol.userId, 'Moderator');
        setUserRole(test, carol.userId, 'User');
        expect(read(test, carol, p)).toEqual([bob.userId]);
        expect(ownInviteRows(test, carol, p)).toEqual([bob.userId]);
    });
});
