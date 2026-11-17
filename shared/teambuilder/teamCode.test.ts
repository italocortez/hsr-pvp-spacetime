// T-S14.3a: the packed team text: round trips, the 400-character worst case, strict and total decoding of
// malformed input, and unknown names reported as unavailable instead of failing the team.
import { describe, expect, it } from 'vitest';
import {
    decodeTeam,
    emptyTeam,
    encodeTeam,
    type Slot,
    type Slots,
    swapSlots,
    TEAM_CODE_MAX,
    type Team,
} from './index';

const slot = (
    character: string,
    eidolon: number,
    lightcone: string | null = null,
    superimposition = 1,
): Slot => ({ character, eidolon, lightcone, superimposition }) as Slot;

const TEAM: Team = {
    slots: [
        slot('firefly', 0, 'whereaboutsshouldyouwish', 1),
        slot('ruanmei', 6),
        null,
        slot('pela', 6, 'resolutionshinesaspearlsofsweat', 5),
    ],
    draftMode: 'auction',
    gameMode: 'moc',
    costSetId: 12,
    budgets: { character: 3050, lightcone: 1500 },
};

function code(team: Team): string {
    const r = encodeTeam(team);
    if (!r.ok) throw new Error(r.message);
    return r.code;
}

describe('encodeTeam / decodeTeam', () => {
    it('writes the documented grammar', () => {
        expect(code(TEAM)).toBe(
            '1.firefly-0-whereaboutsshouldyouwish-1.ruanmei-6._.pela-6-resolutionshinesaspearlsofsweat-5.moc-a-12-3050-1500',
        );
        expect(code(emptyTeam())).toBe('1._._._._.as-c-0-3000-1500');
    });

    it('round trips a full team, an empty team and every mode', () => {
        for (const team of [
            TEAM,
            emptyTeam(),
            { ...TEAM, gameMode: 'as', draftMode: 'classic', costSetId: 0 } as Team,
            { ...TEAM, gameMode: 'aa', costSetId: 4294967295 } as Team,
            { ...TEAM, budgets: { character: 0, lightcone: 99999999 } },
        ]) {
            const decoded = decodeTeam(code(team));
            expect(decoded).toEqual({ ok: true, team, unavailable: [] });
            // Idempotent: decoding then encoding gives the same text.
            if (decoded.ok) expect(code(decoded.team)).toBe(code(team));
        }
    });

    it('the worst case (40-character names, every field at its widest) fits in 400 characters', () => {
        const long = (c: string) => c.repeat(40);
        const team: Team = {
            slots: [
                slot(long('a'), 6, long('w'), 5),
                slot(long('b'), 6, long('x'), 5),
                slot(long('c'), 6, long('y'), 5),
                slot(long('d'), 6, long('z'), 5),
            ],
            draftMode: 'auction',
            gameMode: 'moc',
            costSetId: 4294967295,
            budgets: { character: 99999999, lightcone: 99999999 },
        };
        const text = code(team);
        expect(text.length).toBe(380);
        expect(text.length).toBeLessThanOrEqual(TEAM_CODE_MAX);
        expect(decodeTeam(text)).toEqual({ ok: true, team, unavailable: [] });
        // Every character is unreserved in a URL: no percent encoding.
        expect(encodeURIComponent(text)).toBe(text);
    });

    it('a swapped team round trips in its new order', () => {
        const swapped = { ...TEAM, slots: swapSlots(TEAM.slots, 0, 3) };
        const decoded = decodeTeam(code(swapped));
        expect(decoded.ok && decoded.team.slots.map((s) => s?.character ?? null)).toEqual([
            'pela',
            'ruanmei',
            null,
            'firefly',
        ]);
    });

    it('refuses to write a team it could not read back', () => {
        const bad = (slots: Slots, extra: Partial<Team> = {}) =>
            encodeTeam({ ...TEAM, slots, ...extra });
        expect(bad([slot('Fire Fly', 0), null, null, null]).ok).toBe(false);
        expect(bad([slot('a'.repeat(41), 0), null, null, null]).ok).toBe(false);
        expect(bad([slot('a', 7), null, null, null]).ok).toBe(false);
        expect(bad([slot('a', 0, 'b', 6), null, null, null]).ok).toBe(false);
        expect(bad([slot('a', 0), slot('a', 1), null, null])).toMatchObject({
            ok: false,
            error: 'duplicate',
        });
        expect(bad(TEAM.slots, { costSetId: -1 }).ok).toBe(false);
        expect(bad(TEAM.slots, { costSetId: 1.5 }).ok).toBe(false);
        expect(bad(TEAM.slots, { budgets: { character: 100000000, lightcone: 0 } }).ok).toBe(false);
        expect(bad(TEAM.slots, { budgets: { character: 10.5, lightcone: 0 } }).ok).toBe(false);
    });
});

// T-S14.3a-fix (review M3): the per-slot Auction extra bid is part of version 1.
describe('the per-slot extra bid', () => {
    const withBid = (s: Slot, bid: number): Slot => ({ ...(s as object), bid }) as Slot;

    it('is written after the slot (and its cone), 0 as nothing, and reads back', () => {
        const team: Team = {
            ...TEAM,
            slots: [
                withBid(slot('firefly', 0, 'whereaboutsshouldyouwish', 1), 250),
                withBid(slot('ruanmei', 6), 9999),
                null,
                withBid(slot('pela', 6), 0),
            ],
        };
        expect(code(team)).toBe(
            '1.firefly-0-whereaboutsshouldyouwish-1-250.ruanmei-6-9999._.pela-6.moc-a-12-3050-1500',
        );
        const decoded = decodeTeam(code(team));
        expect(decoded.ok && decoded.team.slots[0]).toEqual(team.slots[0]);
        expect(decoded.ok && decoded.team.slots[1]).toEqual(team.slots[1]);
        // A bid of 0 has no text: it reads back as no bid, and the text stays the same.
        expect(decoded.ok && decoded.team.slots[3]).toEqual(slot('pela', 6));
        if (decoded.ok) expect(code(decoded.team)).toBe(code(team));
    });

    it('a cone name made of digits is still a cone, never a bid', () => {
        const decoded = decodeTeam('1.a-0-12-3._._._.as-c-0-0-0');
        expect(decoded.ok && decoded.team.slots[0]).toEqual(slot('a', 0, '12', 3));
        const bid = decodeTeam('1.a-0-12._._._.as-c-0-0-0');
        expect(bid.ok && bid.team.slots[0]).toEqual(withBid(slot('a', 0), 12));
    });

    it('the worst case with four bids is exactly 400 characters', () => {
        const long = (c: string) => c.repeat(40);
        const team: Team = {
            slots: [
                withBid(slot(long('a'), 6, long('w'), 5), 9999),
                withBid(slot(long('b'), 6, long('x'), 5), 9999),
                withBid(slot(long('c'), 6, long('y'), 5), 9999),
                withBid(slot(long('d'), 6, long('z'), 5), 9999),
            ],
            draftMode: 'auction',
            gameMode: 'moc',
            costSetId: 4294967295,
            budgets: { character: 99999999, lightcone: 99999999 },
        };
        const text = code(team);
        expect(text.length).toBe(TEAM_CODE_MAX);
        expect(decodeTeam(text)).toEqual({ ok: true, team, unavailable: [] });
        expect(encodeURIComponent(text)).toBe(text);
    });

    it.each([
        ['a bid of 0 written out', '1.a-0-0._._._.as-c-0-0-0'],
        ['a bid with a leading zero', '1.a-0-050._._._.as-c-0-0-0'],
        ['a bid over 9999', '1.a-0-10000._._._.as-c-0-0-0'],
        ['a bid after a cone without its level', '1.a-0-cone-250._._._.as-c-0-0-0'],
        ['two bids', '1.a-0-cone-1-5-5._._._.as-c-0-0-0'],
        ['a negative bid', '1.a-0--5._._._.as-c-0-0-0'],
        ['a bid on an empty slot', '1._-5._._._.as-c-0-0-0'],
    ])('%s fails', (_n, input) => {
        expect(decodeTeam(input)).toMatchObject({ ok: false });
    });

    it('refuses to write a bid out of range', () => {
        for (const bid of [-1, 10000, 2.5, Number.NaN])
            expect(
                encodeTeam({ ...TEAM, slots: [withBid(slot('a', 0), bid), null, null, null] }),
            ).toMatchObject({ ok: false, error: 'slot' });
    });
});

// T-S14.3a-fix (review M2): the encoder never throws and refuses what the types forbid.
describe('encodeTeam on input that breaks the types', () => {
    const bad = (team: unknown) => encodeTeam(team as Team);

    it.each([
        ['an undefined slot', { ...TEAM, slots: [undefined, null, null, null] }, 'slot'],
        ['a number as a slot', { ...TEAM, slots: [5, null, null, null] }, 'slot'],
        // T-S14.3a-fix2 (review 2 M12): checked without a cone too.
        [
            'superimposition 99 on a slot without a cone',
            { ...TEAM, slots: [slot('firefly', 0, null, 99), null, null, null] },
            'slot',
        ],
        [
            'no superimposition on a slot without a cone',
            {
                ...TEAM,
                slots: [{ character: 'firefly', eidolon: 0, lightcone: null }, null, null, null],
            },
            'slot',
        ],
        ['budgets null', { ...TEAM, budgets: null }, 'settings'],
        ['budgets missing', { ...TEAM, budgets: undefined }, 'settings'],
        ['the draft mode "constructor"', { ...TEAM, draftMode: 'constructor' }, 'settings'],
        ['the draft mode "toString"', { ...TEAM, draftMode: 'toString' }, 'settings'],
        ['an unknown draft mode', { ...TEAM, draftMode: 'snake' }, 'settings'],
        ['a cost set id as text', { ...TEAM, costSetId: '3' }, 'settings'],
        ['no slots', { ...TEAM, slots: undefined }, 'shape'],
        ['null', null, 'shape'],
        [
            'a slot whose getter throws',
            {
                ...TEAM,
                slots: [
                    {
                        get character(): string {
                            throw new Error('boom');
                        },
                    },
                    null,
                    null,
                    null,
                ],
            },
            'shape',
        ],
    ])('%s fails cleanly', (_n, team, error) => {
        let result: ReturnType<typeof encodeTeam> | undefined;
        expect(() => {
            result = bad(team);
        }).not.toThrow();
        expect(result).toMatchObject({ ok: false, error });
    });
});

describe('decodeTeam: strict and total', () => {
    const good = '1.firefly-0._._._.as-c-0-3000-1500';

    it.each([
        ['not a string (a repeated address key)', ['a', 'b'], 'empty'],
        ['undefined', undefined, 'empty'],
        ['a number', 12, 'empty'],
        ['an empty string', '', 'empty'],
        ['over 400 characters', `${good}${'a'.repeat(400)}`, 'too-long'],
        ['upper case', '1.Firefly-0._._._.as-c-0-3000-1500', 'bad-characters'],
        ['a space', '1.fire fly-0._._._.as-c-0-3000-1500', 'bad-characters'],
        ['a percent sign', '1.fire%20fly-0._._._.as-c-0-3000-1500', 'bad-characters'],
        ['a newline', `${good}\n`, 'bad-characters'],
        ['an unknown version', '2.firefly-0._._._.as-c-0-3000-1500', 'version'],
        ['three slots', '1.firefly-0._._.as-c-0-3000-1500', 'shape'],
        ['five slots', '1.firefly-0._._._._.as-c-0-3000-1500', 'shape'],
        ['a trailing dot', `${good}.`, 'shape'],
        ['eidolon 7', '1.firefly-7._._._.as-c-0-3000-1500', 'slot'],
        ['a missing eidolon', '1.firefly._._._.as-c-0-3000-1500', 'slot'],
        ['superimposition 0', '1.firefly-0-cone-0._._._.as-c-0-3000-1500', 'slot'],
        ['a cone without superimposition', '1.firefly-0-cone._._._.as-c-0-3000-1500', 'slot'],
        ['an empty name', '1.-0._._._.as-c-0-3000-1500', 'slot'],
        ['a 41-character name', `1.${'a'.repeat(41)}-0._._._.as-c-0-3000-1500`, 'slot'],
        ['an empty slot written as nothing', '1.firefly-0.._._.as-c-0-3000-1500', 'slot'],
        ['the same character twice', '1.firefly-0.firefly-2._._.as-c-0-3000-1500', 'duplicate'],
        ['an unknown mode', '1._._._._.xx-c-0-3000-1500', 'settings'],
        ['an unknown draft', '1._._._._.as-x-0-3000-1500', 'settings'],
        ['a set id with a leading zero', '1._._._._.as-c-07-3000-1500', 'settings'],
        ['a set id over u32', '1._._._._.as-c-4294967296-3000-1500', 'settings'],
        ['a budget with a leading zero', '1._._._._.as-c-0-03000-1500', 'settings'],
        ['a budget over 8 digits', '1._._._._.as-c-0-100000000-1500', 'settings'],
        ['a missing budget', '1._._._._.as-c-0-3000', 'settings'],
        ['a negative budget', '1._._._._.as-c-0--5-1500', 'settings'],
    ])('%s fails cleanly', (_name, input, error) => {
        let result: ReturnType<typeof decodeTeam> | undefined;
        expect(() => {
            result = decodeTeam(input);
        }).not.toThrow();
        expect(result).toMatchObject({ ok: false, error });
        expect(result && !result.ok && result.message).toMatch(/\.$/);
    });

    it('never throws on hostile strings', () => {
        for (const input of ['__proto__', 'constructor', '1.__proto__-0._._._.as-c-0-0-0', '.'])
            expect(decodeTeam(input).ok).toBe(false);
    });
});

describe('decodeTeam: unknown names', () => {
    const catalog = {
        characters: new Set(['firefly', 'ruanmei']),
        lightcones: new Map([['whereaboutsshouldyouwish', true]]),
    };

    it('keeps the team and lists unknown characters and cones as unavailable', () => {
        const result = decodeTeam(
            '1.firefly-0-nosuchcone-1.ghost-3._.ruanmei-0-whereaboutsshouldyouwish-1.as-c-0-3000-1500',
            catalog,
        );
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.team.slots.map((s) => s?.character ?? null)).toEqual([
            'firefly',
            'ghost',
            null,
            'ruanmei',
        ]);
        expect(result.unavailable).toEqual([
            { slot: 0, kind: 'lightcone', name: 'nosuchcone' },
            { slot: 1, kind: 'character', name: 'ghost' },
        ]);
    });

    it('without a catalog, nothing is checked against the reference set', () => {
        const result = decodeTeam('1.ghost-3._._._.as-c-0-3000-1500');
        expect(result).toMatchObject({ ok: true, unavailable: [] });
    });
});
