import { describe, expect, it } from 'vitest';
import { assertDevTarget, DEV_PROD_REFUSAL } from './assertDevTarget';

/* The dev-against-prod refusal (user decision 2026-11-13). */
describe('assertDevTarget', () => {
    it('dev with the prod target throws the refusal', () => {
        expect(() => assertDevTarget(true, 'prod')).toThrow(DEV_PROD_REFUSAL);
        expect(DEV_PROD_REFUSAL).toBe(
            'Dev mode cannot run against the prod database. Set VITE_STDB_TARGET=test.',
        );
    });

    it.each([
        ['dev', true, 'test'],
        ['build', false, 'prod'],
        ['build', false, 'test'],
    ] as const)('%s with %s does not throw', (_label, isDev, target) => {
        expect(() => assertDevTarget(isDev, target)).not.toThrow();
    });
});
