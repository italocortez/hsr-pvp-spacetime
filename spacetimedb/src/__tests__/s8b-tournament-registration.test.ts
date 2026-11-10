// T-S8b: in-memory tests for the S8b registration reducers (A26, A26a, A36b, ACCESS-SECURITY-OPS §D.8.6):
// register / withdraw, capacity and waitlist, approval, minimum MMR, account locks, waitlist_promote, add_participant,
// reject_participant, withdraw_tournament_team. Builders in s8-fixtures.ts.
import { describe, expect, it } from 'vitest';
import { M, expectReject, guest, newHarness, tx, type Harness } from './s4-fixtures';
import {
    AUDIT,
    advanceStage,
    enrollMany,
    enrolled,
    enrolledAll,
    fullTeams,
    seedAndGenerate,
    host,
    insertHsrAccount,
    locks,
    makeTeam,
    membersOf,
    membership,
    openTournament,
    register,
    requestsOf,
    stageOf,
    stampGenerated,
    teamRow,
    teams,
    verified,
} from './s8-fixtures';

const dq = (test: Harness, by: any, tournamentId: number, userId: number) =>
    tx(test, by, (ctx) => M.dq_participant(ctx, { tournamentId, userId, reason: 'test' }));

function insertRating(test: Harness, userId: number, rating: number) {
    test.db.MmrRating.insert({
        userId,
        gameMode: { tag: 'MemoryOfChaos' } as any,
        rating,
        matchesPlayed: 1,
        globalCompositeRating: undefined,
        seasonId: 0,
        ...AUDIT(test),
    });
}

describe('register_for_tournament: stage, capacity, waitlist, approval (A26a, C-a11)', () => {
    it('Registration stage only', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org);
        fullTeams(test, id, 2);
        advanceStage(test, org, id, 'Seeding');
        const late = verified(test, 'late');
        expectReject(test, late, (ctx) => M.register_for_tournament(ctx, { tournamentId: id }), 'Tournament is not accepting registrations.');
    });

    it('capacity counts the rows that are neither waitlisted nor Disqualified; full + waitlist → waitlisted', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { maxParticipants: 2, waitlistEnabled: true });
        const [p1, p2, p3] = enrollMany(test, id, 3);
        expect([p1, p2].map((p) => enrolled(test, id, p.userId).isWaitlisted)).toEqual([false, false]);
        expect(enrolled(test, id, p3.userId).isWaitlisted).toBe(true);
        const [p4] = enrollMany(test, id, 1, 'q');
        expect(enrolled(test, id, p4.userId).isWaitlisted).toBe(true); // waitlisted rows do not count either

        dq(test, org, id, p1.userId);
        expect(enrolled(test, id, p1.userId).status.tag).toBe('Disqualified');
        const [p5] = enrollMany(test, id, 1, 'r');
        expect(enrolled(test, id, p5.userId).isWaitlisted).toBe(false); // the DQ row freed a spot
    });

    it('full without a waitlist is rejected', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { maxParticipants: 2 });
        enrollMany(test, id, 2);
        const late = verified(test, 'late');
        expectReject(test, late, (ctx) => M.register_for_tournament(ctx, { tournamentId: id }), 'Tournament is full.');
        expect(enrolled(test, id, late.userId)).toBeUndefined();
    });

    it('requireApproval: pending (approvedByToAt unset) until approve_participant; already registered rejected', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { requireApproval: true });
        const [p] = enrollMany(test, id, 1);
        expect(enrolled(test, id, p.userId).approvedByToAt).toBeUndefined();
        expectReject(test, p, (ctx) => M.register_for_tournament(ctx, { tournamentId: id }), 'You are already registered for this tournament.');
        tx(test, org, (ctx) => M.approve_participant(ctx, { tournamentId: id, userId: p.userId }));
        expect(enrolled(test, id, p.userId).approvedByToAt).toBeDefined();
        expectReject(test, org, (ctx) => M.approve_participant(ctx, { tournamentId: id, userId: p.userId }), 'Participant is already approved.');

        const open = openTournament(test, org);
        const [q] = enrollMany(test, open, 1, 'q');
        expect(enrolled(test, open, q.userId).approvedByToAt).toBeDefined(); // no approval needed: approved at once
    });

    it('a Disqualified row blocks re-registration and self-withdrawal (A26a(2))', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org);
        const [p] = enrollMany(test, id, 1);
        dq(test, org, id, p.userId);
        expectReject(test, p, (ctx) => M.register_for_tournament(ctx, { tournamentId: id }), 'You were disqualified from this tournament.');
        expectReject(test, p, (ctx) => M.withdraw_from_tournament(ctx, { tournamentId: id }), 'You were disqualified from this tournament.');
        expect(enrolled(test, id, p.userId).status.tag).toBe('Disqualified');
    });

    it('requireVerified rejects a guest', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { requireVerified: true });
        const g = guest(test, 'g');
        expectReject(test, g, (ctx) => M.register_for_tournament(ctx, { tournamentId: id }),
            'This tournament requires a verified account. Link your Discord first.');
    });

    it('solo tournament: the auto team is named after the player, or the alias in an anonymous tournament (A36a)', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { teamSize: 1 });
        const [p] = enrollMany(test, id, 1);
        const t = teamRow(test, membership(test, id, p.userId)!.teamId)!;
        expect(t).toMatchObject({ name: 'p1', captainUserId: p.userId, status: { tag: 'Ready' } });

        const anon = openTournament(test, org, { teamSize: 1, isAnonymousDefault: true });
        const q = verified(test, 'q');
        register(test, q, anon, { anonymousAlias: '  Masked  ' });
        expect(enrolled(test, anon, q.userId).anonymousAlias).toBe('Masked');
        expect(teamRow(test, membership(test, anon, q.userId)!.teamId)!.name).toBe('Masked');
        const r = verified(test, 'r');
        expectReject(test, r, (ctx) => M.register_for_tournament(ctx, { tournamentId: id, anonymousAlias: 'x' }),
            'Aliases are only used in anonymous tournaments.');
    });
});

describe('minimum MMR (A36b)', () => {
    function mmrTournament(minimumMmr: number, seedConfig = true) {
        const test = newHarness();
        if (seedConfig) tx(test, 'internal', (ctx) => M.admin_seed_elo_config(ctx, {}));
        const org = host(test);
        const id = openTournament(test, org, { minimumMmr });
        return { test, org, id };
    }

    it('a guest is rejected', () => {
        const { test, id } = mmrTournament(500);
        const g = guest(test, 'g');
        // S10m: A113(1) forces requireVerified when a minimum MMR is set, so the requireVerified check answers first.
        expectReject(test, g, (ctx) => M.register_for_tournament(ctx, { tournamentId: id }), 'This tournament requires a verified account. Link your Discord first.');
    });

    it('a verified player without a rating row is evaluated at initialRating (1000)', () => {
        const { test, id } = mmrTournament(1000);
        const [p] = enrollMany(test, id, 1);
        expect(enrolled(test, id, p.userId)).toBeDefined();
        const high = mmrTournament(1001);
        const q = verified(high.test, 'q');
        expectReject(high.test, q, (ctx) => M.register_for_tournament(ctx, { tournamentId: high.id }),
            'This tournament needs an MMR of at least 1001 (yours: 1000).');
    });

    it('a rating row decides: lower rejected, equal or higher accepted', () => {
        const { test, id } = mmrTournament(1100);
        const low = verified(test, 'low');
        insertRating(test, low.userId, 1099);
        expectReject(test, low, (ctx) => M.register_for_tournament(ctx, { tournamentId: id }),
            'This tournament needs an MMR of at least 1100 (yours: 1099).');
        const ok = verified(test, 'ok');
        insertRating(test, ok.userId, 1100);
        register(test, ok, id);
        expect(enrolled(test, id, ok.userId)).toBeDefined();
    });

    it('no EloConfig row: a row-less player gets the config error (addendum interpretation)', () => {
        const { test, id } = mmrTournament(900, false);
        const p = verified(test, 'p');
        expectReject(test, p, (ctx) => M.register_for_tournament(ctx, { tournamentId: id }),
            'ELO config not initialized. Call admin_seed_elo_config first.');
    });
});

describe('account locks (A26a(4), D-21)', () => {
    it('non-waitlisted: every own account by default, or the named ones; a foreign account is rejected', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org);
        const p = verified(test, 'p');
        const a1 = insertHsrAccount(test, p.userId, '100');
        const a2 = insertHsrAccount(test, p.userId, '101');
        register(test, p, id);
        expect(locks(test, id, p.userId)).toEqual([a1, a2].sort((x, y) => x - y));

        const q = verified(test, 'q');
        const b1 = insertHsrAccount(test, q.userId, '200');
        insertHsrAccount(test, q.userId, '201');
        expectReject(test, q, (ctx) => M.register_for_tournament(ctx, { tournamentId: id, hsrAccountIds: [a1] }),
            `HSR account #${a1} is not one of your accounts.`);
        expect(enrolled(test, id, q.userId)).toBeUndefined(); // rolled back
        register(test, q, id, { hsrAccountIds: [b1] });
        expect(locks(test, id, q.userId)).toEqual([b1]);
    });

    it('waitlisted: no locks at registration; waitlist_promote locks the chosen accounts, or every account when none were named (T-S10g: A104)', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { maxParticipants: 2, waitlistEnabled: true }); // S10s re-alignment (A122(17), F7): the floor is 2
        const [first] = enrollMany(test, id, 2); // S10s re-alignment (F7): two fill the 2 spots
        const w = verified(test, 'w');
        const acc = [insertHsrAccount(test, w.userId, '300'), insertHsrAccount(test, w.userId, '301')];
        register(test, w, id, { hsrAccountIds: [acc[0]] });
        expect(enrolled(test, id, w.userId).isWaitlisted).toBe(true);
        expect(locks(test, id, w.userId)).toEqual([]);

        tx(test, first, (ctx) => M.withdraw_from_tournament(ctx, { tournamentId: id }));
        tx(test, org, (ctx) => M.waitlist_promote(ctx, { tournamentId: id, userId: w.userId }));
        expect(enrolled(test, id, w.userId).isWaitlisted).toBe(false);
        expect(locks(test, id, w.userId)).toEqual([acc[0]]); // A104: the remembered choice
        expect([...test.db.TournamentWaitlistAccount.by_tournament_and_user.filter([id, w.userId])]).toHaveLength(0);

        // none named: every account is locked at promotion
        const id2 = openTournament(test, org, { name: 'second', maxParticipants: 2, waitlistEnabled: true }); // S10s re-alignment (A122(17), F7): the floor is 2
        const [first2] = enrollMany(test, id2, 2, 'f'); // S10s re-alignment (F7)
        register(test, w, id2);
        expect(enrolled(test, id2, w.userId).isWaitlisted).toBe(true);
        tx(test, first2, (ctx) => M.withdraw_from_tournament(ctx, { tournamentId: id2 }));
        tx(test, org, (ctx) => M.waitlist_promote(ctx, { tournamentId: id2, userId: w.userId }));
        expect(locks(test, id2, w.userId)).toEqual(acc);
    });
});

describe('waitlist_promote (D.8.6)', () => {
    function waitlisted(over = {}) {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { maxParticipants: 4, waitlistEnabled: true, requireApproval: true, ...over });
        const regs = enrollMany(test, id, 4);
        for (const p of regs) tx(test, org, (ctx) => M.approve_participant(ctx, { tournamentId: id, userId: p.userId }));
        const [w] = enrollMany(test, id, 1, 'w');
        return { test, org, id, regs, w };
    }

    it('needs a free spot; implies approval; not for a non-waitlisted player; participants permission', () => {
        const { test, org, id, regs, w } = waitlisted();
        expectReject(test, org, (ctx) => M.waitlist_promote(ctx, { tournamentId: id, userId: w.userId }), 'No free spot: the tournament is full.');
        expectReject(test, org, (ctx) => M.waitlist_promote(ctx, { tournamentId: id, userId: regs[1].userId }), 'Participant is not on the waitlist.');
        tx(test, regs[0], (ctx) => M.withdraw_from_tournament(ctx, { tournamentId: id }));
        const plain = verified(test, 'plain');
        expectReject(test, plain, (ctx) => M.waitlist_promote(ctx, { tournamentId: id, userId: w.userId }), /participants permission/);
        expect(enrolled(test, id, w.userId).approvedByToAt).toBeUndefined();
        tx(test, org, (ctx) => M.waitlist_promote(ctx, { tournamentId: id, userId: w.userId }));
        expect(enrolled(test, id, w.userId)).toMatchObject({ isWaitlisted: false, approvedByToAt: expect.anything() });
    });


    it('allowed in Seeding until the bracket is generated, rejected after bracketGeneratedAt', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { maxParticipants: 4, waitlistEnabled: true });
        const ts = fullTeams(test, id, 2);
        const [w1, w2] = enrollMany(test, id, 2, 'w');
        advanceStage(test, org, id, 'Seeding');
        dq(test, org, id, ts[0].mate.userId); // a Disqualified row frees its spot
        dq(test, org, id, ts[1].mate.userId);
        tx(test, org, (ctx) => M.waitlist_promote(ctx, { tournamentId: id, userId: w1.userId }));
        expect(enrolled(test, id, w1.userId).isWaitlisted).toBe(false);
        stampGenerated(test, id); // T-S8c: kept direct: both teams are Forming here, so generate_bracket would reject (< 2 Ready)
        expectReject(test, org, (ctx) => M.waitlist_promote(ctx, { tournamentId: id, userId: w2.userId }), 'Bracket generated; use stand-ins.');
        expect(enrolled(test, id, w2.userId).isWaitlisted).toBe(true);
    });
});

describe('add_participant / reject_participant (participants, before generation)', () => {
    it('add_participant inserts an approved, non-waitlisted enrolment with locks; guards', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { maxParticipants: 2, requireApproval: true });
        const p = verified(test, 'p');
        const acc = insertHsrAccount(test, p.userId, '400');
        const plain = verified(test, 'plain');
        expectReject(test, plain, (ctx) => M.add_participant(ctx, { tournamentId: id, userId: p.userId }), /participants permission/);
        tx(test, org, (ctx) => M.add_participant(ctx, { tournamentId: id, userId: p.userId }));
        expect(enrolled(test, id, p.userId)).toMatchObject({ isWaitlisted: false, approvedByToAt: expect.anything(), status: { tag: 'Registered' } });
        expect(locks(test, id, p.userId)).toEqual([acc]);
        expectReject(test, org, (ctx) => M.add_participant(ctx, { tournamentId: id, userId: p.userId }),
            'This player is already registered for this tournament.');

        const g = guest(test, 'g');
        expectReject(test, org, (ctx) => M.add_participant(ctx, { tournamentId: id, userId: g.userId }),
            'Only verified players can be added to a tournament.');
        expectReject(test, org, (ctx) => M.add_participant(ctx, { tournamentId: id, userId: 9999 }), 'Target user not found.');

        const q = verified(test, 'q');
        tx(test, org, (ctx) => M.add_participant(ctx, { tournamentId: id, userId: q.userId }));
        const r = verified(test, 'r');
        expectReject(test, org, (ctx) => M.add_participant(ctx, { tournamentId: id, userId: r.userId }), 'No free spot: the tournament is full.');
        dq(test, org, id, q.userId);
        expectReject(test, org, (ctx) => M.add_participant(ctx, { tournamentId: id, userId: q.userId }),
            'This player was disqualified from this tournament.');
    });

    it('add_participant: allowed in Seeding before generation; rejected after it and from InProgress', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org);
        fullTeams(test, id, 2);
        advanceStage(test, org, id, 'Seeding');
        const p = verified(test, 'p');
        tx(test, org, (ctx) => M.add_participant(ctx, { tournamentId: id, userId: p.userId }));
        expect(enrolled(test, id, p.userId)).toBeDefined();
        seedAndGenerate(test, org, id);
        const q = verified(test, 'q');
        expectReject(test, org, (ctx) => M.add_participant(ctx, { tournamentId: id, userId: q.userId }), 'Bracket generated; use stand-ins.');
        advanceStage(test, org, id, 'InProgress');
        expectReject(test, org, (ctx) => M.add_participant(ctx, { tournamentId: id, userId: q.userId }),
            'Tournament is in InProgress; the field can change from Registration through Seeding only.');
    });

    it('reject_participant deletes a pending enrolment (may register again); an approved one is rejected', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { requireApproval: true });
        const [p, q] = enrollMany(test, id, 2);
        tx(test, org, (ctx) => M.approve_participant(ctx, { tournamentId: id, userId: q.userId }));
        tx(test, org, (ctx) => M.reject_participant(ctx, { tournamentId: id, userId: p.userId }));
        expect(enrolled(test, id, p.userId)).toBeUndefined();
        register(test, p, id);
        expect(enrolled(test, id, p.userId)).toBeDefined();
        expectReject(test, org, (ctx) => M.reject_participant(ctx, { tournamentId: id, userId: q.userId }),
            'Participant is already approved; disqualify them instead.');
        expectReject(test, org, (ctx) => M.reject_participant(ctx, { tournamentId: id, userId: 9999 }), 'Participant not found.');
    });
});

describe('withdraw_from_tournament (A26a(1)(3))', () => {
    it('in Registration: the row, locks and membership go; the captaincy passes on; the spot frees', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { teamSize: 3 });
        const [cap, m1, m2] = enrollMany(test, id, 3);
        const teamId = makeTeam(test, id, cap, [m1, m2], 'Trio');
        expect(teamRow(test, teamId)!.status.tag).toBe('Ready');
        insertHsrAccount(test, cap.userId, '500');
        expect(locks(test, id, cap.userId)).toEqual([]); // registered before owning an account

        tx(test, cap, (ctx) => M.withdraw_from_tournament(ctx, { tournamentId: id }));
        expect(enrolled(test, id, cap.userId)).toBeUndefined();
        expect(membership(test, id, cap.userId)).toBeUndefined();
        expect(teamRow(test, teamId)!.captainUserId).toBe(Math.min(m1.userId, m2.userId));
        expect(teamRow(test, teamId)!.status.tag).toBe('Forming');

        register(test, cap, id); // may register again; locks taken now
        expect(enrolled(test, id, cap.userId)).toBeDefined();
        expect(locks(test, id, cap.userId)).toHaveLength(1);
        tx(test, cap, (ctx) => M.withdraw_from_tournament(ctx, { tournamentId: id }));
        expect(locks(test, id, cap.userId)).toEqual([]);
    });

    it('a pending request is deleted with the enrolment; the last member withdrawing disbands the team', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org);
        const [cap, asker] = enrollMany(test, id, 2);
        const teamId = makeTeam(test, id, cap, [], 'Short');
        tx(test, asker, (ctx) => M.request_join_team(ctx, { teamId }));
        tx(test, asker, (ctx) => M.withdraw_from_tournament(ctx, { tournamentId: id }));
        expect(requestsOf(test, asker.userId)).toHaveLength(0);
        tx(test, cap, (ctx) => M.withdraw_from_tournament(ctx, { tournamentId: id }));
        expect(teamRow(test, teamId)).toBeFalsy();
        expect(teams(test, id)).toHaveLength(0);
    });

    it('allowed in CheckIn; rejected from Seeding on', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { checkInEnabled: true });
        const ts = fullTeams(test, id, 3);
        const [loner] = enrollMany(test, id, 1, 'loner');
        advanceStage(test, org, id, 'CheckIn');
        tx(test, loner, (ctx) => M.withdraw_from_tournament(ctx, { tournamentId: id }));
        expect(enrolled(test, id, loner.userId)).toBeUndefined();
        for (const t of ts.slice(0, 2)) tx(test, t.captain, (ctx) => M.check_in_tournament(ctx, { tournamentId: id }));
        advanceStage(test, org, id, 'Seeding');
        expectReject(test, ts[0].mate, (ctx) => M.withdraw_from_tournament(ctx, { tournamentId: id }), 'Registration is closed; ask staff.');
        expect(enrolled(test, id, ts[0].mate.userId)).toBeDefined();
    });
});

describe('withdraw_tournament_team (A26)', () => {
    it('the captain withdraws the team: Withdrawn, members stay enrolled and on the team, requests deleted', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { teamSize: 3 });
        const [cap, mate, asker] = enrollMany(test, id, 3);
        const teamId = makeTeam(test, id, cap, [mate], 'Pulled');
        tx(test, asker, (ctx) => M.request_join_team(ctx, { teamId }));
        expectReject(test, mate, (ctx) => M.withdraw_tournament_team(ctx, { teamId }), 'Only the team captain can withdraw the team.');
        tx(test, cap, (ctx) => M.withdraw_tournament_team(ctx, { teamId }));
        expect(teamRow(test, teamId)!.status.tag).toBe('Withdrawn');
        expect(membersOf(test, teamId)).toEqual([cap.userId, mate.userId].sort((a, b) => a - b));
        expect(enrolled(test, id, mate.userId).status.tag).toBe('Registered');
        expect(requestsOf(test, asker.userId)).toHaveLength(0);
        expectReject(test, cap, (ctx) => M.withdraw_tournament_team(ctx, { teamId }), 'Team is Withdrawn.');
    });

    it('rejected from Seeding on', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org);
        const ts = fullTeams(test, id, 2);
        advanceStage(test, org, id, 'Seeding');
        expectReject(test, ts[0].captain, (ctx) => M.withdraw_tournament_team(ctx, { teamId: ts[0].teamId }), 'Registration is closed; ask staff.');
        expect(teamRow(test, ts[0].teamId)!.status.tag).toBe('Ready');
        expect(enrolledAll(test, id)).toHaveLength(4);
    });
});

describe('S8b review fixes (registration)', () => {
    it('fix 2: anonymous solo without an alias (registration or add_participant) gets "Player <n>", never the display name', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { teamSize: 1, isAnonymousDefault: true });
        const [p] = enrollMany(test, id, 1, 'visible');
        const added = verified(test, 'addedName');
        tx(test, org, (ctx) => M.add_participant(ctx, { tournamentId: id, userId: added.userId }));
        const names = [p, added].map((a) => teamRow(test, membership(test, id, a.userId)!.teamId)!.name);
        for (const n of names) expect(n).toMatch(/^Player \d+$/);
        expect(new Set(names).size).toBe(2);
        expect(names.join(' ')).not.toMatch(/visible|addedName/);
        tx(test, p, (ctx) => M.set_anonymous_alias(ctx, { tournamentId: id, alias: 'Ghost' }));
        expect(teamRow(test, membership(test, id, p.userId)!.teamId)!.name).toBe('Ghost');

        const open = openTournament(test, org, { teamSize: 1 });
        const [q] = enrollMany(test, open, 1, 'shown');
        expect(teamRow(test, membership(test, open, q.userId)!.teamId)!.name).toBe('shown1'); // non-anonymous keeps it
    });

    it('fix 5: in CheckIn the last member withdrawing leaves the team Withdrawn (not deleted); in Registration it is deleted', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { checkInEnabled: true });
        const ts = fullTeams(test, id, 3);
        advanceStage(test, org, id, 'CheckIn');
        const t = ts[2];
        tx(test, t.mate, (ctx) => M.withdraw_from_tournament(ctx, { tournamentId: id }));
        expect(teamRow(test, t.teamId)!.status.tag).toBe('Forming');
        tx(test, t.captain, (ctx) => M.withdraw_from_tournament(ctx, { tournamentId: id }));
        expect(teamRow(test, t.teamId)).toBeTruthy();
        expect(teamRow(test, t.teamId)!.status.tag).toBe('Withdrawn');
        expect(enrolled(test, id, t.captain.userId)).toBeUndefined();
    });
});
