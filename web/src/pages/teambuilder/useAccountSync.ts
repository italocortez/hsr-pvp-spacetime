import {
    ACCOUNT_LOADOUT_LIMIT,
    type Autosave,
    type AutosaveStatus,
    adopt,
    adoption,
    afterSave,
    asNew,
    createAutosave,
    type Draft,
    deleteBase,
    edit as editAutosave,
    failed,
    forget,
    freeSlot,
    hold,
    isUnslottedKey,
    keepMine,
    keySlot,
    loadoutName,
    loadoutNote,
    moveKey,
    type Outcome,
    outcomeOf,
    ownership,
    type Row,
    reconcile,
    release,
    requestFlush,
    ringStatus,
    type Sent,
    sameWait,
    setOnline,
    settle,
    slotKey,
    statusOf,
    step,
    succeeded,
    UNSLOTTED_PREFIX,
    versionOf,
    waitOf,
    withSent,
} from '@shared/loadouts';
import { useCallback, useEffect, useLayoutEffect, useReducer, useRef } from 'react';
import { NotConnectedError, useReducerCall } from '@/stdb/useReducerCall';
import { type Content, newBrowserKey } from './loadoutStorage';
import { type Presence, startPresence } from './tabPresence';
import type { DraftsApi } from './useAccountDrafts';

/*
 * Account sync (S14.3c-sync, part b of the split; DECISIONS.md A194 items 3 to 6, A198): when this tab sends its
 * account drafts, and what it does with the answers and with the rows of `view_my_loadouts`. The rules themselves
 * are pure (`shared/loadouts/sync.ts`: `reconcile` maps a draft and its row to send, hold, move or drop; `afterSave`
 * maps an answer to the next draft and step); the timing is the autosave machine (`shared/loadouts/autosave.ts`).
 *
 * - Only drafts this tab owns are sent. A draft is taken over only when its owner is gone: it released the draft
 *   (it left the page), or its presence is lost (`tabPresence.ts`: Web Locks, else a heartbeat; S14.3c fix 3,
 *   review S1). A live owner keeps its draft however long it waits. The taker inherits the draft's waiting state
 *   (`wait`: failures in a row, backoff, a parked reason), so N tabs never try a failing save more often than one.
 *   A released draft whose last send may still land waits `SENT_GRACE_MS` for its row first (review M4).
 * - This tab's waiting state of each draft it owns is written into the draft whenever it changes (`persistWaits`).
 * - Nothing is sent, and no draft is judged, until the rows are fresh for the current connection (`live`: the
 *   subscription has replayed since the connection was last lost; second review N1). The server's version check is
 *   the guarantee either way: a save on an old version is refused, never written.
 * - Every save sends the version its draft is based on and is recorded in the draft before it leaves (`sent`), so
 *   this page's own save is recognised by its row even after a lost answer or a reload (N7).
 */

export const STILL_SAVING = 'This loadout is being saved. Try again in a moment.';
export const DELETE_NOT_CONNECTED =
    'Not connected. The loadout was not deleted; try again when the connection is back.';
export const DELETE_UNKNOWN =
    'The connection was lost while deleting. Check the list when the connection is back.';

export type RemoveResult =
    | { kind: 'done' }
    | { kind: 'error'; text: string }
    /** Refused: the account copy is newer than the one shown. The page now shows it; ask again. */
    | { kind: 'changed' };

type Options = {
    userId: number | null;
    store: DraftsApi;
    /** The rows of `view_my_loadouts` by slot key, as rendered. */
    rows: ReadonlyMap<string, Row>;
    /**
     * The row in a slot as the connection's cache holds it now. Answers and sends read this: the server sends a
     * transaction's rows before the call's answer, so the cache is newer than the last render then.
     */
    rowNow: (key: string) => Row | null;
    /** Verified, the list loaded and fresh for the current connection. */
    live: boolean;
    /** A draft moved to another key (its slot was taken elsewhere, or none was free). */
    onMoved: (from: string, to: string) => void;
};

const newUnslottedKey = () => `${UNSLOTTED_PREFIX}${newBrowserKey().slice(2, 38)}`;

export function useAccountSync({ userId, store, rows, rowNow, live, onMoved }: Options) {
    const saveCall = useReducerCall((r, args: Parameters<NonNullable<typeof r.saveLoadout>>[0]) =>
        r.saveLoadout ? r.saveLoadout(args) : Promise.reject(new NotConnectedError()),
    );
    const deleteCall = useReducerCall((r, args: { slot: number; baseRev: number }) =>
        r.deleteLoadout ? r.deleteLoadout(args) : Promise.reject(new NotConnectedError()),
    );

    // Latest values for callbacks that run outside render (timers, answers, listeners). Written after each commit,
    // before any effect of it runs.
    const latest = useRef({ userId, store, rows, rowNow, live, onMoved, saveCall });
    useLayoutEffect(() => {
        latest.current = { userId, store, rows, rowNow, live, onMoved, saveCall };
    });

    // The scheduler, per account: another account starts clean (its drafts wait in its own key).
    const as = useRef<{ user: number | null; state: Autosave }>({
        user: userId,
        state: createAutosave(live),
    });
    const get = useCallback((): Autosave => {
        const user = latest.current.userId;
        if (as.current.user !== user)
            as.current = { user, state: createAutosave(as.current.state.online) };
        return as.current.state;
    }, []);
    const set = useCallback((s: Autosave) => {
        as.current = { user: latest.current.userId, state: s };
    }, []);
    const [tick, rerender] = useReducer((n: number) => n + 1, 0);
    /** The drafts against the rows again (below): an answer came (its row may have come first), a take-over is due. */
    const [recheckTick, recheck] = useReducer((n: number) => n + 1, 0);
    const mounted = useRef(false);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const pumpRef = useRef<() => void>(() => {});

    const rowOf = useCallback((key: string): Row | null => latest.current.rowNow(key), []);
    const presence = useRef<Presence | null>(null);

    /** Writes this tab's waiting state into each draft it owns, where it changed (a tab that takes over reads it). */
    const persistWaits = useCallback(() => {
        const drafts = latest.current.store;
        const s = get();
        drafts.mutate((all) => {
            let next = all;
            for (const [key, d] of Object.entries(all)) {
                if (d.tab !== drafts.tab || !s.entries[key]) continue;
                const w = waitOf(s, key);
                if (!sameWait(w, d.wait)) next = { ...next, [key]: { ...d, wait: w } };
            }
            return next;
        });
    }, [get]);

    /** Moves a draft to `to` (the active loadout and the scheduler follow). */
    const move = useCallback(
        (from: string, to: string, draft: Draft, now: number) => {
            latest.current.store.mutate((all) => {
                const next = { ...all, [to]: draft };
                if (from !== to) delete next[from];
                return next;
            });
            let s = moveKey(get(), from, to);
            if (!s.entries[to]) s = editAutosave(s, to, now);
            set(s);
            if (from !== to) latest.current.onMoved(from, to);
        },
        [get, set],
    );

    /** The lowest slot no row and no draft (this tab's or another's) uses; null when the account is full. */
    const freeAccountSlot = useCallback((): number | null => {
        const { rowNow: now, store: drafts } = latest.current;
        const rowSlots = Array.from({ length: ACCOUNT_LOADOUT_LIMIT }, (_, s) => s).filter(
            (s) => now(slotKey(s)) !== null,
        );
        const draftSlots = Object.keys(drafts.read())
            .map(keySlot)
            .filter((s): s is number => s !== null);
        return freeSlot([...rowSlots, ...draftSlots], ACCOUNT_LOADOUT_LIMIT);
    }, []);

    /**
     * A new draft (no account copy) goes to the lowest free slot, else waits unslotted. `due`: it was due (a send or
     * an answer found its slot taken, or it waited for a slot): sent at once; else it keeps its wait.
     */
    const relocate = useCallback(
        (key: string, now: number, due: boolean) => {
            const d = latest.current.store.read()[key];
            if (!d) return;
            const free = freeAccountSlot();
            if (free === null) {
                const to = isUnslottedKey(key) ? key : newUnslottedKey();
                if (to !== key) move(key, to, asNew(d), now);
                else if (!get().entries[to]) set(editAutosave(get(), to, now));
                set(failed(get(), to, now, 'full'));
                return;
            }
            const to = slotKey(free);
            move(key, to, asNew(d), now);
            if (due) set(failed(get(), to, now, 'retry'));
        },
        [freeAccountSlot, move, get, set],
    );

    /** The answer to one save. Applied to the draft as it is stored now (another tab may have edited it). */
    const answer = useCallback(
        (key: string, version: number, sent: Sent, outcome: Outcome, owner: number | null) => {
            const { store: drafts } = latest.current;
            if (latest.current.userId !== owner) return; // another account now: its draft waits in its own key
            const now = Date.now();
            const current = drafts.read()[key];
            let s = get();
            if (!current) {
                // Deleted or dropped meanwhile.
                set(outcome.kind === 'ok' ? succeeded(s, key, version) : forget(s, key));
                return;
            }
            const r = afterSave(current, sent, outcome, rowOf(key));
            if (r.draft !== current) drafts.put(key, r.draft);
            switch (r.next) {
                case 'saved':
                    s = succeeded(s, key, version);
                    break;
                case 'settled':
                    s = settle(failed(s, key, now, 'retry'), key, true);
                    break;
                case 'retry':
                case 'move':
                    s = failed(s, key, now, 'retry');
                    break;
                case 'hold':
                    s = hold(
                        failed(s, key, now, 'retry'),
                        key,
                        now,
                        r.draft?.held ?? 'conflict',
                        r.message,
                    );
                    break;
                case 'too-fast':
                case 'refused':
                    s = failed(s, key, now, r.next, r.message);
                    break;
                default:
                    s = failed(s, key, now, r.next);
            }
            set(s);
            if (r.next === 'move') relocate(key, now, true);
            persistWaits();
            if (mounted.current) {
                rerender();
                recheck();
                pumpRef.current();
            }
        },
        [get, set, relocate, rowOf, persistWaits],
    );

    /**
     * Sends one due draft (or settles, holds or moves it if its row says so). True when it moved the draft to a free
     * slot, where it is due at once (the pump then takes another round).
     */
    const send = useCallback(
        (key: string, version: number): boolean => {
            const { store: drafts, saveCall: call, userId: owner } = latest.current;
            const now = Date.now();
            const d = drafts.read()[key];
            const slot = keySlot(key);
            if (!d || d.tab !== drafts.tab) {
                set(forget(get(), key));
                return false;
            }
            if (slot === null) {
                set(failed(get(), key, now, 'retry'));
                relocate(key, now, true);
                return true;
            }
            const v = reconcile(d, rowOf(key));
            if (v.kind === 'drop') {
                drafts.put(key, null);
                set(settle(failed(get(), key, now, 'retry'), key, d.sent.length > 0));
                return false;
            }
            if (v.kind === 'move') {
                set(failed(get(), key, now, 'retry'));
                relocate(key, now, true);
                return true;
            }
            if (v.kind === 'hold') {
                drafts.put(key, v.draft);
                set(hold(failed(get(), key, now, 'retry'), key, now, v.draft.held ?? 'conflict'));
                return false;
            }
            const sent: Sent = {
                baseRev: v.draft.baseRev,
                name: loadoutName(v.draft.name),
                note: loadoutNote(v.draft.note),
                code: v.draft.code,
            };
            // Recorded before it leaves: a reload after a lost answer still knows it (N7).
            drafts.put(key, withSent(v.draft, sent));
            call({ slot, ...sent })
                .then(
                    (): Outcome => ({ kind: 'ok' }),
                    (error: unknown) => outcomeOf(error),
                )
                .then((outcome) => answer(key, version, sent, outcome, owner));
            return false;
        },
        [get, set, relocate, answer, rowOf],
    );

    const pump = useCallback(() => {
        const now = Date.now();
        let r = step(get(), now);
        set(r.state);
        // A draft moved to a free slot while being sent is due at once: one more round. Bounded: a move lands in a
        // slot no row and no draft uses, so a draft moves at most once per round and never back.
        let again = true;
        while (again) {
            again = false;
            for (const key of r.send) again = send(key, versionOf(r.state, key)) || again;
            if (!again) break;
            r = step(get(), now);
            set(r.state);
        }
        if (timer.current) clearTimeout(timer.current);
        timer.current = null;
        if (r.wakeAt !== null && mounted.current)
            timer.current = setTimeout(() => pumpRef.current(), Math.max(0, r.wakeAt - now));
        persistWaits();
        if (mounted.current) rerender();
    }, [get, set, send, persistWaits]);
    useLayoutEffect(() => {
        pumpRef.current = pump;
    });

    // The scheduler sends only while the rows are fresh for the current connection (N1).
    useEffect(() => {
        set(setOnline(get(), live));
        pumpRef.current();
    }, [live, get, set]);

    // This tab's presence, for the other tabs (and theirs, for this one), while a member is on the page.
    const signedIn = userId !== null;
    useEffect(() => {
        if (!signedIn) return;
        const p = startPresence(store.tab, recheck);
        presence.current = p;
        return () => {
            p.stop();
            if (presence.current === p) presence.current = null;
        };
    }, [signedIn, store.tab]);

    // ── The drafts against the rows: on every change of either, once the rows are fresh. Takes over drafts whose
    // owner is gone, holds, moves, settles. Writes only what changes, so a second run changes nothing.
    // biome-ignore lint/correctness/useExhaustiveDependencies: recheckTick means "an answer came, or a take-over may be due"
    useEffect(() => {
        if (!live || userId === null) return;
        const now = Date.now();
        const before = get();
        let s = before;
        let wrote = false;
        let nextAdopt: number | null = null;
        const moves: [string, boolean][] = [];
        for (const [key, d] of Object.entries(store.read())) {
            const e = s.entries[key];
            if (e && e.inFlight !== null) continue;
            if (d.tab !== store.tab) {
                const p = presence.current;
                const gone = d.tab !== null && !!p?.gone(d.tab, d.seen, now);
                if (ownership(d, store.tab, gone) === 'take') {
                    // Taken over with its waiting state: a parked draft stays parked, a backoff keeps its time.
                    store.put(key, { ...d, tab: store.tab, seen: now });
                    s = adopt(s, key, adoption(d, now));
                    wrote = true;
                } else {
                    if (e) s = forget(s, key);
                    const at = d.tab !== null && p ? p.goneAt(d.tab, d.seen) : null;
                    if (at !== null) nextAdopt = nextAdopt === null ? at : Math.min(nextAdopt, at);
                }
                continue;
            }
            if (isUnslottedKey(key)) {
                if (!e) s = editAutosave(s, key, now);
                if (freeAccountSlot() !== null) moves.push([key, true]);
                else if (s.entries[key]?.reason !== 'full') s = failed(s, key, now, 'full');
                continue;
            }
            const v = reconcile(d, rows.get(key) ?? null);
            if (v.kind === 'drop') {
                store.put(key, null);
                if (e) s = settle(s, key, d.sent.length > 0);
                wrote = true;
                continue;
            }
            // An owned draft with no schedule (a sign-in again in this visit): unsaved work, due at once.
            if (!e) s = requestFlush(editAutosave(s, key, now), key);
            if (v.draft !== d) {
                store.put(key, v.draft);
                wrote = true;
            }
            if (v.kind === 'hold') s = hold(s, key, now, v.draft.held ?? 'conflict');
            else s = release(s, key);
            if (v.kind === 'move') moves.push([key, false]);
        }
        set(s);
        for (const [key, due] of moves) relocate(key, now, due);
        if (wrote || moves.length > 0 || s !== before) pumpRef.current();
        if (nextAdopt === null) return;
        const t = setTimeout(recheck, Math.max(0, nextAdopt - now));
        return () => clearTimeout(t);
    }, [live, userId, store.drafts, store.tab, rows, recheckTick, get, set, relocate]);

    /** Releases this tab's drafts (it leaves): another tab, or the next visit, takes them over at once. */
    const releaseOwned = useCallback(() => {
        const drafts = latest.current.store;
        drafts.mutate((all) => {
            let next = all;
            for (const [key, d] of Object.entries(all))
                if (d.tab === drafts.tab) next = { ...next, [key]: { ...d, tab: null } };
            return next;
        });
    }, []);

    // Leaving the page and hiding the tab save what waits; leaving also releases this tab's drafts.
    useEffect(() => {
        mounted.current = true;
        const flushAll = () => {
            set(requestFlush(get()));
            pumpRef.current();
        };
        const onHide = () => {
            if (document.visibilityState === 'hidden') flushAll();
        };
        const onPageHide = () => {
            flushAll();
            releaseOwned();
        };
        document.addEventListener('visibilitychange', onHide);
        window.addEventListener('pagehide', onPageHide);
        return () => {
            document.removeEventListener('visibilitychange', onHide);
            window.removeEventListener('pagehide', onPageHide);
            mounted.current = false;
            flushAll();
            releaseOwned();
            if (timer.current) clearTimeout(timer.current);
        };
    }, [get, set, releaseOwned]);

    // ── Actions.

    /** An edit of an account loadout (its draft is created with `baseRev` when there is none). */
    const edit = useCallback(
        (key: string, content: Content, baseRev: number) => {
            const drafts = latest.current.store;
            const now = Date.now();
            const d = drafts.read()[key];
            drafts.put(
                key,
                d
                    ? { ...d, ...content, at: now, seen: now, tab: drafts.tab }
                    : {
                          ...content,
                          baseRev,
                          at: now,
                          seen: now,
                          tab: drafts.tab,
                          sent: [],
                          held: null,
                          keep: false,
                      },
            );
            set(editAutosave(get(), key, now));
            pumpRef.current();
        },
        [get, set],
    );

    /** A new account loadout in the lowest free slot; its key, or null when the account is full. */
    const create = useCallback(
        (content: Content, flushNow = false): string | null => {
            const free = freeAccountSlot();
            if (free === null) return null;
            const key = slotKey(free);
            edit(key, content, 0);
            if (flushNow) {
                set(requestFlush(get(), key));
                pumpRef.current();
            }
            return key;
        },
        [freeAccountSlot, edit, get, set],
    );

    /** Saves what waits for this loadout at once (switching away from it). */
    const flush = useCallback(
        (key: string) => {
            set(requestFlush(get(), key));
            pumpRef.current();
        },
        [get, set],
    );

    /** Changes one draft (the person's choice); the reconcile above then holds, releases or moves it. */
    const choose = useCallback(
        (key: string, change: (d: Draft) => Draft | null) => {
            const drafts = latest.current.store;
            const d = drafts.read()[key];
            if (!d) return;
            const next = change(d);
            drafts.put(key, next && { ...next, tab: drafts.tab, seen: Date.now() });
            if (next === null) set(forget(get(), key));
            rerender();
        },
        [get, set],
    );

    /** The version a delete of `key` would state now (`deleteBase`); read when the delete dialog opens. */
    const deleteVersion = useCallback(
        (key: string): number | null =>
            deleteBase(latest.current.store.read()[key] ?? null, rowOf(key)),
        [rowOf],
    );

    /**
     * Deletes an account loadout on the version the person has seen. `seen`: the version when the dialog opened
     * (review M3); a newer copy that arrived behind the dialog is not deleted: refused here as changed, asked again.
     */
    const remove = useCallback(
        async (key: string, seen?: number | null): Promise<RemoveResult> => {
            const drafts = latest.current.store;
            const slot = keySlot(key);
            if (get().entries[key]?.inFlight != null) return { kind: 'error', text: STILL_SAVING };
            const local = (): RemoveResult => {
                drafts.put(key, null);
                set(forget(get(), key));
                rerender();
                return { kind: 'done' };
            };
            const base = deleteVersion(key);
            if (seen != null && base !== null && base !== seen) return { kind: 'changed' };
            if (slot === null || base === null) return local();
            try {
                await deleteCall({ slot, baseRev: base });
            } catch (error) {
                const o = outcomeOf(error);
                if (o.kind === 'offline') return { kind: 'error', text: DELETE_NOT_CONNECTED };
                if (o.kind === 'unknown') return { kind: 'error', text: DELETE_UNKNOWN };
                if (o.kind === 'changed') {
                    // The person meant to delete what they saw: their edits go, the newer copy shows.
                    drafts.put(key, null);
                    set(forget(get(), key));
                    rerender();
                    return { kind: 'changed' };
                }
                return {
                    kind: 'error',
                    text: error instanceof Error ? error.message : String(error),
                };
            }
            return local();
        },
        [deleteCall, get, set, deleteVersion],
    );

    /**
     * What the ring shows for an account loadout (`ringStatus`). Runs during render: reads the scheduler without
     * replacing it, for the account of this render (review M9).
     */
    const statusFor = (key: string): AutosaveStatus => {
        const now = Date.now();
        const sched = as.current.user === userId ? as.current.state : null;
        return ringStatus({
            draft: store.drafts[key] ?? null,
            me: store.tab,
            scheduled: sched?.entries[key] ? statusOf(sched, key, now) : null,
            row: rows.get(key) ?? null,
            live,
            now,
        });
    };

    return {
        /** Bumped when the scheduler's state changes (for rendering). */
        tick,
        statusFor,
        freeAccountSlot,
        edit,
        create,
        flush,
        remove,
        deleteVersion,
        /** "Keep my changes". */
        keep: useCallback((key: string) => choose(key, keepMine), [choose]),
        /** "Use the account copy", "Discard my changes": the draft goes. */
        drop: useCallback((key: string) => choose(key, () => null), [choose]),
        /** "Save as a new loadout". */
        saveAsNew: useCallback((key: string) => choose(key, asNew), [choose]),
    };
}
