import {
    BROWSER_LOADOUT_LIMIT,
    type Content,
    cleanLoadout,
    type Draft,
    type Hold,
    isUnslottedKey,
    keySlot,
    LOADOUT_NAME_MAX,
    type Loadout,
    loadoutName,
    loadoutNote,
    SENT_KEEP,
    type Sent,
    type Wait,
} from '@shared/loadouts';
import { decodeTeam } from '@shared/teambuilder';

/*
 * Loadouts in browser storage (S14.3c). Three keys, all versioned, all read and written through try/catch: storage
 * may be blocked or full (a private window, site data off), and the page then keeps everything in memory for this
 * visit only.
 *
 * - `hsrpvp.teambuilder.loadouts.v1`: the browser list (visitors and guests; also kept and shown after sign-in),
 *   `{ v: 1, loadouts: [{ key, name, note, code }] }`, at most 5. Written at once on every change, read fresh before
 *   each write (read, change, write), so two tabs do not drop each other's loadouts.
 * - `hsrpvp.teambuilder.active.v1`: which loadout the page showed last (`{ kind, key, user, rev }`; `rev`, for an
 *   account loadout, the version the page's team was taken from), plus the browser loadout shown last (`browser`,
 *   what the page goes back to on sign-out) and, while a shared team is on the page, `shared: true` with the loadout
 *   the link replaced (`before`), so a reload keeps the shared team (fix pass S3, S5). S14.3e (A205): while the
 *   working loadout shows, also its `name` and `note` when they are not the defaults: a name or note typed on an
 *   empty team is not a loadout yet, and a reload keeps it without listing it anywhere.
 * - `hsrpvp.teambuilder.account-drafts.v2.<user id>`: per account, the edits of account loadouts not yet in the
 *   account copy (`{ [slot]: Draft }`, `shared/loadouts/sync.ts`: content, `baseRev`, `at`, `tab`, `seen`, `sent`,
 *   `held`, `keep`, and `wait`: the owner's waiting state, S14.3c fix 3). One entry per loadout, shared by every tab of this browser: a tab writes its edits at once and
 *   reads the others' through the `storage` event (S14.3c-sync). An entry goes when the account copy holds it. A new
 *   draft that found every slot taken waits under an unslotted key (`u…`). v2: the S14.3c v1 shape (content `base`)
 *   was never published and is not read.
 *
 * - `hsrpvp.teambuilder.tabs.v1`: the heartbeat of open tabs where the browser has no Web Locks (`tabPresence.ts`).
 *
 * Anything that does not read back (bad JSON, a team text this build cannot decode, a wrong shape) is skipped.
 */

export const BROWSER_KEY = 'hsrpvp.teambuilder.loadouts.v1';
export const ACTIVE_KEY = 'hsrpvp.teambuilder.active.v1';
export const DRAFTS_PREFIX = 'hsrpvp.teambuilder.account-drafts.v2.';
export const draftsKey = (userId: number) => `${DRAFTS_PREFIX}${userId}`;

export type { Content };

export type StoredRef =
    | { kind: 'browser'; key: string }
    | { kind: 'account'; key: string; user: number; rev?: number };

export type StoredActive = (
    | {
          kind: 'working';
          shared?: boolean;
          before?: StoredRef;
          /** S14.3e (A205): the working loadout's name and note, kept while it is not a loadout (no character). */
          name?: string;
          note?: string;
      }
    | StoredRef
) & {
    /** The browser loadout shown last on this browser (sign-out goes back to it). */
    browser?: string;
};

const accountKey = (key: unknown): key is string =>
    isText(key) && (keySlot(key) !== null || isUnslottedKey(key));

function getItem(key: string): string | null {
    try {
        return localStorage.getItem(key);
    } catch {
        return null;
    }
}

function setItem(key: string, value: string): boolean {
    try {
        localStorage.setItem(key, value);
        return true;
    } catch {
        return false;
    }
}

function removeItem(key: string): void {
    try {
        localStorage.removeItem(key);
    } catch {
        // Blocked storage: nothing was kept.
    }
}

function parse(text: string | null): unknown {
    if (text === null) return null;
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

const isText = (v: unknown): v is string => typeof v === 'string';
const readable = (code: unknown): code is string => isText(code) && decodeTeam(code).ok;

function content(v: unknown): Content | null {
    if (!v || typeof v !== 'object') return null;
    const o = v as Record<string, unknown>;
    if (!isText(o.name) || !isText(o.note) || !readable(o.code)) return null;
    return { name: loadoutName(o.name), note: loadoutNote(o.note), code: o.code };
}

/** Storage can be written (a probe write and removal). */
export function storageWorks(): boolean {
    const probe = 'hsrpvp.teambuilder.probe';
    if (!setItem(probe, '1')) return false;
    removeItem(probe);
    return true;
}

/** The browser list; empty when absent or unreadable. */
export function readBrowser(): Loadout[] {
    const data = parse(getItem(BROWSER_KEY)) as { v?: unknown; loadouts?: unknown } | null;
    if (data?.v !== 1 || !Array.isArray(data.loadouts)) return [];
    const out: Loadout[] = [];
    const keys = new Set<string>();
    for (const raw of data.loadouts) {
        const c = content(raw);
        const key = (raw as { key?: unknown } | null)?.key;
        if (!c || !isText(key) || key === '' || keys.has(key)) continue;
        keys.add(key);
        out.push(cleanLoadout({ key, ...c }));
        if (out.length >= BROWSER_LOADOUT_LIMIT) break;
    }
    return out;
}

/** Writes the browser list; false when storage refused it. */
export function writeBrowser(list: readonly Loadout[]): boolean {
    return setItem(BROWSER_KEY, JSON.stringify({ v: 1, loadouts: list }));
}

function readRef(v: Record<string, unknown> | null | undefined): StoredRef | null {
    if (v?.kind === 'browser' && isText(v.key)) return { kind: 'browser', key: v.key };
    if (v?.kind === 'account' && accountKey(v.key) && typeof v.user === 'number')
        return {
            kind: 'account',
            key: v.key,
            user: v.user,
            ...(isRev(v.rev) ? { rev: v.rev } : {}),
        };
    return null;
}

const isRev = (v: unknown): v is number =>
    typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 0xffff_ffff;
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const HOLDS: readonly Hold[] = ['conflict', 'deleted', 'retired'];

export function readActive(): StoredActive {
    const v = parse(getItem(ACTIVE_KEY)) as Record<string, unknown> | null;
    const browser = isText(v?.browser) ? { browser: v.browser } : {};
    const ref = readRef(v);
    if (ref) return { ...ref, ...browser };
    // S14.3e: the working loadout's name and note (a name over the field's cap or not text is dropped).
    const meta =
        v?.kind === 'working'
            ? {
                  ...(isText(v.name) && v.name.length <= LOADOUT_NAME_MAX ? { name: v.name } : {}),
                  ...(isText(v.note) ? { note: loadoutNote(v.note) } : {}),
              }
            : {};
    if (v?.kind === 'working' && v.shared === true) {
        const before = readRef(v.before as Record<string, unknown> | undefined);
        return {
            kind: 'working',
            shared: true,
            ...(before ? { before } : {}),
            ...meta,
            ...browser,
        };
    }
    return { kind: 'working', ...meta, ...browser };
}

export function writeActive(active: StoredActive): void {
    setItem(ACTIVE_KEY, JSON.stringify(active));
}

function sentOf(v: unknown): Sent | null {
    const c = content(v);
    const baseRev = (v as { baseRev?: unknown } | null)?.baseRev;
    return c && isRev(baseRev) ? { ...c, baseRev } : null;
}

/** One stored draft, or null when it does not read back. */
function draftOf(raw: unknown): Draft | null {
    const c = content(raw);
    if (!c) return null;
    const o = raw as Record<string, unknown>;
    if (!isRev(o.baseRev) || !isTime(o.at)) return null;
    const sent = Array.isArray(o.sent)
        ? o.sent.map(sentOf).filter((s): s is Sent => s !== null)
        : [];
    return {
        ...c,
        baseRev: o.baseRev,
        at: o.at,
        tab: isText(o.tab) ? o.tab : null,
        seen: isTime(o.seen) ? o.seen : o.at,
        sent: sent.slice(-SENT_KEEP),
        held: HOLDS.find((h) => h === o.held) ?? null,
        keep: o.keep === true,
        wait: waitOf(o.wait),
    };
}

const WAIT_REASONS: readonly NonNullable<Wait['reason']>[] = [
    'too-fast',
    'server-error',
    'server-stopped',
    'refused',
    'full',
];

/** A stored waiting state (S14.3c fix 3), or null when absent or unreadable. */
function waitOf(v: unknown): Wait | null {
    if (!v || typeof v !== 'object') return null;
    const o = v as Record<string, unknown>;
    const failures = o.failures;
    if (typeof failures !== 'number' || !Number.isInteger(failures) || failures < 0) return null;
    return {
        reason: WAIT_REASONS.find((r) => r === o.reason) ?? null,
        failures,
        retryAt: isTime(o.retryAt) ? o.retryAt : null,
        message: isText(o.message) ? o.message : null,
    };
}

/**
 * The heartbeat of open team builder tabs where the browser has no Web Locks (`tabPresence.ts`):
 * `{ [tab id]: last beat, ms }`.
 */
export const PRESENCE_KEY = 'hsrpvp.teambuilder.tabs.v1';

export function readBeats(): Record<string, number> {
    const v = parse(getItem(PRESENCE_KEY));
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    const out: Record<string, number> = {};
    for (const [k, t] of Object.entries(v as Record<string, unknown>)) if (isTime(t)) out[k] = t;
    return out;
}

/** Writes this tab's beat (or removes it: null), dropping beats older than `staleBefore`. */
export function writeBeat(tab: string, at: number | null, staleBefore: number): void {
    const next: Record<string, number> = {};
    for (const [k, t] of Object.entries(readBeats()))
        if (k !== tab && t >= staleBefore) next[k] = t;
    if (at !== null) next[tab] = at;
    if (Object.keys(next).length === 0) removeItem(PRESENCE_KEY);
    else setItem(PRESENCE_KEY, JSON.stringify(next));
}

/** This account's drafts in this browser (every tab's). */
export function readDrafts(userId: number): Record<string, Draft> {
    const v = parse(getItem(draftsKey(userId)));
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    const out: Record<string, Draft> = {};
    for (const [key, raw] of Object.entries(v as Record<string, unknown>)) {
        if (!accountKey(key)) continue;
        const d = draftOf(raw);
        if (d) out[key] = d;
    }
    return out;
}

/** Writes this account's whole draft set; false when storage refused it. */
export function writeDrafts(userId: number, all: Readonly<Record<string, Draft>>): boolean {
    if (Object.keys(all).length === 0) {
        removeItem(draftsKey(userId));
        return getItem(draftsKey(userId)) === null;
    }
    return setItem(draftsKey(userId), JSON.stringify(all));
}

/** An id for this tab's page visit (the owner of the drafts it writes). */
export function newTabId(): string {
    return newBrowserKey().replace(/^b-/, 't-');
}

/** A browser loadout key: unique enough for five loadouts in one browser. */
export function newBrowserKey(): string {
    const c = globalThis.crypto as Crypto | undefined;
    if (c?.randomUUID) return `b-${c.randomUUID()}`;
    return `b-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
