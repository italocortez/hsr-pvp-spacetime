import {
    auctionEidolonExtra,
    canonicalPair,
    rosterCost,
    type SynergyPair,
    synergySurcharge,
    toHundredths,
} from '@shared/scoring';
import { type DraftMode, type Slots, teamCharacters } from './team';

// S14.3a: what a team costs, by the module's own rules (research section 5.1), in integer hundredths like
// `shared/scoring` (A21: floats only at the boundary, `toHundredths` once per stored f32).
//
// | Part      | Classic                                  | Auction                                              |
// |-----------|------------------------------------------|------------------------------------------------------|
// | Character | the cost row at the chosen eidolon       | the base (the E0 cost, the opening bid, A61(1)) plus |
// |           |                                          | the eidolon extra max(0, cost[e] - cost[e0]) (A61(3),|
// |           |                                          | `auctionEidolonExtra`: subtract, then round once, as |
// |           |                                          | the module does; shared/scoring/auction.ts)          |
// | Cone      | the cost row at the superimposition      | the same                                             |
// | Synergy   | every unordered pair inside the group of four adds its modifier once (`synergySurcharge`); the |
// |           | sum is clamped at 0 before it is added (the module's `lineupCosts`, scoringHelpers.ts)          |
// | Total     | `rosterCost` of the above, clamped at 0                                                        |
//
// Rows are the chosen cost set's for the chosen game mode and draft mode (A101); the caller picks them through the
// `TeamCostSource`. A character or light cone without a row costs 0 here and is flagged (`missing`), so the page
// can show "n/a" and a warning (A190 item 6); a lobby would refuse it. In Auction the bid is assumed to be the base:
// the simulator's extra bids are S14.3b.

/** The cost rows of one cost set for the chosen game mode and draft mode, as stored (f32 values). */
export type TeamCostSource = {
    /** E0 to E6, or undefined when the set has no row for this character. */
    character(name: string): readonly number[] | undefined;
    /** S1 to S5, or undefined when the set has no row for this light cone. */
    lightcone(name: string): readonly number[] | undefined;
    /** The set's synergy rows for the modes (either order of a pair; a duplicate counts once). */
    synergies(): readonly { characterA: string; characterB: string; costModifier: number }[];
};

export type SlotCost = {
    /** Hundredths; null when the set has no row (counted as 0). Auction: base + `extra`. */
    character: number | null;
    /** Auction only: the eidolon extra inside `character` (0 in Classic and at E0). */
    extra: number;
    /** Hundredths; null for a missing row; 0 with no cone equipped. */
    lightcone: number | null;
    /** `character` + `lightcone`, missing rows as 0. */
    total: number;
};

export type ActivePair = { characterA: string; characterB: string; modifier: number };

export type Missing = { slot: number; kind: 'character' | 'lightcone'; name: string };

export type TeamCost = {
    slots: (SlotCost | null)[];
    /** The pairs inside the team with a non-zero modifier (hundredths), canonical order, each once. */
    pairs: ActivePair[];
    /** The sum of the pairs, clamped at 0 (what the total adds). */
    surcharge: number;
    /** The team's cost, clamped at 0. */
    total: number;
    /** Rows the set does not have: each counted as 0. */
    missing: Missing[];
};

export function teamCost(slots: Slots, draftMode: DraftMode, source: TeamCostSource): TeamCost {
    const missing: Missing[] = [];
    const characterCosts: number[] = [];
    const lightconeCosts: number[] = [];

    const slotCosts = slots.map((slot, index): SlotCost | null => {
        if (!slot) return null;
        const row = source.character(slot.character);
        let character: number | null = null;
        let extra = 0;
        if (row === undefined) {
            missing.push({ slot: index, kind: 'character', name: slot.character });
        } else {
            if (draftMode === 'auction') {
                // The module's order: the extra is the difference of the stored values, rounded once.
                extra = auctionEidolonExtra(row[0] ?? 0, row[slot.eidolon] ?? 0);
                character = toHundredths(row[0] ?? 0) + extra;
            } else {
                character = toHundredths(row[slot.eidolon] ?? 0);
            }
        }
        let lightcone: number | null = 0;
        if (slot.lightcone !== null) {
            const cone = source.lightcone(slot.lightcone);
            if (cone === undefined) {
                lightcone = null;
                missing.push({ slot: index, kind: 'lightcone', name: slot.lightcone });
            } else {
                lightcone = toHundredths(cone[slot.superimposition - 1] ?? 0);
            }
        }
        characterCosts.push(character ?? 0);
        lightconeCosts.push(lightcone ?? 0);
        return { character, extra, lightcone, total: (character ?? 0) + (lightcone ?? 0) };
    });

    const names = teamCharacters(slots);
    const pairs: SynergyPair[] = source.synergies().map((row) => ({
        characterA: row.characterA,
        characterB: row.characterB,
        costModifier: toHundredths(row.costModifier),
    }));

    // The pairs shown: inside the team, non-zero, each unordered pair once (its first row, as synergySurcharge).
    const seen = new Set<string>();
    const active: ActivePair[] = [];
    for (const pair of pairs) {
        const [a, b] = canonicalPair(pair.characterA, pair.characterB);
        const key = `${a}|${b}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (!names.includes(a) || !names.includes(b) || pair.costModifier === 0) continue;
        active.push({ characterA: a, characterB: b, modifier: pair.costModifier });
    }

    const surcharge = Math.max(0, synergySurcharge([names], pairs));
    const total = Math.max(0, rosterCost({ characterCosts, lightconeCosts, surcharge }));
    return { slots: slotCosts, pairs: active, surcharge, total, missing };
}
