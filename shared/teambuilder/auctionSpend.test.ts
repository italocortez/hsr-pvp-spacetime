// T-S14.3b: the Auction simulator (auctionSpend), the extra bid in the Auction character cost (teamCost, slotBid),
// and the typed amounts (parseAmount, amountText). Hand-computed cases; the rules are the module's
// (draftAuction.ts resolveSale / chargeExtra, draftComplete.ts finishDraft, postDraft.ts equip_lightcone,
// scoringHelpers.ts ensureAuctionSurchargeFits).
import { describe, expect, it } from 'vitest';
import {
    amountText,
    auctionSpend,
    BID_MAX,
    BUDGET_MAX,
    parseAmount,
    readAmount,
    type Slot,
    type Slots,
    slotBid,
    type TeamCostSource,
    teamCost,
} from './index';

const ROWS: Record<string, number[]> = {
    a: [7, 8, 10, 11, 12, 13, 15], // E0 7, E2 10 (extra 3)
    b: [9.5, 10, 11, 12, 13, 14, 16],
    c: [2, 2, 2, 2, 2, 2, 2],
};
const CONES: Record<string, number[]> = { x: [1.5, 2, 2.5, 3, 3.5], y: [4, 4, 4, 4, 4] };

function source(
    pairs: { characterA: string; characterB: string; costModifier: number }[] = [],
): TeamCostSource {
    return {
        character: (name) => ROWS[name],
        lightcone: (name) => CONES[name],
        synergies: () => pairs,
    };
}

const slot = (
    character: string,
    eidolon: number,
    lightcone: string | null = null,
    bid?: number,
): Slot =>
    ({
        character,
        eidolon,
        lightcone,
        superimposition: 1,
        ...(bid === undefined ? {} : { bid }),
    }) as Slot;

const spend = (slots: Slots, budgets = { character: 3000, lightcone: 1500 }, pairs = source()) =>
    auctionSpend(slots, teamCost(slots, 'auction', pairs), budgets);

describe('teamCost: the extra bid (S14.3b)', () => {
    it('Auction: character = base + bid + eidolon extra; the total follows', () => {
        const team: Slots = [slot('a', 2, null, 250), null, null, null];
        const cost = teamCost(team, 'auction', source());
        expect(cost.slots[0]).toEqual({ character: 1250, extra: 300, lightcone: 0, total: 1250 });
        expect(cost.total).toBe(1250);
    });

    it('Classic ignores the bid', () => {
        const team: Slots = [slot('a', 2, null, 250), null, null, null];
        expect(teamCost(team, 'classic', source()).total).toBe(1000);
    });

    it('a character without a row is n/a and its bid is not counted', () => {
        const team: Slots = [slot('ghost', 0, 'x', 300), null, null, null];
        const cost = teamCost(team, 'auction', source());
        expect(cost.slots[0]?.character).toBeNull();
        expect(cost.total).toBe(150);
    });

    it('slotBid keeps 0..BID_MAX whole hundredths only', () => {
        expect(slotBid({})).toBe(0);
        expect(slotBid({ bid: 250 })).toBe(250);
        expect(slotBid({ bid: -5 })).toBe(0);
        expect(slotBid({ bid: 2.5 })).toBe(0);
        expect(slotBid({ bid: BID_MAX + 1 })).toBe(BID_MAX);
    });
});

describe('auctionSpend', () => {
    it('an empty team spends nothing and keeps both budgets', () => {
        const s = spend([null, null, null, null]);
        expect(s).toMatchObject({
            winning: 0,
            characterSpent: 0,
            characterLeft: 3000,
            rollover: 3000,
            lightconeAvailable: 4500,
            lightconeSpent: 0,
            left: 4500,
            overBudget: false,
        });
    });

    it('winning amounts (base + bid) and eidolon extras come from the character budget first', () => {
        // a: base 7 + bid 2.5 + extra 3; b: base 9.5; cone x S1 1.5.
        const s = spend([slot('a', 2, 'x', 250), slot('b', 0), null, null]);
        expect(s.winning).toBe(700 + 250 + 950);
        expect(s.bids).toBe(250);
        expect(s.eidolons).toBe(300);
        expect(s.eidolonsFromCharacter).toBe(300);
        expect(s.eidolonsFromLightcone).toBe(0);
        expect(s.characterSpent).toBe(2200);
        expect(s.characterLeft).toBe(800);
        // D-50: the leftover rolls into the light cone budget.
        expect(s.rollover).toBe(800);
        expect(s.lightconeAvailable).toBe(2300);
        expect(s.cones).toBe(150);
        expect(s.lightconeSpent).toBe(150);
        expect(s.left).toBe(2150);
        expect(s.overBudget).toBe(false);
    });

    it('an extra that does not fit the character budget spills into the light cone budget', () => {
        // a at E6: base 7, extra 8; bid 20 -> winning 27 of 30; 3 of the extra from characters, 5 from cones.
        const s = spend([slot('a', 6, null, 2000), null, null, null]);
        expect(s.winning).toBe(2700);
        expect(s.eidolonsFromCharacter).toBe(300);
        expect(s.eidolonsFromLightcone).toBe(500);
        expect(s.characterLeft).toBe(0);
        expect(s.rollover).toBe(0);
        expect(s.lightconeSpent).toBe(500);
        expect(s.left).toBe(1000);
        expect(s.overBudget).toBe(false);
    });

    it('winning amounts above the character budget are over (a lobby refuses the bid)', () => {
        const s = spend([slot('a', 0, null, 2000), slot('b', 0, null, 500), null, null]);
        // 27 + 14.5 = 41.5 > 30
        expect(s.winning).toBe(4150);
        expect(s.characterLeft).toBe(-1150);
        expect(s.rollover).toBe(0);
        expect(s.over).toEqual({ character: true, lightcone: false, pairings: false });
        expect(s.overBudget).toBe(true);
    });

    it('cones above the light cone budget after the roll-over are over', () => {
        const s = spend([slot('a', 0, 'y'), slot('b', 0, 'y'), slot('c', 0, 'y'), null], {
            character: 2000,
            lightcone: 500,
        });
        // winning 18.5 of 20 -> rollover 1.5; cones 12 > 5 + 1.5.
        expect(s.rollover).toBe(150);
        expect(s.lightconeAvailable).toBe(650);
        expect(s.lightconeSpent).toBe(1200);
        expect(s.over.lightcone).toBe(true);
        expect(s.left).toBe(-550);
    });

    it('the surcharge is not charged but must fit what is left; it counts in the total', () => {
        const pairs = source([{ characterA: 'a', characterB: 'b', costModifier: 3 }]);
        const fits = spend(
            [slot('a', 0), slot('b', 0), null, null],
            { character: 1700, lightcone: 200 },
            pairs,
        );
        // winning 16.5 of 17 -> rollover 0.5; available 2.5; surcharge 3 > 2.5.
        expect(fits.pairings).toBe(300);
        expect(fits.left).toBe(-50);
        expect(fits.over).toEqual({ character: false, lightcone: false, pairings: true });
        const roomy = spend([slot('a', 0), slot('b', 0), null, null], undefined, pairs);
        expect(roomy.over.pairings).toBe(false);
        expect(roomy.left).toBe(3000 + 1500 - 1650 - 300);
    });

    it('a net-negative pair sum is floored at 0', () => {
        const pairs = source([{ characterA: 'a', characterB: 'b', costModifier: -2 }]);
        expect(spend([slot('a', 0), slot('b', 0), null, null], undefined, pairs).pairings).toBe(0);
    });

    it('a missing character row costs 0 (no winning amount, no bid)', () => {
        const s = spend([slot('ghost', 0, 'x', 500), null, null, null]);
        expect(s.winning).toBe(0);
        expect(s.bids).toBe(0);
        expect(s.cones).toBe(150);
    });

    it('budgets of 0: anything spent is over', () => {
        const s = spend([slot('c', 0), null, null, null], { character: 0, lightcone: 0 });
        expect(s.over.character).toBe(true);
        expect(spend([null, null, null, null], { character: 0, lightcone: 0 }).overBudget).toBe(
            false,
        );
    });
});

describe('parseAmount and amountText', () => {
    it.each([
        ['2', 200],
        ['2.5', 250],
        ['.5', 50],
        ['2.', 200],
        ['2,25', 225],
        ['  3 ', 300],
        ['0', 0],
        ['1.234', 123],
    ])('%j reads as %i hundredths', (text, value) => {
        expect(parseAmount(text, BID_MAX)).toBe(value);
    });

    it.each(['', ' ', '-1', '+2', 'abc', '1e3', '1.2.3'])('%j is not an amount', (text) => {
        expect(parseAmount(text, BID_MAX)).toBeNull();
    });

    it('caps at the given maximum', () => {
        expect(parseAmount('500', BID_MAX)).toBe(BID_MAX);
        expect(parseAmount('99999999999', BUDGET_MAX)).toBe(BUDGET_MAX);
    });

    // T-S14.3b-fix (review S3, S4, M5): the forms a person types or pastes.
    it.each([
        ['$5.00', 500],
        ['€ 2,5', 250],
        ['4 €', 400],
        ['£3', 300],
        ['2,5', 250],
        [',5', 50],
        ['0,05', 5],
        ['007', 700],
        ['1.005', 101],
        ['1.995', 200],
        ['2.500', 250],
        ['1,2345', 123],
    ])('readAmount: %j is the amount %i', (text, value) => {
        expect(readAmount(text, BID_MAX)).toEqual({ kind: 'amount', value, capped: false });
    });

    it.each(['1,000', '12,500', '0,000'])('readAmount: %j is refused as unclear', (text) => {
        expect(readAmount(text, BUDGET_MAX)).toEqual({ kind: 'refused', reason: 'ambiguous' });
    });

    it.each(['$', '1,000.50', '1.000,5', '1 000', '$$5', '5$€', '--1', '.', ',', '1e2', 'x2'])(
        'readAmount: %j is refused as unreadable',
        (text) => {
            expect(readAmount(text, BUDGET_MAX)).toEqual({ kind: 'refused', reason: 'unreadable' });
        },
    );

    it('readAmount: a blank is blank; above the cap is the cap, marked', () => {
        expect(readAmount('   ', BID_MAX)).toEqual({ kind: 'blank' });
        expect(readAmount('150', BID_MAX)).toEqual({
            kind: 'amount',
            value: BID_MAX,
            capped: true,
        });
        expect(readAmount('99.99', BID_MAX)).toEqual({
            kind: 'amount',
            value: BID_MAX,
            capped: false,
        });
        expect(readAmount('99.995', BID_MAX)).toEqual({
            kind: 'amount',
            value: BID_MAX,
            capped: true,
        });
        expect(readAmount('9'.repeat(60), BUDGET_MAX)).toEqual({
            kind: 'amount',
            value: BUDGET_MAX,
            capped: true,
        });
    });

    it.each([
        [0, '0'],
        [250, '2.5'],
        [225, '2.25'],
        [3000, '30'],
        [5, '0.05'],
        [BID_MAX, '99.99'],
    ])('%i hundredths show as %j', (value, text) => {
        expect(amountText(value)).toBe(text);
    });
});
