import { AUTOSAVE_IDLE_MS, type AutosaveStatus, type Wait } from './autosave';
import { type Loadout, sameContent } from './list';

// S14.3c-sync (DECISIONS.md A198): how an account draft (this browser's unsaved edits of an account loadout) stands
// against the row of `view_my_loadouts` in its slot, and what a `save_loadout` answer does to it. Pure: no storage, no
// clock, no network. The database decides staleness by version (`rev`); content is compared only to answer "is there
// anything left to send" (the row already holds the draft) and to recognise this page's own save.
//
// - `baseRev`: the version of the account copy the edits started from; 0 for a loadout with no account copy yet (a
//   save then creates). A save sends it; the server refuses a stale one ("changed on another device").
// - `sent`: the saves sent for this draft whose landing has not been seen (in flight, or their answer lost), kept in
//   storage so a reload still knows them. A row at `baseRev + 1` (any version for a create) holding one of them is
//   this page's own save: the draft is rebased on it, never shown as a conflict.
// - `held`: the draft waits for the person: the account copy changed elsewhere (`conflict`), the loadout was deleted
//   elsewhere (`deleted`), or its version cannot rise any more (`retired`). Held drafts are never sent.
// - `keep`: "Keep my changes" was pressed on a conflict: the next send goes on the draft's own version, so the server
//   says which it is: changed (sent again at once on the version the view shows) or deleted (the deleted choice).
// - `tab`, `seen`: the tab that writes and sends the draft (null: released by a tab that left), and when it last
//   touched it. Only that tab sends it; another tab takes it over only once the owner is gone: released, or its
//   presence lost (`ownership`; S14.3c fix 3, review S1). A live tab keeps its draft however long it waits.
// - `wait`: the owner's waiting state (failures in a row, backoff, a parked reason), so a tab that takes the draft
//   over goes on from there instead of sending at once (`adopt` in `autosave.ts`).

export type Content = Omit<Loadout, 'key'>;

export type Hold = 'conflict' | 'deleted' | 'retired';

/** A save sent from a draft: the version it was based on and what it carried. */
export type Sent = Content & { baseRev: number };

export type Draft = Content & {
    baseRev: number;
    /** The last edit, ms (shown in the conflict choice). */
    at: number;
    tab: string | null;
    /** The owning tab's last touch, ms (edit or take-over). */
    seen: number;
    sent: readonly Sent[];
    held: Hold | null;
    keep: boolean;
    /** The owner's waiting state (absent: an ordinary wait). */
    wait?: Wait | null;
};

/** A row of `view_my_loadouts` (name, note and code as the page keeps them). */
export type Row = Content & { rev: number };

/** At most this many unconfirmed sends are remembered per draft. */
export const SENT_KEEP = 4;

// The module's refusal texts this page reacts to (docs/loadout/architecture.md, the contract; the page cannot import
// `spacetimedb/src/helpers/roster/loadoutRules.ts`).
export const TOO_FAST_PREFIX = 'Your loadout was not saved yet: too many saves';
export const SLOT_TAKEN_TEXT =
    'That loadout slot is already in use. Your list was refreshed; save again.';
export const GONE_TEXT = 'That loadout was deleted on another device.';
export const CONFLICT_TEXT = 'That loadout was changed on another device.';
export const REV_MAX_TEXT = 'This loadout cannot be saved again. Save it as a new loadout.';

/** What a reducer call's answer means. */
export type Outcome =
    | { kind: 'ok' }
    /** Not sent: no open connection. */
    | { kind: 'offline' }
    /** Sent, the answer lost with the connection: it may have run. */
    | { kind: 'unknown' }
    /** The server's runtime failed; the transaction rolled back (known not written). */
    | { kind: 'internal' }
    | { kind: 'too-fast'; text: string }
    | { kind: 'slot-taken' }
    | { kind: 'deleted' }
    | { kind: 'changed' }
    | { kind: 'retired'; text: string }
    /** Any other module refusal (unknown character, unreadable team, the guest text, maintenance). */
    | { kind: 'refused'; text: string };

/** Reads an SDK or module error by its `name` (the SDK's classes) and the module's exact sentences. */
export function outcomeOf(error: unknown): Outcome {
    const name = error instanceof Error ? error.name : '';
    const text = error instanceof Error ? error.message : String(error);
    if (name === 'NotConnectedError' || name === 'DisconnectedError') return { kind: 'offline' };
    if (name === 'UnknownCallResultError') return { kind: 'unknown' };
    if (name === 'InternalError') return { kind: 'internal' };
    if (text.startsWith(TOO_FAST_PREFIX)) return { kind: 'too-fast', text };
    if (text === SLOT_TAKEN_TEXT) return { kind: 'slot-taken' };
    if (text === GONE_TEXT) return { kind: 'deleted' };
    if (text === CONFLICT_TEXT) return { kind: 'changed' };
    if (text === REV_MAX_TEXT) return { kind: 'retired', text };
    return { kind: 'refused', text };
}

const sentEqual = (a: Sent, b: Sent) => a.baseRev === b.baseRev && sameContent(a, b);

/** The row is one of the draft's own sends having landed: at its base plus one (a create: any version). */
export function isOwnSave(draft: Draft, row: Row): boolean {
    return draft.sent.some(
        (s) => sameContent(s, row) && (s.baseRev === 0 || row.rev === s.baseRev + 1),
    );
}

/**
 * What the row tells about the draft's own sends: one landed (the draft is rebased on the row, its sends and any
 * hold dropped), or one was an unchanged save (the row at its base already held it: forgotten). Same object when
 * nothing changes.
 */
export function absorbRow(draft: Draft, row: Row | null): Draft {
    if (!row || draft.sent.length === 0) return draft;
    if (isOwnSave(draft, row))
        return { ...draft, baseRev: row.rev, sent: [], held: null, keep: false };
    const sent = draft.sent.filter((s) => !(s.baseRev === row.rev && sameContent(s, row)));
    return sent.length === draft.sent.length ? draft : { ...draft, sent };
}

export type Verdict =
    /** The row holds the draft: nothing to send; the draft goes. */
    | { kind: 'drop' }
    /** Nothing in the way: saved by the ordinary rules. */
    | { kind: 'send'; draft: Draft }
    /** Waits for the person (`draft.held` says why). */
    | { kind: 'hold'; draft: Draft }
    /** A new loadout whose slot another loadout took: it moves to a free slot and is created there. */
    | { kind: 'move'; draft: Draft };

/**
 * The draft against the row in its slot (the rows fresh for this connection, no save of the draft in flight). The
 * returned draft is the same object when nothing about it changed. Idempotent: run again on its result, it gives
 * the same verdict and the same draft.
 */
export function reconcile(draft: Draft, row: Row | null): Verdict {
    const d = absorbRow(draft, row);
    if (row && sameContent(row, d)) return { kind: 'drop' };
    if (d.held === 'conflict' && !row) return { kind: 'hold', draft: { ...d, held: 'deleted' } };
    if (d.held) return { kind: 'hold', draft: d };
    // "Keep my changes": the server is asked, on the draft's own version (see `afterSave`).
    if (d.keep) return { kind: 'send', draft: d };
    if (d.baseRev === 0) return row ? { kind: 'move', draft: d } : { kind: 'send', draft: d };
    if (!row) return { kind: 'hold', draft: { ...d, held: 'deleted' } };
    if (row.rev !== d.baseRev) return { kind: 'hold', draft: { ...d, held: 'conflict' } };
    return { kind: 'send', draft: d };
}

/** The draft with a send recorded (the oldest forgotten beyond `SENT_KEEP`). */
export function withSent(draft: Draft, sent: Sent): Draft {
    return { ...draft, sent: [...draft.sent, sent].slice(-SENT_KEEP) };
}

/** What the scheduler does after an answer. */
export type Next =
    /** Committed. */
    | 'saved'
    /** The account copy already holds the draft: nothing left to send (the draft goes). */
    | 'settled'
    /** Send again at once (the draft was rebased, or the person had chosen to keep it). */
    | 'retry'
    /** A new loadout whose slot is taken: move it, then send at once. */
    | 'move'
    /** Held for the person. */
    | 'hold'
    | 'offline'
    | 'unknown'
    | 'internal'
    | 'too-fast'
    | 'refused';

/**
 * The draft after the answer to `sent` (one of its sends), against the row now in its slot. `draft` null in the
 * result: the draft goes. A send whose answer is known (refused, or not sent) is forgotten; a committed one and one
 * whose answer was lost stay until the row shows them (`absorbRow`).
 */
export function afterSave(
    draft: Draft,
    sent: Sent,
    outcome: Outcome,
    row: Row | null,
): { draft: Draft | null; next: Next; message: string | null } {
    const result = (d: Draft | null, next: Next, message: string | null = null) => ({
        draft: d,
        next,
        message,
    });
    if (outcome.kind === 'ok')
        return result(draft.keep ? { ...draft, keep: false } : draft, 'saved');
    if (outcome.kind === 'unknown') return result(draft, 'unknown');
    const left = draft.sent.filter((s) => !sentEqual(s, sent));
    const known = left.length === draft.sent.length ? draft : { ...draft, sent: left };
    switch (outcome.kind) {
        case 'offline':
        case 'internal':
            return result(known, outcome.kind);
        case 'too-fast':
        case 'refused':
            return result(known, outcome.kind, outcome.text);
        case 'retired':
            return result({ ...known, held: 'retired', keep: false }, 'hold', outcome.text);
        case 'deleted': {
            if (row && sameContent(row, known)) return result(null, 'settled');
            return result({ ...known, held: 'deleted', keep: false }, 'hold');
        }
        case 'slot-taken': {
            const d = absorbRow(known, row);
            if (row && sameContent(row, d)) return result(null, 'settled');
            // An earlier create of this draft landed (its answer was lost): an update now.
            if (d.baseRev !== 0) return result(d, 'retry');
            return result(d, 'move');
        }
        case 'changed': {
            const d = absorbRow(known, row);
            if (row && sameContent(row, d)) return result(null, 'settled');
            // The newer copy is this page's own earlier save: sent again on it.
            if (d.baseRev !== known.baseRev) return result(d, 'retry');
            if (d.keep && row && row.rev !== d.baseRev)
                return result({ ...d, baseRev: row.rev, keep: false, held: null }, 'retry');
            // A real conflict, or the view has not brought the newer copy yet (then the row, when it comes,
            // shows it, or `absorbRow` releases the hold if it is this page's own).
            return result({ ...d, held: 'conflict', keep: false }, 'hold');
        }
    }
}

/** "Keep my changes" on a conflict: sent next on the draft's own version (the server then says which it is). */
export function keepMine(draft: Draft): Draft {
    return { ...draft, held: null, keep: true };
}

/** "Save as a new loadout" (deleted elsewhere, or a version at its top): created next, from nothing. */
export function asNew(draft: Draft): Draft {
    return { ...draft, baseRev: 0, sent: [], held: null, keep: false };
}

/**
 * Account keys: a slot ("0" to "9"), or for a new draft that found no free slot (every slot taken by other
 * devices meanwhile) an unslotted key `u<id>`, kept until a slot frees. Unslotted drafts are never sent as they are.
 */
export const UNSLOTTED_PREFIX = 'u';
export const isUnslottedKey = (key: string) => /^u[0-9a-z-]{1,40}$/.test(key);

// ── Tabs of one browser (S14.3c fix 3, review S1 and M4, M8).

/**
 * Where the browser has no Web Locks: a tab is gone once neither its draft nor its heartbeat (written every
 * `BEAT_MS` while the page is open) has moved for this long.
 */
export const ADOPT_AFTER_MS = 90_000;
export const BEAT_MS = 30_000;
/**
 * A released draft whose last send may still land (the leaving tab sent it on its way out): the tab that takes it
 * over waits this long for its row before it sends the same save again (review M4).
 */
export const SENT_GRACE_MS = 10_000;

/** Heartbeat presence: the owner has shown no sign of life (draft touch or heartbeat) for `ADOPT_AFTER_MS`. */
export function beatGone(seen: number, beat: number | null, now: number): boolean {
    return now - Math.max(seen, beat ?? seen) >= ADOPT_AFTER_MS;
}

/** When a silent owner counts as gone (heartbeat presence). */
export function beatGoneAt(seen: number, beat: number | null): number {
    return Math.max(seen, beat ?? seen) + ADOPT_AFTER_MS;
}

/**
 * Who sends a stored draft, seen from tab `me`: `mine`; `take` (released by a tab that left, or its owner is known
 * gone: this tab adopts it with its waiting state); `wait` (another live tab owns it, however long it waits).
 */
export function ownership(draft: Draft, me: string, ownerGone: boolean): 'mine' | 'take' | 'wait' {
    if (draft.tab === me) return 'mine';
    if (draft.tab === null || ownerGone) return 'take';
    return 'wait';
}

/** The draft's last send carries exactly what the draft holds now: it may still land (or has, unseen). */
export function sendPending(draft: Draft): boolean {
    const last = draft.sent[draft.sent.length - 1];
    return !!last && last.baseRev === draft.baseRev && sameContent(last, draft);
}

/** How a tab that takes a draft over schedules it (see `adopt` in `autosave.ts`). */
export function adoption(
    draft: Draft,
    now: number,
): { at: number; wait: Wait | null; flush: boolean; notBefore: number | null } {
    return {
        at: draft.at,
        wait: draft.wait ?? null,
        // A tab that left asked for its drafts to be saved; a crashed one keeps its ordinary wait.
        flush: draft.tab === null,
        notBefore: sendPending(draft) ? now + SENT_GRACE_MS : null,
    };
}

/**
 * The version an edit of an account loadout is based on (review M8): the draft's; else the row's while the page
 * shows the row's team; else the version the page's team was loaded from (the row moved on since: a conflict, never
 * an overwrite); else the row's, or 0 (a new loadout).
 */
export function editBase(o: {
    draft: number | null;
    row: { rev: number; code: string } | null;
    /** What the page's team was loaded from, when it was this loadout. */
    loaded: { code: string | null; rev: number | null } | null;
}): number {
    if (o.draft !== null) return o.draft;
    const l = o.loaded;
    if (o.row && l && l.code !== null && o.row.code === l.code) return o.row.rev;
    if (l && l.rev !== null) return l.rev;
    return o.row?.rev ?? 0;
}

/**
 * The version a delete states: the one the person has seen (review M8). Their draft's base, else the row's. A new
 * loadout is on the account only once one of its creates landed (its row shows it); one deleted elsewhere is not
 * there at all. Null: nothing to delete on the account (the draft goes here only).
 */
export function deleteBase(draft: Draft | null, row: Row | null): number | null {
    if (draft?.held === 'deleted') return null;
    if (!draft) return row ? row.rev : null;
    if (draft.baseRev === 0) return row && isOwnSave(draft, row) ? row.rev : null;
    return draft.baseRev;
}

/**
 * What the ring shows for an account loadout (review S2, M8). `scheduled`: this tab's scheduler status, `null`
 * when it has no entry for the loadout. The ring never says "saved" over a stored draft that is not confirmed: a
 * draft with no entry (released by another tab, or found before the rows are fresh) reads "Not saved yet" with its
 * reason, unless the account copy already holds it. Another tab's draft reads as that tab's.
 */
export function ringStatus(o: {
    draft: Draft | null;
    me: string;
    scheduled: AutosaveStatus | null;
    row: Row | null;
    live: boolean;
    now: number;
}): AutosaveStatus {
    const { draft: d, scheduled } = o;
    if (d && d.tab !== null && d.tab !== o.me)
        return { kind: 'blocked', reason: 'other-tab', message: null };
    // This tab's schedule speaks only for a draft this tab owns (a released one is nobody's until taken over).
    if (scheduled && (!d || d.tab === o.me)) return scheduled;
    if (!d || (o.row && sameContent(o.row, d))) return { kind: 'saved', everSaved: false };
    if (d.held) return { kind: 'blocked', reason: d.held, message: null };
    if (!o.live) return { kind: 'blocked', reason: 'offline', message: null };
    return { kind: 'waiting', from: d.at, due: Math.max(o.now, d.at + AUTOSAVE_IDLE_MS) };
}
