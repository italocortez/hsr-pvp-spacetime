/** Longest module name shown in the pill, in code points; longer `?module=` values are cut. */
const MAX_MODULE_LENGTH = 40;

/**
 * The human-readable module name from `?module=` (DESIGN.md §4.5), or null when absent.
 * URLSearchParams already decodes percent-escapes and `+`. The cut counts code points, so a
 * surrogate pair (emoji, astral characters) is never split. The value is user-supplied: callers
 * render it as text only.
 */
export function useRequestedModule(search: string): string | null {
    const name = new URLSearchParams(search).get('module')?.trim() ?? '';
    if (name === '') return null;
    const chars = Array.from(name);
    return chars.length > MAX_MODULE_LENGTH
        ? `${chars.slice(0, MAX_MODULE_LENGTH).join('').trimEnd()}…`
        : name;
}
