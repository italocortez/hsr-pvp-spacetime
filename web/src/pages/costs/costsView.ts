import { type CostsSearch, type CostsView, parseCostsSearch } from './costsSearch';

/*
 * The validated search with its defaults filled in, and back. Kept apart from the validator
 * (`costsSearch.ts`), which the route definition puts in the entry chunk: these two live in the
 * page's own chunk.
 */

/** The search with its defaults filled in. */
export function toView(search: CostsSearch): CostsView {
    return {
        tab: search.tab ?? 'characters',
        draft: search.draft ?? 'classic',
        mode: search.mode ?? 'as',
        set: search.set ?? 0,
        el: search.el ?? [],
        path: search.path ?? [],
        role: search.role ?? [],
        rarity: search.rarity ?? [],
        arch: search.arch ?? [],
        q: search.q ?? '',
        sort: search.sort ?? 'name',
        dir: search.dir ?? 'asc',
    };
}

/** The address form of a view: defaults left out (the inverse of `toView`). */
export function toSearch(view: CostsView): CostsSearch {
    return parseCostsSearch({
        tab: view.tab,
        draft: view.draft,
        mode: view.mode,
        set: view.set === 0 ? undefined : String(view.set),
        el: view.el,
        path: view.path,
        role: view.role,
        rarity: view.rarity,
        arch: view.arch,
        q: view.q,
        sort: view.sort,
        dir: view.dir,
    });
}
