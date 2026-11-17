import type { Draft } from '@shared/loadouts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { draftsKey, newTabId, readDrafts, writeDrafts } from './loadoutStorage';

/*
 * Account drafts (S14.3c-sync, part a of the split): this account's unsaved edits of account loadouts, one entry per
 * loadout in browser storage, shared by every tab of this browser (`loadoutStorage.ts`). Storage is the truth:
 * `read()` reads it fresh, `mutate()` reads, changes and writes it at once, and a `storage` event from another tab
 * re-reads it. `drafts` is the same set for rendering. Storage that refuses a write (blocked or full) puts the set in
 * a copy in memory, so nothing typed is dropped; every later write tries storage again and, once it goes through,
 * storage is the truth again (S14.3c fix 3, review M2).
 *
 * Two tabs: each draft names the tab that writes and sends it (`tab`; this tab's id is new for every visit of the
 * page). An edit in a tab makes it the owner; the sync (`useAccountSync`) sends only drafts this tab owns and takes
 * over one that its owner released (left the page) or whose tab is gone (`tabPresence.ts`). Two tabs editing one loadout at
 * the same moment: the last edit is the one stored; each tab's sends carry their version, so the server arbitrates.
 */

export type DraftsApi = ReturnType<typeof useAccountDrafts>;

type Memory = { user: number; drafts: Record<string, Draft> } | null;

export function useAccountDrafts(userId: number | null, storageOk: boolean) {
    const [tab] = useState(newTabId);
    // Writes refused by storage (or storage off): this visit keeps the account's drafts here.
    const memory = useRef<Memory>(null);

    const read = useCallback((): Record<string, Draft> => {
        if (userId === null) return {};
        const m = memory.current;
        if (m && m.user === userId) return m.drafts;
        return storageOk ? readDrafts(userId) : {};
    }, [userId, storageOk]);

    // The set for rendering, kept per account (a change of account reads the new one at once).
    const [state, setState] = useState(() => ({ user: userId, drafts: read() }));
    if (state.user !== userId) setState({ user: userId, drafts: read() });
    const drafts = state.user === userId ? state.drafts : {};

    /** Reads fresh, changes, writes; returns the new set. Changes nothing for a visitor. */
    const mutate = useCallback(
        (change: (all: Record<string, Draft>) => Record<string, Draft>) => {
            if (userId === null) return {};
            const before = read();
            const next = change(before);
            const m = memory.current;
            const pending = !!m && m.user === userId;
            if (next === before && !pending) return before;
            // Storage is tried on every change, also after a refusal (review M2): once a write goes through, the
            // copy in memory goes and storage holds the whole set again (a settled draft is not left behind there).
            const ok = storageOk && writeDrafts(userId, next);
            memory.current = ok ? null : { user: userId, drafts: next };
            if (next === before) return before;
            setState({ user: userId, drafts: next });
            return next;
        },
        [userId, storageOk, read],
    );

    /** One draft: set, or removed (null). */
    const put = useCallback(
        (key: string, draft: Draft | null) =>
            mutate((all) => {
                if (draft === null) {
                    if (!(key in all)) return all;
                    const next = { ...all };
                    delete next[key];
                    return next;
                }
                return all[key] === draft ? all : { ...all, [key]: draft };
            }),
        [mutate],
    );

    // Another tab wrote this account's drafts.
    useEffect(() => {
        if (userId === null) return;
        const onStorage = (e: StorageEvent) => {
            // `null`: the whole storage was cleared.
            if (e.key !== null && e.key !== draftsKey(userId)) return;
            setState({ user: userId, drafts: read() });
        };
        window.addEventListener('storage', onStorage);
        return () => window.removeEventListener('storage', onStorage);
    }, [userId, read]);

    return { tab, drafts, read, mutate, put };
}
