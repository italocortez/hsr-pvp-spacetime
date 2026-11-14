// M5b: names and shapes the login function (api/) and the page (web/src/auth/) must agree on.
// Pure constants and checks; no runtime import of node, react or spacetimedb.

/** The function's two routes (same origin as the app). */
export const AUTH_START_PATH = '/api/auth/discord/start';
export const AUTH_CALLBACK_PATH = '/api/auth/discord/callback';

/**
 * Cookies. All carry the `__Host-` prefix: `Secure`, `Path=/`, no `Domain`, so only this exact
 * origin sets and reads them.
 * - state: HttpOnly, SameSite=Lax (sent on Discord's top-level redirect back), 10 minutes; holds
 *   the sealed `{ state, linkCode, createdAt }`.
 * - confirm: readable by the page, 2 minutes; the one-time confirm token after the presentation.
 * - refusal: readable by the page, 2 minutes; the module's refusal text, percent-encoded.
 */
export const STATE_COOKIE = '__Host-hsr-auth-state';
export const CONFIRM_COOKIE = '__Host-hsr-auth-confirm';
export const REFUSAL_COOKIE = '__Host-hsr-auth-refusal';

/** Lifetimes in seconds. */
export const STATE_MAX_AGE_S = 600;
export const READABLE_COOKIE_MAX_AGE_S = 120;

/**
 * SameSite of the two page-readable cookies. Strict: a Strict cookie set on the callback's 303
 * answer is stored and readable by `document.cookie` on the page the redirect lands on (checked in
 * Edge at M5b; Firefox not checked yet; docs/auth/architecture.md "Phase M5b execution").
 */
export const READABLE_COOKIE_SAMESITE = 'Strict';

/** The longest refusal text carried to the page (UTF-16 units, cut on a code point boundary). */
export const REFUSAL_TEXT_MAX = 200;

/** `?status=` values of the return address `/?login=1&status=<status>`. */
export const LOGIN_STATUSES = ['confirm', 'refused', 'cancelled', 'failed'] as const;
export type LoginStatus = (typeof LOGIN_STATUSES)[number];

/** A link code: 32 base64url characters (24 bytes, the module's `generateLinkCode`). */
export function isLinkCode(value: unknown): value is string {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{32}$/.test(value);
}

/**
 * The canonical base64url (no padding) of 32 bytes: 43 characters whose last one encodes two
 * unused zero bits (the module's `isBase64Url32`): a confirm token or its hash.
 */
export function isBase64Url32(value: unknown): value is string {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(value);
}

/** Cuts `text` to at most `max` UTF-16 units without leaving a lone high surrogate. */
export function capOnCodePoint(text: string, max: number): string {
    if (text.length <= max) return text;
    let end = max;
    const last = text.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end -= 1;
    return text.slice(0, end);
}
