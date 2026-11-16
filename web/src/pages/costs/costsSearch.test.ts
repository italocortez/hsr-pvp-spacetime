import { describe, expect, it } from 'vitest';
import { parseSearch, stringifySearch } from '@/lib/searchParams';
import { ARCH_MAX, type CostsView, parseCostsSearch, parseSetId } from './costsSearch';
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
                'arch',
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
            arch: [],
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
            arch: [],
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

describe('costs search: arch (S14.2b)', () => {
    it('archetype names, repeated, each once, in code-point order', () => {
        expect(parse('arch=FuA&arch=Debuff&arch=FuA').arch).toEqual(['Debuff', 'FuA']);
        expect(parse('arch=Basic+ATK+DMG').arch).toEqual(['Basic ATK DMG']);
    });

    it('drops what an archetype name cannot be: blank, padded, too long, control characters', () => {
        expect(parse('arch=&arch=%20FuA&arch=a%0Ab').arch).toBeUndefined();
        expect(parse(`arch=${'x'.repeat(64)}`).arch).toEqual(['x'.repeat(64)]);
        expect(parse(`arch=${'x'.repeat(65)}`).arch).toBeUndefined();
    });

    it('keeps at most ARCH_MAX names', () => {
        const many = Array.from(
            { length: ARCH_MAX + 5 },
            (_, i) => `arch=a${String(i).padStart(2, '0')}`,
        );
        expect(parse(many.join('&')).arch).toHaveLength(ARCH_MAX);
    });

    it('the limit applies after sorting: the first ARCH_MAX names in code-point order are kept', () => {
        const names = Array.from(
            { length: ARCH_MAX + 5 },
            (_, i) => `a${String(i).padStart(2, '0')}`,
        );
        // Given in reverse order: a limit taken before sorting would keep the last names.
        const qs = [...names].reverse().map((n) => `arch=${n}`);
        expect(parse(qs.join('&')).arch).toEqual(names.slice(0, ARCH_MAX));
    });

    it('characters only: the Light Cones tab drops it', () => {
        expect(parse('tab=lightcones&arch=FuA').arch).toBeUndefined();
    });

    it('unknown names are kept here (the page drops them once the list is known)', () => {
        expect(parse('arch=Nope').arch).toEqual(['Nope']);
    });

    it('round trip and idempotence', () => {
        const qs = '?arch=Break&arch=Debuff&el=ice';
        expect(roundTrip(qs)).toBe(qs);
        const once = parse('arch=FuA&arch=Break');
        expect(parseCostsSearch(once as Record<string, unknown>)).toEqual(once);
        expect(toView(toSearch({ ...toView({}), arch: ['FuA'] })).arch).toEqual(['FuA']);
    });
});
