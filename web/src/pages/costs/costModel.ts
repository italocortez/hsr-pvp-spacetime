import type { HsrCharacter, HsrLightcone, HsrSynergyCost } from '@bindings/types';
import { compareText, matchesCharacterFilters, matchesSearch, roundCost } from '@/lib/rosterModel';
import type { CostLookup, DraftModeTag, GameModeTag } from '@/stdb/costLookup';
import type {
    CostsView,
    ElementParam,
    PathParam,
    RarityParam,
    RoleParam,
    SortDir,
    SortKey,
    Tab,
} from './costsSearch';

/*
 * The costs page's view model (S14.2): pure functions from reference rows, one cost set's lookups
 * and the address view to the rows the table shows. Behaviour follows the mockup's script
 * (design/mockups/costs.html): filters OR within a group and AND across groups; search is a
 * case-insensitive substring of the display name or an alias (joke aliases included); sort
 * by one column, missing costs last in either direction, ties broken by display name then key so
 * equal costs never reorder between renders.
 *
 * Labels, number format, search, the character filters, archetypes and the cost set list are
 * shared with the team builder since S14.3a (`lib/rosterModel.ts`) and re-exported here.
 */

export {
    activeFilterCount,
    archetypeNamesByCharacter,
    archetypeOptions,
    costSetsForMode,
    DRAFT_LABEL,
    DRAFT_TAG,
    ELEMENT_LABEL,
    formatCost,
    formatModifier,
    GAME_MODE_TAG,
    MODE_LABEL,
    MODE_PARAM,
    MODE_SHORT,
    matchesSearch,
    PATH_LABEL,
    ROLE_LABEL,
    roundCost,
} from '@/lib/rosterModel';

export const EIDOLON_KEYS = ['e0', 'e1', 'e2', 'e3', 'e4', 'e5', 'e6'] as const;
export const SUPERIMPOSITION_KEYS = ['s1', 's2', 's3', 's4', 's5'] as const;
export type EidolonKey = (typeof EIDOLON_KEYS)[number];
export type SuperimpositionKey = (typeof SUPERIMPOSITION_KEYS)[number];

/** A synergy partner shown under a character. */
export type SynergyPartner = {
    /** The partner's key (`hsr_character.name`). */
    name: string;
    displayName: string;
    imageUrl: string;
    modifier: number;
};

export type CharacterRow = {
    kind: 'character';
    name: string;
    displayName: string;
    rarity: number;
    imageUrl: string;
    element: ElementParam;
    path: PathParam;
    role: RoleParam;
    /** The character's archetype names (none for a character without a link). */
    archetypes: readonly string[];
    /** Undefined when the set has no row for this character in the selected modes. */
    costs: Record<EidolonKey, number> | undefined;
    synergies: SynergyPartner[];
};

export type LightconeRow = {
    kind: 'lightcone';
    name: string;
    displayName: string;
    rarity: number;
    imageUrl: string;
    path: PathParam;
    costs: Record<SuperimpositionKey, number> | undefined;
};

export type Modes = { gameMode: GameModeTag; draftMode: DraftModeTag };

const lower = (tag: string) => tag.toLowerCase();

/**
 * The synergy partners of each character for one mode pair: a pair shows under both of its
 * characters; a modifier that rounds to 0 is hidden. Partners are listed by display name. A pair
 * that appears twice (both orders, or a duplicate row) is listed once, with its first row's
 * modifier, so a partner never shows twice under one character.
 */
export function synergyPartners(
    rows: readonly HsrSynergyCost[],
    characterByName: ReadonlyMap<string, HsrCharacter>,
): Map<string, SynergyPartner[]> {
    const map = new Map<string, SynergyPartner[]>();
    const add = (owner: string, partner: string, modifier: number) => {
        const c = characterByName.get(partner);
        const entry: SynergyPartner = {
            name: partner,
            displayName: c?.displayName ?? partner,
            imageUrl: c?.imageUrl ?? '',
            modifier: roundCost(modifier),
        };
        const list = map.get(owner);
        if (!list) map.set(owner, [entry]);
        else if (!list.some((p) => p.name === partner)) list.push(entry);
    };
    for (const row of rows) {
        if (roundCost(row.costModifier) === 0) continue;
        if (row.characterA === row.characterB) continue;
        add(row.characterA, row.characterB, row.costModifier);
        add(row.characterB, row.characterA, row.costModifier);
    }
    for (const list of map.values()) list.sort((a, b) => compareText(a.displayName, b.displayName));
    return map;
}

export function buildCharacterRows(
    characters: readonly HsrCharacter[],
    lookup: CostLookup,
    modes: Modes,
    characterByName: ReadonlyMap<string, HsrCharacter>,
    archetypesOf: ReadonlyMap<string, readonly string[]> = new Map(),
): CharacterRow[] {
    const partners = synergyPartners(
        lookup.synergies(modes.gameMode, modes.draftMode),
        characterByName,
    );
    return characters.map((c) => {
        const cost = lookup.character(c.name, modes.gameMode, modes.draftMode)?.costs;
        return {
            kind: 'character',
            name: c.name,
            displayName: c.displayName,
            rarity: c.rarity,
            imageUrl: c.imageUrl,
            element: lower(c.element.tag) as ElementParam,
            path: lower(c.path.tag) as PathParam,
            role: lower(c.role.tag) as RoleParam,
            archetypes: archetypesOf.get(c.name) ?? NO_NAMES,
            costs: cost
                ? {
                      e0: cost.e0,
                      e1: cost.e1,
                      e2: cost.e2,
                      e3: cost.e3,
                      e4: cost.e4,
                      e5: cost.e5,
                      e6: cost.e6,
                  }
                : undefined,
            synergies: partners.get(c.name) ?? [],
        };
    });
}

export function buildLightconeRows(
    lightcones: readonly HsrLightcone[],
    lookup: CostLookup,
    modes: Modes,
): LightconeRow[] {
    return lightcones.map((l) => {
        const cost = lookup.lightcone(l.name, modes.gameMode, modes.draftMode)?.costs;
        return {
            kind: 'lightcone',
            name: l.name,
            displayName: l.displayName,
            rarity: l.rarity,
            imageUrl: l.imageUrl,
            path: lower(l.path.tag) as PathParam,
            costs: cost
                ? { s1: cost.s1, s2: cost.s2, s3: cost.s3, s4: cost.s4, s5: cost.s5 }
                : undefined,
        };
    });
}

export type Filters = Pick<CostsView, 'el' | 'path' | 'role' | 'rarity' | 'arch' | 'q'>;

const NO_NAMES: readonly string[] = [];

/** OR within a group, AND across groups. */
export function filterCharacterRows(
    rows: readonly CharacterRow[],
    filters: Filters,
    aliasesOf: (name: string) => readonly string[],
): CharacterRow[] {
    return rows.filter((r) => matchesCharacterFilters(r, filters, aliasesOf(r.name)));
}

const has = <T>(set: readonly T[], value: T) => set.length === 0 || set.includes(value);

/** Light cones have no element or role: those filters do not apply (the tab drops them). */
export function filterLightconeRows(
    rows: readonly LightconeRow[],
    filters: Filters,
    aliasesOf: (name: string) => readonly string[],
): LightconeRow[] {
    return rows.filter(
        (r) =>
            has(filters.path, r.path) &&
            has(filters.rarity, String(r.rarity) as RarityParam) &&
            matchesSearch(r, aliasesOf(r.name), filters.q),
    );
}

/** The value a row sorts by: text, a number, or undefined for a missing cost. */
function sortValue(row: CharacterRow | LightconeRow, key: SortKey): string | number | undefined {
    if (key === 'name') return row.displayName;
    if (key === 'rarity') return row.rarity;
    const costs = row.costs as Record<string, number> | undefined;
    const v = costs?.[key];
    return v === undefined ? undefined : roundCost(v);
}

/**
 * Sorted copy. Missing costs go last in both directions; ties are broken by display name then key
 * (ascending, whatever the direction) so equal values keep one order across renders.
 */
export function sortRows<R extends CharacterRow | LightconeRow>(
    rows: readonly R[],
    key: SortKey,
    dir: SortDir,
): R[] {
    const factor = dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
        const av = sortValue(a, key);
        const bv = sortValue(b, key);
        if (av === undefined && bv !== undefined) return 1;
        if (bv === undefined && av !== undefined) return -1;
        if (av !== undefined && bv !== undefined) {
            const c =
                typeof av === 'number' && typeof bv === 'number'
                    ? av - bv
                    : compareText(String(av), String(bv));
            if (c !== 0) return factor * c;
        }
        return (
            compareText(a.displayName, b.displayName) ||
            (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
        );
    });
}

/**
 * The sort a header click gives (the mockup's rule): the same column flips direction; a new
 * column starts descending, except the name, which starts ascending.
 */
export function nextSort(current: { sort: SortKey; dir: SortDir }, column: SortKey) {
    if (current.sort === column)
        return { sort: column, dir: current.dir === 'asc' ? 'desc' : 'asc' } as const;
    return { sort: column, dir: column === 'name' ? 'asc' : 'desc' } as const;
}

/** "12 units listed" / "1 unit listed"; "light cone(s)" on the other tab. */
export function countNoun(tab: Tab, n: number): string {
    const noun = tab === 'characters' ? 'unit' : 'light cone';
    return n === 1 ? noun : `${noun}s`;
}
