// T-S8a: unit tests for the pure group stage (A32 sizing, A23 round robin, review T7 qualifier placement).
import { describe, expect, it } from 'vitest';
import {
    foldSeeding,
    generateDoubleElim,
    generateSingleElim,
    groupCount,
    groupKey,
    groupSpec,
    meetingRound,
    nextPowerOf2,
    placeQualifiers,
    roundRobin,
    splitIntoGroups,
} from './index';

const ids = (n: number, from = 1) => Array.from({ length: n }, (_, i) => from + i);
const sizes = (groups: number[][]) => groups.map((g) => g.length);

describe('groupCount (A32: groupSize is a minimum, floor split)', () => {
    it('floors the count and never goes below 1', () => {
        expect(groupCount(5, 2)).toBe(2);
        expect(groupCount(7, 3)).toBe(2);
        expect(groupCount(4, 4)).toBe(1);
        expect(groupCount(8, 4)).toBe(2);
        expect(groupCount(3, 4)).toBe(1);
        expect(groupCount(16, 3)).toBe(5);
    });
    it('rejects a non-positive group size', () => {
        expect(() => groupCount(8, 0)).toThrow(/groupSize/);
        expect(() => groupCount(8, 1.5)).toThrow(/groupSize/);
    });
});

describe('splitIntoGroups (A32 snake seeding)', () => {
    it('5 teams / size 2 → groups of 3 and 2', () => {
        const g = splitIntoGroups(ids(5), 2);
        expect(sizes(g)).toEqual([3, 2]);
    });
    it('7 teams / size 3 → groups of 4 and 3', () => {
        const g = splitIntoGroups(ids(7), 3);
        expect(sizes(g).sort()).toEqual([3, 4]);
        expect(g).toEqual([[1, 4, 5], [2, 3, 6, 7]]);   // snake: the 7th seed lands in group 1
    });
    it('4 teams / size 4 → one group', () => {
        expect(splitIntoGroups(ids(4), 4)).toEqual([[1, 2, 3, 4]]);
    });
    it('snake order: 8 teams / size 4 → [[1,4,5,8],[2,3,6,7]]', () => {
        expect(splitIntoGroups(ids(8), 4)).toEqual([[1, 4, 5, 8], [2, 3, 6, 7]]);
    });
    it('snake order over three groups', () => {
        expect(splitIntoGroups(ids(9), 3)).toEqual([[1, 6, 7], [2, 5, 8], [3, 4, 9]]);
    });
    it('keeps the team ids (not the seed numbers)', () => {
        expect(splitIntoGroups([40, 30, 20, 10], 2)).toEqual([[40, 10], [30, 20]]);
    });
    it('for every n in 2..32 and size in 2..6: no group below the size (unless one group), sizes differ by ≤ 1, every team once', () => {
        for (let n = 2; n <= 32; n++) {
            for (let size = 2; size <= 6; size++) {
                const g = splitIntoGroups(ids(n), size);
                expect(g).toHaveLength(groupCount(n, size));
                const s = sizes(g);
                if (g.length > 1) expect(Math.min(...s)).toBeGreaterThanOrEqual(size);
                expect(Math.max(...s) - Math.min(...s)).toBeLessThanOrEqual(1);
                expect(g.flat().sort((a, b) => a - b)).toEqual(ids(n));
            }
        }
    });
});

describe('roundRobin (circle method)', () => {
    for (const n of [2, 3, 4, 5, 6, 7, 8]) {
        it(`${n} teams: every pair exactly once, at most one match per team per round`, () => {
            const teams = ids(n, 11);
            const rounds = roundRobin(teams);
            expect(rounds).toHaveLength(n % 2 === 0 ? n - 1 : n);
            const pairs = new Set<string>();
            for (const round of rounds) {
                const seen = new Set<number>();
                for (const [a, b] of round) {
                    expect(a).not.toBe(b);
                    expect(seen.has(a) || seen.has(b)).toBe(false);
                    seen.add(a); seen.add(b);
                    const key = [a, b].sort((x, y) => x - y).join('-');
                    expect(pairs.has(key)).toBe(false);
                    pairs.add(key);
                }
                // even: everyone plays; odd: exactly one team sits out (the bye)
                expect(seen.size).toBe(n % 2 === 0 ? n : n - 1);
            }
            expect(pairs.size).toBe((n * (n - 1)) / 2);
        });
    }
    it('odd counts: each team gets exactly one bye', () => {
        const teams = ids(5);
        const rounds = roundRobin(teams);
        const byes = new Map<number, number>();
        for (const round of rounds) {
            const playing = new Set(round.flat());
            for (const t of teams) if (!playing.has(t)) byes.set(t, (byes.get(t) ?? 0) + 1);
        }
        expect([...byes.values()]).toEqual([1, 1, 1, 1, 1]);
    });
});

describe('groupSpec', () => {
    it('keys G{g}-R{r}-M{m}, match numbers counted within (group, round)', () => {
        const spec = groupSpec([[1, 2, 3, 4], [5, 6, 7, 8]]);
        expect(spec).toHaveLength(12);
        for (const m of spec) {
            expect(m.key).toBe(groupKey(m.groupIndex, m.round, m.number));
            expect(m.key).toMatch(/^G\d+-R\d+-M\d+$/);
        }
        expect(new Set(spec.map((m) => m.key)).size).toBe(12);
        expect(spec.filter((m) => m.groupIndex === 0 && m.round === 1).map((m) => m.number)).toEqual([1, 2]);
        expect(spec.filter((m) => m.groupIndex === 1 && m.round === 3).map((m) => m.key)).toEqual(['G1-R3-M1', 'G1-R3-M2']);
        // teams stay within their group
        for (const m of spec) {
            const group = m.groupIndex === 0 ? [1, 2, 3, 4] : [5, 6, 7, 8];
            expect(group).toContain(m.team1);
            expect(group).toContain(m.team2);
        }
    });
    it('groupKey format', () => {
        expect(groupKey(0, 1, 1)).toBe('G0-R1-M1');
        expect(groupKey(3, 2, 4)).toBe('G3-R2-M4');
    });
});

describe('meetingRound', () => {
    it('size 8 fold seeding: 1 v 8 meet in round 1, 1 v 4 in round 2, 1 v 2 in round 3', () => {
        expect(meetingRound(1, 8, 8)).toBe(1);
        expect(meetingRound(1, 4, 8)).toBe(2);
        expect(meetingRound(1, 2, 8)).toBe(3);
        expect(meetingRound(3, 6, 8)).toBe(1);
    });
});

/** Round-1 pairs (as team ids, BYE seeds dropped) of a fold-seeded bracket over `teamIdsBySeed`. */
function round1Pairs(teamIdsBySeed: number[]): [number, number][] {
    const size = nextPowerOf2(Math.max(2, teamIdsBySeed.length));
    return foldSeeding(size)
        .filter(([a, b]) => a <= teamIdsBySeed.length && b <= teamIdsBySeed.length)
        .map(([a, b]) => [teamIdsBySeed[a - 1], teamIdsBySeed[b - 1]]);
}

/** groups × advance ranked groups: team id = 100 * (group + 1) + rank (rank 1-based). */
function rankedGroups(groups: number, perGroup: number): number[][] {
    return Array.from({ length: groups }, (_, g) => Array.from({ length: perGroup }, (_, r) => 100 * (g + 1) + r + 1));
}
const groupOf = (teamId: number) => Math.floor(teamId / 100);
const rankOf = (teamId: number) => teamId % 100;

describe('placeQualifiers (review T7)', () => {
    it('4 groups × top 2: no round-1 match pairs two teams of the same group; winners precede runners-up', () => {
        const order = placeQualifiers(rankedGroups(4, 4), 2);
        expect(order).toHaveLength(8);
        expect(order.slice(0, 4)).toEqual([101, 201, 301, 401]);     // winners in group order
        expect(order.slice(4).every((id) => rankOf(id) === 2)).toBe(true);
        for (const [a, b] of round1Pairs(order)) expect(groupOf(a)).not.toBe(groupOf(b));
        // the elimination bracket built over that order is consistent
        const spec = generateSingleElim(order.length);
        expect(spec.teamCount).toBe(8);
        expect(generateDoubleElim(order.length).teamCount).toBe(8);
    });
    it('2 groups × top 2 (a literal reverse order would pair group-mates): no same-group round-1 pairing', () => {
        const order = placeQualifiers(rankedGroups(2, 4), 2);
        for (const [a, b] of round1Pairs(order)) expect(groupOf(a)).not.toBe(groupOf(b));
    });
    it('property: 2..16 groups × 1..3 qualifiers → a permutation, ranks in blocks, winners in group order, no same-group round-1 pairing', () => {
        for (let groups = 2; groups <= 16; groups++) {
            for (let adv = 1; adv <= 3; adv++) {
                const ranked = rankedGroups(groups, 4);
                const order = placeQualifiers(ranked, adv);
                const expected = ranked.flatMap((g) => g.slice(0, adv)).sort((a, b) => a - b);
                expect([...order].sort((a, b) => a - b), `${groups}×${adv}`).toEqual(expected);
                // a better rank always gets a better seed
                for (let i = 1; i < order.length; i++) expect(rankOf(order[i])).toBeGreaterThanOrEqual(rankOf(order[i - 1]));
                expect(order.slice(0, groups)).toEqual(ranked.map((g) => g[0]));
                for (const [a, b] of round1Pairs(order)) {
                    expect(groupOf(a), `${groups}×${adv}: ${a} v ${b}`).not.toBe(groupOf(b));
                }
            }
        }
    });
    it('a group smaller than the advance count contributes what it has', () => {
        const order = placeQualifiers([[101, 102], [201]], 2);
        expect([...order].sort((a, b) => a - b)).toEqual([101, 102, 201]);
        expect(order.slice(0, 2)).toEqual([101, 201]);
    });
    it('rejects a non-positive advance count', () => {
        expect(() => placeQualifiers(rankedGroups(2, 2), 0)).toThrow(/advanceCount/);
    });
});
