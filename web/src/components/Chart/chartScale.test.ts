// T-S14.5c: the shared chart's value axis (moved from StackedBarChart/chartScale.test.ts with the module; `share`
// stayed behind with the CSS chart, Chart.js places the bars itself).
import { describe, expect, it } from 'vitest';
import { chartScale } from './chartScale';

describe('chartScale', () => {
    it.each([
        [1250, { max: 1500, step: 500, lines: 3 }],
        [1000, { max: 1000, step: 250, lines: 4 }],
        [1, { max: 1, step: 0.25, lines: 4 }],
        [3800, { max: 4000, step: 1000, lines: 4 }],
        [999_999, { max: 1_000_000, step: 250_000, lines: 4 }],
        [7, { max: 8, step: 2, lines: 4 }],
    ])('%d -> %j', (largest, expected) => {
        expect(chartScale(largest)).toEqual(expected);
    });

    it('no value draws a plain grid', () => {
        expect(chartScale(0)).toEqual({ max: 4, step: 1, lines: 4 });
        expect(chartScale(Number.NaN)).toEqual({ max: 4, step: 1, lines: 4 });
        expect(chartScale(-3)).toEqual({ max: 4, step: 1, lines: 4 });
    });

    it('the top is never below the largest value', () => {
        for (const v of [3, 13, 17, 99, 101, 333, 1234, 9999, 12_345]) {
            const s = chartScale(v);
            expect(s.max).toBeGreaterThanOrEqual(v);
            expect(s.lines).toBeLessThanOrEqual(4);
        }
    });
});
