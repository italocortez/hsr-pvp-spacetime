import type { Archetype, HsrCharacterArchetype } from '@bindings/types';
import { describe, expect, it } from 'vitest';
import { buildCostLookup, rowsOfSet } from '@/stdb/costLookup';
import {
    CHARACTERS,
    character,
    characterCost,
    costSet,
    LIGHTCONES,
    lightconeCost,
    synergy,
} from '@/test/costFixtures';
import {
    activeFilterCount,
    archetypeNamesByCharacter,
    archetypeOptions,
    buildCharacterRows,
    buildLightconeRows,
    costSetsForMode,
    countNoun,
    filterCharacterRows,
    filterLightconeRows,
    formatCost,
    formatModifier,
    matchesSearch,
    nextSort,
    sortRows,
    synergyPartners,
} from './costModel';

/* T-COSTS: the costs page's view model as pure functions. */

const AS_CLASSIC = { gameMode: 'ApocalypticShadow', draftMode: 'Classic' } as const;
const byName = new Map(CHARACTERS.map((c) => [c.name, c] as const));
const NO_FILTERS = { el: [], path: [], role: [], rarity: [], arch: [], q: '' };
const aliasesOf = (name: string) =>
    byName.get(name)?.aliases ?? LIGHTCONES.find((l) => l.name === name)?.aliases ?? [];

function lookupOf(rows: {
    chars?: ReturnType<typeof characterCost>[];
    lcs?: ReturnType<typeof lightconeCost>[];
    syn?: ReturnType<typeof synergy>[];
}) {
    return buildCostLookup(rows.chars ?? [], rows.lcs ?? [], rows.syn ?? []);
}

describe('joining rows by name and mode', () => {
    it('a character takes the cost row of its name, game mode and draft mode', () => {
        const lookup = lookupOf({
            chars: [
                characterCost('acheron', 7),
                characterCost('acheron', 1, { mode: 'MemoryOfChaos' }),
                characterCost('acheron', 2, { draft: 'Auction' }),
            ],
        });
        const rows = buildCharacterRows(CHARACTERS, lookup, AS_CLASSIC, byName);
        expect(rows.find((r) => r.name === 'acheron')?.costs?.e0).toBe(7);
        const moc = buildCharacterRows(
            CHARACTERS,
            lookup,
            { gameMode: 'MemoryOfChaos', draftMode: 'Classic' },
            byName,
        );
        expect(moc.find((r) => r.name === 'acheron')?.costs?.e0).toBe(1);
    });

    it('a character with no row for the selection has no costs (shown as n/a)', () => {
        const rows = buildCharacterRows(CHARACTERS, lookupOf({}), AS_CLASSIC, byName);
        expect(rows.every((r) => r.costs === undefined)).toBe(true);
    });

    it('light cones join the same way', () => {
        const lookup = lookupOf({ lcs: [lightconeCost('meshingcogs', 0.5)] });
        const rows = buildLightconeRows(LIGHTCONES, lookup, AS_CLASSIC);
        expect(rows.find((r) => r.name === 'meshingcogs')?.costs?.s5).toBe(2.5);
        expect(rows.find((r) => r.name === 'pastselfinmirror')?.costs).toBeUndefined();
    });

    it('the client filters by costSetId when the cache holds several sets', () => {
        const cache = [characterCost('acheron', 7), characterCost('acheron', 9, { set: 4 })];
        const lookup = buildCostLookup(rowsOfSet(cache, 4), [], []);
        const rows = buildCharacterRows(CHARACTERS, lookup, AS_CLASSIC, byName);
        expect(rows.find((r) => r.name === 'acheron')?.costs?.e0).toBe(9);
        expect(rowsOfSet(cache, 0)).toEqual([cache[0]]);
    });
});

describe('formatting', () => {
    it.each([
        [3, '3'],
        [1.5, '1.5'],
        // f32 values as the SDK decodes them.
        [Math.fround(2.7), '2.7'],
        [Math.fround(0.1), '0.1'],
        [12, '12'],
        [-2, '−2'],
        [-0.5, '−0.5'],
        [-0.01, '0'],
    ])('cost %s shows as %s (a negative one with a real minus sign)', (v, text) => {
        expect(formatCost(v)).toBe(text);
    });

    it.each([
        [3, '+3'],
        [0.5, '+0.5'],
        [-1, '\u22121'],
        [-0.5, '\u22120.5'],
    ])('modifier %s shows as %s (a real minus sign, never "+-")', (v, text) => {
        expect(formatModifier(v)).toBe(text);
        expect(formatModifier(v)).not.toContain('+-');
    });
});

describe('synergies', () => {
    it('a pair shows under both characters', () => {
        const map = synergyPartners([synergy('acheron', 'pela', 1.5)], byName);
        expect(map.get('acheron')?.map((p) => p.name)).toEqual(['pela']);
        expect(map.get('pela')?.map((p) => p.name)).toEqual(['acheron']);
        expect(map.get('pela')?.[0]?.displayName).toBe('Acheron');
        expect(map.get('pela')?.[0]?.modifier).toBe(1.5);
    });

    it('a zero modifier is hidden; a negative one is kept', () => {
        const map = synergyPartners(
            [synergy('acheron', 'pela', 0), synergy('clara', 'huohuo', -1)],
            byName,
        );
        expect(map.has('acheron')).toBe(false);
        expect(map.get('clara')?.[0]?.modifier).toBe(-1);
    });

    it('per draft mode: only the selected mode pair lists its synergies', () => {
        const lookup = lookupOf({
            syn: [
                synergy('acheron', 'pela', 2),
                synergy('clara', 'huohuo', 3, { draft: 'Auction' }),
            ],
        });
        const classic = buildCharacterRows(CHARACTERS, lookup, AS_CLASSIC, byName);
        expect(classic.find((r) => r.name === 'acheron')?.synergies).toHaveLength(1);
        expect(classic.find((r) => r.name === 'clara')?.synergies).toHaveLength(0);
        const auction = buildCharacterRows(
            CHARACTERS,
            lookup,
            { gameMode: 'ApocalypticShadow', draftMode: 'Auction' },
            byName,
        );
        expect(auction.find((r) => r.name === 'acheron')?.synergies).toHaveLength(0);
        expect(auction.find((r) => r.name === 'huohuo')?.synergies[0]?.name).toBe('clara');
    });

    it('a duplicate pair (the same row twice, or both orders) lists the partner once', () => {
        const map = synergyPartners(
            [
                synergy('acheron', 'pela', 1.5),
                synergy('acheron', 'pela', 1.5),
                synergy('pela', 'acheron', 2),
            ],
            byName,
        );
        expect(map.get('acheron')).toEqual([
            expect.objectContaining({ name: 'pela', modifier: 1.5 }),
        ]);
        expect(map.get('pela')).toEqual([
            expect.objectContaining({ name: 'acheron', modifier: 1.5 }),
        ]);
    });

    it('a partner missing from the roster keeps its key as the name and no image', () => {
        const map = synergyPartners([synergy('acheron', 'ghost', 1)], byName);
        expect(map.get('acheron')?.[0]).toMatchObject({ displayName: 'ghost', imageUrl: '' });
    });
});

describe('filters', () => {
    const rows = buildCharacterRows(CHARACTERS, lookupOf({}), AS_CLASSIC, byName);
    const names = (list: { name: string }[]) => list.map((r) => r.name).sort();

    it('OR within a group', () => {
        expect(
            names(filterCharacterRows(rows, { ...NO_FILTERS, el: ['ice', 'wind'] }, aliasesOf)),
        ).toEqual(['huohuo', 'pela']);
    });

    it('AND across groups', () => {
        expect(
            names(
                filterCharacterRows(
                    rows,
                    { ...NO_FILTERS, path: ['nihility'], rarity: ['5'] },
                    aliasesOf,
                ),
            ),
        ).toEqual(['acheron']);
        expect(
            names(
                filterCharacterRows(
                    rows,
                    { ...NO_FILTERS, role: ['support'], el: ['wind'] },
                    aliasesOf,
                ),
            ),
        ).toEqual([]);
    });

    it('search matches the display name and the aliases only, never the internal key', () => {
        const entry = { name: 'march7ththehunt', displayName: 'March 7th' };
        expect(matchesSearch(entry, ['march7'], 'march 7')).toBe(true);
        expect(matchesSearch(entry, ['march7'], 'MARCH7')).toBe(true);
        expect(matchesSearch(entry, ['march7'], 'thehunt')).toBe(false);
        // Nothing else of the row is searched (element, path, role).
        expect(matchesSearch({ displayName: 'Pela' }, ['pela'], 'ice')).toBe(false);
    });

    it('search: case-insensitive substring of display name or alias, joke aliases included', () => {
        expect(names(filterCharacterRows(rows, { ...NO_FILTERS, q: 'FEET' }, aliasesOf))).toEqual([
            'clara',
        ]);
        expect(names(filterCharacterRows(rows, { ...NO_FILTERS, q: 'cher' }, aliasesOf))).toEqual([
            'acheron',
        ]);
        expect(names(filterCharacterRows(rows, { ...NO_FILTERS, q: '  pel ' }, aliasesOf))).toEqual(
            ['pela'],
        );
        expect(matchesSearch({ displayName: 'Ruan Mei' }, [], 'ruan m')).toBe(true);
    });

    it('light cones: path, rarity (3 stars too) and search apply', () => {
        const lcs = buildLightconeRows(LIGHTCONES, lookupOf({}), AS_CLASSIC);
        expect(
            names(filterLightconeRows(lcs, { ...NO_FILTERS, rarity: ['3'] }, aliasesOf)),
        ).toEqual(['meshingcogs']);
        expect(names(filterLightconeRows(lcs, { ...NO_FILTERS, q: 'psim' }, aliasesOf))).toEqual([
            'pastselfinmirror',
        ]);
        expect(
            names(filterLightconeRows(lcs, { ...NO_FILTERS, path: ['destruction'] }, aliasesOf)),
        ).toEqual(['nowheretorun']);
    });

    it('"Clear N" counts every chip that is on, plus one for the search', () => {
        expect(activeFilterCount(NO_FILTERS)).toBe(0);
        expect(
            activeFilterCount({ ...NO_FILTERS, el: ['fire', 'ice'], rarity: ['5'], q: 'x' }),
        ).toBe(4);
        expect(activeFilterCount({ ...NO_FILTERS, q: '   ' })).toBe(0);
    });
});

describe('sorting', () => {
    const roster = [
        character('b', 'Bravo', { rarity: 4 }),
        character('a', 'Alpha'),
        character('c', 'Charlie'),
        character('d', 'Delta'),
    ];
    const lookup = lookupOf({
        chars: [characterCost('a', 5), characterCost('b', 5), characterCost('c', 3)],
    });
    const rows = buildCharacterRows(roster, lookup, AS_CLASSIC, new Map());
    const order = (key: Parameters<typeof sortRows>[1], dir: 'asc' | 'desc') =>
        sortRows(rows, key, dir).map((r) => r.name);

    it('by name ascending is the default order', () => {
        expect(order('name', 'asc')).toEqual(['a', 'b', 'c', 'd']);
        expect(order('name', 'desc')).toEqual(['d', 'c', 'b', 'a']);
    });

    it('costs sort as numbers; equal costs keep the name order in both directions (tie-break)', () => {
        expect(order('e0', 'asc')).toEqual(['c', 'a', 'b', 'd']);
        expect(order('e0', 'desc')).toEqual(['a', 'b', 'c', 'd']);
    });

    it('a missing cost row sorts last in both directions', () => {
        expect(order('e6', 'asc').at(-1)).toBe('d');
        expect(order('e6', 'desc').at(-1)).toBe('d');
    });

    it('rarity sorts as a number', () => {
        expect(order('rarity', 'asc')[0]).toBe('b');
    });

    it('a header click: same column flips, a new column starts descending, the name ascending', () => {
        expect(nextSort({ sort: 'name', dir: 'asc' }, 'name')).toEqual({
            sort: 'name',
            dir: 'desc',
        });
        expect(nextSort({ sort: 'name', dir: 'asc' }, 'e3')).toEqual({ sort: 'e3', dir: 'desc' });
        expect(nextSort({ sort: 'e3', dir: 'desc' }, 'e3')).toEqual({ sort: 'e3', dir: 'asc' });
        expect(nextSort({ sort: 'e3', dir: 'desc' }, 'name')).toEqual({ sort: 'name', dir: 'asc' });
    });
});

describe('cost sets and wording', () => {
    it('lists the published sets of the selected game mode, by name', () => {
        const sets = [
            costSet(3, 'Zeta', { mode: 'ApocalypticShadow' }),
            costSet(2, 'Alpha', { mode: 'ApocalypticShadow', locked: true }),
            costSet(4, 'Moc only', { mode: 'MemoryOfChaos' }),
        ];
        expect(costSetsForMode(sets, 'as').map((s) => s.id)).toEqual([2, 3]);
        expect(costSetsForMode(sets, 'moc').map((s) => s.id)).toEqual([4]);
        expect(costSetsForMode(sets, 'aa')).toEqual([]);
    });

    it('the count noun has a singular', () => {
        expect(countNoun('characters', 1)).toBe('unit');
        expect(countNoun('characters', 2)).toBe('units');
        expect(countNoun('lightcones', 1)).toBe('light cone');
        expect(countNoun('lightcones', 0)).toBe('light cones');
    });
});

describe('archetypes (S14.2b)', () => {
    const arch = (id: number, name: string) => ({ id, name }) as unknown as Archetype;
    const link = (characterName: string, archetypeId: number) =>
        ({ characterName, archetypeId }) as unknown as HsrCharacterArchetype;
    const ARCHETYPES = [arch(1, 'Break'), arch(2, 'DoT'), arch(3, 'FuA'), arch(4, 'Debuff')];
    const LINKS = [link('acheron', 4), link('clara', 3), link('pela', 4), link('pela', 1)];
    const map = archetypeNamesByCharacter(ARCHETYPES, LINKS);
    const rows = buildCharacterRows(CHARACTERS, lookupOf({}), AS_CLASSIC, byName, map);
    const names = (list: { name: string }[]) => list.map((r) => r.name).sort();
    const only = (arch: string[]) =>
        names(filterCharacterRows(rows, { ...NO_FILTERS, arch }, aliasesOf));

    it('names per character from the links; a link to a missing archetype or a repeat is skipped', () => {
        const m = archetypeNamesByCharacter(ARCHETYPES, [
            ...LINKS,
            link('pela', 99),
            link('pela', 1),
        ]);
        expect(m.get('pela')).toEqual(['Debuff', 'Break']);
        expect(m.has('huohuo')).toBe(false);
        expect(rows.find((r) => r.name === 'huohuo')?.archetypes).toEqual([]);
    });

    it('the options: every name, alphabetically (case-insensitive)', () => {
        expect(archetypeOptions([...ARCHETYPES, arch(5, 'basic ATK DMG')])).toEqual([
            'basic ATK DMG',
            'Break',
            'Debuff',
            'DoT',
            'FuA',
        ]);
    });

    it('OR within the group; a character with several archetypes; one with none never matches', () => {
        expect(only([])).toEqual(['acheron', 'clara', 'huohuo', 'pela']);
        expect(only(['Debuff'])).toEqual(['acheron', 'pela']);
        expect(only(['Break'])).toEqual(['pela']);
        expect(only(['FuA', 'Break'])).toEqual(['clara', 'pela']);
        expect(only(['Break', 'Debuff', 'DoT', 'FuA'])).toEqual(['acheron', 'clara', 'pela']);
    });

    it('AND with the other groups', () => {
        expect(
            names(
                filterCharacterRows(
                    rows,
                    { ...NO_FILTERS, arch: ['Debuff'], el: ['ice'] },
                    aliasesOf,
                ),
            ),
        ).toEqual(['pela']);
    });

    it('light cones ignore it; "Clear N" counts each name', () => {
        const lcs = buildLightconeRows(LIGHTCONES, lookupOf({}), AS_CLASSIC);
        expect(
            filterLightconeRows(lcs, { ...NO_FILTERS, arch: ['Break'] }, aliasesOf),
        ).toHaveLength(3);
        expect(activeFilterCount({ ...NO_FILTERS, arch: ['Break', 'DoT'], q: 'x' })).toBe(3);
    });
});
