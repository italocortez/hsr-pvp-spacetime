// Tournaments: isAnonymousDefault in Draft, the minimum MMR of the active season, captain-only reducers and unique
//   solo team names.
// Decisions: A103
// Contracts: docs/tournament/contract.md, docs/brackets/contract.md
// From S10g (s10g-tournament.test.ts).
import { describe, expect, it } from 'vitest';
import { TOURNAMENT_PERM_MESSAGES } from '@module/helpers/tournament/tournamentPermissions';
import { M, newHarness, tx, type Harness } from '../fixtures/harness';
import {
    AUDIT,
    advanceStage,
    createTournament,
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
    stageOf,
    tRow,
    teamRow,
    teams,
    updateBody,
    verified,
} from '../fixtures/tournament-builders';
import { rejection } from '../fixtures/calendar-roster-rating-builders';
import { admin, dq } from '../fixtures/tournament-staff-helpers';

const ANON_DRAFT_ONLY = 'The anonymous setting can only change in Draft.';
const SETTINGS_BEFORE_SEEDING = 'Tournament settings can only change before Seeding.';
const NOT_CAPTAIN_DISBAND = 'Only the team captain can disband the team.';
const NOT_CAPTAIN_RENAME = 'Only the team captain can rename the team.';
const NOT_CAPTAIN_ACCEPT = 'Only the team captain can accept join requests.';
const NOT_CAPTAIN_REJECT = 'Only the team captain can reject join requests.';
const NOT_CAPTAIN_WITHDRAW = 'Only the team captain can withdraw the team.';

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
