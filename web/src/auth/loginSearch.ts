/** Search params of `/`: `login=1` asks for the login prompt, `next` is where to go after it. */
export type LoginSearch = { login?: 1; next?: string };

const MAX_NEXT_LENGTH = 2048;
// Browsers strip tab, CR and LF from URLs (`/<TAB>/host` becomes `//host`) and read `\` as `/`.
function hasUnsafeChar(value: string): boolean {
    for (let i = 0; i < value.length; i++) {
        const code = value.charCodeAt(i);
        if (code <= 0x1f || code === 0x7f || code === 0x5c) return true;
    }
    return false;
}

/**
 * `value` when it is a same-site path, else undefined. Accepts only a string of at most 2048
 * characters that starts with a single `/` (not `//`) and holds no control character
 * (U+0000 to U+001F, U+007F) and no backslash anywhere.
 */
export function safeNextPath(value: unknown): string | undefined {
    if (typeof value !== 'string' || value.length > MAX_NEXT_LENGTH) return undefined;
    if (!value.startsWith('/') || value.startsWith('//')) return undefined;
    if (hasUnsafeChar(value)) return undefined;
    return value;
}

/**
 * `validateSearch` for `/`: keeps `login` only when it is the text "1" (typed as `1`) and `next`
 * only when it is safe (a repeated `next` arrives as an array and is dropped). The router also
 * re-runs validators on already-validated values when it builds a location, so `1` is accepted
 * too (validators must be idempotent). Both
 * keys are always present (maybe undefined): the router merges the raw search under the validated
 * one, so a key left out would let the raw, rejected value through.
 */
export function parseLoginSearch(search: Record<string, unknown>): LoginSearch {
    return {
        login: search.login === '1' || search.login === 1 ? 1 : undefined,
        next: safeNextPath(search.next),
    };
}
