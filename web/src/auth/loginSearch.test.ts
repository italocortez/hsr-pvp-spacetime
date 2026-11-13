import { describe, expect, it } from 'vitest';
import { parseLoginSearch, safeNextPath } from './loginSearch';

// The `next` rule (docs/frontend/pages.md, "The `next` rule"; A166 to A169).
describe('safeNextPath', () => {
    const atLimit = `/${'a'.repeat(2047)}`;
    const overLimit = `/${'a'.repeat(2048)}`;

    it.each([
        ['/profile'],
        ['/lobby/123?tab=a#x'],
        ['/'],
        // A same-site path whose first segment starts with `@`: still a path, not a host.
        ['/@evil.example'],
        [atLimit],
    ])('keeps the same-site path %j', (value) => {
        expect(safeNextPath(value)).toBe(value);
    });

    it('accepts exactly 2048 characters', () => {
        expect(atLimit).toHaveLength(2048);
        expect(safeNextPath(atLimit)).toBe(atLimit);
    });

    it.each([
        ['protocol-relative', '//host'],
        ['backslash read as a slash', '/\\host'],
        ['tab stripped by browsers', '/\t/host'],
        ['CR stripped by browsers', '/\r/host'],
        ['LF stripped by browsers', '/\n/host'],
        ['NUL', '/a\u0000b'],
        ['U+000B (vertical tab)', '/a\u000bb'],
        ['U+001F (last C0 control)', '/a\u001fb'],
        ['U+007F (DEL)', '/a\u007fb'],
        ['a backslash mid-string', '/a\\b'],
        ['absolute URL', 'https://host'],
        ['javascript: URL', 'javascript:alert(1)'],
        ['empty string', ''],
        ['2049 characters', overLimit],
    ])('drops %s', (_label, value) => {
        expect(safeNextPath(value)).toBeUndefined();
    });

    it.each([
        ['a number', 1],
        ['a boolean', true],
        ['null', null],
        ['undefined', undefined],
        ['an object', { path: '/profile' }],
        ['an array (repeated key)', ['/profile']],
        ['an array of two', ['/profile', '/lobby']],
    ])('drops %s', (_label, value) => {
        expect(safeNextPath(value)).toBeUndefined();
    });
});

describe('parseLoginSearch', () => {
    it('reads the text "1" and the number 1 as login 1', () => {
        expect(parseLoginSearch({ login: '1' }).login).toBe(1);
        expect(parseLoginSearch({ login: 1 }).login).toBe(1);
    });

    it.each([
        ['"2"', '2'],
        ['the number 2', 2],
        ['"true"', 'true'],
        ['true', true],
        ['an array', ['1']],
        ['an empty string', ''],
    ])('drops login %s', (_label, login) => {
        expect(parseLoginSearch({ login }).login).toBeUndefined();
    });

    it('keeps a safe next and drops an unsafe or repeated one', () => {
        expect(parseLoginSearch({ next: '/profile' }).next).toBe('/profile');
        expect(parseLoginSearch({ next: '//evil.example' }).next).toBeUndefined();
        expect(parseLoginSearch({ next: ['/a', '/b'] }).next).toBeUndefined();
    });

    it('always returns both keys, even when they are rejected or absent', () => {
        // The router merges the raw search under the validated one: a missing key would let the
        // raw value through.
        for (const input of [{}, { login: '2', next: '//x' }, { login: '1', next: '/a' }]) {
            const out = parseLoginSearch(input);
            expect(Object.keys(out).sort()).toEqual(['login', 'next']);
        }
    });

    it('is idempotent: its own output validates to the same value', () => {
        const inputs: Record<string, unknown>[] = [
            {},
            { login: '1', next: '/lobby/123?tab=a#x' },
            { login: '2', next: '//evil.example' },
            { login: 1 },
        ];
        for (const input of inputs) {
            const once = parseLoginSearch(input);
            expect(parseLoginSearch(once)).toEqual(once);
        }
    });

    it('ignores unknown keys', () => {
        expect(parseLoginSearch({ login: '1', other: 'x' })).toEqual({ login: 1, next: undefined });
    });
});
