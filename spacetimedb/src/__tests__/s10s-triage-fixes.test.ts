// T-S10s: in-memory tests for step S10s (DECISIONS.md A121 and A122 rules 4, 16 to 22; triage rows L63, L64, L65, L66,
// L69, L70, L71, L86, L87, L93 of notes/audit-2026-11-09/low-findings-triage.md). Each item has a test of the new rule
// and one that the neighbouring allowed case still works. State is built through the module's reducers; roles, HSR
// accounts, rating rows, an invite row and a stand-in's join lock are written straight into the in-memory datastore
// outside any reducer, like the earlier suites. `test.db` is read only outside `tx` bodies. TestClock; nothing reaches
// maincloud. The script items (L99, L100, L101) are unit-tested under test/backend/scripts/ and shared/.
import { describe, expect, it } from 'vitest';
import {
    M,
    advance,
    guest,
    newHarness,
    now,
    priceBanNames,
    priceCharacters,
    session,
    setupLobby,
    steps,
    tx,
    type Actor,
    type Harness,
    type Lobby,
} from './s4-fixtures';
import { captain } from './s7-fixtures';
import {
    AUDIT,
    TOURNAMENT_ARGS,
    advanceStage,
    assignAssistant,
    bracketRows,
    enrolled,
    enrollMany,
    insertHsrAccount,
    host,
    locks,
    membership,
    openTournament,
    register,
    resolveMatch,
    seedAndGenerate,
    seedBracket,
    seedingField,
    setUserRole,
    tRow,
    teamRow,
    updateBody,
    verified,
} from './s8-fixtures';
import { byKey, createTournamentLobby, duel, join, playMatch } from './s8d-fixtures';
import {
    DAY_MS,
    HOUR_MS,
    addSlot,
    clearMembershipCount,
    createAccount,
    createEvent,
    fromNow,
    invite,
    rejection,
    slotsOf,
} from './s10-c2-fixtures';
import { fireDeletionJob, providerOf } from './s10-c1-fixtures';

// ─── Texts ───────────────────────────────────────────────────────────────────

const RATE_TEXT = 'You are doing that too quickly. Please wait a moment.';
const DEADLINE_PAST = 'registrationDeadline must be in the future.';
const DEADLINE_NOT_NUMBER = 'registrationDeadline must be a date in microseconds since the epoch (digits only), or empty.';
const START_NOT_NUMBER = 'scheduledStartAt must be a date in microseconds since the epoch (digits only), or empty.';
const TWO_PARTICIPANTS = 'maxParticipants must be at least 2.';
const STANDIN_STAGE = 'Stand-ins can only be approved while the tournament is in progress.';
const STANDIN_DQ_TEAM = 'A disqualified team cannot get a stand-in.';
const ALIAS_TAKEN = 'That alias is already taken in this tournament. Choose another.';

const STAFF_VIEWS = [
    'view_my_tournaments',
    'view_my_tournament_enrolled',
    'view_my_tournament_teams',
    'view_my_tournament_team_members',
    'view_my_tournament_matches',
    'view_my_tournament_match_results',
    'view_my_tournament_lobbies',
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function admin(test: Harness, name = 'boss'): Actor {
    const a = verified(test, name);
    setUserRole(test, a.userId, 'Admin');
    return a;
}

const viewAs = <T = any>(test: Harness, name: string, who: Actor, args: Record<string, unknown> = {}): T[] =>
    (M as any)[name](test.viewContext(who.auth), args) as T[];

const assistantsOf = (test: Harness, tournamentId: number) =>
    [...test.db.TournamentAssistant.tournament_id.filter(tournamentId)].map((a) => a.userId).sort((a, b) => a - b);
const standInsOf = (test: Harness, bracketMatchId: number) => [...test.db.TournamentStandIn.bracket_match_id.filter(bracketMatchId)];
const approveBody = (bracketMatchId: number, teamId: number, userId: number) =>
    (ctx: any) => M.approve_stand_in(ctx, { bracketMatchId, teamId, userId });

/** admin_delete_row('User') by `boss` and the scheduled run_user_deletion fired by hand. */
function adminDelete(test: Harness, boss: Actor, who: Actor) {
    tx(test, boss, (ctx) => M.admin_delete_row(ctx, { tableName: 'User', primaryKeyJson: String(who.userId) }));
    fireDeletionJob(test, who.userId);
}

/** admin_ban_user on the user's Discord id by `by` (an Admin, or 'internal' = the SYSTEM user) and the deletion job. */
function ban(test: Harness, by: Actor | 'internal', who: Actor) {
    const providerId = providerOf(test, who)!;
    tx(test, by, (ctx) => M.admin_ban_user(ctx, { banTypeTag: 'DiscordId', providerId, reason: 'test' }));
    fireDeletionJob(test, who.userId);
}

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
// L66: stand-in approvals end with the tournament; approve needs a running tournament
// ════════════════════════════════════════════════════════════════════════════

describe('A122(19), L66: stand-in approvals and their locks end with the tournament; approval needs InProgress and a team not disqualified', () => {
    it('A122(19) L66: approve_stand_in is refused before InProgress (Seeding, bracket generated)', () => {
        const s = seedingField(2);
        seedAndGenerate(s.test, s.org, s.id);
        const m = bracketRows(s.test, s.id)[0];
        const sub = verified(s.test, 'sub');
        expect(rejection(s.test, s.org, approveBody(m.id, m.team1Id!, sub.userId))).toBe(STANDIN_STAGE);
        expect(standInsOf(s.test, m.id)).toEqual([]);
    });

    it('A122(19) L66: approve_stand_in is refused for a disqualified team; the other team of the match still gets one', () => {
        const f = duel();
        const m = byKey(f.test, f.id, 'W-R1-M1');
        const dqTeam = f.ts.find((t) => t.teamId === m.team1Id)!;
        tx(f.test, f.org, (ctx) => M.dq_participant(ctx, { tournamentId: f.id, userId: dqTeam.captain.userId, reason: 'x', dqWholeTeam: true }));
        expect(teamRow(f.test, dqTeam.teamId)!.status.tag).toBe('Disqualified');
        const sub = verified(f.test, 'sub');
        expect(rejection(f.test, f.org, approveBody(m.id, m.team1Id!, sub.userId))).toBe(STANDIN_DQ_TEAM);
        tx(f.test, f.org, approveBody(m.id, m.team2Id!, sub.userId));
        expect(standInsOf(f.test, m.id).map((r) => r.userId)).toEqual([sub.userId]);
    });

    it('A122(19) L66: cancelling deletes the approval and the locks the stand-in got when joining the match lobby', () => {
        const f = duel();
        const m = byKey(f.test, f.id, 'W-R1-M1');
        const sub = verified(f.test, 'sub');
        insertHsrAccount(f.test, sub.userId, 'sub-main');
        tx(f.test, f.org, approveBody(m.id, m.team1Id!, sub.userId));
        const lobbyId = createTournamentLobby(f.test, f.org, m.id);
        join(f.test, sub, lobbyId);
        expect(locks(f.test, f.id, sub.userId)).toHaveLength(1);
        expect(viewAs(f.test, 'view_my_stand_ins', sub)).toHaveLength(1);

        tx(f.test, f.org, (ctx) => M.cancel_tournament(ctx, { tournamentId: f.id }));
        expect(standInsOf(f.test, m.id)).toEqual([]);
        expect(locks(f.test, f.id, sub.userId)).toEqual([]);
        expect(viewAs(f.test, 'view_my_stand_ins', sub)).toEqual([]);
    });

    it('A122(19) L66: completing deletes the approval and the stand-in\'s locks; an enrolled player\'s locks stay (neighbour)', () => {
        const f = duel();
        const m = byKey(f.test, f.id, 'W-R1-M1');
        const sub = verified(f.test, 'sub');
        const subAcct = insertHsrAccount(f.test, sub.userId, 'sub-main');
        tx(f.test, f.org, approveBody(m.id, m.team1Id!, sub.userId));
        // the lock a stand-in's lobby join writes (lobbyLifecycle D-26), and an enrolled player's registration lock
        f.test.db.TournamentPlayerAccount.insert({ tournamentId: f.id, userId: sub.userId, hsrAccountId: subAcct, ...AUDIT(f.test) });
        const player = f.ts[0].captain;
        const playerAcct = insertHsrAccount(f.test, player.userId, 'player-main');
        f.test.db.TournamentPlayerAccount.insert({ tournamentId: f.id, userId: player.userId, hsrAccountId: playerAcct, ...AUDIT(f.test) });

        resolveMatch(f.test, f.org, m.id, m.team1Id!);
        advanceStage(f.test, f.org, f.id, 'Completed');
        expect(standInsOf(f.test, m.id)).toEqual([]);
        expect(locks(f.test, f.id, sub.userId)).toEqual([]);
        expect(locks(f.test, f.id, player.userId)).toEqual([playerAcct]);
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

        adminDelete(test, boss, org);
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

        adminDelete(test, boss, org);
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
// L86: every calendar reducer runs the clean-up
// ════════════════════════════════════════════════════════════════════════════

describe('A122(22), L86: every calendar action cleans the caller\'s old events and expired slots', () => {
    it('A122(22) L86: save_calendar deletes the caller\'s event ended over 90 days ago; a newer event and another user\'s old event stay', () => {
        const test = newHarness();
        const u = verified(test, 'cal');
        const other = verified(test, 'other');
        const old = createEvent(test, u, { startMs: HOUR_MS, endMs: 2 * HOUR_MS });
        const othersOld = createEvent(test, other, { startMs: HOUR_MS, endMs: 2 * HOUR_MS });
        advance(test, 85 * DAY_MS);
        const recent = createEvent(test, u, { startMs: HOUR_MS, endMs: 2 * HOUR_MS });
        advance(test, 6 * DAY_MS); // old ended 91 days ago, recent 6 days ago
        expect(test.db.CalendarEvent.id.find(old)).toBeTruthy();

        tx(test, u, (ctx) => M.save_calendar(ctx, { targetUserId: other.userId }));
        expect(test.db.CalendarEvent.id.find(old)).toBeFalsy();
        expect(test.db.CalendarEvent.id.find(recent)).toBeTruthy();
        expect(test.db.CalendarEvent.id.find(othersOld)).toBeTruthy();
    });

    it('A122(22) L86: save_calendar deletes the caller\'s slot expired over a week ago; a slot expired 6 days ago stays', () => {
        const test = newHarness();
        const u = verified(test, 'cal');
        const other = verified(test, 'other');
        const old = addSlot(test, u, { startMs: HOUR_MS, endMs: 2 * HOUR_MS });
        advance(test, DAY_MS);
        const recent = addSlot(test, u, { startMs: HOUR_MS, endMs: 2 * HOUR_MS });
        advance(test, 6 * DAY_MS + 12 * HOUR_MS); // old expired ~7.4 days ago, recent ~6.4 days ago
        expect(slotsOf(test, u).map((s) => s.id).sort()).toEqual([old, recent].sort());

        tx(test, u, (ctx) => M.save_calendar(ctx, { targetUserId: other.userId }));
        expect(slotsOf(test, u).map((s) => s.id)).toEqual([recent]);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// L87: the calendar view skips finished tournaments
// ════════════════════════════════════════════════════════════════════════════

describe('A122(22), L87: view_my_calendar_events skips tournaments that are Completed or Cancelled', () => {
    it('A122(22) L87: a match event reached only through the player\'s team shows while the tournament runs and not once it is Completed', () => {
        const f = duel();
        const { test, org } = f;
        const m = byKey(test, f.id, 'W-R1-M1');
        const eventId = createEvent(test, org, { bracketMatchId: m.id });
        const player = f.ts.find((t) => t.teamId === m.team1Id)!.captain;
        test.db.CalendarEventInvite.delete(invite(test, eventId, player.userId)); // reach it through the team path only
        const ids = () => viewAs<{ id: number }>(test, 'view_my_calendar_events', player).map((r) => r.id);
        expect(ids()).toContain(eventId); // neighbour: a running tournament's match event shows

        playMatch(f, m.id, 'Blue'); // a played decision keeps the event (a staff resolve deletes it, D-22)
        advanceStage(test, org, f.id, 'Completed');
        expect(test.db.CalendarEvent.id.find(eventId)).toBeTruthy(); // the event still exists
        expect(ids()).not.toContain(eventId);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// L93: calendar and roster writes use the per-user allowance
// ════════════════════════════════════════════════════════════════════════════

describe('A122(4), L93: calendar and roster writes count on the per-user allowance (20 calls per 10 s)', () => {
    it('A122(4) L93: the 21st calendar call inside 10 s is refused with the neutral text; after the window it is accepted', () => {
        const test = newHarness();
        const u = verified(test, 'cal');
        const other = verified(test, 'other');
        tx(test, u, (ctx) => M.save_calendar(ctx, { targetUserId: other.userId }));
        clearMembershipCount(test, u);
        const toggle = (isVisible: boolean) => (ctx: any) => M.toggle_calendar_visibility(ctx, { targetUserId: other.userId, isVisible });
        for (let i = 0; i < 20; i++) tx(test, u, toggle(i % 2 === 0));
        expect(rejection(test, u, toggle(true))).toBe(RATE_TEXT);
        advance(test, 10_001);
        tx(test, u, toggle(true));
        expect([...test.db.SavedCalendar.by_user_and_target.filter([u.userId, other.userId])][0].isVisible).toBe(true);
    });

    it('A122(4) L93: the 21st roster write inside 10 s is refused with the neutral text; after the window it is accepted', () => {
        const test = newHarness();
        const u = verified(test, 'roster');
        const acct = createAccount(test, u, '800000001', 'Main');
        clearMembershipCount(test, u);
        const rename = (label: string) => (ctx: any) =>
            M.update_hsr_account(ctx, { hsrAccountId: acct, displayLabel: label, isRosterPublic: true, isRatingPublic: true });
        for (let i = 0; i < 20; i++) tx(test, u, rename(`Main ${i}`));
        expect(rejection(test, u, rename('Blocked'))).toBe(RATE_TEXT);
        expect(test.db.HsrAccount.id.find(acct)!.displayLabel).toBe('Main 19');
        advance(test, 10_001);
        tx(test, u, rename('Later'));
        expect(test.db.HsrAccount.id.find(acct)!.displayLabel).toBe('Later');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Fix pass F2 / F11: the clean-up spares the call's own target
// ════════════════════════════════════════════════════════════════════════════

describe('A122(22), L86 fix pass F2: a user still edits or deletes their own old event or expired slot', () => {
    it('A122(22) L86 F2: delete_calendar_event on the caller\'s event ended 91 days ago succeeds and the row is gone', () => {
        const test = newHarness();
        const u = verified(test, 'cal');
        const old = createEvent(test, u, { startMs: HOUR_MS, endMs: 2 * HOUR_MS });
        advance(test, 91 * DAY_MS);
        tx(test, u, (ctx) => M.delete_calendar_event(ctx, { eventId: old }));
        expect(test.db.CalendarEvent.id.find(old)).toBeFalsy();
    });

    it('A122(22) L86 F2: update_calendar_event of that old event\'s title succeeds (A79: endAt unchanged); another old event of the caller is cleaned', () => {
        const test = newHarness();
        const u = verified(test, 'cal');
        const old = createEvent(test, u, { startMs: HOUR_MS, endMs: 2 * HOUR_MS });
        const other = createEvent(test, u, { startMs: HOUR_MS, endMs: 2 * HOUR_MS });
        const row = test.db.CalendarEvent.id.find(old)!;
        advance(test, 91 * DAY_MS);
        tx(test, u, (ctx) => M.update_calendar_event(ctx, {
            eventId: old, title: 'Renamed', description: '',
            startAt: row.startAt.microsSinceUnixEpoch.toString(), endAt: row.endAt.microsSinceUnixEpoch.toString(),
        }));
        expect(test.db.CalendarEvent.id.find(old)!.title).toBe('Renamed');
        expect(test.db.CalendarEvent.id.find(other)).toBeFalsy();
    });

    it('A122(22) L86 F2: delete_availability_slot on the caller\'s slot expired 9 days ago succeeds and the row is gone', () => {
        const test = newHarness();
        const u = verified(test, 'cal');
        const old = addSlot(test, u, { startMs: HOUR_MS, endMs: 2 * HOUR_MS });
        advance(test, 9 * DAY_MS);
        tx(test, u, (ctx) => M.delete_availability_slot(ctx, { slotId: old }));
        expect(slotsOf(test, u)).toEqual([]);
    });

    it('A122(4) L93 F11: the allowance is counted before the clean-up: a refused call deletes nothing', () => {
        const test = newHarness();
        const u = verified(test, 'cal');
        const other = verified(test, 'other');
        const old = createEvent(test, u, { startMs: HOUR_MS, endMs: 2 * HOUR_MS });
        advance(test, 91 * DAY_MS);
        const row = test.db.UserRateState.userId.find(u.userId)!;
        test.db.UserRateState.userId.update({ ...row, membershipWindowStart: test.clock.now(), membershipCount: 20 });
        expect(rejection(test, u, (ctx) => M.save_calendar(ctx, { targetUserId: other.userId }))).toBe(RATE_TEXT);
        expect(test.db.CalendarEvent.id.find(old)).toBeTruthy();
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
// A125: in Auction the undo window stays open until the first bid
// ════════════════════════════════════════════════════════════════════════════

describe('A125: in Auction the undo cancels an open first nomination until the first bid or sale', () => {
    const AUCTION_FOUR = { draftMode: { tag: 'Auction' }, banMode: { tag: 'Four' } };
    const TURN_MS = 30_000; // DEFAULT_LOBBY_ARGS.standardTurnSeconds
    const undoBody = (s: Lobby) => (ctx: any) => M.undo_last_step(ctx, { lobbyId: s.lobbyId });
    const turnTeam = (s: Lobby) => {
        const sess = session(s.test, s.lobbyId);
        return sess.draftSequence[sess.turnIndex].teamTurn.tag as 'Blue' | 'Red';
    };
    /** Auction lobby with its four bans done (auction phase open, no nomination). */
    function auctionReady(): Lobby {
        const test = newHarness();
        const s = setupLobby(test, { lobby: AUCTION_FOUR });
        for (const name of ['ban-a', 'ban-b', 'ban-c', 'ban-d']) {
            tx(test, captain(s, turnTeam(s)), (ctx) => {
                priceBanNames(ctx, s.lobbyId, [name]);
                return M.ban_character(ctx, { lobbyId: s.lobbyId, characterName: name });
            });
        }
        expect(session(test, s.lobbyId)).toMatchObject({ isAuctionPhase: true, turnIndex: 4 });
        return s;
    }
    const nominatorOf = (s: Lobby) => session(s.test, s.lobbyId).nextNominatorTeam.tag as 'Blue' | 'Red';
    const otherSide = (side: 'Blue' | 'Red') => (side === 'Blue' ? 'Red' : 'Blue');
    function nominate(s: Lobby, name: string) {
        tx(s.test, captain(s, nominatorOf(s)), (ctx) => {
            priceCharacters(ctx, s.lobbyId, [name]);
            return M.nominate_character(ctx, { lobbyId: s.lobbyId, characterName: name });
        });
    }
    const stepsOf = (s: Lobby, tag: string) => steps(s.test, s.lobbyId).filter((x) => x.action.tag === tag);
    /** The session fields a nomination may write, plus the budgets and won counts that must not move. */
    const snapshot = (s: Lobby) => {
        const x = session(s.test, s.lobbyId);
        return {
            currentNomination: x.currentNomination, currentBidAmount: x.currentBidAmount, currentBidTeam: x.currentBidTeam.tag,
            nextNominatorTeam: x.nextNominatorTeam.tag, turnIndex: x.turnIndex, isAuctionPhase: x.isAuctionPhase,
            blue: x.teamBlueCharBudget, red: x.teamRedCharBudget, blueLc: x.teamBlueLcBudget, redLc: x.teamRedLcBudget,
            blueWon: x.blueCharactersWon, redWon: x.redCharactersWon,
        };
    };

    it('A125: a first undo cancels a manual nomination (state restored exactly, Undo row, fresh timer for the nominator); a second undo removes the last ban', () => {
        const s = auctionReady();
        const before = snapshot(s);
        const nominator = nominatorOf(s);
        nominate(s, 'nominee');
        const nom = stepsOf(s, 'Nominate')[0];
        expect(session(s.test, s.lobbyId).currentNomination).toBe('nominee');

        advance(s.test, 5_000);
        tx(s.test, s.host, undoBody(s));
        expect(snapshot(s)).toEqual(before);
        expect(nominatorOf(s)).toBe(nominator);
        const sess = session(s.test, s.lobbyId);
        expect([sess.timerState.turnStartAt.microsSinceUnixEpoch, sess.timerState.accumulatedPauseMs]).toEqual([now(s.test), 0]);
        expect(stepsOf(s, 'Nominate')).toEqual([]);
        expect((stepsOf(s, 'Undo')[0].payload.value as any).originalSequenceId).toBe(nom.sequence);

        tx(s.test, s.host, undoBody(s));
        expect(session(s.test, s.lobbyId)).toMatchObject({ isAuctionPhase: false, turnIndex: 3 });
        expect(stepsOf(s, 'Ban')).toHaveLength(3);
        expect(stepsOf(s, 'Undo')).toHaveLength(2);
    });

    it('A125: the timer\'s automatic EMPTY nomination (a Nominate step by actor 0, the turn not passed) is cancelled the same way', () => {
        const s = auctionReady();
        const before = snapshot(s);
        advance(s.test, TURN_MS + 1_000);
        tx(s.test, captain(s, 'Blue'), (ctx) => M.timer_expiry_auction(ctx, { lobbyId: s.lobbyId }));
        const nom = stepsOf(s, 'Nominate')[0];
        expect([nom.actorUserId, (nom.payload.value as any).characterName]).toEqual([0, 'EMPTY']);
        expect(session(s.test, s.lobbyId)).toMatchObject({ currentNomination: 'EMPTY', nextNominatorTeam: { tag: before.nextNominatorTeam } });

        tx(s.test, s.host, undoBody(s));
        expect(snapshot(s)).toEqual(before);
        expect(stepsOf(s, 'Nominate')).toEqual([]);
    });

    it('A125: after the undo the nominator nominates again normally', () => {
        const s = auctionReady();
        nominate(s, 'first-pick');
        tx(s.test, s.host, undoBody(s));
        nominate(s, 'second-pick');
        expect(session(s.test, s.lobbyId)).toMatchObject({ currentNomination: 'second-pick' });
        expect(stepsOf(s, 'Nominate')).toHaveLength(1);
    });

    it('A125: once a bid exists the undo is refused with the existing text and nothing changes', () => {
        const s = auctionReady();
        const nominator = nominatorOf(s);
        nominate(s, 'nominee');
        tx(s.test, captain(s, otherSide(nominator)), (ctx) => M.place_bid(ctx, { lobbyId: s.lobbyId, bidAmount: 5 }));
        const before = snapshot(s);
        expect(rejection(s.test, s.host, undoBody(s))).toBe('Undo is not available during the auction phase.');
        expect(snapshot(s)).toEqual(before);
        expect(stepsOf(s, 'Nominate')).toHaveLength(1);
    });

    it('A125: once a sale exists the undo is refused, also with a new nomination open', () => {
        const s = auctionReady();
        const nominator = nominatorOf(s);
        nominate(s, 'nominee');
        tx(s.test, captain(s, otherSide(nominator)), (ctx) => M.pass_bid(ctx, { lobbyId: s.lobbyId }));
        expect(stepsOf(s, 'AuctionSold')).toHaveLength(1);
        expect(rejection(s.test, s.host, undoBody(s))).toBe('Undo is not available during the auction phase.');
        nominate(s, 'next');
        expect(rejection(s.test, s.host, undoBody(s))).toBe('Undo is not available during the auction phase.');
        expect(stepsOf(s, 'Nominate')).toHaveLength(2);
    });
});
