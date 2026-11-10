// T-S10g: in-memory tests for step S10g (DECISIONS.md A94, A103, A104, A105; tournament audit 2026-11-09 findings 2, 3,
// 4, 5, 6, 8, 10, 11, 13, LOW 15, 16). User deletion and tournaments, the Draft-only anonymous flag, late account locks,
// the staff and Admin views, DQ lobby voiding and stage bounds, rollback / override after a staff or DQ decision, the
// group lock, the minimum MMR on the active season, registrant accounts and matches-for-me narrowing, the tournament
// entry throttle, the DQ'd ex-captain and the solo team name on a display-name change. Builders from the s4 / s8 / s8d /
// s10 fixtures; roles, HSR accounts and rating rows are written through `test.db` outside any transaction; scheduled
// reducers are fired by hand. Nothing reaches maincloud. S10g review fix pass: F1 (verified self-deletion settles the
// enrolment), F3 (the player's own first game), F4 (acting captain everywhere), F5 (waitlisted late locks).
import { describe, expect, it } from 'vitest';
import { TOURNAMENT_PERM_MESSAGES } from '@module/helpers/tournament/tournamentPermissions';
import { M, advance, guest, lobbyRow, newHarness, tx, type Actor, type Harness } from './s4-fixtures';
import {
    AUDIT,
    advanceStage,
    assignAssistant,
    bracketRows,
    createTournament,
    enrolled,
    enrollMany,
    fullTeams,
    host,
    insertHsrAccount,
    liveField,
    locks,
    makeTeam,
    matchRow,
    membersOf,
    membership,
    moderator,
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
    updateBody,
    verified,
} from './s8-fixtures';
import {
    byKey,
    createTournamentLobby,
    duel,
    join,
    lobbiesOf,
    openMatchLobby,
    playBracketMatch,
    playMatch,
    recordsOfLobby,
    recordsOfMatch,
    seedElo,
    sidesOf,
} from './s8d-fixtures';
import { rejection } from './s10-c2-fixtures';
import { fireDeletionJob } from './s10-c1-fixtures';

// ─── Texts ───────────────────────────────────────────────────────────────────

const ORGANIZER_DELETE = 'You organize a tournament that has not finished. Cancel it, or wait until it ends, before deleting your account.';
const ANON_DRAFT_ONLY = 'The anonymous setting can only change in Draft.';
const SETTINGS_BEFORE_SEEDING = 'Tournament settings can only change before Seeding.';
const LOCK_STAGE = 'Accounts can be locked from Registration until the tournament ends.';
const LOCK_EMPTY = 'Name at least one account to lock.';
const LOCK_NOT_REGISTERED = 'You are not registered for this tournament.';
const LOCK_DQ = 'You were disqualified from this tournament.';
const LOCK_STARTED = 'Your first game of this tournament has started; accounts can no longer be locked.';
const notYours = (id: number) => `HSR account #${id} is not one of your accounts.`;
const NOT_LOCKED = 'This account is not locked for this tournament. Use a registered tournament account.';
const DECIDED_BY_STAFF = 'This match was decided by staff or a disqualification; roll the match back first (rollback_bracket_match).';
const GROUP_LOCKED = 'Group results are locked: the elimination bracket already exists.';
const dqStage = (stage: string) => `Tournament is ${stage}; participants can be disqualified from Registration through InProgress only.`;
const THROTTLE = 'You are changing your tournament entries too quickly. Please wait a minute.';
const NOT_CAPTAIN_DISBAND = 'Only the team captain can disband the team.';
const NOT_CAPTAIN_RENAME = 'Only the team captain can rename the team.';
const NOT_CAPTAIN_ACCEPT = 'Only the team captain can accept join requests.';
const NOT_CAPTAIN_REJECT = 'Only the team captain can reject join requests.';
const NOT_CAPTAIN_WITHDRAW = 'Only the team captain can withdraw the team.';
const LEAVE_LOBBY_DELETE = 'Leave your lobby before deleting your account.';
const LOCK_WAITLIST_CLOSED = 'The bracket has been generated; waitlisted players can no longer be promoted, so accounts cannot be locked.';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function admin(test: Harness, name = 'admin'): Actor {
    const a = verified(test, name);
    setUserRole(test, a.userId, 'Admin');
    return a;
}

/** A per-sender view called as `who` (arg views take `args`). */
const viewAs = <T = any>(test: Harness, name: string, who: Actor, args: Record<string, unknown> = {}): T[] =>
    (M as any)[name](test.viewContext(who.auth), args) as T[];

const dq = (tournamentId: number, userId: number, dqWholeTeam = false) =>
    (ctx: any) => M.dq_participant(ctx, { tournamentId, userId, reason: 'test', dqWholeTeam });
const lockBody = (tournamentId: number, hsrAccountIds: number[]) =>
    (ctx: any) => M.lock_tournament_accounts(ctx, { tournamentId, hsrAccountIds });
const rollbackBody = (bracketMatchId: number) => (ctx: any) => M.rollback_bracket_match(ctx, { bracketMatchId, reason: 'replay' });
const resolveBody = (bracketMatchId: number, winnerTeamId: number) =>
    (ctx: any) => M.resolve_bracket_match(ctx, { bracketMatchId, winnerTeamId, reason: 'staff' });
const overrideBody = (matchResultId: number, newStatusTag: string, winnerTeamSideTag = '') =>
    (ctx: any) => M.override_match_result(ctx, { matchResultId, newStatusTag, winnerTeamSideTag, reason: 'staff' });

const waitlistRows = (test: Harness, tournamentId: number, userId: number) =>
    [...test.db.TournamentWaitlistAccount.by_tournament_and_user.filter([tournamentId, userId])].map((r) => r.hsrAccountId).sort((a, b) => a - b);

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
            const t4 = openTournament(test, org, { name: 'Full', maxParticipants: 1, waitlistEnabled: true });
            enrollMany(test, t4, 1, 'f');
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
// A103: isAnonymousDefault is fixed after Draft
// ════════════════════════════════════════════════════════════════════════════

describe('A103: update_tournament changes isAnonymousDefault in Draft only', () => {
    it('A103: accepted in Draft; rejected in Registration and CheckIn with the text; rejected in Seeding (settings closed); the flag is unchanged', () => {
        const test = newHarness();
        const org = host(test);
        const id = createTournament(test, org, { checkInEnabled: true });
        tx(test, org, updateBody(test, id, { isAnonymousDefault: true }));
        expect(tRow(test, id).isAnonymousDefault).toBe(true);
        tx(test, org, updateBody(test, id, { isAnonymousDefault: false }));
        expect(tRow(test, id).isAnonymousDefault).toBe(false);

        advanceStage(test, org, id, 'Registration');
        expect(rejection(test, org, updateBody(test, id, { isAnonymousDefault: true }))).toBe(ANON_DRAFT_ONLY);
        fullTeams(test, id, 2);
        advanceStage(test, org, id, 'CheckIn');
        expect(stageOf(test, id)).toBe('CheckIn');
        expect(rejection(test, org, updateBody(test, id, { isAnonymousDefault: true }))).toBe(ANON_DRAFT_ONLY);
        for (const t of teams(test, id)) tx(test, org, (ctx) => M.check_in_tournament(ctx, { tournamentId: id, teamId: t.id }));
        advanceStage(test, org, id, 'Seeding');
        expect(rejection(test, org, updateBody(test, id, { isAnonymousDefault: true }))).toBe(SETTINGS_BEFORE_SEEDING);
        expect(tRow(test, id).isAnonymousDefault).toBe(false);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// A104: lock_tournament_accounts
// ════════════════════════════════════════════════════════════════════════════

describe('A104: lock_tournament_accounts', () => {
    it('A104 (audit #7): an approved player locks an account added after registration, selects it in the match lobby and the draft starts; afterwards the call is rejected', () => {
        const f = duel({ countTowardsMmr: true });
        const { test, org } = f;
        seedElo(test);
        const m = byKey(test, f.id, 'W-R1-M1');
        const players = [f.ts[0].captain, f.ts[0].mate, f.ts[1].captain, f.ts[1].mate];
        for (const p of players) expect(locks(test, f.id, p.userId)).toEqual([]); // registered before owning an account
        const accts = new Map(players.map((p) => [p.userId, insertHsrAccount(test, p.userId, `late-${p.userId}`)]));

        const lobbyId = createTournamentLobby(test, org, m.id);
        expect(lobbyRow(test, lobbyId).matchType.tag).toBe('Ranked');
        for (const p of players) {
            join(test, p, lobbyId);
            tx(test, p, (ctx) => M.confirm_ready(ctx, { lobbyId }));
        }
        const b1 = players[0];
        const b1Acct = accts.get(b1.userId)!;
        expect(rejection(test, b1, (ctx) => M.select_match_account(ctx, { lobbyId, hsrAccountId: b1Acct }))).toBe(NOT_LOCKED);

        for (const p of players) {
            const acct = accts.get(p.userId)!;
            tx(test, p, lockBody(f.id, [acct]));
            expect(locks(test, f.id, p.userId)).toEqual([acct]);
            tx(test, p, (ctx) => M.select_match_account(ctx, { lobbyId, hsrAccountId: acct }));
        }
        tx(test, org, (ctx) => M.start_draft(ctx, { lobbyId }));
        expect(lobbyRow(test, lobbyId).stage.tag).toBe('Drafting');

        // b1 and the teammate both sit in the started game: no more locks for either (review F3: the player's own game)
        const extra = insertHsrAccount(test, b1.userId, 'too-late');
        expect(rejection(test, b1, lockBody(f.id, [extra]))).toBe(LOCK_STARTED);
        expect(rejection(test, players[1], lockBody(f.id, [accts.get(players[1].userId)!]))).toBe(LOCK_STARTED);
        expect(locks(test, f.id, b1.userId)).toEqual([b1Acct]);
    });

    it('A104: locks are only added: naming fewer accounts keeps the old ones', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org);
        const p = verified(test, 'p');
        const a1 = insertHsrAccount(test, p.userId, 'a1');
        register(test, p, id, { hsrAccountIds: [a1] });
        const a2 = insertHsrAccount(test, p.userId, 'a2');
        const a3 = insertHsrAccount(test, p.userId, 'a3');
        tx(test, p, lockBody(id, [a2, a3]));
        expect(locks(test, id, p.userId)).toEqual([a1, a2, a3].sort((x, y) => x - y));
        tx(test, p, lockBody(id, [a1]));
        expect(locks(test, id, p.userId)).toEqual([a1, a2, a3].sort((x, y) => x - y));
    });

    it('A104: someone else\'s account, an empty list, a non-registrant and a disqualified player are rejected with their texts; nothing is locked', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org);
        const p = verified(test, 'p');
        const other = verified(test, 'other');
        register(test, p, id);
        const foreign = insertHsrAccount(test, other.userId, 'foreign');
        const own = insertHsrAccount(test, p.userId, 'own');

        expect(rejection(test, p, lockBody(id, [own, foreign]))).toBe(notYours(foreign));
        expect(rejection(test, p, lockBody(id, []))).toBe(LOCK_EMPTY);
        expect(rejection(test, other, lockBody(id, [foreign]))).toBe(LOCK_NOT_REGISTERED);
        expect(locks(test, id, p.userId)).toEqual([]);

        const d = verified(test, 'd');
        register(test, d, id);
        const dAcct = insertHsrAccount(test, d.userId, 'd-acct');
        tx(test, org, dq(id, d.userId));
        expect(rejection(test, d, lockBody(id, [dAcct]))).toBe(LOCK_DQ);
        expect(locks(test, id, d.userId)).toEqual([]);
    });

    it('A104: a waitlisted player\'s call is remembered and every remembered account is locked at promotion', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { maxParticipants: 1, waitlistEnabled: true });
        const [first] = enrollMany(test, id, 1);
        const w = verified(test, 'w');
        const a1 = insertHsrAccount(test, w.userId, 'w1');
        register(test, w, id, { hsrAccountIds: [a1] });
        expect(enrolled(test, id, w.userId).isWaitlisted).toBe(true);
        const a2 = insertHsrAccount(test, w.userId, 'w2');
        insertHsrAccount(test, w.userId, 'w3'); // owned, never named
        tx(test, w, lockBody(id, [a2]));
        expect(locks(test, id, w.userId)).toEqual([]); // nothing locked while waitlisted
        expect(waitlistRows(test, id, w.userId)).toEqual([a1, a2].sort((x, y) => x - y));

        tx(test, first, (ctx) => M.withdraw_from_tournament(ctx, { tournamentId: id }));
        tx(test, org, (ctx) => M.waitlist_promote(ctx, { tournamentId: id, userId: w.userId }));
        expect(locks(test, id, w.userId)).toEqual([a1, a2].sort((x, y) => x - y));
        expect(waitlistRows(test, id, w.userId)).toEqual([]);
    });

    it('A104: stage bounds: rejected in Draft and in Completed with the text', () => {
        const test = newHarness();
        const org = host(test);
        const draft = createTournament(test, org);
        const p = verified(test, 'p');
        const acct = insertHsrAccount(test, p.userId, 'p-acct');
        expect(rejection(test, p, lockBody(draft, [acct]))).toBe(LOCK_STAGE);

        const f = duel();
        const cap = f.ts[0].captain;
        const capAcct = insertHsrAccount(f.test, cap.userId, 'cap-acct');
        resolveMatch(f.test, f.org, byKey(f.test, f.id, 'W-R1-M1').id, f.ts[0].teamId);
        advanceStage(f.test, f.org, f.id, 'Completed');
        expect(rejection(f.test, cap, lockBody(f.id, [capAcct]))).toBe(LOCK_STAGE);
        expect(locks(f.test, f.id, cap.userId)).toEqual([]);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// A105: staff views and Admin views
// ════════════════════════════════════════════════════════════════════════════

const STAFF_VIEWS = [
    'view_my_tournaments',
    'view_my_tournament_enrolled',
    'view_my_tournament_teams',
    'view_my_tournament_team_members',
    'view_my_tournament_matches',
    'view_my_tournament_match_results',
    'view_my_tournament_lobbies',
];
const ADMIN_VIEWS = [
    'view_admin_tournament',
    'view_admin_tournament_enrolled',
    'view_admin_tournament_teams',
    'view_admin_tournament_team_members',
    'view_admin_tournament_matches',
    'view_admin_tournament_match_results',
    'view_admin_tournament_lobbies',
];

describe('A105: the tournament staff views and the Admin arg views', () => {
    it('A105(1): a running tournament: the organizer, an assistant (no flags), a non-staff Moderator and a non-staff Admin read every staff view; a plain user reads nothing', () => {
        const f = duel();
        const { test, org } = f;
        const assistant = verified(test, 'assist');
        assignAssistant(test, org, f.id, assistant, {});
        openMatchLobby(f, byKey(test, f.id, 'W-R1-M1').id); // Drafting: a lobby and its Pending record
        const mod = moderator(test, 'mod');
        const boss = admin(test);
        const plain = verified(test, 'plain');
        for (const name of STAFF_VIEWS) {
            const rows = viewAs(test, name, org);
            expect(rows.length, `${name}: organizer`).toBeGreaterThan(0);
            expect(viewAs(test, name, assistant), `${name}: assistant`).toEqual(rows);
            expect(viewAs(test, name, mod), `${name}: Moderator`).toEqual(rows);
            expect(viewAs(test, name, boss), `${name}: Admin`).toEqual(rows);
            expect(viewAs(test, name, plain), `${name}: plain user`).toEqual([]);
        }
    });

    it('A105(1)(2): Completed and Cancelled tournaments leave the staff views; the Admin arg views return them by id; anyone else, or an unknown id, gets nothing', () => {
        const f = duel();
        const { test, org } = f;
        const assistant = verified(test, 'assist');
        assignAssistant(test, org, f.id, assistant, {});
        playMatch(f, byKey(test, f.id, 'W-R1-M1').id, 'Blue'); // decides the Bo1; the lobby parks with its record
        advanceStage(test, org, f.id, 'Completed');
        const cancelled = openTournament(test, org, { name: 'Cancelled cup' });
        enrollMany(test, cancelled, 2, 'cx');
        tx(test, org, (ctx) => M.cancel_tournament(ctx, { tournamentId: cancelled }));
        expect(stageOf(test, cancelled)).toBe('Cancelled');
        const mod = moderator(test, 'mod');
        const boss = admin(test);
        const plain = verified(test, 'plain');

        for (const name of STAFF_VIEWS) {
            for (const [who, label] of [[org, 'organizer'], [assistant, 'assistant'], [mod, 'Moderator'], [boss, 'Admin']] as const) {
                expect(viewAs(test, name, who), `${name}: ${label}`).toEqual([]);
            }
        }
        for (const name of ADMIN_VIEWS) {
            expect(viewAs(test, name, boss, { tournamentId: f.id }).length, `${name}: Admin, Completed`).toBeGreaterThan(0);
            for (const [who, label] of [[mod, 'Moderator'], [org, 'organizer'], [plain, 'plain user']] as const) {
                expect(viewAs(test, name, who, { tournamentId: f.id }), `${name}: ${label}`).toEqual([]);
            }
            expect(viewAs(test, name, boss, { tournamentId: 99_999 }), `${name}: unknown id`).toEqual([]);
        }
        expect(viewAs(test, 'view_admin_tournament', boss, { tournamentId: cancelled }).map((t) => t.id)).toEqual([cancelled]);
        expect(viewAs(test, 'view_admin_tournament', boss, { tournamentId: f.id }).map((t) => t.stage.tag)).toEqual(['Completed']);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Audit #2 and #8: dq_participant lobby voiding and stage bounds
// ════════════════════════════════════════════════════════════════════════════

describe('tournament audit #2: a DQ voids the unsettled lobbies of the matches it settles', () => {
    it('audit #2: a Waiting lobby of the DQ\'d team\'s Ready match is removed; advance_tournament_stage(Completed) is not blocked', () => {
        const f = duel();
        const m = byKey(f.test, f.id, 'W-R1-M1');
        const s = openMatchLobby(f, m.id, { noStart: true });
        expect(lobbyRow(f.test, s.lobbyId).stage.tag).toBe('Waiting');
        tx(f.test, f.org, dq(f.id, f.ts[1].captain.userId, true));
        const after = matchRow(f.test, m.id);
        expect(after.state.tag).toBe('Decided');
        expect(after.decidedBy?.tag).toBe('Dq');
        expect(after.winnerTeamId).toBe(f.ts[0].teamId);
        expect(f.test.db.Lobby.id.find(s.lobbyId)).toBeFalsy();
        expect(lobbiesOf(f.test, m.id)).toEqual([]);
        advanceStage(f.test, f.org, f.id, 'Completed');
        expect(stageOf(f.test, f.id)).toBe('Completed');
    });

    it('audit #2 (A68(6)): a lobby parked with a Submitted record is voided (record Voided, lobby gone)', () => {
        const f = liveField(2, { defaultBestOf: 3, grandFinalBestOf: 3, requireResultValidation: true });
        const m = byKey(f.test, f.id, 'W-R1-M1');
        const [parked] = playBracketMatch(f, m.id, ['Blue']);
        const [rec] = recordsOfLobby(f.test, parked.lobbyId);
        expect(rec.status.tag).toBe('Submitted');
        tx(f.test, f.org, dq(f.id, f.ts[1].captain.userId, true));
        expect(matchRow(f.test, m.id).decidedBy?.tag).toBe('Dq');
        expect(f.test.db.MatchResultRecord.id.find(rec.id)!.status.tag).toBe('Voided');
        expect(f.test.db.Lobby.id.find(parked.lobbyId)).toBeFalsy();
        advanceStage(f.test, f.org, f.id, 'Completed');
        expect(stageOf(f.test, f.id)).toBe('Completed');
    });

    it('audit #2 (D-25): the DQ\'d team\'s live lobby is still force-conceded (Validated concede record, lobby parked)', () => {
        const f = duel();
        const m = byKey(f.test, f.id, 'W-R1-M1');
        const live = openMatchLobby(f, m.id);
        expect(lobbyRow(f.test, live.lobbyId).stage.tag).toBe('Drafting');
        tx(f.test, f.org, dq(f.id, f.ts[1].captain.userId, true));
        expect(matchRow(f.test, m.id).decidedBy?.tag).toBe('Dq');
        expect(lobbyRow(f.test, live.lobbyId).stage.tag).toBe('AwaitingResult');
        const [rec] = recordsOfLobby(f.test, live.lobbyId);
        expect(rec.status.tag).toBe('Validated');
        expect(rec.winnerTeamSide?.tag).toBe('Blue');
    });
});

describe('tournament audit #8: dq_participant needs Registration through InProgress', () => {
    it('audit #8: refused in Draft, Completed and Cancelled with the text; nothing changes', () => {
        const test = newHarness();
        const org = host(test);
        const draft = createTournament(test, org);
        const p = verified(test, 'p');
        expect(rejection(test, org, dq(draft, p.userId))).toBe(dqStage('Draft'));

        const cancelled = openTournament(test, org, { name: 'Cancelled' });
        register(test, p, cancelled);
        tx(test, org, (ctx) => M.cancel_tournament(ctx, { tournamentId: cancelled }));
        const before = enrolled(test, cancelled, p.userId);
        expect(rejection(test, org, dq(cancelled, p.userId))).toBe(dqStage('Cancelled'));
        expect(enrolled(test, cancelled, p.userId)).toEqual(before);

        const f = duel();
        resolveMatch(f.test, f.org, byKey(f.test, f.id, 'W-R1-M1').id, f.ts[0].teamId);
        advanceStage(f.test, f.org, f.id, 'Completed');
        const loser = f.ts[1].captain;
        const team = teamRow(f.test, f.ts[1].teamId)!;
        expect(rejection(f.test, f.org, dq(f.id, loser.userId, true))).toBe(dqStage('Completed'));
        expect(enrolled(f.test, f.id, loser.userId).status.tag).not.toBe('Disqualified');
        expect(membersOf(f.test, f.ts[1].teamId)).toEqual([loser.userId, f.ts[1].mate.userId].sort((a, b) => a - b));
        expect(teamRow(f.test, f.ts[1].teamId)).toEqual(team);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Audit #3, #4, #5: rollback, override and the group lock
// ════════════════════════════════════════════════════════════════════════════

describe('tournament audit #3: rollback after an override or a staff decision', () => {
    it('audit #3: a Bo1 decided by an override to Validated, then rollback_bracket_match: Ready, record Voided, winner removed downstream', () => {
        const f = liveField(4, { defaultBestOf: 1, grandFinalBestOf: 1, requireResultValidation: true });
        const m = byKey(f.test, f.id, 'W-R1-M1');
        const final = byKey(f.test, f.id, 'W-R2-M1');
        const slot = () => { const r = matchRow(f.test, final.id); return m.nextWinnerSlot === 1 ? r.team1Id : r.team2Id; };
        const s = playMatch(f, m.id, 'Blue');
        const [r] = recordsOfLobby(f.test, s.lobbyId);
        tx(f.test, f.org, overrideBody(r.id, 'Validated', 'Blue'));
        expect(matchRow(f.test, m.id).decidedBy?.tag).toBe('Staff');
        expect(slot()).toBe(m.team1Id);

        tx(f.test, f.org, rollbackBody(m.id));
        const after = matchRow(f.test, m.id);
        expect(after.state.tag).toBe('Ready');
        expect(after.winnerTeamId).toBeUndefined();
        expect(f.test.db.MatchResultRecord.id.find(r.id)!.status.tag).toBe('Voided');
        expect(f.test.db.Lobby.id.find(s.lobbyId)).toBeFalsy();
        expect(slot()).toBeUndefined();
    });

    it('audit #3 (S8e rule kept): a staff resolve against the tally, then rollback: nothing is voided and the games re-decide the match (Played)', () => {
        const f = liveField(2, { defaultBestOf: 3, grandFinalBestOf: 3 });
        const m = byKey(f.test, f.id, 'W-R1-M1');
        playBracketMatch(f, m.id, ['Blue', 'Blue']);
        resolveMatch(f.test, f.org, m.id, m.team2Id!);
        expect(matchRow(f.test, m.id).decidedBy?.tag).toBe('Staff');
        tx(f.test, f.org, rollbackBody(m.id));
        const after = matchRow(f.test, m.id);
        expect(after.state.tag).toBe('Decided');
        expect(after.decidedBy?.tag).toBe('Played');
        expect(after.winnerTeamId).toBe(m.team1Id);
        expect(recordsOfMatch(f.test, m.id).map((r) => r.status.tag)).toEqual(['Validated', 'Validated']);
    });
});

describe('tournament audit #4: override_match_result on a staff or DQ decision', () => {
    it('audit #4: a record of a match decided by Dq is refused with the text; nothing changes', () => {
        const f = liveField(2, { defaultBestOf: 3, grandFinalBestOf: 3 });
        const m = byKey(f.test, f.id, 'W-R1-M1');
        const [g1] = playBracketMatch(f, m.id, ['Blue']);
        const [rec] = recordsOfLobby(f.test, g1.lobbyId);
        tx(f.test, f.org, dq(f.id, f.ts[1].captain.userId, true));
        const decided = matchRow(f.test, m.id);
        expect(decided.decidedBy?.tag).toBe('Dq');
        expect(rejection(f.test, f.org, overrideBody(rec.id, 'Validated', 'Red'))).toBe(DECIDED_BY_STAFF);
        expect(matchRow(f.test, m.id)).toEqual(decided);
        expect(f.test.db.MatchResultRecord.id.find(rec.id)!.status.tag).toBe('Validated');
    });

    it('audit #4: a match decided by Staff against the tally (resolve_bracket_match) is refused; nothing changes', () => {
        const f = liveField(4, { defaultBestOf: 3, grandFinalBestOf: 3 });
        const m = byKey(f.test, f.id, 'W-R1-M1');
        const final = byKey(f.test, f.id, 'W-R2-M1');
        const [g1] = playBracketMatch(f, m.id, ['Blue']);
        const [rec] = recordsOfLobby(f.test, g1.lobbyId);
        resolveMatch(f.test, f.org, m.id, m.team2Id!); // 1–0 for team1 on games; staff decide for team2
        const decided = matchRow(f.test, m.id);
        expect(rejection(f.test, f.org, overrideBody(rec.id, 'Validated', 'Red'))).toBe(DECIDED_BY_STAFF);
        expect(matchRow(f.test, m.id)).toEqual(decided);
        const r = matchRow(f.test, final.id);
        expect(m.nextWinnerSlot === 1 ? r.team1Id : r.team2Id).toBe(m.team2Id); // still placed downstream
    });

    it('audit #4: a Staff decision the tally gives (an earlier override) can be corrected by another override', () => {
        const f = liveField(2, { defaultBestOf: 1, grandFinalBestOf: 1, requireResultValidation: true });
        const m = byKey(f.test, f.id, 'W-R1-M1');
        const s = playMatch(f, m.id, 'Blue');
        const [rec] = recordsOfLobby(f.test, s.lobbyId);
        tx(f.test, f.org, overrideBody(rec.id, 'Validated', 'Blue'));
        expect(matchRow(f.test, m.id).winnerTeamId).toBe(m.team1Id);
        tx(f.test, f.org, overrideBody(rec.id, 'Validated', 'Red'));
        const after = matchRow(f.test, m.id);
        expect(after.state.tag).toBe('Decided');
        expect(after.decidedBy?.tag).toBe('Staff');
        expect(after.winnerTeamId).toBe(m.team2Id);
    });
});

describe('tournament audit #5: group matches lock once the elimination bracket exists', () => {
    it('audit #5: before advance_group_stage resolve / rollback / override work on a group match; after it each is refused with the text', () => {
        const f = liveField(4, { format: 'GroupIntoSingleElim', groupSize: 4, groupAdvanceCount: 2 });
        const { test, org } = f;
        const groupRows = () => bracketRows(test, f.id).filter((r) => r.bracketSide.tag === 'Group').sort((a, b) => a.id - b.id);
        const [g1, g2] = groupRows();
        const s = playMatch(f, g1.id, 'Blue'); // decided by play (Bo1)
        const [rec] = recordsOfLobby(test, s.lobbyId);
        tx(test, org, overrideBody(rec.id, 'Validated', 'Red')); // works before the elimination bracket exists
        expect(matchRow(test, g1.id).winnerTeamId).toBe(g1.team2Id);
        resolveMatch(test, org, g2.id, g2.team1Id!);
        tx(test, org, rollbackBody(g2.id));
        expect(matchRow(test, g2.id).state.tag).toBe('Ready');
        resolveMatch(test, org, g2.id, g2.team1Id!);
        for (const r of groupRows().filter((x) => x.state.tag === 'Ready')) resolveMatch(test, org, r.id, r.team1Id!);
        tx(test, org, (ctx) => M.advance_group_stage(ctx, { tournamentId: f.id }));
        expect(bracketRows(test, f.id).some((r) => r.bracketSide.tag !== 'Group')).toBe(true);

        const before = groupRows();
        expect(rejection(test, org, resolveBody(g2.id, g2.team2Id!))).toBe(GROUP_LOCKED);
        expect(rejection(test, org, rollbackBody(g1.id))).toBe(GROUP_LOCKED);
        expect(rejection(test, org, overrideBody(rec.id, 'Validated', 'Blue'))).toBe(GROUP_LOCKED);
        expect(groupRows()).toEqual(before);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Audit #6: minimum MMR on the active season
// ════════════════════════════════════════════════════════════════════════════

describe('tournament audit #6: the minimum MMR reads the active season', () => {
    function rating(test: Harness, userId: number, value: number, seasonId: number) {
        test.db.MmrRating.insert({
            userId, gameMode: { tag: 'MemoryOfChaos' } as any, rating: value, matchesPlayed: 1,
            globalCompositeRating: undefined, seasonId, ...AUDIT(test),
        });
    }
    function world() {
        const test = newHarness();
        tx(test, 'internal', (ctx) => M.admin_seed_elo_config(ctx, {}));
        const org = host(test);
        return { test, org };
    }

    it('audit #6: with an active season whose id is not 0, a player rated 1600 in it passes a 1400 floor and a player rated 700 in it fails a 900 floor', () => {
        const { test, org } = world();
        const boss = admin(test);
        tx(test, boss, (ctx) => M.create_season(ctx, { name: 'S1', startDate: test.clock.now(), endDate: undefined }));
        const season = [...test.db.Season.iter()].find((s) => s.name === 'S1')!;
        tx(test, boss, (ctx) => M.set_active_season(ctx, { seasonId: season.id }));
        expect(season.id).not.toBe(0);

        const high = verified(test, 'high');
        rating(test, high.userId, 1600, season.id);
        const low = verified(test, 'low');
        rating(test, low.userId, 700, season.id);
        const t1400 = openTournament(test, org, { name: 'Floor 1400', minimumMmr: 1400 });
        const t900 = openTournament(test, org, { name: 'Floor 900', minimumMmr: 900 });
        register(test, high, t1400);
        expect(enrolled(test, t1400, high.userId)).toBeDefined();
        expect(rejection(test, low, (ctx) => M.register_for_tournament(ctx, { tournamentId: t900 })))
            .toBe('This tournament needs an MMR of at least 900 (yours: 700).');
        expect(enrolled(test, t900, low.userId)).toBeUndefined();
    });

    it('audit #6: with no active season the season-0 rating decides (old behaviour)', () => {
        const { test, org } = world();
        const high = verified(test, 'high');
        rating(test, high.userId, 1600, 0);
        const low = verified(test, 'low');
        rating(test, low.userId, 700, 0);
        const t1400 = openTournament(test, org, { name: 'Floor 1400', minimumMmr: 1400 });
        const t900 = openTournament(test, org, { name: 'Floor 900', minimumMmr: 900 });
        register(test, high, t1400);
        expect(enrolled(test, t1400, high.userId)).toBeDefined();
        expect(rejection(test, low, (ctx) => M.register_for_tournament(ctx, { tournamentId: t900 })))
            .toBe('This tournament needs an MMR of at least 900 (yours: 700).');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Audit #10, #11: registrant accounts and matches-for-me
// ════════════════════════════════════════════════════════════════════════════

type RegistrantRow = { tournamentId: number; userId: number; seat: number; hsrAccountId: number; displayLabel: string };

describe('tournament audit #10: view_tournament_registrant_accounts', () => {
    it('audit #10(a)(c): anonymous tournament: a participant sees neutral labels and no ids for other seats, the real label on own rows; waitlisted / disqualified readers see only their own rows; staff see every registrant', () => {
        const test = newHarness();
        const org = host(test);
        // S10m: the fixture default is now ClosedNoRating (A113(1)); this view test reads an open roster.
        const id = openTournament(test, org, { teamSize: 1, isAnonymousDefault: true, maxParticipants: 3, waitlistEnabled: true, rosterVisibility: 'OpenRoster' });
        const p1 = verified(test, 'p1');
        const p2 = verified(test, 'p2');
        const d = verified(test, 'd');
        const w = verified(test, 'w');
        const p1Acct = insertHsrAccount(test, p1.userId, 'p1 main');
        const p2Accts = [insertHsrAccount(test, p2.userId, 'p2 main'), insertHsrAccount(test, p2.userId, 'p2 alt')];
        const dAcct = insertHsrAccount(test, d.userId, 'd main');
        insertHsrAccount(test, w.userId, 'w main');
        for (const p of [p1, p2, d, w]) register(test, p, id);
        expect(enrolled(test, id, w.userId).isWaitlisted).toBe(true);
        tx(test, org, dq(id, d.userId));

        const VIEW = 'view_tournament_registrant_accounts';
        const staffRows = viewAs<RegistrantRow>(test, VIEW, org).filter((r) => r.tournamentId === id);
        expect(new Set(staffRows.map((r) => r.userId))).toEqual(new Set([p1.userId, p2.userId, d.userId]));
        expect(staffRows.find((r) => r.hsrAccountId === dAcct)?.displayLabel).toBe('d main');
        const p2Seat = staffRows.find((r) => r.userId === p2.userId)!.seat;

        const p1Rows = viewAs<RegistrantRow>(test, VIEW, p1);
        const own = p1Rows.filter((r) => r.userId === p1.userId);
        expect(own.map((r) => [r.hsrAccountId, r.displayLabel])).toEqual([[p1Acct, 'p1 main']]);
        const others = p1Rows.filter((r) => r.userId !== p1.userId);
        expect(others).toHaveLength(2); // p2's two accounts; d (Disqualified) and w (waitlisted) are out of the field
        for (const r of others) {
            expect(r.userId).toBe(0);
            expect(r.hsrAccountId).toBe(0);
            expect(r.seat).toBe(p2Seat);
        }
        expect(others.map((r) => r.displayLabel).sort()).toEqual([`Seat-${p2Seat} account 1`, `Seat-${p2Seat} account 2`]);
        const leaked = p1Rows.filter((r) => ['p2 main', 'p2 alt', 'd main', 'w main'].includes(r.displayLabel)
            || p2Accts.includes(r.hsrAccountId) || r.hsrAccountId === dAcct || [p2.userId, d.userId, w.userId].includes(r.userId));
        expect(leaked).toEqual([]);

        const dRows = viewAs<RegistrantRow>(test, VIEW, d);
        expect(dRows.map((r) => [r.userId, r.displayLabel])).toEqual([[d.userId, 'd main']]);
        expect(viewAs<RegistrantRow>(test, VIEW, w)).toEqual([]); // no locks while waitlisted, and no one else's rows
    });

    it('audit #10(b): a Completed tournament returns nothing to a participant or to the organizer', () => {
        const f = duel({ isAnonymousDefault: true });
        const cap = f.ts[0].captain;
        const acct = insertHsrAccount(f.test, cap.userId, 'cap main');
        tx(f.test, cap, lockBody(f.id, [acct]));
        const VIEW = 'view_tournament_registrant_accounts';
        expect(viewAs(f.test, VIEW, cap).length).toBeGreaterThan(0);
        expect(viewAs(f.test, VIEW, f.org).length).toBeGreaterThan(0);
        resolveMatch(f.test, f.org, byKey(f.test, f.id, 'W-R1-M1').id, f.ts[0].teamId);
        advanceStage(f.test, f.org, f.id, 'Completed');
        expect(viewAs(f.test, VIEW, cap)).toEqual([]);
        expect(viewAs(f.test, VIEW, f.org)).toEqual([]);
    });
});

describe('tournament audit #11: view_tournament_matches_for_me covers InProgress tournaments only', () => {
    it('audit #11: rows for an InProgress tournament; nothing once it is Cancelled', () => {
        const f = duel();
        const cap = f.ts[0].captain;
        expect(viewAs(f.test, 'view_tournament_matches_for_me', cap).length).toBeGreaterThan(0);
        tx(f.test, f.org, (ctx) => M.cancel_tournament(ctx, { tournamentId: f.id }));
        expect(byKey(f.test, f.id, 'W-R1-M1').state.tag).toBe('Ready'); // the bracket row stays
        expect(viewAs(f.test, 'view_tournament_matches_for_me', cap)).toEqual([]);
    });

    // No reducer completes a tournament with a Ready match, so the Completed case is a direct row edit (as the S8b / S8c
    // guard tests stamp rows).
    it('audit #11: nothing for a Completed tournament that still holds a Ready row (direct stage edit)', () => {
        const f = duel();
        const cap = f.ts[0].captain;
        expect(viewAs(f.test, 'view_tournament_matches_for_me', cap).length).toBeGreaterThan(0);
        f.test.db.Tournament.id.update({ ...tRow(f.test, f.id), stage: { tag: 'Completed' } as any });
        expect(viewAs(f.test, 'view_tournament_matches_for_me', cap)).toEqual([]);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Audit #13: the tournament entry throttle
// ════════════════════════════════════════════════════════════════════════════

describe('tournament audit #13: at most 10 tournament entry writes per 60 s window', () => {
    it('audit #13: register, alias, rename and lock share one window; the 11th is rejected; withdraw and an unchanged rename are never counted; a new window passes', () => {
        const test = newHarness();
        const org = host(test);
        const anon = openTournament(test, org, { name: 'Anon', isAnonymousDefault: true });
        const plain = openTournament(test, org, { name: 'Plain' });
        const u = verified(test, 'u');
        const count = () => test.db.UserRateState.userId.find(u.userId)?.tournamentCount;
        const alias = (a: string) => (ctx: any) => M.set_anonymous_alias(ctx, { tournamentId: anon, alias: a });
        const withdraw = (ctx: any) => M.withdraw_from_tournament(ctx, { tournamentId: plain });
        const registerPlain = (ctx: any) => M.register_for_tournament(ctx, { tournamentId: plain });

        register(test, u, anon, { anonymousAlias: 'Ghost' });       // 1
        expect(count()).toBe(1);
        tx(test, u, alias('Ghost two'));                            // 2
        tx(test, u, (ctx) => M.create_tournament_team(ctx, { tournamentId: anon, teamName: 'Alpha' }));
        expect(count()).toBe(2); // creating a team is not an entry write
        const teamId = teams(test, anon).find((t) => t.name === 'Alpha')!.id;
        const rename = (name: string) => (ctx: any) => M.rename_tournament_team(ctx, { teamId, name });
        tx(test, u, rename('Beta'));                                // 3
        tx(test, u, rename('Beta'));                                // unchanged: not counted
        expect(count()).toBe(3);
        const acct = insertHsrAccount(test, u.userId, 'u-acct');
        tx(test, u, lockBody(anon, [acct]));                        // 4
        for (let i = 0; i < 3; i++) {
            tx(test, u, registerPlain);                             // 5, 6, 7
            tx(test, u, withdraw);                                  // never counted
        }
        expect(count()).toBe(7);
        tx(test, u, alias('Ghost three'));                          // 8
        tx(test, u, alias('Ghost four'));                           // 9
        tx(test, u, registerPlain);                                 // 10
        expect(count()).toBe(10);

        expect(rejection(test, u, alias('Ghost five'))).toBe(THROTTLE);
        expect(rejection(test, u, rename('Gamma'))).toBe(THROTTLE);
        expect(rejection(test, u, lockBody(anon, [acct]))).toBe(THROTTLE);
        expect(enrolled(test, anon, u.userId).anonymousAlias).toBe('Ghost four');
        expect(teamRow(test, teamId)!.name).toBe('Beta');
        tx(test, u, rename('Beta'));                                // unchanged: passes at the cap
        tx(test, u, withdraw);                                      // never rejected
        expect(enrolled(test, plain, u.userId)).toBeUndefined();
        expect(rejection(test, u, registerPlain)).toBe(THROTTLE);
        expect(count()).toBe(10);

        advance(test, 60_000);
        tx(test, u, alias('Ghost five'));
        expect(count()).toBe(1);
        expect(enrolled(test, anon, u.userId).anonymousAlias).toBe('Ghost five');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// LOW 15 and 16
// ════════════════════════════════════════════════════════════════════════════

describe('tournament audit LOW 15: a disqualified ex-captain is not the captain any more', () => {
    it('LOW 15: after a whole-team DQ the ex-captain cannot disband or rename the team; the Disqualified team row stays', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org);
        const [cap, mate] = enrollMany(test, id, 2, 'm');
        const teamId = makeTeam(test, id, cap, [mate], 'Doomed');
        tx(test, org, dq(id, cap.userId, true));
        const team = teamRow(test, teamId)!;
        expect(team.status.tag).toBe('Disqualified');
        expect(team.captainUserId).toBe(cap.userId);
        expect(rejection(test, cap, (ctx) => M.disband_tournament_team(ctx, { teamId }))).toBe(NOT_CAPTAIN_DISBAND);
        expect(rejection(test, cap, (ctx) => M.rename_tournament_team(ctx, { teamId, name: 'Renamed' }))).toBe(NOT_CAPTAIN_RENAME);
        expect(teamRow(test, teamId)).toEqual(team);
    });
});

describe('tournament audit LOW 16: update_display_name keeps solo team names unique', () => {
    it('LOW 16: a solo player taking another player\'s display name gets a " (2)" team name; the other team is unchanged', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { teamSize: 1 });
        const alpha = verified(test, 'alpha');
        const beta = verified(test, 'beta');
        register(test, alpha, id);
        register(test, beta, id);
        const alphaTeam = membership(test, id, alpha.userId)!.teamId;
        const betaTeam = membership(test, id, beta.userId)!.teamId;
        const alphaName = teamRow(test, alphaTeam)!.name;
        expect(alphaName).toBe(test.db.User.id.find(alpha.userId)!.displayName);

        tx(test, beta, (ctx) => M.update_display_name(ctx, { newDisplayName: alphaName.toUpperCase() }));
        expect(teamRow(test, betaTeam)!.name).toBe(`${alphaName.toUpperCase()} (2)`);
        expect(teamRow(test, alphaTeam)!.name).toBe(alphaName);
        const names = teams(test, id).map((t) => t.name.toLowerCase());
        expect(new Set(names).size).toBe(names.length);
    });
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

describe('A104 review F3: "their first game" is the player\'s own game', () => {
    it('A104 / F3: a member who sat out the team\'s first game (a stand-in played) can still lock; the teammate who played cannot', () => {
        const f = duel();
        const { test, org } = f;
        const m = byKey(test, f.id, 'W-R1-M1');
        const { blue, red } = sidesOf(f, m.id);
        const sub = verified(test, 'sub');
        tx(test, org, (ctx) => M.approve_stand_in(ctx, { bracketMatchId: m.id, teamId: m.team1Id!, userId: sub.userId }));
        const lobbyId = createTournamentLobby(test, org, m.id);
        for (const p of [blue.captain, sub, red.captain, red.mate]) {
            join(test, p, lobbyId);
            tx(test, p, (ctx) => M.confirm_ready(ctx, { lobbyId }));
        }
        tx(test, org, (ctx) => M.start_draft(ctx, { lobbyId }));
        expect(lobbyRow(test, lobbyId).stage.tag).not.toBe('Waiting');
        expect([...test.db.LobbyMember.lobby_id.filter(lobbyId)].some((r) => r.userId === blue.mate.userId)).toBe(false);

        const mateAcct = insertHsrAccount(test, blue.mate.userId, 'mate-late');
        tx(test, blue.mate, lockBody(f.id, [mateAcct]));
        expect(locks(test, f.id, blue.mate.userId)).toEqual([mateAcct]);
        const capAcct = insertHsrAccount(test, blue.captain.userId, 'cap-late');
        expect(rejection(test, blue.captain, lockBody(f.id, [capAcct]))).toBe(LOCK_STARTED);
        expect(locks(test, f.id, blue.captain.userId)).toEqual([]);
    });

    it('A104 / F3: a voided game the player took part in still counts (resolve_bracket_match voids the live lobby; record Voided, lobby gone)', () => {
        const f = duel();
        const { test, org } = f;
        const m = byKey(test, f.id, 'W-R1-M1');
        const s = openMatchLobby(f, m.id);
        const [rec] = recordsOfLobby(test, s.lobbyId);
        resolveMatch(test, org, m.id, m.team1Id!);
        expect(test.db.MatchResultRecord.id.find(rec.id)!.status.tag).toBe('Voided');
        expect(test.db.Lobby.id.find(s.lobbyId)).toBeFalsy();
        expect(stageOf(test, f.id)).toBe('InProgress');

        const b1 = s.a.b1;
        const acct = insertHsrAccount(test, b1.userId, 'b1-late');
        expect(rejection(test, b1, lockBody(f.id, [acct]))).toBe(LOCK_STARTED);
        expect(locks(test, f.id, b1.userId)).toEqual([]);
    });
});

describe('tournament audit #15 review F4: every captain-only reducer needs the acting captain', () => {
    it('F4: after a whole-team DQ in Registration the ex-captain cannot accept or reject a pending request', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org);
        const [cap, x] = enrollMany(test, id, 2, 'f4-');
        tx(test, cap, (ctx) => M.create_tournament_team(ctx, { tournamentId: id, teamName: 'Solo cap' }));
        const teamId = teams(test, id).find((t) => t.name === 'Solo cap')!.id;
        tx(test, x, (ctx) => M.request_join_team(ctx, { teamId }));
        tx(test, org, dq(id, cap.userId, true));
        const team = teamRow(test, teamId)!;
        expect(team.status.tag).toBe('Disqualified');
        expect(team.captainUserId).toBe(cap.userId);
        const requestsBefore = requestsOf(test, x.userId);

        expect(rejection(test, cap, (ctx) => M.accept_team_request(ctx, { teamId, userId: x.userId }))).toBe(NOT_CAPTAIN_ACCEPT);
        expect(rejection(test, cap, (ctx) => M.reject_team_request(ctx, { teamId, userId: x.userId }))).toBe(NOT_CAPTAIN_REJECT);
        expect(requestsOf(test, x.userId)).toEqual(requestsBefore);
        expect(membersOf(test, teamId)).toEqual([]);
        expect(teamRow(test, teamId)).toEqual(team);
    });

    it('F4: after a whole-team DQ in CheckIn the ex-captain cannot check the team in or withdraw it (captain texts, not the status text)', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { checkInEnabled: true });
        const [t1] = fullTeams(test, id, 2, 'ci');
        advanceStage(test, org, id, 'CheckIn');
        expect(stageOf(test, id)).toBe('CheckIn');
        tx(test, org, dq(id, t1.captain.userId, true));
        const team = teamRow(test, t1.teamId)!;
        expect(team.status.tag).toBe('Disqualified');
        expect(team.captainUserId).toBe(t1.captain.userId);

        expect(rejection(test, t1.captain, (ctx) => M.check_in_tournament(ctx, { tournamentId: id, teamId: t1.teamId })))
            .toBe(TOURNAMENT_PERM_MESSAGES.participants);
        expect(rejection(test, t1.captain, (ctx) => M.withdraw_tournament_team(ctx, { teamId: t1.teamId }))).toBe(NOT_CAPTAIN_WITHDRAW);
        expect(teamRow(test, t1.teamId)).toEqual(team);
        expect(enrolled(test, id, t1.captain.userId).status.tag).toBe('Disqualified');
    });
});

describe('A104 review F5: lock_tournament_accounts by a waitlisted player', () => {
    it('A104 / F5: the first waitlisted call (no accounts named at registration) is stored and applied at promotion: only the chosen account is locked', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { maxParticipants: 1, waitlistEnabled: true });
        const [first] = enrollMany(test, id, 1);
        const w = verified(test, 'w');
        insertHsrAccount(test, w.userId, 'w1');
        const a2 = insertHsrAccount(test, w.userId, 'w2');
        register(test, w, id);
        expect(enrolled(test, id, w.userId).isWaitlisted).toBe(true);
        expect(waitlistRows(test, id, w.userId)).toEqual([]);

        tx(test, w, lockBody(id, [a2]));
        expect(waitlistRows(test, id, w.userId)).toEqual([a2]);
        expect(locks(test, id, w.userId)).toEqual([]);

        tx(test, first, (ctx) => M.withdraw_from_tournament(ctx, { tournamentId: id }));
        tx(test, org, (ctx) => M.waitlist_promote(ctx, { tournamentId: id, userId: w.userId }));
        expect(locks(test, id, w.userId)).toEqual([a2]);
        expect(waitlistRows(test, id, w.userId)).toEqual([]);
    });

    it('A104 / F5: once the bracket is generated (Seeding, then InProgress) a waitlisted call is refused with the text; nothing is stored', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { teamSize: 1, maxParticipants: 2, waitlistEnabled: true });
        enrollMany(test, id, 2, 'in');
        const w = verified(test, 'w');
        const acct = insertHsrAccount(test, w.userId, 'w-acct');
        register(test, w, id);
        expect(enrolled(test, id, w.userId).isWaitlisted).toBe(true);
        advanceStage(test, org, id, 'Seeding');
        seedAndGenerate(test, org, id);
        expect(tRow(test, id).bracketGeneratedAt).toBeDefined();
        expect(rejection(test, org, (ctx) => M.waitlist_promote(ctx, { tournamentId: id, userId: w.userId }))).toBe('Bracket generated; use stand-ins.');

        expect(rejection(test, w, lockBody(id, [acct]))).toBe(LOCK_WAITLIST_CLOSED);
        expect(waitlistRows(test, id, w.userId)).toEqual([]);
        advanceStage(test, org, id, 'InProgress');
        expect(rejection(test, w, lockBody(id, [acct]))).toBe(LOCK_WAITLIST_CLOSED);
        expect(waitlistRows(test, id, w.userId)).toEqual([]);
        expect(locks(test, id, w.userId)).toEqual([]);
    });
});
