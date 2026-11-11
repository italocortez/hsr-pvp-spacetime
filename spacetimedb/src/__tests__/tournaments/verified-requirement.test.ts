// Tournaments: requireVerified, guest entries and guest counts, the live-game sign-in guard, invites that follow a
//   moved entry, and minimumMmr 0.
// Decisions: A113
// Contracts: docs/tournament/contract.md, docs/brackets/contract.md
// From S10m, S10q (s10m-verified-rules.test.ts, s10q-gap-coverage.test.ts); merged by T-REORG2.
//
// T-S10m: in-memory tests for step S10m (DECISIONS.md A113): settings under which a guest cannot play force a
// tournament's requireVerified on (create and update); turning it on is refused while guests hold an entry; signing in
// to an existing account (A112) is refused while the guest plays a live game; a moved entry takes the guest's match
// calendar invites along; a guest cannot be a tournament assistant. server_link_provider runs as the owner ('internal',
// linkDiscord). Rows set directly through `test.db` are written outside any transaction. Nothing reaches maincloud.
//
// Titles starting "pins current behaviour (row silent)": the decision row says nothing about the case, so the test
// records today's behaviour rather than a rule; the owner accepted these pins (A145). A later decision on the case
// replaces the pin with a rule test.
import { describe, expect, it } from 'vitest';
import {
    M,
    expectReject,
    guest,
    linkDiscord,
    lobbyRow,
    newHarness,
    now,
    setupLobby,
    tx,
    type Actor,
    type Harness,
    type SlotTag,
    advance,
    member,
} from '../fixtures/harness';
import { host, verified, existingUser, signIn, mappedUser, addSecondIdentity } from '../fixtures/identity';
import { createEvent, invite, seedInvite } from '../fixtures/calendar';
import {
    TOURNAMENT_ARGS,
    advanceStage,
    assignAssistant,
    createTournament,
    enrolled,
    membership,
    openTournament,
    register,
    seedAndGenerate,
    bracketRows,
    tRow,
    updateBody,
    type TournamentArgs,
    guestsText,
    soloLive,
} from '../fixtures/tournaments';

// ─── Builders ────────────────────────────────────────────────────────────────

const VERIFIED_TEXT = 'This tournament requires a verified account. Link your Discord first.';
const FINISH_TEXT = 'Finish your current game before signing in to an existing account.';
const ASSISTANT_TEXT = 'A tournament assistant must be a verified user.';

/** The five A113(1) triggers, each as the create_tournament overrides that turn it on (everything else "no gates"). */
const TRIGGERS: Array<[string, Partial<TournamentArgs>]> = [
    ['countTowardsMmr', { countTowardsMmr: true }],
    ['requireRoster', { requireRoster: true }],
    ['minimumMmr', { minimumMmr: 1200 }],
    ['requireOwnership', { requireOwnership: true }],
    ['rosterVisibility OpenRoster', { rosterVisibility: 'OpenRoster' }],
    ['rosterVisibility ClosedWithRating', { rosterVisibility: 'ClosedWithRating' }],
];

/** A guest with an entry in a solo tournament (no gates). */
function enrolledGuest(test: Harness, org: Actor, sub: string): { g: Actor; id: number } {
    const id = openTournament(test, org, { teamSize: 1 });
    const g = guest(test, sub);
    register(test, g, id);
    return { g, id };
}

const setLobbyStage = (test: Harness, lobbyId: number, stage: string) =>
    test.db.Lobby.id.update({ ...lobbyRow(test, lobbyId), stage: { tag: stage } as any });

// ════════════════════════════════════════════════════════════════════════════
// A113(1): the forcing settings
// ════════════════════════════════════════════════════════════════════════════

describe('A113(1): settings under which a guest cannot play force requireVerified', () => {
    for (const [label, over] of TRIGGERS) {
        it(`A113(1): ${label} forces requireVerified at create, whatever is sent`, () => {
            const test = newHarness();
            const org = host(test);
            const id = createTournament(test, org, { ...over, requireVerified: false });
            expect(tRow(test, id).requireVerified).toBe(true);
        });

        it(`A113(1): ${label} forces requireVerified at update, whatever is sent`, () => {
            const test = newHarness();
            const org = host(test);
            if (over.countTowardsMmr) {
                // countTowardsMmr is fixed at creation: a rated tournament keeps requireVerified on through an update.
                const id = createTournament(test, org, { countTowardsMmr: true });
                tx(test, org, updateBody(test, id, { requireVerified: false }));
                expect(tRow(test, id).requireVerified).toBe(true);
                return;
            }
            const id = createTournament(test, org);
            expect(tRow(test, id).requireVerified).toBe(false);
            tx(test, org, updateBody(test, id, { ...over, requireVerified: false }));
            expect(tRow(test, id).requireVerified).toBe(true);
        });
    }

    it('A113(1): with none of the triggers the organizer\'s choice is kept, true and false, at create and at update', () => {
        const test = newHarness();
        const org = host(test);
        expect(TOURNAMENT_ARGS.rosterVisibility).toBe('ClosedNoRating');
        const off = createTournament(test, org, { requireVerified: false });
        const on = createTournament(test, org, { requireVerified: true });
        expect(tRow(test, off).requireVerified).toBe(false);
        expect(tRow(test, on).requireVerified).toBe(true);

        tx(test, org, updateBody(test, off, { requireVerified: true }));
        tx(test, org, updateBody(test, on, { requireVerified: false }));
        expect(tRow(test, off).requireVerified).toBe(true);
        expect(tRow(test, on).requireVerified).toBe(false);
    });

    it('A113(1): once forced, a guest cannot register; a verified player can', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { rosterVisibility: 'OpenRoster', requireVerified: false });
        const g = guest(test, 'g');
        expectReject(test, g, (ctx) => M.register_for_tournament(ctx, { tournamentId: id }), VERIFIED_TEXT);
        expect(enrolled(test, id, g.userId)).toBeFalsy();
        const v = verified(test, 'v');
        register(test, v, id);
        expect(enrolled(test, id, v.userId)).toBeTruthy();
    });
});

// ════════════════════════════════════════════════════════════════════════════
// A113(2): turning it on while guests are enrolled
// ════════════════════════════════════════════════════════════════════════════

describe('A113(2): a change that turns requireVerified on is refused while guests are enrolled', () => {
    function withGuests() {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { teamSize: 1, maxParticipants: 8 });
        const g1 = guest(test, 'g1');
        const g2 = guest(test, 'g2');
        const v = verified(test, 'v');
        for (const p of [g1, g2, v]) register(test, p, id);
        return { test, org, id, g1, g2, v };
    }

    it('A113(2): directly (requireVerified sent true) and through a forcing setting: rejected with the guest count, nothing changed', () => {
        const { test, org, id } = withGuests();
        const before = tRow(test, id);
        expectReject(test, org, updateBody(test, id, { requireVerified: true }), guestsText(2));
        expectReject(test, org, updateBody(test, id, { requireRoster: true, name: 'Renamed' }), guestsText(2));
        expectReject(test, org, updateBody(test, id, { rosterVisibility: 'ClosedWithRating' }), guestsText(2));
        expect(tRow(test, id)).toEqual(before);
    });

    it('A113(2): after the guests are removed the same change passes', () => {
        const { test, org, id, g1, g2 } = withGuests();
        tx(test, g1, (ctx) => M.withdraw_from_tournament(ctx, { tournamentId: id }));
        expectReject(test, org, updateBody(test, id, { requireRoster: true }), guestsText(1));
        tx(test, g2, (ctx) => M.withdraw_from_tournament(ctx, { tournamentId: id }));
        tx(test, org, updateBody(test, id, { requireRoster: true }));
        expect(tRow(test, id)).toMatchObject({ requireRoster: true, requireVerified: true });
    });

    it('A113(2): an update that does not change the effective value is not blocked by existing guests (off stays off; on stays on)', () => {
        const { test, org, id } = withGuests();
        tx(test, org, updateBody(test, id, { name: 'Renamed', requireVerified: false }));
        expect(tRow(test, id)).toMatchObject({ name: 'Renamed', requireVerified: false });

        // A row with requireVerified already on and guests enrolled (data written before A113): a forcing change
        // keeps the value and is not refused.
        test.db.Tournament.id.update({ ...tRow(test, id), requireVerified: true });
        tx(test, org, updateBody(test, id, { name: 'Again', rosterVisibility: 'OpenRoster' }));
        expect(tRow(test, id)).toMatchObject({ name: 'Again', requireVerified: true });
    });
});

// ════════════════════════════════════════════════════════════════════════════
// A113(4): sign-in to an existing account during a live game
// ════════════════════════════════════════════════════════════════════════════

describe('A113(4): signing in to an existing account is refused while the guest plays a live game', () => {
    /** The guest has a tournament entry and sits in a started lobby (Drafting) in `slot`. */
    function seated(slot: SlotTag) {
        const test = newHarness();
        const org = host(test);
        const { g, id } = enrolledGuest(test, org, 'g');
        const seats: Array<[string, SlotTag]> = [['b1', 'BluePlayer'], ['b2', 'BluePlayer'], ['r1', 'RedPlayer'], ['r2', 'RedPlayer']];
        let s;
        if (slot === 'Spectator') {
            s = setupLobby(test, { seats });
            // A new join after the start takes a Spectator seat (joinAsSpectator does the same for a fresh guest).
            tx(test, g, (ctx) => M.join_lobby(ctx, { lobbyId: s!.lobbyId, joinCode: '', password: '' }));
            expect([...test.db.LobbyMember.by_lobby_and_user.filter([s.lobbyId, g.userId])][0]!.lobbySlot.tag).toBe('Spectator');
        } else if (slot === 'BlueCoach') {
            s = setupLobby(test, { seats: [...seats, ['g', 'BlueCoach']], actors: { g } });
        } else {
            s = setupLobby(test, { seats: [['g', 'BluePlayer'], ['b2', 'BluePlayer'], ['r1', 'RedPlayer'], ['r2', 'RedPlayer']], actors: { g } });
        }
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('Drafting');
        const e = existingUser(test, 'e', { uids: ['e-acc'] });
        return { test, org, id, g, guestId: g.userId, lobbyId: s.lobbyId, e };
    }

    for (const stage of ['Drafting', 'Equipping', 'Scoring']) {
        it(`A113(4): a seated player in ${stage}: rejected; the guest, its entry and the identity mapping are unchanged`, () => {
            const { test, id, g, guestId, lobbyId, e } = seated('BluePlayer');
            if (stage !== 'Drafting') setLobbyStage(test, lobbyId, stage);
            const entryBefore = enrolled(test, id, guestId);
            const userBefore = test.db.User.id.find(guestId);

            expectReject(test, 'internal', (ctx) => M.server_link_provider(ctx, {
                callerIdentityHex: g.identity.toHexString(), provider: 'discord', providerId: e.providerId, providerName: 'ignored',
            }), FINISH_TEXT);

            expect(test.db.User.id.find(guestId)).toEqual(userBefore);
            expect(userBefore!.isGuest).toBe(true);
            expect(enrolled(test, id, guestId)).toEqual(entryBefore);
            expect(enrolled(test, id, e.a.userId)).toBeFalsy();
            expect(mappedUser(test, g)).toBe(guestId);
            expect([...test.db.LobbyMember.by_lobby_and_user.filter([lobbyId, guestId])]).toHaveLength(1);
        });
    }

    it('A113(4): as a spectator in Drafting: accepted and the entry moves', () => {
        const { test, id, g, guestId, e } = seated('Spectator');
        signIn(test, g, e.providerId);
        expect(mappedUser(test, g)).toBe(e.a.userId);
        expect(test.db.User.id.find(guestId)).toBeFalsy();
        expect(enrolled(test, id, e.a.userId)).toBeTruthy();
    });

    it('A113(4): as a coach in Drafting: accepted and the entry moves', () => {
        const { test, id, g, guestId, e } = seated('BlueCoach');
        signIn(test, g, e.providerId);
        expect(mappedUser(test, g)).toBe(e.a.userId);
        expect(test.db.User.id.find(guestId)).toBeFalsy();
        expect(enrolled(test, id, e.a.userId)).toBeTruthy();
    });

    it('A113(4): a seated player in a Waiting lobby: accepted and the entry moves', () => {
        const test = newHarness();
        const org = host(test);
        const { g, id } = enrolledGuest(test, org, 'g');
        const guestId = g.userId;
        const s = setupLobby(test, { seats: [['g', 'BluePlayer'], ['r1', 'RedPlayer']], actors: { g }, noStart: true });
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('Waiting');
        const e = existingUser(test, 'e', { uids: ['e-acc'] });
        signIn(test, g, e.providerId);
        expect(mappedUser(test, g)).toBe(e.a.userId);
        expect(test.db.User.id.find(guestId)).toBeFalsy();
        expect(enrolled(test, id, e.a.userId)).toBeTruthy();
    });

    it('A113(4): a seated player in an AwaitingResult lobby: accepted and the entry moves', () => {
        const { test, id, g, guestId, lobbyId, e } = seated('BluePlayer');
        setLobbyStage(test, lobbyId, 'AwaitingResult');
        signIn(test, g, e.providerId);
        expect(mappedUser(test, g)).toBe(e.a.userId);
        expect(test.db.User.id.find(guestId)).toBeFalsy();
        expect(enrolled(test, id, e.a.userId)).toBeTruthy();
    });

    it('A113(4): the first-time link (the guest upgraded in place) during a live game is accepted', () => {
        const { test, id, g, guestId, lobbyId } = seated('BluePlayer');
        linkDiscord(test, g, 'pid-fresh', 'Fresh');
        expect(g.userId).toBe(guestId);
        expect(test.db.User.id.find(guestId)!.isGuest).toBe(false);
        expect(enrolled(test, id, guestId)).toBeTruthy();
        expect([...test.db.LobbyMember.by_lobby_and_user.filter([lobbyId, guestId])]).toHaveLength(1);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// A113(5): calendar invites follow the moved entry
// ════════════════════════════════════════════════════════════════════════════

describe('A113(5): the guest\'s match calendar invites follow the moved entry', () => {
    const HOUR = 3_600_000_000n;
    function eventArgs(test: Harness, bracketMatchId: number, inviteeUserIds: number[] = []) {
        const start = now(test) + HOUR;
        return {
            title: 'Match', description: '', startAt: start.toString(), endAt: (start + HOUR).toString(),
            bracketMatchId, inviteeUserIds: inviteeUserIds.join(','),
        };
    }
    const eventOf = (test: Harness, bracketMatchId: number) => [...test.db.CalendarEvent.bracket_match_id.filter(bracketMatchId)][0]!;
    const inviteOf = (test: Harness, eventId: number, userId: number) =>
        [...test.db.CalendarEventInvite.by_event_and_invitee.filter([eventId, userId])][0];

    /** A solo tournament in InProgress whose first match is the guest against a verified player. */
    function guestMatch(test: Harness, org: Actor, sub: string) {
        const id = openTournament(test, org, { teamSize: 1 });
        const g = guest(test, sub);
        const v = verified(test, `${sub}-v`);
        register(test, g, id);
        register(test, v, id);
        advanceStage(test, org, id, 'Seeding');
        seedAndGenerate(test, org, id);
        advanceStage(test, org, id, 'InProgress');
        const gTeam = membership(test, id, g.userId)!.teamId;
        const match = bracketRows(test, id).find((m) => m.team1Id === gTeam || m.team2Id === gTeam)!;
        return { id, g, v, match };
    }

    it('A113(5): after the move the existing user holds the invite (status kept) and the guest\'s is gone', () => {
        const test = newHarness();
        const org = host(test);
        const { id, g, match } = guestMatch(test, org, 'g');
        tx(test, org, (ctx) => M.create_calendar_event(ctx, eventArgs(test, match.id)));
        const event = eventOf(test, match.id);
        const guestId = g.userId;
        const before = inviteOf(test, event.id, guestId)!;
        expect(before).toBeTruthy();
        const countBefore = [...test.db.CalendarEventInvite.event_id.filter(event.id)].length;
        const e = existingUser(test, 'e', { uids: ['e-acc'] });

        signIn(test, g, e.providerId);

        expect(enrolled(test, id, e.a.userId)).toBeTruthy();
        expect(inviteOf(test, event.id, guestId)).toBeFalsy();
        expect(inviteOf(test, event.id, e.a.userId)).toMatchObject({ inviteStatus: before.inviteStatus, createdDate: before.createdDate });
        expect([...test.db.CalendarEventInvite.event_id.filter(event.id)]).toHaveLength(countBefore);
    });

    it('A113(5): no duplicate when the existing user was already invited to the event', () => {
        const test = newHarness();
        const org = host(test);
        const { g, match } = guestMatch(test, org, 'g');
        const e = existingUser(test, 'e', { uids: ['e-acc'] });
        tx(test, org, (ctx) => M.create_calendar_event(ctx, eventArgs(test, match.id, [e.a.userId])));
        const event = eventOf(test, match.id);
        const guestId = g.userId;
        const countBefore = [...test.db.CalendarEventInvite.event_id.filter(event.id)].length;

        signIn(test, g, e.providerId);

        expect(inviteOf(test, event.id, guestId)).toBeFalsy();
        expect([...test.db.CalendarEventInvite.by_event_and_invitee.filter([event.id, e.a.userId])]).toHaveLength(1);
        expect([...test.db.CalendarEventInvite.event_id.filter(event.id)]).toHaveLength(countBefore - 1);
    });

    it('A113(5): invites to another tournament\'s match event and to a personal event are not moved', () => {
        const test = newHarness();
        const org = host(test);
        const { g, match } = guestMatch(test, org, 'g');
        tx(test, org, (ctx) => M.create_calendar_event(ctx, eventArgs(test, match.id)));

        // Another tournament, the guest not enrolled there, invited by hand to its match event.
        const other = openTournament(test, org, { teamSize: 1 });
        register(test, verified(test, 'o1'), other);
        register(test, verified(test, 'o2'), other);
        advanceStage(test, org, other, 'Seeding');
        seedAndGenerate(test, org, other);
        advanceStage(test, org, other, 'InProgress');
        const otherMatch = bracketRows(test, other).find((m) => m.team1Id !== undefined && m.team2Id !== undefined)!;
        // T-S10ac (A157(7)): a guest can no longer be invited by hand; both invites are seeded as pre-A157 rows.
        tx(test, org, (ctx) => M.create_calendar_event(ctx, eventArgs(test, otherMatch.id)));
        const otherEvent = eventOf(test, otherMatch.id);
        seedInvite(test, otherEvent.id, g.userId, org.userId);
        // A personal event of the organizer with the guest invited.
        tx(test, org, (ctx) => M.create_calendar_event(ctx, { ...eventArgs(test, 0), title: 'Personal' }));
        const personal = [...test.db.CalendarEvent.organizer_id.filter(org.userId)].find((ev) => ev.bracketMatchId === undefined)!;
        seedInvite(test, personal.id, g.userId, org.userId);
        const guestId = g.userId;
        expect(inviteOf(test, otherEvent.id, guestId)).toBeTruthy();
        expect(inviteOf(test, personal.id, guestId)).toBeTruthy();
        const e = existingUser(test, 'e', { uids: ['e-acc'] });

        signIn(test, g, e.providerId);

        expect(inviteOf(test, eventOf(test, match.id).id, e.a.userId)).toBeTruthy();
        expect(inviteOf(test, otherEvent.id, e.a.userId)).toBeFalsy();
        expect(inviteOf(test, personal.id, e.a.userId)).toBeFalsy();
        // The guest is deleted, its remaining invites with it.
        expect([...test.db.CalendarEventInvite.invitee_user_id.filter(guestId)]).toEqual([]);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// A113(6): tournament assistants
// ════════════════════════════════════════════════════════════════════════════

describe('A113(6): a guest cannot be made a tournament assistant', () => {
    it('A113(6): a guest target is rejected and no row is written; a verified user is assigned', () => {
        const test = newHarness();
        const org = host(test);
        const id = createTournament(test, org);
        const g = guest(test, 'g');
        expect(() => assignAssistant(test, org, id, g, { participants: true })).toThrow(ASSISTANT_TEXT);
        expect([...test.db.TournamentAssistant.by_tournament_and_user.filter([id, g.userId])]).toEqual([]);
        const v = verified(test, 'v');
        assignAssistant(test, org, id, v, { participants: true });
        expect([...test.db.TournamentAssistant.by_tournament_and_user.filter([id, v.userId])]).toHaveLength(1);
    });
});

// ─── Texts ───────────────────────────────────────────────────────────────────

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
