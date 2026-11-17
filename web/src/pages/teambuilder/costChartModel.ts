import { type Slots, slotBid, type TeamCost } from '@shared/teambuilder';
import type { ChartBar, ChartSeries } from '@/components/StackedBarChart/StackedBarChart';
import { formatModifier } from '@/lib/rosterModel';

/*
 * The Cost Breakdown chart's data (S14.3b): one column per filled slot, in slot order, stacked as the mockup's
 * Chart.js chart (character at the bottom, then the light cone, then, in Auction, the extra bid), and the Pairings
 * column (A190 item 12, variant A). Pure: the page passes the shared cost model's figures (`teamCost`, hundredths).
 *
 * - Classic: character = the cost row at the chosen eidolon; light cone = the row at the superimposition.
 * - Auction: character = the base (E0) plus the eidolon extra, extra bid = the slot's bid; their sum is the winning
 *   amount plus the extra, what the module records for the sale.
 * - A row the cost set does not have is "n/a" and counts 0 (A190 item 6).
 * - Pairings: the team's synergy surcharge after the floor at 0, as its own column, shown only when above 0 (the strip
 *   under the slots lists every pair, also a negative one, and says when the floor applied).
 */

/**
 * A190 item 12: variant A (true) draws the Pairings column; variant B (false) keeps pairs in the total and the strip
 * only. The A/B patch `tmp/pw/ab-chart/pairings-B.patch` flips this line.
 */
export const PAIRINGS_COLUMN = true;

export const COST_SERIES = {
    character: { key: 'character', label: 'Character', tone: 1 },
    lightcone: { key: 'lightcone', label: 'Light Cone', tone: 2 },
    bid: { key: 'bid', label: 'Extra bid', tone: 3 },
    pairings: { key: 'pairings', label: 'Pairings', tone: 4 },
} as const satisfies Record<string, ChartSeries>;

export function costSeries(auction: boolean): ChartSeries[] {
    const s = COST_SERIES;
    return auction
        ? [s.character, s.lightcone, s.bid, s.pairings]
        : [s.character, s.lightcone, s.pairings];
}

/** Hundredths as text: one decimal, two when the amount has them (a bid of 2.25). */
export function amountFixed(hundredths: number): string {
    const v = Math.abs(hundredths);
    const text = (v / 100).toFixed(v % 10 === 0 ? 1 : 2);
    return hundredths < 0 ? `−${text}` : text;
}

export type CostChartInput = {
    slots: Slots;
    cost: TeamCost;
    auction: boolean;
    nameOf: (key: string) => string;
    /** Defaults to `PAIRINGS_COLUMN`. */
    pairingsColumn?: boolean;
};

const NA = 'n/a';

export function costChartBars({
    slots,
    cost,
    auction,
    nameOf,
    pairingsColumn = PAIRINGS_COLUMN,
}: CostChartInput): ChartBar[] {
    const bars: ChartBar[] = [];
    slots.forEach((slot, index) => {
        const c = cost.slots[index];
        if (!slot || !c) return;
        const name = nameOf(slot.character);
        const missingCharacter = c.character === null;
        const bid = auction && !missingCharacter ? slotBid(slot) : 0;
        const character = (c.character ?? 0) - bid;
        const cone = c.lightcone ?? 0;
        const total = c.total;

        const characterText = missingCharacter ? NA : amountFixed(character);
        const coneText =
            slot.lightcone === null ? 'none' : c.lightcone === null ? NA : amountFixed(cone);
        const extraText = auction && c.extra > 0 ? amountFixed(c.extra) : null;

        const said = [
            `character ${characterText}${missingCharacter ? ', counted as 0' : ''}${
                extraText ? ` (eidolon extra ${extraText})` : ''
            }`,
            `light cone ${coneText}${c.lightcone === null && slot.lightcone !== null ? ', counted as 0' : ''}`,
        ];
        if (auction) said.push(`extra bid ${amountFixed(bid)}`);

        const tip = [
            { series: 'character', label: 'Character', value: characterText },
            ...(extraText ? [{ label: 'of it eidolon extra', value: extraText }] : []),
            { series: 'lightcone', label: 'Light Cone', value: coneText },
            ...(auction ? [{ series: 'bid', label: 'Extra bid', value: amountFixed(bid) }] : []),
        ];

        bars.push({
            key: `slot-${slot.character}`,
            name,
            segments: [
                { series: 'character', value: Math.max(0, character) },
                { series: 'lightcone', value: Math.max(0, cone) },
                ...(auction ? [{ series: 'bid', value: bid }] : []),
            ],
            total,
            // A character the set does not price, with nothing else on it, says so above its empty column.
            totalText: missingCharacter && total === 0 ? NA : `Σ ${amountFixed(total)}`,
            description: `${name}: total ${amountFixed(total)}. ${capitalise(said.join(', '))}.`,
            tip,
            tipTotal: `Σ Total: ${amountFixed(total)}`,
        });
    });

    if (pairingsColumn && cost.surcharge > 0) {
        const pairs = cost.pairs.map((p) => ({
            label: `${nameOf(p.characterA)} × ${nameOf(p.characterB)}`,
            value: formatModifier(p.modifier / 100),
        }));
        const count = cost.pairs.length;
        const sum = amountFixed(cost.surcharge);
        bars.push({
            key: 'pairings',
            name: 'Pairings',
            segments: [{ series: 'pairings', value: cost.surcharge }],
            total: cost.surcharge,
            totalText: `Σ ${sum}`,
            description: `Pairings: total ${sum}, the synergy surcharge of ${count} ${
                count === 1 ? 'pair' : 'pairs'
            }: ${pairs.map((p) => `${p.label.replace(' × ', ' and ')} ${p.value}`).join(', ')}.`,
            tip: pairs,
            tipTotal: `Σ Total: ${sum}`,
            apart: true,
        });
    }
    return bars;
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
