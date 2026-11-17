import {
    editBase,
    type Loadout,
    loadoutName,
    loadoutNote,
    NEW_LOADOUT_NAME,
    sameContent,
} from '@shared/loadouts';
import { decodeTeam } from '@shared/teambuilder';
import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import {
    type Content,
    readActive,
    type StoredActive,
    type StoredRef,
    writeActive,
} from './loadoutStorage';

/*
 * The active and the working loadout (S14.3c; S14.3c-sync part c of the split). The active loadout is one of the two
 * lists, or the **working** loadout: the page's team before it belongs to any list (a first visit, a shared link, a
 * full store, a loadout deleted elsewhere). The page's team (slots, budgets, and the modes in the address) stays the
 * page's (`useTeamBuilderPage`): this hook loads a loadout's text into it and, after an edit (`edited()`), writes
 * the page's text back through `write` (an existing loadout) or `create` (the working loadout's first edit).
 *
 * Effects, each standing alone (none relies on another having run first in the same commit):
 * - who: a sign-out or another account clears the account's content from the page;
 * - restore: once the account list is live, the account loadout shown last on this browser becomes active again;
 * - load: the active loadout's text goes onto the page when it changed and the page holds no edit not yet written;
 * - vanish: an active loadout that is gone (nothing on the account, no draft) leaves its team as the working one;
 * - edit: the page's text is written into the active loadout, or makes the working one a loadout once the store
 *   it belongs to is known (and, for an account, the list is live and the restore decided: second review N2) and
 *   its team holds a character (S14.3e, A205: a mode, cost set, budget, name or note change on an empty team
 *   stores nothing; the name and note stay in the working state and the active key, the modes in the address);
 * - stored: the active key in storage follows the state (not while a restore is pending).
 *
 * The version a new draft is based on (A198) is the version of the account copy the page's team was loaded from
 * (`loaded.rev`, kept across a reload in the active key), not the row seen at the moment of the edit: an edit made
 * on an older copy is then a conflict, never an overwrite (N2).
 */

export const SHARED_TEAM_NAME = 'Shared team';
export const DELETED_HERE =
    'This loadout was deleted on another device. Its team stays here, not saved.';

export type Store = 'browser' | 'account';
export type ActiveRef = { kind: 'working' } | { kind: Store; key: string };
type Ref = { kind: Store; key: string };

export const sameRef = (a: ActiveRef, b: ActiveRef) =>
    a.kind === b.kind && (a.kind === 'working' || (b.kind !== 'working' && a.key === b.key));

/** The packed team holds at least one character: only then is a working loadout stored (A205). */
export const holdsCharacter = (code: string | null): boolean => {
    if (code === null) return false;
    const d = decodeTeam(code);
    return d.ok && d.team.slots.some((s) => s !== null);
};

type Options = {
    code: string | null;
    emptyCode: () => string | null;
    load: (code: string) => void;
    linkArrived: boolean;
    hasPrevious: boolean;
    forgetPrevious: () => void;
    userId: number | null;
    /** The connection has said who the visitor is. */
    known: boolean;
    /** Where a new loadout goes; null until known. */
    homeStore: Store | null;
    /** The account list is loaded and fresh for this connection. */
    accountLive: boolean;
    /** A loadout's current content (an account loadout: this browser's draft over the row). */
    find: (ref: Ref) => Loadout | undefined;
    /** An account loadout: its draft's base version, and its row. */
    accountBase: (key: string) => {
        draft: number | null;
        row: { rev: number; code: string } | null;
    };
    write: (ref: Ref, content: Content, baseRev: number) => void;
    /** A new loadout from the working one; its key, or null when the store is full. */
    create: (store: Store, content: Content) => string | null;
    /** The account loadout being left: saved at once. */
    onLeave: (ref: ActiveRef) => void;
};

type Loaded = { key: string | null; code: string | null; rev: number | null };
type Shared = { on: boolean; before: StoredRef | null };

export function useActiveLoadout(o: Options) {
    const { code, emptyCode, load, userId, homeStore, accountLive, find, accountBase } = o;
    const { forgetPrevious, create, write, onLeave, known } = o;
    const [stored] = useState<StoredActive>(readActive);
    const [shared, setShared] = useState<Shared>(() =>
        o.linkArrived
            ? { on: true, before: stored.kind === 'working' ? null : stored }
            : stored.kind === 'working' && stored.shared
              ? { on: true, before: stored.before ?? null }
              : { on: false, before: null },
    );
    const [active, setActiveState] = useState<ActiveRef>(() =>
        o.linkArrived || stored.kind !== 'browser' ? { kind: 'working' } : stored,
    );
    const activeRef = useRef(active);
    const [working, setWorking] = useState(() => {
        // S14.3e: a name or note kept for the working loadout comes back (not after a new link).
        const kept = !o.linkArrived && stored.kind === 'working' ? stored : null;
        return {
            name: kept?.name ?? (shared.on ? SHARED_TEAM_NAME : NEW_LOADOUT_NAME),
            note: kept?.note ?? '',
        };
    });
    const [notice, setNotice] = useState<string | null>(null);
    const lastBrowser = useRef(
        stored.browser ?? (stored.kind === 'browser' ? stored.key : undefined),
    );
    /** The account loadout to take back once its list is here (it follows a draft that moves first). */
    const [restoreKey, setRestoreKey] = useState(stored.kind === 'account' ? stored.key : null);
    const [restoredFor, setRestoredFor] = useState<number | null | undefined>(undefined);
    /**
     * Account keys moved since the last render (`onMoved`). An effect of this commit that still holds the old key
     * (it read the render's data) lands on the new one, whatever order the effects ran in. Cleared every commit.
     */
    const movedTo = useRef(new Map<string, string>());
    useLayoutEffect(() => {
        movedTo.current.clear();
    });
    const wantsRestore =
        stored.kind === 'account' &&
        stored.user === userId &&
        !shared.on &&
        restoredFor !== userId &&
        active.kind === 'working';
    /** What the page's team was last loaded from (an account loadout's version). */
    const loaded = useRef<Loaded>(
        stored.kind === 'account'
            ? { key: stored.key, code: null, rev: stored.rev ?? null }
            : { key: null, code: null, rev: null },
    );
    /** The page holds edits of its own since the last load. */
    const tracking = useRef(false);
    /** An edit of the working loadout waits for its store (who the visitor is, the account list). */
    const wantCreate = useRef(false);
    /** A rename or note typed while the store was not known yet (review M5). */
    const early = useRef<Partial<Pick<Content, 'name' | 'note'>>>({});

    const setActive = useCallback((ref: ActiveRef) => {
        const to = ref.kind === 'account' ? movedTo.current.get(ref.key) : undefined;
        const next: ActiveRef = to ? { kind: 'account', key: to } : ref;
        activeRef.current = next;
        setActiveState(next);
        if (next.kind === 'browser') lastBrowser.current = next.key;
    }, []);

    const activeContent = active.kind === 'working' ? undefined : find(active);
    const activeRev =
        active.kind === 'account'
            ? (() => {
                  const b = accountBase(active.key);
                  return b.draft ?? b.row?.rev ?? null;
              })()
            : null;

    /** Records a load of `ref`'s text (and puts it on the page). */
    const loadRef = useCallback(
        (ref: ActiveRef, text: string) => {
            const b = ref.kind === 'account' ? accountBase(ref.key) : null;
            loaded.current = {
                key: ref.kind === 'working' ? null : ref.key,
                code: text,
                rev: b ? (b.draft ?? b.row?.rev ?? null) : null,
            };
            tracking.current = false;
            load(text);
        },
        [accountBase, load],
    );

    const leaveShared = useCallback(() => {
        setShared((s) => (s.on || s.before ? { on: false, before: null } : s));
        forgetPrevious();
    }, [forgetPrevious]);

    // ── stored: the active key follows the state (a pending restore keeps the stored one for a reload).
    useEffect(() => {
        if (wantsRestore) return;
        const extra = lastBrowser.current ? { browser: lastBrowser.current } : {};
        if (active.kind === 'account' && userId !== null)
            writeActive({
                kind: 'account',
                key: active.key,
                user: userId,
                ...(activeRev !== null ? { rev: activeRev } : {}),
                ...extra,
            });
        else if (active.kind === 'browser')
            writeActive({ kind: 'browser', key: active.key, ...extra });
        else if (active.kind === 'working')
            writeActive({
                kind: 'working',
                ...(shared.on
                    ? { shared: true, ...(shared.before ? { before: shared.before } : {}) }
                    : {}),
                // S14.3e: the working name and note, when they are not the defaults (A205 item 2).
                ...(working.name !== (shared.on ? SHARED_TEAM_NAME : NEW_LOADOUT_NAME)
                    ? { name: working.name }
                    : {}),
                ...(working.note !== '' ? { note: working.note } : {}),
                ...extra,
            });
    }, [active, activeRev, shared, userId, wantsRestore, working]);

    // A kept previous team with no shared team on the page (an older visit) has no notice to go with.
    // biome-ignore lint/correctness/useExhaustiveDependencies: once, on arrival
    useEffect(() => {
        if (!shared.on && o.hasPrevious) forgetPrevious();
    }, []);

    // ── who: sign-out and a change of account (fix pass S3). Nothing of the account stays on the page: the browser
    // loadout shown last comes back, else a fresh empty working loadout. The account's drafts stay in its own key.
    const clearAccountContent = useCallback(() => {
        setNotice(null);
        leaveShared();
        if (activeRef.current.kind === 'browser') return;
        tracking.current = false;
        wantCreate.current = false;
        early.current = {};
        const b = lastBrowser.current
            ? find({ kind: 'browser', key: lastBrowser.current })
            : undefined;
        if (b) {
            setActive({ kind: 'browser', key: b.key });
            loadRef({ kind: 'browser', key: b.key }, b.code);
            return;
        }
        setWorking({ name: NEW_LOADOUT_NAME, note: '' });
        setActive({ kind: 'working' });
        loaded.current = { key: null, code: null, rev: null };
        const c = emptyCode();
        if (c) load(c);
    }, [leaveShared, find, setActive, loadRef, emptyCode, load]);

    const seenUser = useRef<number | null | undefined>(undefined);
    // biome-ignore lint/correctness/useExhaustiveDependencies: on a new answer about who the visitor is
    useEffect(() => {
        if (!known) return;
        const prev = seenUser.current;
        seenUser.current = userId;
        if (prev === undefined) {
            // The first answer of this visit: another account's stored loadout (signed out elsewhere) must go.
            if (stored.kind === 'account' && stored.user !== userId) clearAccountContent();
            if (shared.before?.kind === 'account' && shared.before.user !== userId)
                setShared((s) => ({ on: s.on, before: null }));
            return;
        }
        if (prev !== userId && prev !== null) clearAccountContent();
    }, [known, userId]);

    // ── restore: once the list is live, the account loadout shown last comes back (its text loads below, unless
    // the page already holds an early edit, which is then written into it on its stored version: N2).
    useEffect(() => {
        if (!wantsRestore || !accountLive || userId === null) return;
        setRestoredFor(userId);
        // `restoreKey` and `find` are this render's pair; a move in this commit is followed by `setActive`.
        if (restoreKey === null || !find({ kind: 'account', key: restoreKey })) return;
        const key = movedTo.current.get(restoreKey) ?? restoreKey;
        if (loaded.current.key !== key) loaded.current = { key, code: null, rev: null };
        setActive({ kind: 'account', key });
    }, [wantsRestore, accountLive, userId, restoreKey, find, setActive]);

    // ── load: once per new text of the active loadout, unless the page holds an edit not yet written into it.
    // biome-ignore lint/correctness/useExhaustiveDependencies: a new text or a new active loadout, not the page's code
    useEffect(() => {
        if (!activeContent || active.kind === 'working') return;
        const l = loaded.current;
        if (l.key === active.key && l.code === activeContent.code) return;
        if (tracking.current && l.key === active.key && code !== l.code) return;
        loadRef(active, activeContent.code);
    }, [activeContent?.code, active]);

    // ── vanish: the active loadout is gone (deleted elsewhere or in another tab): its team, name and note stay as
    // the working loadout. A sign-out is not this (the list is not live then).
    const lastContent = useRef<Loadout | undefined>(undefined);
    useEffect(() => {
        if (activeContent) {
            lastContent.current = activeContent;
            return;
        }
        if (active.kind === 'working' || !sameRef(active, activeRef.current)) return;
        if (active.kind === 'account' && !accountLive) return;
        if (active.kind === 'account') setNotice(DELETED_HERE);
        const last = lastContent.current;
        tracking.current = false;
        setWorking({ name: last?.name ?? NEW_LOADOUT_NAME, note: last?.note ?? '' });
        setActive({ kind: 'working' });
        loaded.current = { key: null, code: null, rev: null };
    }, [active, activeContent, accountLive, setActive]);

    /** The store for a new loadout is known and, for an account, its list live with the restore decided. */
    const storeReady =
        homeStore === 'browser' || (homeStore === 'account' && accountLive && !wantsRestore);

    /**
     * Writes a change into the active loadout. The working one becomes a loadout on its first change once its team
     * holds a character (A205); before that a change only updates the working state.
     */
    const apply = useCallback(
        (change: Partial<Content>) => {
            const a = activeRef.current;
            if (a.kind === 'working') {
                const w = { ...working, ...change };
                setWorking({ name: w.name, note: w.note });
                const c = change.code ?? code;
                if (!storeReady || homeStore === null) {
                    // A rename or a note before the store is known is kept for the loadout the page then shows
                    // (the restored one, else the one made from this working loadout; review M5).
                    if (change.name !== undefined) early.current.name = change.name;
                    if (change.note !== undefined) early.current.note = change.note;
                    if (holdsCharacter(c)) wantCreate.current = true;
                    return;
                }
                if (!c) return;
                if (!holdsCharacter(c)) {
                    // An empty team is not a loadout (A205): nothing is stored; the name and note wait in `working`.
                    wantCreate.current = false;
                    early.current = {};
                    return;
                }
                wantCreate.current = false;
                early.current = {};
                const content = { name: loadoutName(w.name), note: loadoutNote(w.note), code: c };
                const key = create(homeStore, content);
                if (key === null) return;
                const ref: Ref = { kind: homeStore, key };
                loaded.current = { key, code: c, rev: homeStore === 'account' ? 0 : null };
                // A shared team saved by its first edit keeps the link notice for this visit (S14.3a).
                setActive(ref);
                return;
            }
            const current = find(a);
            if (!current) return;
            const merged = { ...current, ...change };
            const next = {
                name: loadoutName(merged.name),
                note: loadoutNote(merged.note),
                code: merged.code,
            };
            if (sameContent(current, next)) return;
            const l = loaded.current;
            // The version the page's team came from (`editBase`: a stale base is a conflict, never an overwrite).
            const base =
                a.kind === 'account'
                    ? editBase({ ...accountBase(a.key), loaded: l.key === a.key ? l : null })
                    : 0;
            if (change.code !== undefined) loaded.current = { ...l, key: a.key, code: change.code };
            write(a, next, base);
        },
        [working, code, storeReady, homeStore, find, accountBase, create, write, setActive],
    );

    // ── edit: the page's text goes into the active loadout. `editTick` means "an edit happened".
    const [editTick, bumpEdit] = useReducer((n: number) => n + 1, 0);
    const edited = useCallback(() => {
        tracking.current = true;
        setNotice(null);
        bumpEdit();
    }, []);
    // biome-ignore lint/correctness/useExhaustiveDependencies: editTick means "an edit happened"; apply is read fresh
    useEffect(() => {
        if (!code) return;
        const a = activeRef.current;
        if (a.kind === 'working') {
            // The working loadout waits for its store (and the restore) before it becomes a loadout, and for a
            // character (A205). An early rename or note on an empty team, once no restore takes it, stays in
            // `working` only: it must not land on a loadout switched to later.
            if (storeReady && !holdsCharacter(code)) {
                wantCreate.current = false;
                early.current = {};
                return;
            }
            if (storeReady && (tracking.current || wantCreate.current)) apply({ code });
            return;
        }
        wantCreate.current = false;
        const meta = early.current;
        if (meta.name !== undefined || meta.note !== undefined) {
            // An early rename or note goes into the loadout now shown, with an early team edit if there is one.
            early.current = {};
            const withCode = tracking.current && find(a)?.code !== code;
            apply({ ...meta, ...(withCode ? { code } : {}) });
            return;
        }
        if (!tracking.current) return;
        if (find(a)?.code === code) return;
        apply({ code });
    }, [code, editTick, active, storeReady]);

    // ── Moves and switches.

    /** A draft moved to another key: the active loadout and the restore follow it. */
    const onMoved = useCallback(
        (from: string, to: string) => {
            for (const [k, v] of movedTo.current) if (v === from) movedTo.current.set(k, to);
            movedTo.current.set(from, to);
            setRestoreKey((k) => (k === from ? to : k));
            if (loaded.current.key === from) loaded.current = { ...loaded.current, key: to };
            const a = activeRef.current;
            if (a.kind === 'account' && a.key === from) setActive({ kind: 'account', key: to });
        },
        [setActive],
    );

    /** Puts another loadout on the page (the one left is saved at once). */
    const switchTo = useCallback(
        (ref: ActiveRef) => {
            if (sameRef(ref, activeRef.current)) return;
            const target = ref.kind === 'working' ? undefined : find(ref);
            if (ref.kind !== 'working' && !target) return;
            onLeave(activeRef.current);
            setNotice(null);
            leaveShared();
            setActive(ref);
            if (target) loadRef(ref, target.code);
        },
        [find, onLeave, leaveShared, setActive, loadRef],
    );

    /** A loadout just made (new, a copy) becomes active with `text` on the page. */
    const enter = useCallback(
        (ref: Ref, text: string) => {
            onLeave(activeRef.current);
            leaveShared();
            setActive(ref);
            loadRef(ref, text);
        },
        [onLeave, leaveShared, setActive, loadRef],
    );

    /**
     * "New Loadout" (S14.3e, A205): the loadout being left is saved at once, and the page shows a fresh working
     * loadout ("New Loadout", no note, an empty team under the current modes). It is stored with its first
     * character, so pressing New again on it makes no second empty loadout.
     */
    const startNew = useCallback(() => {
        onLeave(activeRef.current);
        setNotice(null);
        leaveShared();
        tracking.current = false;
        wantCreate.current = false;
        early.current = {};
        setWorking({ name: NEW_LOADOUT_NAME, note: '' });
        setActive({ kind: 'working' });
        loaded.current = { key: null, code: null, rev: null };
        const c = emptyCode();
        if (c) load(c);
    }, [onLeave, leaveShared, setActive, emptyCode, load]);

    /** After the active loadout went: the one before it, else the working loadout (`clear`: an empty team). */
    const afterRemove = useCallback(
        (next: Ref | null, clear = false) => {
            tracking.current = false;
            leaveShared();
            const target = next ? find(next) : undefined;
            if (next && target) {
                setActive(next);
                loadRef(next, target.code);
                return;
            }
            setWorking({ name: NEW_LOADOUT_NAME, note: '' });
            setActive({ kind: 'working' });
            loaded.current = { key: null, code: null, rev: null };
            const c = clear ? emptyCode() : null;
            if (c) load(c);
        },
        [leaveShared, find, setActive, loadRef, emptyCode, load],
    );

    /** The draft of the active loadout went (the account copy chosen): its text loads again. */
    const reload = useCallback((key: string) => {
        if (loaded.current.key !== key) return;
        tracking.current = false;
        loaded.current = { ...loaded.current, code: null };
    }, []);

    const beforeRef: Ref | null =
        shared.before && (shared.before.kind === 'browser' || shared.before.user === userId)
            ? { kind: shared.before.kind, key: shared.before.key }
            : null;

    return {
        active,
        activeContent,
        name: activeContent?.name ?? working.name,
        note: activeContent?.note ?? working.note,
        notice,
        dismissNotice: useCallback(() => setNotice(null), []),
        /** The loadout a shared link took the page from, while it can be restored. */
        beforeLink: beforeRef && find(beforeRef) ? beforeRef : null,
        forgetBeforeLink: useCallback(() => setShared((s) => ({ on: s.on, before: null })), []),
        edited,
        rename: useCallback((name: string) => apply({ name }), [apply]),
        setNote: useCallback((note: string) => apply({ note: loadoutNote(note) }), [apply]),
        switchTo,
        enter,
        startNew,
        afterRemove,
        reload,
        onMoved,
    };
}
