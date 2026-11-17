import {
    parseTeamBuilderSearch,
    type TeamBuilderSearch,
    type TeamBuilderView,
} from './teambuilderSearch';

/*
 * The validated search with its defaults filled in, and back (the costs page's `costsView.ts` pattern): kept apart
 * from the validator, which the route definition puts in the entry chunk. `team` is not part of the view: the page
 * reads it once on arrival (`useWorkingTeam`).
 */

export function toView(search: TeamBuilderSearch): TeamBuilderView {
    return {
        draft: search.draft ?? 'classic',
        mode: search.mode ?? 'as',
        set: search.set ?? 0,
        el: search.el ?? [],
        path: search.path ?? [],
        role: search.role ?? [],
        rarity: search.rarity ?? [],
        arch: search.arch ?? [],
        q: search.q ?? '',
    };
}

/** The address form of a view: defaults left out, no `team` (the inverse of `toView`). */
export function toSearch(view: TeamBuilderView): TeamBuilderSearch {
    return parseTeamBuilderSearch({
        draft: view.draft,
        mode: view.mode,
        set: view.set === 0 ? undefined : String(view.set),
        el: view.el,
        path: view.path,
        role: view.role,
        rarity: view.rarity,
        arch: view.arch,
        q: view.q,
    });
}
