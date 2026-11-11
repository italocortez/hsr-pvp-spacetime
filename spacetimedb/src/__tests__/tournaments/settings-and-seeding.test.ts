// Tournaments: waitlist promotion during Seeding, update_tournament after the deadline, at least 2 participants,
//   MMR seeding of the active season, unique aliases.
// Decisions: A122
// Contracts: docs/tournament/contract.md, docs/brackets/contract.md
// From S10s (s10s-triage-fixes.test.ts).
import { describe, expect, it } from 'vitest';
import { M, advance, newHarness, tx, type Actor, type Harness } from '../fixtures/harness';
import {
    AUDIT,
    TOURNAMENT_ARGS,
    advanceStage,
    bracketRows,
    enrollMany,
    enrolled,
    host,
    membership,
    openTournament,
    register,
    seedAndGenerate,
    seedBracket,
    seedingField,
    tRow,
    teamRow,
    updateBody,
    verified,
} from '../fixtures/tournament-builders';
import { DAY_MS, HOUR_MS, fromNow, rejection } from '../fixtures/calendar-roster-rating-builders';
import { admin } from '../fixtures/tournament-admin-views';

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
