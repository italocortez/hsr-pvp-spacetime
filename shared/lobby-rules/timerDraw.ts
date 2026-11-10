// A117(3) (S10o fix pass, review F1): the index a timer auto-pick or auto-ban draws from its pool. Pure: plain numbers in,
// a number out, no spacetimedb import, so the module and a unit test share it. It replaces ctx.random, whose host seed
// (pcg32 of the transaction timestamp, high bits sign-filled) skews the first output.
//
// The five 32-bit input words (timestamp low, timestamp high, lobby id, turn index, next step sequence) go through the
// MurmurHash3 x86_32 body and its fmix32 finalizer (seed 0). The 32-bit hash is reduced to [0, n) by multiply-high:
// floor(h * n / 2^32). Each index then receives floor(2^32 / n) or ceil(2^32 / n) of the 2^32 hash values, so the
// residual bias is at most n / 2^32 relative (about 2e-8 at n = 80). h * n stays below 2^53 for any n < 2^21, so the
// product is exact in a double.

const C1 = 0xcc9e2d51;
const C2 = 0x1b873593;

const rotl32 = (x: number, r: number): number => (x << r) | (x >>> (32 - r));

/** MurmurHash3 fmix32: the 32-bit avalanche finalizer. Returns an unsigned 32-bit value. */
export function fmix32(h: number): number {
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return h >>> 0;
}

/** MurmurHash3 x86_32 over 32-bit words (each taken modulo 2^32), seed 0. Returns an unsigned 32-bit value. */
export function murmur3Words(words: readonly number[]): number {
    let h = 0;
    for (const w of words) {
        let k = Math.imul(w | 0, C1);
        k = rotl32(k, 15);
        k = Math.imul(k, C2);
        h ^= k;
        h = rotl32(h, 13);
        h = (Math.imul(h, 5) + 0xe6546b64) | 0;
    }
    h ^= words.length * 4; // the byte length, as in MurmurHash3
    return fmix32(h);
}

/** A 64-bit microsecond timestamp folded to its low and high 32-bit words (all bits kept). */
export function microsWords(micros: bigint): { lo: number; hi: number } {
    const u = BigInt.asUintN(64, micros);
    return { lo: Number(u & 0xffffffffn), hi: Number(u >> 32n) };
}

export interface TimerDrawInput {
    /** Transaction timestamp, microseconds since the Unix epoch, low 32 bits. */
    timestampLo: number;
    /** Transaction timestamp, microseconds since the Unix epoch, high 32 bits. */
    timestampHi: number;
    lobbyId: number;
    turnIndex: number;
    /** The MatchSessionStep.sequence the auto step is about to take. */
    nextSequence: number;
}

/** The pool index in [0, poolLength) for a timer draw (poolLength >= 1; a pool of one always gives 0). */
export function timerDrawIndex(input: TimerDrawInput, poolLength: number): number {
    const h = murmur3Words([input.timestampLo, input.timestampHi, input.lobbyId, input.turnIndex, input.nextSequence]);
    return Math.floor((h * poolLength) / 0x1_0000_0000);
}
