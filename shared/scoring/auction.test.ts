// T-S14.3a-fix (review M1): the Auction eidolon extra in the module's order. The module's rule
// (`auctionEidolonExtra` in spacetimedb/src/reducers/draft/draftAuction.ts) is
//     Math.max(0, costAt(e) - costAt(0))
// on the stored f32 costs; the value becomes hundredths only afterwards. `moduleRule` below is that line, written
// out here so the shared function is pinned to its shape: subtract the stored values, clamp, then round once.
import { describe, expect, it } from 'vitest';
import { auctionEidolonExtra, eidolonExtra, toHundredths } from './index';

const f32 = Math.fround;
const moduleRule = (atE0: number, atE: number) => Math.max(0, atE - atE0);

describe('auctionEidolonExtra', () => {
    it('is the module rule rounded once, for every pair on a fine grid of f32 costs', () => {
        let differsWhenRoundedFirst = 0;
        for (let a = 0; a <= 1200; a += 7) {
            for (let b = 0; b <= 1200; b += 11) {
                const atE0 = f32(a / 1000 + 4);
                const atE = f32(b / 1000 + 4);
                const shared = auctionEidolonExtra(atE0, atE);
                expect(shared).toBe(toHundredths(moduleRule(atE0, atE)));
                if (shared !== eidolonExtra(toHundredths(atE0), toHundredths(atE)))
                    differsWhenRoundedFirst += 1;
            }
        }
        // The grid holds costs with more than two decimals, where rounding first gives another answer: the test
        // would catch the old order.
        expect(differsWhenRoundedFirst).toBeGreaterThan(0);
    });

    it('a cheaper eidolon adds nothing; equal costs add nothing', () => {
        expect(auctionEidolonExtra(f32(8), f32(5))).toBe(0);
        expect(auctionEidolonExtra(f32(7.5), f32(7.5))).toBe(0);
    });

    it('seed-like costs (halves) give the plain difference', () => {
        expect(auctionEidolonExtra(f32(8), f32(11))).toBe(300);
        expect(auctionEidolonExtra(f32(10), f32(13.5))).toBe(350);
    });

    it('a cost finer than a hundredth: the module order gives 1, rounding first would give 0', () => {
        // 0.014 - 0.006 = 0.008 -> 1 hundredth (the module); rounded first, both are 1 hundredth -> 0.
        const atE0 = f32(0.006);
        const atE = f32(0.014);
        expect(auctionEidolonExtra(atE0, atE)).toBe(toHundredths(moduleRule(atE0, atE)));
        expect(auctionEidolonExtra(atE0, atE)).toBe(1);
        expect(eidolonExtra(toHundredths(atE0), toHundredths(atE))).toBe(0);
    });
});
