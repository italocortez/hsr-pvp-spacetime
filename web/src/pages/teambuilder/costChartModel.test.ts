// T-S14.3b: the Cost Breakdown chart's data: columns per filled slot (segments, totals, labels, accessible text), the
// Auction extra bid, "n/a" rows, the empty team. T-S14.3c-fix3 (A199 item 1): pairings stacked on each character's
// column, each pair split evenly in hundredths, and the sum rules over the seed's real pairs.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type Slot, type Slots, type TeamCostSource, teamCost } from '@shared/teambuilder';
import { describe, expect, it } from 'vitest';
import { amountFixed, costChartBars, costSeries, pairingShares } from './costChartModel';

const ROWS: Record<string, number[]> = {
    acheron: [7, 8, 9, 10, 11, 12, 13],
    pela: [1, 1, 1, 1, 1, 1, 1],
    clara: [2, 2, 2, 2, 2, 2, 2],
    anaxa: [5, 5, 5, 5, 5, 5, 5],
    cerydra: [4, 4, 4, 4, 4, 4, 4],
};
const CONES: Record<string, number[]> = { mirror: [2.5, 3, 3.5, 4, 4.5] };
const NAMES: Record<string, string> = {
    acheron: 'Acheron',
    pela: 'Pela',
    clara: 'Clara',
    anaxa: 'Anaxa',
    cerydra: 'Cerydra',
};
const nameOf = (k: string) => NAMES[k] ?? k;

type PairRow = { characterA: string; characterB: string; costModifier: number };
const source = (pairs: PairRow[] = []): TeamCostSource => ({
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

const costOf = (slots: Slots, auction: boolean, src: TeamCostSource) =>
    teamCost(slots, auction ? 'auction' : 'classic', src);
const bars = (slots: Slots, auction: boolean, src = source()) =>
    costChartBars({ slots, cost: costOf(slots, auction, src), auction, nameOf });
const pairingOf = (b: ReturnType<typeof bars>[number] | undefined) =>
    b?.segments.find((s) => s.series === 'pairing')?.value ?? 0;
const sum = (xs: number[]) => xs.reduce((a, x) => a + x, 0);

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
});

describe('pairings stacked on each column (A199 item 1)', () => {
    it('one pair: half on each of its two columns, on top; totals include it; no column of its own', () => {
        const src = source([{ characterA: 'anaxa', characterB: 'cerydra', costModifier: 3 }]);
        const team: Slots = [slot('anaxa', 0, 'mirror'), slot('cerydra', 0), null, null];
        const b = bars(team, false, src);
        expect(b.map((x) => x.key)).toEqual(['slot-anaxa', 'slot-cerydra']);
        expect(b[0]?.segments).toEqual([
            { series: 'character', value: 500 },
            { series: 'lightcone', value: 250 },
            { series: 'pairing', value: 150 },
        ]);
        expect(b[1]?.segments.at(-1)).toEqual({ series: 'pairing', value: 150 });
        expect(b[0]?.total).toBe(900);
        expect(b[0]?.totalText).toBe('Σ 9.0');
        expect(b[0]?.tip.at(-1)).toEqual({
            series: 'pairing',
            label: 'Pairing with Cerydra',
            value: '1.5 of 3.0',
        });
        expect(b[0]?.description).toBe(
            'Anaxa: total 9.0. Character 5.0, light cone 2.5, pairing with Cerydra 1.5 of 3.0.',
        );
        expect(b[1]?.description).toBe(
            'Cerydra: total 5.5. Character 4.0, light cone none, pairing with Anaxa 1.5 of 3.0.',
        );
        expect(sum(b.map((x) => x.total))).toBe(costOf(team, false, src).total);
    });

    it('two pairs sharing a character: one segment with the sum of its halves, each pair listed', () => {
        const src = source([
            { characterA: 'acheron', characterB: 'pela', costModifier: 1.5 },
            { characterA: 'pela', characterB: 'clara', costModifier: 0.5 },
        ]);
        const team: Slots = [slot('acheron', 0), slot('pela', 0), slot('clara', 0), null];
        const b = bars(team, false, src);
        expect(b.map(pairingOf)).toEqual([75, 100, 25]);
        expect(b[1]?.tip.filter((r) => r.series === 'pairing')).toEqual([
            { series: 'pairing', label: 'Pairing with Acheron', value: '0.75 of 1.5' },
            { series: 'pairing', label: 'Pairing with Clara', value: '0.25 of 0.5' },
        ]);
        expect(sum(b.map(pairingOf))).toBe(costOf(team, false, src).surcharge);
    });

    it('an odd hundredth goes to the earlier slot; none is lost or made up', () => {
        const src = source([{ characterA: 'pela', characterB: 'acheron', costModifier: 0.25 }]);
        // Pela in slot 1, Acheron in slot 3: Pela (earlier) takes 13, Acheron 12, whatever the row's order.
        const b = bars([null, slot('pela', 0), null, slot('acheron', 0)], false, src);
        expect(b.map(pairingOf)).toEqual([13, 12]);
        expect(b[0]?.tip.at(-1)?.value).toBe('0.13 of 0.25');
        expect(b[1]?.tip.at(-1)?.value).toBe('0.12 of 0.25');
        const swapped = bars([null, slot('acheron', 0), null, slot('pela', 0)], false, src);
        expect(swapped.map(pairingOf)).toEqual([13, 12]);
    });

    it('a pair with a character the set does not price: its half still sits on that column', () => {
        const src = source([{ characterA: 'ghost', characterB: 'pela', costModifier: 2 }]);
        const team: Slots = [slot('ghost', 0), slot('pela', 0), null, null];
        const b = bars(team, false, src);
        expect(b.map(pairingOf)).toEqual([100, 100]);
        expect(b[0]?.total).toBe(100);
        expect(b[0]?.totalText).toBe('Σ 1.0');
        expect(b[0]?.description).toBe(
            'ghost: total 1.0. Character n/a, counted as 0, light cone none, pairing with Pela 1.0 of 2.0.',
        );
        expect(sum(b.map((x) => x.total))).toBe(costOf(team, false, src).total);
    });

    it('Auction with the default set: pairs are free, no segment, no legend entry needed', () => {
        // The seed prices every pair at 0 in Auction: the cost model lists no active pair.
        const src = source([{ characterA: 'anaxa', characterB: 'cerydra', costModifier: 0 }]);
        const b = bars([slot('anaxa', 0, null, 100), slot('cerydra', 0), null, null], true, src);
        expect(b.map(pairingOf)).toEqual([0, 0]);
        expect(b.every((x) => x.segments.every((s) => s.series !== 'pairing'))).toBe(true);
        // A set that prices them in Auction: the same segment, on top of the extra bid.
        const priced = source([{ characterA: 'anaxa', characterB: 'cerydra', costModifier: 1 }]);
        const p = bars([slot('anaxa', 0, null, 100), slot('cerydra', 0), null, null], true, priced);
        expect(p[0]?.segments.map((s) => s.series)).toEqual([
            'character',
            'lightcone',
            'bid',
            'pairing',
        ]);
        expect(p.map(pairingOf)).toEqual([50, 50]);
    });

    it('four characters, three pairs: segments add up to the surcharge, columns to the team total', () => {
        const src = source([
            { characterA: 'acheron', characterB: 'pela', costModifier: 1.5 },
            { characterA: 'clara', characterB: 'pela', costModifier: 0.25 },
            { characterA: 'anaxa', characterB: 'acheron', costModifier: 3 },
        ]);
        const team: Slots = [
            slot('acheron', 0),
            slot('pela', 0),
            slot('clara', 0),
            slot('anaxa', 0),
        ];
        const cost = costOf(team, false, src);
        const b = bars(team, false, src);
        // Acheron 75 + 150, Pela 75 + 13 (the earlier slot of Clara × Pela takes the odd hundredth), Clara 12,
        // Anaxa 150.
        expect(b.map(pairingOf)).toEqual([225, 88, 12, 150]);
        expect(sum(b.map(pairingOf))).toBe(cost.surcharge);
        expect(sum(b.map((x) => x.total))).toBe(cost.total);
    });

    it('old data with a negative modifier: no negative height, the sums still follow the floor', () => {
        const src = source([
            { characterA: 'acheron', characterB: 'pela', costModifier: 1 },
            { characterA: 'clara', characterB: 'pela', costModifier: -2 },
        ]);
        const team: Slots = [slot('acheron', 0), slot('pela', 0), slot('clara', 0), null];
        const cost = costOf(team, false, src);
        expect(cost.surcharge).toBe(0);
        const b = bars(team, false, src);
        expect(b.flatMap((x) => x.segments).every((s) => s.value >= 0)).toBe(true);
        expect(sum(b.map(pairingOf))).toBe(0);
        expect(sum(b.map((x) => x.total))).toBe(cost.total);
        const oldPairs = [
            { characterA: 'a', characterB: 'b', modifier: 300 },
            { characterA: 'b', characterB: 'c', modifier: -100 },
        ];
        const shares = pairingShares(['a', 'b', 'c'], oldPairs, 200);
        expect([...shares.values()].map((v) => v.segment)).toEqual([150, 50, 0]);
    });
});

describe('the sum rules over the seed’s real pairs (property)', () => {
    type SeedPair = {
        source_name: string;
        target_name: string;
        cost: Record<string, unknown>;
    };
    // jsdom gives this file a non-file import.meta.url: the repository is found from the cwd (as in
    // serviceWorkerScript.test.ts).
    const file = [process.cwd(), dirname(process.cwd())]
        .map((d) => join(d, 'data', 'seed', 'synergies.json'))
        .find((f) => existsSync(f)) as string;
    const seed = JSON.parse(readFileSync(file, 'utf8')) as SeedPair[];
    const modes = ['memory_of_chaos', 'apocalyptic_shadow', 'anomaly_arbitration'] as const;
    const characters = [...new Set(seed.flatMap((p) => [p.source_name, p.target_name]))].sort();

    it.each(modes.flatMap((m) => [[m, false] as const, [m, true] as const]))(
        '%s, auction %s: every team of four from the paired characters, in two slot orders',
        (mode, auction) => {
            const draft = auction ? 'auction' : 'classic';
            const rows: PairRow[] = seed.map((p) => ({
                characterA: p.source_name,
                characterB: p.target_name,
                costModifier: (p.cost[mode] as Record<string, { modifier: number }>)[draft]
                    ?.modifier as number,
            }));
            const src: TeamCostSource = {
                character: () => [3, 3, 3, 3, 3, 3, 3],
                lightcone: () => undefined,
                synergies: () => rows,
            };
            let teams = 0;
            const n = characters.length;
            for (let a = 0; a < n; a++)
                for (let b = a + 1; b < n; b++)
                    for (let c = b + 1; c < n; c++)
                        for (let d = c + 1; d < n; d++) {
                            const four = [a, b, c, d].map((i) => characters[i] as string);
                            for (const order of [four, [...four].reverse()]) {
                                const [s0, s1, s2, s3] = order.map((k) =>
                                    slot(k, 0, null, auction ? 50 : undefined),
                                );
                                const team: Slots = [
                                    s0 ?? null,
                                    s1 ?? null,
                                    s2 ?? null,
                                    s3 ?? null,
                                ];
                                const cost = costOf(team, auction, src);
                                const b2 = costChartBars({ slots: team, cost, auction, nameOf });
                                const segs = b2.map(pairingOf);
                                expect(segs.every((v) => v >= 0)).toBe(true);
                                expect(sum(segs)).toBe(cost.surcharge);
                                expect(sum(b2.map((x) => x.total))).toBe(cost.total);
                                teams++;
                            }
                        }
            expect(teams).toBeGreaterThan(100);
        },
    );
});

describe('costSeries and amountFixed', () => {
    it('the legend series follow the draft mode; the pairing last', () => {
        expect(costSeries(false).map((s) => s.label)).toEqual([
            'Character',
            'Light Cone',
            'Pairing',
        ]);
        expect(costSeries(true).map((s) => s.label)).toEqual([
            'Character',
            'Light Cone',
            'Extra bid',
            'Pairing',
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
