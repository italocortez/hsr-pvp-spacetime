import {
    archNames,
    CHARACTER_RARITIES,
    DRAFT_MODES,
    type DraftParam,
    ELEMENTS,
    type ElementParam,
    GAME_MODES,
    type ModeParam,
    oneOf,
    PATHS,
    type PathParam,
    parseSetId,
    type RarityParam,
    ROLES,
    type RoleParam,
    searchText,
    setOf,
    single,
} from '@/lib/rosterSearch';

/*
 * The `/teambuilder` address (S14.3a; A190 items 7 and 9; plain text, A169): the cost set, draft mode and game
 * mode, the pool's filters and search, as on the costs page, plus `team`, a packed team
 * (`shared/teambuilder/teamCode.ts`) that a shared link carries. Defaults are left out. Anything unknown or
 * invalid is dropped. `team` is only screened here (its alphabet and length); the page decodes it once on arrival,
 * loads it and removes it from the address. The working team itself is kept in browser storage, not here.
 *
 * | Param | Values | Default (omitted) |
 * |---|---|---|
 * | `draft` | `auction` | classic |
 * | `mode` | `moc`, `aa` | as |
 * | `set` | a published cost set id, 1 to 4294967295, canonical decimal | 0 (Default) |
 * | `el`, `path`, `role` (repeated) | as on the costs page | none |
 * | `rarity` (repeated) | 5 4 | none |
 * | `arch` (repeated) | archetype names (the costs page's rule) | none |
 * | `q` | search text, trimmed, at most 100 characters | empty |
 * | `team` | a packed team: [a-z0-9._-], 1 to 400 characters; anything else given becomes `!` (unreadable) | none |
 *
 * Kept small: it sits in the entry chunk with the route definition.
 */

export type TeamBuilderSearch = {
    draft?: 'auction';
    mode?: 'moc' | 'aa';
    set?: number;
    el?: ElementParam[];
    path?: PathParam[];
    role?: RoleParam[];
    rarity?: RarityParam[];
    arch?: string[];
    q?: string;
    team?: string;
};

export type TeamBuilderView = {
    draft: DraftParam;
    mode: ModeParam;
    set: number;
    el: ElementParam[];
    path: PathParam[];
    role: RoleParam[];
    rarity: RarityParam[];
    arch: string[];
    q: string;
};

/** `validateSearch` for `/teambuilder`. */
export function parseTeamBuilderSearch(search: Record<string, unknown>): TeamBuilderSearch {
    const mode = oneOf(search.mode, GAME_MODES);
    const team = single(search.team);
    return {
        draft: oneOf(search.draft, DRAFT_MODES) === 'auction' ? 'auction' : undefined,
        mode: mode === 'as' ? undefined : mode,
        set: parseSetId(search.set),
        el: setOf(search.el, ELEMENTS),
        path: setOf(search.path, PATHS),
        role: setOf(search.role, ROLES),
        rarity: setOf(search.rarity, CHARACTER_RARITIES),
        arch: archNames(search.arch),
        q: searchText(search.q),
        team: teamParam(search.team, team),
    };
}

/**
 * A `team` value that is given but cannot be a packed team (upper case, a trailing `)` from a chat app, percent
 * encoding, over 400 characters, given twice) is kept as this marker, which never decodes: the page then says the
 * link could not be read instead of dropping it in silence (review S14.3a S2).
 */
export const UNREADABLE_TEAM = '!';

function teamParam(raw: unknown, team: string | undefined): string | undefined {
    if (raw === undefined) return undefined;
    return team !== undefined && /^[a-z0-9._-]{1,400}$/.test(team) ? team : UNREADABLE_TEAM;
}
