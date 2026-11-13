// Group stage (A32 sizing, A23 round robin, review T7 qualifier placement). Pure: no `spacetimedb` / `react`.
// Ported from the legacy `spacetimedb/src/helpers/bracketGeneration.ts` (`snakeSeedIntoGroups`,
// `circleSchedule`), with the A32 floor fix; the legacy helper was deleted in S8c.

import { foldSeeding, groupKey, nextPowerOf2 } from './engine';

/** A32: `groupSize` is a minimum. Group count = floor(teams / groupSize), at least 1. */
export function groupCount(teamCount: number, groupSize: number): number {
    if (!Number.isInteger(groupSize) || groupSize < 1)
        throw new Error('groupSize must be a positive integer.');
    return Math.max(1, Math.floor(teamCount / groupSize));
}

/**
 * A32: snake seeding into `groupCount(n, groupSize)` groups (seed 1 → group 0, seed 2 → group 1, …, then back).
 * With the floor count the leftover teams land one per group, so no group is smaller than `groupSize`
 * (unless there are fewer teams than `groupSize`: one group) and sizes differ by at most one.
 * Example: 8 teams, groupSize 4 → [[1,4,5,8],[2,3,6,7]] (team ids in seed order).
 */
export function splitIntoGroups(teamIdsBySeed: readonly number[], groupSize: number): number[][] {
    const count = groupCount(teamIdsBySeed.length, groupSize);
    const groups: number[][] = Array.from({ length: count }, () => []);
    let g = 0;
    let forward = true;
    for (const id of teamIdsBySeed) {
        groups[g].push(id);
        if (count === 1) continue;
        if (forward) {
            if (g === count - 1) forward = false;
            else g++;
        } else if (g === 0) forward = true;
        else g--;
    }
    return groups;
}

/**
 * Round robin by the circle method: n−1 rounds for an even count, n rounds for an odd count (each team sits
 * out one round; the bye pairing is dropped). Every pair meets exactly once.
 */
export function roundRobin(teamIds: readonly number[]): [number, number][][] {
    const BYE = -1;
    const teams = [...teamIds];
    if (teams.length % 2 !== 0) teams.push(BYE);
    const n = teams.length;
    const rounds: [number, number][][] = [];
    for (let round = 0; round < n - 1; round++) {
        const matches: [number, number][] = [];
        for (let i = 0; i < n / 2; i++) {
            const home = teams[i];
            const away = teams[n - 1 - i];
            if (home !== BYE && away !== BYE) matches.push([home, away]);
        }
        rounds.push(matches);
        // keep teams[0] fixed, rotate the rest
        const last = teams.pop()!;
        teams.splice(1, 0, last);
    }
    return rounds;
}

export interface GroupMatchSpec {
    key: string; // groupKey(groupIndex, round, number)
    groupIndex: number; // 0-based, = TournamentTeam.groupId / BracketMatch.groupId
    round: number; // 1-based
    number: number; // 1-based within (group, round)
    team1: number;
    team2: number;
}

/** Every group match of the given groups (team ids), in group → round → match order. */
export function groupSpec(groups: readonly (readonly number[])[]): GroupMatchSpec[] {
    const out: GroupMatchSpec[] = [];
    groups.forEach((teams, groupIndex) => {
        roundRobin(teams).forEach((matches, r) => {
            matches.forEach(([team1, team2], m) => {
                out.push({
                    key: groupKey(groupIndex, r + 1, m + 1),
                    groupIndex,
                    round: r + 1,
                    number: m + 1,
                    team1,
                    team2,
                });
            });
        });
    });
    return out;
}

/**
 * The round in which two seed positions of a fold-seeded winners bracket of size `bracketSize` can first meet
 * (1 = the same round-1 match).
 */
export function meetingRound(seedA: number, seedB: number, bracketSize: number): number {
    const matchOf = new Map<number, number>();
    foldSeeding(bracketSize).forEach(([a, b], i) => {
        matchOf.set(a, i);
        matchOf.set(b, i);
    });
    let ma = matchOf.get(seedA)!;
    let mb = matchOf.get(seedB)!;
    let round = 1;
    while (ma !== mb) {
        ma >>= 1;
        mb >>= 1;
        round++;
    }
    return round;
}

/**
 * Review T7 / A23: the `teamIdsBySeed` order of the elimination bracket built from the group results; the
 * qualifiers enter Winners round 1 only (`generateSingleElim` / `generateDoubleElim` over this order).
 *
 * `rankedGroups[g]` lists group g's team ids by final rank (`rankGroup`); the top `advanceCount` of each
 * group qualify. Rule:
 *  - seeds are handed out rank by rank: all group winners take seeds 1..G, then all runners-up take
 *    seeds G+1..2G, and so on (a better rank always gets a better seed);
 *  - group winners take their seeds in group order (group 0 winner = seed 1);
 *  - each later rank is placed in alternating direction (rank 2 from the last group to the first, rank 3
 *    from the first to the last, …): each team takes the free seed of its rank's block where it would meet
 *    its own group's already-placed teams as late as possible in the winners bracket (ties: lowest seed).
 * With fold seeding this keeps teams of one group out of the same round-1 match whenever there are at least
 * two groups. (A literal "runners-up in reverse group order" would pair every runner-up with its own group
 * winner under fold seeding when the block exactly fills the bracket, e.g. 2 groups × 2 qualifiers.)
 */
export function placeQualifiers(
    rankedGroups: readonly (readonly number[])[],
    advanceCount: number,
): number[] {
    if (!Number.isInteger(advanceCount) || advanceCount < 1)
        throw new Error('advanceCount must be a positive integer.');
    const groupCountValue = rankedGroups.length;
    const qualifierCount = rankedGroups.reduce((n, g) => n + Math.min(advanceCount, g.length), 0);
    const bracketSize = nextPowerOf2(Math.max(2, qualifierCount));
    const seedOf = new Map<number, number>(); // teamId → seed
    const bySeed: number[] = []; // seed - 1 → teamId
    let nextSeed = 1;
    for (let rank = 0; rank < advanceCount; rank++) {
        const order = Array.from({ length: groupCountValue }, (_, i) =>
            rank % 2 === 0 ? i : groupCountValue - 1 - i,
        ).filter((g) => rankedGroups[g].length > rank);
        const block = order.map((_, i) => nextSeed + i);
        nextSeed += block.length;
        const free = new Set(block);
        for (const g of order) {
            const teamId = rankedGroups[g][rank];
            const mates = rankedGroups[g].slice(0, rank).map((id) => seedOf.get(id)!);
            let best = -1;
            let bestRound = -1;
            for (const seed of block) {
                if (!free.has(seed)) continue;
                const round =
                    mates.length === 0
                        ? Infinity
                        : Math.min(...mates.map((s) => meetingRound(s, seed, bracketSize)));
                if (round > bestRound) {
                    best = seed;
                    bestRound = round;
                }
            }
            free.delete(best);
            seedOf.set(teamId, best);
            bySeed[best - 1] = teamId;
        }
    }
    return bySeed;
}
