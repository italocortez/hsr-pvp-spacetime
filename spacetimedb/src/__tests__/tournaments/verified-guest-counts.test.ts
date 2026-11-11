// Tournaments: guest counts under requireVerified, the live-game guard, invites and minimumMmr 0.
// Decisions: A113
// Contracts: docs/tournament/contract.md, docs/brackets/contract.md
// From S10q (s10q-gap-coverage.test.ts).
import { describe, expect, it } from 'vitest';
import {
    M,
    advance,
    expectReject,
    guest,
    lobbyRow,
    member,
    newHarness,
    setupLobby,
    tx,
    type Actor,
} from '../fixtures/harness';
import {
    createTournament,
    enrolled,
    host,
    openTournament,
    register,
    tRow,
    updateBody,
    verified,
} from '../fixtures/tournament-builders';
import { createEvent, invite } from '../fixtures/calendar-roster-rating-builders';
import {
    addSecondIdentity,
    existingUser,
    mappedUser,
    signIn,
    soloLive,
} from '../fixtures/guest-sign-in-builders';

// ─── Texts ───────────────────────────────────────────────────────────────────

const FINISH_TEXT = 'Finish your current game before signing in to an existing account.';
const guestsText = (n: number) => `These settings require verified accounts, and ${n} guest player(s) are registered.`;

const signInBody = (g: Actor, providerId: string) => (ctx: any) => M.server_link_provider(ctx, {
    callerIdentityHex: g.identity.toHexString(), provider: 'discord', providerId, providerName: 'ignored',
});

// ════════════════════════════════════════════════════════════════════════════
// Gap 3. A113 (S10m review F5)
// ════════════════════════════════════════════════════════════════════════════

describe('Gap 3, A113: guest counts, the live-game guard, invites, minimumMmr 0 (S10m review F5)', () => {
    /** An open solo tournament with a verified player and a guest the organizer has disqualified. */
    function dqGuestCup() {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { teamSize: 1, maxParticipants: 8 });
        const g = guest(test, 'g-dq');
        const v = verified(test, 'dq-v');
        register(test, g, id);
        register(test, v, id);
        tx(test, org, (ctx) => M.dq_participant(ctx, { tournamentId: id, userId: g.userId, reason: 'test' }));
        expect(enrolled(test, id, g.userId)!.status.tag).toBe('Disqualified');
        return { test, org, id, g };
    }
    const GUESTS_1_FULL = `${guestsText(1)} Remove them first, or keep the settings that allow guests.`;

    it('A144, A113(2) (F5: the Disqualified exclusion): a tournament whose only guest enrolment is Disqualified accepts the change that turns requireVerified on; the disqualified entry stays, still Disqualified', () => {
        const { test, org, id, g } = dqGuestCup();
        const dqBefore = enrolled(test, id, g.userId)!;
        expect(tRow(test, id)).toMatchObject({ requireRoster: false, requireVerified: false });

        tx(test, org, updateBody(test, id, { requireRoster: true }));

        expect(tRow(test, id)).toMatchObject({ requireRoster: true, requireVerified: true });
        expect(enrolled(test, id, g.userId)).toEqual(dqBefore);
        expect(enrolled(test, id, g.userId)!.status.tag).toBe('Disqualified');
    });

    it('A144, A113(2), A118 (F5: the Disqualified exclusion, neighbour): with a Disqualified guest and one other guest, the change is refused naming 1 guest player; after reject_participant removes the other guest it is accepted', () => {
        const { test, org, id, g } = dqGuestCup();
        const o = guest(test, 'g-other');
        register(test, o, id);
        expect(enrolled(test, id, o.userId)!.status.tag).not.toBe('Disqualified');
        const before = tRow(test, id);

        expectReject(test, org, updateBody(test, id, { requireRoster: true }), GUESTS_1_FULL);
        expect(tRow(test, id)).toEqual(before);

        tx(test, org, (ctx) => M.reject_participant(ctx, { tournamentId: id, userId: o.userId }));
        expect(enrolled(test, id, o.userId)).toBeUndefined();

        tx(test, org, updateBody(test, id, { requireRoster: true }));
        expect(tRow(test, id)).toMatchObject({ requireRoster: true, requireVerified: true });
        expect(enrolled(test, id, g.userId)!.status.tag).toBe('Disqualified');
    });

    it('A113(2) (F5): a waitlisted guest and a guest awaiting approval are guest enrolments: the change is refused with the count', () => {
        const test = newHarness();
        const org = host(test);
        const waitId = openTournament(test, org, { teamSize: 1, maxParticipants: 2, waitlistEnabled: true });
        for (const n of ['w1', 'w2']) register(test, verified(test, n), waitId);
        const gw = guest(test, 'g-waitlisted');
        register(test, gw, waitId);
        expect(enrolled(test, waitId, gw.userId)!.isWaitlisted).toBe(true);
        expectReject(test, org, updateBody(test, waitId, { requireRoster: true }), guestsText(1));
        expect(tRow(test, waitId).requireRoster).toBe(false);

        const approvalId = openTournament(test, org, { teamSize: 1, requireApproval: true, name: 'Approval cup' } as any);
        const ga = guest(test, 'g-awaiting');
        register(test, ga, approvalId);
        expect(enrolled(test, approvalId, ga.userId)!.approvedByToAt).toBeUndefined();
        expectReject(test, org, updateBody(test, approvalId, { requireVerified: true }), guestsText(1));
        expect(tRow(test, approvalId).requireVerified).toBe(false);
    });

    /** The guest holds an entry and sits as BluePlayer in a started casual 2v2 lobby (Drafting). */
    function seatedGuest() {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { teamSize: 1 });
        const g = guest(test, 'g');
        register(test, g, id);
        const s = setupLobby(test, { seats: [['g', 'BluePlayer'], ['b2', 'BluePlayer'], ['r1', 'RedPlayer'], ['r2', 'RedPlayer']], actors: { g } });
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('Drafting');
        return { test, id, g, guestId: g.userId, lobbyId: s.lobbyId, e: existingUser(test, 'e') };
    }

    it('A113(4), A98 (F5: an away seat): a guest who left a live game (row away, leftAt set) still holds the seat: the sign-in is refused and nothing changes', () => {
        const { test, id, g, guestId, lobbyId, e } = seatedGuest();
        tx(test, g, (ctx) => M.leave_lobby(ctx, { lobbyId }));
        expect(member(test, lobbyId, guestId)).toMatchObject({ lobbySlot: { tag: 'BluePlayer' } });
        expect(member(test, lobbyId, guestId)!.leftAt).toBeDefined();
        expect(member(test, lobbyId, guestId)!.abandonedAt).toBeUndefined();
        const entryBefore = enrolled(test, id, guestId);

        expectReject(test, 'internal', signInBody(g, e.providerId), FINISH_TEXT);

        expect(mappedUser(test, g)).toBe(guestId);
        expect(test.db.User.id.find(guestId)!.isGuest).toBe(true);
        expect(enrolled(test, id, guestId)).toEqual(entryBefore);
        expect(enrolled(test, id, e.a.userId)).toBeFalsy();
    });

    it('pins current behaviour (row silent): A113(4) (F5: a second identity): a seated guest who keeps a second identity is not deleted by the sign-in, so it is accepted; the guest keeps its seat and its entry, the signing-in identity maps to the existing user', () => {
        const { test, id, g, guestId, lobbyId, e } = seatedGuest();
        addSecondIdentity(test, guestId, 'g-second-device');
        const seatBefore = member(test, lobbyId, guestId);
        const entryBefore = enrolled(test, id, guestId);

        tx(test, 'internal', signInBody(g, e.providerId));

        expect(mappedUser(test, g)).toBe(e.a.userId);
        expect(test.db.User.id.find(guestId)!.isGuest).toBe(true);
        expect(member(test, lobbyId, guestId)).toEqual(seatBefore);
        expect(enrolled(test, id, guestId)).toEqual(entryBefore);
        expect(enrolled(test, id, e.a.userId)).toBeFalsy();
    });

    it('A113(5) (F5: an invite already responded to): the re-pointed invite keeps its status and respondedAt (the guest\'s response is written on the row: respond_to_invite refuses guests)', () => {
        const test = newHarness();
        const org = host(test);
        const g = guest(test, 'g-inv');
        const v = verified(test, 'inv-v');
        const { id, match } = soloLive(test, org, [g, v], g);
        const eventId = createEvent(test, org, { bracketMatchId: match.id });
        const pending = invite(test, eventId, g.userId)!;
        expect(pending.inviteStatus.tag).toBe('Pending');
        advance(test, 5_000);
        const respondedAt = test.clock.now();
        test.db.CalendarEventInvite.delete(pending);
        test.db.CalendarEventInvite.insert({ ...pending, inviteStatus: { tag: 'Accepted' } as any, respondedAt } as any);
        advance(test, 5_000);
        const e = existingUser(test, 'e-inv');

        const guestId = signIn(test, g, e.providerId);

        expect(enrolled(test, id, e.a.userId)).toBeTruthy();
        expect(invite(test, eventId, guestId)).toBeFalsy();
        const moved = invite(test, eventId, e.a.userId)!;
        expect(moved.inviteStatus.tag).toBe('Accepted');
        expect(moved.respondedAt).toEqual(respondedAt);
    });

    it('pins current behaviour (row silent): A113(1) (F5: minimumMmr 0): a floor of 0 is stored as no floor and does not force requireVerified, at create and at an update while a guest is enrolled', () => {
        const test = newHarness();
        const org = host(test);
        const created = createTournament(test, org, { minimumMmr: 0, requireVerified: false });
        expect(tRow(test, created)).toMatchObject({ requireVerified: false });
        expect(tRow(test, created).minimumMmr).toBeUndefined();

        const id = openTournament(test, org, { teamSize: 1, name: 'Floor cup' } as any);
        const g = guest(test, 'g-floor0');
        register(test, g, id);
        tx(test, org, updateBody(test, id, { minimumMmr: 0, requireVerified: false }));
        expect(tRow(test, id).requireVerified).toBe(false);
        expect(tRow(test, id).minimumMmr).toBeUndefined();
        expect(enrolled(test, id, g.userId)).toBeTruthy();
    });
});
