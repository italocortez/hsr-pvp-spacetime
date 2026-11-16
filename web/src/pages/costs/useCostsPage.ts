import type { CostSet } from '@bindings/types';
import { useNavigate } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { retryReferenceSet, useReferenceSet } from '@/stdb/referenceSet';
import {
    activeFilterCount,
    archetypeNamesByCharacter,
    archetypeOptions,
    buildCharacterRows,
    buildLightconeRows,
    type CharacterRow,
    costSetsForMode,
    DRAFT_TAG,
    filterCharacterRows,
    filterLightconeRows,
    GAME_MODE_TAG,
    type LightconeRow,
    MODE_PARAM,
    nextSort,
    sortRows,
} from './costModel';
import {
    type CostsSearch,
    type CostsView,
    type ModeParam,
    parseCostsSearch,
    type SortDir,
    type SortKey,
    type Tab,
} from './costsSearch';
import { toSearch, toView } from './costsView';
import { useCustomCostSet } from './useCostSet';

/*
 * The costs page's state (S14.2): the address is the state (user ruling item 5), the data comes
 * from the reference set (with the default cost set) and, for a custom set, a route subscription.
 * Local only: which rows are expanded (cleared on any change of tab, draft mode, game mode or set),
 * the other tab's sort (each tab keeps its own sort, as in the mockup; the address holds the
 * shown tab's), and the unknown-set notice (shown until the next control is used).
 *
 * Every control writes the address through `go`: a same-page navigation that keeps the scroll
 * position (`resetScroll: false`) and computes the next search from the router's latest one (the
 * functional form), so two quick activations both land.
 */

export type TableState = 'loading' | 'error' | 'ready';

type Update = (view: CostsView) => CostsView;

const EMPTY_ALIASES: readonly string[] = [];

export function useCostsPage(search: CostsSearch) {
    const view = useMemo(() => toView(search), [search]);
    const navigate = useNavigate({ from: '/costs' });
    const ref = useReferenceSet({ costs: true });

    // The requested set: shown only once the published list says it exists. Unknown, unpublished
    // or deleted: the default set, with a notice, and the id leaves the address (below).
    const requestedSet = view.set;
    const publishedSet: CostSet | undefined =
        requestedSet > 0 ? ref.costSets.find((s) => s.id === requestedSet) : undefined;
    const fallback = requestedSet > 0 && ref.ready && publishedSet === undefined;
    const custom = useCustomCostSet(publishedSet?.id);

    // A custom set fixes the game mode to its own (user ruling item 1).
    const mode: ModeParam = publishedSet ? MODE_PARAM[publishedSet.gameMode.tag] : view.mode;
    const modes = useMemo(
        () => ({ gameMode: GAME_MODE_TAG[mode], draftMode: DRAFT_TAG[view.draft] }),
        [mode, view.draft],
    );

    const go = useCallback(
        (update: Update, replace = false) => {
            void navigate({
                search: (prev) => toSearch(update(toView(parseCostsSearch(prev)))),
                replace,
                resetScroll: false,
            });
        },
        [navigate],
    );

    // A shared address whose mode disagrees with its set: the address follows the set.
    useEffect(() => {
        if (publishedSet && view.mode !== mode) go((v) => ({ ...v, mode }), true);
    }, [publishedSet, view.mode, mode, go]);

    // The unknown-set notice: kept here once shown, so the bad id can leave the address at once
    // (replaced, so Back never returns to it) while the notice stays until the next control.
    const [notice, setNotice] = useState<number | null>(null);
    useEffect(() => {
        if (!fallback) return;
        setNotice(requestedSet);
        go((v) => (v.set === requestedSet ? { ...v, set: 0 } : v), true);
    }, [fallback, requestedSet, go]);
    const noticeSet = fallback ? requestedSet : notice;

    /** A control's change: the notice goes with the first one. */
    const act = (update: Update, replace = false) => {
        setNotice(null);
        go(update, replace);
    };

    const lookup = publishedSet ? custom.lookup : ref.defaultCosts;
    const aliasesOf = useCallback(
        (name: string) =>
            (view.tab === 'characters'
                ? ref.characterByName.get(name)?.aliases
                : ref.lightconeByName.get(name)?.aliases) ?? EMPTY_ALIASES,
        [view.tab, ref.characterByName, ref.lightconeByName],
    );

    // Archetypes (S14.2b): from the reference set's `archetype` and `hsr_character_archetype`,
    // already subscribed; no query of their own.
    const archetypesOf = useMemo(
        () => archetypeNamesByCharacter(ref.archetypes, ref.characterArchetypes),
        [ref.archetypes, ref.characterArchetypes],
    );
    const archetypeNames = useMemo(() => archetypeOptions(ref.archetypes), [ref.archetypes]);

    // Unknown archetype names leave the address once the list is known (not before: a shared
    // link must survive the page's loading), replaced so Back never returns to them.
    const unknownArch = ref.ready && view.arch.some((a) => !archetypeNames.includes(a));
    useEffect(() => {
        if (!unknownArch) return;
        go((v) => ({ ...v, arch: v.arch.filter((a) => archetypeNames.includes(a)) }), true);
    }, [unknownArch, archetypeNames, go]);

    const characterRows = useMemo(
        () =>
            view.tab === 'characters'
                ? buildCharacterRows(
                      ref.characters,
                      lookup,
                      modes,
                      ref.characterByName,
                      archetypesOf,
                  )
                : [],
        [view.tab, ref.characters, lookup, modes, ref.characterByName, archetypesOf],
    );
    const lightconeRows = useMemo(
        () => (view.tab === 'lightcones' ? buildLightconeRows(ref.lightcones, lookup, modes) : []),
        [view.tab, ref.lightcones, lookup, modes],
    );

    // `view` is memoized on the router's search, which keeps its identity while unchanged.
    const rows: CharacterRow[] | LightconeRow[] = useMemo(
        () =>
            view.tab === 'characters'
                ? sortRows(filterCharacterRows(characterRows, view, aliasesOf), view.sort, view.dir)
                : sortRows(
                      filterLightconeRows(lightconeRows, view, aliasesOf),
                      view.sort,
                      view.dir,
                  ),
        [view, characterRows, lightconeRows, aliasesOf],
    );

    const error = ref.error ?? (publishedSet ? custom.error : ref.costsError);
    const loading = !ref.ready || (publishedSet ? !custom.ready : !ref.costsReady);
    const tableState: TableState = error ? 'error' : loading ? 'loading' : 'ready';

    // Expanded rows: cleared whenever the tab, draft mode, game mode or set changes.
    const scope = `${view.tab}|${view.draft}|${mode}|${publishedSet?.id ?? 0}`;
    const [expanded, setExpanded] = useState<{ scope: string; names: ReadonlySet<string> }>({
        scope,
        names: new Set(),
    });
    // A new scope empties the set for good (coming back to the old scope keeps it empty).
    if (expanded.scope !== scope) setExpanded({ scope, names: EMPTY_SET });
    const expandedNames = expanded.scope === scope ? expanded.names : EMPTY_SET;
    const toggleExpanded = useCallback(
        (name: string) => {
            setNotice(null);
            setExpanded((prev) => {
                const names = new Set(prev.scope === scope ? prev.names : EMPTY_SET);
                if (names.has(name)) names.delete(name);
                else names.add(name);
                return { scope, names };
            });
        },
        [scope],
    );
    /** Any other use of the page (the intro toggle): the notice goes too. */
    const dismissNotice = useCallback(() => setNotice(null), []);

    // Each tab keeps its own sort; the address holds the shown tab's.
    const otherSort = useRef<Record<Tab, { sort: SortKey; dir: SortDir }>>({
        characters: { sort: 'name', dir: 'asc' },
        lightcones: { sort: 'name', dir: 'asc' },
    });

    const actions = {
        setTab(tab: Tab) {
            if (tab === view.tab) return;
            act((v) => {
                if (v.tab === tab) return v;
                otherSort.current[v.tab] = { sort: v.sort, dir: v.dir };
                const kept = otherSort.current[tab];
                // Light Cones have no element or role: those filters are cleared (the validator
                // also drops them, and a 3-star rarity going back to Characters). Archetypes
                // classify characters only: cleared too.
                return { ...v, tab, el: [], role: [], arch: [], sort: kept.sort, dir: kept.dir };
            });
        },
        setDraft(draft: CostsView['draft']) {
            act((v) => ({ ...v, draft }));
        },
        setMode(next: ModeParam) {
            if (publishedSet) return;
            act((v) => ({ ...v, mode: next, set: 0 }));
        },
        setCostSet(id: number) {
            const picked = ref.costSets.find((s) => s.id === id);
            if (id !== 0 && !picked) return;
            act((v) => ({ ...v, set: id, mode: picked ? MODE_PARAM[picked.gameMode.tag] : mode }));
        },
        toggle<K extends 'el' | 'path' | 'role' | 'rarity' | 'arch'>(
            key: K,
            value: CostsView[K][number],
        ) {
            act((v) => {
                const list = v[key] as string[];
                const nextList = list.includes(value)
                    ? list.filter((x) => x !== value)
                    : [...list, value];
                return { ...v, [key]: nextList };
            });
        },
        setQuery(text: string) {
            // Typing replaces the entry: typing never adds a history step, so Back leaves the
            // page state from before the search. The validator stores the text trimmed.
            act((v) => ({ ...v, q: text }), true);
        },
        clearFilters() {
            act((v) => ({ ...v, el: [], path: [], role: [], rarity: [], arch: [], q: '' }));
        },
        sortBy(column: SortKey) {
            act((v) => ({ ...v, ...nextSort(v, column) }));
        },
        retry() {
            if (ref.error || (!publishedSet && ref.costsError)) retryReferenceSet();
            if (publishedSet && custom.error) custom.retry();
        },
    };

    const filterCount = activeFilterCount(view);
    const setsForMode = useMemo(() => costSetsForMode(ref.costSets, mode), [ref.costSets, mode]);

    return {
        view,
        mode,
        rows,
        tableState,
        error,
        noticeSet,
        costSet: publishedSet,
        setsForMode,
        setsReady: ref.ready,
        archetypeNames,
        filterCount,
        expandedNames,
        toggleExpanded,
        dismissNotice,
        actions,
    };
}

const EMPTY_SET: ReadonlySet<string> = new Set();
