// T-S14.3d: the one comma rule of `readAmount` (S14.3d leftover). A comma followed by exactly three digits is
// refused as unclear whatever stands before it: nothing (",500"), zeros ("0,500", "00,500") or other digits
// ("1,500"). Fewer or more digits after the comma read as decimals, as before.
import { describe, expect, it } from 'vitest';
import { BUDGET_MAX, readAmount } from './index';

describe('readAmount: a comma with exactly three digits', () => {
    it.each([',500', '0,500', '00,500', ',000', '1,500', '$,500', ' ,250 '])(
        '%j is refused as unclear',
        (text) => {
            expect(readAmount(text, BUDGET_MAX)).toEqual({ kind: 'refused', reason: 'ambiguous' });
        },
    );

    it.each([
        [',5', 50],
        [',50', 50],
        ['0,5', 50],
        ['0,50', 50],
        [',5000', 50],
        ['0,5000', 50],
        ['.500', 50],
        ['0.500', 50],
    ])('%j reads %i hundredths', (text, value) => {
        expect(readAmount(text, BUDGET_MAX)).toEqual({ kind: 'amount', value, capped: false });
    });

    it('",500" and "0,500" are read the same way', () => {
        expect(readAmount(',500', BUDGET_MAX)).toEqual(readAmount('0,500', BUDGET_MAX));
    });
});
