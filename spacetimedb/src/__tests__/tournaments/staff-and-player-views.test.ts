// Tournaments: the staff views, the Admin arg views, registrant accounts, matches for me and team requests.
// Decisions: A73, A105, A122
// Contracts: docs/tournament/contract.md, docs/brackets/contract.md
// From S10g, S10s, S9c (s10g-tournament.test.ts, s10s-triage-fixes.test.ts, s9c-rulings.test.ts).
import { describe, expect, it } from 'vitest';
import type { TeamRequestViewRow } from '@bindings/types';
import { M, newHarness, tx, type Actor, type Harness } from '../fixtures/harness';
import {
    advanceStage,
    assignAssistant,
    enrollMany,
    enrolled,
    host,
    host as tournamentHost,
    insertHsrAccount,
    locks,
    moderator,
    openTournament,
    register,
    resolveMatch,
    stageOf,
    tRow,
    verified,
} from '../fixtures/tournament-builders';
import { byKey, duel, openMatchLobby, playMatch } from '../fixtures/tournament-match-builders';
import { admin, dq, lockBody } from '../fixtures/tournament-staff-helpers';
import { displayName, view } from '../fixtures/seat-view-readers';

/** A per-sender view called as `who` (arg views take `args`). */
const viewAs = <T = any>(test: Harness, name: string, who: Actor, args: Record<string, unknown> = {}): T[] =>
    (M as any)[name](test.viewContext(who.auth), args) as T[];

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
    // S10s re-alignment (A122(21), L71): the assistant holds one permission; an assistant with none reads no staff view
    // since S10s (s10s-triage-fixes.test.ts), so the "(no flags)" reader of this test is gone.
    it('A105(1): a running tournament: the organizer, an assistant (one permission), a non-staff Moderator and a non-staff Admin read every staff view; a plain user reads nothing', () => {
        const f = duel();
        const { test, org } = f;
        const assistant = verified(test, 'assist');
        assignAssistant(test, org, f.id, assistant, { results: true });
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
// L71: an assistant with no permission reads no staff view
// ════════════════════════════════════════════════════════════════════════════

describe('A122(21), L71: an assistant with all three permissions off reads no staff view', () => {
    it('A122(21) L71: the seven staff views are empty for a no-permission assistant; an assistant with one permission reads the organizer\'s rows', () => {
        const f = duel();
        const { test, org } = f;
        const none = verified(test, 'none');
        const one = verified(test, 'one');
        assignAssistant(test, org, f.id, none, {});
        assignAssistant(test, org, f.id, one, { bracket: true });
        for (const name of STAFF_VIEWS) {
            expect(viewAs(test, name, none), `${name}: no permission`).toEqual([]);
            expect(viewAs(test, name, one), `${name}: one permission`).toEqual(viewAs(test, name, org));
        }
        expect(viewAs(test, 'view_my_tournaments', one)).toHaveLength(1);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Fix pass F8: the L71 gate on view_tournament_registrant_accounts
// ════════════════════════════════════════════════════════════════════════════

describe('A122(21), L71 fix pass F8: view_tournament_registrant_accounts follows the same assistant gate', () => {
    it('A122(21) L71 F8: a no-permission assistant reads no registrant account; an assistant with one permission reads them', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org); // ClosedNoRating: only staff and the owner read account rows
        const p = verified(test, 'player');
        const acct = insertHsrAccount(test, p.userId, 'player-main');
        register(test, p, id);
        expect(locks(test, id, p.userId)).toEqual([acct]);
        const none = verified(test, 'none');
        const one = verified(test, 'one');
        assignAssistant(test, org, id, none, {});
        assignAssistant(test, org, id, one, { participants: true });
        expect(viewAs(test, 'view_tournament_registrant_accounts', none)).toEqual([]);
        const rows = viewAs<{ userId: number; hsrAccountId: number }>(test, 'view_tournament_registrant_accounts', one);
        expect(rows.map((r) => [r.userId, r.hsrAccountId])).toEqual([[p.userId, acct]]);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// A73: team requests identify the requester to the captain
// ════════════════════════════════════════════════════════════════════════════

describe('A73(1): view_my_team_requests identifies the requester to the captain in every tournament', () => {
    function anonTournamentRequest() {
        const test = newHarness();
        const org = tournamentHost(test, 'org');
        const id = openTournament(test, org, { isAnonymousDefault: true });
        const [cap, asker, outsider] = ['cap', 'asker', 'outsider'].map((n) => verified(test, n));
        register(test, cap, id);
        register(test, asker, id);
        register(test, outsider, id);
        tx(test, cap, (ctx) => M.create_tournament_team(ctx, { tournamentId: id, teamName: 'Forming' }));
        const teamId = [...test.db.TournamentTeam.tournament_id.filter(id)][0].id;
        tx(test, asker, (ctx) => M.request_join_team(ctx, { teamId }));
        return { test, id, org, cap, asker, outsider, teamId };
    }

    it('A73(1) the captain of an anonymous tournament reads the requester\'s real userId and real display name', () => {
        const { test, cap, asker, teamId, id } = anonTournamentRequest();
        expect(test.db.Tournament.id.find(id)!.isAnonymousDefault).toBe(true);
        const rows = view<TeamRequestViewRow>(test, 'view_my_team_requests', cap);
        expect(rows).toEqual([expect.objectContaining({ teamId, userId: asker.userId, label: displayName(test, asker), isMine: false })]);
    });

    it('A73(1) the requester\'s own row is unchanged (isMine, real id, the tournament-anonymity label)', () => {
        const { test, asker, teamId } = anonTournamentRequest();
        const [own] = view<TeamRequestViewRow>(test, 'view_my_team_requests', asker);
        expect(own).toMatchObject({ teamId, userId: asker.userId, isMine: true });
        expect(own.label).not.toBe(displayName(test, asker));
        expect(own.label).toBe('Seat-2');
    });

    it('A73(1) an outsider (another registrant, the organizer) reads nothing', () => {
        const { test, outsider, org } = anonTournamentRequest();
        expect(view(test, 'view_my_team_requests', outsider)).toEqual([]);
        expect(view(test, 'view_my_team_requests', org)).toEqual([]);
    });
});
