// T-S14.3b: the Cost Breakdown chart's data: columns per filled slot (segments, totals, labels, accessible text), the
// Auction extra bid, "n/a" rows, the Pairings column (variant A) and its absence, the empty team.
import { type Slot, type Slots, type TeamCostSource, teamCost } from '@shared/teambuilder';
import { describe, expect, it } from 'vitest';
import { amountFixed, costChartBars, costSeries, PAIRINGS_COLUMN } from './costChartModel';

const ROWS: Record<string, number[]> = {
    acheron: [7, 8, 9, 10, 11, 12, 13],
    pela: [1, 1, 1, 1, 1, 1, 1],
    clara: [2, 2, 2, 2, 2, 2, 2],
};
const CONES: Record<string, number[]> = { mirror: [2.5, 3, 3.5, 4, 4.5] };
const NAMES: Record<string, string> = { acheron: 'Acheron', pela: 'Pela', clara: 'Clara' };
const nameOf = (k: string) => NAMES[k] ?? k;

const source = (
    pairs: { characterA: string; characterB: string; costModifier: number }[] = [],
): TeamCostSource => ({
    character: (n) => ROWS[n],
    lightcone: (n) => CONES[n],
    synergies: () => pairs,
});

const slot = (
    character: string,
    eidolon: number,
    lightcone: string | null = null,
    bid?: number,
): Slot => ({ character, eidolon, lightcone, superimposition: 1, ...(bid ? { bid } : {}) }) as Slot;

const bars = (slots: Slots, auction: boolean, src = source(), pairingsColumn?: boolean) =>
    costChartBars({
        slots,
        cost: teamCost(slots, auction ? 'auction' : 'classic', src),
        auction,
        nameOf,
        pairingsColumn,
    });

describe('costChartBars', () => {
    it('an empty team has no column', () => {
        expect(bars([null, null, null, null], false)).toEqual([]);
        expect(bars([null, null, null, null], true)).toEqual([]);
    });

    it('Classic: one column per filled slot in slot order, character then light cone', () => {
        const b = bars([null, slot('acheron', 2, 'mirror'), null, slot('pela', 6)], false);
        expect(b.map((x) => x.name)).toEqual(['Acheron', 'Pela']);
        expect(b[0]?.segments).toEqual([
            { series: 'character', value: 900 },
            { series: 'lightcone', value: 250 },
        ]);
        expect(b[0]?.total).toBe(1150);
        expect(b[0]?.totalText).toBe('Σ 11.5');
        expect(b[0]?.tipTotal).toBe('Σ Total: 11.5');
        expect(b[0]?.description).toBe('Acheron: total 11.5. Character 9.0, light cone 2.5.');
        expect(b[1]?.description).toBe('Pela: total 1.0. Character 1.0, light cone none.');
    });

    it('Auction: character (base + eidolon extra), light cone, extra bid on top; the total includes the bid', () => {
        const [a] = bars([slot('acheron', 2, 'mirror', 250), null, null, null], true);
        // base 7 + extra 2 = 9; bid 2.5; cone 2.5.
        expect(a?.segments).toEqual([
            { series: 'character', value: 900 },
            { series: 'lightcone', value: 250 },
            { series: 'bid', value: 250 },
        ]);
        expect(a?.total).toBe(1400);
        expect(a?.description).toBe(
            'Acheron: total 14.0. Character 9.0 (eidolon extra 2.0), light cone 2.5, extra bid 2.5.',
        );
        expect(a?.tip.map((r) => `${r.label} ${r.value}`)).toEqual([
            'Character 9.0',
            'of it eidolon extra 2.0',
            'Light Cone 2.5',
            'Extra bid 2.5',
        ]);
    });

    it('Classic ignores a stored bid', () => {
        const [a] = bars([slot('acheron', 0, null, 250), null, null, null], false);
        expect(a?.segments.map((s) => s.series)).toEqual(['character', 'lightcone']);
        expect(a?.total).toBe(700);
    });

    it('a character without a row is n/a, counted as 0, and says so above its empty column', () => {
        const [g, c] = bars(
            [slot('ghost', 0, null, 300), slot('clara', 0, 'nocone'), null, null],
            true,
        );
        expect(g?.segments.every((s) => s.value === 0)).toBe(true);
        expect(g?.totalText).toBe('n/a');
        expect(g?.description).toBe(
            'ghost: total 0.0. Character n/a, counted as 0, light cone none, extra bid 0.0.',
        );
        // A cone without a row: n/a too, the character still counts.
        expect(c?.description).toBe(
            'Clara: total 2.0. Character 2.0, light cone n/a, counted as 0, extra bid 0.0.',
        );
        expect(c?.totalText).toBe('Σ 2.0');
    });

    it('variant A: a Pairings column with the surcharge after the floor, set apart, listing each pair', () => {
        const src = source([
            { characterA: 'acheron', characterB: 'pela', costModifier: 1.5 },
            { characterA: 'clara', characterB: 'pela', costModifier: -0.5 },
        ]);
        const b = bars([slot('acheron', 0), slot('pela', 6), slot('clara', 0), null], false, src);
        const p = b.at(-1);
        expect(p?.key).toBe('pairings');
        expect(p?.apart).toBe(true);
        expect(p?.segments).toEqual([{ series: 'pairings', value: 100 }]);
        expect(p?.totalText).toBe('Σ 1.0');
        expect(p?.tip).toEqual([
            { label: 'Acheron × Pela', value: '+1.5' },
            { label: 'Clara × Pela', value: '−0.5' },
        ]);
        expect(p?.description).toBe(
            'Pairings: total 1.0, the synergy surcharge of 2 pairs: Acheron and Pela +1.5, Clara and Pela −0.5.',
        );
    });

    it('no Pairings column when the surcharge is 0 (no pair, or a net-negative sum floored at 0)', () => {
        expect(
            bars([slot('acheron', 0), slot('pela', 6), null, null], false).map((b) => b.key),
        ).toEqual(['slot-acheron', 'slot-pela']);
        const negative = source([{ characterA: 'acheron', characterB: 'pela', costModifier: -2 }]);
        expect(
            bars([slot('acheron', 0), slot('pela', 6), null, null], false, negative),
        ).toHaveLength(2);
    });

    it('variant B (pairingsColumn false) keeps pairs out of the chart', () => {
        const src = source([{ characterA: 'acheron', characterB: 'pela', costModifier: 1.5 }]);
        expect(
            bars([slot('acheron', 0), slot('pela', 6), null, null], false, src, false),
        ).toHaveLength(2);
    });

    it('the tree builds variant A', () => {
        expect(PAIRINGS_COLUMN).toBe(true);
    });
});

describe('costSeries and amountFixed', () => {
    it('the legend series follow the draft mode', () => {
        expect(costSeries(false).map((s) => s.label)).toEqual([
            'Character',
            'Light Cone',
            'Pairings',
        ]);
        expect(costSeries(true).map((s) => s.label)).toEqual([
            'Character',
            'Light Cone',
            'Extra bid',
            'Pairings',
        ]);
    });

    it.each([
        [0, '0.0'],
        [250, '2.5'],
        [225, '2.25'],
        [12049, '120.49'],
        [-150, '−1.5'],
    ])('%i -> %j', (h, text) => {
        expect(amountFixed(h)).toBe(text);
    });
});
