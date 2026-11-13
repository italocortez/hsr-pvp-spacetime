import { SenderError } from 'spacetimedb/server';

// ─── M5a: one-time link codes (LinkRequest; A44(3), A46) ──────────────────────────────────────────────────────────
// A connected guest asks request_link_code for a code; the browser hands only that code to the auth function, which
// names it in server_link_by_code once Discord confirms the user. The code is a bearer secret for five minutes.

/** One text for an unknown, used or expired code (server_link_by_code), so the function cannot probe codes. */
export const LINK_CODE_REFUSED_TEXT = 'This link code is invalid or has expired.';

/** How long a code lives: five minutes, in microseconds. */
export const LINK_CODE_TTL_MICROS = 5n * 60n * 1_000_000n;

/** Code length in characters: 24 bytes of SHA-256 output in base64url (alphabet A-Z a-z 0-9 - _), no padding. */
export const LINK_CODE_LENGTH = 32;
const LINK_CODE_BYTES = 24;

/** The client nonce: exactly 43 base64url characters (32 random bytes, no padding). */
export const CLIENT_NONCE_LENGTH = 43;
export const CLIENT_NONCE_INVALID_TEXT = 'clientNonce must be 43 base64url characters (32 random bytes).';
const CLIENT_NONCE_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** Throws unless `nonce` is exactly 43 characters of A-Z a-z 0-9 - _. The value is never echoed. */
export function checkClientNonce(nonce: string): void {
    if (typeof nonce !== 'string' || !CLIENT_NONCE_SHAPE.test(nonce)) throw new SenderError(CLIENT_NONCE_INVALID_TEXT);
}

/** request_link_code: at most this many LinkRequest rows are examined per call by the inline sweep. */
export const LINK_SWEEP_SCAN_LIMIT = 64;
/** run_identity_gc: at most this many LinkRequest rows are examined per scheduled run (the backstop sweep). */
export const LINK_SWEEP_GC_SCAN_LIMIT = 10_000;

// ─── SHA-256 (FIPS 180-4) ─────────────────────────────────────────────────────────────────────────────────────────
// The module has no crypto API, and ctx.random is seeded from the transaction timestamp alone (SDK 2.15.0:
// makeRandom(ctx.timestamp)), so its output is a function of the commit time. The secrecy of a code therefore rests on
// the client nonce: 32 bytes from the caller's crypto.getRandomValues (a CSPRNG), sent as the reducer argument, never
// stored or logged. The caller's connection id (chosen by its SDK at connect; no table or view exposes it) is a second
// secret input. The code is a SHA-256 digest over both plus the identity, the timestamp and the caller's previous
// code; ctx.random is not used (it would add only a function of the timestamp, already hashed). Exported for its test
// vectors.

const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

export function sha256(message: Uint8Array): Uint8Array {
    const bitLength = BigInt(message.length) * 8n;
    const padded = new Uint8Array(Math.ceil((message.length + 9) / 64) * 64);
    padded.set(message);
    padded[message.length] = 0x80;
    for (let i = 0; i < 8; i++) {
        padded[padded.length - 1 - i] = Number((bitLength >> BigInt(8 * i)) & 0xffn);
    }

    const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    const w = new Uint32Array(64);
    for (let off = 0; off < padded.length; off += 64) {
        for (let i = 0; i < 16; i++) {
            const j = off + i * 4;
            w[i] = (padded[j] << 24) | (padded[j + 1] << 16) | (padded[j + 2] << 8) | padded[j + 3];
        }
        for (let i = 16; i < 64; i++) {
            const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
            const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
        }
        let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
        for (let i = 0; i < 64; i++) {
            const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
            const ch = (e & f) ^ (~e & g);
            const t1 = (hh + S1 + ch + K[i] + w[i]) | 0;
            const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
            const maj = (a & b) ^ (a & c) ^ (b & c);
            const t2 = (S0 + maj) | 0;
            hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
        }
        h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
    }

    const out = new Uint8Array(32);
    for (let i = 0; i < 8; i++) {
        out[i * 4] = h[i] >>> 24;
        out[i * 4 + 1] = (h[i] >>> 16) & 0xff;
        out[i * 4 + 2] = (h[i] >>> 8) & 0xff;
        out[i * 4 + 3] = h[i] & 0xff;
    }
    return out;
}

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** base64url without padding; `bytes.length` must be a multiple of 3. */
function base64Url(bytes: Uint8Array): string {
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
        const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
        out += B64URL[(n >>> 18) & 63] + B64URL[(n >>> 12) & 63] + B64URL[(n >>> 6) & 63] + B64URL[n & 63];
    }
    return out;
}

/** ASCII bytes of a string whose characters are all below 128 (the domain tag and a previous code). */
function asciiBytes(s: string): Uint8Array {
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0x7f;
    return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.length; }
    return out;
}

function u64Bytes(v: bigint): Uint8Array {
    const out = new Uint8Array(8);
    const u = BigInt.asUintN(64, v);
    for (let i = 0; i < 8; i++) out[i] = Number((u >> BigInt(8 * i)) & 0xffn);
    return out;
}

/**
 * A fresh code for the caller. SHA-256 over, in this order: the domain tag 'hsr-link-code/v1' (16 ASCII bytes), the
 * client nonce (43 ASCII bytes, checked by checkClientNonce), the caller's identity (32 bytes, Identity.toUint8Array),
 * the connection id (16 bytes, ConnectionId.toUint8Array; zeros without a connection), the transaction timestamp
 * (microseconds, 8 bytes little-endian), the caller's previous code (32 ASCII bytes, or none, so a second request in
 * the same microsecond differs) and the attempt counter (1 byte): 116 bytes, or 148 with a previous code. The code is
 * the first 24 bytes of the digest in base64url without padding (32 characters). A code another row already holds (the primary key) is re-drawn with the next attempt, at most 4 times.
 */
export function generateLinkCode(ctx: any, previousCode: string | undefined, clientNonce: string): string {
    const connection = ctx.connectionId ? ctx.connectionId.toUint8Array() : new Uint8Array(16);
    for (let attempt = 0; attempt < 4; attempt++) {
        const digest = sha256(concat([
            asciiBytes('hsr-link-code/v1'),
            asciiBytes(clientNonce),
            ctx.sender.toUint8Array(),
            connection,
            u64Bytes(ctx.timestamp.microsSinceUnixEpoch),
            asciiBytes(previousCode ?? ''),
            new Uint8Array([attempt]),
        ]));
        const code = base64Url(digest.subarray(0, LINK_CODE_BYTES));
        if (!ctx.db.LinkRequest.code.find(code)) return code;
    }
    throw new SenderError('Could not create a link code. Please try again.');
}

/**
 * Deletes stale LinkRequest rows among the first `scanLimit` rows the table yields.
 * A row is stale once its expiresAt has passed: the 5-minute code window before presentation, the 2-minute confirm
 * window after it (M5a2). Returns how many went. Rows are collected first and deleted after the scan.
 */
export function sweepStaleLinkRequests(ctx: any, scanLimit: number): number {
    const nowMicros: bigint = ctx.timestamp.microsSinceUnixEpoch;
    const stale: string[] = [];
    let scanned = 0;
    // iter() required: LinkRequest has no expiresAt index; the scan stops after scanLimit rows.
    for (const r of ctx.db.LinkRequest.iter()) {
        if (scanned >= scanLimit) break;
        scanned++;
        if (r.expiresAt.microsSinceUnixEpoch <= nowMicros) stale.push(r.code);
    }
    for (const code of stale) ctx.db.LinkRequest.code.delete(code);
    return stale.length;
}

/** performUserDeletion: every LinkRequest row of the user (user_id index). */
export function deleteLinkRequestsOfUser(ctx: any, userId: number): void {
    for (const r of [...ctx.db.LinkRequest.user_id.filter(userId)]) ctx.db.LinkRequest.code.delete(r.code);
}

// ─── M5a2: the second lock (presentation, then confirmation by the requesting browser) ──────────────────────────────
// server_link_by_code no longer merges: it records the Discord account as pending, with the SHA-256 of a one-time
// confirm token that the auth function gave to the browser that finished Discord. confirm_link, called by the
// requesting identity itself with that token, performs the merge. The function alone holds the hash, never the token
// after the redirect, and cannot call confirm_link as the requesting identity.

/** The confirm window after a presentation: two minutes, in microseconds. */
export const CONFIRM_WINDOW_MICROS = 2n * 60n * 1_000_000n;

/** Length of the confirm token and of the confirm hash: 32 bytes in base64url without padding. */
export const CONFIRM_FIELD_LENGTH = 43;
export const CONFIRM_HASH_INVALID_TEXT = 'confirmHash must be 43 base64url characters (a SHA-256 digest).';
export const CONFIRM_TOKEN_INVALID_TEXT = 'confirmToken must be 43 base64url characters (32 bytes).';
/** confirm_link: no row, not presented yet, or the confirm window has passed. */
export const NO_PENDING_LINK_TEXT = 'No sign-in is waiting for confirmation. Please start again.';
/** confirm_link: the token does not match the stored hash. */
export const CONFIRM_REFUSED_TEXT = 'This sign-in could not be confirmed.';
/** server_link_by_code / confirm_link: the identity no longer maps to the live guest that asked for the code. */
export const ACCOUNT_CHANGED_TEXT = 'This account changed since the sign-in started. Please start again.';
/** server_link_by_code with provider discord and a providerId that is not a snowflake (digits, 17 to 20). */
export const NOT_A_DISCORD_ID_TEXT = 'providerId is not a Discord id.';
export const DISCORD_ID_SHAPE = /^[0-9]{17,20}$/;

// 43 base64url characters carry 258 bits; 32 bytes use 256 of them, so the last character's two low bits must be 0
// (the canonical encoding Node's Buffer.toString('base64url') and any RFC 4648 encoder produce).
const CANONICAL_43 = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

/** True when `value` is the canonical base64url encoding (no padding) of exactly 32 bytes. */
export function isBase64Url32(value: string): boolean {
    return typeof value === 'string' && CANONICAL_43.test(value);
}

/** Decodes the canonical base64url encoding of 32 bytes (callers check isBase64Url32 first). */
export function decodeBase64Url32(value: string): Uint8Array {
    const out = new Uint8Array(32);
    let acc = 0;
    let bits = 0;
    let j = 0;
    for (let i = 0; i < value.length; i++) {
        acc = (acc << 6) | B64URL.indexOf(value[i]);
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            if (j < 32) out[j++] = (acc >>> bits) & 0xff;
        }
        acc &= (1 << bits) - 1;
    }
    return out;
}

/** base64url without padding of any byte string (a 32-byte digest gives 43 characters). */
export function encodeBase64Url(bytes: Uint8Array): string {
    let out = '';
    let i = 0;
    for (; i + 3 <= bytes.length; i += 3) {
        const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
        out += B64URL[(n >>> 18) & 63] + B64URL[(n >>> 12) & 63] + B64URL[(n >>> 6) & 63] + B64URL[n & 63];
    }
    const rest = bytes.length - i;
    if (rest === 1) {
        const n = bytes[i] << 16;
        out += B64URL[(n >>> 18) & 63] + B64URL[(n >>> 12) & 63];
    } else if (rest === 2) {
        const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
        out += B64URL[(n >>> 18) & 63] + B64URL[(n >>> 12) & 63] + B64URL[(n >>> 6) & 63];
    }
    return out;
}

/**
 * The confirm hash of a confirm token: SHA-256 over the token's 32 DECODED bytes (not over its 43 characters), written
 * as base64url without padding (43 characters). The auth function computes the same with
 * `createHash('sha256').update(Buffer.from(token, 'base64url')).digest('base64url')`.
 * Vector: the token of 32 zero bytes, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', hashes to
 * 'Zmh6rfhivXdsj8GLjp-OIAiXFIVu4jOzkCpZHQ1fKSU'.
 */
export function confirmHashOf(token: string): string {
    return encodeBase64Url(sha256(decodeBase64Url32(token)));
}

/** Compares two equal-length strings without an early exit. */
export function sameText(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

/** The row has been presented by the server and waits for confirm_link. */
export function isAwaitingConfirm(row: any): boolean {
    return row.usedAt !== undefined && row.pendingProviderId !== undefined && row.confirmHash !== undefined;
}

/**
 * server_link_by_code and confirm_link: the row's identity must still map to the live guest that asked for the code
 * (same user id, still a guest, no provider, not soft-deleted). An identity with no mapping is left to planProviderLink
 * ("Identity not registered").
 */
export function ensureStillTheRequestingGuest(ctx: any, row: any): void {
    const mapping = ctx.db.UserIdentity.identity.find(row.identity);
    if (!mapping) return;
    const user = ctx.db.User.id.find(mapping.userId);
    if (mapping.userId !== row.userId || !user || !user.isGuest || user.loginMethod !== undefined || user.deletedAt !== undefined) {
        throw new SenderError(ACCOUNT_CHANGED_TEXT);
    }
}
