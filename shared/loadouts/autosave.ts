// S14.3c: when an account loadout is saved (DECISIONS.md A194 items 3 to 6). A pure state machine: the caller owns
// the clock (every function takes `now`, in ms), the timer (it wakes `step` at `wakeAt`) and the reducer call (it
// sends what `step` lists and reports back with `succeeded` or `failed`). No storage, no network, no `Date.now()`.
//
// Rules:
// - An edit restarts a 60 s wait (`AUTOSAVE_IDLE_MS`); the loadout is due when the wait runs out.
// - A ceiling: 5 minutes after the first unsaved edit (`AUTOSAVE_CEILING_MS`) the loadout is due even while the
//   edits go on.
// - `requestFlush` makes a loadout due at once (switching loadout, leaving the page, hiding the tab, a copy to the
//   account).
// - At most one save in flight per loadout. Edits made while it flies keep the loadout dirty; the next save carries
//   them.
// - Never more than 6 sends in any 60 s across all loadouts (the server's limit, A194 item 6): a seventh due save
//   waits in a queue until the oldest send leaves the window. The server counts a fixed window that opens at its
//   first save, so a sliding window here never sends more than it accepts; a refusal is still handled below.
// - A save refused as too fast is retried after 10, 20, 40, then every 60 s; one that could not be sent (no
//   connection) waits until the caller says the connection is back (`setOnline`), and is retried after 10 s in any
//   case. A refusal of the content itself (an unknown character, an unreadable team, a full account) is not
//   retried until the next edit.
// - A save whose result is not known (the connection dropped in flight, or the server's runtime failed: S14.3c fix,
//   review S1) is treated as "no connection" (`failed(..., 'unknown')`): sent again as soon as the connection is
//   back, and while it stays up after 10, 20, 40, then every 60 s. The caller settles it earlier when the row
//   arrives holding the draft (`settle`).
// - A draft held for the person (S14.3c-sync: the account copy changed or was deleted elsewhere, or its version is at
//   its top) is held (`hold`): never sent, edits included, until the person chooses (`release` to send it, `forget`
//   to drop it).
// - A server runtime failure (`failed(..., 'internal')`, S14.3c-sync, second review N4) is retried after 10, 20, 40,
//   60 s and stops after `SERVER_RETRY_LIMIT` tries in a row until the next edit or a reconnect.

export const AUTOSAVE_IDLE_MS = 60_000;
export const AUTOSAVE_CEILING_MS = 5 * 60_000;
export const SAVE_LIMIT = 6;
export const SAVE_WINDOW_MS = 60_000;
export const TOO_FAST_RETRY_MS = [10_000, 20_000, 40_000, 60_000] as const;
export const OFFLINE_RETRY_MS = 10_000;
export const SERVER_RETRY_LIMIT = 5;

/** Why a dirty loadout is not being saved right now. */
export type BlockReason =
    /** No connection: waits for it. */
    | 'offline'
    /** The server refused: too many saves in a short time. Retried with backoff. */
    | 'too-fast'
    /** Held by the page's own 6-per-minute queue. */
    | 'queued'
    /** The content was refused (unknown character, unreadable team, a name the server refused). Waits for an edit. */
    | 'refused'
    /** No free slot on the account. Waits for an edit or a free slot. */
    | 'full'
    /** The account copy changed elsewhere since this draft was made: held until the person chooses. */
    | 'conflict'
    /** The loadout was deleted elsewhere: held until the person chooses. */
    | 'deleted'
    /** Its version cannot rise any more: held until the person saves it as a new loadout. */
    | 'retired'
    /** The server's runtime failed: retried with backoff. */
    | 'server-error'
    /** The server's runtime failed `SERVER_RETRY_LIMIT` times in a row: waits for an edit or a reconnect. */
    | 'server-stopped'
    /** Set by the page, never by the machine: another tab of this browser writes and saves this draft. */
    | 'other-tab';

/** `unknown`: the connection was lost in flight. `internal`: the server's runtime failed (rolled back). */
export type FailReason =
    | 'offline'
    | 'unknown'
    | 'internal'
    | 'too-fast'
    | 'refused'
    | 'full'
    | 'retry';

/** The reasons a person's choice ends (`hold`, `release`). */
export type HeldReason = 'conflict' | 'deleted' | 'retired';
const isHeld = (reason: BlockReason | null): reason is HeldReason =>
    reason === 'conflict' || reason === 'deleted' || reason === 'retired';

/** Not sent by `step` until something other than the clock changes them. */
const parked = (reason: BlockReason | null) =>
    reason === 'refused' || reason === 'full' || reason === 'server-stopped' || isHeld(reason);

type Entry = {
    /** Bumped by every edit. */
    version: number;
    /** The last version the server confirmed. */
    savedVersion: number;
    /** First edit not yet saved: the ceiling counts from here. */
    firstEditAt: number | null;
    lastEditAt: number | null;
    flush: boolean;
    /** The version a save in flight carries. */
    inFlight: number | null;
    sentAt: number | null;
    retryAt: number | null;
    failures: number;
    reason: BlockReason | null;
    message: string | null;
    /** A save of this loadout went through on this visit (the ring then reads "Auto saved"). */
    everSaved: boolean;
};

export type Autosave = {
    readonly entries: Readonly<Record<string, Entry>>;
    /** When each of the recent sends left (ms), oldest first. */
    readonly sends: readonly number[];
    readonly online: boolean;
};

export type AutosaveStatus =
    | { kind: 'saved'; everSaved: boolean }
    | { kind: 'waiting'; from: number; due: number }
    | { kind: 'saving' }
    | { kind: 'blocked'; reason: BlockReason; message: string | null };

const blank = (): Entry => ({
    version: 0,
    savedVersion: 0,
    firstEditAt: null,
    lastEditAt: null,
    flush: false,
    inFlight: null,
    sentAt: null,
    retryAt: null,
    failures: 0,
    reason: null,
    message: null,
    everSaved: false,
});

export function createAutosave(online = true): Autosave {
    return { entries: {}, sends: [], online };
}

function put(s: Autosave, key: string, entry: Entry): Autosave {
    return { ...s, entries: { ...s.entries, [key]: entry } };
}

const isDirty = (e: Entry) => e.version > e.savedVersion;

/** An edit of `key`: the wait restarts; a content refusal is forgotten (the edit may have fixed it). */
export function edit(s: Autosave, key: string, now: number): Autosave {
    const e = s.entries[key] ?? blank();
    const clearReason =
        e.reason === 'refused' || e.reason === 'full' || e.reason === 'server-stopped';
    return put(s, key, {
        ...e,
        failures: e.reason === 'server-stopped' ? 0 : e.failures,
        version: e.version + 1,
        // After a content refusal the edit starts a fresh wait and ceiling.
        firstEditAt: clearReason ? now : (e.firstEditAt ?? now),
        lastEditAt: now,
        flush: clearReason ? false : e.flush,
        reason: clearReason ? null : e.reason,
        message: clearReason ? null : e.message,
    });
}

/** Due now: one loadout, or every dirty one when `key` is left out. */
export function requestFlush(s: Autosave, key?: string): Autosave {
    let next = s;
    for (const [k, e] of Object.entries(s.entries)) {
        if (key !== undefined && k !== key) continue;
        if (isDirty(e)) next = put(next, k, { ...e, flush: true });
    }
    return next;
}

/** The connection came back (true) or went (false). Back: what waited for it is due again. */
export function setOnline(s: Autosave, online: boolean): Autosave {
    if (s.online === online) return s;
    let next: Autosave = { ...s, online };
    if (online) {
        for (const [k, e] of Object.entries(s.entries)) {
            if (e.reason === 'offline')
                next = put(next, k, { ...e, reason: null, message: null, retryAt: null });
            // A reconnect is a new chance for a save the server's runtime kept failing (N4).
            if (e.reason === 'server-stopped')
                next = put(next, k, {
                    ...e,
                    reason: null,
                    message: null,
                    retryAt: null,
                    failures: 0,
                    flush: true,
                });
        }
    }
    return next;
}

/** When the loadout is due by the wait and the ceiling (flush aside). */
function dueOf(e: Entry, now: number): number {
    if (e.flush) return now;
    const last = e.lastEditAt ?? now;
    const first = e.firstEditAt ?? last;
    return Math.min(last + AUTOSAVE_IDLE_MS, first + AUTOSAVE_CEILING_MS);
}

/**
 * Advances to `now`: lists the loadouts to send (each now in flight), marks the ones held back, and says when to
 * call again (`wakeAt`, null when nothing waits on the clock).
 */
export function step(
    s: Autosave,
    now: number,
): { state: Autosave; send: string[]; wakeAt: number | null } {
    const sends = s.sends.filter((t) => t > now - SAVE_WINDOW_MS);
    let next: Autosave = { ...s, sends };
    let wakeAt: number | null = null;
    const wake = (t: number) => {
        wakeAt = wakeAt === null ? t : Math.min(wakeAt, t);
    };
    const send: string[] = [];

    const candidates = Object.entries(s.entries)
        .filter(([, e]) => isDirty(e) && e.inFlight === null)
        .filter(([, e]) => !parked(e.reason))
        .map(([k, e]) => {
            const due = Math.max(dueOf(e, now), e.retryAt ?? 0);
            return { k, e, due };
        })
        .sort((a, b) => a.due - b.due || (a.k < b.k ? -1 : 1));

    for (const { k, e, due } of candidates) {
        if (!next.online) {
            if (e.reason !== 'offline')
                next = put(next, k, { ...e, reason: 'offline', message: null });
            continue;
        }
        if (due > now) {
            wake(due);
            if (e.reason === 'queued') next = put(next, k, { ...e, reason: null });
            continue;
        }
        const window = next.sends;
        if (window.length >= SAVE_LIMIT) {
            wake((window[0] as number) + SAVE_WINDOW_MS);
            if (e.reason !== 'queued' && e.reason !== 'too-fast')
                next = put(next, k, { ...e, reason: 'queued', message: null });
            continue;
        }
        next = { ...put(next, k, { ...e, inFlight: e.version, sentAt: now, flush: false }) };
        next = { ...next, sends: [...next.sends, now] };
        send.push(k);
    }
    return { state: next, send, wakeAt };
}

/** The server confirmed the save of `version`. */
export function succeeded(s: Autosave, key: string, version: number): Autosave {
    const e = s.entries[key];
    if (!e) return s;
    const savedVersion = Math.max(e.savedVersion, version);
    const clean = savedVersion >= e.version;
    return put(s, key, {
        ...e,
        savedVersion,
        inFlight: null,
        retryAt: null,
        failures: 0,
        reason: null,
        message: null,
        everSaved: true,
        // Edits made while the save flew are newer than the send: their ceiling starts there.
        firstEditAt: clean ? null : (e.sentAt ?? e.firstEditAt),
        lastEditAt: clean ? null : e.lastEditAt,
        flush: clean ? false : e.flush,
    });
}

/** The save in flight failed. `retry`: the page fixed the cause (another slot) and it may go again at once. */
export function failed(
    s: Autosave,
    key: string,
    now: number,
    reason: FailReason,
    message: string | null = null,
): Autosave {
    const e = s.entries[key];
    if (!e) return s;
    const base = { ...e, inFlight: null };
    if (reason === 'retry')
        return put(s, key, { ...base, flush: true, reason: null, message: null });
    const failures = e.failures + 1;
    // A save that could not go was due already: once its backoff or connection wait is over it goes at once.
    if (reason === 'too-fast') {
        const wait =
            TOO_FAST_RETRY_MS[Math.min(failures - 1, TOO_FAST_RETRY_MS.length - 1)] ?? 60_000;
        return put(s, key, {
            ...base,
            flush: true,
            failures,
            reason,
            message,
            retryAt: now + wait,
        });
    }
    if (reason === 'offline')
        return put(s, key, {
            ...base,
            flush: true,
            failures,
            reason,
            message,
            retryAt: now + OFFLINE_RETRY_MS,
        });
    if (reason === 'internal') {
        // Known not written. Retried with backoff, then stopped until an edit or a reconnect (N4).
        if (failures >= SERVER_RETRY_LIMIT)
            return put(s, key, {
                ...base,
                flush: false,
                failures,
                reason: 'server-stopped',
                message: null,
                retryAt: null,
            });
        const wait =
            TOO_FAST_RETRY_MS[Math.min(failures - 1, TOO_FAST_RETRY_MS.length - 1)] ?? 60_000;
        return put(s, key, {
            ...base,
            flush: true,
            failures,
            reason: 'server-error',
            message: null,
            retryAt: now + wait,
        });
    }
    if (reason === 'unknown') {
        // Shown as "no connection" (the SDK's own sentence is not for the person); cleared by `setOnline(true)`.
        const wait =
            TOO_FAST_RETRY_MS[Math.min(failures - 1, TOO_FAST_RETRY_MS.length - 1)] ?? 60_000;
        return put(s, key, {
            ...base,
            flush: true,
            failures,
            reason: 'offline',
            message: null,
            retryAt: now + wait,
        });
    }
    // A content refusal waits for an edit, which starts an ordinary wait.
    return put(s, key, { ...base, flush: false, failures, reason, message, retryAt: null });
}

/** The loadout is gone (deleted): nothing more to save. */
export function forget(s: Autosave, key: string): Autosave {
    if (!(key in s.entries)) return s;
    const entries = { ...s.entries };
    delete entries[key];
    return { ...s, entries };
}

/**
 * Nothing is left to send for `key` (the account copy already holds the draft: an edit taken back, or a save
 * whose result was not known that did land). The pending save is cancelled; a save in flight is left to report.
 * `landed`: it was this page's own save that arrived (the ring then reads "Auto saved").
 */
export function settle(s: Autosave, key: string, landed = false): Autosave {
    const e = s.entries[key];
    if (!e || e.inFlight !== null || !isDirty(e)) return s;
    return put(s, key, {
        ...e,
        everSaved: e.everSaved || landed,
        savedVersion: e.version,
        firstEditAt: null,
        lastEditAt: null,
        flush: false,
        retryAt: null,
        failures: 0,
        reason: null,
        message: null,
    });
}

/** Held: waits for the person's choice. Dirty, never sent; edits keep it held. A save in flight reports first. */
export function hold(
    s: Autosave,
    key: string,
    now: number,
    reason: HeldReason = 'conflict',
    message: string | null = null,
): Autosave {
    const e = s.entries[key];
    // Held already for this reason: kept (a message given earlier stays unless a new one is given).
    if (
        e &&
        (e.inFlight !== null ||
            (e.reason === reason && (message === null || e.message === message)))
    )
        return s;
    // A draft found on load has no entry yet: it is unsaved work, so it counts as an edit.
    const dirty = e && isDirty(e) ? e : edit(s, key, now).entries[key];
    if (!dirty) return s;
    return put(s, key, { ...dirty, flush: false, reason, message, retryAt: null });
}

/** The person chose (or the hold went away): due at once. */
export function release(s: Autosave, key: string): Autosave {
    const e = s.entries[key];
    if (!e || !isHeld(e.reason)) return s;
    return put(s, key, { ...e, reason: null, message: null, flush: isDirty(e) });
}

/** The loadout moved to another key (an account slot taken by another device): its state moves with it. */
export function moveKey(s: Autosave, from: string, to: string): Autosave {
    const e = s.entries[from];
    if (!e || from === to) return s;
    return put(forget(s, from), to, e);
}

/**
 * The part of a loadout's waiting state that another tab inherits when it takes the draft over (S14.3c fix 3,
 * review S1): why it waits (only the reasons that belong to the draft, not to this tab's connection or queue), how
 * many tries failed in a row, and when the next try is due. Stored in the draft.
 */
export type Wait = {
    reason: 'too-fast' | 'server-error' | 'server-stopped' | 'refused' | 'full' | null;
    failures: number;
    retryAt: number | null;
    message: string | null;
};

const INHERITED: readonly BlockReason[] = [
    'too-fast',
    'server-error',
    'server-stopped',
    'refused',
    'full',
];
const inherited = (r: BlockReason | null): r is NonNullable<Wait['reason']> =>
    r !== null && INHERITED.includes(r);

/** The waiting state to store with the draft of `key`; null when it has none (an ordinary wait). */
export function waitOf(s: Autosave, key: string): Wait | null {
    const e = s.entries[key];
    if (!e) return null;
    // A wait for this tab's own connection (offline, a lost answer) or queue is not the draft's: the next tab has
    // its own connection, so nothing of it is handed on.
    if (!inherited(e.reason)) return null;
    return { reason: e.reason, failures: e.failures, retryAt: e.retryAt, message: e.message };
}

export const sameWait = (a: Wait | null | undefined, b: Wait | null | undefined): boolean =>
    (a ?? null) === (b ?? null) ||
    (!!a &&
        !!b &&
        a.reason === b.reason &&
        a.failures === b.failures &&
        a.retryAt === b.retryAt &&
        a.message === b.message);

/**
 * A draft taken over from another tab (it left, or it is gone): a fresh entry that keeps the draft's waiting state.
 * `at`: the draft's last edit (its idle wait counts from there). `flush`: due at once (the tab that left asked for
 * it). `notBefore`: not sent before this time (a send of the leaving tab may still land: its row settles the draft).
 * A parked reason stays parked (an edit or a reconnect frees it, as in the tab that had it); a backoff keeps its time.
 */
export function adopt(
    s: Autosave,
    key: string,
    o: { at: number; wait: Wait | null | undefined; flush: boolean; notBefore: number | null },
): Autosave {
    const base = edit(forget(s, key), key, o.at).entries[key] as Entry;
    const w = o.wait ?? null;
    const times = [w?.retryAt, o.notBefore].filter((t): t is number => typeof t === 'number');
    return put(s, key, {
        ...base,
        flush: o.flush && !parked(w?.reason ?? null),
        failures: w?.failures ?? 0,
        reason: w?.reason ?? null,
        message: w?.reason ? w.message : null,
        retryAt: times.length > 0 ? Math.max(...times) : null,
    });
}

/** The loadout has unsaved edits (in flight or not). */
export function isPending(s: Autosave, key: string): boolean {
    const e = s.entries[key];
    return !!e && (isDirty(e) || e.inFlight !== null);
}

/** The version a save would carry now, to report back with `succeeded`. */
export function versionOf(s: Autosave, key: string): number {
    return s.entries[key]?.version ?? 0;
}

/** What the ring shows for `key`. */
export function statusOf(s: Autosave, key: string, now: number): AutosaveStatus {
    const e = s.entries[key];
    if (!e) return { kind: 'saved', everSaved: false };
    if (e.inFlight !== null) return { kind: 'saving' };
    if (!isDirty(e)) return { kind: 'saved', everSaved: e.everSaved };
    if (!s.online && !e.reason) return { kind: 'blocked', reason: 'offline', message: null };
    if (e.reason) return { kind: 'blocked', reason: e.reason, message: e.message };
    const from = e.lastEditAt ?? now;
    return { kind: 'waiting', from, due: Math.max(dueOf(e, now), e.retryAt ?? 0) };
}
