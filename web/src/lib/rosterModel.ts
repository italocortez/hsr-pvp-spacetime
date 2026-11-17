import type { Archetype, CostSet, HsrCharacterArchetype } from '@bindings/types';
import type { DraftModeTag, GameModeTag } from '@/stdb/costLookup';
import type {
    DraftParam,
    ElementParam,
    ModeParam,
    PathParam,
    RarityParam,
    RoleParam,
} from './rosterSearch';

/*
 * Labels, number format, search and filter rules shared by the pages that show a roster with costs (S14.2 costs,
 * S14.3a team builder). Moved here from `pages/costs/costModel.ts` in S14.3a; `costModel.ts` re-exports them, so
 * its behaviour and tests are unchanged.
 */

export const GAME_MODE_TAG: Record<ModeParam, GameModeTag> = {
    as: 'ApocalypticShadow',
    moc: 'MemoryOfChaos',
    aa: 'AnomalyArbitration',
};
export const MODE_PARAM: Record<GameModeTag, ModeParam> = {
    ApocalypticShadow: 'as',
    MemoryOfChaos: 'moc',
    AnomalyArbitration: 'aa',
};
export const MODE_LABEL: Record<ModeParam, string> = {
    as: 'Apocalyptic Shadow',
    moc: 'Memory of Chaos',
    aa: 'Anomaly Arbitration',
};
export const MODE_SHORT: Record<ModeParam, string> = { as: 'AS', moc: 'MoC', aa: 'AA' };
export const DRAFT_TAG: Record<DraftParam, DraftModeTag> = {
    classic: 'Classic',
    auction: 'Auction',
};
export const DRAFT_LABEL: Record<DraftParam, string> = { classic: 'Classic', auction: 'Auction' };

export const ELEMENT_LABEL: Record<ElementParam, string> = {
    fire: 'Fire',
    ice: 'Ice',
    imaginary: 'Imaginary',
    lightning: 'Lightning',
    physical: 'Physical',
    quantum: 'Quantum',
    wind: 'Wind',
};
export const PATH_LABEL: Record<PathParam, string> = {
    destruction: 'Destruction',
    hunt: 'Hunt',
    erudition: 'Erudition',
    harmony: 'Harmony',
    nihility: 'Nihility',
    preservation: 'Preservation',
    abundance: 'Abundance',
    remembrance: 'Remembrance',
    elation: 'Elation',
};
export const ROLE_LABEL: Record<RoleParam, string> = {
    dps: 'DPS',
    support: 'Support',
    sustain: 'Sustain',
};

/** f32 values (1.5000000xxx) rounded to the one decimal the cost tables use. */
export function roundCost(value: number): number {
    return Math.round(value * 10) / 10;
}

/** A cost as text: an integer, or one decimal; a negative one with a real minus sign. */
export function formatCost(value: number): string {
    const v = roundCost(value);
    const abs = Math.abs(v);
    const text = Number.isInteger(abs) ? String(abs) : abs.toFixed(1);
    return v < 0 ? `−${text}` : text;
}

/** A cost with one decimal always ("7.0", "0.5"): the team builder's pills and picker (the mockup's `fmt`). */
export function formatCostFixed(value: number): string {
    const v = roundCost(value);
    const text = Math.abs(v).toFixed(1);
    return v < 0 ? `−${text}` : text;
}

/** A synergy modifier with its sign: "+3", "+0.5", "minus1" (a real minus sign, never "+-1"). */
export function formatModifier(value: number): string {
    const v = roundCost(value);
    return v < 0 ? formatCost(v) : `+${formatCost(v)}`;
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
export function compareText(a: string, b: string): number {
    return collator.compare(a, b);
}

/**
 * Archetype names per character, from the archetype rows and the character links of the
 * reference set. A link to an archetype that is not in the list is skipped; names are listed
 * once each.
 */
export function archetypeNamesByCharacter(
    archetypes: readonly Archetype[],
    links: readonly HsrCharacterArchetype[],
): Map<string, string[]> {
    const nameById = new Map(archetypes.map((a) => [a.id, a.name] as const));
    const map = new Map<string, string[]>();
    for (const link of links) {
        const name = nameById.get(link.archetypeId);
        if (name === undefined) continue;
        const list = map.get(link.characterName);
        if (!list) map.set(link.characterName, [name]);
        else if (!list.includes(name)) list.push(name);
    }
    return map;
}

/** The archetype filter's options: every archetype name, alphabetically. */
export function archetypeOptions(archetypes: readonly Archetype[]): string[] {
    return archetypes.map((a) => a.name).sort(compareText);
}

/**
 * Search: a case-insensitive substring of the display name or any alias, as the mockup's script
 * (its `name` and `aliases`). The internal key is not searched: it is not shown, and the seed's
 * aliases already list it.
 */
export function matchesSearch(
    entry: { displayName: string },
    aliases: readonly string[],
    query: string,
): boolean {
    const q = query.trim().toLowerCase();
    if (q === '') return true;
    if (entry.displayName.toLowerCase().includes(q)) return true;
    return aliases.some((a) => a.toLowerCase().includes(q));
}

/** The pool filters of a character list (the costs page's Characters tab, the team builder's pool). */
export type RosterFilters = {
    el: readonly ElementParam[];
    path: readonly PathParam[];
    role: readonly RoleParam[];
    rarity: readonly RarityParam[];
    arch: readonly string[];
    q: string;
};

/** A character as the filters see it. */
export type FilterableCharacter = {
    name: string;
    displayName: string;
    rarity: number;
    element: ElementParam;
    path: PathParam;
    role: RoleParam;
    archetypes: readonly string[];
};

const has = <T>(set: readonly T[], value: T) => set.length === 0 || set.includes(value);

/** OR within a group, AND across groups; a character with any picked archetype (none: no match). */
export function matchesCharacterFilters(
    c: FilterableCharacter,
    filters: RosterFilters,
    aliases: readonly string[],
): boolean {
    return (
        has(filters.el, c.element) &&
        has(filters.path, c.path) &&
        has(filters.role, c.role) &&
        has(filters.rarity, String(c.rarity) as RarityParam) &&
        (filters.arch.length === 0 || c.archetypes.some((a) => filters.arch.includes(a))) &&
        matchesSearch(c, aliases, filters.q)
    );
}

/** "Clear N": every chip that is on, plus one for a search. */
export function activeFilterCount(filters: RosterFilters): number {
    return (
        filters.el.length +
        filters.path.length +
        filters.role.length +
        filters.rarity.length +
        filters.arch.length +
        (filters.q.trim() !== '' ? 1 : 0)
    );
}

/** The cost sets the selector lists for a game mode: published ones of that mode, by name. */
export function costSetsForMode(sets: readonly CostSet[], mode: ModeParam): CostSet[] {
    return sets
        .filter((s) => s.gameMode.tag === GAME_MODE_TAG[mode])
        .sort((a, b) => compareText(a.name, b.name) || a.id - b.id);
}
