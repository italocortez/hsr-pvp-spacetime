import type { CostSet, HsrCharacter, HsrLightcone } from '@bindings/types';
import {
    auctionSpend,
    BID_MAX,
    BUDGET_MAX,
    type Budgets,
    DEFAULT_BUDGETS,
    decodeTeam,
    defaultEidolon,
    defaultSuperimposition,
    EMPTY_SLOTS,
    encodeTeam,
    firstEmptySlot,
    type GameMode,
    type Superimposition,
    slotOf,
    type TeamCostSource,
    teamCost,
} from '@shared/teambuilder';
import { useNavigate } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
    activeFilterCount,
    archetypeNamesByCharacter,
    archetypeOptions,
    compareText,
    costSetsForMode,
    DRAFT_TAG,
    type FilterableCharacter,
    GAME_MODE_TAG,
    MODE_PARAM,
    matchesCharacterFilters,
} from '@/lib/rosterModel';
import type { ElementParam, ModeParam, PathParam, RoleParam } from '@/lib/rosterSearch';
import { retryReferenceSet, useReferenceSet } from '@/stdb/referenceSet';
import { useCustomCostSet } from '@/stdb/useCustomCostSet';
import {
    parseTeamBuilderSearch,
    type TeamBuilderSearch,
    type TeamBuilderView,
} from './teambuilderSearch';
import { toSearch, toView } from './teambuilderView';
import { useLoadouts } from './useLoadouts';
import { useWorkingTeam } from './useWorkingTeam';

/*
 * The team builder's state (S14.3a). The address holds the cost set, the modes and the pool's filters (A190 items
 * 7 and 9, the costs page's rules: every control writes it through `go`, typing replaces the entry, the rest push
 * one, scroll kept); the working team lives in browser storage (`useWorkingTeam`). Data: the reference set with
 * the default cost set, and a custom set's route subscription, exactly as the costs page (no new subscription).
 */

export type DataState = 'loading' | 'error' | 'ready';

/** What a press on a pool card did. */
export type PickResult = 'added' | 'removed' | 'full' | 'unknown';

/** A pool card: the character as the filters see it, plus what the card shows. */
export type PoolCharacter = FilterableCharacter & { imageUrl: string };

type Update = (view: TeamBuilderView) => TeamBuilderView;

const EMPTY_ALIASES: readonly string[] = [];
const NO_NAMES: readonly string[] = [];
const lower = (tag: string) => tag.toLowerCase();

/** The cost rows of one set for the chosen modes, as the shared model reads them. */
function costSource(
    lookup: ReturnType<typeof useReferenceSet>['defaultCosts'],
    mode: ModeParam,
    draft: TeamBuilderView['draft'],
): TeamCostSource {
    const gameMode = GAME_MODE_TAG[mode];
    const draftMode = DRAFT_TAG[draft];
    return {
        character(name) {
            const c = lookup.character(name, gameMode, draftMode)?.costs;
            return c ? [c.e0, c.e1, c.e2, c.e3, c.e4, c.e5, c.e6] : undefined;
        },
        lightcone(name) {
            const c = lookup.lightcone(name, gameMode, draftMode)?.costs;
            return c ? [c.s1, c.s2, c.s3, c.s4, c.s5] : undefined;
        },
        synergies: () => lookup.synergies(gameMode, draftMode),
    };
}

export function useTeamBuilderPage(search: TeamBuilderSearch) {
    const view = useMemo(() => toView(search), [search]);
    const navigate = useNavigate({ from: '/teambuilder' });
    const ref = useReferenceSet({ costs: true });

    // The cost set: shown once the published list has it; otherwise Default with a notice (the costs page's rule).
    const requestedSet = view.set;
    const publishedSet: CostSet | undefined =
        requestedSet > 0 ? ref.costSets.find((s) => s.id === requestedSet) : undefined;
    const fallback = requestedSet > 0 && ref.ready && publishedSet === undefined;
    const custom = useCustomCostSet(publishedSet?.id);

    // A custom set fixes the game mode to its own (A185 item 1).
    const mode: ModeParam = publishedSet ? MODE_PARAM[publishedSet.gameMode.tag] : view.mode;

    const go = useCallback(
        (update: Update, replace = false) => {
            void navigate({
                search: (prev) => toSearch(update(toView(parseTeamBuilderSearch(prev)))),
                replace,
                resetScroll: false,
            });
        },
        [navigate],
    );

    const team = useWorkingTeam(search.team, {
        draftMode: view.draft,
        gameMode: mode as GameMode,
        costSetId: publishedSet?.id ?? 0,
    });

    // S14.3c: the page's team as packed text, for the active loadout. While the published sets load, the address's
    // set stands (a loadout's set must not read as Default before the list is here).
    const loadoutSet = publishedSet?.id ?? (ref.ready ? 0 : view.set);
    const code = useMemo(() => {
        const e = encodeTeam({
            slots: team.slots,
            budgets: team.budgets,
            draftMode: view.draft,
            gameMode: mode as GameMode,
            costSetId: loadoutSet,
        });
        return e.ok ? e.code : null;
    }, [team.slots, team.budgets, view.draft, mode, loadoutSet]);
    const teamLoad = team.load;
    const loadCode = useCallback(
        (text: string) => {
            const d = decodeTeam(text);
            if (!d.ok) return;
            const t = d.team;
            teamLoad({ slots: t.slots, budgets: t.budgets });
            go((v) => ({ ...v, draft: t.draftMode, mode: t.gameMode, set: t.costSetId }), true);
        },
        [teamLoad, go],
    );
    const emptyCode = useCallback(() => {
        const e = encodeTeam({
            slots: EMPTY_SLOTS,
            budgets: DEFAULT_BUDGETS,
            draftMode: view.draft,
            gameMode: mode as GameMode,
            costSetId: loadoutSet,
        });
        return e.ok ? e.code : null;
    }, [view.draft, mode, loadoutSet]);
    const [linkArrived] = useState(() => team.arrival.kind === 'loaded');
    const loadouts = useLoadouts({
        code,
        emptyCode,
        load: loadCode,
        linkArrived,
        hasPrevious: team.previous !== null,
        forgetPrevious: team.dismissPrevious,
    });
    const edited = loadouts.edited;

    // A packed team in the address (a shared link): loaded once by `useWorkingTeam`; its settings move into the
    // address and `team` leaves it (replaced, so Back never loads it again over later edits).
    const [linkNotice, setLinkNotice] = useState<string | null>(null);
    const { arrival, settleArrival } = team;
    useEffect(() => {
        if (arrival.kind === 'none') return;
        if (arrival.kind === 'loaded') {
            const t = arrival.team;
            go((v) => ({ ...v, draft: t.draftMode, mode: t.gameMode, set: t.costSetId }), true);
        } else {
            setLinkNotice('The team in this link could not be read. Showing your saved team.');
            go((v) => v, true);
        }
        settleArrival();
    }, [arrival, go, settleArrival]);

    useEffect(() => {
        if (publishedSet && view.mode !== mode) go((v) => ({ ...v, mode }), true);
    }, [publishedSet, view.mode, mode, go]);

    const [setNotice, setSetNotice] = useState<number | null>(null);
    useEffect(() => {
        if (!fallback) return;
        setSetNotice(requestedSet);
        go((v) => (v.set === requestedSet ? { ...v, set: 0 } : v), true);
    }, [fallback, requestedSet, go]);
    const noticeSet = fallback ? requestedSet : setNotice;

    const [fullHint, setFullHint] = useState(false);
    const dismissNotices = useCallback(() => {
        setSetNotice(null);
        setLinkNotice(null);
    }, []);
    const act = (update: Update, replace = false) => {
        dismissNotices();
        go(update, replace);
    };

    const lookup = publishedSet ? custom.lookup : ref.defaultCosts;
    const source = useMemo(() => costSource(lookup, mode, view.draft), [lookup, mode, view.draft]);
    const computed = useMemo(
        () => teamCost(team.slots, view.draft, source),
        [team.slots, view.draft, source],
    );

    // The pool.
    const archetypesOf = useMemo(
        () => archetypeNamesByCharacter(ref.archetypes, ref.characterArchetypes),
        [ref.archetypes, ref.characterArchetypes],
    );
    const archetypeNames = useMemo(() => archetypeOptions(ref.archetypes), [ref.archetypes]);
    const unknownArch = ref.ready && view.arch.some((a) => !archetypeNames.includes(a));
    useEffect(() => {
        if (!unknownArch) return;
        go((v) => ({ ...v, arch: v.arch.filter((a) => archetypeNames.includes(a)) }), true);
    }, [unknownArch, archetypeNames, go]);

    const allCharacters: PoolCharacter[] = useMemo(
        () =>
            [...ref.characters]
                .sort((a, b) => compareText(a.displayName, b.displayName))
                .map((c) => ({
                    name: c.name,
                    displayName: c.displayName,
                    rarity: c.rarity,
                    imageUrl: c.imageUrl,
                    element: lower(c.element.tag) as ElementParam,
                    path: lower(c.path.tag) as PathParam,
                    role: lower(c.role.tag) as RoleParam,
                    archetypes: archetypesOf.get(c.name) ?? NO_NAMES,
                })),
        [ref.characters, archetypesOf],
    );
    const pool = useMemo(
        () =>
            allCharacters.filter((c) =>
                matchesCharacterFilters(
                    c,
                    view,
                    ref.characterByName.get(c.name)?.aliases ?? EMPTY_ALIASES,
                ),
            ),
        [allCharacters, view, ref.characterByName],
    );

    const error = ref.error ?? (publishedSet ? custom.error : ref.costsError);
    const loading = !ref.ready || (publishedSet ? !custom.ready : !ref.costsReady);
    const dataState: DataState = error ? 'error' : loading ? 'loading' : 'ready';
    // While the rows are not all here, every filled slot would read as "missing": no warning and no "n/a" until the
    // data is ready (review S1); the page shows placeholders instead of figures.
    const costsReady = dataState === 'ready';
    const cost = useMemo(
        () => (costsReady ? computed : { ...computed, missing: [] }),
        [computed, costsReady],
    );

    // S14.3b: the Auction simulator, from the same figures as the total; null in Classic, where the figures are
    // Classic costs and a winning amount means nothing (review M11).
    const spend = useMemo(
        () => (view.draft === 'auction' ? auctionSpend(team.slots, cost, team.budgets) : null),
        [view.draft, team.slots, cost, team.budgets],
    );

    const sortedLightcones = useMemo(
        () => [...ref.lightcones].sort((a, b) => compareText(a.displayName, b.displayName)),
        [ref.lightcones],
    );

    /** The character with this key, if the reference set has it. */
    const characterOf = useCallback(
        (name: string): HsrCharacter | undefined => ref.characterByName.get(name),
        [ref.characterByName],
    );
    const lightconeOf = useCallback(
        (name: string): HsrLightcone | undefined => ref.lightconeByName.get(name),
        [ref.lightconeByName],
    );

    const filled = team.slots.filter((s) => s !== null).length;

    const actions = {
        setDraft(draft: TeamBuilderView['draft']) {
            edited();
            act((v) => ({ ...v, draft }));
        },
        setMode(next: ModeParam) {
            if (publishedSet) return;
            edited();
            act((v) => ({ ...v, mode: next, set: 0 }));
        },
        setCostSet(id: number) {
            const picked = ref.costSets.find((s) => s.id === id);
            if (id !== 0 && !picked) return;
            edited();
            act((v) => ({ ...v, set: id, mode: picked ? MODE_PARAM[picked.gameMode.tag] : mode }));
        },
        toggle<K extends 'el' | 'path' | 'role' | 'rarity' | 'arch'>(
            key: K,
            value: TeamBuilderView[K][number],
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
            act((v) => ({ ...v, q: text }), true);
        },
        clearFilters() {
            act((v) => ({ ...v, el: [], path: [], role: [], rarity: [], arch: [], q: '' }));
        },
        retry() {
            if (ref.error || (!publishedSet && ref.costsError)) retryReferenceSet();
            if (publishedSet && custom.error) custom.retry();
        },
        /**
         * A pool card: a picked character leaves the team; another joins slot `target` when given and empty,
         * else the first empty slot. Returns what happened and the slot it happened in (-1 for none), for the page's
         * status line and announcement.
         */
        pick(name: string, target?: number): { what: PickResult; index: number } {
            dismissNotices();
            const at = slotOf(team.slots, name);
            if (at >= 0) {
                edited();
                team.setSlot(at, null);
                setFullHint(false);
                return { what: 'removed', index: at };
            }
            const c = ref.characterByName.get(name);
            if (!c) return { what: 'unknown', index: -1 };
            const index =
                target !== undefined && team.slots[target] === null
                    ? target
                    : firstEmptySlot(team.slots);
            if (index < 0) {
                setFullHint(true);
                return { what: 'full', index: -1 };
            }
            edited();
            team.setSlot(index, {
                character: name,
                eidolon: defaultEidolon(c),
                lightcone: null,
                superimposition: 1,
            });
            setFullHint(false);
            return { what: 'added', index };
        },
        remove(index: number) {
            dismissNotices();
            edited();
            team.setSlot(index, null);
            setFullHint(false);
        },
        setEidolon(index: number, eidolon: number) {
            const s = team.slots[index];
            if (!s || eidolon < 0 || eidolon > 6) return;
            edited();
            team.setSlot(index, { ...s, eidolon: eidolon as typeof s.eidolon });
        },
        setSuperimposition(index: number, value: number) {
            const s = team.slots[index];
            if (!s?.lightcone || value < 1 || value > 5) return;
            edited();
            team.setSlot(index, { ...s, superimposition: value as Superimposition });
        },
        equip(index: number, lightcone: string | null) {
            const s = team.slots[index];
            if (!s) return;
            edited();
            if (lightcone === null) {
                team.setSlot(index, { ...s, lightcone: null, superimposition: 1 });
                return;
            }
            const l = ref.lightconeByName.get(lightcone);
            if (!l) return;
            team.setSlot(index, {
                ...s,
                lightcone,
                superimposition: defaultSuperimposition(l),
            });
        },
        /** S14.3b: a slot's Auction extra bid, hundredths (0 clears it; the packed text then writes nothing). */
        setBid(index: number, hundredths: number) {
            const s = team.slots[index];
            if (!s) return;
            edited();
            const bid = Math.min(BID_MAX, Math.max(0, Math.round(hundredths)));
            const { bid: _old, ...rest } = s;
            team.setSlot(index, bid > 0 ? { ...rest, bid } : rest);
        },
        /** S14.3b: one of the two Auction budgets, hundredths. */
        setBudget(kind: keyof Budgets, hundredths: number) {
            const v = Math.min(BUDGET_MAX, Math.max(0, Math.round(hundredths)));
            edited();
            team.setBudgets((b) => (b[kind] === v ? b : { ...b, [kind]: v }));
        },
        swap(a: number, b: number) {
            dismissNotices();
            edited();
            team.swap(a, b);
        },
        clearTeam() {
            dismissNotices();
            edited();
            team.clear();
            setFullHint(false);
        },
        /** The team a link replaced comes back, with the modes it was saved under. */
        restorePrevious() {
            const prev = team.previous;
            if (!prev) return;
            edited();
            team.restorePrevious();
            setFullHint(false);
            go((v) => ({ ...v, draft: prev.draftMode, mode: prev.gameMode, set: prev.costSetId }));
        },
        dismissPrevious() {
            team.dismissPrevious();
        },
    };

    const filterCount = activeFilterCount(view);
    const setsForMode = useMemo(() => costSetsForMode(ref.costSets, mode), [ref.costSets, mode]);

    return {
        view,
        mode,
        slots: team.slots,
        filled,
        cost,
        budgets: team.budgets,
        spend,
        costsReady,
        source,
        dataState,
        refReady: ref.ready,
        costSet: publishedSet,
        setsForMode,
        noticeSet,
        linkNotice,
        /** A link replaced a different saved team, which can still be restored. */
        replacedTeam: team.previous !== null,
        fullHint,
        pool,
        poolTotal: allCharacters.length,
        lightcones: sortedLightcones,
        archetypeNames,
        filterCount,
        characterOf,
        lightconeOf,
        dismissNotices,
        actions,
        /** S14.3c: the loadouts (browser and account), the active one, autosave. */
        loadouts,
        /** S14.3c: the page's team as packed text (the share link). */
        code,
    };
}

export type TeamBuilderPageState = ReturnType<typeof useTeamBuilderPage>;
