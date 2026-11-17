import { decodeTeam } from '@shared/teambuilder';
import { describe, expect, it } from 'vitest';
import { parseSearch, stringifySearch } from '@/lib/searchParams';
import { parseTeamBuilderSearch, UNREADABLE_TEAM } from './teambuilderSearch';
import { toSearch, toView } from './teambuilderView';

/* T-S14.3a: the /teambuilder validator: kept and dropped values, idempotence, defaults out of the address. */

const parse = (qs: string) => parseTeamBuilderSearch(parseSearch(qs));

describe('parseTeamBuilderSearch', () => {
    it('keeps valid values in canonical order and drops defaults', () => {
        expect(
            parse('?draft=auction&mode=aa&set=7&el=ice&el=fire&rarity=4&arch=Debuff&q=%20pel%20'),
        ).toEqual({
            draft: 'auction',
            mode: 'aa',
            set: 7,
            el: ['fire', 'ice'],
            path: undefined,
            role: undefined,
            rarity: ['4'],
            arch: ['Debuff'],
            q: 'pel',
            team: undefined,
        });
        expect(parse('?draft=classic&mode=as&set=0')).toMatchObject({
            draft: undefined,
            mode: undefined,
            set: undefined,
        });
    });

    it.each([
        ['?mode=pf', 'mode'],
        ['?set=007', 'set'],
        ['?set=4294967296', 'set'],
        ['?rarity=3', 'rarity'],
        ['?el=wood', 'el'],
        ['?q=', 'q'],
    ])('%s drops %s', (qs, key) => {
        expect((parse(qs) as Record<string, unknown>)[key]).toBeUndefined();
    });

    // T-S14.3a-fix (review S2): a team that is given but cannot be one is kept as the unreadable marker, so the page
    // says so instead of dropping it in silence; the marker itself never decodes and is stable.
    it.each([
        ['upper case', '?team=1.Firefly-0._._._.as-c-0-0-0'],
        ['percent encoding', '?team=a%20b'],
        ['over 400 characters', `?team=${'a'.repeat(401)}`],
        ['given twice', '?team=a&team=b'],
        ['a trailing parenthesis from a chat app', '?team=1._._._._.as-c-0-0-0)'],
        ['markup', '?team=%3Cimg%20src%3Dx%3E'],
        ['empty', '?team='],
    ])('a team with %s becomes the unreadable marker', (_name, qs) => {
        const parsed = parse(qs);
        expect(parsed.team).toBe(UNREADABLE_TEAM);
        expect(parseTeamBuilderSearch(parsed as Record<string, unknown>).team).toBe(
            UNREADABLE_TEAM,
        );
        expect(decodeTeam(parsed.team).ok).toBe(false);
    });

    it('no team given: no marker', () => {
        expect(parse('?mode=moc').team).toBeUndefined();
    });

    it('keeps a team text of the right alphabet and length (decoded later by the page)', () => {
        expect(parse('?team=1.firefly-0._._._.as-c-0-3000-1500').team).toBe(
            '1.firefly-0._._._.as-c-0-3000-1500',
        );
    });

    it('is idempotent and round trips through the view (team excluded)', () => {
        const once = parse('?mode=moc&path=hunt&role=dps&q=x&team=1._._._._.as-c-0-0-0');
        expect(parseTeamBuilderSearch(once as Record<string, unknown>)).toEqual(once);
        const view = toView(once);
        expect(toSearch(view)).toEqual({ ...once, team: undefined });
        expect(stringifySearch(toSearch(view))).toBe('?mode=moc&path=hunt&q=x&role=dps');
    });
});
