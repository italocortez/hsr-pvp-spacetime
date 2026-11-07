// T-S8c: in-memory tests for the S8c seeding, generation and group-advancement reducers (A23, A26, A26a, A29, A30,
// A32, A36a, review §5.4 / T7 / T20): seed_bracket, set_seed_order, generate_bracket, advance_group_stage, and the
// removal of the legacy advancement reducers. Builders in s8-fixtures.ts; rating and stand-in rows are inserted
// directly, like the S8a / S8b tests. Nothing reaches maincloud.
import { describe, expect, it } from 'vitest';
import {
    classifyMatches,
    generateDoubleElim,
    generateSingleElim,
    placeQualifiers,
    splitIntoGroups,
    type BracketSpec,
} from '@shared/bracket';
import { TOURNAMENT_PERM_MESSAGES } from '../helpers/tournamentPermissions';
import { M, advance, expectReject, tx, type Harness } from './s4-fixtures';
import {
    AUDIT,
    advanceStage,
    assignAssistant,
    bracketByKey,
    bracketRows,
    enrolled,
    generateBracket,
    liveField,
    matchRow,
    membersOf,
    openTournament,
    host,
    resolveMatch,
    seedAndGenerate,
    seedBracket,
    seedingField,
    tRow,
    teamRow,
    teams,
    verified,
    fullTeams,
} from './s8-fixtures';

const BRACKET = TOURNAMENT_PERM_MESSAGES.bracket;

const seedOf = (test: Harness, teamId: number) => teamRow(test, teamId)!.seedNumber;
/** Team ids by seedNumber, over the teams that hold a seed. */
const bySeed = (test: Harness, tournamentId: number) =>
    teams(test, tournamentId).filter((t) => t.seedNumber !== undefined).sort((a, b) => a.seedNumber! - b.seedNumber!).map((t) => t.id);

function insertRating(test: Harness, userId: number, rating: number) {
    test.db.MmrRating.insert({
        userId,
        gameMode: { tag: 'MemoryOfChaos' } as any,
        rating,
        matchesPlayed: 1,
        globalCompositeRating: undefined,
        seasonId: 0,
        ...AUDIT(test),
    });
}

/** The rows match the spec one to one: keys, sides, rounds, routes, seeded slots and the BYE settlement (S8a). */
function checkAgainstSpec(test: Harness, rows: any[], spec: BracketSpec, teamIdsBySeed: number[]) {
    expect(rows).toHaveLength(spec.matches.length);
    const map = new Map(rows.map((r) => [r.positionKey, r]));
    const kinds = classifyMatches(spec);
    for (const m of spec.matches) {
        const row = map.get(m.key);
        expect(row, m.key).toBeDefined();
        expect(row.bracketSide.tag, m.key).toBe(m.side);
        expect(row.roundNumber, m.key).toBe(m.round);
        expect(row.matchNumber, m.key).toBe(m.number);
        expect(row.groupId, m.key).toBeUndefined();
        if (m.winnerTo) {
            expect(matchRow(test, row.nextWinnerMatchId).positionKey, m.key).toBe(m.winnerTo.key);
            expect(row.nextWinnerSlot, m.key).toBe(m.winnerTo.slot);
        } else {
            expect(row.nextWinnerMatchId, m.key).toBeUndefined();
        }
        if (m.loserTo) {
            expect(matchRow(test, row.nextLoserMatchId).positionKey, m.key).toBe(m.loserTo.key);
            expect(row.nextLoserSlot, m.key).toBe(m.loserTo.slot);
        } else {
            expect(row.nextLoserMatchId, m.key).toBeUndefined();
        }
        m.sources.forEach((src, i) => {
            if (src.kind !== 'seed') return;
            const id = i === 0 ? row.team1Id : row.team2Id;
            const bye = i === 0 ? row.team1IsBye : row.team2IsBye;
            if (src.seed <= spec.teamCount) expect(id, `${m.key} slot ${i + 1}`).toBe(teamIdsBySeed[src.seed - 1]);
            else expect(bye, `${m.key} slot ${i + 1}`).toBe(true);
        });
        const kind = kinds.get(m.key)!;
        if (kind === 'void') expect(row.state.tag, m.key).toBe('Void');
        else if (kind === 'walkover') expect(['Walkover', 'Pending'], m.key).toContain(row.state.tag);
        else expect(['Ready', 'Pending'], m.key).toContain(row.state.tag);
        expect(row.winnerAdvantage, m.key).toBe(m.winnerAdvantage);
    }
}

// ─── Seeding ──────────────────────────────────────────────────────────────────

describe('seed_bracket (A23, A25 bracket, A26 Ready only, C-a7)', () => {
    it('bracket permission: plain and a results-only assistant rejected; a bracket assistant seeds', () => {
        const { test, org, id } = seedingField(3);
        const plain = verified(test, 'plain');
        expectReject(test, plain, (ctx) => M.seed_bracket(ctx, { tournamentId: id, mode: 'mmr' }), BRACKET);
        const resultsOnly = verified(test, 'res');
        assignAssistant(test, org, id, resultsOnly, { participants: true, results: true });
        expectReject(test, resultsOnly, (ctx) => M.seed_bracket(ctx, { tournamentId: id, mode: 'mmr' }), BRACKET);
        expect(tRow(test, id).lastSeedChangeAt).toBeUndefined();
        const asst = verified(test, 'asst');
        assignAssistant(test, org, id, asst, { bracket: true });
        seedBracket(test, asst, id);
        expect(bySeed(test, id)).toHaveLength(3);
    });

    it('Seeding only; an unknown mode is rejected', () => {
        const test = seedingField(2).test;
        const org = host(test, 'org2');
        const reg = openTournament(test, org);
        fullTeams(test, reg, 2, 'r');
        expectReject(test, org, (ctx) => M.seed_bracket(ctx, { tournamentId: reg, mode: 'mmr' }), 'Tournament is not in Seeding.');
        advanceStage(test, org, reg, 'Seeding');
        expectReject(test, org, (ctx) => M.seed_bracket(ctx, { tournamentId: reg, mode: 'elo' }), 'Seeding mode must be "mmr" or "random".');
        seedAndGenerate(test, org, reg);
        advanceStage(test, org, reg, 'InProgress');
        expectReject(test, org, (ctx) => M.seed_bracket(ctx, { tournamentId: reg, mode: 'mmr' }), 'Tournament is not in Seeding.');
    });

    it("'mmr': captains' rating for the default game mode, highest first, unrated 0, ties by team id; stamps lastSeedChangeAt", () => {
        const { test, org, id, ts } = seedingField(4);
        insertRating(test, ts[2].captain.userId, 2000);
        insertRating(test, ts[0].captain.userId, 1500);
        insertRating(test, ts[3].mate.userId, 9999); // a non-captain's rating does not count
        advance(test, 1_000);
        seedBracket(test, org, id, 'mmr');
        expect(bySeed(test, id)).toEqual([ts[2].teamId, ts[0].teamId, ts[1].teamId, ts[3].teamId]);
        expect(tRow(test, id).lastSeedChangeAt!.microsSinceUnixEpoch).toBe(test.clock.now().microsSinceUnixEpoch);
    });

    it("'random': seeds 1..n, each once, Ready teams only (a Forming team stays unseeded)", () => {
        const { test, org, id, ts: all } = seedingField(6);
        dq(test, org, id, all[5].mate.userId); // A26: Ready → Forming below teamSize
        const shortTeam = all[5].teamId;
        const ts = all.slice(0, 5);
        seedBracket(test, org, id, 'random');
        expect(ts.map((t) => seedOf(test, t.teamId)).sort()).toEqual([1, 2, 3, 4, 5]);
        expect(seedOf(test, shortTeam)).toBeUndefined();
        expect(tRow(test, id).lastSeedChangeAt).toBeDefined();
    });
});

describe('set_seed_order (replaces swap_seeds)', () => {
    it('exactly the Ready teams, each once; order applied; lastSeedChangeAt re-stamped; bracket permission', () => {
        const { test, org, id, ts: all } = seedingField(5);
        // the fifth team drops below teamSize in Seeding (A26: Ready → Forming)
        dq(test, org, id, all[4].mate.userId);
        const forming = all[4].teamId;
        expect(teamRow(test, forming)!.status.tag).toBe('Forming');
        const ts = all.slice(0, 4);
        const ids = ts.map((t) => t.teamId);
        const order = (teamIds: number[]) => (ctx: any) => M.set_seed_order(ctx, { tournamentId: id, teamIds });
        expectReject(test, org, order([ids[0], ids[0], ids[1], ids[2]]), 'A team appears twice in the seed order.');
        expectReject(test, org, order(ids.slice(0, 3)), 'The seed order must list every Ready team exactly once.');
        expectReject(test, org, order([...ids.slice(0, 3), 9999]), 'The seed order must list every Ready team exactly once.');
        expectReject(test, org, order([...ids.slice(0, 3), forming]), 'The seed order must list every Ready team exactly once.');
        expectReject(test, org, order([...ids, forming]), 'The seed order must list every Ready team exactly once.');
        expectReject(test, verified(test, 'plain'), order(ids), BRACKET);
        expect(ids.map((t) => seedOf(test, t))).toEqual([undefined, undefined, undefined, undefined]);
        expect(tRow(test, id).lastSeedChangeAt).toBeUndefined();

        const wanted = [ids[3], ids[1], ids[0], ids[2]];
        tx(test, org, order(wanted));
        expect(bySeed(test, id)).toEqual(wanted);
        const first = tRow(test, id).lastSeedChangeAt!.microsSinceUnixEpoch;
        advance(test, 1_000);
        tx(test, org, order([...wanted].reverse()));
        expect(bySeed(test, id)).toEqual([...wanted].reverse());
        expect(tRow(test, id).lastSeedChangeAt!.microsSinceUnixEpoch > first).toBe(true);
        expect(seedOf(test, forming)).toBeUndefined();
    });
});

// ─── Generation ───────────────────────────────────────────────────────────────

describe('generate_bracket: preconditions (A26a, A25)', () => {
    it('Withdraws the teams still Forming (members stay enrolled and on the team); they get no bracket slot', () => {
        const { test, org, id, ts: all } = seedingField(3);
        dq(test, org, id, all[2].mate.userId); // A26: Ready → Forming below teamSize
        const shortTeam = all[2].teamId;
        const shortCap = all[2].captain;
        const ts = all.slice(0, 2);
        expect(teamRow(test, shortTeam)!.status.tag).toBe('Forming');
        seedAndGenerate(test, org, id);
        expect(teamRow(test, shortTeam)!.status.tag).toBe('Withdrawn');
        expect(membersOf(test, shortTeam)).toEqual([shortCap.userId]);
        expect(enrolled(test, id, shortCap.userId).status.tag).toBe('Registered');
        expect(bracketRows(test, id).some((r) => r.team1Id === shortTeam || r.team2Id === shortTeam)).toBe(false);
        for (const t of ts) expect(teamRow(test, t.teamId)!.status.tag).toBe('Ready');
    });

    it('fewer than 2 Ready teams: rejected, nothing written (the Withdraw rolls back too)', () => {
        const { test, org, id, ts } = seedingField(2);
        tx(test, org, (ctx) => M.dq_participant(ctx, { tournamentId: id, userId: ts[1].mate.userId, reason: 'test' }));
        expect(teamRow(test, ts[1].teamId)!.status.tag).toBe('Forming'); // A26: below teamSize before the bracket
        seedBracket(test, org, id);
        expectReject(test, org, (ctx) => M.generate_bracket(ctx, { tournamentId: id }), 'At least 2 Ready teams are needed.');
        expect(teamRow(test, ts[1].teamId)!.status.tag).toBe('Forming');
        expect(bracketRows(test, id)).toHaveLength(0);
        expect(tRow(test, id).bracketGeneratedAt).toBeUndefined();
    });

    it('an unseeded Ready team is rejected (none seeded; one Ready after seeding); duplicate seeds rejected', () => {
        const { test, org, id, ts } = seedingField(2);
        expectReject(test, org, (ctx) => M.generate_bracket(ctx, { tournamentId: id }), 'Seed every Ready team first.');
        seedBracket(test, org, id);
        // a team that becomes Ready after seeding is unseeded
        const [cap, mate] = [addParticipant(test, org, id, 'late1'), addParticipant(test, org, id, 'late2')];
        const lateTeam = makeTeamSeeding(test, org, id, cap, mate);
        expect(seedOf(test, lateTeam)).toBeUndefined();
        expectReject(test, org, (ctx) => M.generate_bracket(ctx, { tournamentId: id }), 'Seed every Ready team first.');
        test.db.TournamentTeam.id.update({ ...teamRow(test, lateTeam)!, seedNumber: 1 }); // no reducer writes a duplicate
        expectReject(test, org, (ctx) => M.generate_bracket(ctx, { tournamentId: id }), 'Seed numbers must be unique.');
        expect(bracketRows(test, id)).toHaveLength(0);
        expect(seedOf(test, ts[0].teamId)).toBe(1);
    });

    it('bracket permission and Seeding stage', () => {
        const { test, org, id } = seedingField(2);
        seedBracket(test, org, id);
        expectReject(test, verified(test, 'plain'), (ctx) => M.generate_bracket(ctx, { tournamentId: id }), BRACKET);
        const asst = verified(test, 'asst');
        assignAssistant(test, org, id, asst, { participants: true, results: true });
        expectReject(test, asst, (ctx) => M.generate_bracket(ctx, { tournamentId: id }), BRACKET);
        const b = verified(test, 'b');
        assignAssistant(test, org, id, b, { bracket: true });
        generateBracket(test, b, id);
        advanceStage(test, org, id, 'InProgress');
        expectReject(test, org, (ctx) => M.generate_bracket(ctx, { tournamentId: id }), 'Tournament is not in Seeding.');
    });
});

const dq = (test: Harness, by: any, tournamentId: number, userId: number, dqWholeTeam = false) =>
    tx(test, by, (ctx) => M.dq_participant(ctx, { tournamentId, userId, reason: 'test', dqWholeTeam }));

/** A verified player enrolled by staff (add_participant: Seeding before generation is allowed). */
function addParticipant(test: Harness, org: any, tournamentId: number, name: string) {
    const p = verified(test, name);
    tx(test, org, (ctx) => M.add_participant(ctx, { tournamentId, userId: p.userId }));
    return p;
}

/** Two more enrolled players formed into a Ready team in Seeding (participants permission: add_team_member). */
function makeTeamSeeding(test: Harness, org: any, tournamentId: number, cap: any, mate: any): number {
    const teamId = test.db.TournamentTeam.insert({
        id: 0, tournamentId, name: 'late', captainUserId: cap.userId, status: { tag: 'Forming' } as any,
        seedNumber: undefined, groupId: undefined, finalPlacement: undefined, ...AUDIT(test),
    }).id;
    test.db.TournamentTeamMember.insert({ teamId, userId: cap.userId, tournamentId, ...AUDIT(test) } as any);
    tx(test, org, (ctx) => M.add_team_member(ctx, { teamId, userId: mate.userId }));
    expect(teamRow(test, teamId)!.status.tag).toBe('Ready');
    return teamId;
}

describe('generate_bracket: elimination formats (rows and FK wiring as S8a, A27, A29)', () => {
    it('single elimination, 5 teams with the third-place match', () => {
        const { test, org, id } = seedingField(5, { has3rdPlaceMatch: true });
        seedAndGenerate(test, org, id);
        const order = bySeed(test, id);
        expect(order.map((t) => seedOf(test, t))).toEqual([1, 2, 3, 4, 5]);
        checkAgainstSpec(test, bracketRows(test, id), generateSingleElim(5, { thirdPlace: true }), order);
        expect(bracketByKey(test, id).get('TP')).toBeDefined();
        for (const r of bracketRows(test, id)) expect(r.bestOf).toBe(tRow(test, id).defaultBestOf);
    });

    for (const n of [4, 6, 16]) {
        it(`double elimination, ${n} teams (GF winnerAdvantage, grandFinalBestOf)`, () => {
            const { test, org, id } = seedingField(n, { format: 'DoubleElimination', winnerAdvantage: 1 });
            seedAndGenerate(test, org, id);
            const spec = generateDoubleElim(n, { winnerAdvantage: 1 });
            checkAgainstSpec(test, bracketRows(test, id), spec, bySeed(test, id));
            const gf = bracketByKey(test, id).get('GF')!;
            expect(gf.winnerAdvantage).toBe(1);
            expect(gf.bestOf).toBe(tRow(test, id).grandFinalBestOf);
            expect(bracketRows(test, id).some((r) => r.bracketSide.tag === 'ThirdPlace')).toBe(false);
        });
    }

    it('stamps bracketGeneratedAt; Seeding → InProgress passes through the real reducers', () => {
        const { test, org, id, ts } = seedingField(4);
        seedBracket(test, org, id);
        advance(test, 1_000);
        generateBracket(test, org, id);
        expect(tRow(test, id).bracketGeneratedAt!.microsSinceUnixEpoch).toBe(test.clock.now().microsSinceUnixEpoch);
        advanceStage(test, org, id, 'InProgress');
        for (const t of ts) expect(teamRow(test, t.teamId)!.status.tag).toBe('Active');
    });

    it('regeneration deletes the old rows and their stand-ins (T20) and follows the new seed order', () => {
        const { test, org, id, ts } = seedingField(4);
        seedAndGenerate(test, org, id);
        const oldIds = bracketRows(test, id).map((r) => r.id);
        const firstStamp = tRow(test, id).bracketGeneratedAt!.microsSinceUnixEpoch;
        const m = bracketRows(test, id).find((r) => r.state.tag === 'Ready')!;
        const sub = verified(test, 'sub');
        test.db.TournamentStandIn.insert({
            id: 0, bracketMatchId: m.id, teamId: m.team1Id!, userId: sub.userId, approvedByUserId: org.userId, ...AUDIT(test),
        } as any);
        expect([...test.db.TournamentStandIn.bracket_match_id.filter(m.id)]).toHaveLength(1);

        advance(test, 1_000);
        const reversed = ts.map((t) => t.teamId).reverse();
        tx(test, org, (ctx) => M.set_seed_order(ctx, { tournamentId: id, teamIds: reversed }));
        advance(test, 1_000);
        generateBracket(test, org, id);
        for (const old of oldIds) expect(test.db.BracketMatch.id.find(old)).toBeFalsy();
        expect([...test.db.TournamentStandIn.bracket_match_id.filter(m.id)]).toHaveLength(0);
        expect([...test.db.TournamentStandIn.iter()]).toHaveLength(0);
        checkAgainstSpec(test, bracketRows(test, id), generateSingleElim(4, { thirdPlace: false }), reversed);
        expect(tRow(test, id).bracketGeneratedAt!.microsSinceUnixEpoch > firstStamp).toBe(true);
        advanceStage(test, org, id, 'InProgress');
    });
});

describe('generate_bracket: group formats (A32 auto split, A36a manual groups, review T7)', () => {
    it('GroupIntoSingleElim, auto: snake split by seed, groupId written, round-robin rows only (no elimination rows)', () => {
        const { test, org, id } = seedingField(8, { format: 'GroupIntoSingleElim', groupSize: 4, groupAdvanceCount: 2 });
        seedAndGenerate(test, org, id);
        const order = bySeed(test, id);
        const groups = splitIntoGroups(order, 4);
        const rows = bracketRows(test, id);
        expect(rows).toHaveLength(12);
        for (const r of rows) {
            expect(r.bracketSide.tag).toBe('Group');
            expect(r.state.tag).toBe('Ready');
            expect(groups[r.groupId!]).toContain(r.team1Id);
            expect(groups[r.groupId!]).toContain(r.team2Id);
        }
        groups.forEach((g, gi) => g.forEach((t) => expect(teamRow(test, t)!.groupId).toBe(gi)));
        advanceStage(test, org, id, 'InProgress');
    });

    it('GroupOnly, auto: 5 teams / groupSize 2 → groups of 3 and 2', () => {
        const { test, org, id } = seedingField(5, { format: 'GroupOnly', groupSize: 2, groupAdvanceCount: 1 });
        seedAndGenerate(test, org, id);
        const rows = bracketRows(test, id);
        expect(rows).toHaveLength(3 + 1);
        expect(rows.every((r) => r.bracketSide.tag === 'Group')).toBe(true);
        const sizes = [0, 1].map((g) => teams(test, id).filter((t) => t.groupId === g).length).sort();
        expect(sizes).toEqual([2, 3]);
    });

    function manualField(n: number, groupSize: number) {
        const s = seedingField(n, { format: 'GroupIntoSingleElim', groupAssignmentMode: 'Manual', groupSize, groupAdvanceCount: 1 });
        seedBracket(s.test, s.org, s.id);
        const assign = (groupIds: number[]) => s.ts.forEach((t, i) =>
            tx(s.test, s.org, (ctx) => M.assign_team_group(ctx, { tournamentId: s.id, teamId: t.teamId, groupIndex: groupIds[i] })));
        const gen = (ctx: any) => M.generate_bracket(ctx, { tournamentId: s.id });
        return { ...s, assign, gen };
    }

    it('manual: a Ready team without a group is rejected', () => {
        const { test, org, ts, assign, gen } = manualField(4, 2);
        expectReject(test, org, gen, `Team "t team 1" has no group.`);
        assign([0, 1, 1, 0]);
        test.db.TournamentTeam.id.update({ ...teamRow(test, ts[2].teamId)!, groupId: undefined });
        expectReject(test, org, gen, `Team "t team 3" has no group.`);
    });

    it('manual: an undersized group, a group index beyond groupCount and uneven sizes are rejected; nothing written', () => {
        const a = manualField(4, 2);
        a.assign([0, 0, 0, 1]);
        expectReject(a.test, a.org, a.gen, 'Every group needs at least 2 teams.');
        a.assign([0, 1, 1, 0]);
        a.test.db.TournamentTeam.id.update({ ...teamRow(a.test, a.ts[3].teamId)!, groupId: 2 }); // assign_team_group refuses it
        expectReject(a.test, a.org, a.gen, 'Team "t team 4" is in group 2; only 2 groups exist.');
        expect(bracketRows(a.test, a.id)).toHaveLength(0);
        expect(teamRow(a.test, a.ts[0].teamId)!.groupId).toBe(0); // rejected generation clears nothing

        const b = manualField(8, 3); // groupCount(8, 3) = 2
        b.assign([0, 0, 0, 0, 0, 1, 1, 1]);
        expectReject(b.test, b.org, b.gen, 'Group sizes may differ by one team at most.');
        expect(bracketRows(b.test, b.id)).toHaveLength(0);
    });

    it('manual: fewer Ready teams than groupSize → one group holding every team is accepted (as the auto split)', () => {
        const { test, org, id, ts } = seedingField(3, { format: 'GroupIntoSingleElim', groupAssignmentMode: 'Manual', groupSize: 4, groupAdvanceCount: 2 });
        seedBracket(test, org, id);
        for (const t of ts) tx(test, org, (ctx) => M.assign_team_group(ctx, { tournamentId: id, teamId: t.teamId, groupIndex: 0 }));
        generateBracket(test, org, id);
        const rows = bracketRows(test, id);
        expect(rows).toHaveLength(3);
        expect(rows.every((r) => r.bracketSide.tag === 'Group' && r.groupId === 0)).toBe(true);
        expect(ts.map((t) => teamRow(test, t.teamId)!.groupId)).toEqual([0, 0, 0]);
        // with enough teams for two groups an undersized group is still rejected (see the test above: [0, 0, 0, 1])
    });

    it('manual: a valid assignment is used as given (not the snake split)', () => {
        const { test, org, id, ts, assign, gen } = manualField(4, 2);
        assign([0, 0, 1, 1]); // the snake split would be [0, 1, 1, 0]
        tx(test, org, gen);
        const rows = bracketRows(test, id);
        expect(rows).toHaveLength(2);
        const pair = (g: number) => rows.filter((r) => r.groupId === g).map((r) => [r.team1Id, r.team2Id].sort());
        expect(pair(0)).toEqual([[ts[0].teamId, ts[1].teamId].sort()]);
        expect(pair(1)).toEqual([[ts[2].teamId, ts[3].teamId].sort()]);
        expect(ts.map((t) => teamRow(test, t.teamId)!.groupId)).toEqual([0, 0, 1, 1]);
        expect(rows.every((r) => r.bracketSide.tag === 'Group')).toBe(true);
        advanceStage(test, org, id, 'InProgress');
    });
});

// ─── Group advancement ────────────────────────────────────────────────────────

describe('advance_group_stage (A23, A26 status gate, A30, review T7 / T11)', () => {
    /** 8 teams, groupSize 4, 2 advance; InProgress with the group matches open. */
    function groups(format: 'GroupIntoSingleElim' | 'GroupIntoDoubleElim' = 'GroupIntoSingleElim') {
        const s = liveField(8, { format, groupSize: 4, groupAdvanceCount: 2 });
        const advanceGroups = (ctx: any) => M.advance_group_stage(ctx, { tournamentId: s.id });
        /** Decides every open group match for the lower team id through resolve_bracket_match. */
        const decideAll = (except = 0) => {
            const open = bracketRows(s.test, s.id).filter((r) => r.state.tag === 'Ready').sort((a, b) => a.id - b.id);
            for (const r of open.slice(0, open.length - except)) resolveMatch(s.test, s.org, r.id, Math.min(r.team1Id!, r.team2Id!));
        };
        /** Group members ranked by id (the lower id wins every match). */
        const ranked = () => [0, 1].map((g) => teams(s.test, s.id).filter((t) => t.groupId === g).map((t) => t.id).sort((a, b) => a - b));
        return { ...s, advanceGroups, decideAll, ranked };
    }

    it('rejected while a group match is open; then the elimination bracket over the qualifiers; non-qualifiers Eliminated', () => {
        const g = groups();
        const { test, org, id } = g;
        expectReject(test, org, g.advanceGroups, '12 group match(es) are not settled.');
        g.decideAll(1);
        expectReject(test, org, g.advanceGroups, '1 group match(es) are not settled.');
        g.decideAll();
        const groupRows = bracketRows(test, id);
        for (const r of groupRows) expect(r.decidedBy?.tag).toBe('Staff');

        expectReject(test, verified(test, 'plain'), g.advanceGroups, BRACKET);
        tx(test, org, g.advanceGroups);
        const ranked = g.ranked();
        const qualifiers = placeQualifiers(ranked, 2);
        const elim = bracketRows(test, id).filter((r) => r.bracketSide.tag !== 'Group');
        checkAgainstSpec(test, elim, generateSingleElim(4, { thirdPlace: false }), qualifiers);
        // the group rows are untouched
        expect(bracketRows(test, id).filter((r) => r.bracketSide.tag === 'Group')).toEqual(groupRows);
        for (const q of qualifiers) expect(teamRow(test, q)!.status.tag).toBe('Active');
        for (const out of ranked.flatMap((r) => r.slice(2))) expect(teamRow(test, out)!.status.tag).toBe('Eliminated');

        // a second call: the elimination rows exist
        expectReject(test, org, g.advanceGroups, 'The elimination bracket already exists.');
    });

    it('GroupIntoDoubleElim: the double-elimination bracket over the 4 qualifiers', () => {
        const g = groups('GroupIntoDoubleElim');
        g.decideAll();
        tx(g.test, g.org, g.advanceGroups);
        const elim = bracketRows(g.test, g.id).filter((r) => r.bracketSide.tag !== 'Group');
        checkAgainstSpec(g.test, elim, generateDoubleElim(4, { winnerAdvantage: tRow(g.test, g.id).winnerAdvantage }), placeQualifiers(g.ranked(), 2));
    });

    it('status gate (A26): a disqualified group winner does not qualify; the next-ranked team takes its place', () => {
        const g = groups();
        const { test, org, id } = g;
        g.decideAll();
        const ranked = g.ranked();
        const winner0 = ranked[0][0];
        const cap = teamRow(test, winner0)!.captainUserId;
        tx(test, org, (ctx) => M.dq_participant(ctx, { tournamentId: id, userId: cap, reason: 'test', dqWholeTeam: true }));
        tx(test, org, g.advanceGroups);
        const expected = placeQualifiers([ranked[0].slice(1), ranked[1]], 2);
        const elim = bracketRows(test, id).filter((r) => r.bracketSide.tag !== 'Group');
        checkAgainstSpec(test, elim, generateSingleElim(4, { thirdPlace: false }), expected);
        expect(teamRow(test, winner0)!.status.tag).toBe('Disqualified'); // not overwritten with Eliminated
    });

    it('GroupOnly and the elimination formats are rejected', () => {
        const only = liveField(4, { format: 'GroupOnly', groupSize: 2, groupAdvanceCount: 1 });
        expectReject(only.test, only.org, (ctx) => M.advance_group_stage(ctx, { tournamentId: only.id }),
            'A group-only tournament has no elimination stage.');
        const se = liveField(4);
        expectReject(se.test, se.org, (ctx) => M.advance_group_stage(ctx, { tournamentId: se.id }), 'This tournament has no group stage.');
    });

    it('Seeding: rejected (InProgress only)', () => {
        const { test, org, id } = seedingField(8, { format: 'GroupIntoSingleElim', groupSize: 4, groupAdvanceCount: 2 });
        seedAndGenerate(test, org, id);
        expectReject(test, org, (ctx) => M.advance_group_stage(ctx, { tournamentId: id }), 'Tournament is not in progress.');
    });
});

// ─── Surface ──────────────────────────────────────────────────────────────────

describe('module surface (A23)', () => {
    it('the legacy advancement reducers are gone; the S8c reducers are exported', () => {
        for (const gone of ['submit_and_advance_bracket', 'advance_bracket_match', 'admin_set_bracket_winner', 'swap_seeds', 'advance_group_to_elimination']) {
            expect(gone in M, gone).toBe(false);
        }
        for (const name of ['seed_bracket', 'set_seed_order', 'generate_bracket', 'advance_group_stage', 'resolve_bracket_match', 'rollback_bracket_match', 'dq_participant']) {
            expect(typeof (M as any)[name], name).not.toBe('undefined');
        }
    });
});
