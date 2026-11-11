// Calendar: tournament-linked event callers, invitee and length rules, recurring slots, the per-call clean-up and
//   the write allowance.
// Decisions: A89, A122
// Contracts: docs/calendar/contract.md
// From S10d, S10f, S10s, S10q (s10d-rulings.test.ts, s10f-draft-results.test.ts, s10s-triage-fixes.test.ts,
//   s10q-gap-coverage.test.ts).
import { describe, expect, it } from 'vitest';
import { M, advance, newHarness, tx, type Harness, rejection, snap } from '../fixtures/harness';
import { moderator, setUserRole, verified } from '../fixtures/identity';
import {
    DAY_MS,
    HOUR_MS,
    addSlot,
    clearMembershipCount,
    createEvent,
    eventArgs,
    fromNow,
    invite,
    invitesOf,
    slotsOf,
    event,
} from '../fixtures/calendar';
import { createAccount } from '../fixtures/roster';
import { viewAs } from '../fixtures/views';
import { advanceStage, assignAssistant, liveField } from '../fixtures/tournaments';
import { byKey, duel, playMatch } from '../fixtures/tournament-matches';

// T-S11a (A162(1)): the organizer of a match event no longer passes on their own, so the linked text drops "the organizer".
const LINKED = (action: string) => `Forbidden: Only an Admin or tournament staff with the bracket permission can ${action}.`;
const PERSONAL = (action: string) => `Forbidden: Only the organizer or an Admin can ${action}.`;

// ════════════════════════════════════════════════════════════════════════════
// A89: tournament staff manage tournament-linked calendar events
// ════════════════════════════════════════════════════════════════════════════

describe('A89: tournament-linked events accept the tournament organizer and bracket staff', () => {
    function calendarWorld() {
        const f = liveField(2);
        const { test, org, id } = f;
        const m = byKey(test, id, 'W-R1-M1');
        const asstA = verified(test, 'asstA');
        const asstB = verified(test, 'asstB');
        const asstP = verified(test, 'asstP');
        assignAssistant(test, org, id, asstA, { bracket: true });
        assignAssistant(test, org, id, asstB, { bracket: true });
        assignAssistant(test, org, id, asstP, { participants: true, results: true }); // no bracket permission
        const mod = moderator(test, 'calmod');
        const adm = verified(test, 'caladm');
        setUserRole(test, adm.userId, 'Admin');
        return {
            test, m, org, asstA, asstB, asstP, mod, adm,
            participant: f.ts[0].captain,
            stranger: verified(test, 'stranger'),
            invitee: verified(test, 'invitee'),
            invitee2: verified(test, 'invitee2'),
        };
    }
    type World = ReturnType<typeof calendarWorld>;

    const updateBody = (test: Harness, id: number, title: string) => (ctx: any) => {
        const e = ctx.db.CalendarEvent.id.find(id);
        return M.update_calendar_event(ctx, {
            eventId: id, title, description: '',
            startAt: e.startAt.microsSinceUnixEpoch.toString(), endAt: e.endAt.microsSinceUnixEpoch.toString(),
        });
    };
    const linkedEvent = (w: World) => createEvent(w.test, w.asstA, { title: 'Final', bracketMatchId: w.m.id });

    it.each(['org', 'asstB', 'mod', 'adm'] as const)('%s updates, invites, removes an invite and deletes an event an assistant scheduled (A89)', (who) => {
        const w = calendarWorld();
        const { test } = w;
        const caller = w[who];
        const id = linkedEvent(w);
        tx(test, caller, updateBody(test, id, 'Final (moved)'));
        expect(event(test, id)!.title).toBe('Final (moved)');
        tx(test, caller, (ctx) => M.invite_to_event(ctx, { eventId: id, inviteeUserId: w.invitee.userId }));
        expect(invite(test, id, w.invitee.userId)).toBeDefined();
        tx(test, caller, (ctx) => M.remove_invite(ctx, { eventId: id, inviteeUserId: w.invitee.userId }));
        expect(invite(test, id, w.invitee.userId)).toBeUndefined();
        tx(test, caller, (ctx) => M.delete_calendar_event(ctx, { eventId: id }));
        expect(event(test, id)).toBeUndefined();
    });

    it.each(['asstP', 'participant', 'stranger'] as const)('%s (no bracket permission) is rejected on every call with the linked text; nothing changes (A89)', (who) => {
        const w = calendarWorld();
        const { test } = w;
        const caller = w[who];
        const id = linkedEvent(w);
        tx(test, w.asstA, (ctx) => M.invite_to_event(ctx, { eventId: id, inviteeUserId: w.invitee.userId }));
        const before = snap(event(test, id), invitesOf(test, id));
        const calls: Array<[string, (ctx: any) => unknown]> = [
            ['update this event', updateBody(test, id, 'hijack')],
            ['delete this event', (ctx) => M.delete_calendar_event(ctx, { eventId: id })],
            ['invite users to this event', (ctx) => M.invite_to_event(ctx, { eventId: id, inviteeUserId: w.invitee2.userId })],
            ['remove invites from this event', (ctx) => M.remove_invite(ctx, { eventId: id, inviteeUserId: w.invitee.userId })],
        ];
        for (const [action, body] of calls) {
            const msg = rejection(test, caller, body);
            expect(snap(event(test, id), invitesOf(test, id))).toBe(before);
            expect(msg).toBe(LINKED(action));
        }
    });

    it('a personal event still rejects everyone but its organizer and an Admin, with the old text (A89, D-08)', () => {
        const w = calendarWorld();
        const { test } = w;
        const id = createEvent(test, w.asstA, { title: 'Personal' });
        for (const caller of [w.org, w.asstB, w.mod, w.stranger]) {
            const before = snap(event(test, id), invitesOf(test, id));
            const msg = rejection(test, caller, updateBody(test, id, 'hijack'));
            expect(snap(event(test, id), invitesOf(test, id))).toBe(before);
            expect(msg).toBe(PERSONAL('update this event'));
            const del = rejection(test, caller, (ctx) => M.delete_calendar_event(ctx, { eventId: id }));
            expect(event(test, id)).toBeDefined();
            expect(del).toBe(PERSONAL('delete this event'));
        }
        tx(test, w.adm, updateBody(test, id, 'By admin'));
        expect(event(test, id)!.title).toBe('By admin');
        tx(test, w.asstA, updateBody(test, id, 'By organizer'));
        expect(event(test, id)!.title).toBe('By organizer');
    });

    // ── T-S11a (A162(1)): the creator of a match event keeps no right of their own once they leave the staff ──

    const allCalls = (test: Harness, id: number, inviteeId: number, newInviteeId: number): Array<[string, (ctx: any) => unknown]> => [
        ['update this event', updateBody(test, id, 'hijack')],
        ['delete this event', (ctx) => M.delete_calendar_event(ctx, { eventId: id })],
        ['invite users to this event', (ctx) => M.invite_to_event(ctx, { eventId: id, inviteeUserId: newInviteeId })],
        ['remove invites from this event', (ctx) => M.remove_invite(ctx, { eventId: id, inviteeUserId: inviteeId })],
    ];

    it('A162(1): an assistant who created a match event and was then removed from the staff is rejected on every edit with the linked text; nothing changes', () => {
        const w = calendarWorld();
        const { test } = w;
        const id = linkedEvent(w); // created by asstA
        tx(test, w.asstA, (ctx) => M.invite_to_event(ctx, { eventId: id, inviteeUserId: w.invitee.userId }));
        tx(test, w.org, (ctx) => M.remove_tournament_assistant(ctx, { tournamentId: w.m.tournamentId, userId: w.asstA.userId }));
        const before = snap(event(test, id), invitesOf(test, id));
        for (const [action, body] of allCalls(test, id, w.invitee.userId, w.invitee2.userId)) {
            expect(rejection(test, w.asstA, body)).toBe(LINKED(action));
            expect(snap(event(test, id), invitesOf(test, id))).toBe(before);
        }
        // the staff who hold the permission still manage it
        tx(test, w.asstB, updateBody(test, id, 'by asstB'));
        expect(event(test, id)!.title).toBe('by asstB');
    });

    it('A162(1): an assistant whose bracket flag was turned off loses the creator\'s rights the same way', () => {
        const w = calendarWorld();
        const { test } = w;
        const id = linkedEvent(w);
        assignAssistant(test, w.org, w.m.tournamentId, w.asstA, { participants: true }); // re-assign without bracket
        expect(rejection(test, w.asstA, updateBody(test, id, 'hijack'))).toBe(LINKED('update this event'));
    });

    it('A162(1): a Moderator who created a match event and was demoted to User is rejected; promoted back, they manage it again', () => {
        const w = calendarWorld();
        const { test } = w;
        const id = createEvent(test, w.mod, { title: 'Mod final', bracketMatchId: w.m.id });
        tx(test, w.mod, (ctx) => M.invite_to_event(ctx, { eventId: id, inviteeUserId: w.invitee.userId }));
        setUserRole(test, w.mod.userId, 'User');
        const before = snap(event(test, id), invitesOf(test, id));
        for (const [action, body] of allCalls(test, id, w.invitee.userId, w.invitee2.userId)) {
            expect(rejection(test, w.mod, body)).toBe(LINKED(action));
            expect(snap(event(test, id), invitesOf(test, id))).toBe(before);
        }
        setUserRole(test, w.mod.userId, 'Moderator');
        tx(test, w.mod, updateBody(test, id, 'back'));
        expect(event(test, id)!.title).toBe('back');
    });

    it('A162(1): a former-staff creator who is also an invitee of the match event may still remove their own invite (as any invitee), and nothing more', () => {
        const w = calendarWorld();
        const { test } = w;
        // a team member of the match made bracket staff creates the event and is auto-invited as a member (D-17)
        assignAssistant(test, w.org, w.m.tournamentId, w.participant, { bracket: true });
        const id = createEvent(test, w.participant, { title: 'Own match', bracketMatchId: w.m.id });
        expect(invite(test, id, w.participant.userId)).toBeDefined();
        tx(test, w.org, (ctx) => M.remove_tournament_assistant(ctx, { tournamentId: w.m.tournamentId, userId: w.participant.userId }));
        expect(rejection(test, w.participant, updateBody(test, id, 'hijack'))).toBe(LINKED('update this event'));
        tx(test, w.participant, (ctx) => M.remove_invite(ctx, { eventId: id, inviteeUserId: w.participant.userId }));
        expect(invite(test, id, w.participant.userId)).toBeUndefined();
    });

    it('A162(1): nothing changes for the organizer of a personal event (update, invite, remove an invite, delete)', () => {
        const w = calendarWorld();
        const { test } = w;
        const id = createEvent(test, w.stranger, { title: 'Mine' });
        tx(test, w.stranger, updateBody(test, id, 'Mine (moved)'));
        tx(test, w.stranger, (ctx) => M.invite_to_event(ctx, { eventId: id, inviteeUserId: w.invitee.userId }));
        tx(test, w.stranger, (ctx) => M.remove_invite(ctx, { eventId: id, inviteeUserId: w.invitee.userId }));
        expect(event(test, id)!.title).toBe('Mine (moved)');
        expect(invite(test, id, w.invitee.userId)).toBeUndefined();
        tx(test, w.stranger, (ctx) => M.delete_calendar_event(ctx, { eventId: id }));
        expect(event(test, id)).toBeUndefined();
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Calendar #2, #3, #5
// ════════════════════════════════════════════════════════════════════════════

describe('Calendar #2: duplicate manual invitee ids (calendar architecture S10f)', () => {
    it('"b,b" produces one invite row for b; ten ids with one duplicate fit the 9-invitee cap (calendar audit #2)', () => {
        const test = newHarness();
        const org = verified(test, 'org');
        const others = Array.from({ length: 9 }, (_, i) => verified(test, `inv${i}`));
        const id = createEvent(test, org, { invitees: [others[0], others[0]] });
        expect(invitesOf(test, id).filter((r) => r.inviteeUserId === others[0].userId)).toHaveLength(1);
        expect(invitesOf(test, id)).toHaveLength(1);

        const full = createEvent(test, org, { invitees: [...others, others[3]] });
        const rows = invitesOf(test, full);
        expect(rows).toHaveLength(9);
        expect(new Set(rows.map((r) => r.inviteeUserId)).size).toBe(9);
    });
});

// T-S10ac (A157(3)): 'Calendar #3: one "no end date" rule for recurring slots' (two it.each cases, '' and '0') is
// removed with recurrence.

describe('Calendar #5: title and description length caps (calendar architecture S10f)', () => {
    const TITLE_LONG = 'Event title cannot exceed 100 characters.';
    const DESC_LONG = 'Event description cannot exceed 1000 characters.';
    const EMPTY_TITLE = 'Event title must not be empty.';

    it('create: title 100 and description 1000 pass; title 101, an empty / blank title and description 1001 are rejected with their texts (calendar audit #5)', () => {
        const test = newHarness();
        const org = verified(test, 'org');
        const id = createEvent(test, org, { title: 't'.repeat(100), description: 'd'.repeat(1000) });
        const row = test.db.CalendarEvent.id.find(id)!;
        expect([row.title.length, row.description?.length]).toEqual([100, 1000]);
        const count = () => [...test.db.CalendarEvent.organizer_id.filter(org.userId)].length;
        const create = (o: Parameters<typeof eventArgs>[1]) => (ctx: any) => M.create_calendar_event(ctx, eventArgs(test, o));
        const msgs = [
            rejection(test, org, create({ title: 't'.repeat(101) })),
            rejection(test, org, create({ title: '' })),
            rejection(test, org, create({ title: '   ' })),
            rejection(test, org, create({ description: 'd'.repeat(1001) })),
        ];
        expect(count()).toBe(1);
        expect(msgs).toEqual([TITLE_LONG, EMPTY_TITLE, EMPTY_TITLE, DESC_LONG]);
    });

    it('update: the same caps; a rejected update leaves the row as it was (calendar audit #5)', () => {
        const test = newHarness();
        const org = verified(test, 'org');
        const id = createEvent(test, org, { title: 'Scrim', description: 'old' });
        const base = { eventId: id, startAt: fromNow(test, 2 * DAY_MS), endAt: fromNow(test, 2 * DAY_MS + HOUR_MS) };
        const update = (title: string, description: string) => (ctx: any) => M.update_calendar_event(ctx, { ...base, title, description });
        const msgs = [
            rejection(test, org, update('t'.repeat(101), '')),
            rejection(test, org, update('', '')),
            rejection(test, org, update('ok', 'd'.repeat(1001))),
        ];
        expect([test.db.CalendarEvent.id.find(id)!.title, test.db.CalendarEvent.id.find(id)!.description]).toEqual(['Scrim', 'old']);
        expect(msgs).toEqual([TITLE_LONG, EMPTY_TITLE, DESC_LONG]);
        tx(test, org, update('t'.repeat(100), 'd'.repeat(1000)));
        const row = test.db.CalendarEvent.id.find(id)!;
        expect([row.title.length, row.description?.length]).toEqual([100, 1000]);
    });
});

// ─── Texts ───────────────────────────────────────────────────────────────────

const RATE_TEXT = 'You are doing that too quickly. Please wait a moment.';

// ════════════════════════════════════════════════════════════════════════════
// L86: every calendar reducer runs the clean-up
// ════════════════════════════════════════════════════════════════════════════

describe('A122(22), L86: every calendar action cleans the caller\'s old events and expired slots', () => {
    it('A122(22) L86: save_calendar deletes the caller\'s event ended over 90 days ago; a newer event and another user\'s old event stay', () => {
        const test = newHarness();
        const u = verified(test, 'cal');
        const other = verified(test, 'other');
        const old = createEvent(test, u, { startMs: HOUR_MS, endMs: 2 * HOUR_MS });
        const othersOld = createEvent(test, other, { startMs: HOUR_MS, endMs: 2 * HOUR_MS });
        advance(test, 85 * DAY_MS);
        const recent = createEvent(test, u, { startMs: HOUR_MS, endMs: 2 * HOUR_MS });
        advance(test, 6 * DAY_MS); // old ended 91 days ago, recent 6 days ago
        expect(test.db.CalendarEvent.id.find(old)).toBeTruthy();

        tx(test, u, (ctx) => M.save_calendar(ctx, { targetUserId: other.userId }));
        expect(test.db.CalendarEvent.id.find(old)).toBeFalsy();
        expect(test.db.CalendarEvent.id.find(recent)).toBeTruthy();
        expect(test.db.CalendarEvent.id.find(othersOld)).toBeTruthy();
    });

    it('A122(22) L86: save_calendar deletes the caller\'s slot expired over a week ago; a slot expired 6 days ago stays', () => {
        const test = newHarness();
        const u = verified(test, 'cal');
        const other = verified(test, 'other');
        const old = addSlot(test, u, { startMs: HOUR_MS, endMs: 2 * HOUR_MS });
        advance(test, DAY_MS);
        const recent = addSlot(test, u, { startMs: HOUR_MS, endMs: 2 * HOUR_MS });
        advance(test, 6 * DAY_MS + 12 * HOUR_MS); // old expired ~7.4 days ago, recent ~6.4 days ago
        expect(slotsOf(test, u).map((s) => s.id).sort()).toEqual([old, recent].sort());

        tx(test, u, (ctx) => M.save_calendar(ctx, { targetUserId: other.userId }));
        expect(slotsOf(test, u).map((s) => s.id)).toEqual([recent]);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// L87: the calendar view skips finished tournaments
// ════════════════════════════════════════════════════════════════════════════

describe('A122(22), L87: view_my_calendar_events skips tournaments that are Completed or Cancelled', () => {
    it('A122(22) L87: a match event reached only through the player\'s team shows while the tournament runs and not once it is Completed', () => {
        const f = duel();
        const { test, org } = f;
        const m = byKey(test, f.id, 'W-R1-M1');
        const eventId = createEvent(test, org, { bracketMatchId: m.id });
        const player = f.ts.find((t) => t.teamId === m.team1Id)!.captain;
        test.db.CalendarEventInvite.delete(invite(test, eventId, player.userId)); // reach it through the team path only
        const ids = () => viewAs<{ id: number }>(test, 'view_my_calendar_events', player).map((r) => r.id);
        expect(ids()).toContain(eventId); // neighbour: a running tournament's match event shows

        playMatch(f, m.id, 'Blue'); // a played decision keeps the event (a staff resolve deletes it, D-22)
        advanceStage(test, org, f.id, 'Completed');
        expect(test.db.CalendarEvent.id.find(eventId)).toBeTruthy(); // the event still exists
        expect(ids()).not.toContain(eventId);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// L93: calendar and roster writes use the per-user allowance
// ════════════════════════════════════════════════════════════════════════════

describe('A122(4), L93: calendar and roster writes count on the per-user allowance (20 calls per 10 s)', () => {
    it('A122(4) L93: the 21st calendar call inside 10 s is refused with the neutral text; after the window it is accepted', () => {
        const test = newHarness();
        const u = verified(test, 'cal');
        const other = verified(test, 'other');
        tx(test, u, (ctx) => M.save_calendar(ctx, { targetUserId: other.userId }));
        clearMembershipCount(test, u);
        const toggle = (isVisible: boolean) => (ctx: any) => M.toggle_calendar_visibility(ctx, { targetUserId: other.userId, isVisible });
        for (let i = 0; i < 20; i++) tx(test, u, toggle(i % 2 === 0));
        expect(rejection(test, u, toggle(true))).toBe(RATE_TEXT);
        advance(test, 10_001);
        tx(test, u, toggle(true));
        expect([...test.db.SavedCalendar.by_user_and_target.filter([u.userId, other.userId])][0].isVisible).toBe(true);
    });

    it('A122(4) L93: the 21st roster write inside 10 s is refused with the neutral text; after the window it is accepted', () => {
        const test = newHarness();
        const u = verified(test, 'roster');
        const acct = createAccount(test, u, '800000001', 'Main');
        clearMembershipCount(test, u);
        const rename = (label: string) => (ctx: any) =>
            M.update_hsr_account(ctx, { hsrAccountId: acct, displayLabel: label, isRosterPublic: true, isRatingPublic: true });
        for (let i = 0; i < 20; i++) tx(test, u, rename(`Main ${i}`));
        expect(rejection(test, u, rename('Blocked'))).toBe(RATE_TEXT);
        expect(test.db.HsrAccount.id.find(acct)!.displayLabel).toBe('Main 19');
        advance(test, 10_001);
        tx(test, u, rename('Later'));
        expect(test.db.HsrAccount.id.find(acct)!.displayLabel).toBe('Later');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Fix pass F2 / F11: the clean-up spares the call's own target
// ════════════════════════════════════════════════════════════════════════════

describe('A122(22), L86 fix pass F2: a user still edits or deletes their own old event or expired slot', () => {
    it('A122(22) L86 F2: delete_calendar_event on the caller\'s event ended 91 days ago succeeds and the row is gone', () => {
        const test = newHarness();
        const u = verified(test, 'cal');
        const old = createEvent(test, u, { startMs: HOUR_MS, endMs: 2 * HOUR_MS });
        advance(test, 91 * DAY_MS);
        tx(test, u, (ctx) => M.delete_calendar_event(ctx, { eventId: old }));
        expect(test.db.CalendarEvent.id.find(old)).toBeFalsy();
    });

    it('A122(22) L86 F2: update_calendar_event of that old event\'s title succeeds (A79: endAt unchanged); another old event of the caller is cleaned', () => {
        const test = newHarness();
        const u = verified(test, 'cal');
        const old = createEvent(test, u, { startMs: HOUR_MS, endMs: 2 * HOUR_MS });
        const other = createEvent(test, u, { startMs: HOUR_MS, endMs: 2 * HOUR_MS });
        const row = test.db.CalendarEvent.id.find(old)!;
        advance(test, 91 * DAY_MS);
        tx(test, u, (ctx) => M.update_calendar_event(ctx, {
            eventId: old, title: 'Renamed', description: '',
            startAt: row.startAt.microsSinceUnixEpoch.toString(), endAt: row.endAt.microsSinceUnixEpoch.toString(),
        }));
        expect(test.db.CalendarEvent.id.find(old)!.title).toBe('Renamed');
        expect(test.db.CalendarEvent.id.find(other)).toBeFalsy();
    });

    it('A122(22) L86 F2: delete_availability_slot on the caller\'s slot expired 9 days ago succeeds and the row is gone', () => {
        const test = newHarness();
        const u = verified(test, 'cal');
        const old = addSlot(test, u, { startMs: HOUR_MS, endMs: 2 * HOUR_MS });
        advance(test, 9 * DAY_MS);
        tx(test, u, (ctx) => M.delete_availability_slot(ctx, { slotId: old }));
        expect(slotsOf(test, u)).toEqual([]);
    });

    it('A122(4) L93 F11: the allowance is counted before the clean-up: a refused call deletes nothing', () => {
        const test = newHarness();
        const u = verified(test, 'cal');
        const other = verified(test, 'other');
        const old = createEvent(test, u, { startMs: HOUR_MS, endMs: 2 * HOUR_MS });
        advance(test, 91 * DAY_MS);
        const row = test.db.UserRateState.userId.find(u.userId)!;
        test.db.UserRateState.userId.update({ ...row, membershipWindowStart: test.clock.now(), membershipCount: 20 });
        expect(rejection(test, u, (ctx) => M.save_calendar(ctx, { targetUserId: other.userId }))).toBe(RATE_TEXT);
        expect(test.db.CalendarEvent.id.find(old)).toBeTruthy();
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Gap 9. A122(22), L86 (S10s re-review N5)
// ════════════════════════════════════════════════════════════════════════════

describe('Gap 9, A122(22) L86: the clean-up spares the call\'s own old target (S10s re-review N5)', () => {
    it('A122(22) L86 (N5): update_availability_slot on the caller\'s slot expired 9 days ago succeeds and moves it; another expired slot of the caller is cleaned', () => {
        const test = newHarness();
        const u = verified(test, 'cal-slot');
        const target = addSlot(test, u, { startMs: HOUR_MS, endMs: 2 * HOUR_MS });
        const other = addSlot(test, u, { startMs: HOUR_MS, endMs: 3 * HOUR_MS });
        advance(test, 9 * DAY_MS);
        const startAt = fromNow(test, DAY_MS);
        const endAt = fromNow(test, DAY_MS + 2 * HOUR_MS);

        tx(test, u, (ctx) => M.update_availability_slot(ctx, {
            slotId: target, startAt, endAt, kind: 'Available', // T-S10ac (A157(3)): recurrence arguments removed
        }));

        const slots = slotsOf(test, u);
        expect(slots.map((sl) => sl.id)).toEqual([target]);
        expect(slots[0].startAt.microsSinceUnixEpoch.toString()).toBe(startAt);
        expect(other).not.toBe(target);
    });

    it('A122(22) L86 (N5): invite_to_event on the caller\'s event ended 91 days ago succeeds; another old event of the caller is cleaned', () => {
        const test = newHarness();
        const u = verified(test, 'cal-inv');
        const friend = verified(test, 'cal-friend');
        const target = createEvent(test, u, { startMs: HOUR_MS, endMs: 2 * HOUR_MS });
        const other = createEvent(test, u, { startMs: HOUR_MS, endMs: 2 * HOUR_MS });
        advance(test, 91 * DAY_MS);

        tx(test, u, (ctx) => M.invite_to_event(ctx, { eventId: target, inviteeUserId: friend.userId }));

        expect(test.db.CalendarEvent.id.find(target)).toBeTruthy();
        expect(invite(test, target, friend.userId)).toMatchObject({ inviteStatus: { tag: 'Pending' } });
        expect(test.db.CalendarEvent.id.find(other)).toBeFalsy();
    });
});
