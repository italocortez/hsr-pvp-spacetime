import type { MyLoadoutRow } from '@bindings/types';
import {
    ACCOUNT_LOADOUT_LIMIT,
    type AutosaveStatus,
    addLoadout,
    BROWSER_LOADOUT_LIMIT,
    copyName,
    type Difference,
    differences,
    duplicateLoadout,
    freeSlot,
    type Hold,
    keySlot,
    type Loadout,
    loadoutName,
    loadoutNote,
    type Row,
    removeLoadout,
    slotKey,
    updateLoadout,
} from '@shared/loadouts';
import { decodeTeam } from '@shared/teambuilder';
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '@/auth/authStore';
import { useStdbConnection } from '@/stdb/connectionContext';
import { useFreshRouteSubscriptions } from '@/stdb/useRouteSubscriptions';
import { useRows } from '@/stdb/useRows';
import { type Content, newBrowserKey, storageWorks } from './loadoutStorage';
import { useAccountDrafts } from './useAccountDrafts';
import { useAccountSync } from './useAccountSync';
import {
    type ActiveRef,
    holdsCharacter,
    type Store,
    sameRef,
    useActiveLoadout,
} from './useActiveLoadout';
import { useBrowserLoadouts } from './useBrowserLoadouts';

/*
 * The team builder's loadouts (S14.3c; DECISIONS.md A190 items 1, 2, 3, 10, 15; A194 items 3 to 6; A198). Two stores
 * behind one list, composed here from smaller parts (S14.3c-sync, A198 item 2):
 *
 * - browser list (`useBrowserLoadouts`, everyone, up to 5);
 * - account drafts (`useAccountDrafts`): this browser's unsaved edits of account loadouts, shared by its tabs;
 * - account sync (`useAccountSync` with the pure rules of `shared/loadouts/sync.ts`): `view_my_loadouts`, versions,
 *   autosave, conflicts, deletions elsewhere;
 * - the active and working loadout (`useActiveLoadout`): restore, load, the shared link, edits.
 *
 * This layer only wires them and holds the actions the Loadouts card calls.
 */

export const LOADOUTS_QUERY = 'SELECT * FROM view_my_loadouts';

export const ACCOUNT_FULL = `Your account already holds ${ACCOUNT_LOADOUT_LIMIT} loadouts. Delete one first.`;
export const BROWSER_FULL = `This browser already holds ${BROWSER_LOADOUT_LIMIT} loadouts. Delete one first.`;
export const NOT_KNOWN_YET = 'Still connecting. Try again in a moment.';
export const ACCOUNT_LOADING = 'Your account loadouts are still loading.';
export { SHARED_TEAM_NAME } from './useActiveLoadout';
export type { ActiveRef, Store };

export type LoadoutItem = Loadout & {
    store: Store;
    filled: number;
    /** An account loadout held for the person's choice (changed or deleted elsewhere). */
    held: Hold | null;
};

export type LoadoutStatus =
    | {
          kind: 'working';
          full: Store | null;
          loading: boolean;
          /** No character on the page: nothing to store yet (A205). */
          empty: boolean;
      }
    | { kind: 'browser' }
    | { kind: 'account'; autosave: AutosaveStatus };

/** The active loadout is held: both copies, what differs, for the person's choice. */
export type HeldInfo = {
    key: string;
    kind: Hold;
    mine: { name: string; filled: number; at: number };
    /** The account copy (null: none, the loadout was deleted). */
    theirs: { name: string; filled: number } | null;
    differences: Difference[];
};

export type RemoveOutcome =
    | { kind: 'done' }
    | { kind: 'error'; text: string }
    | { kind: 'changed' };

type Options = {
    /** The page's team as packed text (null when it cannot be written). */
    code: string | null;
    /** A new loadout's text: an empty team under the current modes. */
    emptyCode: () => string | null;
    /** Puts a loadout's packed text on the page (team, budgets, modes). */
    load: (code: string) => void;
    /** The page opened with a team in its address (a shared link). */
    linkArrived: boolean;
    /** The S14.3a previous team (what a link replaced) is kept: its notice shows. */
    hasPrevious: boolean;
    /** Forgets that previous team (its notice goes). */
    forgetPrevious: () => void;
};

const filledOf = (code: string) => {
    const d = decodeTeam(code);
    return d.ok ? d.team.slots.filter((s) => s !== null).length : 0;
};

const rowOf = (r: MyLoadoutRow): Row => ({
    rev: r.rev,
    name: loadoutName(r.name),
    note: loadoutNote(r.note),
    code: r.code,
});

/** Slot keys in slot order, then the unslotted ones (they wait for a free slot). */
const byAccountKey = (a: Loadout, b: Loadout) => {
    const sa = keySlot(a.key);
    const sb = keySlot(b.key);
    if (sa !== null && sb !== null) return sa - sb;
    if (sa !== null) return -1;
    if (sb !== null) return 1;
    return a.key < b.key ? -1 : 1;
};

export function useLoadouts({
    code,
    emptyCode,
    load,
    linkArrived,
    hasPrevious,
    forgetPrevious,
}: Options) {
    // ── Who the visitor is. While the connection has not answered (first load, a failed connection), the last
    // answer of this visit stands: a lost connection is not a sign-out (fix pass S4).
    const auth = useAuth();
    const liveUser = auth.ready && auth.user && !auth.user.isGuest ? auth.user.id : null;
    const [lastKnown, setLastKnown] = useState<number | null | undefined>(undefined);
    if (auth.ready && lastKnown !== liveUser) setLastKnown(liveUser);
    const userId = auth.ready ? liveUser : (lastKnown ?? null);
    const verified = userId !== null;
    const known = auth.ready || lastKnown !== undefined;
    const homeStore: Store | null = known ? (verified ? 'account' : 'browser') : null;

    // ── Account rows: this route only, verified only; fresh once replayed after a reconnect (N1).
    const queries = useMemo(() => (verified ? [LOADOUTS_QUERY] : []), [verified]);
    const sub = useFreshRouteSubscriptions(queries);
    const raw = useRows(
        (c) => (verified ? c.db.viewMyLoadouts : undefined),
        `${sub.ready}-${sub.fresh}`,
    ) as readonly MyLoadoutRow[];
    const rows = useMemo(() => {
        const m = new Map<string, Row>();
        for (const r of raw) m.set(slotKey(r.slot), rowOf(r));
        return m;
    }, [raw]);
    const accountLive = verified && sub.ready && sub.fresh;
    const conn = useStdbConnection();
    /** A slot's row as the connection's cache holds it now (for answers that arrive between renders). */
    const rowNow = useCallback(
        (key: string): Row | null => {
            const table = verified ? conn?.db.viewMyLoadouts : undefined;
            if (!table) return null;
            for (const r of table.iter()) if (slotKey(r.slot) === key) return rowOf(r);
            return null;
        },
        [conn, verified],
    );

    // ── The stores.
    const [storageOk] = useState(storageWorks);
    const browser = useBrowserLoadouts(storageOk);
    const drafts = useAccountDrafts(userId, storageOk);
    const moved = useRef<(from: string, to: string) => void>(() => {});
    const sync = useAccountSync({
        userId,
        store: drafts,
        rows,
        rowNow,
        live: accountLive,
        onMoved: (from, to) => moved.current(from, to),
    });

    /** The account list: the rows with this browser's drafts over them, in slot order. */
    const account = useMemo<Loadout[]>(() => {
        if (!verified) return [];
        const keys = new Set([...rows.keys(), ...Object.keys(drafts.drafts)]);
        return [...keys]
            .map((key) => {
                const c = drafts.drafts[key] ?? rows.get(key);
                return c ? { key, name: c.name, note: c.note, code: c.code } : null;
            })
            .filter((l): l is Loadout => l !== null)
            .sort(byAccountKey);
    }, [verified, rows, drafts.drafts]);

    const find = useCallback(
        (ref: { kind: Store; key: string }) =>
            (ref.kind === 'browser' ? browser.list : account).find((l) => l.key === ref.key),
        [browser.list, account],
    );
    const accountBase = useCallback(
        (key: string) => {
            const r = rows.get(key);
            return {
                draft: drafts.drafts[key]?.baseRev ?? null,
                row: r ? { rev: r.rev, code: r.code } : null,
            };
        },
        [rows, drafts.drafts],
    );

    const active = useActiveLoadout({
        code,
        emptyCode,
        load,
        linkArrived,
        hasPrevious,
        forgetPrevious,
        userId,
        known,
        homeStore,
        accountLive,
        find,
        accountBase,
        write: useCallback(
            (ref: { kind: Store; key: string }, content: Content, baseRev: number) => {
                if (ref.kind === 'browser')
                    browser.mutate((list) => updateLoadout(list, ref.key, content));
                else sync.edit(ref.key, content, baseRev);
            },
            [browser.mutate, sync.edit],
        ),
        create: useCallback(
            (store: Store, content: Content) => {
                if (store === 'account') return sync.create(content);
                if (browser.read().length >= BROWSER_LOADOUT_LIMIT) return null;
                const key = newBrowserKey();
                browser.mutate((list) => {
                    const r = addLoadout(list, { key, ...content }, BROWSER_LOADOUT_LIMIT);
                    return r.ok ? r.list : list;
                });
                return key;
            },
            [browser.read, browser.mutate, sync.create],
        ),
        onLeave: useCallback(
            (ref: ActiveRef) => {
                if (ref.kind === 'account') sync.flush(ref.key);
            },
            [sync.flush],
        ),
    });
    useLayoutEffect(() => {
        moved.current = active.onMoved;
    });

    const accountFull =
        accountLive &&
        freeSlot(
            account.map((l) => keySlot(l.key)).filter((s): s is number => s !== null),
            ACCOUNT_LOADOUT_LIMIT,
        ) === null;

    // ── Actions.

    /**
     * "New Loadout": a fresh empty working loadout, stored with its first character (S14.3e, A205; it no longer
     * stores an empty loadout at once); a refusal text when the visitor's store is full or not ready.
     */
    const create = useCallback((): string | null => {
        if (homeStore === null) return NOT_KNOWN_YET;
        if (homeStore === 'account') {
            if (!accountLive) return ACCOUNT_LOADING;
            if (accountFull) return ACCOUNT_FULL;
        } else if (browser.read().length >= BROWSER_LOADOUT_LIMIT) return BROWSER_FULL;
        active.startNew();
        return null;
    }, [homeStore, accountLive, accountFull, browser.read, active.startNew]);

    /** A copy right after the source (browser) or in the lowest free slot (account); it becomes active. */
    const duplicate = useCallback(
        (ref: { kind: Store; key: string }): string | null => {
            const source = find(ref);
            if (!source) return null;
            if (ref.kind === 'browser') {
                const key = newBrowserKey();
                const r = duplicateLoadout(browser.read(), ref.key, key, BROWSER_LOADOUT_LIMIT);
                if (!r.ok) return r.reason === 'full' ? BROWSER_FULL : null;
                browser.mutate((list) => {
                    const again = duplicateLoadout(list, ref.key, key, BROWSER_LOADOUT_LIMIT);
                    return again.ok ? again.list : list;
                });
                active.enter({ kind: 'browser', key }, source.code);
                return null;
            }
            const name = copyName(
                source.name,
                account.map((l) => l.name),
            );
            const key = sync.create({ name, note: source.note, code: source.code });
            if (key === null) return ACCOUNT_FULL;
            active.enter({ kind: 'account', key }, source.code);
            return null;
        },
        [find, browser, account, sync.create, active.enter],
    );

    /** The loadout before `key` in its list (shown after it goes), else none. */
    const neighbour = useCallback(
        (store: Store, key: string): { kind: Store; key: string } | null => {
            const next = removeLoadout(store === 'browser' ? browser.read() : account, key).next;
            return next === null ? null : { kind: store, key: next };
        },
        [browser.read, account],
    );

    /** Deletes a loadout (asked first by the card). */
    const remove = useCallback(
        async (ref: { kind: Store; key: string }, seen?: number | null): Promise<RemoveOutcome> => {
            const wasActive = sameRef(ref, active.active);
            const next = neighbour(ref.kind, ref.key);
            if (ref.kind === 'browser') {
                browser.mutate((list) => removeLoadout(list, ref.key).list);
                if (wasActive) active.afterRemove(next);
                return { kind: 'done' };
            }
            const r = await sync.remove(ref.key, seen);
            if (r.kind === 'done' && wasActive) active.afterRemove(next);
            if (r.kind === 'changed') active.reload(ref.key);
            return r;
        },
        [active.active, active.afterRemove, active.reload, neighbour, browser.mutate, sync.remove],
    );

    /** "Copy to my account": a new account loadout from a browser one, saved at once; the browser copy stays. */
    const copyToAccount = useCallback(
        (key: string): { ok: boolean; text: string } => {
            const source = browser.read().find((l) => l.key === key);
            if (!source) return { ok: false, text: 'That loadout is gone.' };
            if (!accountLive) return { ok: false, text: ACCOUNT_LOADING };
            const made = sync.create(
                { name: source.name, note: source.note, code: source.code },
                true,
            );
            if (made === null) return { ok: false, text: ACCOUNT_FULL };
            return { ok: true, text: `${source.name} copied to your account.` };
        },
        [browser.read, accountLive, sync.create],
    );

    // ── Held loadouts (S14.3c-sync): the person's choice.
    const takeAccountCopy = useCallback(
        (key: string) => {
            sync.drop(key);
            active.reload(key);
        },
        [sync.drop, active.reload],
    );
    const discard = useCallback(
        (key: string) => {
            const wasActive = sameRef({ kind: 'account', key }, active.active);
            const next = neighbour('account', key);
            sync.drop(key);
            if (wasActive) active.afterRemove(next, true);
        },
        [sync.drop, active.active, active.afterRemove, neighbour],
    );

    // ── What the page shows.
    const heldOf = (key: string): Hold | null => drafts.drafts[key]?.held ?? null;
    const items = (list: Loadout[], store: Store): LoadoutItem[] =>
        list.map((l) => ({
            ...l,
            store,
            filled: filledOf(l.code),
            held: store === 'account' ? heldOf(l.key) : null,
        }));

    let fullStore: Store | null = null;
    if (homeStore === 'account' && accountFull) fullStore = 'account';
    if (homeStore === 'browser' && browser.list.length >= BROWSER_LOADOUT_LIMIT)
        fullStore = 'browser';

    const a = active.active;
    let status: LoadoutStatus;
    if (a.kind === 'working')
        status = {
            kind: 'working',
            full: fullStore,
            loading: homeStore === 'account' && !accountLive,
            empty: !holdsCharacter(code),
        };
    else if (a.kind === 'browser') status = { kind: 'browser' };
    else status = { kind: 'account', autosave: sync.statusFor(a.key) };

    let held: HeldInfo | null = null;
    const d = a.kind === 'account' ? drafts.drafts[a.key] : undefined;
    if (a.kind === 'account' && d?.held) {
        const r = rows.get(a.key);
        held = {
            key: a.key,
            kind: d.held,
            mine: { name: d.name, filled: filledOf(d.code), at: d.at },
            theirs: r ? { name: r.name, filled: filledOf(r.code) } : null,
            differences: r ? differences(d, r) : [],
        };
    }
    const otherHeld = account
        .filter((l) => heldOf(l.key) !== null && !(a.kind === 'account' && a.key === l.key))
        .map((l) => ({ name: l.name, kind: heldOf(l.key) as Hold }));

    return {
        active: a,
        name: active.name,
        note: active.note,
        browser: items(browser.list, 'browser'),
        /** Null while the visitor is not a verified member. */
        account: verified ? items(account, 'account') : null,
        accountReady: accountLive,
        accountError: verified ? sub.error : undefined,
        verified,
        /** False until the connection has said whether the visitor is a member (no sign-in line meanwhile). */
        known: homeStore !== null,
        storageOk,
        status,
        notice: active.notice,
        dismissNotice: active.dismissNotice,
        /** The active loadout waits for the person's choice. */
        held,
        /** Other account loadouts waiting the same way (a line on the card, a mark in the menu). */
        otherHeld,
        keepMine: sync.keep,
        takeAccountCopy,
        saveAsNew: sync.saveAsNew,
        discard,
        beforeLink: active.beforeLink,
        forgetBeforeLink: active.forgetBeforeLink,
        edited: active.edited,
        rename: active.rename,
        setNote: active.setNote,
        switchTo: active.switchTo,
        create,
        duplicate,
        remove,
        /** The version a delete of an account loadout would state now (read when its dialog opens). */
        deleteVersion: (ref: { kind: Store; key: string }): number | null =>
            ref.kind === 'account' ? sync.deleteVersion(ref.key) : null,
        copyToAccount,
    };
}

export type LoadoutsState = ReturnType<typeof useLoadouts>;
