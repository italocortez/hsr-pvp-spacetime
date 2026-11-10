// T-S8b: in-memory tests for the S8b team reducers (A26, A26a, A36a; review T9, T10, T13, T23, T24, TD-18):
// team edits in Registration only, Forming ↔ Ready, captain-only decisions, waitlisted members, rename / alias,
// add_team_member, team-level check-in (A26) and manual groups (A32, A36a). Builders in s8-fixtures.ts.
import { describe, expect, it } from 'vitest';
import { TOURNAMENT_PERM_MESSAGES } from '@module/helpers/tournament/tournamentPermissions';
import { M, advance, expectReject, newHarness, tx, type Harness } from './s4-fixtures';
import {
    advanceStage,
    assignAssistant,
    enrollMany,
    enrolled,
    fullTeams,
    host,
    makeTeam,
    membersOf,
    membership,
    openTournament,
    register,
    requestsOf,
    seedAndGenerate,
    tRow,
    teamRow,
    verified,
} from './s8-fixtures';

const status = (test: Harness, teamId: number) => teamRow(test, teamId)!.status.tag;

describe('team edits: Registration only, captain decisions, Forming ↔ Ready (A26, A26a)', () => {
    it('Forming → Ready at teamSize; Ready → Forming when a member leaves; the captain leaving passes the captaincy', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { teamSize: 3 });
        const [cap, a, b] = enrollMany(test, id, 3);
        const teamId = makeTeam(test, id, cap, [a], 'Trio');
        expect(status(test, teamId)).toBe('Forming');
        tx(test, b, (ctx) => M.request_join_team(ctx, { teamId }));
        tx(test, cap, (ctx) => M.accept_team_request(ctx, { teamId, userId: b.userId }));
        expect(status(test, teamId)).toBe('Ready');
        expect(membersOf(test, teamId)).toHaveLength(3);

        tx(test, b, (ctx) => M.leave_tournament_team(ctx, { teamId }));
        expect(status(test, teamId)).toBe('Forming');
        expect(enrolled(test, id, b.userId)).toBeDefined(); // leaving keeps the enrolment

        tx(test, cap, (ctx) => M.leave_tournament_team(ctx, { teamId }));
        expect(teamRow(test, teamId)!.captainUserId).toBe(a.userId);
        tx(test, a, (ctx) => M.leave_tournament_team(ctx, { teamId }));
        expect(teamRow(test, teamId)).toBeFalsy(); // the last member leaving deletes the team
        expectReject(test, cap, (ctx) => M.leave_tournament_team(ctx, { teamId }), 'Team not found.');
    });

    it('captain-only decisions; a full team rejects joins; one pending request per team; accepting clears other requests', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org);
        const [cap, mate, x, y] = enrollMany(test, id, 4);
        const teamId = makeTeam(test, id, cap, [], 'Duo');
        const other = makeTeam(test, id, y, [], 'Other');
        tx(test, mate, (ctx) => M.request_join_team(ctx, { teamId }));
        tx(test, mate, (ctx) => M.request_join_team(ctx, { teamId: other }));
        expectReject(test, mate, (ctx) => M.request_join_team(ctx, { teamId }), 'You already have a pending request to join this team.');
        tx(test, x, (ctx) => M.request_join_team(ctx, { teamId }));
        expectReject(test, x, (ctx) => M.accept_team_request(ctx, { teamId, userId: mate.userId }), 'Only the team captain can accept join requests.');
        expectReject(test, x, (ctx) => M.reject_team_request(ctx, { teamId, userId: x.userId }), 'Only the team captain can reject join requests.');
        expectReject(test, mate, (ctx) => M.disband_tournament_team(ctx, { teamId }), 'Only the team captain can disband the team.');

        tx(test, cap, (ctx) => M.accept_team_request(ctx, { teamId, userId: mate.userId }));
        expect(status(test, teamId)).toBe('Ready');
        expect(requestsOf(test, mate.userId)).toHaveLength(0); // the request to `other` went too
        expectReject(test, cap, (ctx) => M.accept_team_request(ctx, { teamId, userId: x.userId }), 'Team is already full.');
        const z = enrollMany(test, id, 1, 'z')[0];
        expectReject(test, z, (ctx) => M.request_join_team(ctx, { teamId }), 'Team is already full.');
        tx(test, cap, (ctx) => M.reject_team_request(ctx, { teamId, userId: x.userId }));
        expect(requestsOf(test, x.userId)).toHaveLength(0);
        expectReject(test, cap, (ctx) => M.reject_team_request(ctx, { teamId, userId: x.userId }), 'Join request not found.');

        tx(test, cap, (ctx) => M.disband_tournament_team(ctx, { teamId }));
        expect(teamRow(test, teamId)).toBeFalsy();
        expect(membership(test, id, mate.userId)).toBeUndefined();
        expect(enrolled(test, id, mate.userId)).toBeDefined(); // members stay enrolled and teamless
    });

    it('the creator / joiner must be enrolled, approved when required, and teamless (T13)', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { requireApproval: true });
        const outsider = verified(test, 'outsider');
        expectReject(test, outsider, (ctx) => M.create_tournament_team(ctx, { tournamentId: id, teamName: 'X' }),
            'You must be registered in the tournament first.');
        const [p, q] = enrollMany(test, id, 2);
        expectReject(test, p, (ctx) => M.create_tournament_team(ctx, { tournamentId: id, teamName: 'X' }), 'Your registration awaits approval.');
        for (const u of [p, q]) tx(test, org, (ctx) => M.approve_participant(ctx, { tournamentId: id, userId: u.userId }));
        const teamId = makeTeam(test, id, p, [], 'X');
        expectReject(test, p, (ctx) => M.create_tournament_team(ctx, { tournamentId: id, teamName: 'Y' }),
            'You are already on a team in this tournament.');
        expectReject(test, p, (ctx) => M.request_join_team(ctx, { teamId }), 'You are already on a team in this tournament.');
        void q;
    });

    it('team edits stop when registration closes (CheckIn); disband after close rejected (TD-18)', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { checkInEnabled: true, teamSize: 3 });
        const [cap, mate, joiner, solo] = enrollMany(test, id, 4);
        const teamId = makeTeam(test, id, cap, [mate], 'Late');
        tx(test, joiner, (ctx) => M.request_join_team(ctx, { teamId }));
        advanceStage(test, org, id, 'CheckIn');
        expectReject(test, solo, (ctx) => M.create_tournament_team(ctx, { tournamentId: id, teamName: 'New' }),
            'Teams can only be created during the Registration stage.');
        expectReject(test, solo, (ctx) => M.request_join_team(ctx, { teamId }), 'Teams can only be joined during the Registration stage.');
        expectReject(test, cap, (ctx) => M.accept_team_request(ctx, { teamId, userId: joiner.userId }),
            'Teams can only be joined during the Registration stage.');
        expectReject(test, cap, (ctx) => M.reject_team_request(ctx, { teamId, userId: joiner.userId }),
            'Teams can only be edited during the Registration stage.');
        expectReject(test, mate, (ctx) => M.leave_tournament_team(ctx, { teamId }), 'Teams can only be left during the Registration stage.');
        expectReject(test, cap, (ctx) => M.disband_tournament_team(ctx, { teamId }), 'Teams can only be disbanded during the Registration stage.');
        expect(membersOf(test, teamId)).toHaveLength(2);
    });

    it('waitlisted players may create or join a team; it stays Forming until they are promoted (A26a(4))', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { maxParticipants: 3, waitlistEnabled: true });
        const [a, b, c] = enrollMany(test, id, 3);
        const [w1, w2] = enrollMany(test, id, 2, 'w');
        expect(enrolled(test, id, w1.userId).isWaitlisted).toBe(true);
        const waitTeam = makeTeam(test, id, w1, [w2], 'Waiting');
        expect(membersOf(test, waitTeam)).toHaveLength(2);
        expect(status(test, waitTeam)).toBe('Forming');
        const mixed = makeTeam(test, id, a, [], 'Mixed');
        void mixed;
        tx(test, b, (ctx) => M.withdraw_from_tournament(ctx, { tournamentId: id }));
        tx(test, c, (ctx) => M.withdraw_from_tournament(ctx, { tournamentId: id }));
        tx(test, org, (ctx) => M.waitlist_promote(ctx, { tournamentId: id, userId: w1.userId }));
        expect(status(test, waitTeam)).toBe('Forming');
        tx(test, org, (ctx) => M.waitlist_promote(ctx, { tournamentId: id, userId: w2.userId }));
        expect(status(test, waitTeam)).toBe('Ready'); // refreshTeamOf on promotion
    });

    it('solo tournaments: no team creation, leaving or disbanding', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { teamSize: 1 });
        const [p] = enrollMany(test, id, 1);
        const teamId = membership(test, id, p.userId)!.teamId;
        expectReject(test, p, (ctx) => M.create_tournament_team(ctx, { tournamentId: id, teamName: 'X' }), 'Cannot create teams in a solo tournament.');
        expectReject(test, p, (ctx) => M.leave_tournament_team(ctx, { teamId }), 'A solo team cannot be left; withdraw from the tournament instead.');
        expectReject(test, p, (ctx) => M.disband_tournament_team(ctx, { teamId }), 'A solo team cannot be disbanded; withdraw from the tournament instead.');
    });
});

describe('naming (A36a)', () => {
    it('rename_tournament_team: captain, Registration or CheckIn, 1–40 characters, unique case-insensitively', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { checkInEnabled: true });
        const ts = fullTeams(test, id, 2);
        const [t1, t2] = ts;
        const rename = (who: any, teamId: number, name: string) => tx(test, who, (ctx) => M.rename_tournament_team(ctx, { teamId, name }));
        expectReject(test, t1.mate, (ctx) => M.rename_tournament_team(ctx, { teamId: t1.teamId, name: 'X' }),
            'Only the team captain can rename the team.');
        expectReject(test, t1.captain, (ctx) => M.rename_tournament_team(ctx, { teamId: t1.teamId, name: '   ' }), 'Team name must be 1-40 characters.');
        expectReject(test, t1.captain, (ctx) => M.rename_tournament_team(ctx, { teamId: t1.teamId, name: 'x'.repeat(41) }),
            'Team name must be 1-40 characters.');
        expectReject(test, t1.captain, (ctx) => M.rename_tournament_team(ctx, { teamId: t1.teamId, name: 'T TEAM 2' }),
            'Another team in this tournament already uses that name.');
        rename(t1.captain, t1.teamId, '  ' + 'y'.repeat(40) + '  ');
        expect(teamRow(test, t1.teamId)!.name).toBe('y'.repeat(40));
        rename(t2.captain, t2.teamId, 'T team 2'.toUpperCase()); // its own name in another case is fine
        expect(teamRow(test, t2.teamId)!.name).toBe('T TEAM 2');
        expectReject(test, t1.captain, (ctx) => M.create_tournament_team(ctx, { tournamentId: id, teamName: 'x' }),
            'You are already on a team in this tournament.');
        const [loner] = enrollMany(test, id, 1, 'loner');
        expectReject(test, loner, (ctx) => M.create_tournament_team(ctx, { tournamentId: id, teamName: 't team 2' }),
            'Another team in this tournament already uses that name.');

        advanceStage(test, org, id, 'CheckIn');
        rename(t1.captain, t1.teamId, 'Checked');
        expect(teamRow(test, t1.teamId)!.name).toBe('Checked');
        for (const t of ts) tx(test, t.captain, (ctx) => M.check_in_tournament(ctx, { tournamentId: id }));
        advanceStage(test, org, id, 'Seeding');
        expectReject(test, t1.captain, (ctx) => M.rename_tournament_team(ctx, { teamId: t1.teamId, name: 'Late' }),
            'Teams can only be renamed during Registration or CheckIn.');
    });

    it('review fix 6: auto-generated solo team names are unique (" (2)", " (3)" suffixes); solo teams cannot be renamed', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { teamSize: 1 });
        // Display names are not unique (usernames are): three players shown as "Same".
        const twins = ['s1', 's2', 's3'].map((sub) => {
            const a = verified(test, sub);
            test.db.User.id.update({ ...test.db.User.id.find(a.userId)!, displayName: 'Same' });
            return a;
        });
        register(test, twins[0], id);
        register(test, twins[1], id);
        tx(test, org, (ctx) => M.add_participant(ctx, { tournamentId: id, userId: twins[2].userId }));
        const names = twins.map((a) => teamRow(test, membership(test, id, a.userId)!.teamId)!.name);
        expect(names).toEqual(['Same', 'Same (2)', 'Same (3)']);
        const teamId = membership(test, id, twins[0].userId)!.teamId;
        expectReject(test, twins[0], (ctx) => M.rename_tournament_team(ctx, { teamId, name: 'Other' }), 'A solo team is named after its player.');
    });

    it('set_anonymous_alias: anonymous tournaments only, before Seeding, 1–32 characters; a solo team takes the alias', () => {
        const test = newHarness();
        const org = host(test);
        const plainT = openTournament(test, org, { teamSize: 1 });
        const [p] = enrollMany(test, plainT, 1);
        expectReject(test, p, (ctx) => M.set_anonymous_alias(ctx, { tournamentId: plainT, alias: 'Ghost' }),
            'Aliases are only used in anonymous tournaments.');

        const id = openTournament(test, org, { teamSize: 1, isAnonymousDefault: true, checkInEnabled: true });
        const outsider = verified(test, 'outsider');
        expectReject(test, outsider, (ctx) => M.set_anonymous_alias(ctx, { tournamentId: id, alias: 'Ghost' }),
            'You are not registered for this tournament.');
        const [a, b] = enrollMany(test, id, 2, 'a');
        const teamA = membership(test, id, a.userId)!.teamId;
        // review fix 2: an anonymous solo team without an alias gets a neutral name, never the display name
        expect(teamRow(test, teamA)!.name).toMatch(/^Player \d+$/);
        expect(teamRow(test, membership(test, id, b.userId)!.teamId)!.name).toMatch(/^Player \d+$/);
        expectReject(test, a, (ctx) => M.set_anonymous_alias(ctx, { tournamentId: id, alias: 'x'.repeat(33) }), 'Alias must be 1-32 characters.');
        tx(test, a, (ctx) => M.set_anonymous_alias(ctx, { tournamentId: id, alias: ' Ghost ' }));
        expect(enrolled(test, id, a.userId).anonymousAlias).toBe('Ghost');
        expect(teamRow(test, teamA)!.name).toBe('Ghost');
        const userA = test.db.User.id.find(a.userId)!;
        expect(teamRow(test, teamA)!.name).not.toBe(userA.displayName);
        // S10s re-alignment (A122(20), L69): an alias taken by another entrant (case-insensitive) is now refused;
        // before S10s it was accepted and the team name got " (2)" (review fix 6).
        expectReject(test, b, (ctx) => M.set_anonymous_alias(ctx, { tournamentId: id, alias: 'ghost' }),
            'That alias is already taken in this tournament. Choose another.');
        tx(test, b, (ctx) => M.set_anonymous_alias(ctx, { tournamentId: id, alias: 'Wraith' }));
        expect(teamRow(test, membership(test, id, b.userId)!.teamId)!.name).toBe('Wraith');

        advanceStage(test, org, id, 'CheckIn');
        tx(test, a, (ctx) => M.set_anonymous_alias(ctx, { tournamentId: id, alias: 'Shade' }));
        expect(teamRow(test, teamA)!.name).toBe('Shade');
        for (const u of [a, b]) tx(test, u, (ctx) => M.check_in_tournament(ctx, { tournamentId: id }));
        advanceStage(test, org, id, 'Seeding');
        expectReject(test, a, (ctx) => M.set_anonymous_alias(ctx, { tournamentId: id, alias: 'Late' }), 'Aliases can only be set before Seeding.');
    });
});

describe('add_team_member (participants, until generation; A26a)', () => {
    it('moves an enrolled teamless player into a short team; the team becomes Ready; guards', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { maxParticipants: 5, waitlistEnabled: true });
        const [cap, loose, other] = enrollMany(test, id, 3);
        const ts = fullTeams(test, id, 1, 'full'); // 2 more players: 5 of 5
        const [w] = enrollMany(test, id, 1, 'w');
        const teamId = makeTeam(test, id, cap, [], 'Short');
        tx(test, other, (ctx) => M.request_join_team(ctx, { teamId }));
        tx(test, loose, (ctx) => M.request_join_team(ctx, { teamId }));

        const plain = verified(test, 'plain');
        expectReject(test, plain, (ctx) => M.add_team_member(ctx, { teamId, userId: loose.userId }), TOURNAMENT_PERM_MESSAGES.participants);
        expectReject(test, org, (ctx) => M.add_team_member(ctx, { teamId, userId: w.userId }), 'The player is on the waitlist; promote them first.');
        expectReject(test, org, (ctx) => M.add_team_member(ctx, { teamId, userId: ts[0].mate.userId }), 'The player is already on a team.');
        expectReject(test, org, (ctx) => M.add_team_member(ctx, { teamId: ts[0].teamId, userId: loose.userId }), 'Team is already full.');

        tx(test, org, (ctx) => M.add_team_member(ctx, { teamId, userId: loose.userId }));
        expect(membersOf(test, teamId)).toContain(loose.userId);
        expect(status(test, teamId)).toBe('Ready');
        expect(requestsOf(test, loose.userId)).toHaveLength(0); // the player's own pending requests go
        expect(requestsOf(test, other.userId)).toHaveLength(1);
    });

    it('allowed in Seeding before generation (fills a team still Forming), rejected after bracketGeneratedAt', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org);
        fullTeams(test, id, 2);
        const [cap, loose, late] = enrollMany(test, id, 3, 's');
        const teamId = makeTeam(test, id, cap, [], 'Short');
        advanceStage(test, org, id, 'Seeding');
        expect(status(test, teamId)).toBe('Forming');
        const asst = verified(test, 'asst');
        assignAssistant(test, org, id, asst, { participants: true });
        tx(test, asst, (ctx) => M.add_team_member(ctx, { teamId, userId: loose.userId }));
        expect(status(test, teamId)).toBe('Ready');
        seedAndGenerate(test, org, id); // T-S8c: the real seed + generate (3 Ready teams) instead of a direct stamp
        const other = makeShortTeamDirect(test, id, late.userId);
        expectReject(test, org, (ctx) => M.add_team_member(ctx, { teamId: other, userId: late.userId }), 'Bracket generated; use stand-ins.');
    });
});

/** A Forming team row inserted directly (no participant can create one after registration closes). */
function makeShortTeamDirect(test: Harness, tournamentId: number, captainUserId: number): number {
    const ts = test.clock.now();
    return test.db.TournamentTeam.insert({
        id: 0, tournamentId, name: 'direct', captainUserId, status: { tag: 'Forming' } as any,
        seedNumber: undefined, groupId: undefined, finalPlacement: undefined,
        createdById: 0, createdDate: ts, lastModifiedById: 0, lastModifiedDate: ts,
    } as any).id;
}

describe('team check-in (A26)', () => {
    it('the captain checks the whole team in; a member cannot; staff with participants may name a team', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { checkInEnabled: true });
        const [t1, t2, t3] = fullTeams(test, id, 3);
        expectReject(test, t1.captain, (ctx) => M.check_in_tournament(ctx, { tournamentId: id }), 'Tournament is not in the CheckIn stage.');
        advanceStage(test, org, id, 'CheckIn');

        expectReject(test, t1.mate, (ctx) => M.check_in_tournament(ctx, { tournamentId: id }), 'Only the team captain can check the team in.');
        expectReject(test, t1.mate, (ctx) => M.check_in_tournament(ctx, { tournamentId: id, teamId: t1.teamId }),
            TOURNAMENT_PERM_MESSAGES.participants);
        tx(test, t1.captain, (ctx) => M.check_in_tournament(ctx, { tournamentId: id }));
        expect(enrolled(test, id, t1.captain.userId).status.tag).toBe('CheckedIn');
        expect(enrolled(test, id, t1.mate.userId).status.tag).toBe('CheckedIn');
        expectReject(test, t1.captain, (ctx) => M.check_in_tournament(ctx, { tournamentId: id }), 'Team is already checked in.');

        const bracketOnly = verified(test, 'bracketOnly');
        assignAssistant(test, org, id, bracketOnly, { bracket: true, results: true });
        expectReject(test, bracketOnly, (ctx) => M.check_in_tournament(ctx, { tournamentId: id, teamId: t2.teamId }),
            TOURNAMENT_PERM_MESSAGES.participants);
        const staff = verified(test, 'staff');
        assignAssistant(test, org, id, staff, { participants: true });
        tx(test, staff, (ctx) => M.check_in_tournament(ctx, { tournamentId: id, teamId: t2.teamId }));
        expect(enrolled(test, id, t2.mate.userId).status.tag).toBe('CheckedIn');

        advanceStage(test, org, id, 'Seeding');
        expect(status(test, t1.teamId)).toBe('Ready');
        expect(status(test, t2.teamId)).toBe('Ready');
        expect(status(test, t3.teamId)).toBe('Withdrawn');
        expect(enrolled(test, id, t3.captain.userId).status.tag).toBe('Registered');
    });

    it('a team of another tournament or a withdrawn team cannot be checked in', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { checkInEnabled: true });
        const [t1, t2] = fullTeams(test, id, 2);
        const otherT = openTournament(test, org, { checkInEnabled: true });
        tx(test, t2.captain, (ctx) => M.withdraw_tournament_team(ctx, { teamId: t2.teamId }));
        advanceStage(test, org, id, 'CheckIn');
        expectReject(test, org, (ctx) => M.check_in_tournament(ctx, { tournamentId: id, teamId: 9999 }), 'Team not found in this tournament.');
        void otherT;
        expectReject(test, t2.captain, (ctx) => M.check_in_tournament(ctx, { tournamentId: id }), 'Team is Withdrawn.');
        tx(test, t1.captain, (ctx) => M.check_in_tournament(ctx, { tournamentId: id }));
    });
});

describe('manual groups (A32, A36a)', () => {
    /** GroupOnly, Manual, groupSize 2, four Ready teams, in Seeding. */
    function manual(over = {}) {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { format: 'GroupOnly', groupAssignmentMode: 'Manual', groupSize: 2, groupAdvanceCount: 1, maxParticipants: 10, ...over });
        const ts = fullTeams(test, id, 4);
        return { test, org, id, ts };
    }

    it('assign_team_group: bracket permission, Seeding, index below groupCount(ready, groupSize); stamps lastSeedChangeAt', () => {
        const { test, org, id, ts } = manual();
        expectReject(test, org, (ctx) => M.assign_team_group(ctx, { tournamentId: id, teamId: ts[0].teamId, groupIndex: 0 }),
            'Groups can only be assigned during Seeding.');
        advanceStage(test, org, id, 'Seeding');
        const partsOnly = verified(test, 'parts');
        assignAssistant(test, org, id, partsOnly, { participants: true, results: true });
        expectReject(test, partsOnly, (ctx) => M.assign_team_group(ctx, { tournamentId: id, teamId: ts[0].teamId, groupIndex: 0 }),
            TOURNAMENT_PERM_MESSAGES.bracket);
        expectReject(test, org, (ctx) => M.assign_team_group(ctx, { tournamentId: id, teamId: ts[0].teamId, groupIndex: 2 }),
            'groupIndex must be below 2 (4 Ready teams, groupSize 2).');
        expectReject(test, org, (ctx) => M.assign_team_group(ctx, { tournamentId: id, teamId: 9999, groupIndex: 0 }),
            'Team not found in this tournament.');

        expect(tRow(test, id).lastSeedChangeAt).toBeUndefined();
        const bracketAsst = verified(test, 'bracket');
        assignAssistant(test, org, id, bracketAsst, { bracket: true });
        tx(test, bracketAsst, (ctx) => M.assign_team_group(ctx, { tournamentId: id, teamId: ts[0].teamId, groupIndex: 1 }));
        expect(teamRow(test, ts[0].teamId)!.groupId).toBe(1);
        const stamped = tRow(test, id).lastSeedChangeAt!.microsSinceUnixEpoch;
        advance(test, 1_000);
        tx(test, org, (ctx) => M.assign_team_group(ctx, { tournamentId: id, teamId: ts[0].teamId, groupIndex: 1 })); // no change
        expect(tRow(test, id).lastSeedChangeAt!.microsSinceUnixEpoch).toBe(stamped);

        advance(test, 1_000);
        tx(test, org, (ctx) => M.clear_team_groups(ctx, { tournamentId: id }));
        expect(teamRow(test, ts[0].teamId)!.groupId).toBeUndefined();
        expect(tRow(test, id).lastSeedChangeAt!.microsSinceUnixEpoch > stamped).toBe(true);
        expectReject(test, partsOnly, (ctx) => M.clear_team_groups(ctx, { tournamentId: id }), TOURNAMENT_PERM_MESSAGES.bracket);
    });

    it('only Ready teams are grouped', () => {
        const { test, org, id, ts } = manual();
        const [cap] = enrollMany(test, id, 1, 'short');
        const shortTeam = makeTeam(test, id, cap, [], 'Short');
        advanceStage(test, org, id, 'Seeding');
        expect(ts).toHaveLength(4);
        expectReject(test, org, (ctx) => M.assign_team_group(ctx, { tournamentId: id, teamId: shortTeam, groupIndex: 0 }),
            'Team is Forming; only Ready teams are grouped.');
    });

    it('Auto mode and non-group formats are rejected', () => {
        const auto = manual({ groupAssignmentMode: 'Auto' });
        advanceStage(auto.test, auto.org, auto.id, 'Seeding');
        expectReject(auto.test, auto.org, (ctx) => M.assign_team_group(ctx, { tournamentId: auto.id, teamId: auto.ts[0].teamId, groupIndex: 0 }),
            'Group assignment is automatic for this tournament.');
        expectReject(auto.test, auto.org, (ctx) => M.clear_team_groups(ctx, { tournamentId: auto.id }),
            'Group assignment is automatic for this tournament.');

        const elim = manual({ format: 'SingleElimination' });
        advanceStage(elim.test, elim.org, elim.id, 'Seeding');
        expectReject(elim.test, elim.org, (ctx) => M.assign_team_group(ctx, { tournamentId: elim.id, teamId: elim.ts[0].teamId, groupIndex: 0 }),
            'This tournament has no group stage.');
    });
});

