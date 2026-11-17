// T-S14.3a: the team builder's cost model against hand-computed cases from the real seed rules (data/seed/, the
// Default set): character cost by eidolon per game mode and draft mode, light cone cost by superimposition,
// unordered synergy pairs inside the team, the clamp at 0, the Auction eidolon extra, and a missing row.
import { describe, expect, it } from 'vitest';
import { eidolonExtra } from '../scoring';
import {
    defaultEidolon,
    defaultSuperimposition,
    type Slot,
    type Slots,
    signatureLightcone,
    type TeamCostSource,
    teamCost,
} from './index';

type Modes = { mode: 'as' | 'moc' | 'aa'; draft: 'classic' | 'auction' };

// Rows copied from data/seed/ (cost_set_id 0). Characters: E0..E6; cones: S1..S5.
const E = (...v: number[]) => v;
const SEED_CHARACTERS: Record<string, Record<Modes['mode'], number[]>> = {
    anaxa: {
        as: E(9.5, 10, 12, 12.5, 13, 14, 18.5),
        moc: E(9.5, 10, 12, 12.5, 13, 14, 18.5),
        aa: E(9.5, 10, 12, 12.5, 13, 14, 18.5),
    },
    cerydra: {
        as: E(7, 8.5, 10, 11, 11.5, 12, 15.5),
        moc: E(7.5, 9, 10.5, 11.5, 12, 12.5, 16),
        aa: E(7, 8.5, 10, 11, 11.5, 12, 15.5),
    },
    phainon: {
        as: E(9.5, 11.5, 15, 14.5, 15, 16, 20.5),
        moc: E(10, 12, 15, 14.5, 15, 16, 20.5),
        aa: E(9.5, 11.5, 15, 14.5, 15, 16, 20.5),
    },
    pela: { as: E(6, 6, 6, 6, 6, 6, 6), moc: E(6, 6, 6, 6, 6, 6, 6), aa: E(6, 6, 6, 6, 6, 6, 6) },
};
const SEED_CONES: Record<string, number[]> = {
    pastselfinmirror: E(1.5, 2, 2.5, 3, 3.5),
    agroundedascent: E(2, 2.5, 3, 3.5, 4),
};
// Synergies (seed): Classic +3 and +2 in every game mode; Auction 0.
const SEED_PAIRS = (draft: Modes['draft']) => [
    { characterA: 'anaxa', characterB: 'cerydra', costModifier: draft === 'classic' ? 3 : 0 },
    { characterA: 'cerydra', characterB: 'phainon', costModifier: draft === 'classic' ? 2 : 0 },
    { characterA: 'theherta', characterB: 'tribbie', costModifier: draft === 'classic' ? 4 : 0 },
];

function seedSource({ mode, draft }: Modes): TeamCostSource {
    return {
        character: (name) => SEED_CHARACTERS[name]?.[mode],
        lightcone: (name) => SEED_CONES[name],
        synergies: () => SEED_PAIRS(draft),
    };
}

const slot = (
    character: string,
    eidolon: number,
    lightcone: string | null = null,
    superimposition = 1,
): Slot => ({ character, eidolon, lightcone, superimposition }) as Slot;

const TEAM: Slots = [
    slot('cerydra', 2),
    slot('phainon', 0),
    slot('pela', 6, 'pastselfinmirror', 1),
    slot('anaxa', 0),
];

describe('teamCost: Classic', () => {
    it('AS: character at its eidolon, cone at its superimposition, two pairs inside the team', () => {
        const cost = teamCost(TEAM, 'classic', seedSource({ mode: 'as', draft: 'classic' }));
        // 10 + 9.5 + 6 + 9.5 = 35; cone 1.5; pairs anaxa-cerydra 3 + cerydra-phainon 2 = 5.
        expect(cost.slots.map((s) => s?.total)).toEqual([1000, 950, 750, 950]);
        expect(cost.pairs).toEqual([
            { characterA: 'anaxa', characterB: 'cerydra', modifier: 300 },
            { characterA: 'cerydra', characterB: 'phainon', modifier: 200 },
        ]);
        expect(cost.surcharge).toBe(500);
        expect(cost.total).toBe(4150);
        expect(cost.missing).toEqual([]);
    });

    it('MoC reads the MoC rows: Cerydra E2 10.5, Phainon E0 10', () => {
        const cost = teamCost(TEAM, 'classic', seedSource({ mode: 'moc', draft: 'classic' }));
        // 10.5 + 10 + 6 + 9.5 + 1.5 + 5 = 42.5
        expect(cost.total).toBe(4250);
    });

    it('AA reads the AA rows', () => {
        const cost = teamCost(TEAM, 'classic', seedSource({ mode: 'aa', draft: 'classic' }));
        expect(cost.total).toBe(4150);
    });

    it('a higher eidolon and superimposition raise the total by the row difference', () => {
        const team: Slots = [
            slot('cerydra', 6),
            slot('phainon', 0),
            slot('pela', 6, 'pastselfinmirror', 5),
            slot('anaxa', 0),
        ];
        const cost = teamCost(team, 'classic', seedSource({ mode: 'as', draft: 'classic' }));
        // 15.5 + 9.5 + 6 + 9.5 + 3.5 + 5 = 49
        expect(cost.total).toBe(4900);
    });

    it('a pair counts once in either row order, and only when both are in the team', () => {
        const source: TeamCostSource = {
            ...seedSource({ mode: 'as', draft: 'classic' }),
            synergies: () => [
                { characterA: 'cerydra', characterB: 'anaxa', costModifier: 3 },
                { characterA: 'anaxa', characterB: 'cerydra', costModifier: 3 },
                { characterA: 'anaxa', characterB: 'tribbie', costModifier: 4 },
            ],
        };
        const cost = teamCost(TEAM, 'classic', source);
        expect(cost.pairs).toEqual([{ characterA: 'anaxa', characterB: 'cerydra', modifier: 300 }]);
        expect(cost.surcharge).toBe(300);
    });

    it('a negative modifier is listed, but the pairs sum is floored at 0 before it is added', () => {
        const source: TeamCostSource = {
            ...seedSource({ mode: 'as', draft: 'classic' }),
            synergies: () => [{ characterA: 'pela', characterB: 'anaxa', costModifier: -3 }],
        };
        const cost = teamCost(TEAM, 'classic', source);
        expect(cost.pairs).toEqual([{ characterA: 'anaxa', characterB: 'pela', modifier: -300 }]);
        expect(cost.surcharge).toBe(0);
        expect(cost.total).toBe(3650); // 35 + 1.5, the -3 ignored
    });

    it('a negative pair offsets a positive one before the floor', () => {
        const source: TeamCostSource = {
            ...seedSource({ mode: 'as', draft: 'classic' }),
            synergies: () => [
                { characterA: 'anaxa', characterB: 'cerydra', costModifier: 3 },
                { characterA: 'pela', characterB: 'phainon', costModifier: -1 },
            ],
        };
        expect(teamCost(TEAM, 'classic', source).surcharge).toBe(200);
    });

    it('zero modifiers are not listed', () => {
        const cost = teamCost(TEAM, 'auction', seedSource({ mode: 'as', draft: 'auction' }));
        expect(cost.pairs).toEqual([]);
        expect(cost.surcharge).toBe(0);
    });

    it('f32 values are rounded to hundredths at the boundary', () => {
        const source: TeamCostSource = {
            character: () => [1.100000023841858, 0, 0, 0, 0, 0, 0],
            lightcone: () => [0.30000001192092896, 0, 0, 0, 0],
            synergies: () => [],
        };
        const cost = teamCost([slot('a', 0, 'b', 1), null, null, null], 'classic', source);
        expect(cost.total).toBe(140);
    });
});

describe('teamCost: Auction', () => {
    it('character = base (E0) + eidolon extra; pairs are 0 in the seed', () => {
        const team: Slots = [slot('cerydra', 2), slot('phainon', 3), null, null];
        const cost = teamCost(team, 'auction', seedSource({ mode: 'as', draft: 'auction' }));
        // Cerydra: 7 + (10 - 7) = 10, extra 3; Phainon: 9.5 + (14.5 - 9.5) = 14.5, extra 5.
        expect(cost.slots[0]).toEqual({ character: 1000, extra: 300, lightcone: 0, total: 1000 });
        expect(cost.slots[1]).toEqual({ character: 1450, extra: 500, lightcone: 0, total: 1450 });
        expect(cost.total).toBe(2450);
    });

    it('an eidolon cheaper than E0 adds no extra: the base is paid (Classic would charge the lower row)', () => {
        const source: TeamCostSource = {
            character: () => [5, 4, 4, 4, 4, 4, 4],
            lightcone: () => undefined,
            synergies: () => [],
        };
        const team: Slots = [slot('x', 1), null, null, null];
        expect(teamCost(team, 'auction', source).total).toBe(500);
        expect(teamCost(team, 'classic', source).total).toBe(400);
    });

    it('pairs with a modifier count in the Auction total too (A190 item 5)', () => {
        const source: TeamCostSource = {
            ...seedSource({ mode: 'as', draft: 'auction' }),
            synergies: () => [{ characterA: 'anaxa', characterB: 'cerydra', costModifier: 1.5 }],
        };
        const cost = teamCost(TEAM, 'auction', source);
        // 7 + 3 extra + 9.5 + 6 + 9.5 + 1.5 + 1.5 = 38
        expect(cost.total).toBe(3800);
    });

    it('eidolonExtra (shared/scoring) is max(0, e - e0)', () => {
        expect(eidolonExtra(700, 1000)).toBe(300);
        expect(eidolonExtra(700, 500)).toBe(0);
        expect(eidolonExtra(700, 700)).toBe(0);
    });
});

describe('teamCost: missing rows and empty slots', () => {
    it('a character or cone with no row counts 0 and is flagged', () => {
        const team: Slots = [slot('cerydra', 0, 'nosuchcone', 1), slot('ghost', 3), null, null];
        const cost = teamCost(team, 'classic', seedSource({ mode: 'as', draft: 'classic' }));
        expect(cost.slots[0]).toEqual({ character: 700, extra: 0, lightcone: null, total: 700 });
        expect(cost.slots[1]).toEqual({ character: null, extra: 0, lightcone: 0, total: 0 });
        expect(cost.total).toBe(700);
        expect(cost.missing).toEqual([
            { slot: 0, kind: 'lightcone', name: 'nosuchcone' },
            { slot: 1, kind: 'character', name: 'ghost' },
        ]);
    });

    it('an empty team costs 0', () => {
        const cost = teamCost(
            [null, null, null, null],
            'classic',
            seedSource({ mode: 'as', draft: 'classic' }),
        );
        expect(cost).toEqual({
            slots: [null, null, null, null],
            pairs: [],
            surcharge: 0,
            total: 0,
            missing: [],
        });
    });
});

describe('pick defaults', () => {
    it('E6 for 4-stars and Trailblazers, E0 for other 5-stars (A190 item 4)', () => {
        expect(defaultEidolon({ name: 'pela', displayName: 'Pela', rarity: 4 })).toBe(6);
        expect(
            defaultEidolon({
                name: 'trailblazerharmony',
                displayName: 'MC Harmony',
                rarity: 5,
            }),
        ).toBe(6);
        expect(defaultEidolon({ name: 'acheron', displayName: 'Acheron', rarity: 5 })).toBe(0);
    });

    it('S1 for a limited 5-star cone, S5 for a 4-star, a 3-star and a shop 5-star', () => {
        expect(defaultSuperimposition({ rarity: 5, aliases: ['pastselfinmirror'] })).toBe(1);
        expect(defaultSuperimposition({ rarity: 5, aliases: ['x', 'shop'] })).toBe(5);
        expect(defaultSuperimposition({ rarity: 4, aliases: [] })).toBe(5);
        expect(defaultSuperimposition({ rarity: 3, aliases: [] })).toBe(5);
    });

    it("a 5-star's signature cone is the one carrying its name or alias; none for a 4-star", () => {
        const cones = [
            { name: 'agroundedascent', aliases: ['agroundedascent', 'sunday'] },
            { name: 'pastselfinmirror', aliases: ['pastselfinmirror', 'ruanmei', 'rm'] },
        ];
        const ruanmei = { displayName: 'Ruan Mei', aliases: ['ruanmei'], rarity: 5 };
        expect(signatureLightcone(ruanmei, cones)?.name).toBe('pastselfinmirror');
        expect(signatureLightcone({ ...ruanmei, rarity: 4 }, cones)).toBeUndefined();
        expect(
            signatureLightcone({ displayName: 'Acheron', aliases: [], rarity: 5 }, cones),
        ).toBeUndefined();
    });
});
