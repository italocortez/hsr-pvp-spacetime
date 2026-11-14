// Tournaments: deleting a user with tournament ties: an organizer cannot delete their account; deletion settles the
//   user's tournament ties; a deleted or banned organizer is replaced, or a server deletion cancels the unfinished
//   tournaments.
// Decisions: A94, A121, A124
// Contracts: docs/tournament/contract.md, docs/brackets/contract.md
// From S10g, S10s, S10q (s10g-tournament.test.ts, s10s-triage-fixes.test.ts, s10q-gap-coverage.test.ts); merged by
// T-REORG2.
//
// Titles starting "pins current behaviour (row silent)": the decision row says nothing about the case, so the test
// records today's behaviour rather than a rule; the owner accepted these pins (A145). A later decision on the case
// replaces the pin with a rule test.
import { describe, expect, it } from 'vitest';
import { ScheduleAt } from 'spacetimedb';
import {
    M,
    guest,
    lobbyRow,
    newHarness,
    tx,
    type Actor,
    type Harness,
    rejection,
    advance,
    disconnect,
    expectReject,
    now,
    AUDIT,
} from '../fixtures/harness';
import {
    host,
    setUserRole,
    verified,
    fireDeletionJob,
    admin,
    providerOf,
    existingUser,
    signIn,
} from '../fixtures/identity';
import { DAY_MS, createEvent } from '../fixtures/calendar';
import { insertHsrAccount } from '../fixtures/roster';
import {
    advanceStage,
    assignAssistant,
    bracketRows,
    createTournament,
    enrollMany,
    enrolled,
    fullTeams,
    locks,
    makeTeam,
    matchRow,
    membersOf,
    membership,
    openTournament,
    register,
    requestsOf,
    resolveMatch,
    seedAndGenerate,
    stageOf,
    tRow,
    teamRow,
    teams,
    waitlistRows,
    soloLive,
    updateBody,
} from '../fixtures/tournaments';
import { byKey, duel, openMatchLobby, createTournamentLobby, playMatch } from '../fixtures/tournament-matches';

// ─── Texts ───────────────────────────────────────────────────────────────────

const ORGANIZER_DELETE = 'You organize a tournament that has not finished. Cancel it, or wait until it ends, before deleting your account.';
const LEAVE_LOBBY_DELETE = 'Leave your lobby before deleting your account.';

type DeletePath = 'self' | 'admin';

/** Deletes `who`: delete_my_account as the user, or admin_delete_row('User') + the scheduled run_user_deletion. */
function deleteUser(test: Harness, path: DeletePath, who: Actor, boss: Actor) {
    if (path === 'self') {
        tx(test, who, (ctx) => M.delete_my_account(ctx, {}));
    } else {
        adminDeleteUser(test, boss, who);
    }
}

/**
 * The deleted player for a path: a guest for delete_my_account, a verified user for the admin path. Since the S10g
 * review F1 fix a verified user's own deletion settles the enrolment too (covered in the 'A94(2) review F1' block).
 */
const playerFor = (test: Harness, path: DeletePath, name: string): Actor => (path === 'self' ? guest(test, name) : verified(test, name));

// ════════════════════════════════════════════════════════════════════════════
// A94: user deletion and tournaments
// ════════════════════════════════════════════════════════════════════════════

describe('A94(1): the organizer of an unfinished tournament cannot delete their account', () => {
    it('A94(1) verified branch: rejected in Draft, Registration and InProgress with the text; allowed once the tournament is Completed', () => {
        const test = newHarness();
        const org = host(test);
        const id = createTournament(test, org);
        const del = (ctx: any) => M.delete_my_account(ctx, {});
        expect(stageOf(test, id)).toBe('Draft');
        expect(rejection(test, org, del)).toBe(ORGANIZER_DELETE);
        advanceStage(test, org, id, 'Registration');
        expect(rejection(test, org, del)).toBe(ORGANIZER_DELETE);
        const [a, b] = fullTeams(test, id, 2);
        advanceStage(test, org, id, 'Seeding');
        seedAndGenerate(test, org, id);
        advanceStage(test, org, id, 'InProgress');
        expect(rejection(test, org, del)).toBe(ORGANIZER_DELETE);
        expect(test.db.User.id.find(org.userId)).toBeTruthy();

        const final = byKey(test, id, 'W-R1-M1');
        resolveMatch(test, org, final.id, a.teamId);
        advanceStage(test, org, id, 'Completed');
        tx(test, org, del);
        expect(test.db.UserIdentity.identity.find(org.identity)).toBeFalsy();
        expect(teamRow(test, b.teamId)).toBeTruthy(); // the tournament's rows stay
    });

    it('A94(1) guest branch: a guest Tournament Host is rejected while the tournament is in Draft; allowed once it is Cancelled', () => {
        const test = newHarness();
        const g = guest(test, 'gorg');
        setUserRole(test, g.userId, 'TournamentHost');
        const id = createTournament(test, g);
        const del = (ctx: any) => M.delete_my_account(ctx, {});
        expect(rejection(test, g, del)).toBe(ORGANIZER_DELETE);
        expect(test.db.UserIdentity.identity.find(g.identity)).toBeTruthy();
        tx(test, g, (ctx) => M.cancel_tournament(ctx, { tournamentId: id }));
        tx(test, g, del);
        expect(test.db.UserIdentity.identity.find(g.identity)).toBeFalsy();
        expect(tRow(test, id).stage.tag).toBe('Cancelled');
    });
});

describe('A94(2): deletion settles the user\'s tournament ties', () => {
    for (const path of ['self', 'admin'] as const) {
        it(`A94(2) (${path}): an enrolled solo player before the bracket exists is withdrawn: enrolment, solo team, membership and locks gone; the spot is freed`, () => {
            const test = newHarness();
            const org = host(test);
            const boss = admin(test, 'admin');
            const id = openTournament(test, org, { teamSize: 1, maxParticipants: 2 });
            const p = playerFor(test, path, 'gone');
            const acct = insertHsrAccount(test, p.userId, 'gone-main');
            register(test, p, id);
            const [other] = enrollMany(test, id, 1, 'stay');
            const teamId = membership(test, id, p.userId)!.teamId;
            expect(locks(test, id, p.userId)).toEqual([acct]);
            const late = verified(test, 'late');
            expect(rejection(test, late, (ctx) => M.register_for_tournament(ctx, { tournamentId: id }))).toBe('Tournament is full.');

            deleteUser(test, path, p, boss);
            expect(enrolled(test, id, p.userId)).toBeUndefined();
            expect(membership(test, id, p.userId)).toBeUndefined();
            expect(teamRow(test, teamId)).toBeFalsy(); // a solo team left empty in Registration is deleted
            expect(locks(test, id, p.userId)).toEqual([]);
            expect(enrolled(test, id, other.userId)).toBeDefined();
            register(test, late, id);
            expect(enrolled(test, id, late.userId).isWaitlisted).toBe(false);
        });

        it(`A94(2) (${path}): a team captain deleted before the bracket is handled as a withdrawal (captain transferred, team refreshed)`, () => {
            const test = newHarness();
            const org = host(test);
            const boss = admin(test, 'admin');
            const id = openTournament(test, org);
            const cap = playerFor(test, path, 'cap');
            register(test, cap, id);
            const [mate] = enrollMany(test, id, 1, 'mate');
            const teamId = makeTeam(test, id, cap, [mate], 'Capped');
            expect(teamRow(test, teamId)!.status.tag).toBe('Ready');

            deleteUser(test, path, cap, boss);
            expect(enrolled(test, id, cap.userId)).toBeUndefined();
            const team = teamRow(test, teamId)!;
            expect(team.captainUserId).toBe(mate.userId);
            expect(membersOf(test, teamId)).toEqual([mate.userId]);
            expect(team.status.tag).toBe('Forming');
        });

        it(`A94(2) (${path}): a player deleted after the bracket exists is Disqualified and their Ready match is settled as dq_participant would (Dq, opponent wins)`, () => {
            const test = newHarness();
            const org = host(test);
            const boss = admin(test, 'admin');
            const p = playerFor(test, path, 'gone');
            const q = verified(test, 'opp');
            const id = soloLive(test, org, [p, q], p).id;
            const m = bracketRows(test, id)[0];
            expect(m.state.tag).toBe('Ready');
            const pTeam = membership(test, id, p.userId)!.teamId;
            const qTeam = membership(test, id, q.userId)!.teamId;

            deleteUser(test, path, p, boss);
            expect(enrolled(test, id, p.userId).status.tag).toBe('Disqualified');
            expect(membership(test, id, p.userId)).toBeUndefined();
            expect(teamRow(test, pTeam)!.status.tag).toBe('Disqualified');
            const after = matchRow(test, m.id);
            expect(after.state.tag).toBe('Decided');
            expect(after.decidedBy?.tag).toBe('Dq');
            expect(after.winnerTeamId).toBe(qTeam);
        });

        // Self path: a stand-in must be verified, so the enrolment ties (request, locks, waitlist) sit on a guest and the
        // staff ties (assistant, stand-in) on a verified user who is not enrolled; both delete their own account. Admin
        // path: one verified user holds all.
        it(`A94(2) (${path}): the user's pending team requests, assistant rows, stand-in approvals, account locks and waitlist account rows are gone`, () => {
            const test = newHarness();
            const org = host(test);
            const boss = admin(test, 'admin');
            const x = playerFor(test, path, 'x');
            const s = path === 'self' ? verified(test, 'staffed') : x;
            const acct = insertHsrAccount(test, x.userId, 'x-main');

            // a pending request in a team tournament (and the registration locks)
            const t1 = openTournament(test, org, { name: 'Requests' });
            register(test, x, t1);
            const [cap] = enrollMany(test, t1, 1, 'c');
            tx(test, cap, (ctx) => M.create_tournament_team(ctx, { tournamentId: t1, teamName: 'Open' }));
            const openTeam = teams(test, t1).find((t) => t.name === 'Open')!.id;
            tx(test, x, (ctx) => M.request_join_team(ctx, { teamId: openTeam }));
            expect(requestsOf(test, x.userId)).toHaveLength(1);
            // an assistant row
            const t2 = openTournament(test, org, { name: 'Assisted' });
            assignAssistant(test, org, t2, s, { results: true });
            // a stand-in approval on a live bracket match
            const t3 = openTournament(test, org, { name: 'Live' });
            fullTeams(test, t3, 2, 'z');
            advanceStage(test, org, t3, 'Seeding');
            seedAndGenerate(test, org, t3);
            advanceStage(test, org, t3, 'InProgress');
            const m3 = bracketRows(test, t3)[0];
            tx(test, org, (ctx) => M.approve_stand_in(ctx, { bracketMatchId: m3.id, teamId: m3.team1Id!, userId: s.userId }));
            // a waitlisted registration with a remembered account choice
            const t4 = openTournament(test, org, { name: 'Full', maxParticipants: 2, waitlistEnabled: true }); // S10s re-alignment (A122(17), F7): the floor is 2
            enrollMany(test, t4, 2, 'f'); // S10s re-alignment (F7)
            register(test, x, t4, { hsrAccountIds: [acct] });
            expect(waitlistRows(test, t4, x.userId)).toEqual([acct]);

            expect([...test.db.TournamentAssistant.user_id.filter(s.userId)]).toHaveLength(1);
            expect([...test.db.TournamentStandIn.user_id.filter(s.userId)]).toHaveLength(1);
            expect([...test.db.TournamentPlayerAccount.by_user.filter(x.userId)].length).toBeGreaterThan(0);

            deleteUser(test, path, x, boss);
            if (s !== x) deleteUser(test, path, s, boss);
            expect(requestsOf(test, x.userId)).toEqual([]);
            expect([...test.db.TournamentAssistant.user_id.filter(s.userId)]).toEqual([]);
            expect([...test.db.TournamentStandIn.user_id.filter(s.userId)]).toEqual([]);
            expect([...test.db.TournamentPlayerAccount.by_user.filter(x.userId)]).toEqual([]);
            expect([...test.db.TournamentWaitlistAccount.by_user.filter(x.userId)]).toEqual([]);
            expect(enrolled(test, t1, x.userId)).toBeUndefined();
            expect(enrolled(test, t4, x.userId)).toBeUndefined();
        });
    }
});

// ════════════════════════════════════════════════════════════════════════════
// S10g review fix pass: F1, F3, F4, F5
// ════════════════════════════════════════════════════════════════════════════

describe('A94(2) review F1: a verified user\'s own deletion settles a live enrolment', () => {
    it('A94(2) / F1: a verified solo player deletes their own account in Registration: withdrawn (enrolment, solo team, membership, locks gone)', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { teamSize: 1, maxParticipants: 4 });
        const p = verified(test, 'gone');
        const acct = insertHsrAccount(test, p.userId, 'gone-main');
        register(test, p, id);
        const teamId = membership(test, id, p.userId)!.teamId;
        expect(locks(test, id, p.userId)).toEqual([acct]);

        tx(test, p, (ctx) => M.delete_my_account(ctx, {}));
        expect(test.db.UserIdentity.identity.find(p.identity)).toBeFalsy();
        expect(enrolled(test, id, p.userId)).toBeUndefined();
        expect(membership(test, id, p.userId)).toBeUndefined();
        expect(teamRow(test, teamId)).toBeFalsy();
        expect(locks(test, id, p.userId)).toEqual([]);
    });

    it('A94(2) / F1: a verified solo player deletes their own account in InProgress (no lobby): Disqualified, the Ready match settled for the opponent (Dq)', () => {
        const test = newHarness();
        const org = host(test);
        const p = verified(test, 'gone');
        const q = verified(test, 'opp');
        const id = soloLive(test, org, [p, q], p).id;
        const m = bracketRows(test, id)[0];
        expect(m.state.tag).toBe('Ready');
        const pTeam = membership(test, id, p.userId)!.teamId;
        const qTeam = membership(test, id, q.userId)!.teamId;

        tx(test, p, (ctx) => M.delete_my_account(ctx, {}));
        expect(test.db.UserIdentity.identity.find(p.identity)).toBeFalsy();
        expect(enrolled(test, id, p.userId).status.tag).toBe('Disqualified');
        expect(membership(test, id, p.userId)).toBeUndefined();
        expect(teamRow(test, pTeam)!.status.tag).toBe('Disqualified');
        const after = matchRow(test, m.id);
        expect(after.state.tag).toBe('Decided');
        expect(after.decidedBy?.tag).toBe('Dq');
        expect(after.winnerTeamId).toBe(qTeam);
    });

    it('A94(2) / F1: the lobby guard of the verified branch stays: a verified player seated in a live tournament lobby is refused; nothing changes', () => {
        const f = duel();
        const m = byKey(f.test, f.id, 'W-R1-M1');
        const s = openMatchLobby(f, m.id);
        expect(lobbyRow(f.test, s.lobbyId).stage.tag).toBe('Drafting');
        const b2 = s.a.b2;
        expect(rejection(f.test, b2, (ctx) => M.delete_my_account(ctx, {}))).toBe(LEAVE_LOBBY_DELETE);
        expect(enrolled(f.test, f.id, b2.userId).status.tag).not.toBe('Disqualified');
        expect(f.test.db.UserIdentity.identity.find(b2.identity)).toBeTruthy();
    });
});

const assistantsOf = (test: Harness, tournamentId: number) =>
    [...test.db.TournamentAssistant.tournament_id.filter(tournamentId)].map((a) => a.userId).sort((a, b) => a - b);

/** admin_delete_row('User') by `by` ('internal' = the SYSTEM user) and the scheduled run_user_deletion fired by hand. */
function adminDeleteUser(test: Harness, by: Actor | 'internal', who: Actor) {
    tx(test, by, (ctx) => M.admin_delete_row(ctx, { tableName: 'User', primaryKeyJson: String(who.userId) }));
    fireDeletionJob(test, who.userId);
}

/** admin_ban_user on the user's Discord id by `by` (an Admin, or 'internal' = the SYSTEM user) and the deletion job. */
function ban(test: Harness, by: Actor | 'internal', who: Actor) {
    const providerId = providerOf(test, who)!;
    tx(test, by, (ctx) => M.admin_ban_user(ctx, { banTypeTag: 'DiscordId', providerId, reason: 'test' }));
    fireDeletionJob(test, who.userId);
}

// ════════════════════════════════════════════════════════════════════════════
// L70 / A121: a new organizer when staff delete or ban the organizer
// ════════════════════════════════════════════════════════════════════════════

describe('A121, L70: a tournament whose organizer is deleted or banned by staff gets a new organizer', () => {
    it('A121 L70: an admin deletion hands the tournament to the longest-serving assistant holding all three permissions; that row is removed', () => {
        const test = newHarness();
        const org = host(test);
        const boss = admin(test);
        const id = openTournament(test, org);
        const partial = verified(test, 'partial');
        const first = verified(test, 'first');
        const second = verified(test, 'second');
        assignAssistant(test, org, id, partial, { participants: true, bracket: true }); // oldest, but not all three
        advance(test, 1_000);
        assignAssistant(test, org, id, first, { participants: true, bracket: true, results: true });
        advance(test, 1_000);
        assignAssistant(test, org, id, second, { participants: true, bracket: true, results: true });
        const done = openTournament(test, org, { name: 'Done cup' });
        tx(test, org, (ctx) => M.cancel_tournament(ctx, { tournamentId: done }));

        adminDeleteUser(test, boss, org);
        expect(tRow(test, id).organizerId).toBe(first.userId);
        expect(assistantsOf(test, id)).toEqual([partial.userId, second.userId].sort((a, b) => a - b));
        expect(tRow(test, done).organizerId).toBe(org.userId); // a Cancelled tournament keeps its row as it was
    });

    it('A121 L70: a ban with no full assistant makes the acting Admin the organizer; the linked calendar event moves to them', () => {
        const f = duel();
        const { test, org } = f;
        const boss = admin(test);
        const partial = verified(test, 'partial');
        assignAssistant(test, org, f.id, partial, { results: true });
        const m = byKey(test, f.id, 'W-R1-M1');
        const eventId = createEvent(test, org, { bracketMatchId: m.id });

        ban(test, boss, org);
        expect(tRow(test, f.id).organizerId).toBe(boss.userId);
        expect(test.db.CalendarEvent.id.find(eventId)?.organizerId).toBe(boss.userId);
        expect(assistantsOf(test, f.id)).toEqual([partial.userId]);
        expect(test.db.User.id.find(org.userId)).toBeFalsy();
        // the new organizer holds the owner permission: in InProgress the stage refuses the settings change, not the permission
        expect(rejection(test, boss, updateBody(test, f.id, {}))).toBe('Tournament settings can only change before Seeding.');
    });

    // S10s fix pass (F13): the heir filters and an heir who also plays.
    it('A121 L70 (F13): a guest assistant, an assistant pending deletion and a partial one are skipped; equal dates go to the lower user id; an heir enrolled as a player keeps the enrolment', () => {
        const test = newHarness();
        const org = host(test);
        const boss = admin(test);
        const id = openTournament(test, org);
        const ghost = guest(test, 'ghost');            // a guest assistant row (A113(6) refuses it today; a legacy row)
        const pending = verified(test, 'pending');     // full permissions, pending deletion
        const partial = verified(test, 'partial');
        const low = verified(test, 'low');             // created before `high`: the lower user id
        const high = verified(test, 'high');
        expect(low.userId).toBeLessThan(high.userId);
        const fullRow = (userId: number) => ({
            id: 0, tournamentId: id, userId, canManageParticipants: true, canManageBracket: true, canResolveResults: true, ...AUDIT(test),
        });
        test.db.TournamentAssistant.insert(fullRow(ghost.userId));
        advance(test, 1_000);
        assignAssistant(test, org, id, pending, { participants: true, bracket: true, results: true });
        test.db.User.id.update({ ...test.db.User.id.find(pending.userId)!, deletedAt: test.clock.now() });
        advance(test, 1_000);
        assignAssistant(test, org, id, partial, { participants: true, results: true });
        advance(test, 1_000);
        assignAssistant(test, org, id, high, { participants: true, bracket: true, results: true }); // same instant
        assignAssistant(test, org, id, low, { participants: true, bracket: true, results: true });
        register(test, low, id); // the heir also plays

        adminDeleteUser(test, boss, org);
        expect(tRow(test, id).organizerId).toBe(low.userId);
        expect(assistantsOf(test, id)).not.toContain(low.userId);
        expect(enrolled(test, id, low.userId)).toBeDefined();
        expect(assistantsOf(test, id)).toEqual([ghost.userId, pending.userId, partial.userId, high.userId].sort((a, b) => a - b));
    });
});

// ════════════════════════════════════════════════════════════════════════════
// A124: a server deletion of an organizer cancels the tournament
// ════════════════════════════════════════════════════════════════════════════

describe('A124: a server deletion or ban of an organizer cancels the unfinished tournaments', () => {
    it('A124: server_delete_user cancels a tournament in Registration through the cancel path; no assistant takes over; a Completed one is untouched', () => {
        const f = duel();
        const { test, org } = f;
        playMatch(f, byKey(test, f.id, 'W-R1-M1').id, 'Blue');
        advanceStage(test, org, f.id, 'Completed');
        const reg = openTournament(test, org, { name: 'Open cup' });
        const helper = verified(test, 'helper');
        assignAssistant(test, org, reg, helper, { participants: true, bracket: true, results: true });
        const [p] = enrollMany(test, reg, 1, 'reg');

        const username = test.db.User.id.find(org.userId)!.username;
        tx(test, 'internal', (ctx) => M.server_delete_user(ctx, { username }));
        expect(tRow(test, reg).stage.tag).toBe('Cancelled');
        expect(tRow(test, reg).organizerId).toBe(org.userId); // no hand-over on this path
        expect(assistantsOf(test, reg)).toEqual([helper.userId]); // the cancel keeps the staff rows (display)
        expect(enrolled(test, reg, p.userId)).toBeDefined();      // and the enrolments (audit trail)
        expect([...test.db.TournamentFinalizeJob.tournament_id.filter(reg)]).toHaveLength(1); // the A24(5) job started
        expect(tRow(test, f.id).stage.tag).toBe('Completed');
    });

    it('A124: a ban sent as the SYSTEM user (Owner or Delegate) cancels a live tournament: its open lobby is voided and its match event deleted', () => {
        const f = duel();
        const { test, org } = f;
        const m = byKey(test, f.id, 'W-R1-M1');
        const eventId = createEvent(test, org, { bracketMatchId: m.id });
        const lobbyId = createTournamentLobby(test, org, m.id);
        expect(test.db.Lobby.id.find(lobbyId)).toBeTruthy();

        ban(test, 'internal', org);
        expect(tRow(test, f.id).stage.tag).toBe('Cancelled');
        expect(test.db.Lobby.id.find(lobbyId)).toBeFalsy();
        expect(test.db.CalendarEvent.id.find(eventId)).toBeFalsy();
        expect(test.db.User.id.find(org.userId)).toBeFalsy();
    });

    it('A124 (neighbour): an Admin\'s ban still hands the tournament over (A121), it is not cancelled', () => {
        const test = newHarness();
        const org = host(test);
        const boss = admin(test);
        const id = openTournament(test, org);
        ban(test, boss, org);
        expect(tRow(test, id).stage.tag).toBe('Registration');
        expect(tRow(test, id).organizerId).toBe(boss.userId);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Gap 8. A124 (S10s re-review N5)
// ════════════════════════════════════════════════════════════════════════════

describe('Gap 8, A124: server deletions cancel; identity GC and the sign-in re-point (confirm_link) do not (S10s re-review N5)', () => {
    it('A124 (N5: a Draft tournament): server_delete_user of its organizer cancels a tournament still in Draft; no assistant takes over', () => {
        const test = newHarness();
        const org = host(test);
        const id = createTournament(test, org);
        const helper = verified(test, 'helper');
        assignAssistant(test, org, id, helper, { participants: true, bracket: true, results: true });
        expect(tRow(test, id).stage.tag).toBe('Draft');
        const username = test.db.User.id.find(org.userId)!.username;

        tx(test, 'internal', (ctx) => M.server_delete_user(ctx, { username }));

        expect(tRow(test, id).stage.tag).toBe('Cancelled');
        expect(tRow(test, id).organizerId).toBe(org.userId);
        expect(test.db.User.id.find(org.userId)).toBeFalsy();
    });

    it('A124 (N5: admin_delete_row as SYSTEM): admin_delete_row(\'User\') sent by the Owner identity (the SYSTEM user) cancels the organizer\'s tournament in Registration; the full assistant does not take over', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org);
        const helper = verified(test, 'helper');
        assignAssistant(test, org, id, helper, { participants: true, bracket: true, results: true });

        adminDeleteUser(test, 'internal', org);

        expect(tRow(test, id).stage.tag).toBe('Cancelled');
        expect(tRow(test, id).organizerId).toBe(org.userId);
        expect([...test.db.TournamentAssistant.tournament_id.filter(id)].map((a) => a.userId)).toEqual([helper.userId]);
        expect(test.db.User.id.find(org.userId)).toBeFalsy();
    });

    /** A tournament in Registration whose organizerId is a guest (engineered: a guest cannot be a Tournament Host). */
    function guestOrganized(test: Harness, sub: string) {
        const org = host(test, `${sub}-creator`);
        const id = openTournament(test, org, { name: `${sub} cup` } as any);
        const g = guest(test, sub);
        test.db.Tournament.id.update({ ...tRow(test, id), organizerId: g.userId });
        return { id, g };
    }

    it('pins current behaviour (row silent): A124 (N5: identity GC): the scheduled identity clean-up deletes an idle guest organizer; the tournament is not cancelled and keeps its organizer id', () => {
        const test = newHarness();
        const { id, g } = guestOrganized(test, 'gc-org');
        disconnect(test, g); // the guest closed the tab (presence offline), as s10h's idle guests
        advance(test, 31 * DAY_MS);
        tx(test, 'internal', (ctx) => M.run_identity_gc(ctx, { arg: { scheduledId: 1n, scheduledAt: ScheduleAt.time(now(test)) } as any }));

        expect(test.db.User.id.find(g.userId)).toBeFalsy();
        expect(tRow(test, id).stage.tag).toBe('Registration');
        expect(tRow(test, id).organizerId).toBe(g.userId);
    });

    it('pins current behaviour (row silent): A124 (N5: the sign-in, confirm_link): a guest organizer signing in to an existing account is deleted; the tournament is not cancelled and keeps the guest\'s organizer id', () => {
        const test = newHarness();
        const { id, g } = guestOrganized(test, 'link-org');
        const e = existingUser(test, 'e-link-org');

        const guestId = signIn(test, g, e.providerId);

        expect(test.db.User.id.find(guestId)).toBeFalsy();
        expect(tRow(test, id).stage.tag).toBe('Registration');
        expect(tRow(test, id).organizerId).toBe(guestId);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Gap 10. A121 with A94(1)
// ════════════════════════════════════════════════════════════════════════════

describe('Gap 10, A121: the new organizer is bound by A94(1) (S10s review, "side effects to know")', () => {
    it('A121, A94(1): the assistant who took over cannot delete their own account while the tournament is unfinished; once they cancel it, the deletion goes through', () => {
        const test = newHarness();
        const org = host(test);
        const boss = admin(test);
        const id = openTournament(test, org);
        const heir = verified(test, 'heir');
        assignAssistant(test, org, id, heir, { participants: true, bracket: true, results: true });
        adminDeleteUser(test, boss, org);
        expect(tRow(test, id).organizerId).toBe(heir.userId);

        expectReject(test, heir, (ctx) => M.delete_my_account(ctx, {}), ORGANIZER_DELETE);
        expect(test.db.User.id.find(heir.userId)).toBeTruthy();

        tx(test, heir, (ctx) => M.cancel_tournament(ctx, { tournamentId: id }));
        tx(test, heir, (ctx) => M.delete_my_account(ctx, {}));
        expect(test.db.User.id.find(heir.userId)).toBeFalsy();
    });
});
