import { type ActivePair, type Slots, slotBid, type TeamCost } from '@shared/teambuilder';
import type {
    ChartBar,
    ChartSeries,
    ChartTipRow,
} from '@/components/StackedBarChart/StackedBarChart';

/*
 * The Cost Breakdown chart's data (S14.3b): one column per filled slot, in slot order, stacked as the mockup's
 * Chart.js chart (character at the bottom, then the light cone, then, in Auction, the extra bid, then the pairing).
 * Pure: the page passes the shared cost model's figures (`teamCost`, hundredths).
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

export const COST_SERIES = {
    character: { key: 'character', label: 'Character', tone: 1 },
    lightcone: { key: 'lightcone', label: 'Light Cone', tone: 2 },
    bid: { key: 'bid', label: 'Extra bid', tone: 3 },
    pairing: { key: 'pairing', label: 'Pairing', tone: 4 },
} as const satisfies Record<string, ChartSeries>;

/** The legend's series; the chart shows an entry only when a column draws it (the pairing only with a pair). */
export function costSeries(auction: boolean): ChartSeries[] {
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

export function costChartBars({ slots, cost, auction, nameOf }: CostChartInput): ChartBar[] {
    const order = slots.flatMap((s) => (s ? [s.character] : []));
    const shares = pairingShares(order, cost.pairs, cost.surcharge);
    const bars: ChartBar[] = [];
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

        const said = [
            `character ${characterText}${missingCharacter ? ', counted as 0' : ''}${
                extraText ? ` (eidolon extra ${extraText})` : ''
            }`,
            `light cone ${coneText}${c.lightcone === null && slot.lightcone !== null ? ', counted as 0' : ''}`,
        ];
        if (auction) said.push(`extra bid ${amountFixed(bid)}`);
        for (const r of pairRows) said.push(`pairing with ${r.partner} ${r.value}`);

        const tip: ChartTipRow[] = [
            { series: 'character', label: 'Character', value: characterText },
            ...(extraText ? [{ label: 'of it eidolon extra', value: extraText }] : []),
            { series: 'lightcone', label: 'Light Cone', value: coneText },
            ...(auction ? [{ series: 'bid', label: 'Extra bid', value: amountFixed(bid) }] : []),
            ...pairRows.map((r) => ({
                series: 'pairing',
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
                ...(auction ? [{ series: 'bid', value: bid }] : []),
                ...(pairingValue > 0 ? [{ series: 'pairing', value: pairingValue }] : []),
            ],
            total,
            // A character the set does not price, with nothing else on it, says so above its empty column.
            totalText: missingCharacter && total === 0 ? NA : `Σ ${amountFixed(total)}`,
            description: `${name}: total ${amountFixed(total)}. ${capitalise(said.join(', '))}.`,
            tip,
            tipTotal: `Σ Total: ${amountFixed(total)}`,
        });
    });
    return bars;
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
