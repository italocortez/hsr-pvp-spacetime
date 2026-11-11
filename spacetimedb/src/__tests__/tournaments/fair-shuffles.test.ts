// Tournaments: random seeding and random team formation use the fair shuffle.
// Decisions: A36a, A120
// Contracts: docs/tournament/contract.md, docs/brackets/contract.md
// From S10p (s10p-fair-shuffles.test.ts).
import { describe, expect, it } from 'vitest';
import { SHUFFLE_DOMAIN, fairShuffle, shuffleKeyAt } from '@shared/lobby-rules';
import { advance, newHarness, now, type Harness } from '../fixtures/harness';
import { host } from '../fixtures/identity';
import {
    advanceStage,
    enrollMany,
    enrolled,
    fullTeams,
    membersOf,
    membership,
    openTournament,
    seedBracket,
    seedingField,
    teamRow,
    teams,
} from '../fixtures/tournaments';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Ready team ids by seedNumber. */
const bySeed = (test: Harness, tournamentId: number) =>
    teams(test, tournamentId).filter((t) => t.seedNumber !== undefined).sort((a, b) => a.seedNumber! - b.seedNumber!).map((t) => t.id);

/** The order seed_bracket('random') must write: fairShuffle of the Ready team ids in id order at the current clock. */
const expectedSeeds = (test: Harness, tournamentId: number, readyIds: number[]) =>
    fairShuffle([...readyIds].sort((a, b) => a - b), shuffleKeyAt(now(test), [SHUFFLE_DOMAIN.BracketSeeding, tournamentId]));

// ════════════════════════════════════════════════════════════════════════════
// Random bracket seeding (C-a7)
// ════════════════════════════════════════════════════════════════════════════

describe('A120: seed_bracket random mode uses the fair shuffle', () => {
    it('A120: random seeding writes seeds 1..n as a permutation of the Ready teams, in the order fairShuffle gives for the transaction', () => {
        const { test, org, id, ts } = seedingField(8);
        advance(test, 1_234);
        const ready = ts.map((t) => t.teamId);
        const want = expectedSeeds(test, id, ready);
        seedBracket(test, org, id, 'random');
        const got = bySeed(test, id);
        expect([...got].sort((a, b) => a - b)).toEqual([...ready].sort((a, b) => a - b));
        expect(ready.map((t) => teamRow(test, t)!.seedNumber).sort((a, b) => a! - b!)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
        expect(got).toEqual(want);
    });

    it('A120: re-seeding at a later time draws again; the result follows the new timestamp', () => {
        const { test, org, id, ts } = seedingField(8);
        const ready = ts.map((t) => t.teamId);
        const orders = new Set<string>();
        for (let i = 0; i < 10; i++) {
            advance(test, 1_000);
            const want = expectedSeeds(test, id, ready);
            seedBracket(test, org, id, 'random');
            expect(bySeed(test, id)).toEqual(want);
            orders.add(want.join());
        }
        expect(orders.size).toBeGreaterThanOrEqual(2);
    });

    it('A120: two tournaments seeded at the same timestamp are each keyed by their own id', () => {
        const { test, org, id: a, ts: tsA } = seedingField(6);
        const org2 = host(test, 'org2');
        const b = openTournament(test, org2, { maxParticipants: 12 });
        const tsB = fullTeams(test, b, 6, 'u');
        advanceStage(test, org2, b, 'Seeding');
        const at = now(test);
        const readyA = tsA.map((t) => t.teamId);
        const readyB = tsB.map((t) => t.teamId);
        seedBracket(test, org, a, 'random');
        seedBracket(test, org2, b, 'random');
        expect(now(test)).toBe(at); // one timestamp for both calls
        expect(bySeed(test, a)).toEqual(expectedSeeds(test, a, readyA));
        expect(bySeed(test, b)).toEqual(expectedSeeds(test, b, readyB));
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Random team formation (A36a)
// ════════════════════════════════════════════════════════════════════════════

describe('A120: random team formation (A36a) uses the fair shuffle', () => {
    for (const [teamSize, pool] of [[2, 5], [3, 7]] as const) {
        it(`A120: team size ${teamSize}, ${pool} opted-in solos: full teams in fairShuffle order, captain first, the remainder stays enrolled without a team`, () => {
            const test = newHarness();
            const org = host(test);
            const id = openTournament(test, org, { teamSize, maxParticipants: 12 });
            const solos = enrollMany(test, id, pool, 'r', { allowRandomTeamAssignment: true });
            const optedOut = enrollMany(test, id, 1, 'out');
            advance(test, 4_321);
            const sorted = solos.map((p) => p.userId).sort((a, b) => a - b);
            const order = fairShuffle(sorted, shuffleKeyAt(now(test), [SHUFFLE_DOMAIN.TeamFormation, id]));
            advanceStage(test, org, id, 'Seeding');

            const full = Math.floor(pool / teamSize);
            const formed = teams(test, id).filter((t) => /^Team \d+$/.test(t.name)).sort((a, b) => a.id - b.id);
            expect(formed).toHaveLength(full);
            formed.forEach((team, k) => {
                const want = order.slice(k * teamSize, (k + 1) * teamSize);
                expect(membersOf(test, team.id)).toEqual([...want].sort((a, b) => a - b));
                expect(team.captainUserId).toBe(want[0]);
            });
            for (const userId of order.slice(full * teamSize)) {
                expect(membership(test, id, userId)).toBeUndefined();
                expect(enrolled(test, id, userId)).toBeDefined();
            }
            expect(membership(test, id, optedOut[0].userId)).toBeUndefined();
        });
    }

    it('A120: formation and seeding in one tournament use different domain words, so their draws are keyed apart', () => {
        expect(SHUFFLE_DOMAIN.TeamFormation).not.toBe(SHUFFLE_DOMAIN.BracketSeeding);
        const ids = Array.from({ length: 8 }, (_, i) => i + 1);
        const at = 1_790_000_000_000_000n;
        expect(fairShuffle(ids, shuffleKeyAt(at, [SHUFFLE_DOMAIN.TeamFormation, 3])))
            .not.toEqual(fairShuffle(ids, shuffleKeyAt(at, [SHUFFLE_DOMAIN.BracketSeeding, 3])));
    });
});
