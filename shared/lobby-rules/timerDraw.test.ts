// T-S10o fix pass (review F1, F2): the pure timer draw (A117(3)). Distribution over structured, realistic inputs, and
// the dependence of the draw on the transaction time and on the step sequence.
import { describe, expect, it } from 'vitest';
import {
    fairShuffle,
    fmix32,
    microsWords,
    murmur3Words,
    SHUFFLE_DOMAIN,
    shuffleKeyAt,
    timerDrawIndex,
    type ShuffleKey,
    type TimerDrawInput,
} from './timerDraw';

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

// ─── T-S10p (A120): fairShuffle, the Fisher-Yates pass every other random draw of the module uses ──────────────────

const microsAt = (i: number) => BASE_MICROS + BigInt(i) * STEP_MICROS + BigInt((i * i) % 1_000_003);
const seedKey = (i: number, id = 7): ShuffleKey => shuffleKeyAt(microsAt(i), [SHUFFLE_DOMAIN.BracketSeeding, id]);
const range = (n: number) => Array.from({ length: n }, (_, i) => i);

describe('fairShuffle: shape (A120)', () => {
    it('A120: returns a permutation of the input and does not mutate it', () => {
        for (const n of [3, 8, 16, 80]) {
            const input = range(n).map((k) => k * 10);
            const frozen = Object.freeze([...input]);
            for (let i = 0; i < 50; i++) {
                const out = fairShuffle(frozen, seedKey(i));
                expect(out).not.toBe(frozen);
                expect([...out].sort((a, b) => a - b)).toEqual(input);
            }
            expect(frozen).toEqual(input);
        }
    });

    it('A120: lengths 0, 1 and 2', () => {
        expect(fairShuffle([], seedKey(0))).toEqual([]);
        expect(fairShuffle(['a'], seedKey(0))).toEqual(['a']);
        const seen = new Set<string>();
        for (let i = 0; i < 200; i++) {
            const out = fairShuffle(['a', 'b'], seedKey(i));
            expect([...out].sort()).toEqual(['a', 'b']);
            seen.add(out.join(''));
        }
        expect(seen).toEqual(new Set(['ab', 'ba']));
    });

    it('A120: deterministic for the same timestamp and key words', () => {
        const input = range(16);
        expect(fairShuffle(input, seedKey(3))).toEqual(fairShuffle(input, seedKey(3)));
        expect(fairShuffle(input, shuffleKeyAt(microsAt(3), [SHUFFLE_DOMAIN.RandomSwap, 42])))
            .toEqual(fairShuffle(input, shuffleKeyAt(microsAt(3), [SHUFFLE_DOMAIN.RandomSwap, 42])));
    });

    it('A120: differs across timestamps (1 µs to 40 s apart) and across the high word', () => {
        const input = range(8);
        for (const step of [1n, 1_000n, 40_000_000n]) {
            const orders = new Set<string>();
            for (let i = 0; i < 40; i++) orders.add(fairShuffle(input, shuffleKeyAt(BASE_MICROS + BigInt(i) * step, [SHUFFLE_DOMAIN.BracketSeeding, 7])).join());
            expect(orders.size).toBeGreaterThanOrEqual(35);
        }
        const byHi = new Set<string>();
        const base = seedKey(0);
        for (let hi = 0; hi < 40; hi++) byHi.add(fairShuffle(input, { ...base, timestampHi: base.timestampHi + hi }).join());
        expect(byHi.size).toBeGreaterThanOrEqual(35);
    });

    it('A120: differs across domain words and ids at one timestamp; the three domain words are distinct', () => {
        const domains = Object.values(SHUFFLE_DOMAIN);
        expect(new Set(domains).size).toBe(3);
        const input = range(8);
        let differ = 0;
        for (let i = 0; i < 100; i++) {
            const micros = microsAt(i);
            const orders = domains.map((d) => fairShuffle(input, shuffleKeyAt(micros, [d, 5])).join());
            if (new Set(orders).size === 3) differ++;
        }
        expect(differ).toBeGreaterThanOrEqual(95); // 8! = 40,320 orders: a coincidence is rare
        const byId = new Set<string>();
        for (let id = 1; id <= 40; id++) byId.add(fairShuffle(input, shuffleKeyAt(microsAt(0), [SHUFFLE_DOMAIN.BracketSeeding, id])).join());
        expect(byId.size).toBeGreaterThanOrEqual(35);
    });
});

describe('fairShuffle: distribution (A120)', () => {
    // Tolerance: every frequency within 5% (relative) of the ideal. n = 4: 240,000 shuffles, 10,000 expected per
    // permutation, one standard deviation about 1%; n = 16: 160,000 shuffles, 10,000 expected per (element, position)
    // cell, one standard deviation about 1%. Each step's index is uniform within (i + 1) / 2^32; the whole order is a
    // function of one 32-bit hash state (at most 2^32 orders reachable: every order up to n = 12, so all 24 at n = 4).
    // n = 4 runs for every domain word over three timestamp families: jittered (13.3 s apart plus a quadratic term),
    // consecutive microseconds, and round seconds.
    const ROUND_SECOND_BASE = (BASE_MICROS / 1_000_000n) * 1_000_000n;
    const FAMILIES: Array<[string, (i: number) => bigint]> = [
        ['jittered', microsAt],
        ['consecutive microseconds', (i) => BASE_MICROS + BigInt(i)],
        ['round seconds', (i) => ROUND_SECOND_BASE + BigInt(i) * 1_000_000n],
    ];
    for (const [domainName, domain] of Object.entries(SHUFFLE_DOMAIN)) {
        for (const [familyName, micros] of FAMILIES) {
            it(`A120: n = 4, ${domainName}, ${familyName}: each of the 24 permutations appears within 5% of 1/24 over 240,000 timestamps`, () => {
                const N = 240_000;
                const counts = new Map<string, number>();
                for (let i = 0; i < N; i++) {
                    const key = fairShuffle(range(4), shuffleKeyAt(micros(i), [domain, 7])).join('');
                    counts.set(key, (counts.get(key) ?? 0) + 1);
                }
                expect(counts.size).toBe(24);
                const ideal = N / 24;
                for (const c of counts.values()) {
                    expect(c).toBeGreaterThan(ideal * 0.95);
                    expect(c).toBeLessThan(ideal * 1.05);
                }
            });
        }
    }

    it('A120: n = 16: each element lands in each position within 5% of 1/16 over 160,000 timestamps', () => {
        const N = 160_000;
        const n = 16;
        const cells = new Array<number>(n * n).fill(0);
        for (let i = 0; i < N; i++) {
            fairShuffle(range(n), seedKey(i, 1000 + (i % 5))).forEach((element, position) => cells[element * n + position]++);
        }
        const ideal = N / n;
        expect(Math.min(...cells)).toBeGreaterThan(ideal * 0.95);
        expect(Math.max(...cells)).toBeLessThan(ideal * 1.05);
    });
});
