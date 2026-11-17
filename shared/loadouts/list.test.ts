import { describe, expect, it } from 'vitest';
import {
    addLoadout,
    duplicateLoadout,
    freeSlot,
    keySlot,
    type Loadout,
    removeLoadout,
    sameContent,
    slotKey,
    updateLoadout,
} from './list';
import { ACCOUNT_LOADOUT_LIMIT, BROWSER_LOADOUT_LIMIT, UNTITLED } from './names';

// T-S14.3c: list operations and the limits of 5 (browser) and 10 (account).

const l = (key: string, name = key, code = '1._._._._.as-c-0-3000-1500'): Loadout => ({
    key,
    name,
    note: '',
    code,
});

describe('addLoadout', () => {
    it('appends until the limit, then refuses', () => {
        let list: Loadout[] = [];
        for (let i = 0; i < BROWSER_LOADOUT_LIMIT; i++) {
            const r = addLoadout(list, l(`k${i}`), BROWSER_LOADOUT_LIMIT);
            expect(r.ok).toBe(true);
            if (r.ok) list = r.list;
        }
        expect(list).toHaveLength(5);
        expect(addLoadout(list, l('k5'), BROWSER_LOADOUT_LIMIT)).toEqual({
            ok: false,
            reason: 'full',
        });
    });

    it('cleans the name and note', () => {
        const r = addLoadout([], { key: 'a', name: '   ', note: 'n'.repeat(1200), code: 'c' }, 5);
        expect(r.ok && r.list[0]).toMatchObject({ name: UNTITLED });
        expect(r.ok && r.list[0]?.note).toHaveLength(1000);
    });
});

describe('updateLoadout', () => {
    it('renames one loadout and leaves the rest', () => {
        const list = updateLoadout([l('a'), l('b')], 'b', { name: '  Boothill  ' });
        expect(list.map((x) => x.name)).toEqual(['a', 'Boothill']);
    });

    it('an unknown key changes nothing', () => {
        expect(updateLoadout([l('a')], 'z', { name: 'x' })).toEqual([l('a')]);
    });
});

describe('duplicateLoadout', () => {
    it('puts the copy right after its source with the Copy name', () => {
        const r = duplicateLoadout([l('a', 'Acheron'), l('b', 'Boothill')], 'a', 'c', 5);
        expect(r.ok && r.list.map((x) => x.name)).toEqual(['Acheron', 'Acheron Copy', 'Boothill']);
        expect(r.ok && r.key).toBe('c');
    });

    it('Copy 2 when Copy exists', () => {
        const r = duplicateLoadout([l('a', 'A'), l('b', 'A Copy')], 'a', 'c', 5);
        expect(r.ok && r.list[1]?.name).toBe('A Copy 2');
    });

    it('refuses when full or when the source is gone', () => {
        const full = Array.from({ length: 5 }, (_, i) => l(`k${i}`));
        expect(duplicateLoadout(full, 'k0', 'x', 5)).toEqual({ ok: false, reason: 'full' });
        expect(duplicateLoadout([l('a')], 'z', 'x', 5)).toEqual({ ok: false, reason: 'missing' });
    });
});

describe('removeLoadout', () => {
    it('the next active one is the one before (the mockup), else the new first, else none', () => {
        expect(removeLoadout([l('a'), l('b'), l('c')], 'b')).toEqual({
            list: [l('a'), l('c')],
            next: 'a',
        });
        expect(removeLoadout([l('a'), l('b')], 'a').next).toBe('b');
        expect(removeLoadout([l('a')], 'a')).toEqual({ list: [], next: null });
    });
});

describe('account slots', () => {
    it('the lowest free slot, none when all ten are used', () => {
        expect(freeSlot([], ACCOUNT_LOADOUT_LIMIT)).toBe(0);
        expect(freeSlot([0, 1, 3], ACCOUNT_LOADOUT_LIMIT)).toBe(2);
        expect(freeSlot([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], ACCOUNT_LOADOUT_LIMIT)).toBeNull();
    });

    it('slot keys read back; anything else is not a slot', () => {
        expect(keySlot(slotKey(7))).toBe(7);
        expect(keySlot('b-123')).toBeNull();
        expect(keySlot('10')).toBeNull();
    });

    it('sameContent compares name, note and code', () => {
        expect(sameContent(l('a'), l('b', 'a'))).toBe(true);
        expect(sameContent(l('a'), { ...l('a'), note: 'x' })).toBe(false);
    });
});
