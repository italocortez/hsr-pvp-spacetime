import { describe, expect, it } from 'vitest';
import { parseStandbySearch } from './standbySearch';

// `/standby` search validator (docs/frontend/pages.md "Standby", A169 plain-text search).
describe('parseStandbySearch', () => {
    it('keeps a non-empty text module as written', () => {
        expect(parseStandbySearch({ module: 'Tournaments' })).toEqual({ module: 'Tournaments' });
        // Plain text: "123" and "true" stay text, never a number or a boolean.
        expect(parseStandbySearch({ module: '123' })).toEqual({ module: '123' });
        expect(parseStandbySearch({ module: 'true' })).toEqual({ module: 'true' });
    });

    it.each([
        ['an empty string', ''],
        ['a repeated key (array)', ['a', 'b']],
        ['a number', 123],
        ['a boolean', true],
        ['null', null],
        ['an object', { name: 'x' }],
    ])('drops %s', (_label, module) => {
        expect(parseStandbySearch({ module }).module).toBeUndefined();
    });

    it('always returns the module key, even when absent or rejected', () => {
        expect(Object.keys(parseStandbySearch({}))).toEqual(['module']);
        expect(Object.keys(parseStandbySearch({ module: ['a', 'b'] }))).toEqual(['module']);
    });

    it('is idempotent and ignores unknown keys', () => {
        for (const input of [{}, { module: 'Lobbies' }, { module: '' }, { other: 'x' }]) {
            const once = parseStandbySearch(input);
            expect(parseStandbySearch(once)).toEqual(once);
        }
    });
});
