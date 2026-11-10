// T-S10o fix pass (review F1, F2): the pure timer draw (A117(3)). Distribution over structured, realistic inputs, and
// the dependence of the draw on the transaction time and on the step sequence.
import { describe, expect, it } from 'vitest';
import { fmix32, microsWords, murmur3Words, timerDrawIndex, type TimerDrawInput } from './timerDraw';

// 2026-09 in microseconds; consecutive inputs 13.337777 s apart (about 31 days over 200,000 draws, so the high word moves).
const BASE_MICROS = 1_790_000_000_000_000n;
const STEP_MICROS = 13_337_777n;
const LOBBY_IDS = [1, 7, 42, 1000, 65537];
const DRAWS = 200_000;

function inputAt(i: number): TimerDrawInput {
    const { lo, hi } = microsWords(BASE_MICROS + BigInt(i) * STEP_MICROS + BigInt((i * i) % 1_000_003));
    return { timestampLo: lo, timestampHi: hi, lobbyId: LOBBY_IDS[i % LOBBY_IDS.length], turnIndex: i % 20, nextSequence: 3 + (i % 40) };
}

function shares(n: number): number[] {
    const counts = new Array<number>(n).fill(0);
    for (let i = 0; i < DRAWS; i++) counts[timerDrawIndex(inputAt(i), n)]++;
    return counts.map((c) => c / DRAWS);
}

describe('timerDrawIndex: distribution (A117(3), review F1)', () => {
    // Tolerance: every share within 10% (relative) of 1/n. At n = 80 that is 1.125%..1.375%; the ctx.random seed skew
    // measured by the review (1.0%..4.1% at n = 80, 7.5%..10.6% at n = 12) fails it clearly, while sampling noise of a
    // uniform draw over 200,000 inputs is about 2% relative at n = 80 (one standard deviation).
    for (const n of [2, 12, 80]) {
        it(`n = ${n}: every position's share is within 10% of 1/${n}`, () => {
            const s = shares(n);
            const ideal = 1 / n;
            expect(s).toHaveLength(n);
            expect(Math.min(...s)).toBeGreaterThan(ideal * 0.9);
            expect(Math.max(...s)).toBeLessThan(ideal * 1.1);
        });
    }

    it('a pool of one always gives index 0; every index is in range', () => {
        for (let i = 0; i < 1000; i++) {
            expect(timerDrawIndex(inputAt(i), 1)).toBe(0);
            const k = timerDrawIndex(inputAt(i), 7);
            expect(Number.isInteger(k) && k >= 0 && k < 7).toBe(true);
        }
    });
});

describe('timerDrawIndex: inputs (A117(3), review F2)', () => {
    const base: TimerDrawInput = { ...inputAt(0), lobbyId: 12, turnIndex: 5, nextSequence: 9 };

    it('is deterministic: the same input gives the same index', () => {
        expect(timerDrawIndex({ ...base }, 80)).toBe(timerDrawIndex({ ...base }, 80));
    });

    it('depends on the transaction time: same lobby, turn and sequence, 40 times 1 ms to 40 s apart give many draws', () => {
        for (const stepMicros of [1_000n, 1_000_000n, 40_000_000n]) {
            const drawn = new Set<number>();
            for (let i = 0; i < 40; i++) {
                const { lo, hi } = microsWords(BASE_MICROS + BigInt(i) * stepMicros);
                drawn.add(timerDrawIndex({ ...base, timestampLo: lo, timestampHi: hi }, 12));
            }
            expect(drawn.size).toBeGreaterThanOrEqual(8);
        }
    });

    it('depends on the high word of the timestamp too', () => {
        const drawn = new Set<number>();
        for (let hi = 0; hi < 40; hi++) drawn.add(timerDrawIndex({ ...base, timestampHi: base.timestampHi + hi }, 12));
        expect(drawn.size).toBeGreaterThanOrEqual(8);
    });

    it('depends on the sequence: same time, lobby and turn, sequences 1..40 give many draws', () => {
        const drawn = new Set<number>();
        for (let seq = 1; seq <= 40; seq++) drawn.add(timerDrawIndex({ ...base, nextSequence: seq }, 12));
        expect(drawn.size).toBeGreaterThanOrEqual(8);
    });

    it('depends on the lobby and the turn', () => {
        const byLobby = new Set<number>();
        const byTurn = new Set<number>();
        for (let k = 1; k <= 40; k++) {
            byLobby.add(timerDrawIndex({ ...base, lobbyId: k }, 12));
            byTurn.add(timerDrawIndex({ ...base, turnIndex: k }, 12));
        }
        expect(byLobby.size).toBeGreaterThanOrEqual(8);
        expect(byTurn.size).toBeGreaterThanOrEqual(8);
    });
});

describe('timerDraw helpers', () => {
    it('microsWords keeps all 64 bits', () => {
        expect(microsWords(0x0123_4567_89ab_cdefn)).toEqual({ lo: 0x89ab_cdef, hi: 0x0123_4567 });
        expect(microsWords(BASE_MICROS)).toEqual({ lo: Number(BASE_MICROS & 0xffffffffn), hi: Number(BASE_MICROS >> 32n) });
    });

    it('fmix32 and murmur3Words return unsigned 32-bit values; murmur3 matches the reference vector', () => {
        expect(fmix32(0)).toBe(0);
        const h = fmix32(0xdeadbeef);
        expect(h >= 0 && h <= 0xffffffff && Number.isInteger(h)).toBe(true);
        // MurmurHash3 x86_32, seed 0, of the 4 bytes 00 00 00 00 (one zero word) is 0x2362f9de.
        expect(murmur3Words([0])).toBe(0x2362f9de);
    });
});
