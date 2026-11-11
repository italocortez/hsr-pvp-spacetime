// Tournaments: reject_participant removes a guest's approved entry as a withdrawal, invites included.
// Decisions: A118
// Contracts: docs/tournament/contract.md, docs/brackets/contract.md
// From S10o, S10q (s10o-autopick-guest-entry.test.ts, s10q-gap-coverage.test.ts).
import { describe, expect, it } from 'vitest';
import { M, expectReject, guest, linkDiscord, newHarness, tx, type Actor } from '../fixtures/harness';
import { host, verified } from '../fixtures/identity';
import { createEvent, invite, seedInvite } from '../fixtures/calendar';
import {
    advanceStage,
    assignAssistant,
    bracketRows,
    enrolled,
    generateBracket,
    makeTeam,
    membersOf,
    membership,
    openTournament,
    register,
    seedAndGenerate,
    seedBracket,
    tRow,
    teamRow,
    updateBody,
    guestsText,
} from '../fixtures/tournaments';

const APPROVED = 'Participant is already approved; disqualify them instead.';
const GENERATED = 'Bracket generated; use stand-ins.';
const NO_PERMISSION = 'This action needs the participants permission.';

// ════════════════════════════════════════════════════════════════════════════
// A118: staff remove a guest's approved entry before the bracket
// ════════════════════════════════════════════════════════════════════════════

const reject = (tournamentId: number, userId: number) => (ctx: any) => M.reject_participant(ctx, { tournamentId, userId });

describe('A118: reject_participant removes a guest\'s approved entry as a withdrawal before the bracket exists', () => {
    it('A118: solo guest: no Disqualified row, the empty solo team is deleted, the spot is freed for a third player', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { teamSize: 1, maxParticipants: 2 });
        const g = guest(test, 'g');
        const v = verified(test, 'v');
        register(test, g, id);
        register(test, v, id);
        const soloTeam = membership(test, id, g.userId)!.teamId;
        expect(enrolled(test, id, g.userId).approvedByToAt).toBeDefined();

        tx(test, org, reject(id, g.userId));
        expect(enrolled(test, id, g.userId)).toBeUndefined(); // no row at all, so no Disqualified row
        expect(membership(test, id, g.userId)).toBeUndefined();
        expect(teamRow(test, soloTeam)).toBeFalsy(); // Registration: the empty solo team is deleted

        // The freed spot: a third player takes it without the waitlist.
        const w = verified(test, 'w');
        register(test, w, id);
        expect(enrolled(test, id, w.userId).isWaitlisted).toBe(false);
        expect(enrolled(test, id, v.userId)).toBeTruthy();
    });

    it('A118: the removed guest can register again, and after signing in to a verified account can register too', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { teamSize: 1, maxParticipants: 4 });
        const g = guest(test, 'g');
        register(test, g, id);
        tx(test, org, reject(id, g.userId));
        register(test, g, id);
        expect(enrolled(test, id, g.userId).status.tag).toBe('Registered');

        tx(test, org, reject(id, g.userId));
        linkDiscord(test, g, 'pid-g', 'g'); // first-time link: the guest is upgraded in place
        expect(test.db.User.id.find(g.userId)!.isGuest).toBe(false);
        register(test, g, id);
        expect(enrolled(test, id, g.userId).status.tag).toBe('Registered');
    });

    it('A118: a guest team member is removed; the team keeps its captain', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { teamSize: 2 });
        const cap = verified(test, 'cap');
        const g = guest(test, 'g');
        register(test, cap, id);
        register(test, g, id);
        const teamId = makeTeam(test, id, cap, [g], 'Mixed');
        expect(membersOf(test, teamId)).toEqual([cap.userId, g.userId].sort((a, b) => a - b));

        tx(test, org, reject(id, g.userId));
        expect(enrolled(test, id, g.userId)).toBeUndefined();
        expect(membersOf(test, teamId)).toEqual([cap.userId]);
        expect(teamRow(test, teamId)!.captainUserId).toBe(cap.userId);
    });

    it('A118: a guest captain with a mate is removed; the captaincy passes to the mate', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { teamSize: 2 });
        const g = guest(test, 'g');
        const mate = verified(test, 'mate');
        register(test, g, id);
        register(test, mate, id);
        const teamId = makeTeam(test, id, g, [mate], 'Guest led');

        tx(test, org, reject(id, g.userId));
        expect(enrolled(test, id, g.userId)).toBeUndefined();
        expect(membersOf(test, teamId)).toEqual([mate.userId]);
        expect(teamRow(test, teamId)!.captainUserId).toBe(mate.userId);
    });

    it('A118: the guest\'s team requests are removed with the entry', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { teamSize: 2 });
        const cap = verified(test, 'cap');
        const g = guest(test, 'g');
        register(test, cap, id);
        register(test, g, id);
        tx(test, cap, (ctx) => M.create_tournament_team(ctx, { tournamentId: id, teamName: 'T' }));
        const teamId = membership(test, id, cap.userId)!.teamId;
        tx(test, g, (ctx) => M.request_join_team(ctx, { teamId }));
        expect([...test.db.TournamentTeamRequest.user_id.filter(g.userId)]).toHaveLength(1);
        tx(test, org, reject(id, g.userId));
        expect([...test.db.TournamentTeamRequest.user_id.filter(g.userId)]).toHaveLength(0);
    });

    it('A118: a waitlisted player is not promoted by the removal (a withdrawal promotes nobody), and the freed spot lets staff promote them', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { teamSize: 1, maxParticipants: 2, waitlistEnabled: true });
        const g = guest(test, 'g');
        const v = verified(test, 'v');
        const w = verified(test, 'w');
        for (const p of [g, v, w]) register(test, p, id);
        expect(enrolled(test, id, w.userId).isWaitlisted).toBe(true);
        expectReject(test, org, (ctx) => M.waitlist_promote(ctx, { tournamentId: id, userId: w.userId }), 'No free spot: the tournament is full.');

        tx(test, org, reject(id, g.userId));
        expect(enrolled(test, id, w.userId).isWaitlisted).toBe(true);
        tx(test, org, (ctx) => M.waitlist_promote(ctx, { tournamentId: id, userId: w.userId }));
        expect(enrolled(test, id, w.userId).isWaitlisted).toBe(false);
    });

    it('A118: in CheckIn and in Seeding before generation the guest entry is removed too', () => {
        for (const stage of ['CheckIn', 'Seeding']) {
            const test = newHarness();
            const org = host(test);
            const id = openTournament(test, org, { teamSize: 1, checkInEnabled: stage === 'CheckIn' });
            const g = guest(test, 'g');
            const v = verified(test, 'v');
            register(test, g, id);
            register(test, v, id);
            advanceStage(test, org, id, stage);
            expect(tRow(test, id).stage.tag).toBe(stage);
            tx(test, org, reject(id, g.userId));
            expect(enrolled(test, id, g.userId)).toBeUndefined();
            expect(enrolled(test, id, v.userId)).toBeTruthy();
        }
    });

    it('A118: an approved verified player is still refused with the existing text', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { teamSize: 1 });
        const v = verified(test, 'v');
        register(test, v, id);
        expectReject(test, org, reject(id, v.userId), APPROVED);
        expect(enrolled(test, id, v.userId)).toBeTruthy();
    });

    it('A118: a guest whose approved row is already Disqualified is refused with the existing text; the row stays', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { teamSize: 1 });
        const g = guest(test, 'g');
        const v = verified(test, 'v');
        register(test, g, id);
        register(test, v, id);
        tx(test, org, (ctx) => M.dq_participant(ctx, { tournamentId: id, userId: g.userId, reason: 'test' }));
        const before = enrolled(test, id, g.userId)!;
        expect(before.status.tag).toBe('Disqualified');
        expect(before.approvedByToAt).toBeDefined();

        expectReject(test, org, reject(id, g.userId), APPROVED);
        expect(enrolled(test, id, g.userId)).toEqual(before);
    });

    it('A118: a guest upgraded in place while still enrolled is a verified player: refused with the existing text', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { teamSize: 1 });
        const g = guest(test, 'g');
        register(test, g, id);
        linkDiscord(test, g, 'pid-g', 'g'); // first-time link: the same User row, now verified, keeps its entry
        expect(test.db.User.id.find(g.userId)!.isGuest).toBe(false);
        const before = enrolled(test, id, g.userId)!;
        expect(before.approvedByToAt).toBeDefined();

        expectReject(test, org, reject(id, g.userId), APPROVED);
        expect(enrolled(test, id, g.userId)).toEqual(before);
    });

    it('A118: in Seeding a seeded guest\'s solo team is removed (marked Withdrawn), then generate_bracket places the other teams only', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { teamSize: 1, maxParticipants: 8 });
        const g = guest(test, 'g');
        const others = ['v1', 'v2', 'v3', 'v4'].map((n) => verified(test, n));
        for (const p of [g, ...others]) register(test, p, id);
        advanceStage(test, org, id, 'Seeding');
        seedBracket(test, org, id);
        const guestTeam = membership(test, id, g.userId)!.teamId;
        expect(teamRow(test, guestTeam)!.seedNumber).toBeDefined();

        tx(test, org, reject(id, g.userId));
        expect(enrolled(test, id, g.userId)).toBeUndefined();
        expect(teamRow(test, guestTeam)!.status.tag).toBe('Withdrawn'); // after Registration: kept, marked Withdrawn

        generateBracket(test, org, id);
        expect(tRow(test, id).bracketGeneratedAt).toBeDefined();
        const placed = new Set(bracketRows(test, id).flatMap((r) => [r.team1Id, r.team2Id]).filter((t) => t !== undefined));
        expect(placed.has(guestTeam)).toBe(false);
        for (const p of others) expect(placed.has(membership(test, id, p.userId)!.teamId)).toBe(true);
    });

    it('A118: after the bracket exists a guest is refused with the existing text', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { teamSize: 1 });
        const g = guest(test, 'g');
        const v = verified(test, 'v');
        register(test, g, id);
        register(test, v, id);
        advanceStage(test, org, id, 'Seeding');
        seedAndGenerate(test, org, id);
        expectReject(test, org, reject(id, g.userId), GENERATED);
        expect(enrolled(test, id, g.userId)).toBeTruthy();
    });

    it('A118: a caller without the participants permission is refused', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { teamSize: 1 });
        const g = guest(test, 'g');
        register(test, g, id);
        const bracketOnly = verified(test, 'bo');
        assignAssistant(test, org, id, bracketOnly, { bracket: true });
        const stranger = verified(test, 'stranger');
        for (const who of [bracketOnly, stranger] as Actor[]) {
            expectReject(test, who, reject(id, g.userId), NO_PERMISSION);
        }
        expect(enrolled(test, id, g.userId)).toBeTruthy();

        const helper = verified(test, 'helper');
        assignAssistant(test, org, id, helper, { participants: true });
        tx(test, helper, reject(id, g.userId));
        expect(enrolled(test, id, g.userId)).toBeUndefined();
    });

    it('A118 / A113(2): with the guests removed this way, the setting change that was refused now passes', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { teamSize: 1, maxParticipants: 8 });
        const g1 = guest(test, 'g1');
        const g2 = guest(test, 'g2');
        const v = verified(test, 'v');
        for (const p of [g1, g2, v]) register(test, p, id);
        expectReject(test, org, updateBody(test, id, { requireRoster: true }), guestsText(2));

        tx(test, org, reject(id, g1.userId));
        tx(test, org, reject(id, g2.userId));
        tx(test, org, updateBody(test, id, { requireRoster: true }));
        expect(tRow(test, id)).toMatchObject({ requireRoster: true, requireVerified: true });
        expect(enrolled(test, id, v.userId)).toBeTruthy();
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Gap 5. A118 (S10o log: calendar invites on a removal)
// ════════════════════════════════════════════════════════════════════════════

describe('Gap 5, A118: the removed guest\'s calendar invites go as on a withdrawal (S10o log)', () => {
    it('A118, D-24 (S10o log): reject_participant on a guest removes the guest\'s invites to the tournament\'s match events, as the withdrawal path does; the opponent\'s invite and the guest\'s personal-event invite stay (engineered: match events exist only after generation, so the bracket stamp is cleared by hand; withdraw_from_tournament itself is closed in Seeding, so the comparison is with the D-24 rule, not a second call)', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { teamSize: 1, maxParticipants: 4 });
        const g = guest(test, 'g-rm');
        const v1 = verified(test, 'rm-v1');
        const v2 = verified(test, 'rm-v2');
        const v3 = verified(test, 'rm-v3');
        for (const p of [g, v1, v2, v3]) register(test, p, id);
        advanceStage(test, org, id, 'Seeding');
        seedAndGenerate(test, org, id);
        const matchOf = (who: Actor) => {
            const teamId = membership(test, id, who.userId)!.teamId;
            return bracketRows(test, id).find((m) => m.team1Id === teamId || m.team2Id === teamId)!;
        };
        const opponentOf = (who: Actor) => {
            const m = matchOf(who);
            const teamId = membership(test, id, who.userId)!.teamId;
            return teamRow(test, m.team1Id === teamId ? m.team2Id! : m.team1Id!)!.captainUserId;
        };
        const gEvent = createEvent(test, org, { bracketMatchId: matchOf(g).id });
        // T-S10ac (A157(7)): a guest can no longer be invited by hand; the invite is seeded as a pre-A157 row.
        const personal = createEvent(test, org, { title: 'Personal' });
        seedInvite(test, personal, g.userId, org.userId);
        expect(invite(test, gEvent, g.userId)).toBeTruthy();
        const gOpponent = opponentOf(g);
        expect(invite(test, gEvent, gOpponent)).toBeTruthy();
        // Engineered state: A118 applies before the bracket exists, when no match event can exist yet.
        test.db.Tournament.id.update({ ...tRow(test, id), bracketGeneratedAt: undefined });

        tx(test, org, (ctx) => M.reject_participant(ctx, { tournamentId: id, userId: g.userId }));
        expect(enrolled(test, id, g.userId)).toBeUndefined();
        expect(invite(test, gEvent, g.userId)).toBeFalsy();
        expect(invite(test, personal, g.userId)).toBeTruthy();
        expect(invite(test, gEvent, gOpponent)).toBeTruthy();
        expect(test.db.CalendarEvent.id.find(gEvent)).toBeTruthy();
    });
});
