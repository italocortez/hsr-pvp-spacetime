import type { Budgets, Slots } from './team';
import { slotBid, type TeamCost } from './teamCost';

// S14.3b: the Auction simulator. How a team built in the builder would spend a lobby's two Auction budgets, by the
// module's rules (A190 item 5: "the eidolon extra charged, pairs in the total"). All amounts in integer hundredths.
//
// The module (spacetimedb/src/reducers/draft/draftAuction.ts, postDraft.ts, helpers/draft/draftComplete.ts,
// helpers/results/scoringHelpers.ts):
//
// 1. The character budget pays the winning amount of each sale (`resolveSale`: a bid can never exceed what is left of
//    it, `place_bid`). The winning amount is the E0 cost (the nomination's opening bid, A61(1)) plus whatever the team
//    bid on top: the builder's per-slot "extra bid".
// 2. The eidolon extra max(0, cost[e] - cost[e0]) is charged at the sale, character budget first, the rest from the
//    light cone budget (`chargeExtra`, A61(5)(6)).
// 3. When the draft ends, what is left of the character budget rolls into the light cone budget (D-50, `finishDraft`).
// 4. Each equipped light cone is paid from the light cone budget (`equip_lightcone`: "Not enough LC budget.").
// 5. The synergy surcharge is not charged: it must fit the budget left (`ensureAuctionSurchargeFits`: "The synergy
//    surcharge exceeds the remaining budget"), and it counts in the roster cost (the total).
//
// Not modelled: the order of the sales. The module charges each extra at its own sale, so an early extra can leave too
// little character budget for a later bid, and at 0 character budget an extra may not spill (A133). The builder has no
// order, so it charges the extras after all the winning amounts. A character without a cost row ("n/a") costs 0 here.

export type AuctionSpend = {
    budgets: Budgets;
    /** The winning amounts: base + extra bid per character. */
    winning: number;
    /** The extra bids inside `winning`. */
    bids: number;
    /** The eidolon extras, and how they split over the two budgets. */
    eidolons: number;
    eidolonsFromCharacter: number;
    eidolonsFromLightcone: number;
    /** What the character budget pays: `winning` + `eidolonsFromCharacter`. */
    characterSpent: number;
    /** `budgets.character` - `characterSpent`; below 0 when the winning amounts do not fit. */
    characterLeft: number;
    /** What rolls into the light cone budget at the end of the draft (D-50). */
    rollover: number;
    /** The equipped light cones. */
    cones: number;
    /** The light cone budget after the roll-over: `budgets.lightcone` + `rollover`. */
    lightconeAvailable: number;
    /** What the light cone budget pays: `eidolonsFromLightcone` + `cones`. */
    lightconeSpent: number;
    /** The synergy surcharge (clamped at 0), which must fit what is left. */
    pairings: number;
    /** `lightconeAvailable` - `lightconeSpent` - `pairings`; below 0 when over. */
    left: number;
    over: {
        /** The winning amounts exceed the character budget (a lobby refuses such a bid). */
        character: boolean;
        /** The extras' spill and the cones exceed the light cone budget after the roll-over. */
        lightcone: boolean;
        /** The surcharge does not fit what is left after the cones. */
        pairings: boolean;
    };
    /** True when any of `over` holds. */
    overBudget: boolean;
};

export function auctionSpend(slots: Slots, cost: TeamCost, budgets: Budgets): AuctionSpend {
    let winning = 0;
    let bids = 0;
    let eidolons = 0;
    let cones = 0;
    slots.forEach((slot, index) => {
        const c = cost.slots[index];
        if (!slot || !c) return;
        if (c.character !== null) {
            winning += c.character - c.extra;
            bids += slotBid(slot);
            eidolons += c.extra;
        }
        cones += c.lightcone ?? 0;
    });

    const character = Math.max(0, budgets.character);
    const lightcone = Math.max(0, budgets.lightcone);
    const freeCharacter = Math.max(0, character - winning);
    const eidolonsFromCharacter = Math.min(eidolons, freeCharacter);
    const eidolonsFromLightcone = eidolons - eidolonsFromCharacter;
    const characterSpent = winning + eidolonsFromCharacter;
    const characterLeft = character - characterSpent;
    const rollover = Math.max(0, characterLeft);
    const lightconeAvailable = lightcone + rollover;
    const lightconeSpent = eidolonsFromLightcone + cones;
    const pairings = Math.max(0, cost.surcharge);
    const left = lightconeAvailable - lightconeSpent - pairings;

    const over = {
        character: winning > character,
        lightcone: lightconeSpent > lightconeAvailable,
        pairings:
            lightconeSpent <= lightconeAvailable && pairings > lightconeAvailable - lightconeSpent,
    };
    return {
        budgets: { character, lightcone },
        winning,
        bids,
        eidolons,
        eidolonsFromCharacter,
        eidolonsFromLightcone,
        characterSpent,
        characterLeft,
        rollover,
        cones,
        lightconeAvailable,
        lightconeSpent,
        pairings,
        left,
        over,
        overBudget: over.character || over.lightcone || over.pairings,
    };
}
