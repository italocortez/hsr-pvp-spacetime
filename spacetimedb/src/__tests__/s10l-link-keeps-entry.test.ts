// T-S10l: in-memory tests for step S10l (DECISIONS.md A112): a guest who signs in with a provider account that already
// has a user keeps the guest's tournament entries (server_link_provider, the re-point + guest-deletion path). The entry,
// its team membership, captaincy and requests move to the existing user; locks are rebuilt from the existing user's own
// game accounts; an entry the existing user cannot hold is settled as a deletion (A94(2)). server_link_provider runs as
// the owner ('internal', linkDiscord). Roles, HSR accounts and rate rows are read or written through `test.db` outside
// any transaction. Nothing reaches maincloud.
import { describe, expect, it } from 'vitest';
import { M, expectReject, guest, linkDiscord, lobbyRow, newHarness, seatOf, tx, type Actor, type Harness } from './s4-fixtures';
import {
    AUDIT,
    advanceStage,
    bracketRows,
    enrolled,
    enrolledAll,
    fullTeams,
    host,
    insertHsrAccount,
    locks,
    makeTeam,
    membersOf,
    membership,
    openTournament,
    register,
    requestsOf,
    seedAndGenerate,
    stageOf,
    teamRow,
    teams,
    updateBody,
    verified,
} from './s8-fixtures';
import { createTournamentLobby, join, openMatchLobby, seedElo } from './s8d-fixtures';

// ─── Builders ────────────────────────────────────────────────────────────────

/** A verified user with a known provider id (the account the guest signs in to) and `accounts` HSR accounts. */
function existingUser(test: Harness, sub: string, name: string, accounts = 2): { a: Actor; providerId: string; accountIds: number[] } {
    const a = guest(test, sub);
    const providerId = `pid-${sub}`;
    linkDiscord(test, a, providerId, name);
    const accountIds = Array.from({ length: accounts }, (_, i) => insertHsrAccount(test, a.userId, `${sub}-acc-${i}`));
    return { a, providerId, accountIds: accountIds.sort((x, y) => x - y) };
}

/** Signs `g` in to the account that owns `providerId`; returns the guest's former user id. */
function signIn(test: Harness, g: Actor, providerId: string): number {
    const guestId = g.userId;
    linkDiscord(test, g, providerId, 'ignored');
    return guestId;
}

const capacity = (test: Harness, id: number) =>
    enrolledAll(test, id).filter((e) => !e.isWaitlisted && e.status.tag !== 'Disqualified').length;
const waitlistRows = (test: Harness, id: number, userId: number) =>
    [...test.db.TournamentWaitlistAccount.by_tournament_and_user.filter([id, userId])];
const teamOf = (test: Harness, id: number, userId: number) => teamRow(test, membership(test, id, userId)!.teamId)!;

// ════════════════════════════════════════════════════════════════════════════
// A112(1)(2): the entry moves
// ════════════════════════════════════════════════════════════════════════════

describe('A112: a guest signing in to an existing account keeps the tournament entry', () => {
    it('A112(1)(2): a solo entry in Registration moves with its status; the solo team is renamed uniquely; capacity unchanged; the guest is gone; locks rebuilt from the existing user\'s accounts', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { teamSize: 1 });
        const namesake = guest(test, 'namesake');
        linkDiscord(test, namesake, 'pid-namesake', 'Ex'); // another player whose solo team is already called "Ex"
        register(test, namesake, id);
        const g = guest(test, 'g-solo');
        const guestAccount = insertHsrAccount(test, g.userId, 'g-solo-acc');
        register(test, g, id);
        const e = existingUser(test, 'e-solo', 'Ex');

        const before = enrolled(test, id, g.userId)!;
        const teamId = membership(test, id, g.userId)!.teamId;
        const seedBefore = teamRow(test, teamId)!.seedNumber;
        const capacityBefore = capacity(test, id);
        expect(locks(test, id, g.userId)).toEqual([guestAccount]);

        const guestId = signIn(test, g, e.providerId);

        expect(g.userId).toBe(e.a.userId);
        expect(enrolled(test, id, guestId)).toBeFalsy();
        const after = enrolled(test, id, e.a.userId)!;
        expect(after).toMatchObject({
            status: before.status,
            isWaitlisted: before.isWaitlisted,
            anonymousAlias: before.anonymousAlias,
            allowRandomTeamAssignment: before.allowRandomTeamAssignment,
            approvedByToAt: before.approvedByToAt,
            createdDate: before.createdDate,
        });
        expect(membership(test, id, e.a.userId)!.teamId).toBe(teamId);
        const team = teamRow(test, teamId)!;
        expect(team.captainUserId).toBe(e.a.userId);
        expect(team.seedNumber).toBe(seedBefore);
        expect(team.name).toBe('Ex (2)');
        const names = teams(test, id).map((t) => t.name.toLowerCase());
        expect(new Set(names).size).toBe(names.length);
        expect(capacity(test, id)).toBe(capacityBefore);
        expect(test.db.User.id.find(guestId)).toBeFalsy();
        expect(test.db.DeletedUser.id.find(guestId)).toBeFalsy(); // no history left: hard-deleted
        expect(locks(test, id, e.a.userId)).toEqual(e.accountIds);
        expect(locks(test, id, guestId)).toEqual([]);
        expect(test.db.HsrAccount.id.find(guestAccount)).toBeFalsy();
    });

    it('A112(1) / A36a: in an anonymous tournament the alias is kept and the team name carries no display name', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { teamSize: 1, isAnonymousDefault: true });
        const g = guest(test, 'g-anon');
        register(test, g, id, { anonymousAlias: 'Shadow' });
        const quiet = guest(test, 'g-quiet'); // a second guest without an alias: "Player <n>"
        register(test, quiet, id);
        const e = existingUser(test, 'e-anon', 'RealName');
        const e2 = existingUser(test, 'e-anon2', 'OtherReal');
        const quietTeamName = teamOf(test, id, quiet.userId).name;

        signIn(test, g, e.providerId);
        signIn(test, quiet, e2.providerId);

        expect(enrolled(test, id, e.a.userId)!.anonymousAlias).toBe('Shadow');
        expect(teamOf(test, id, e.a.userId).name).toBe('Shadow');
        expect(teamOf(test, id, e2.a.userId).name).toBe(quietTeamName);
        for (const t of teams(test, id)) {
            expect(t.name).not.toContain('RealName');
            expect(t.name).not.toContain('OtherReal');
        }
    });

    it('A112(1): a guest captain of a Forming team: captaincy, membership and the pending request addressed to the team follow; the new captain can accept it', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { teamSize: 3 });
        const g = guest(test, 'g-cap');
        const mate = verified(test, 'mate');
        const asker = verified(test, 'asker');
        for (const p of [g, mate, asker]) register(test, p, id);
        const teamId = makeTeam(test, id, g, [mate], 'Guests');
        tx(test, asker, (ctx) => M.request_join_team(ctx, { teamId }));
        const e = existingUser(test, 'e-cap', 'Captain');

        signIn(test, g, e.providerId);

        const team = teamRow(test, teamId)!;
        expect(team.captainUserId).toBe(e.a.userId);
        expect(team.name).toBe('Guests');
        expect(team.status.tag).toBe('Forming');
        expect(membersOf(test, teamId)).toEqual([e.a.userId, mate.userId].sort((a, b) => a - b));
        expect(requestsOf(test, asker.userId).map((r) => r.teamId)).toEqual([teamId]);

        tx(test, e.a, (ctx) => M.accept_team_request(ctx, { teamId, userId: asker.userId }));
        expect(membersOf(test, teamId)).toContain(asker.userId);
    });

    it('A112(1): a guest who is a plain member of someone else\'s team: the membership moves, the captain stays', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { teamSize: 2 });
        const cap = verified(test, 'cap');
        const g = guest(test, 'g-member');
        register(test, cap, id);
        register(test, g, id);
        const teamId = makeTeam(test, id, cap, [g], 'Cap team');
        const statusBefore = teamRow(test, teamId)!.status.tag;
        const e = existingUser(test, 'e-member', 'Member');

        const guestId = signIn(test, g, e.providerId);

        expect(membersOf(test, teamId)).toEqual([cap.userId, e.a.userId].sort((a, b) => a - b));
        expect(membership(test, id, guestId)).toBeFalsy();
        expect(teamRow(test, teamId)!.captainUserId).toBe(cap.userId);
        expect(teamRow(test, teamId)!.status.tag).toBe(statusBefore);
    });

    it('A112(1): a pending join request made by the guest follows to the existing user', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { teamSize: 2 });
        const cap = verified(test, 'cap-r');
        const g = guest(test, 'g-req');
        register(test, cap, id);
        register(test, g, id);
        tx(test, cap, (ctx) => M.create_tournament_team(ctx, { tournamentId: id, teamName: 'Open' }));
        const teamId = teams(test, id).find((t) => t.name === 'Open')!.id;
        tx(test, g, (ctx) => M.request_join_team(ctx, { teamId }));
        const e = existingUser(test, 'e-req', 'Requester');

        const guestId = signIn(test, g, e.providerId);

        expect(requestsOf(test, guestId)).toEqual([]);
        expect(requestsOf(test, e.a.userId).map((r) => r.teamId)).toEqual([teamId]);
        tx(test, cap, (ctx) => M.accept_team_request(ctx, { teamId, userId: e.a.userId }));
        expect(membersOf(test, teamId)).toEqual([cap.userId, e.a.userId].sort((a, b) => a - b));
    });

    it('A112(1)(2): after the bracket exists (InProgress) the entry moves, bracket rows are unchanged, and the existing user joins the match lobby, selects a locked account and starts', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { teamSize: 2, maxParticipants: 8 });
        const [other] = fullTeams(test, id, 1, 'v');
        const g = guest(test, 'g-live');
        const mate = verified(test, 'mate-live');
        register(test, g, id);
        register(test, mate, id);
        const gTeam = makeTeam(test, id, g, [mate], 'Guest team');
        advanceStage(test, org, id, 'Seeding');
        seedAndGenerate(test, org, id);
        advanceStage(test, org, id, 'InProgress');
        const e = existingUser(test, 'e-live', 'Live');
        const bracketBefore = bracketRows(test, id);
        const statusBefore = enrolled(test, id, g.userId)!.status.tag;
        const seedBefore = teamRow(test, gTeam)!.seedNumber;

        const guestId = signIn(test, g, e.providerId);

        expect(bracketRows(test, id)).toEqual(bracketBefore);
        expect(enrolled(test, id, guestId)).toBeFalsy();
        expect(enrolled(test, id, e.a.userId)!.status.tag).toBe(statusBefore);
        expect(statusBefore).toBe('Active');
        expect(teamRow(test, gTeam)).toMatchObject({ captainUserId: e.a.userId, seedNumber: seedBefore, status: { tag: 'Active' } });
        expect(locks(test, id, e.a.userId)).toEqual(e.accountIds);

        const match = bracketBefore.find((m) => m.team1Id !== undefined && m.team2Id !== undefined)!;
        const f = { test, org, id, ts: [other, { captain: e.a, mate, teamId: gTeam }] } as any;
        const s = openMatchLobby(f, match.id, { noStart: true });
        const seat = [...test.db.LobbyMember.by_lobby_and_user.filter([s.lobbyId, e.a.userId])][0]!;
        expect(['BluePlayer', 'RedPlayer']).toContain(seat.lobbySlot.tag);
        for (const sel of [...test.db.LobbyMemberAccount.by_lobby_and_user.filter([s.lobbyId, e.a.userId])]) {
            tx(test, e.a, (ctx) => M.deselect_match_account(ctx, { lobbyId: s.lobbyId, hsrAccountId: sel.hsrAccountId }));
        }
        tx(test, e.a, (ctx) => M.select_match_account(ctx, { lobbyId: s.lobbyId, hsrAccountId: e.accountIds[1] }));
        expect([...test.db.LobbyMemberAccount.by_lobby_and_user.filter([s.lobbyId, e.a.userId])].map((r) => r.hsrAccountId))
            .toEqual([e.accountIds[1]]);
        tx(test, org, (ctx) => M.start_draft(ctx, { lobbyId: s.lobbyId }));
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('Drafting');
    });

    it('A112(1): in Seeding after generation the entry moves and the bracket rows are unchanged', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { teamSize: 1, maxParticipants: 4 });
        const p = verified(test, 'seed-p');
        const g = guest(test, 'g-seed');
        register(test, p, id);
        register(test, g, id);
        advanceStage(test, org, id, 'Seeding');
        seedAndGenerate(test, org, id);
        const e = existingUser(test, 'e-seed', 'Seeder');
        const teamId = membership(test, id, g.userId)!.teamId;
        const bracketBefore = bracketRows(test, id);

        signIn(test, g, e.providerId);

        expect(bracketRows(test, id)).toEqual(bracketBefore);
        expect(membership(test, id, e.a.userId)!.teamId).toBe(teamId);
        expect(teamRow(test, teamId)!.captainUserId).toBe(e.a.userId);
        expect(stageOf(test, id)).toBe('Seeding');
    });

    it('A112(1)(2): a waitlisted guest keeps the waitlist place; no chosen accounts cross over; promotion later locks every account of the existing user', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { teamSize: 1, maxParticipants: 2, waitlistEnabled: true });
        const [p1, p2] = [verified(test, 'w1'), verified(test, 'w2')];
        register(test, p1, id);
        register(test, p2, id);
        const g = guest(test, 'g-wait');
        const gAccount = insertHsrAccount(test, g.userId, 'g-wait-acc');
        register(test, g, id, { hsrAccountIds: [gAccount] });
        const later = verified(test, 'w-later');
        register(test, later, id);
        expect(waitlistRows(test, id, g.userId)).toHaveLength(1);
        const before = enrolled(test, id, g.userId)!;
        const e = existingUser(test, 'e-wait', 'Waiter');

        const guestId = signIn(test, g, e.providerId);

        const after = enrolled(test, id, e.a.userId)!;
        expect(after.isWaitlisted).toBe(true);
        expect(after.createdDate).toEqual(before.createdDate);
        expect(after.createdDate.microsSinceUnixEpoch <= enrolled(test, id, later.userId)!.createdDate.microsSinceUnixEpoch).toBe(true);
        expect(locks(test, id, e.a.userId)).toEqual([]);
        expect(waitlistRows(test, id, guestId)).toEqual([]);
        expect(waitlistRows(test, id, e.a.userId)).toEqual([]);

        tx(test, p1, (ctx) => M.withdraw_from_tournament(ctx, { tournamentId: id }));
        tx(test, org, (ctx) => M.waitlist_promote(ctx, { tournamentId: id, userId: e.a.userId }));
        expect(enrolled(test, id, e.a.userId)!.isWaitlisted).toBe(false);
        expect(locks(test, id, e.a.userId)).toEqual(e.accountIds);
    });
});


// ════════════════════════════════════════════════════════════════════════════
// A112(3): the entry is not moved and is settled as a deletion (A94(2))
// ════════════════════════════════════════════════════════════════════════════

describe('A112(3): entries the existing user cannot hold are settled as a deletion', () => {
    it('A112(3): the existing user already holds an approved entry: before the bracket the guest\'s entry is withdrawn, the user\'s own entry is untouched', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { teamSize: 1 });
        const e = existingUser(test, 'e-dup', 'Dup');
        register(test, e.a, id);
        const g = guest(test, 'g-dup');
        register(test, g, id);
        const own = enrolled(test, id, e.a.userId)!;
        const ownTeam = teamOf(test, id, e.a.userId);
        const guestTeamId = membership(test, id, g.userId)!.teamId;
        const capacityBefore = capacity(test, id);

        const guestId = signIn(test, g, e.providerId);

        expect(enrolled(test, id, guestId)).toBeFalsy();
        expect(enrolled(test, id, e.a.userId)).toEqual(own);
        expect(teamOf(test, id, e.a.userId)).toEqual(ownTeam);
        expect(teamRow(test, guestTeamId)).toBeFalsy(); // A94(2): withdrawn, the solo team deleted in Registration
        expect(capacity(test, id)).toBe(capacityBefore - 1);
        expect(test.db.User.id.find(guestId)).toBeFalsy();
    });

    it('A112(3): the existing user already holds an entry after the bracket exists: the guest is disqualified, the user\'s own entry is untouched', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { teamSize: 2, maxParticipants: 8 });
        const e = existingUser(test, 'e-dup-live', 'DupLive');
        const eMate = verified(test, 'e-mate');
        const g = guest(test, 'g-dup-live');
        const gMate = verified(test, 'g-mate');
        for (const p of [e.a, eMate, g, gMate]) register(test, p, id);
        makeTeam(test, id, e.a, [eMate], 'E team');
        const gTeam = makeTeam(test, id, g, [gMate], 'G team');
        advanceStage(test, org, id, 'Seeding');
        seedAndGenerate(test, org, id);
        advanceStage(test, org, id, 'InProgress');
        const own = enrolled(test, id, e.a.userId)!;

        const guestId = signIn(test, g, e.providerId);

        expect(enrolled(test, id, guestId)!.status.tag).toBe('Disqualified');
        expect(enrolled(test, id, e.a.userId)).toEqual(own);
        expect(membersOf(test, gTeam)).toEqual([gMate.userId]);
        expect(teamRow(test, gTeam)!.captainUserId).toBe(gMate.userId);
        expect(test.db.DeletedUser.id.find(guestId)).toBeTruthy(); // the kept enrolment is history: archived
    });

    it('A112(3): the existing user was disqualified from the tournament: the guest\'s entry is not moved and is withdrawn; the Disqualified row stays', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { teamSize: 1 });
        const e = existingUser(test, 'e-dq', 'Dq');
        register(test, e.a, id);
        tx(test, org, (ctx) => M.dq_participant(ctx, { tournamentId: id, userId: e.a.userId, reason: 'test' }));
        const own = enrolled(test, id, e.a.userId)!;
        const g = guest(test, 'g-dq');
        register(test, g, id);

        const guestId = signIn(test, g, e.providerId);

        expect(enrolled(test, id, guestId)).toBeFalsy();
        expect(enrolled(test, id, e.a.userId)).toEqual(own);
        expect(own.status.tag).toBe('Disqualified');
    });

    it('A112(3): the tournament requires a roster and the existing user has no game account: not moved, settled as a deletion', () => {
        const test = newHarness();
        const org = host(test);
        // S10m: A113(1)(2) no longer let a guest enter a roster tournament; the row is set directly, as data written
        // before A113 (requireRoster on, requireVerified off).
        const id = openTournament(test, org, { teamSize: 1 });
        const g = guest(test, 'g-roster');
        insertHsrAccount(test, g.userId, 'g-roster-acc');
        register(test, g, id);
        test.db.Tournament.id.update({ ...test.db.Tournament.id.find(id)!, requireRoster: true });
        const e = existingUser(test, 'e-roster', 'NoRoster', 0);

        const guestId = signIn(test, g, e.providerId);

        expect(enrolled(test, id, guestId)).toBeFalsy();
        expect(enrolled(test, id, e.a.userId)).toBeFalsy();
        expect(teams(test, id)).toEqual([]);
        expect(locks(test, id, e.a.userId)).toEqual([]);
    });

    it('A112(1): an entry in a finished (Cancelled) tournament is left alone with the guest', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { teamSize: 1 });
        const g = guest(test, 'g-done');
        register(test, g, id);
        advanceStage(test, org, id, 'Cancelled');
        const before = enrolled(test, id, g.userId)!;
        const e = existingUser(test, 'e-done', 'Done');

        const guestId = signIn(test, g, e.providerId);

        expect(enrolled(test, id, guestId)).toEqual(before);
        expect(enrolled(test, id, e.a.userId)).toBeFalsy();
        expect(test.db.DeletedUser.id.find(guestId)).toBeTruthy();
    });
});

// ════════════════════════════════════════════════════════════════════════════
// A112: unchanged paths, mixed cases, rate limits
// ════════════════════════════════════════════════════════════════════════════

describe('A112: the other link paths and side effects', () => {
    it('A112 (scope): a first-time link upgrades the guest in place; the entry stays with the same user id', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { teamSize: 1 });
        const g = guest(test, 'g-first');
        register(test, g, id);
        const before = enrolled(test, id, g.userId)!;
        const guestId = g.userId;

        linkDiscord(test, g, 'pid-brand-new', 'Newcomer');

        expect(g.userId).toBe(guestId);
        expect(test.db.User.id.find(guestId)!.isGuest).toBe(false);
        expect(enrolled(test, id, guestId)).toEqual(before);
    });

    it('A112(1)(3): a guest in two tournaments: the entry the existing user can hold moves, the other is settled as a deletion', () => {
        const test = newHarness();
        const org = host(test);
        const t1 = openTournament(test, org, { teamSize: 1, name: 'T1' } as any);
        const t2 = openTournament(test, org, { teamSize: 1, name: 'T2' } as any);
        const e = existingUser(test, 'e-two', 'Two');
        register(test, e.a, t2);
        const own = enrolled(test, t2, e.a.userId)!;
        const g = guest(test, 'g-two');
        register(test, g, t1);
        register(test, g, t2);

        const guestId = signIn(test, g, e.providerId);

        expect(enrolled(test, t1, e.a.userId)).toBeTruthy();
        expect(enrolled(test, t1, guestId)).toBeFalsy();
        expect(enrolled(test, t2, e.a.userId)).toEqual(own);
        expect(enrolled(test, t2, guestId)).toBeFalsy();
        expect(enrolledAll(test, t2)).toHaveLength(1);
        expect(test.db.User.id.find(guestId)).toBeFalsy();
    });

    it('A112: the move consumes none of the existing user\'s tournament-change allowance', () => {
        const test = newHarness();
        const org = host(test);
        const t1 = openTournament(test, org, { teamSize: 1, name: 'T1' } as any);
        const t2 = openTournament(test, org, { teamSize: 1, name: 'T2' } as any);
        const e = existingUser(test, 'e-rate', 'Rate');
        register(test, e.a, t2); // one counted write
        const g = guest(test, 'g-rate');
        register(test, g, t1);
        const rateBefore = test.db.UserRateState.userId.find(e.a.userId)!;
        expect(rateBefore.tournamentCount).toBe(1);

        signIn(test, g, e.providerId);

        expect(enrolled(test, t1, e.a.userId)).toBeTruthy();
        expect(test.db.UserRateState.userId.find(e.a.userId)).toEqual(rateBefore);
        const moved = enrolled(test, t1, e.a.userId)!;
        expect(moved.lastModifiedById).toBe(0); // audit actor: SYSTEM_USER_ID, as the link path
    });
});

// ════════════════════════════════════════════════════════════════════════════
// S10l review fixes: F1 (minimum MMR), F2 (stand-in on the other side), F7 (captaincy without membership),
// and the Disqualified guest entry (review answer 5)
// ════════════════════════════════════════════════════════════════════════════

const SEAT = 'This seat is not available to you in this tournament lobby.';
const standInRows = (test: Harness, bracketMatchId: number, userId: number) =>
    [...test.db.TournamentStandIn.by_match_and_user.filter([bracketMatchId, userId])];

function rate(test: Harness, userId: number, rating: number) {
    test.db.MmrRating.insert({
        userId, gameMode: { tag: 'MemoryOfChaos' } as any, rating, matchesPlayed: 1,
        globalCompositeRating: undefined, seasonId: 0, ...AUDIT(test),
    } as any);
}

describe('S10l review fixes', () => {
    it('A112(3) / review F1: the organizer sets a floor after a guest registered; an existing account below it does not take the entry (settled as a deletion); one at the floor does', () => {
        const test = newHarness();
        seedElo(test);
        const org = host(test);
        const id = openTournament(test, org, { teamSize: 1 });
        const gLow = guest(test, 'g-floor-low');
        const gAt = guest(test, 'g-floor-at');
        register(test, gLow, id);
        register(test, gAt, id);
        // S10m: A113(2) refuses this change through update_tournament while guests are enrolled; the floor is set
        // directly, as data written before A113 (minimumMmr set, requireVerified off).
        test.db.Tournament.id.update({ ...test.db.Tournament.id.find(id)!, minimumMmr: 1500 });
        expect(enrolled(test, id, gLow.userId)).toBeTruthy(); // existing registrants are not re-checked
        const low = existingUser(test, 'e-floor-low', 'Low');
        rate(test, low.a.userId, 1200);
        const at = existingUser(test, 'e-floor-at', 'At');
        rate(test, at.a.userId, 1500);
        const lowTeamId = membership(test, id, gLow.userId)!.teamId;

        const lowGuestId = signIn(test, gLow, low.providerId);
        const atGuestId = signIn(test, gAt, at.providerId);

        // Below the floor: not moved; A94(2) in Registration withdraws (row and solo team deleted).
        expect(enrolled(test, id, low.a.userId)).toBeFalsy();
        expect(enrolled(test, id, lowGuestId)).toBeFalsy();
        expect(teamRow(test, lowTeamId)).toBeFalsy();
        expect(locks(test, id, low.a.userId)).toEqual([]);
        // At the floor: moved.
        expect(enrolled(test, id, atGuestId)).toBeFalsy();
        expect(enrolled(test, id, at.a.userId)).toBeTruthy();
        expect(teamOf(test, id, at.a.userId).captainUserId).toBe(at.a.userId);
        expect(locks(test, id, at.a.userId)).toEqual(at.accountIds);
    });

    it('A112 / review F2: the existing user\'s stand-in approval for the opposing team of the match is deleted, they can only sit on their own team; a stand-in row for an unrelated match stays', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { teamSize: 2, maxParticipants: 8 });
        fullTeams(test, id, 3, 'v');
        const g = guest(test, 'g-si');
        const mate = verified(test, 'mate-si');
        register(test, g, id);
        register(test, mate, id);
        const gTeam = makeTeam(test, id, g, [mate], 'Guest team');
        advanceStage(test, org, id, 'Seeding');
        seedAndGenerate(test, org, id);
        advanceStage(test, org, id, 'InProgress');
        const e = existingUser(test, 'e-si', 'Sub');
        const ready = bracketRows(test, id).filter((m) => m.team1Id !== undefined && m.team2Id !== undefined);
        const m = ready.find((r) => r.team1Id === gTeam || r.team2Id === gTeam)!;
        const unrelated = ready.find((r) => r.team1Id !== gTeam && r.team2Id !== gTeam)!;
        const opponent = m.team1Id === gTeam ? m.team2Id! : m.team1Id!;
        tx(test, org, (ctx) => M.approve_stand_in(ctx, { bracketMatchId: m.id, teamId: opponent, userId: e.a.userId }));
        tx(test, org, (ctx) => M.approve_stand_in(ctx, { bracketMatchId: unrelated.id, teamId: unrelated.team1Id!, userId: e.a.userId }));
        expect(standInRows(test, m.id, e.a.userId)).toHaveLength(1);

        signIn(test, g, e.providerId);

        expect(membership(test, id, e.a.userId)!.teamId).toBe(gTeam);
        expect(standInRows(test, m.id, e.a.userId)).toEqual([]);
        expect(standInRows(test, unrelated.id, e.a.userId)).toHaveLength(1);

        const lobbyId = createTournamentLobby(test, org, m.id);
        join(test, e.a, lobbyId);
        const own = m.team1Id === gTeam ? 'BluePlayer' : 'RedPlayer';
        const other = own === 'BluePlayer' ? 'RedPlayer' : 'BluePlayer';
        expect([...test.db.LobbyMember.by_lobby_and_user.filter([lobbyId, e.a.userId])][0]!.lobbySlot.tag).toBe(own);
        expectReject(test, e.a, (ctx) => M.set_team_slot(ctx, {
            lobbyId, targetJoinSeq: seatOf(ctx, lobbyId, e.a.userId), lobbySlot: { tag: other } as any,
        }), SEAT);
    });

    it('A112(1) / review F7: a disqualified guest whose solo team was emptied is still its recorded captain; after the move the team names the existing user', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { teamSize: 1 });
        const g = guest(test, 'g-dq-cap');
        register(test, g, id);
        const teamId = membership(test, id, g.userId)!.teamId;
        tx(test, org, (ctx) => M.dq_participant(ctx, { tournamentId: id, userId: g.userId, reason: 'test' }));
        expect(membership(test, id, g.userId)).toBeFalsy();
        expect(teamRow(test, teamId)!.captainUserId).toBe(g.userId);
        const e = existingUser(test, 'e-dq-cap', 'DqCap');

        const guestId = signIn(test, g, e.providerId);

        expect(teamRow(test, teamId)!.captainUserId).toBe(e.a.userId);
        expect(teams(test, id).some((t) => t.captainUserId === guestId)).toBe(false);
        expect(membership(test, id, e.a.userId)).toBeFalsy();
    });

    it('A112(1) / review answer 5: a Disqualified guest entry moves with its status; the existing user cannot re-register and holds no locks', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { teamSize: 2 });
        const cap = verified(test, 'cap-dq');
        const g = guest(test, 'g-dq-member');
        insertHsrAccount(test, g.userId, 'g-dq-acc');
        register(test, cap, id);
        register(test, g, id);
        const teamId = makeTeam(test, id, cap, [g], 'Cap dq team');
        tx(test, org, (ctx) => M.dq_participant(ctx, { tournamentId: id, userId: g.userId, reason: 'test' }));
        const before = enrolled(test, id, g.userId)!;
        expect(before.status.tag).toBe('Disqualified');
        const e = existingUser(test, 'e-dq-member', 'DqMember');

        const guestId = signIn(test, g, e.providerId);

        expect(enrolled(test, id, guestId)).toBeFalsy();
        expect(enrolled(test, id, e.a.userId)).toMatchObject({ status: { tag: 'Disqualified' }, createdDate: before.createdDate });
        expect(locks(test, id, e.a.userId)).toEqual([]);
        expect(membership(test, id, e.a.userId)).toBeFalsy();
        expect(teamRow(test, teamId)!.captainUserId).toBe(cap.userId);
        expectReject(test, e.a, (ctx) => M.register_for_tournament(ctx, { tournamentId: id }), 'You were disqualified from this tournament.');
        expect(locks(test, id, e.a.userId)).toEqual([]);
    });
});
