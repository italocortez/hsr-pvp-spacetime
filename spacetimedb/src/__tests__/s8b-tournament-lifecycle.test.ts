// T-S8b: in-memory tests for the S8b tournament permission layer (A25), the stage machine (review §5.1, A26, A26a,
// A27–A29, A32, A36a) and admin_cancel_idle_tournaments (A24(6)). Builders in s8-fixtures.ts. T-S8c: the bracket is
// seeded and generated through seed_bracket + generate_bracket, which stamp bracketGeneratedAt and groupId themselves.
import { describe, expect, it } from 'vitest';
import { TOURNAMENT_PERM_MESSAGES } from '../helpers/tournamentPermissions';
import { BEST_OF_ERROR } from '../helpers/seriesSettings';
import { M, advance, expectReject, newHarness, tx, type Actor, type Harness } from './s4-fixtures';
import {
    advanceStage,
    assignAssistant,
    createTournament,
    enrollMany,
    enrolled,
    enrolledAll,
    fullTeams,
    seedAndGenerate,
    host,
    makeTeam,
    membersOf,
    membership,
    moderator,
    openTournament,
    register,
    requestsOf,
    stageOf,
    tRow,
    teamRow,
    teams,
    updateBody,
    verified,
    TOURNAMENT_ARGS,
    type TournamentArgs,
} from './s8-fixtures';

const OWNER = TOURNAMENT_PERM_MESSAGES.owner;
const PARTICIPANTS = TOURNAMENT_PERM_MESSAGES.participants;
const BRACKET = TOURNAMENT_PERM_MESSAGES.bracket;
const RESULTS = TOURNAMENT_PERM_MESSAGES.results;
const DAY_MS = 86_400_000;

/** A tournament in Seeding with four full Ready teams of two and the bracket generated + stamped. */
function seeded(over: Partial<TournamentArgs> = {}) {
    const test = newHarness();
    const org = host(test);
    const id = openTournament(test, org, over);
    const ts = fullTeams(test, id, 4);
    advanceStage(test, org, id, 'Seeding');
    seedAndGenerate(test, org, id);
    return { test, org, id, ts };
}

type Who = 'organizer' | 'moderator' | 'matching' | 'others' | 'plain';
const FLAG_FOR = { participants: 'participants', bracket: 'bracket', results: 'results' } as const;

/** The caller for a matrix row: `matching` holds only `perm`'s flag, `others` every flag but it. */
function actorFor(test: Harness, org: Actor, id: number, who: Who, perm: 'participants' | 'bracket' | 'results' | 'owner'): Actor {
    if (who === 'organizer') return org;
    if (who === 'moderator') return moderator(test);
    if (who === 'plain') return verified(test, 'plain');
    const a = verified(test, `asst-${who}`);
    const all = { participants: true, bracket: true, results: true };
    if (perm === 'owner') {
        assignAssistant(test, org, id, a, all);
    } else if (who === 'matching') {
        assignAssistant(test, org, id, a, { [FLAG_FOR[perm]]: true });
    } else {
        assignAssistant(test, org, id, a, { ...all, [FLAG_FOR[perm]]: false });
    }
    return a;
}

describe('A25 permission matrix', () => {
    const ok: Who[] = ['organizer', 'moderator'];

    it.each([...ok, 'others', 'plain'] as Who[])('update_tournament (owner): %s', (who) => {
        const test = newHarness();
        const org = host(test);
        const id = createTournament(test, org);
        const a = actorFor(test, org, id, who, 'owner');
        const call = () => tx(test, a, updateBody(test, id, { name: `by ${who}` }));
        if (ok.includes(who)) {
            call();
            expect(tRow(test, id).name).toBe(`by ${who}`);
        } else {
            expect(call).toThrow(OWNER); // `others` = an assistant holding all three flags
        }
    });

    it.each([...ok, 'matching', 'others', 'plain'] as Who[])('approve_participant (participants): %s', (who) => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { requireApproval: true });
        const [p] = enrollMany(test, id, 1);
        const a = actorFor(test, org, id, who, 'participants');
        const call = () => tx(test, a, (ctx) => M.approve_participant(ctx, { tournamentId: id, userId: p.userId }));
        if (who === 'others' || who === 'plain') {
            expect(call).toThrow(PARTICIPANTS);
            expect(enrolled(test, id, p.userId).approvedByToAt).toBeUndefined();
        } else {
            call();
            expect(enrolled(test, id, p.userId).approvedByToAt).toBeDefined();
        }
    });

    it.each([...ok, 'matching', 'others', 'plain'] as Who[])('advance_tournament_stage Seeding → InProgress (bracket): %s', (who) => {
        const { test, org, id } = seeded();
        const a = actorFor(test, org, id, who, 'bracket');
        const call = () => advanceStage(test, a, id, 'InProgress');
        if (who === 'others' || who === 'plain') {
            expect(call).toThrow(BRACKET);
            expect(stageOf(test, id)).toBe('Seeding');
        } else {
            call();
            expect(stageOf(test, id)).toBe('InProgress');
        }
    });

    // T-S8c: advance_bracket_match is deleted; resolve_bracket_match is the `results` reducer (full coverage in
    // s8c-bracket-results.test.ts). In Seeding a caller who passes the permission gets the stage error, one who
    // fails it the permission error.
    it.each([...ok, 'matching', 'others', 'plain'] as Who[])('resolve_bracket_match (results) in Seeding: %s', (who) => {
        const { test, org, id } = seeded();
        const m = [...test.db.BracketMatch.tournament_id.filter(id)].find((r) => r.state.tag === 'Ready')!;
        const a = actorFor(test, org, id, who, 'results');
        const msg = who === 'others' || who === 'plain' ? RESULTS : 'Tournament is not in progress.';
        expectReject(test, a, (ctx) => M.resolve_bracket_match(ctx, { bracketMatchId: m.id, winnerTeamId: m.team1Id!, reason: '' }), msg);
    });

    it('organizer-only actions are rejected for an assistant holding every flag', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org);
        fullTeams(test, id, 2);
        const asst = verified(test, 'asst');
        assignAssistant(test, org, id, asst, { participants: true, bracket: true, results: true });
        const other = verified(test, 'other');
        expectReject(test, asst, updateBody(test, id), OWNER);
        expectReject(test, asst, (ctx) => M.advance_tournament_stage(ctx, { tournamentId: id, nextStage: 'Seeding' }), OWNER);
        expectReject(test, asst, (ctx) => M.advance_tournament_stage(ctx, { tournamentId: id, nextStage: 'Cancelled' }), OWNER);
        expectReject(test, asst, (ctx) => M.cancel_tournament(ctx, { tournamentId: id }), OWNER);
        expectReject(test, asst, (ctx) => M.assign_tournament_assistant(ctx, {
            tournamentId: id, userId: other.userId, canManageParticipants: true, canManageBracket: false, canResolveResults: false,
        }), OWNER);
        expectReject(test, asst, (ctx) => M.remove_tournament_assistant(ctx, { tournamentId: id, userId: asst.userId }), OWNER);
        expect(stageOf(test, id)).toBe('Registration');
    });

    it('assign / remove_tournament_assistant: owner only; upsert, self-assignment rejected, a Moderator may manage them', () => {
        const test = newHarness();
        const org = host(test);
        const id = createTournament(test, org);
        const a = verified(test, 'a');
        const plain = verified(test, 'plain');
        const asstRows = () => [...test.db.TournamentAssistant.tournament_id.filter(id)];

        expectReject(test, plain, (ctx) => M.assign_tournament_assistant(ctx, {
            tournamentId: id, userId: a.userId, canManageParticipants: true, canManageBracket: false, canResolveResults: false,
        }), OWNER);
        assignAssistant(test, org, id, a, { participants: true });
        assignAssistant(test, org, id, a, { bracket: true, results: true }); // upsert
        expect(asstRows()).toHaveLength(1);
        expect(asstRows()[0]).toMatchObject({ userId: a.userId, canManageParticipants: false, canManageBracket: true, canResolveResults: true });

        expectReject(test, org, (ctx) => M.assign_tournament_assistant(ctx, {
            tournamentId: id, userId: org.userId, canManageParticipants: true, canManageBracket: true, canResolveResults: true,
        }), 'You cannot assign yourself as a tournament assistant.');

        expectReject(test, plain, (ctx) => M.remove_tournament_assistant(ctx, { tournamentId: id, userId: a.userId }), OWNER);
        const mod = moderator(test);
        tx(test, mod, (ctx) => M.remove_tournament_assistant(ctx, { tournamentId: id, userId: a.userId }));
        expect(asstRows()).toHaveLength(0);
        expectReject(test, org, (ctx) => M.remove_tournament_assistant(ctx, { tournamentId: id, userId: a.userId }),
            'Tournament assistant not found.');
        assignAssistant(test, mod, id, org, { participants: true }); // a Moderator may list the organizer
        expect(asstRows()).toHaveLength(1);
    });

    it('create_tournament needs Tournament Host', () => {
        const test = newHarness();
        const plain = verified(test, 'plain');
        expectReject(test, plain, (ctx) => M.create_tournament(ctx, createArgs() as any), /Requires Tournament Host/);
    });
});

/** create_tournament arguments for a direct reducer call. */
const createArgs = (over: Partial<TournamentArgs> = {}) => ({ ...TOURNAMENT_ARGS, ...over });

describe('settings validation (create_tournament, A27–A29, A32, A36)', () => {
    const cases: Array<[string, Partial<TournamentArgs>, string | RegExp]> = [
        ['A29 third place with double elimination', { format: 'DoubleElimination', has3rdPlaceMatch: true }, 'A third-place match exists only in single elimination.'],
        ['A28 defaultBestOf 5', { defaultBestOf: 5 }, BEST_OF_ERROR],
        ['A28 grandFinalBestOf 5', { grandFinalBestOf: 5, winnerAdvantage: 0 }, BEST_OF_ERROR],
        ['A27 winnerAdvantage 2 with a Bo3 final', { grandFinalBestOf: 3, winnerAdvantage: 2 }, /winnerAdvantage must be less than ceil\(grandFinalBestOf \/ 2\) = 2/],
        ['A27 winnerAdvantage 1 with a Bo1 final', { grandFinalBestOf: 1, winnerAdvantage: 1 }, /winnerAdvantage must be less than ceil\(grandFinalBestOf \/ 2\) = 1/],
        ['A32 groupSize 1 in a group format', { format: 'GroupOnly', groupSize: 1 }, 'groupSize must be at least 2.'],
        ['A36 groupAdvanceCount 3', { format: 'GroupIntoSingleElim', groupAdvanceCount: 3 }, 'groupAdvanceCount must be 1 or 2.'],
        ['teamSize 4', { teamSize: 4 }, 'teamSize must be 1, 2, or 3.'],
        ['an unknown lineupFormat', { lineupFormat: 'Quarters' }, /Invalid lineupFormat/],
    ];
    it.each(cases)('%s is rejected', (_name, over, msg) => {
        const test = newHarness();
        const org = host(test);
        expectReject(test, org, (ctx) => M.create_tournament(ctx, createArgs(over) as any), msg);
        expect([...test.db.Tournament.iter()]).toHaveLength(0);
    });

    it('accepted edges: Bo3 final with winnerAdvantage 1, groupSize 2, groupSize 1 outside group formats', () => {
        const test = newHarness();
        const org = host(test);
        createTournament(test, org, { format: 'DoubleElimination', grandFinalBestOf: 3, winnerAdvantage: 1 });
        createTournament(test, org, { format: 'GroupOnly', groupSize: 2, groupAdvanceCount: 1 });
        createTournament(test, org, { groupSize: 1 });
        expect([...test.db.Tournament.iter()]).toHaveLength(3);
    });

    it('countTowardsMmr forces requireResultValidation on and allowMirrorPicks off (A36, D-42)', () => {
        const test = newHarness();
        const org = host(test);
        const id = createTournament(test, org, { countTowardsMmr: true, requireResultValidation: false, allowMirrorPicks: true });
        expect(tRow(test, id)).toMatchObject({ requireResultValidation: true, allowMirrorPicks: false, lobbyPresetId: expect.any(Number) });
    });

    it('update_tournament: format / teamSize only in Draft; maxParticipants never below the registered count', () => {
        const test = newHarness();
        const org = host(test);
        const id = createTournament(test, org);
        tx(test, org, updateBody(test, id, { format: 'DoubleElimination', teamSize: 3 }));
        expect(tRow(test, id)).toMatchObject({ format: { tag: 'DoubleElimination' }, teamSize: 3 });
        advanceStage(test, org, id, 'Registration');
        expectReject(test, org, updateBody(test, id, { teamSize: 2 }),
            'Format and team size can only change in Draft.');
        enrollMany(test, id, 3);
        expectReject(test, org, updateBody(test, id, { maxParticipants: 2 }),
            'maxParticipants cannot be below the 3 registered participant(s).');
        tx(test, org, updateBody(test, id, { maxParticipants: 3 }));
        expect(tRow(test, id).maxParticipants).toBe(3);
    });
});

describe('stage machine (review §5.1)', () => {
    it('Draft → Registration re-checks the settings on the row (tampered rows rejected)', () => {
        const cases: Array<[Record<string, unknown>, string | RegExp]> = [
            [{ format: { tag: 'DoubleElimination' }, has3rdPlaceMatch: true }, 'A third-place match exists only in single elimination.'],
            [{ costSetId: 404 }, 'Cost set 404 not found.'],
            [{ defaultBestOf: 5 }, BEST_OF_ERROR],
            [{ grandFinalBestOf: 1, winnerAdvantage: 1 }, /winnerAdvantage must be less than/],
            [{ format: { tag: 'GroupOnly' }, groupSize: 1 }, 'groupSize must be at least 2.'],
            [{ format: { tag: 'GroupOnly' }, groupAdvanceCount: 3 }, 'groupAdvanceCount must be 1 or 2.'],
        ];
        for (const [tamper, msg] of cases) {
            const test = newHarness();
            const org = host(test);
            const id = createTournament(test, org);
            test.db.Tournament.id.update({ ...tRow(test, id), ...tamper } as any);
            expectReject(test, org, (ctx) => M.advance_tournament_stage(ctx, { tournamentId: id, nextStage: 'Registration' }), msg);
            expect(stageOf(test, id)).toBe('Draft');
        }
    });

    it('the transitions table: no skipping, no going back', () => {
        const test = newHarness();
        const org = host(test);
        const id = createTournament(test, org);
        expectReject(test, org, (ctx) => M.advance_tournament_stage(ctx, { tournamentId: id, nextStage: 'Seeding' }), /Cannot skip stages/);
        advanceStage(test, org, id, 'Registration');
        expectReject(test, org, (ctx) => M.advance_tournament_stage(ctx, { tournamentId: id, nextStage: 'Draft' }), /forward-only/);
    });

    it('Registration → CheckIn only with checkInEnabled; Registration → Seeding only without it', () => {
        const test = newHarness();
        const org = host(test);
        const off = openTournament(test, org);
        expectReject(test, org, (ctx) => M.advance_tournament_stage(ctx, { tournamentId: off, nextStage: 'CheckIn' }),
            'Check-in is disabled for this tournament: move to Seeding.');
        const on = openTournament(test, org, { checkInEnabled: true });
        fullTeams(test, on, 2);
        expectReject(test, org, (ctx) => M.advance_tournament_stage(ctx, { tournamentId: on, nextStage: 'Seeding' }),
            'Check-in is enabled: move to CheckIn first.');
        advanceStage(test, org, on, 'CheckIn');
        expect(stageOf(test, on)).toBe('CheckIn');
    });

    it('Registration → Seeding with fewer than 2 eligible teams is rejected and rolls back', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org);
        const [{ teamId }] = fullTeams(test, id, 1);
        const [solo] = enrollMany(test, id, 1, 'solo');
        const asker = enrollMany(test, id, 1, 'asker')[0];
        const short = makeTeam(test, id, solo, [], 'short');
        tx(test, asker, (ctx) => M.request_join_team(ctx, { teamId: short }));
        expectReject(test, org, (ctx) => M.advance_tournament_stage(ctx, { tournamentId: id, nextStage: 'Seeding' }),
            'At least 2 eligible teams are needed (1).');
        expect(stageOf(test, id)).toBe('Registration');
        expect(requestsOf(test, asker.userId)).toHaveLength(1); // the request cleanup rolled back too
        expect(teamRow(test, teamId)!.status.tag).toBe('Ready');
    });

    it('Registration → Seeding: requests deleted, random teams formed, eligible teams Ready, the short team stays Forming (A26a)', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { teamSize: 2, requireApproval: true, maxParticipants: 20, waitlistEnabled: true });
        const ts = [1, 2].map((n) => {
            const [captain, mate] = enrollMany(test, id, 2, `t${n}-`);
            for (const p of [captain, mate]) tx(test, org, (ctx) => M.approve_participant(ctx, { tournamentId: id, userId: p.userId }));
            return { captain, mate, teamId: makeTeam(test, id, captain, [mate], `t team ${n}`) };
        });
        // A short team (captain only) with a pending request from a teamless player.
        const [shortCaptain, asker] = enrollMany(test, id, 2, 'short');
        for (const p of [shortCaptain, asker]) tx(test, org, (ctx) => M.approve_participant(ctx, { tournamentId: id, userId: p.userId }));
        const shortTeam = makeTeam(test, id, shortCaptain, [], 'Short');
        tx(test, asker, (ctx) => M.request_join_team(ctx, { teamId: shortTeam }));

        // Random pool: five opted-in approved solos (two teams + one leftover), one opted-in but unapproved, and the asker
        // (opted out). Plus one opted-in waitlisted player.
        const pool = enrollMany(test, id, 5, 'r', { allowRandomTeamAssignment: true });
        for (const p of pool) tx(test, org, (ctx) => M.approve_participant(ctx, { tournamentId: id, userId: p.userId }));
        const [unapproved] = enrollMany(test, id, 1, 'unapproved', { allowRandomTeamAssignment: true });
        const before = new Set(teams(test, id).map((t) => t.id));

        advanceStage(test, org, id, 'Seeding');
        expect(stageOf(test, id)).toBe('Seeding');
        expect(requestsOf(test, asker.userId)).toHaveLength(0);

        const formed = teams(test, id).filter((t) => !before.has(t.id));
        expect(formed).toHaveLength(2);
        const placed = new Set<number>();
        for (const t of formed) {
            expect(t.name).toMatch(/^Team \d+$/);
            expect(t.status.tag).toBe('Ready');
            const ms = membersOf(test, t.id);
            expect(ms).toHaveLength(2);
            expect(ms).toContain(t.captainUserId);
            for (const u of ms) placed.add(u);
        }
        const poolIds = pool.map((p) => p.userId);
        expect([...placed].every((u) => poolIds.includes(u))).toBe(true);
        expect(placed.size).toBe(4);
        const leftover = poolIds.filter((u) => !placed.has(u));
        expect(leftover).toHaveLength(1);
        expect(membership(test, id, leftover[0])).toBeUndefined();
        expect(enrolled(test, id, leftover[0])).toBeDefined(); // leftovers stay enrolled
        expect(membership(test, id, unapproved.userId)).toBeUndefined();
        expect(membership(test, id, asker.userId)).toBeUndefined();

        for (const t of ts) expect(teamRow(test, t.teamId)!.status.tag).toBe('Ready');
        // Addendum: the short team stays Forming with its member enrolled; S8c's generate_bracket withdraws it.
        expect(teamRow(test, shortTeam)!.status.tag).toBe('Forming');
        expect(enrolled(test, id, shortCaptain.userId).status.tag).toBe('Registered');
    });

    it('random formation skips waitlisted players; team names skip the taken "Team <n>"', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { maxParticipants: 6, waitlistEnabled: true });
        const [c1, m1] = enrollMany(test, id, 2, 'a');
        makeTeam(test, id, c1, [m1], 'team 1'); // takes "Team 1" case-insensitively
        const pool = enrollMany(test, id, 3, 'r', { allowRandomTeamAssignment: true });
        enrollMany(test, id, 1, 'optedOut'); // fills the sixth spot
        const [waiting] = enrollMany(test, id, 1, 'w', { allowRandomTeamAssignment: true });
        expect(enrolled(test, id, waiting.userId).isWaitlisted).toBe(true);
        tx(test, waiting, (ctx) => M.withdraw_from_tournament(ctx, { tournamentId: id })); // keeps the spot count honest
        const [waiting2] = enrollMany(test, id, 1, 'w2', { allowRandomTeamAssignment: true });
        expect(enrolled(test, id, waiting2.userId).isWaitlisted).toBe(true);
        advanceStage(test, org, id, 'Seeding');
        // 3 opted-in non-waitlisted players → one random team (4 would have made two if the waitlisted one counted).
        const names = teams(test, id).map((t) => t.name).sort();
        expect(names).toEqual(['Team 2', 'team 1']);
        expect(membership(test, id, waiting2.userId)).toBeUndefined();
        expect(pool.filter((p) => membership(test, id, p.userId))).toHaveLength(2);
    });

    it('CheckIn → Seeding withdraws the teams that did not check in; their members stay enrolled', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { checkInEnabled: true });
        const ts = fullTeams(test, id, 3);
        advanceStage(test, org, id, 'CheckIn');
        tx(test, ts[0].captain, (ctx) => M.check_in_tournament(ctx, { tournamentId: id }));
        tx(test, ts[1].captain, (ctx) => M.check_in_tournament(ctx, { tournamentId: id }));
        advanceStage(test, org, id, 'Seeding');
        expect(teamRow(test, ts[0].teamId)!.status.tag).toBe('Ready');
        expect(teamRow(test, ts[1].teamId)!.status.tag).toBe('Ready');
        expect(teamRow(test, ts[2].teamId)!.status.tag).toBe('Withdrawn');
        expect(membersOf(test, ts[2].teamId)).toHaveLength(2);
        expect(enrolled(test, id, ts[2].mate.userId).status.tag).toBe('Registered');
    });

    it('CheckIn → Seeding with fewer than 2 checked-in teams is rejected', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { checkInEnabled: true });
        const ts = fullTeams(test, id, 2);
        advanceStage(test, org, id, 'CheckIn');
        tx(test, ts[0].captain, (ctx) => M.check_in_tournament(ctx, { tournamentId: id }));
        expectReject(test, org, (ctx) => M.advance_tournament_stage(ctx, { tournamentId: id, nextStage: 'Seeding' }),
            'At least 2 eligible teams are needed (1).');
        expect(teamRow(test, ts[1].teamId)!.status.tag).toBe('Ready');
    });

    it('Seeding → InProgress: rejected before generation and after a later seed change; then Ready → Active, members Active', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org);
        const ts = fullTeams(test, id, 4);
        advanceStage(test, org, id, 'Seeding');
        expectReject(test, org, (ctx) => M.advance_tournament_stage(ctx, { tournamentId: id, nextStage: 'InProgress' }),
            'Generate the bracket first.');
        // T-S8c: generation needs every Ready team seeded; a rejected generation stamps nothing.
        expectReject(test, org, (ctx) => M.generate_bracket(ctx, { tournamentId: id }), 'Seed every Ready team first.');
        expectReject(test, org, (ctx) => M.advance_tournament_stage(ctx, { tournamentId: id, nextStage: 'InProgress' }),
            'Generate the bracket first.');
        seedAndGenerate(test, org, id);
        advance(test, 1_000);
        // a later seed change through the reducer (reversed order) stamps lastSeedChangeAt after bracketGeneratedAt
        tx(test, org, (ctx) => M.set_seed_order(ctx, { tournamentId: id, teamIds: ts.map((t) => t.teamId).reverse() }));
        expectReject(test, org, (ctx) => M.advance_tournament_stage(ctx, { tournamentId: id, nextStage: 'InProgress' }),
            'Seeding changed after the bracket was generated; regenerate it.');
        advance(test, 1_000);
        tx(test, org, (ctx) => M.generate_bracket(ctx, { tournamentId: id })); // regenerate on the new seeds
        advanceStage(test, org, id, 'InProgress');
        expect(stageOf(test, id)).toBe('InProgress');
        for (const t of ts) {
            expect(teamRow(test, t.teamId)!.status.tag).toBe('Active');
            expect(enrolled(test, id, t.captain.userId).status.tag).toBe('Active');
            expect(enrolled(test, id, t.mate.userId).status.tag).toBe('Active');
        }
    });

    it('Seeding → InProgress for a group format needs a groupId on every Ready team', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { format: 'GroupOnly', groupSize: 2, groupAdvanceCount: 1 });
        const ts = fullTeams(test, id, 4);
        advanceStage(test, org, id, 'Seeding');
        seedAndGenerate(test, org, id);
        // T-S8c: generate_bracket writes groupId (A32 split); clearing it on the rows shows the guard still holds.
        ts.forEach((t) => expect(teamRow(test, t.teamId)!.groupId).toBeTypeOf('number'));
        const written = ts.map((t) => teamRow(test, t.teamId)!.groupId);
        ts.forEach((t) => test.db.TournamentTeam.id.update({ ...teamRow(test, t.teamId)!, groupId: undefined }));
        expectReject(test, org, (ctx) => M.advance_tournament_stage(ctx, { tournamentId: id, nextStage: 'InProgress' }),
            '4 Ready team(s) have no group; assign groups and regenerate the bracket.');
        ts.forEach((t, i) => test.db.TournamentTeam.id.update({ ...teamRow(test, t.teamId)!, groupId: written[i] }));
        advanceStage(test, org, id, 'InProgress');
        expect(stageOf(test, id)).toBe('InProgress');
    });

    it('advance_tournament_stage → Cancelled runs the cancel cascade; terminal stages cannot be cancelled', () => {
        const { test, org, id, ts } = seeded();
        const bracketCount = [...test.db.BracketMatch.tournament_id.filter(id)].length;
        advanceStage(test, org, id, 'Cancelled');
        expect(stageOf(test, id)).toBe('Cancelled');
        // T-S8d (A24(5), S8d interpretation 2): the cascade keeps teams and bracket rows (display and the finalize
        // job's bracket order) and starts the finalize job; it no longer deletes them.
        expect(teams(test, id)).toHaveLength(4);
        expect([...test.db.BracketMatch.tournament_id.filter(id)]).toHaveLength(bracketCount);
        expect([...test.db.TournamentFinalizeJob.tournament_id.filter(id)]).toHaveLength(1);
        expect(enrolled(test, id, ts[0].captain.userId)).toBeDefined(); // enrolments kept (audit trail)
        expectReject(test, org, (ctx) => M.cancel_tournament(ctx, { tournamentId: id }),
            'Cannot cancel a tournament that is already Cancelled.');
    });
});

describe('admin_cancel_idle_tournaments (A24(6))', () => {
    it('Moderator+ only; idle beyond the threshold → Cancelled; recent, Draft and terminal ones untouched', () => {
        const test = newHarness();
        const org = host(test);
        const idleReg = openTournament(test, org, { name: 'idle reg' });
        const draft = createTournament(test, org, { name: 'draft' });
        const { id: idleSeeded } = (() => {
            const id = openTournament(test, org, { name: 'idle seeded' });
            fullTeams(test, id, 2, 's');
            advanceStage(test, org, id, 'Seeding');
            return { id };
        })();
        const done = openTournament(test, org, { name: 'done' });
        test.db.Tournament.id.update({ ...tRow(test, done), stage: { tag: 'Completed' } as any });
        advance(test, 8 * DAY_MS);
        const recent = openTournament(test, org, { name: 'recent' });

        const plain = verified(test, 'plain');
        expectReject(test, plain, (ctx) => M.admin_cancel_idle_tournaments(ctx, { idleDays: 7 }), /Moderator/);
        expectReject(test, org, (ctx) => M.admin_cancel_idle_tournaments(ctx, { idleDays: 7 }), /Moderator/);

        const mod = moderator(test);
        expectReject(test, mod, (ctx) => M.admin_cancel_idle_tournaments(ctx, { idleDays: 0 }), 'idleDays must be at least 1.');
        tx(test, mod, (ctx) => M.admin_cancel_idle_tournaments(ctx, { idleDays: 7 }));
        expect(stageOf(test, idleReg)).toBe('Cancelled');
        expect(stageOf(test, idleSeeded)).toBe('Cancelled');
        // T-S8d (A24(5), S8d interpretation 2): teams are kept by the cancel cascade; the finalize job starts.
        expect(teams(test, idleSeeded)).toHaveLength(2);
        expect([...test.db.TournamentFinalizeJob.tournament_id.filter(idleSeeded)]).toHaveLength(1);
        expect(stageOf(test, recent)).toBe('Registration');
        expect(stageOf(test, draft)).toBe('Draft');
        expect(stageOf(test, done)).toBe('Completed');
    });

    it('a tournament touched inside the window is kept (lastModifiedDate, not createdDate)', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org);
        advance(test, 5 * DAY_MS);
        tx(test, org, updateBody(test, id, { name: 'touched' }));
        advance(test, 5 * DAY_MS);
        tx(test, moderator(test), (ctx) => M.admin_cancel_idle_tournaments(ctx, { idleDays: 7 }));
        expect(stageOf(test, id)).toBe('Registration');
        expect(enrolledAll(test, id)).toHaveLength(0);
    });
});

describe('S8b review fixes (stage machine, idle cancel)', () => {
    it('fix 1: Registration → CheckIn closes registration: requests deleted, random teams formed and must check in', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { checkInEnabled: true });
        const ts = fullTeams(test, id, 2);
        const [cap, asker] = enrollMany(test, id, 2, 'short');
        const shortTeam = makeTeam(test, id, cap, [], 'Short');
        tx(test, asker, (ctx) => M.request_join_team(ctx, { teamId: shortTeam }));
        const pool = enrollMany(test, id, 2, 'r', { allowRandomTeamAssignment: true });
        const before = new Set(teams(test, id).map((t) => t.id));

        advanceStage(test, org, id, 'CheckIn');
        expect(requestsOf(test, asker.userId)).toHaveLength(0);
        const formed = teams(test, id).filter((t) => !before.has(t.id));
        expect(formed).toHaveLength(1);
        expect(membersOf(test, formed[0].id)).toEqual(pool.map((p) => p.userId).sort((a, b) => a - b));
        expect(formed[0].status.tag).toBe('Ready');

        // The random team checks in like any team; one that does not is Withdrawn at Seeding.
        const randomCaptain = pool.find((p) => p.userId === formed[0].captainUserId)!;
        tx(test, randomCaptain, (ctx) => M.check_in_tournament(ctx, { tournamentId: id }));
        tx(test, ts[0].captain, (ctx) => M.check_in_tournament(ctx, { tournamentId: id }));
        advanceStage(test, org, id, 'Seeding');
        expect(teamRow(test, formed[0].id)!.status.tag).toBe('Ready');
        expect(teamRow(test, ts[0].teamId)!.status.tag).toBe('Ready');
        expect(teamRow(test, ts[1].teamId)!.status.tag).toBe('Withdrawn');
        expect(teamRow(test, shortTeam)!.status.tag).toBe('Withdrawn'); // not checked in either
    });

    it('fix 4: an InProgress tournament whose bracket matches were touched recently is not idle', () => {
        const build = () => {
            const s = seeded();
            advanceStage(s.test, s.org, s.id, 'InProgress');
            return s;
        };
        const busy = build();
        advance(busy.test, 8 * DAY_MS);
        const m = [...busy.test.db.BracketMatch.tournament_id.filter(busy.id)][0];
        busy.test.db.BracketMatch.id.update({ ...m, lastModifiedDate: busy.test.clock.now() });
        tx(busy.test, moderator(busy.test), (ctx) => M.admin_cancel_idle_tournaments(ctx, { idleDays: 7 }));
        expect(stageOf(busy.test, busy.id)).toBe('InProgress');

        const quiet = build();
        advance(quiet.test, 8 * DAY_MS);
        tx(quiet.test, moderator(quiet.test), (ctx) => M.admin_cancel_idle_tournaments(ctx, { idleDays: 7 }));
        expect(stageOf(quiet.test, quiet.id)).toBe('Cancelled');
    });
});
