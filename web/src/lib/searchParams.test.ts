import { describe, expect, it } from 'vitest';
import { parseSearch, stringifySearch } from './searchParams';

// Plain-text search params (A169, docs/frontend/pages.md "Search params are plain text").
describe('parseSearch', () => {
    it('reads single values as text, never as numbers or booleans', () => {
        expect(parseSearch('?a=1&b=x&c=true')).toEqual({ a: '1', b: 'x', c: 'true' });
    });

    it('turns a repeated key into an array in URL order', () => {
        expect(parseSearch('?el=fire&el=ice&el=wind')).toEqual({ el: ['fire', 'ice', 'wind'] });
    });

    it('decodes + and %20 as a space', () => {
        expect(parseSearch('?a=Team+Builder&b=Team%20Builder')).toEqual({
            a: 'Team Builder',
            b: 'Team Builder',
        });
    });

    it('accepts a search string without the leading ?', () => {
        expect(parseSearch('a=1')).toEqual({ a: '1' });
    });

    it('treats a __proto__ key as plain data', () => {
        const key = '__proto__';
        const out = parseSearch(`?${key}=x&a=1`);
        expect(Object.getPrototypeOf(out)).toBeNull();
        expect(Object.keys(out).sort()).toEqual([key, 'a']);
        expect(out[key]).toBe('x');
        // Nothing leaked onto Object.prototype.
        expect(({} as Record<string, unknown>).x).toBeUndefined();
    });

    it('gives an empty object for an empty search', () => {
        expect(Object.keys(parseSearch(''))).toEqual([]);
    });
});

describe('stringifySearch', () => {
    it('writes keys sorted', () => {
        expect(stringifySearch({ b: 'y', a: 'x', c: 'z' })).toBe('?a=x&b=y&c=z');
    });

    it('leaves out empty strings, undefined and null', () => {
        expect(stringifySearch({ a: '', b: undefined, c: null, d: 'x' })).toBe('?d=x');
    });

    it('writes an array as a repeated key and drops empty items', () => {
        expect(stringifySearch({ el: ['fire', '', 'ice'] })).toBe('?el=fire&el=ice');
    });

    it('writes finite numbers and booleans as their text', () => {
        expect(stringifySearch({ a: 1, b: -2.5, c: true, d: false, e: 0 })).toBe(
            '?a=1&b=-2.5&c=true&d=false&e=0',
        );
    });

    it('leaves out NaN, Infinity, objects and other non-text values', () => {
        expect(
            stringifySearch({
                a: Number.NaN,
                b: Number.POSITIVE_INFINITY,
                c: Number.NEGATIVE_INFINITY,
                d: { x: 1 },
                e: 1n,
                f: Symbol('s'),
                g: () => 1,
            }),
        ).toBe('');
    });

    it('returns an empty string, not "?", when nothing remains', () => {
        expect(stringifySearch({})).toBe('');
        expect(stringifySearch({ a: undefined, b: '' })).toBe('');
    });

    it('encodes values so they read back unchanged', () => {
        expect(stringifySearch({ next: '/lobby/123?tab=a#x' })).toBe(
            '?next=%2Flobby%2F123%3Ftab%3Da%23x',
        );
    });
});

describe('round trip', () => {
    it.each([
        ['?a=1&b=x'],
        ['?el=fire&el=ice'],
        ['?module=Team+Builder'],
        ['?login=1&next=%2Flobby%2F123'],
        ['?x=%26%3D%3F%23'],
    ])('parse then stringify is stable for %s', (search) => {
        const once = stringifySearch(parseSearch(search));
        expect(once).toBe(search);
        expect(stringifySearch(parseSearch(once))).toBe(once);
    });

    it('stringify then parse gives the values back as text', () => {
        const written = stringifySearch({ login: 1, next: '/profile', el: ['fire', 'ice'] });
        expect(parseSearch(written)).toEqual({ el: ['fire', 'ice'], login: '1', next: '/profile' });
    });
});
