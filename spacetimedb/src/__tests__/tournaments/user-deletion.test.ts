// Tournaments: an organizer cannot delete their account; deletion settles the user's tournament ties.
// Decisions: A94
// Contracts: docs/tournament/contract.md, docs/brackets/contract.md
// From S10g (s10g-tournament.test.ts).
import { describe, expect, it } from 'vitest';
import { M, guest, lobbyRow, newHarness, tx, type Actor, type Harness } from '../fixtures/harness';
import {
    advanceStage,
    assignAssistant,
    bracketRows,
    createTournament,
    enrollMany,
    enrolled,
    fullTeams,
    host,
    insertHsrAccount,
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
    setUserRole,
    stageOf,
    tRow,
    teamRow,
    teams,
    verified,
} from '../fixtures/tournament-builders';
import { byKey, duel, openMatchLobby } from '../fixtures/tournament-match-builders';
import { rejection } from '../fixtures/calendar-roster-rating-builders';
import { fireDeletionJob } from '../fixtures/achievement-auth-cost-builders';
import { admin, waitlistRows } from '../fixtures/tournament-staff-helpers';

// ─── Texts ───────────────────────────────────────────────────────────────────

const ORGANIZER_DELETE = 'You organize a tournament that has not finished. Cancel it, or wait until it ends, before deleting your account.';
const LEAVE_LOBBY_DELETE = 'Leave your lobby before deleting your account.';

type DeletePath = 'self' | 'admin';

/** Deletes `who`: delete_my_account as the user, or admin_delete_row('User') + the scheduled run_user_deletion. */
function deleteUser(test: Harness, path: DeletePath, who: Actor, boss: Actor) {
    if (path === 'self') {
        tx(test, who, (ctx) => M.delete_my_account(ctx, {}));
    } else {
        tx(test, boss, (ctx) => M.admin_delete_row(ctx, { tableName: 'User', primaryKeyJson: String(who.userId) }));
        fireDeletionJob(test, who.userId);
    }
}

/**
 * The deleted player for a path: a guest for delete_my_account, a verified user for the admin path. Since the S10g
 * review F1 fix a verified user's own deletion settles the enrolment too (covered in the 'A94(2) review F1' block).
 */
const playerFor = (test: Harness, path: DeletePath, name: string): Actor => (path === 'self' ? guest(test, name) : verified(test, name));

/** A solo tournament (teamSize 1) with the given players, Seeding → generated → InProgress. */
function soloLive(test: Harness, org: Actor, players: Actor[]): number {
    const id = openTournament(test, org, { teamSize: 1, maxParticipants: 4 });
    for (const p of players) register(test, p, id);
    advanceStage(test, org, id, 'Seeding');
    seedAndGenerate(test, org, id);
    advanceStage(test, org, id, 'InProgress');
    return id;
}

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
            const boss = admin(test);
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
            const boss = admin(test);
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
            const boss = admin(test);
            const p = playerFor(test, path, 'gone');
            const q = verified(test, 'opp');
            const id = soloLive(test, org, [p, q]);
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
            const boss = admin(test);
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
        const id = soloLive(test, org, [p, q]);
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
