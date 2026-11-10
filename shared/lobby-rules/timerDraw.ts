// A117(3) (S10o fix pass, review F1): the index a timer auto-pick or auto-ban draws from its pool. Pure: plain numbers in,
// a number out, no spacetimedb import, so the module and a unit test share it. It replaces ctx.random, whose host seed
// (pcg32 of the transaction timestamp, high bits sign-filled) skews the first output. A120 (S10p) adds fairShuffle below,
// the shuffle the module's other random draws use.
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

/** Multiply-high: a 32-bit hash reduced to [0, n), floor(h * n / 2^32). Exact in a double for n < 2^21. */
function reduceHash(h: number, n: number): number {
    return Math.floor((h * n) / 0x1_0000_0000);
}

/** The pool index in [0, poolLength) for a timer draw (poolLength >= 1; a pool of one always gives 0). */
export function timerDrawIndex(input: TimerDrawInput, poolLength: number): number {
    const h = murmur3Words([input.timestampLo, input.timestampHi, input.lobbyId, input.turnIndex, input.nextSequence]);
    return reduceHash(h, poolLength);
}

// A120 (S10p): the shuffle of every other random draw of the module (random bracket seeding, the RandomSwap of
// shuffle_teams, the random team formation of A36a). A Fisher-Yates pass over a copy of the input, from the last
// position down: for i = n - 1 .. 1, j = floor(murmur3Words([tsLo, tsHi, ...keyWords, i]) * (i + 1) / 2^32), then swap
// positions i and j. Each step's index is uniform over its i + 1 positions within a relative bias of (i + 1) / 2^32 (the
// same multiply-high argument as timerDrawIndex). The steps are not independent: all of them share the hash state after
// the timestamp and key words, so the whole order is a function of one 32-bit state and at most 2^32 orders are
// reachable for a given site and id (all of them up to n = 12, since 12! < 2^32 < 13!; from n = 13 some orders cannot
// occur). A generator seeded from the timestamp alone, as ctx.random was, has the same limit. Positions, pairs and
// small-n orders measure uniform (the distribution tests). The per-position counter i makes every step hash different
// input words, and the key words carry a domain word per site, so two shuffles in one transaction never reuse a hash.

/** Domain words (ASCII tags) that keep the three shuffle sites apart inside one transaction (A120). */
export const SHUFFLE_DOMAIN = {
    /** seed_bracket, mode 'random' (C-a7): 'SEED'. */
    BracketSeeding: 0x5345_4544,
    /** shuffle_teams, RandomSwap: 'SWAP'. */
    RandomSwap: 0x5357_4150,
    /** formRandomTeams, A36a: 'TEAM'. */
    TeamFormation: 0x5445_414d,
} as const;

export interface ShuffleKey {
    /** Transaction timestamp, microseconds since the Unix epoch, low 32 bits. */
    timestampLo: number;
    /** Transaction timestamp, microseconds since the Unix epoch, high 32 bits. */
    timestampHi: number;
    /** Caller words: a SHUFFLE_DOMAIN word, then the acting row's id (tournament or lobby). Each taken modulo 2^32. */
    words: readonly number[];
}

/** A ShuffleKey from a transaction timestamp (microseconds) and the caller's key words. */
export function shuffleKeyAt(micros: bigint, words: readonly number[]): ShuffleKey {
    const { lo, hi } = microsWords(micros);
    return { timestampLo: lo, timestampHi: hi, words };
}

/** A120: a permutation of `items` drawn from the key (a new array; the input is not touched). n < 2^21. */
export function fairShuffle<T>(items: readonly T[], key: ShuffleKey): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
        const j = reduceHash(murmur3Words([key.timestampLo, key.timestampHi, ...key.words, i]), i + 1);
        if (j !== i) {
            const tmp = out[i];
            out[i] = out[j];
            out[j] = tmp;
        }
    }
    return out;
}
