/*
 * The `/costs` address (S14.2, user ruling 2026-11-16 item 5): every view setting is a plain-text
 * search param (A169, `web/src/lib/searchParams.ts`); multi-value filters repeat their key
 * (`?el=fire&el=ice`). Defaults are left out of the address. Anything unknown or invalid is
 * dropped here, so the page never sees a value it did not expect, and the router rewrites the
 * address bar for a dropped value.
 *
 * | Param | Values | Default (omitted) |
 * |---|---|---|
 * | `tab` | `lightcones` | characters |
 * | `draft` | `auction` | classic |
 * | `mode` | `moc`, `aa` | as (Apocalyptic Shadow) |
 * | `set` | a published cost set id: decimal, 1 to 4294967295, no leading zero | the default set (0) |
 * | `el` | fire ice imaginary lightning physical quantum wind (Characters only) | none |
 * | `path` | the nine paths | none |
 * | `role` | dps support sustain (Characters only) | none |
 * | `rarity` | 5 4 (Characters), 5 4 3 (Light Cones) | none |
 * | `q` | search text, trimmed, at most 100 characters | empty |
 * | `sort` | name rarity e0..e6 (Characters), name rarity s1..s5 (Light Cones) | name |
 * | `dir` | `desc` | asc |
 *
 * The validator is idempotent (the router runs it again on its own output) and returns every key
 * it owns, `undefined` when dropped. The router merges the raw search under the validated one, so
 * a key the validator does not own (`?foo=bar`) would survive; the route's search middleware
 * (`routes/costs.tsx`) runs this validator on the final search, which leaves only these keys.
 */

export const TABS = ['characters', 'lightcones'] as const;
export type Tab = (typeof TABS)[number];

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

export const RARITIES_BY_TAB: Record<Tab, readonly RarityParam[]> = {
    characters: ['5', '4'],
    lightcones: ['5', '4', '3'],
};
export type RarityParam = '5' | '4' | '3';

export const CHARACTER_SORTS = [
    'name',
    'rarity',
    'e0',
    'e1',
    'e2',
    'e3',
    'e4',
    'e5',
    'e6',
] as const;
export const LIGHTCONE_SORTS = ['name', 'rarity', 's1', 's2', 's3', 's4', 's5'] as const;
export type SortKey = (typeof CHARACTER_SORTS)[number] | (typeof LIGHTCONE_SORTS)[number];
export type SortDir = 'asc' | 'desc';

export const SEARCH_MAX = 100;

/** The validated search (`undefined` = the default, left out of the address). */
export type CostsSearch = {
    tab?: 'lightcones';
    draft?: 'auction';
    mode?: 'moc' | 'aa';
    set?: number;
    el?: ElementParam[];
    path?: PathParam[];
    role?: RoleParam[];
    rarity?: RarityParam[];
    q?: string;
    sort?: SortKey;
    dir?: 'desc';
};

/** The search with every default filled in: what the page renders. */
export type CostsView = {
    tab: Tab;
    draft: DraftParam;
    mode: ModeParam;
    set: number;
    el: ElementParam[];
    path: PathParam[];
    role: RoleParam[];
    rarity: RarityParam[];
    q: string;
    sort: SortKey;
    dir: SortDir;
};

const U32_MAX = 4294967295;

/** Every value of a key as text (a repeated key arrives as an array). */
function texts(value: unknown): string[] {
    if (typeof value === 'string') return [value];
    if (typeof value === 'number' && Number.isFinite(value)) return [String(value)];
    if (Array.isArray(value)) return value.flatMap(texts);
    return [];
}

/** A single value: a repeated key or a non-text value is dropped. */
function single(value: unknown): string | undefined {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return undefined;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
    const text = single(value);
    return text !== undefined && (allowed as readonly string[]).includes(text)
        ? (text as T)
        : undefined;
}

/** The allowed values present, each once, in the canonical order; undefined when none. */
function setOf<T extends string>(value: unknown, allowed: readonly T[]): T[] | undefined {
    const present = new Set(texts(value));
    const out = allowed.filter((v) => present.has(v));
    return out.length > 0 ? out : undefined;
}

/** A cost set id: 1 to 4294967295 written in canonical decimal (no sign, no leading zero). */
export function parseSetId(value: unknown): number | undefined {
    const text = single(value);
    if (text === undefined || !/^[1-9][0-9]{0,9}$/.test(text)) return undefined;
    const id = Number(text);
    return id <= U32_MAX ? id : undefined;
}

/** `validateSearch` for `/costs`. */
export function parseCostsSearch(search: Record<string, unknown>): CostsSearch {
    const tab = oneOf(search.tab, TABS);
    const isLc = tab === 'lightcones';
    const sorts: readonly SortKey[] = isLc ? LIGHTCONE_SORTS : CHARACTER_SORTS;
    const sort = oneOf(search.sort, sorts);
    // The search is stored trimmed: "  pel " and "pel" are one address.
    const q = single(search.q)?.trim();
    return {
        tab: isLc ? 'lightcones' : undefined,
        draft: oneOf(search.draft, DRAFT_MODES) === 'auction' ? 'auction' : undefined,
        mode: (() => {
            const mode = oneOf(search.mode, GAME_MODES);
            return mode === 'as' ? undefined : mode;
        })(),
        set: parseSetId(search.set),
        // Element and role filter characters only: the Light Cones tab drops them.
        el: isLc ? undefined : setOf(search.el, ELEMENTS),
        path: setOf(search.path, PATHS),
        role: isLc ? undefined : setOf(search.role, ROLES),
        rarity: setOf(search.rarity, RARITIES_BY_TAB[isLc ? 'lightcones' : 'characters']),
        q: q !== undefined && q !== '' && q.length <= SEARCH_MAX ? q : undefined,
        sort: sort === 'name' ? undefined : sort,
        dir: oneOf(search.dir, ['asc', 'desc'] as const) === 'desc' ? 'desc' : undefined,
    };
}
