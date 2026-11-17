import { describe, expect, it } from 'vitest';
import { LIMIT, lightconeCandidates } from './lightconeCandidates';

/* T-S14.3a: the light cone picker's list: signature first, the character's path, search, the cap. */

const cone = (name: string, path: string, rarity: number, aliases: string[] = [name]) => ({
    name,
    displayName: name,
    rarity,
    aliases,
    path: { tag: path },
});

const CONES = [
    cone('a4harmony', 'Harmony', 4),
    cone('b5nihility', 'Nihility', 5),
    cone('c3nihility', 'Nihility', 3),
    cone('d5harmony', 'Harmony', 5, ['d5harmony', 'ruanmei']),
    cone('e4nihility', 'Nihility', 4),
];
const RUAN_MEI = {
    displayName: 'Ruan Mei',
    aliases: ['ruanmei'],
    rarity: 5,
    path: { tag: 'Harmony' },
};
const PELA = { displayName: 'Pela', aliases: ['pela'], rarity: 4, path: { tag: 'Nihility' } };
const names = (list: { cone: { name: string } }[]) => list.map((c) => c.cone.name);

describe('lightconeCandidates', () => {
    // T-S14.3a-fix: the empty search follows the mockup's panel ("Start typing to search…" and the signature only).
    it('empty search: the signature only (the mockup), marked as the signature', () => {
        const list = lightconeCandidates('', RUAN_MEI, CONES);
        expect(names(list)).toEqual(['d5harmony']);
        expect(list[0]?.signature).toBe(true);
    });

    it('empty search for a 4-star: nothing (no signature)', () => {
        expect(names(lightconeCandidates('', PELA, CONES))).toEqual([]);
    });

    it('a search matches names and aliases, spaces and case ignored, signature then path first', () => {
        expect(names(lightconeCandidates('RUAN mei', PELA, CONES))).toEqual(['d5harmony']);
        expect(names(lightconeCandidates('5', PELA, CONES))).toEqual(['b5nihility', 'd5harmony']);
        expect(names(lightconeCandidates('harmony', RUAN_MEI, CONES))).toEqual([
            'd5harmony',
            'a4harmony',
        ]);
        expect(names(lightconeCandidates('4', RUAN_MEI, CONES))).toEqual([
            'a4harmony',
            'e4nihility',
        ]);
    });

    it('the equipped cone is left out and the list is capped', () => {
        expect(names(lightconeCandidates('', RUAN_MEI, CONES, 'd5harmony'))).toEqual([]);
        expect(names(lightconeCandidates('harmony', RUAN_MEI, CONES, 'd5harmony'))).toEqual([
            'a4harmony',
        ]);
        const many = Array.from({ length: 80 }, (_, i) => cone(`x${i}`, 'Hunt', 4));
        expect(lightconeCandidates('x', undefined, many)).toHaveLength(LIMIT);
    });
});
