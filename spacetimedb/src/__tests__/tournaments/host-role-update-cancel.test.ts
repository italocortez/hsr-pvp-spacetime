// Tournaments: the TournamentHost role, update outside Draft, cancel_tournament and per-tournament account locks.
// Decisions: A24, A26a, A36, D-21
// Contracts: docs/tournament/contract.md, docs/brackets/contract.md
// From S10 (s10-tournament.test.ts).
//
// T-S10 (batch B): in-memory ports of the live tournament suites' remaining gaps (tournament-admin, -cancel-cleanup,
// -management, -stages, season/tournament-player-account): mod_promote_to_host / mod_demote_from_host, update_tournament
// in Registration and after Seeding / on Cancelled, cancel from Draft, cancel of a Completed tournament, the cancel
// cascade (docs/tournament/contract.md "Cancel cascade" edge row, S8d) and per-tournament account locks.
// Builders from s4 / s8 / s8d fixtures; roles are written through `test.db` (setUserRole), never server_set_role.
// Nothing reaches maincloud.
import { describe, expect, it } from 'vitest';
import { M, expectReject, newHarness, tx, type Actor, type Harness } from '../fixtures/harness';
import { host, moderator, setUserRole, verified } from '../fixtures/identity';
import { invitesOf, at } from '../fixtures/calendar';
import { insertHsrAccount } from '../fixtures/roster';
import {
    advanceStage,
    assignAssistant,
    bracketRows,
    createTournament,
    locks,
    makeTeam,
    openTournament,
    register,
    requestsOf,
    resolveMatch,
    seedAndGenerate,
    stageOf,
    tRow,
    teams,
    updateBody,
} from '../fixtures/tournaments';
import { duel } from '../fixtures/tournament-matches';

const roleOf = (test: Harness, who: Actor) => test.db.User.id.find(who.userId)!.role.tag;
const promote = (test: Harness, by: Actor, target: Actor) =>
    tx(test, by, (ctx) => M.mod_promote_to_host(ctx, { userId: target.userId }));
const demote = (test: Harness, by: Actor, target: Actor) =>
    tx(test, by, (ctx) => M.mod_demote_from_host(ctx, { userId: target.userId }));
const cancel = (test: Harness, by: Actor, tournamentId: number) =>
    tx(test, by, (ctx) => M.cancel_tournament(ctx, { tournamentId }));
const assistantsOf = (test: Harness, tournamentId: number) => [...test.db.TournamentAssistant.tournament_id.filter(tournamentId)];
const eventsOf = (test: Harness, bracketMatchId: number) => [...test.db.CalendarEvent.bracket_match_id.filter(bracketMatchId)];

/** create_calendar_event (bracketMatchId 0 = personal); a linked event needs `bracket` and auto-invites the teams. */
function calendarEvent(test: Harness, who: Actor, title: string, bracketMatchId: number): number {
    tx(test, who, (ctx) => M.create_calendar_event(ctx, {
        title, description: '', startAt: at(test, 24), endAt: at(test, 26), bracketMatchId, inviteeUserIds: '',
    }));
    return [...test.db.CalendarEvent.organizer_id.filter(who.userId)].find((e) => e.title === title)!.id;
}

/** A verified player owning one HSR account (registering locks every own account by default). */
function playerWithAccount(test: Harness, name: string): { a: Actor; account: number } {
    const a = verified(test, name);
    return { a, account: insertHsrAccount(test, a.userId, `uid-${name}`) };
}

const sortIds = (ids: number[]) => [...ids].sort((x, y) => x - y);

// ─── mod_promote_to_host / mod_demote_from_host ──────────────────────────────

describe('mod_promote_to_host / mod_demote_from_host (Moderator+; User <-> TournamentHost only)', () => {
    it('contract "Moderator Promote to Host" / "Moderator Demote from Host": a Moderator promotes a User and demotes them back; an Admin may too', () => {
        const test = newHarness();
        const mod = moderator(test);
        const admin = verified(test, 'adm');
        setUserRole(test, admin.userId, 'Admin');
        const u = verified(test, 'u');

        promote(test, mod, u);
        expect(roleOf(test, u)).toBe('TournamentHost');
        demote(test, mod, u);
        expect(roleOf(test, u)).toBe('User');
        promote(test, admin, u);
        expect(roleOf(test, u)).toBe('TournamentHost');
    });

    it('contract edge rows "Promote already-TournamentHost" / "Promote Admin-role user" / "Demote a User-role player": wrong source role rejected, role unchanged', () => {
        const test = newHarness();
        const mod = moderator(test);
        const th = host(test, 'th');
        const admin = verified(test, 'adm');
        setUserRole(test, admin.userId, 'Admin');
        const u = verified(test, 'u');

        expectReject(test, mod, (ctx) => M.mod_promote_to_host(ctx, { userId: th.userId }),
            'Can only promote users with the "User" role to TournamentHost. Current role: TournamentHost');
        expectReject(test, mod, (ctx) => M.mod_promote_to_host(ctx, { userId: admin.userId }),
            'Can only promote users with the "User" role to TournamentHost. Current role: Admin');
        expectReject(test, mod, (ctx) => M.mod_demote_from_host(ctx, { userId: u.userId }),
            'Can only demote users with the "TournamentHost" role to User. Current role: User');
        expect(roleOf(test, th)).toBe('TournamentHost');
        expect(roleOf(test, admin)).toBe('Admin');
        expect(roleOf(test, u)).toBe('User');
    });

    it('contract edge rows "Non-moderator calls promote/demote" / "Self-promote/demote via mod reducer": rejected, roles unchanged', () => {
        const test = newHarness();
        const mod = moderator(test);
        const th = host(test, 'th');
        const u = verified(test, 'u');
        const other = verified(test, 'other');

        expectReject(test, th, (ctx) => M.mod_promote_to_host(ctx, { userId: u.userId }), 'Requires Moderator or Admin privileges');
        expectReject(test, other, (ctx) => M.mod_demote_from_host(ctx, { userId: th.userId }), 'Requires Moderator or Admin privileges');
        expectReject(test, mod, (ctx) => M.mod_demote_from_host(ctx, { userId: mod.userId }), 'You cannot change your own role via this reducer.');
        expect(roleOf(test, u)).toBe('User');
        expect(roleOf(test, th)).toBe('TournamentHost');
        expect(roleOf(test, mod)).toBe('Moderator');
    });
});

// ─── update_tournament ────────────────────────────────────────────────────────

describe('update_tournament outside Draft (A36)', () => {
    it('contract "Tournament Update (Registration)" (T-S10g: isAnonymousDefault Draft-only, A103): rosterVisibility and disconnectPolicy change in Registration; isAnonymousDefault stays; stage kept', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org);
        tx(test, org, updateBody(test, id, {
            name: 'Reg Update', rosterVisibility: 'ClosedWithRating', disconnectPolicy: 'Deferred',
        }));
        const t = tRow(test, id);
        expect(t.name).toBe('Reg Update');
        expect(t.rosterVisibility.tag).toBe('ClosedWithRating');
        expect(t.isAnonymousDefault).toBe(false);
        expect(t.disconnectPolicy.tag).toBe('Deferred');
        expect(t.stage.tag).toBe('Registration');
        // A103: a flip of isAnonymousDefault outside Draft is rejected (the s10g suite covers every stage).
        expectReject(test, org, updateBody(test, id, { isAnonymousDefault: true }), 'The anonymous setting can only change in Draft.');
        expect(tRow(test, id).isAnonymousDefault).toBe(false);
    });

    it('A36 (contract S8b scenario "update_tournament takes the same set; … the rest until Seeding"): rejected in Seeding and on a Cancelled tournament with the current text', () => {
        const test = newHarness();
        const org = host(test);
        const seeding = openTournament(test, org);
        const [sa, sb, sc, sd] = ['sa', 'sb', 'sc', 'sd'].map((n) => verified(test, n));
        for (const p of [sa, sb, sc, sd]) register(test, p, seeding);
        makeTeam(test, seeding, sa, [sb], 'S one');
        makeTeam(test, seeding, sc, [sd], 'S two');
        advanceStage(test, org, seeding, 'Seeding');
        expect(stageOf(test, seeding)).toBe('Seeding');
        expectReject(test, org, updateBody(test, seeding, { name: 'Late' }), 'Tournament settings can only change before Seeding.');

        const cancelled = openTournament(test, org, { name: 'To cancel' });
        cancel(test, org, cancelled);
        expectReject(test, org, updateBody(test, cancelled, { name: 'After' }), 'Tournament settings can only change before Seeding.');
        expect(tRow(test, cancelled).name).toBe('To cancel');
    });
});

// ─── cancel ───────────────────────────────────────────────────────────────────

describe('cancel_tournament (A24(5), A24(6))', () => {
    it('contract reducer row "cancel_tournament: cancel from any non-terminal stage" + edge row "Cancel tournament with no infrastructure rows": a Draft tournament cancels cleanly', () => {
        const test = newHarness();
        const org = host(test);
        const id = createTournament(test, org);
        expect(stageOf(test, id)).toBe('Draft');
        cancel(test, org, id);
        expect(stageOf(test, id)).toBe('Cancelled');
    });

    it('contract edge row "Cancel completed tournament": rejected, the tournament stays Completed (current text "Cannot cancel a tournament that is already Completed.")', () => {
        const f = duel();
        const [final] = bracketRows(f.test, f.id);
        resolveMatch(f.test, f.org, final.id, final.team1Id!);
        advanceStage(f.test, f.org, f.id, 'Completed');
        expect(stageOf(f.test, f.id)).toBe('Completed');
        expectReject(f.test, f.org, (ctx) => M.cancel_tournament(ctx, { tournamentId: f.id }),
            'Cannot cancel a tournament that is already Completed.');
        expect(stageOf(f.test, f.id)).toBe('Completed');
    });

    it('contract "Cancel cascade" edge row (S8d, A24(5)), from Registration: pending team requests and account locks deleted; the team, its member, assistants and enrolments kept', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org);
        const cap = playerWithAccount(test, 'cap');
        const mate = playerWithAccount(test, 'mate');
        const asker = playerWithAccount(test, 'asker');
        for (const p of [cap, mate, asker]) register(test, p.a, id);
        const teamId = makeTeam(test, id, cap.a, [], 'Keepers'); // Forming (teamSize 2): the requests stay pending
        tx(test, mate.a, (ctx) => M.request_join_team(ctx, { teamId }));
        tx(test, asker.a, (ctx) => M.request_join_team(ctx, { teamId }));
        const helper = verified(test, 'helper');
        assignAssistant(test, org, id, helper, { participants: true });

        expect(requestsOf(test, mate.a.userId)).toHaveLength(1);
        expect(requestsOf(test, asker.a.userId)).toHaveLength(1);
        expect(locks(test, id, cap.a.userId)).toEqual([cap.account]);
        expect(locks(test, id, asker.a.userId)).toEqual([asker.account]);

        cancel(test, org, id);

        expect(stageOf(test, id)).toBe('Cancelled');
        expect(requestsOf(test, mate.a.userId)).toEqual([]);
        expect(requestsOf(test, asker.a.userId)).toEqual([]);
        for (const p of [cap, mate, asker]) expect(locks(test, id, p.a.userId)).toEqual([]);
        expect(teams(test, id).map((t) => t.id)).toEqual([teamId]);
        expect([...test.db.TournamentTeamMember.team_id.filter(teamId)].map((m) => m.userId)).toEqual([cap.a.userId]);
        expect(assistantsOf(test, id).map((r) => r.userId)).toEqual([helper.userId]);
        expect([...test.db.TournamentEnrolled.tournament_id.filter(id)]).toHaveLength(3);
    });

    it('contract "Cancel cascade" edge row + calendar contract "Tournament Cancellation Cascades" (D-21), from InProgress: linked events and their invites deleted, a personal event kept; bracket, teams, assistants kept; locks deleted', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org);
        const ps = ['a1', 'a2', 'b1', 'b2', 'c1', 'c2', 'd1', 'd2'].map((n) => playerWithAccount(test, n));
        for (const p of ps) register(test, p.a, id);
        const teamIds = [0, 2, 4, 6].map((i) => makeTeam(test, id, ps[i].a, [ps[i + 1].a], `team ${i / 2 + 1}`));
        advanceStage(test, org, id, 'Seeding');
        seedAndGenerate(test, org, id);
        advanceStage(test, org, id, 'InProgress');
        const helper = verified(test, 'helper');
        assignAssistant(test, org, id, helper, { bracket: true });

        const ready = bracketRows(test, id).filter((m) => m.state.tag === 'Ready');
        expect(ready.length).toBeGreaterThanOrEqual(2);
        const e1 = calendarEvent(test, org, 'Semi 1', ready[0].id);
        const e2 = calendarEvent(test, org, 'Semi 2', ready[1].id);
        expect(invitesOf(test, e1).length).toBeGreaterThan(0);
        expect(invitesOf(test, e2).length).toBeGreaterThan(0);
        const personal = calendarEvent(test, ps[0].a, 'Personal', 0);
        const bracketBefore = sortIds(bracketRows(test, id).map((m) => m.id));
        expect(locks(test, id, ps[0].a.userId)).toEqual([ps[0].account]);

        cancel(test, org, id);

        expect(stageOf(test, id)).toBe('Cancelled');
        for (const m of ready.slice(0, 2)) expect(eventsOf(test, m.id)).toEqual([]);
        expect(test.db.CalendarEvent.id.find(e1)).toBeNull();
        expect(test.db.CalendarEvent.id.find(e2)).toBeNull();
        expect(invitesOf(test, e1)).toEqual([]);
        expect(invitesOf(test, e2)).toEqual([]);
        expect(test.db.CalendarEvent.id.find(personal)).not.toBeNull();
        expect(sortIds(bracketRows(test, id).map((m) => m.id))).toEqual(bracketBefore);
        expect(sortIds(teams(test, id).map((t) => t.id))).toEqual(sortIds(teamIds));
        expect(assistantsOf(test, id).map((r) => r.userId)).toEqual([helper.userId]);
        for (const p of ps) expect(locks(test, id, p.a.userId)).toEqual([]);
    });
});

// ─── account locks per tournament ─────────────────────────────────────────────

describe('TournamentPlayerAccount locks are scoped per tournament (A26a(4), D-21)', () => {
    it("contract \"withdraw … TournamentPlayerAccount rows deleted\": withdrawing from B deletes B's locks and leaves A's", () => {
        const test = newHarness();
        const org = host(test);
        const a = openTournament(test, org, { name: 'Cup A' });
        const b = openTournament(test, org, { name: 'Cup B' });
        const p = verified(test, 'p');
        const acc = sortIds([insertHsrAccount(test, p.userId, '500'), insertHsrAccount(test, p.userId, '501')]);
        register(test, p, a);
        register(test, p, b);
        expect(locks(test, a, p.userId)).toEqual(acc);
        expect(locks(test, b, p.userId)).toEqual(acc);

        tx(test, p, (ctx) => M.withdraw_from_tournament(ctx, { tournamentId: b }));

        expect(locks(test, b, p.userId)).toEqual([]);
        expect(locks(test, a, p.userId)).toEqual(acc);
    });
});
