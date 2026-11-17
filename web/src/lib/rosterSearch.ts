/*
 * Address pieces shared by the pages that filter a roster (S14.2 costs, S14.3a team builder): the value lists
 * and the plain-text readers (A169, `searchParams.ts`). Moved here from `pages/costs/costsSearch.ts` in S14.3a
 * so both route validators use one copy; `costsSearch.ts` re-exports them. These sit in the entry chunk with the
 * route validators, so keep them small.
 */

export const DRAFT_MODES = ['classic', 'auction'] as const;
export type DraftParam = (typeof DRAFT_MODES)[number];

export const GAME_MODES = ['as', 'moc', 'aa'] as const;
export type ModeParam = (typeof GAME_MODES)[number];

export const ELEMENTS = [
    'fire',
    'ice',
    'imaginary',
    'lightning',
    'physical',
    'quantum',
    'wind',
] as const;
export type ElementParam = (typeof ELEMENTS)[number];

export const PATHS = [
    'destruction',
    'hunt',
    'erudition',
    'harmony',
    'nihility',
    'preservation',
    'abundance',
    'remembrance',
    'elation',
] as const;
export type PathParam = (typeof PATHS)[number];

export const ROLES = ['dps', 'support', 'sustain'] as const;
export type RoleParam = (typeof ROLES)[number];

export type RarityParam = '5' | '4' | '3';
export const CHARACTER_RARITIES: readonly RarityParam[] = ['5', '4'];

export const SEARCH_MAX = 100;

/** The longest archetype name the address keeps, and the most names. */
export const ARCH_NAME_MAX = 64;
export const ARCH_MAX = 32;

const U32_MAX = 4294967295;

/** Every value of a key as text (a repeated key arrives as an array). */
export function texts(value: unknown): string[] {
    if (typeof value === 'string') return [value];
    if (typeof value === 'number' && Number.isFinite(value)) return [String(value)];
    if (Array.isArray(value)) return value.flatMap(texts);
    return [];
}

/** A single value: a repeated key or a non-text value is dropped. */
export function single(value: unknown): string | undefined {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return undefined;
}

export function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
    const text = single(value);
    return text !== undefined && (allowed as readonly string[]).includes(text)
        ? (text as T)
        : undefined;
}

/** The allowed values present, each once, in the canonical order; undefined when none. */
export function setOf<T extends string>(value: unknown, allowed: readonly T[]): T[] | undefined {
    const present = new Set(texts(value));
    const out = allowed.filter((v) => present.has(v));
    return out.length > 0 ? out : undefined;
}

/**
 * Archetype names: the address keeps the name (stable: the module upserts archetypes by their
 * unique name and has no rename; readable in a shared link; the same on test and prod, where ids
 * differ), each once, in code-point order. A name must be what the module can store: trimmed,
 * not blank, no control characters. Whether it exists is the page's check (the list loads later).
 */
export function archNames(value: unknown): string[] | undefined {
    const names = [
        ...new Set(
            texts(value).filter(
                (t) =>
                    t !== '' &&
                    t.length <= ARCH_NAME_MAX &&
                    t === t.trim() &&
                    // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting them is the point
                    !/[\u0000-\u001f\u007f]/.test(t),
            ),
        ),
    ]
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
        .slice(0, ARCH_MAX);
    return names.length > 0 ? names : undefined;
}

/** A cost set id: 1 to 4294967295 written in canonical decimal (no sign, no leading zero). */
export function parseSetId(value: unknown): number | undefined {
    const text = single(value);
    if (text === undefined || !/^[1-9][0-9]{0,9}$/.test(text)) return undefined;
    const id = Number(text);
    return id <= U32_MAX ? id : undefined;
}

/** The search text: trimmed, not blank, at most `SEARCH_MAX` characters. */
export function searchText(value: unknown): string | undefined {
    const q = single(value)?.trim();
    return q !== undefined && q !== '' && q.length <= SEARCH_MAX ? q : undefined;
}
