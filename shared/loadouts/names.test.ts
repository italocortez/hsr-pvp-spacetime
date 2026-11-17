import { describe, expect, it } from 'vitest';
import {
    copyName,
    cutUnits,
    LOADOUT_NAME_MAX,
    LOADOUT_NOTE_MAX,
    loadoutName,
    loadoutNote,
    UNTITLED,
    wellFormed,
} from './names';

// T-S14.3c: the name and note rules, equal to the module's (docs/loadout/contract.md "Name rules", "Note cap").

describe('loadoutName', () => {
    it('trims, keeps 40 units, and turns a blank name into Untitled', () => {
        expect(loadoutName('  Firefly Hyper ')).toBe('Firefly Hyper');
        expect(loadoutName('')).toBe(UNTITLED);
        expect(loadoutName('   ')).toBe(UNTITLED);
        expect(loadoutName('a'.repeat(40))).toHaveLength(40);
        expect(loadoutName(`  ${'a'.repeat(40)}  `)).toBe('a'.repeat(40));
        expect(loadoutName('b'.repeat(41))).toHaveLength(LOADOUT_NAME_MAX);
    });

    it('never ends on half of a surrogate pair', () => {
        const name = `${'a'.repeat(39)}😀`;
        expect(name.length).toBe(41);
        expect(loadoutName(name)).toBe('a'.repeat(39));
    });

    it('a name cut at 40 is trimmed again (no trailing space is sent)', () => {
        expect(loadoutName(`${'a'.repeat(39)} b`)).toBe('a'.repeat(39));
    });
});

describe('loadoutNote', () => {
    it('keeps 1,000 units and its spaces', () => {
        expect(loadoutNote(' x ')).toBe(' x ');
        expect(loadoutNote('n'.repeat(1000))).toHaveLength(LOADOUT_NOTE_MAX);
        expect(loadoutNote('n'.repeat(1001))).toHaveLength(LOADOUT_NOTE_MAX);
    });

    it('cutUnits leaves short text alone', () => {
        expect(cutUnits('abc', 5)).toBe('abc');
    });
});

describe('copyName', () => {
    it('Copy, then Copy 2, Copy 3 (the mockup)', () => {
        expect(copyName('Firefly', ['Firefly'])).toBe('Firefly Copy');
        expect(copyName('Firefly', ['Firefly', 'Firefly Copy'])).toBe('Firefly Copy 2');
        expect(copyName('Firefly', ['Firefly', 'Firefly Copy', 'Firefly Copy 2'])).toBe(
            'Firefly Copy 3',
        );
    });

    it('fits 40 units with the suffix', () => {
        const long = 'x'.repeat(40);
        const copy = copyName(long, [long]);
        expect(copy).toHaveLength(40);
        expect(copy.endsWith(' Copy')).toBe(true);
        const second = copyName(long, [long, copy]);
        expect(second).toHaveLength(40);
        expect(second.endsWith(' Copy 2')).toBe(true);
    });
});

// T-S14.3c-fix (review M10): a lone surrogate becomes U+FFFD, as on its way to the server.
describe('wellFormed', () => {
    it('lone halves become U+FFFD, whole pairs stay, the length is unchanged', () => {
        const high = String.fromCharCode(0xd83d);
        const low = String.fromCharCode(0xde00);
        const mark = String.fromCharCode(0xfffd);
        expect(wellFormed(`a${high}b`)).toBe(`a${mark}b`);
        expect(wellFormed(`a${low}b`)).toBe(`a${mark}b`);
        expect(wellFormed(`${high}${low}`)).toBe(`${high}${low}`);
        expect(loadoutName(`Hyper ${high}`)).toBe(`Hyper ${mark}`);
        expect(loadoutNote(`x${low}`)).toHaveLength(2);
    });
});
