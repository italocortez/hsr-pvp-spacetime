/** Longest module name shown in the pill, in code points; longer names are cut. */
const MAX_MODULE_LENGTH = 40;

/**
 * The human-readable module name to show (DESIGN.md §4.5), or null when absent or blank. The cut
 * counts code points, so a surrogate pair (emoji, astral characters) is never split. The value
 * may be user-supplied (`/standby?module=`): callers render it as text only.
 */
export function useRequestedModule(raw: string | undefined): string | null {
    const name = raw?.trim() ?? '';
    if (name === '') return null;
    const chars = Array.from(name);
    return chars.length > MAX_MODULE_LENGTH
        ? `${chars.slice(0, MAX_MODULE_LENGTH).join('').trimEnd()}…`
        : name;
}
