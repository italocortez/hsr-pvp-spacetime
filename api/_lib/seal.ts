// The sealed OAuth state (M5b): AES-256-GCM with a key derived by HKDF-SHA256 from AUTH_SECRET.
// The cookie value is `v1.` + base64url(iv 12 bytes | ciphertext | tag 16 bytes): the link code
// inside can be neither read nor changed without the secret.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { isLinkCode } from '../../shared/auth-flow.js';

export interface StatePayload {
    /** 32 random bytes, base64url: the OAuth `state` parameter. */
    state: string;
    linkCode: string;
    /** Milliseconds since the epoch, the function's clock at start. */
    createdAt: number;
}

export type UnsealResult =
    | { ok: true; payload: StatePayload }
    | { ok: false; reason: 'malformed' | 'invalid' | 'expired' };

const PREFIX = 'v1.';
const INFO = 'hsr-pvp/auth-state/v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** A state created more than this far in the function's future is refused (clock skew). */
const FUTURE_SKEW_MS = 60_000;

function deriveKey(secret: string): Buffer {
    return Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.alloc(0), INFO, 32));
}

/** Seals `payload`; `iv` is injectable for tests only (a fresh random one otherwise). */
export function seal(
    payload: StatePayload,
    secret: string,
    iv: Buffer = randomBytes(IV_BYTES),
): string {
    const cipher = createCipheriv('aes-256-gcm', deriveKey(secret), iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
    return PREFIX + Buffer.concat([iv, body, cipher.getAuthTag()]).toString('base64url');
}

/**
 * Opens a sealed value. `malformed`: not this format; `invalid`: tampered, or another key;
 * `expired`: older than `maxAgeMs` by `nowMs`, or from the future beyond the skew allowance.
 */
export function unseal(
    value: string,
    secret: string,
    nowMs: number,
    maxAgeMs: number,
): UnsealResult {
    if (!value.startsWith(PREFIX)) return { ok: false, reason: 'malformed' };
    const raw = value.slice(PREFIX.length);
    if (!/^[A-Za-z0-9_-]+$/.test(raw)) return { ok: false, reason: 'malformed' };
    const bytes = Buffer.from(raw, 'base64url');
    if (bytes.length < IV_BYTES + TAG_BYTES + 1) return { ok: false, reason: 'malformed' };
    let text: string;
    try {
        const decipher = createDecipheriv(
            'aes-256-gcm',
            deriveKey(secret),
            bytes.subarray(0, IV_BYTES),
        );
        decipher.setAuthTag(bytes.subarray(bytes.length - TAG_BYTES));
        text = Buffer.concat([
            decipher.update(bytes.subarray(IV_BYTES, bytes.length - TAG_BYTES)),
            decipher.final(),
        ]).toString('utf8');
    } catch {
        return { ok: false, reason: 'invalid' };
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return { ok: false, reason: 'invalid' };
    }
    const p = parsed as Partial<StatePayload> | null;
    if (
        typeof p !== 'object' ||
        p === null ||
        typeof p.state !== 'string' ||
        !/^[A-Za-z0-9_-]{43}$/.test(p.state) ||
        !isLinkCode(p.linkCode) ||
        typeof p.createdAt !== 'number' ||
        !Number.isFinite(p.createdAt)
    ) {
        return { ok: false, reason: 'invalid' };
    }
    if (nowMs - p.createdAt > maxAgeMs || p.createdAt - nowMs > FUTURE_SKEW_MS) {
        return { ok: false, reason: 'expired' };
    }
    return { ok: true, payload: { state: p.state, linkCode: p.linkCode, createdAt: p.createdAt } };
}
