// Tournaments: settings changes (isAnonymousDefault in Draft, update_tournament after the deadline, at least 2
//   participants), the MMR of the active season (minimum MMR, MMR seeding), captain-only reducers, unique solo team
//   names and aliases, waitlist promotion during Seeding.
// Decisions: A103, A122
// Contracts: docs/tournament/contract.md, docs/brackets/contract.md
// From S10g, S10s (s10g-tournament.test.ts, s10s-triage-fixes.test.ts); merged by T-REORG2.
import { describe, expect, it } from 'vitest';
import { TOURNAMENT_PERM_MESSAGES } from '@module/helpers/tournament/tournamentPermissions';
import { M, newHarness, tx, type Harness, AUDIT, rejection, advance, type Actor } from '../fixtures/harness';
import { host, verified, admin } from '../fixtures/identity';
import { DAY_MS, HOUR_MS, fromNow } from '../fixtures/calendar';
import {
    advanceStage,
    createTournament,
    enrollMany,
    enrolled,
    fullTeams,
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
    dq,
    TOURNAMENT_ARGS,
    bracketRows,
    seedAndGenerate,
    seedBracket,
    seedingField,
} from '../fixtures/tournaments';

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
    function world() {
        const test = newHarness();
        tx(test, 'internal', (ctx) => M.admin_seed_elo_config(ctx, {}));
        const org = host(test);
        return { test, org };
    }

    it('audit #6: with an active season whose id is not 0, a player rated 1600 in it passes a 1400 floor and a player rated 700 in it fails a 900 floor', () => {
        const { test, org } = world();
        const boss = admin(test, 'admin');
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

const DEADLINE_PAST = 'registrationDeadline must be in the future.';
const DEADLINE_NOT_NUMBER = 'registrationDeadline must be a date in microseconds since the epoch (digits only), or empty.';
const START_NOT_NUMBER = 'scheduledStartAt must be a date in microseconds since the epoch (digits only), or empty.';
const TWO_PARTICIPANTS = 'maxParticipants must be at least 2.';
const ALIAS_TAKEN = 'That alias is already taken in this tournament. Choose another.';

function rating(test: Harness, userId: number, value: number, seasonId: number) {
    test.db.MmrRating.insert({
        userId, gameMode: { tag: 'MemoryOfChaos' } as any, rating: value, matchesPlayed: 1,
        globalCompositeRating: undefined, seasonId, ...AUDIT(test),
    });
}

// ════════════════════════════════════════════════════════════════════════════
// L63: waitlist promotion in Seeding
// ════════════════════════════════════════════════════════════════════════════

describe('A122(16), L63: a solo player promoted from the waitlist during Seeding is seeded', () => {
    function soloCheckIn() {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { teamSize: 1, maxParticipants: 2, waitlistEnabled: true, checkInEnabled: true });
        const [a, b, c] = enrollMany(test, id, 3, 'solo');
        expect(enrolled(test, id, c.userId).isWaitlisted).toBe(true);
        return { test, org, id, a, b, c };
    }

    it('A122(16) L63: the waitlisted player\'s team, Withdrawn at CheckIn → Seeding, becomes Ready on promotion and is seeded into the bracket', () => {
        const { test, org, id, a, b, c } = soloCheckIn();
        advanceStage(test, org, id, 'CheckIn');
        for (const p of [a, b]) tx(test, p, (ctx) => M.check_in_tournament(ctx, { tournamentId: id }));
        advanceStage(test, org, id, 'Seeding');
        const cTeam = membership(test, id, c.userId)!.teamId;
        expect(teamRow(test, cTeam)!.status.tag).toBe('Withdrawn');

        tx(test, org, (ctx) => M.dq_participant(ctx, { tournamentId: id, userId: b.userId, reason: 'no-show', dqWholeTeam: false }));
        tx(test, org, (ctx) => M.waitlist_promote(ctx, { tournamentId: id, userId: c.userId }));
        expect(teamRow(test, cTeam)!.status.tag).toBe('Ready');
        const e = enrolled(test, id, c.userId);
        expect([e.isWaitlisted, e.status.tag, e.approvedByToAt !== undefined]).toEqual([false, 'Registered', true]);

        seedAndGenerate(test, org, id);
        const placed = bracketRows(test, id).flatMap((m) => [m.team1Id, m.team2Id]);
        expect(placed).toContain(cTeam);
        expect(placed).toContain(membership(test, id, a.userId)!.teamId);
    });

    it('A122(16) L63 (neighbour): a promotion during CheckIn leaves the team Forming → Ready as before (it was never Withdrawn)', () => {
        const { test, org, id, b, c } = soloCheckIn();
        advanceStage(test, org, id, 'CheckIn');
        tx(test, b, (ctx) => M.withdraw_from_tournament(ctx, { tournamentId: id }));
        tx(test, org, (ctx) => M.waitlist_promote(ctx, { tournamentId: id, userId: c.userId }));
        const cTeam = membership(test, id, c.userId)!.teamId;
        expect(teamRow(test, cTeam)!.status.tag).toBe('Ready');
        expect(enrolled(test, id, c.userId).status.tag).toBe('Registered');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// L64: update_tournament after the registration deadline
// ════════════════════════════════════════════════════════════════════════════

describe('A122(17), L64: update_tournament after the deadline, readable date errors, at least 2 participants', () => {
    function pastDeadline() {
        const test = newHarness();
        const org = host(test);
        const deadline = fromNow(test, HOUR_MS);
        const id = openTournament(test, org, { registrationDeadline: deadline });
        advance(test, 2 * HOUR_MS); // the deadline has passed
        return { test, org, id, deadline };
    }

    it('A122(17) L64: with the stored deadline passed, a change that keeps it is accepted', () => {
        const { test, org, id, deadline } = pastDeadline();
        tx(test, org, updateBody(test, id, { registrationDeadline: deadline, description: 'typo fixed' }));
        expect(tRow(test, id).description).toBe('typo fixed');
        expect(tRow(test, id).registrationDeadline!.microsSinceUnixEpoch).toBe(BigInt(deadline));
    });

    it('A122(17) L64: moving the deadline to another past time is refused; moving it to the future is accepted', () => {
        const { test, org, id } = pastDeadline();
        expect(rejection(test, org, updateBody(test, id, { registrationDeadline: fromNow(test, -HOUR_MS / 2) }))).toBe(DEADLINE_PAST);
        const later = fromNow(test, DAY_MS);
        tx(test, org, updateBody(test, id, { registrationDeadline: later }));
        expect(tRow(test, id).registrationDeadline!.microsSinceUnixEpoch).toBe(BigInt(later));
    });

    it('A122(17) L64: a non-numeric date is a readable SenderError for either date', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org);
        expect(rejection(test, org, updateBody(test, id, { registrationDeadline: 'tomorrow' }))).toBe(DEADLINE_NOT_NUMBER);
        expect(rejection(test, org, updateBody(test, id, { scheduledStartAt: '12abc' }))).toBe(START_NOT_NUMBER);
        expect(tRow(test, id).registrationDeadline).toBeUndefined();
    });

    it('A122(17) L64: maxParticipants below 2 is refused; 2 is accepted', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org);
        expect(rejection(test, org, updateBody(test, id, { maxParticipants: 1 }))).toBe(TWO_PARTICIPANTS);
        expect(rejection(test, org, updateBody(test, id, { maxParticipants: 0 }))).toBe(TWO_PARTICIPANTS);
        tx(test, org, updateBody(test, id, { maxParticipants: 2 }));
        expect(tRow(test, id).maxParticipants).toBe(2);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// L65: seeding by rating reads the active season
// ════════════════════════════════════════════════════════════════════════════

describe('A122(18), L65: seed_bracket(mmr) reads the captain\'s rating of the active season', () => {
    function field() {
        const s = seedingField(2);
        const [t1, t2] = s.ts; // team ids ascending
        rating(s.test, t1.captain.userId, 2000, 0);
        return { ...s, t1, t2 };
    }
    const seedOf = (test: Harness, teamId: number) => teamRow(test, teamId)!.seedNumber;

    it('A122(18) L65: with an active season, its ratings decide (a higher rating in another season does not count)', () => {
        const f = field();
        const boss = admin(f.test);
        tx(f.test, boss, (ctx) => M.create_season(ctx, { name: 'S1', startDate: f.test.clock.now(), endDate: undefined }));
        const season = [...f.test.db.Season.iter()].find((s) => s.name === 'S1')!;
        tx(f.test, boss, (ctx) => M.set_active_season(ctx, { seasonId: season.id }));
        expect(season.id).not.toBe(0);
        rating(f.test, f.t1.captain.userId, 1000, season.id);
        rating(f.test, f.t2.captain.userId, 1500, season.id);
        seedBracket(f.test, f.org, f.id, 'mmr');
        expect([seedOf(f.test, f.t2.teamId), seedOf(f.test, f.t1.teamId)]).toEqual([1, 2]);
    });

    it('A122(18) L65 (neighbour): with no active season the season-0 rating decides', () => {
        const f = field();
        seedBracket(f.test, f.org, f.id, 'mmr');
        expect([seedOf(f.test, f.t1.teamId), seedOf(f.test, f.t2.teamId)]).toEqual([1, 2]);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// L69: anonymous aliases
// ════════════════════════════════════════════════════════════════════════════

describe('A122(20), L69: an anonymous alias is unique in its tournament (fix pass F1: display names are not compared)', () => {
    function anon() {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { teamSize: 1, isAnonymousDefault: true });
        const a = verified(test, 'alpha');
        register(test, a, id, { anonymousAlias: 'Ghost' });
        return { test, org, id, a };
    }
    const nameOf = (test: Harness, who: Actor) => test.db.User.id.find(who.userId)!.displayName;

    it('A122(20) L69: register_for_tournament refuses an alias another entrant holds (case-insensitive, trimmed)', () => {
        const { test, id } = anon();
        const b = verified(test, 'bravo');
        expect(rejection(test, b, (ctx) => M.register_for_tournament(ctx, { tournamentId: id, anonymousAlias: '  gHOST ' }))).toBe(ALIAS_TAKEN);
        expect(enrolled(test, id, b.userId)).toBeUndefined();
    });

    it('A122(20) L69: set_anonymous_alias refuses an alias another entrant holds', () => {
        const { test, id } = anon();
        const b = verified(test, 'bravo');
        register(test, b, id);
        expect(rejection(test, b, (ctx) => M.set_anonymous_alias(ctx, { tournamentId: id, alias: 'ghost' }))).toBe(ALIAS_TAKEN);
        expect(enrolled(test, id, b.userId).anonymousAlias).toBeUndefined();
    });

    it('A122(20) L69 fix pass F1 (A37): another entrant\'s display name is accepted as an alias, so a refusal never reveals who is enrolled', () => {
        const { test, id, a } = anon();
        const b = verified(test, 'bravo');
        const aName = nameOf(test, a); // read outside the transaction
        register(test, b, id, { anonymousAlias: aName });
        expect(enrolled(test, id, b.userId).anonymousAlias).toBe(aName);
        const c = verified(test, 'charlie');
        register(test, c, id);
        const bName = nameOf(test, b);
        tx(test, c, (ctx) => M.set_anonymous_alias(ctx, { tournamentId: id, alias: bName }));
        expect(enrolled(test, id, c.userId).anonymousAlias).toBe(bName);
    });

    it('A122(20) L69 (neighbour): a free alias, the caller\'s own display name and a case change of the caller\'s own alias are accepted', () => {
        const { test, id, a } = anon();
        const b = verified(test, 'bravo');
        register(test, b, id, { anonymousAlias: nameOf(test, b) });
        expect(enrolled(test, id, b.userId).anonymousAlias).toBe(nameOf(test, b));
        tx(test, b, (ctx) => M.set_anonymous_alias(ctx, { tournamentId: id, alias: 'Shade' }));
        expect(enrolled(test, id, b.userId).anonymousAlias).toBe('Shade');
        tx(test, a, (ctx) => M.set_anonymous_alias(ctx, { tournamentId: id, alias: 'GHOST' }));
        expect(enrolled(test, id, a.userId).anonymousAlias).toBe('GHOST');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Fix pass F7: the floor of 2 participants on create
// ════════════════════════════════════════════════════════════════════════════

describe('A122(17), L64 fix pass F7: create_tournament refuses fewer than 2 participants', () => {
    it('A122(17) L64 F7: create_tournament with maxParticipants 1 or 0 is refused; 2 is accepted', () => {
        const test = newHarness();
        const org = host(test);
        for (const maxParticipants of [0, 1]) {
            expect(rejection(test, org, (ctx) => M.create_tournament(ctx, { ...TOURNAMENT_ARGS, maxParticipants } as any))).toBe(TWO_PARTICIPANTS);
        }
        tx(test, org, (ctx) => M.create_tournament(ctx, { ...TOURNAMENT_ARGS, maxParticipants: 2 } as any));
        expect([...test.db.Tournament.organizer_id.filter(org.userId)].map((t) => t.maxParticipants)).toEqual([2]);
    });
});
