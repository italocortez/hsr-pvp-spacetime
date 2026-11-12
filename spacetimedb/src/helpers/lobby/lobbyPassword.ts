import { SenderError } from 'spacetimedb/server';

/**
 * S11a (triage L24): lobby passwords are stored as a hash, not as the text the host typed, and have a length cap.
 *
 * `LobbyPassword.passwordHash` holds `hashLobbyPassword(lobbyId, password)`: the SHA-256 (hex) of
 * `"hsr-lobby-password:<lobbyId>:<password>"`. A reducer is deterministic and has no crypto API, so SHA-256 is written
 * out here (FIPS 180-4, over the UTF-8 bytes). The lobby id salts the hash, so one password gives a different value in
 * each lobby. This keeps the typed text out of `spacetime sql` reads by the database owner; it is not a defence against
 * guessing (a lobby password is short, and a failed `join_lobby` rolls back, so attempts cannot be counted in the
 * module: the guess limit is left open, S11a log).
 */
export const LOBBY_PASSWORD_MAX_LENGTH = 64;

/**
 * S11a (review L3): a string longer than this many UTF-16 units is refused on its raw `.length`, before it is expanded
 * into code points (a code point is at most 2 units, so anything over 128 units already exceeds the cap).
 */
export const LOBBY_PASSWORD_MAX_UTF16_UNITS = 256;

/** True when the password has more than LOBBY_PASSWORD_MAX_LENGTH code points; the raw length is tested first (L3). */
export function lobbyPasswordTooLong(password: string): boolean {
    return password.length > LOBBY_PASSWORD_MAX_UTF16_UNITS || [...password].length > LOBBY_PASSWORD_MAX_LENGTH;
}

/** Refuses a password longer than LOBBY_PASSWORD_MAX_LENGTH characters (code points). */
export function ensureLobbyPasswordLength(password: string): void {
    if (lobbyPasswordTooLong(password)) {
        throw new SenderError(`The lobby password can be at most ${LOBBY_PASSWORD_MAX_LENGTH} characters.`);
    }
}

export function hashLobbyPassword(lobbyId: number, password: string): string {
    return sha256Hex(utf8Bytes(`hsr-lobby-password:${lobbyId}:${password}`));
}

function utf8Bytes(text: string): number[] {
    const out: number[] = [];
    for (const ch of text) {
        const cp = ch.codePointAt(0)!;
        if (cp < 0x80) out.push(cp);
        else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
        else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
        else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    }
    return out;
}

const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function sha256Hex(bytes: number[]): string {
    const bitLength = bytes.length * 8;
    const msg = bytes.slice();
    msg.push(0x80);
    while (msg.length % 64 !== 56) msg.push(0);
    // 64-bit big-endian length (messages here are far below 2^32 bits)
    msg.push(0, 0, 0, 0, (bitLength >>> 24) & 0xff, (bitLength >>> 16) & 0xff, (bitLength >>> 8) & 0xff, bitLength & 0xff);

    const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    const w = new Array<number>(64);
    const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
    for (let off = 0; off < msg.length; off += 64) {
        for (let i = 0; i < 16; i++) {
            const j = off + i * 4;
            w[i] = ((msg[j] << 24) | (msg[j + 1] << 16) | (msg[j + 2] << 8) | msg[j + 3]) >>> 0;
        }
        for (let i = 16; i < 64; i++) {
            const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
            const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
        }
        let [a, b, c, d, e, f, g, hh] = h;
        for (let i = 0; i < 64; i++) {
            const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
            const ch = (e & f) ^ (~e & g);
            const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
            const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
            const maj = (a & b) ^ (a & c) ^ (b & c);
            const t2 = (S0 + maj) >>> 0;
            hh = g; g = f; f = e; e = (d + t1) >>> 0;
            d = c; c = b; b = a; a = (t1 + t2) >>> 0;
        }
        h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
        h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
    }
    return h.map((x) => x.toString(16).padStart(8, '0')).join('');
}

/** Exposed for the in-memory test against the FIPS 180-4 vectors. */
export const sha256HexOfUtf8 = (text: string): string => sha256Hex(utf8Bytes(text));
