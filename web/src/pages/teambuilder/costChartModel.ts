import { type ActivePair, type Slots, slotBid, type TeamCost } from '@shared/teambuilder';
import type { ChartConfiguration, ScriptableContext } from 'chart.js';
import { chartScale } from '@/components/Chart/chartScale';
import type { ChartModel } from '@/components/Chart/types';
import { categoryTickLines } from '@/components/Chart/wrapLabel';

/*
 * The Cost Breakdown chart's data (S14.3b; on the shared Chart.js wrapper since S14.5c): one column per filled slot,
 * in slot order, stacked as the mockup's Chart.js chart (character at the bottom, then the light cone, then, in
 * Auction, the extra bid, then the pairing). Pure: the page passes the shared cost model's figures (`teamCost`,
 * hundredths). `costChartBars` computes the numbers; `costChartModel` turns them into the Chart.js configuration,
 * the tooltips, the legend and the data table, so every figure the chart shows comes from one place.
 *
 * - Classic: character = the cost row at the chosen eidolon; light cone = the row at the superimposition.
 * - Auction: character = the base (E0) plus the eidolon extra, extra bid = the slot's bid; their sum is the winning
 *   amount plus the extra, what the module records for the sale.
 * - A row the cost set does not have is "n/a" and counts 0 (A190 item 6).
 * - Pairing (A199 item 1, the user: "it was clear that way what was causing the price of a given unit to
 *   increase"): each active pair puts half of its modifier on top of the column of each of its two characters; a
 *   character in several pairs carries the sum of its halves as one segment. In hundredths, an odd modifier gives the
 *   extra hundredth to the character in the earlier slot (the left column), so the two halves add up to the pair
 *   exactly. Each column's total includes its pairing, so the columns add up to the team total.
 * - Modifiers are 0 or more (the module refuses a negative one since A199). Old data with a negative one draws no
 *   negative height and no crash: the segments are cut back, right to left, until they add up to the team's
 *   surcharge after its floor at 0, so the columns still add up to the team total.
 */

export type CostSeriesKey = 'character' | 'lightcone' | 'bid' | 'pairing';

/** A series: its label and its colour, a custom property set per game mode in `CostChart.module.css`. */
export type CostSeries = { key: CostSeriesKey; label: string; color: string };

export const COST_SERIES = {
    character: { key: 'character', label: 'Character', color: '--chart-tone-1' },
    lightcone: { key: 'lightcone', label: 'Light Cone', color: '--chart-tone-2' },
    bid: { key: 'bid', label: 'Extra bid', color: '--chart-tone-3' },
    pairing: { key: 'pairing', label: 'Pairing', color: '--chart-tone-4' },
} as const satisfies Record<CostSeriesKey, CostSeries>;

export type CostSegment = { series: CostSeriesKey; value: number };

export type CostTipRow = { series?: CostSeriesKey; label: string; value: string };

/** One column (hundredths). */
export type CostBar = {
    key: string;
    /** Under the column (wrapped to two lines; the full name is in the tooltip and the table). */
    name: string;
    /** Bottom to top; never negative (a value of 0 draws nothing). */
    segments: readonly CostSegment[];
    total: number;
    /** Above the column ("Σ 12.5", or "n/a"). */
    totalText: string;
    tip: readonly CostTipRow[];
    /** The tooltip's last line ("Σ Total: 12.5"). */
    tipTotal: string;
    /** The column's row in the data table: name, total, then one cell per series of the draft mode. */
    cells: readonly string[];
};

/** The legend's series; the chart shows an entry only when a column draws it (the pairing only with a pair). */
export function costSeries(auction: boolean): CostSeries[] {
    const s = COST_SERIES;
    return auction
        ? [s.character, s.lightcone, s.bid, s.pairing]
        : [s.character, s.lightcone, s.pairing];
}

/** Hundredths as text: one decimal, two when the amount has them (a bid of 2.25). */
export function amountFixed(hundredths: number): string {
    const v = Math.abs(hundredths);
    const text = (v / 100).toFixed(v % 10 === 0 ? 1 : 2);
    return hundredths < 0 ? `−${text}` : text;
}

/** One pair as one column sees it: the partner, this column's half and the pair's whole modifier (hundredths). */
export type PairShare = { partner: string; share: number; modifier: number };

/**
 * Each character's pairing: its halves of the active pairs and the segment it draws (hundredths). `order`: the
 * team's characters in slot order. The segments are never negative and add up to `surcharge` exactly.
 */
export function pairingShares(
    order: readonly string[],
    pairs: readonly ActivePair[],
    surcharge: number,
): Map<string, { segment: number; pairs: PairShare[] }> {
    const out = new Map<string, { segment: number; pairs: PairShare[] }>();
    const at = (c: string) => {
        let v = out.get(c);
        if (!v) {
            v = { segment: 0, pairs: [] };
            out.set(c, v);
        }
        return v;
    };
    const slotOf = (c: string) => {
        const i = order.indexOf(c);
        return i < 0 ? order.length : i;
    };
    for (const p of pairs) {
        const [first, second] =
            slotOf(p.characterA) <= slotOf(p.characterB)
                ? [p.characterA, p.characterB]
                : [p.characterB, p.characterA];
        // The earlier slot takes the odd hundredth: ceil to it, floor to the other (the sum is the modifier).
        const big = Math.ceil(p.modifier / 2);
        const small = p.modifier - big;
        at(first).pairs.push({ partner: second, share: big, modifier: p.modifier });
        at(second).pairs.push({ partner: first, share: small, modifier: p.modifier });
    }
    for (const v of out.values())
        v.segment = Math.max(
            0,
            v.pairs.reduce((s, x) => s + x.share, 0),
        );
    // Only reachable with a negative modifier (old data): cut back to the surcharge, the right-most column first.
    let excess = [...out.values()].reduce((s, v) => s + v.segment, 0) - Math.max(0, surcharge);
    const rightFirst = [...out.keys()].sort((a, b) => slotOf(b) - slotOf(a));
    for (const c of rightFirst) {
        if (excess <= 0) break;
        const v = out.get(c) as { segment: number };
        const cut = Math.min(v.segment, excess);
        v.segment -= cut;
        excess -= cut;
    }
    return out;
}

export type CostChartInput = {
    slots: Slots;
    cost: TeamCost;
    auction: boolean;
    nameOf: (key: string) => string;
};

const NA = 'n/a';

export function costChartBars({ slots, cost, auction, nameOf }: CostChartInput): CostBar[] {
    const order = slots.flatMap((s) => (s ? [s.character] : []));
    const shares = pairingShares(order, cost.pairs, cost.surcharge);
    const bars: CostBar[] = [];
    slots.forEach((slot, index) => {
        const c = cost.slots[index];
        if (!slot || !c) return;
        const name = nameOf(slot.character);
        const missingCharacter = c.character === null;
        const bid = auction && !missingCharacter ? slotBid(slot) : 0;
        const character = (c.character ?? 0) - bid;
        const cone = c.lightcone ?? 0;
        const pairing = shares.get(slot.character);
        const pairingValue = pairing?.segment ?? 0;
        const total = c.total + pairingValue;

        const characterText = missingCharacter ? NA : amountFixed(character);
        const coneText =
            slot.lightcone === null ? 'none' : c.lightcone === null ? NA : amountFixed(cone);
        const extraText = auction && c.extra > 0 ? amountFixed(c.extra) : null;
        const pairRows = (pairing?.pairs ?? []).map((p) => ({
            partner: nameOf(p.partner),
            value: `${amountFixed(p.share)} of ${amountFixed(p.modifier)}`,
        }));

        const cells = [
            name,
            amountFixed(total),
            `${characterText}${missingCharacter ? ', counted as 0' : ''}${
                extraText ? ` (eidolon extra ${extraText})` : ''
            }`,
            `${coneText}${c.lightcone === null && slot.lightcone !== null ? ', counted as 0' : ''}`,
            ...(auction ? [amountFixed(bid)] : []),
            pairRows.length
                ? pairRows.map((r) => `with ${r.partner} ${r.value}`).join('; ')
                : 'none',
        ];

        const tip: CostTipRow[] = [
            { series: 'character', label: 'Character', value: characterText },
            ...(extraText ? [{ label: 'of it eidolon extra', value: extraText }] : []),
            { series: 'lightcone', label: 'Light Cone', value: coneText },
            ...(auction
                ? [{ series: 'bid' as const, label: 'Extra bid', value: amountFixed(bid) }]
                : []),
            ...pairRows.map((r) => ({
                series: 'pairing' as const,
                label: `Pairing with ${r.partner}`,
                value: r.value,
            })),
        ];

        bars.push({
            key: `slot-${slot.character}`,
            name,
            segments: [
                { series: 'character', value: Math.max(0, character) },
                { series: 'lightcone', value: Math.max(0, cone) },
                ...(auction ? [{ series: 'bid' as const, value: bid }] : []),
                ...(pairingValue > 0 ? [{ series: 'pairing' as const, value: pairingValue }] : []),
            ],
            total,
            // A character the set does not price, with nothing else on it, says so above its empty column.
            totalText: missingCharacter && total === 0 ? NA : `Σ ${amountFixed(total)}`,
            tip,
            tipTotal: `Σ Total: ${amountFixed(total)}`,
            cells,
        });
    });
    return bars;
}

/** The data table's column heads (the row header first). */
export function costTableColumns(auction: boolean): string[] {
    return [
        'Character',
        'Total',
        'Character cost',
        'Light cone',
        ...(auction ? ['Extra bid'] : []),
        'Pairing',
    ];
}

/** The 2px gap between parts: a border in the card's colour under every part that has a drawn part below it. */
export function gapBelow(
    rows: readonly (readonly (number | null)[])[],
    series: number,
    index: number,
) {
    return rows.slice(0, series).some((r) => r[index] != null) ? 2 : 0;
}

const FONT = 'var(--font-primary)';

export type CostChartModelInput = {
    bars: readonly CostBar[];
    auction: boolean;
    /** The game mode's short name ("MoC"). */
    mode: string;
    /** Shown instead of columns ("No characters selected", "Loading costs"). */
    empty: string;
};

/**
 * The chart for the shared wrapper (`components/Chart`): stacked bars in the series' colours, the "Σ" labels above
 * the columns, names under them on two lines at most, the value axis "Cost — <mode>" on round steps (at most four
 * faint grid lines, no tick labels), the tooltips, the legend of drawn series and the data table. Values are drawn
 * in units (hundredths / 100); 0 is `null`, so a part of 0 draws nothing.
 */
export function costChartModel({
    bars,
    auction,
    mode,
    empty,
}: CostChartModelInput): ChartModel<'bar'> {
    const series = costSeries(auction);
    const scale = chartScale(Math.max(0, ...bars.map((b) => b.total)), 4);
    const rows = series.map((s) =>
        bars.map((b) => {
            const v = b.segments.find((g) => g.series === s.key)?.value ?? 0;
            return v > 0 ? v / 100 : null;
        }),
    );
    const drawn = series.filter((_, i) => rows[i]?.some((v) => v != null));
    const hasBars = bars.length > 0;
    const label = `Cost per character, ${mode}, ${auction ? 'Auction' : 'Classic'} draft`;

    const config: ChartConfiguration<'bar', (number | null)[], string> = {
        type: 'bar',
        data: {
            labels: bars.map((b) => b.name),
            datasets: series.map((s, si) => ({
                label: s.label,
                data: rows[si] ?? [],
                backgroundColor: `var(${s.color})`,
                hoverBackgroundColor: `var(${s.color})`,
                borderColor: 'var(--chart-surface)',
                hoverBorderColor: 'var(--chart-surface)',
                borderWidth: (ctx: ScriptableContext<'bar'>) => ({
                    top: 0,
                    left: 0,
                    right: 0,
                    bottom: gapBelow(rows, si, ctx.dataIndex),
                }),
                borderSkipped: false,
                borderRadius: 0,
                // A part above 0 stays visible: 2px of colour (plus the 2px gap above the part below).
                minBarLength: si === 0 ? 2 : 4,
                barPercentage: 1,
                categoryPercentage: 0.72,
                maxBarThickness: 70,
            })),
        },
        options: {
            layout: { padding: { top: 24 } },
            animation: { duration: 500, easing: 'easeOutQuart' },
            interaction: { mode: 'index', intersect: false, axis: 'x' },
            scales: {
                x: {
                    stacked: true,
                    grid: { display: false, drawTicks: false },
                    border: { display: hasBars, color: 'var(--chart-axis)', width: 1 },
                    ticks: {
                        color: 'var(--chart-ink)',
                        font: { family: FONT, size: 11, weight: 600 },
                        maxRotation: 0,
                        minRotation: 0,
                        autoSkip: false,
                        padding: 8,
                        callback(value) {
                            return categoryTickLines(this, value, 2);
                        },
                    },
                },
                y: {
                    stacked: true,
                    min: 0,
                    max: scale.max / 100,
                    grid: { display: hasBars, color: 'var(--chart-grid)', drawTicks: false },
                    border: { display: false },
                    ticks: { display: false, stepSize: scale.step / 100 },
                    title: {
                        display: true,
                        text: `Cost — ${mode}`,
                        color: 'var(--chart-muted)',
                        font: { family: FONT, size: 11, weight: 600 },
                        padding: { top: 0, bottom: 8 },
                    },
                },
            },
            plugins: {
                stackLabels: {
                    labels: bars.map((b) => b.totalText),
                    color: 'var(--chart-accent)',
                    font: { family: FONT, size: 13, weight: 700 },
                    offset: 4,
                },
            },
        },
    };

    return {
        label,
        description: `Stacked bars, one per character: ${series
            .map((s) => s.label.toLowerCase())
            .join(', ')}. Every value is in the table that follows.`,
        config: config as unknown as ChartConfiguration<'bar'>,
        table: {
            columns: costTableColumns(auction),
            rows: bars.map((b) => ({ key: b.key, cells: b.cells })),
        },
        tips: bars.map((b) => ({
            title: b.name,
            rows: b.tip.map((r) => ({
                ...(r.series ? { color: COST_SERIES[r.series].color } : {}),
                label: r.label,
                value: r.value,
            })),
            footer: b.tipTotal,
        })),
        legend: drawn.map((s) => ({ key: s.key, label: s.label, color: s.color })),
        ...(hasBars ? {} : { empty }),
    };
}
