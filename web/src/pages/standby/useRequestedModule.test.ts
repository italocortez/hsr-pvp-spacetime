import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useRequestedModule } from './useRequestedModule';

// The module-name cut (docs/frontend/pages.md "Standby"): 40 code points, a surrogate pair is
// never split, a blank name gives no pill.
const name = (raw: string | undefined) => renderHook(() => useRequestedModule(raw)).result.current;

describe('useRequestedModule', () => {
    it('returns null when absent, empty or whitespace only', () => {
        expect(name(undefined)).toBeNull();
        expect(name('')).toBeNull();
        expect(name('   \t\n ')).toBeNull();
    });

    it('trims surrounding whitespace', () => {
        expect(name('  Lobbies  ')).toBe('Lobbies');
    });

    it('keeps a name of exactly 40 code points whole', () => {
        const forty = 'a'.repeat(40);
        expect(name(forty)).toBe(forty);
    });

    it('cuts a longer name to 40 code points plus an ellipsis', () => {
        expect(name('a'.repeat(41))).toBe(`${'a'.repeat(40)}…`);
    });

    it('counts code points, not UTF-16 units: 40 emoji stay whole', () => {
        const emoji = '😀'.repeat(40); // 80 UTF-16 units, 40 code points
        expect(name(emoji)).toBe(emoji);
    });

    it('never splits a surrogate pair at the cut', () => {
        const raw = `${'a'.repeat(39)}😀b`; // the 40th code point is the emoji
        // A UTF-16 cut at 40 units would end in a lone high surrogate instead.
        expect(name(raw)).toBe(`${'a'.repeat(39)}😀…`);
    });

    it('drops a trailing space left by the cut before the ellipsis', () => {
        expect(name(`${'a'.repeat(39)} bcd`)).toBe(`${'a'.repeat(39)}…`);
    });
});
