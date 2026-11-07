// T-S8a: unit tests for the A30 group ranking (wins → head-to-head only for an exact two-way tie → game
// differential → seed) and the comparator the web standings table shares with the server.
import { describe, expect, it } from 'vitest';
import { compareGroupTeams, groupTeamStats, rankGroup, type DecidedGroupMatch, type GroupTeam } from './index';

/** A decided match: `w` beat `l` with the given series score (winner's games first). */
const won = (w: number, l: number, wg = 2, lg = 0, flip = false): DecidedGroupMatch =>
    flip
        ? { team1Id: l, team2Id: w, winnerTeamId: w, team1Games: lg, team2Games: wg }
        : { team1Id: w, team2Id: l, winnerTeamId: w, team1Games: wg, team2Games: lg };

const teams = (...seeds: [number, number][]): GroupTeam[] => seeds.map(([teamId, seedNumber]) => ({ teamId, seedNumber }));
const order = (matches: DecidedGroupMatch[], ts: GroupTeam[]) => rankGroup(matches, ts).map((r) => r.teamId);

describe('rankGroup (A30)', () => {
    it('wins decide first', () => {
        const ts = teams([1, 4], [2, 3], [3, 2], [4, 1]);
        const ms = [won(1, 2), won(1, 3), won(1, 4), won(2, 3), won(2, 4), won(3, 4)];
        const r = rankGroup(ms, ts);
        expect(r.map((x) => x.teamId)).toEqual([1, 2, 3, 4]);
        expect(r.map((x) => x.rank)).toEqual([1, 2, 3, 4]);
        expect(r.map((x) => x.wins)).toEqual([3, 2, 1, 0]);
        expect(r[0].gameDiff).toBe(6);
        expect(r[3].gameDiff).toBe(-6);
    });

    it('exactly two teams tied on wins → head-to-head, even against a better game differential and seed', () => {
        // 1 and 2 both have 2 wins; 2 beat 1 narrowly but 1 has the bigger differential and the better seed
        const ts = teams([1, 1], [2, 2], [3, 3], [4, 4]);
        const ms = [won(2, 1, 2, 1), won(1, 3, 2, 0), won(1, 4, 2, 0), won(2, 3, 2, 1), won(4, 2, 2, 1), won(3, 4, 2, 0)];
        const stats = groupTeamStats(ms, ts);
        const s1 = stats.find((s) => s.teamId === 1)!;
        const s2 = stats.find((s) => s.teamId === 2)!;
        expect(s1.wins).toBe(2);
        expect(s2.wins).toBe(2);
        expect(s1.gameDiff).toBeGreaterThan(s2.gameDiff);
        expect(order(ms, ts).slice(0, 2)).toEqual([2, 1]);
    });

    it('three-way tie on wins skips head-to-head and uses game differential', () => {
        // 1 > 2 > 3 > 1 cycle, each also beats 4; differentials 3 > 1 > 2 by margins
        const ts = teams([1, 3], [2, 2], [3, 1], [4, 4]);
        const ms = [
            won(1, 2, 2, 0), // 1: +2, 2: -2
            won(2, 3, 2, 1), // 2: +1, 3: -1
            won(3, 1, 2, 1), // 3: +1, 1: -1
            won(1, 4, 2, 1), // 1: +1
            won(2, 4, 2, 0), // 2: +2
            won(3, 4, 2, 0), // 3: +2
        ];
        const stats = groupTeamStats(ms, ts);
        expect(stats.filter((s) => s.wins === 2).map((s) => s.teamId).sort()).toEqual([1, 2, 3]);
        // diffs: 1 = +2 -1 +1 = 2; 2 = -2 +1 +2 = 1; 3 = -1 +1 +2 = 2 → 1 and 3 tie on diff, seed: 3 (seed 1) first
        expect(stats.find((s) => s.teamId === 1)!.gameDiff).toBe(2);
        expect(stats.find((s) => s.teamId === 2)!.gameDiff).toBe(1);
        expect(stats.find((s) => s.teamId === 3)!.gameDiff).toBe(2);
        expect(order(ms, ts)).toEqual([3, 1, 2, 4]);
    });

    it('three-way tie: head-to-head is ignored even where it would contradict the differential', () => {
        // 1 beat 3 head-to-head, but 3 has the better differential → 3 above 1
        const ts = teams([1, 1], [2, 2], [3, 3], [4, 4]);
        const ms = [
            won(1, 3, 2, 1), // 1 +1, 3 -1
            won(3, 2, 2, 0), // 3 +2, 2 -2
            won(2, 1, 2, 0), // 2 +2, 1 -2
            won(1, 4, 2, 1), // 1 +1
            won(2, 4, 2, 1), // 2 +1
            won(3, 4, 2, 0), // 3 +2
        ];
        // diffs: 1 = 0, 2 = +1, 3 = +3
        expect(order(ms, ts)).toEqual([3, 2, 1, 4]);
    });

    it('differential tie (no head-to-head played) → seed', () => {
        const ts = teams([1, 5], [2, 2]);
        expect(order([], ts)).toEqual([2, 1]);
        const ts3 = teams([7, 3], [8, 1], [9, 2]);
        expect(order([], ts3)).toEqual([8, 9, 7]);
    });

    it('a two-way tie without a played head-to-head falls through to differential, then seed', () => {
        const ts = teams([1, 2], [2, 1], [3, 3]);
        // 1 and 2 both have 1 win and never met; 3 lost both
        const ms = [won(1, 3, 2, 0), won(2, 3, 2, 1)];
        expect(order(ms, ts)).toEqual([1, 2, 3]);
        const msEq = [won(1, 3, 2, 1), won(2, 3, 2, 1)];
        expect(order(msEq, ts)).toEqual([2, 1, 3]);   // equal diff → seed 1 (team 2) first
    });

    it('a team without matches is still ranked (0 wins, 0 diff); matches with outsiders are ignored', () => {
        const ts = teams([1, 1], [2, 2], [3, 3]);
        const ms = [won(2, 1), won(1, 99, 2, 0)];
        const r = rankGroup(ms, ts);
        expect(r.map((x) => x.teamId)).toEqual([2, 3, 1]);   // 1 and 3 tied on 0 wins, never met: diff 0 > -2
        expect(r.find((x) => x.teamId === 3)).toMatchObject({ wins: 0, gameDiff: 0 });
        expect(r.find((x) => x.teamId === 1)).toMatchObject({ wins: 0, gameDiff: -2 });
    });

    it('team1 / team2 orientation does not change the stats', () => {
        const ts = teams([1, 1], [2, 2]);
        const a = groupTeamStats([won(2, 1, 2, 1)], ts);
        const b = groupTeamStats([won(2, 1, 2, 1, true)], ts);
        expect(a).toEqual(b);
    });
});

describe('compareGroupTeams is a consistent comparator', () => {
    const fixtures: [DecidedGroupMatch[], GroupTeam[]][] = [
        [[won(1, 2), won(1, 3), won(1, 4), won(2, 3), won(2, 4), won(3, 4)], teams([1, 4], [2, 3], [3, 2], [4, 1])],
        [[won(2, 1, 2, 1), won(1, 3), won(1, 4), won(2, 3, 2, 1), won(4, 2, 2, 1), won(3, 4)], teams([1, 1], [2, 2], [3, 3], [4, 4])],
        [[won(1, 2), won(2, 3, 2, 1), won(3, 1, 2, 1), won(1, 4, 2, 1), won(2, 4), won(3, 4)], teams([1, 3], [2, 2], [3, 1], [4, 4])],
        [[], teams([7, 3], [8, 1], [9, 2])],
    ];
    it('antisymmetric, irreflexive and transitive on the fixtures; sorting agrees with rankGroup', () => {
        for (const [ms, ts] of fixtures) {
            const all = groupTeamStats(ms, ts);
            for (const a of all) {
                expect(compareGroupTeams(a, a, ms, all)).toBe(0);
                for (const b of all) {
                    if (a === b) continue;
                    const ab = compareGroupTeams(a, b, ms, all);
                    const ba = compareGroupTeams(b, a, ms, all);
                    expect(ab).not.toBe(0);
                    expect(Math.sign(ab)).toBe(-Math.sign(ba));
                    for (const c of all) {
                        if (c === a || c === b) continue;
                        if (ab < 0 && compareGroupTeams(b, c, ms, all) < 0) expect(compareGroupTeams(a, c, ms, all)).toBeLessThan(0);
                    }
                }
            }
            const sorted = [...all].sort((a, b) => compareGroupTeams(a, b, ms, all)).map((s) => s.teamId);
            expect(sorted).toEqual(rankGroup(ms, ts).map((r) => r.teamId));
        }
    });
});
