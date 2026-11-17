// S14.3c: the rules a loadout's name and note follow on the page, matched to the module's checks
// (`spacetimedb/src/helpers/roster/loadoutRules.ts`, docs/loadout/contract.md): the name is trimmed, never blank,
// at most 40 UTF-16 units; the note at most 1,000 UTF-16 units (JavaScript `string.length`, the unit an HTML
// `maxlength` counts too). A blank name is never sent: the server refuses it, so the page turns it into "Untitled"
// (the mockup's rule on blur).

/** A190 item 15, A193 item 1. */
export const LOADOUT_NAME_MAX = 40;
export const LOADOUT_NOTE_MAX = 1_000;
/** A190 item 3. */
export const BROWSER_LOADOUT_LIMIT = 5;
export const ACCOUNT_LOADOUT_LIMIT = 10;

/** The mockup's names: a new loadout, and a blank name after editing. */
export const NEW_LOADOUT_NAME = 'New Loadout';
export const UNTITLED = 'Untitled';

/** Cut to at most `max` UTF-16 units without leaving half of a surrogate pair at the end. */
export function cutUnits(text: string, max: number): string {
    if (text.length <= max) return text;
    let cut = text.slice(0, max);
    const last = cut.charCodeAt(cut.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
    return cut;
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * A lone surrogate becomes U+FFFD, what the text turns into on its way to the server (UTF-8), so the copy kept
 * here equals the row that comes back (review M10). One unit for one unit: the limits are unchanged.
 */
export function wellFormed(text: string): string {
    return text.replace(LONE_SURROGATE, '�');
}

/** The name as it is kept and sent: trimmed, "Untitled" when blank, at most 40 units. */
export function loadoutName(raw: string): string {
    const trimmed = wellFormed(cutUnits(raw.trim(), LOADOUT_NAME_MAX).trim());
    return trimmed === '' ? UNTITLED : trimmed;
}

/** The note as it is kept and sent: at most 1,000 units (not trimmed: line breaks and spaces are the writer's). */
export function loadoutNote(raw: string): string {
    return wellFormed(cutUnits(raw, LOADOUT_NOTE_MAX));
}

/**
 * The name of a copy (the mockup's rule): "<name> Copy", then "<name> Copy 2", "<name> Copy 3", ... until no other
 * loadout in `taken` has it. The base is shortened so the result fits 40 units.
 */
export function copyName(source: string, taken: Iterable<string>): string {
    const names = new Set(taken);
    const base = loadoutName(source);
    for (let n = 1; ; n++) {
        const suffix = n === 1 ? ' Copy' : ` Copy ${n}`;
        const name = `${cutUnits(base, LOADOUT_NAME_MAX - suffix.length).trimEnd()}${suffix}`;
        if (!names.has(name)) return name;
    }
}
