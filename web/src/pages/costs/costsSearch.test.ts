import { describe, expect, it } from 'vitest';
import { parseSearch, stringifySearch } from '@/lib/searchParams';
import { type CostsView, parseCostsSearch, parseSetId } from './costsSearch';
import { toSearch, toView } from './costsView';

/* T-COSTS: the `/costs` address validator (user ruling 2026-11-16 item 5). */

const parse = (qs: string) => parseCostsSearch(parseSearch(qs));
/** What the router would write back for an address. */
const roundTrip = (qs: string) => stringifySearch(parse(qs));

describe('costs search: each param', () => {
    it('an empty address is all defaults, every key present and undefined', () => {
        const s = parse('');
        expect(Object.keys(s).sort()).toEqual(
            [
                'dir',
                'draft',
                'el',
                'mode',
                'path',
                'q',
                'rarity',
                'role',
                'set',
                'sort',
                'tab',
            ].sort(),
        );
        expect(Object.values(s).every((v) => v === undefined)).toBe(true);
        expect(toView(s)).toEqual({
            tab: 'characters',
            draft: 'classic',
            mode: 'as',
            set: 0,
            el: [],
            path: [],
            role: [],
            rarity: [],
            q: '',
            sort: 'name',
            dir: 'asc',
        });
    });

    it.each([
        ['tab=lightcones', { tab: 'lightcones' }],
        ['tab=characters', {}],
        ['tab=weapons', {}],
        ['draft=auction', { draft: 'auction' }],
        ['draft=classic', {}],
        ['draft=AUCTION', {}],
        ['mode=moc', { mode: 'moc' }],
        ['mode=aa', { mode: 'aa' }],
        ['mode=as', {}],
        ['mode=pf', {}],
        ['dir=desc', { dir: 'desc' }],
        ['dir=asc', {}],
        ['dir=down', {}],
        ['sort=e3', { sort: 'e3' }],
        ['sort=name', {}],
        ['sort=s3', {}],
        ['tab=lightcones&sort=s3', { tab: 'lightcones', sort: 's3' }],
        ['tab=lightcones&sort=e3', { tab: 'lightcones' }],
        ['q=feet', { q: 'feet' }],
        ['q=%20%20', {}],
        // Stored trimmed.
        ['q=%20pel%20%20', { q: 'pel' }],
        ['q=ruan%20mei', { q: 'ruan mei' }],
        [`q=${'x'.repeat(101)}`, {}],
        [`q=%20${'x'.repeat(100)}%20`, { q: 'x'.repeat(100) }],
    ])('%s', (qs, expected) => {
        const s = parse(qs);
        for (const [k, v] of Object.entries(s)) {
            expect([k, v]).toEqual([k, (expected as Record<string, unknown>)[k]]);
        }
    });

    it.each([
        ['set=7', 7],
        ['set=4294967295', 4294967295],
        ['set=0', undefined],
        ['set=007', undefined],
        ['set=-1', undefined],
        ['set=1.5', undefined],
        ['set=4294967296', undefined],
        ['set=1e3', undefined],
        ['set=abc', undefined],
        ['set=7&set=8', undefined],
    ])('%s gives set %s', (qs, expected) => {
        expect(parse(qs).set).toBe(expected);
    });

    it('parseSetId accepts its own output (a number) again', () => {
        expect(parseSetId(7)).toBe(7);
        expect(parseSetId(0)).toBeUndefined();
    });
});

describe('costs search: repeated keys', () => {
    it('keeps known values once each, in the chip order, and drops the rest', () => {
        const s = parse(
            'el=wind&el=fire&el=fire&el=plasma&path=hunt&path=trailblaze&role=dps&rarity=4&rarity=5',
        );
        expect(s.el).toEqual(['fire', 'wind']);
        expect(s.path).toEqual(['hunt']);
        expect(s.role).toEqual(['dps']);
        expect(s.rarity).toEqual(['5', '4']);
    });

    it('the Light Cones tab drops element and role, and allows 3 stars', () => {
        const s = parse('tab=lightcones&el=fire&role=dps&rarity=3&path=harmony');
        expect(s.el).toBeUndefined();
        expect(s.role).toBeUndefined();
        expect(s.rarity).toEqual(['3']);
        expect(s.path).toEqual(['harmony']);
    });

    it('3 stars is not a character rarity', () => {
        expect(parse('rarity=3').rarity).toBeUndefined();
        expect(parse('rarity=3&rarity=4').rarity).toEqual(['4']);
    });

    it('a single value or a repeated scalar key: the scalar is dropped when repeated', () => {
        expect(parse('tab=lightcones&tab=lightcones').tab).toBeUndefined();
        expect(parse('q=a&q=b').q).toBeUndefined();
    });
});

describe('costs search: defaults omitted, idempotent, round trip', () => {
    it('defaults are left out of the address', () => {
        expect(roundTrip('tab=characters&draft=classic&mode=as&sort=name&dir=asc&set=0')).toBe('');
    });

    it('the validator accepts its own output (the router runs it again)', () => {
        const once = parse(
            'tab=lightcones&draft=auction&mode=aa&set=12&path=harmony&path=hunt&rarity=3&q=psim&sort=s2&dir=desc',
        );
        expect(parseCostsSearch(once as Record<string, unknown>)).toEqual(once);
    });

    it('round trip: a full address comes back the same (keys sorted, repeated keys)', () => {
        const qs =
            '?dir=desc&draft=auction&el=fire&el=ice&mode=moc&path=hunt&q=feet&rarity=5&role=dps&set=3&sort=e6';
        expect(roundTrip(qs)).toBe(qs);
    });

    it('toSearch inverts toView', () => {
        const view: CostsView = {
            tab: 'lightcones',
            draft: 'auction',
            mode: 'aa',
            set: 9,
            el: [],
            path: ['harmony'],
            role: [],
            rarity: ['3'],
            q: 'cogs',
            sort: 's5',
            dir: 'desc',
        };
        expect(toView(toSearch(view))).toEqual(view);
        expect(toSearch(toView({}))).toEqual(parse(''));
    });

    it('user text stays text: markup in q is kept as typed, never interpreted here', () => {
        expect(parse('q=%3Cimg%20src%3Dx%3E').q).toBe('<img src=x>');
    });
});
