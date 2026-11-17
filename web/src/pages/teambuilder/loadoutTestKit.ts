import type { MyLoadoutRow } from '@bindings/types';
import type { Draft, Hold } from '@shared/loadouts';
import { decodeTeam, encodeTeam } from '@shared/teambuilder';
import { act, screen } from '@testing-library/react';
import { SenderError } from 'spacetimedb';
import { vi } from 'vitest';
import { setConnectionStatus } from '@/stdb/connectionStatus';
import type { LoadoutReducersLike } from '@/stdb/types';
import { CHARACTERS, characterCost, LIGHTCONES } from '@/test/costFixtures';
import { MockConnection, MockTable, profileRow } from '@/test/mockConnection';
import { renderWithConnection } from '@/test/renderWithConnection';
import { ACTIVE_KEY, BROWSER_KEY, draftsKey } from './loadoutStorage';

/*
 * Test kit for the team builder's loadout tests (T-S14.3c-sync; imported by test files only, never by the app).
 *
 * `LoadoutServer` is a test double of the module's `save_loadout` and `delete_loadout` (S14.3c-rev), written from
 * `spacetimedb/src/reducers/roster/userLoadouts.ts` and `helpers/roster/loadoutRules.ts` and kept to their order
 * and texts: slot range; the version check (`ensureLoadoutBase`: base 0 needs a free slot, else "slot already in
 * use"; a base below the slot's `firstRev` or an empty slot is "deleted"; another version of the same loadout is
 * "changed"); the content checks (name trimmed, not blank, at most 40; note at most 1,000; the code decodes, is
 * canonical and names known characters); an unchanged save writes nothing; the version top; then the save limit (6
 * per account in a fixed 60 s window, counted only for a save that writes); then the write: an update to
 * `baseRev + 1`, a new loadout to one above the account's highest version ever (`revFloor`), kept as `firstRev`.
 * Deletes: an empty slot or a newer loadout in it (base below `firstRev`) is a silent no-op; another version is
 * "changed"; deletes count on no limit. The view (`view_my_loadouts`) is the mock table: rows `{ slot, rev, name,
 * note, code }`, changed after the write as the server sends them, or queued while `holdView` is on (the rows a
 * reconnect replays later).
 */

export const ACHERON = '1.acheron-0._._._.as-c-0-3000-1500';
export const CLARA = '1.clara-0._._._.as-c-0-3000-1500';
export const PELA = '1.pela-6._._._.as-c-0-3000-1500';
export const EMPTY = '1._._._._.as-c-0-3000-1500';

export const TEXT = {
    slot: 'Loadout slot must be between 1 and 10.',
    taken: 'That loadout slot is already in use. Your list was refreshed; save again.',
    gone: 'That loadout was deleted on another device.',
    changed: 'That loadout was changed on another device.',
    top: 'This loadout cannot be saved again. Save it as a new loadout.',
    tooFast:
        'Your loadout was not saved yet: too many saves in a short time. It will be saved in a moment.',
    nameEmpty: 'Loadout name cannot be empty.',
    nameLong: 'Loadout name cannot exceed 40 characters.',
    noteLong: 'Loadout note cannot exceed 1000 characters.',
    code: 'This team could not be read. Reload the page and try again.',
    duplicate: 'A team cannot hold the same character twice.',
} as const;

type Stored = { rev: number; firstRev: number; name: string; note: string; code: string };
type SaveArgs = Parameters<LoadoutReducersLike['saveLoadout']>[0];
type DeleteArgs = Parameters<LoadoutReducersLike['deleteLoadout']>[0];

export class LoadoutServer {
    readonly slots = new Map<number, Stored>();
    revFloor = 0;
    window: { start: number; count: number } | null = null;
    /** Accepted saves that wrote (for counting). */
    writes = 0;
    /** View changes not yet delivered (while `holdView`). */
    private queued: (() => void)[] = [];
    holdView = false;
    /** Character keys the reference tables hold. */
    known = new Set(CHARACTERS.map((c) => c.name));

    constructor(private view: MockTable<MyLoadoutRow>) {}

    /** A reload: the server's rows go to a new connection's view (changes held back are dropped: it reads anew). */
    attach(view: MockTable<MyLoadoutRow>) {
        this.view = view;
        this.queued = [];
        this.holdView = false;
        view.rows = [...this.slots.entries()].map(([slot, s]) => ({
            slot,
            rev: s.rev,
            name: s.name,
            note: s.note,
            code: s.code,
        }));
    }

    private emit(change: () => void) {
        if (this.holdView) this.queued.push(change);
        else change();
    }
    /** Delivers the view changes held back (the replay after a reconnect brings them). */
    flushView() {
        const q = this.queued;
        this.queued = [];
        for (const c of q) c();
    }

    private toView(slot: number, s: Stored | null) {
        this.emit(() => {
            const at = this.view.rows.find((r) => r.slot === slot);
            if (!s) {
                if (at) this.view.delete(at);
                return;
            }
            const row = { slot, rev: s.rev, name: s.name, note: s.note, code: s.code };
            if (at) this.view.update(at, row);
            else this.view.insert(row);
        });
    }

    /** `save_loadout`, in the reducer's order. Throws the module's refusal as a `SenderError`. */
    save({ slot, baseRev, name, note, code }: SaveArgs): void {
        if (!Number.isInteger(slot) || slot < 0 || slot >= 10) throw new SenderError(TEXT.slot);
        const existing = this.slots.get(slot);
        if (baseRev === 0) {
            if (existing) throw new SenderError(TEXT.taken);
        } else {
            if (!existing || baseRev < existing.firstRev) throw new SenderError(TEXT.gone);
            if (existing.rev !== baseRev) throw new SenderError(TEXT.changed);
        }
        const trimmed = name.trim();
        if (!trimmed) throw new SenderError(TEXT.nameEmpty);
        if (trimmed.length > 40) throw new SenderError(TEXT.nameLong);
        if (note.length > 1000) throw new SenderError(TEXT.noteLong);
        if (code.length > 400) throw new SenderError(TEXT.code);
        const decoded = decodeTeam(code, {
            characters: { has: (n: string) => this.known.has(n) },
            lightcones: { has: () => true },
        });
        if (!decoded.ok)
            throw new SenderError(decoded.error === 'duplicate' ? TEXT.duplicate : TEXT.code);
        const encoded = encodeTeam(decoded.team);
        if (!encoded.ok || encoded.code !== code) throw new SenderError(TEXT.code);
        const first = decoded.unavailable[0];
        if (first) throw new SenderError(`Unknown character "${first.name}".`);
        if (
            existing &&
            existing.name === trimmed &&
            existing.note === note &&
            existing.code === code
        )
            return;
        const base = existing ? existing.rev : this.revFloor;
        if (base >= 0xffff_ffff) throw new SenderError(TEXT.top);
        const rev = base + 1;
        this.allow(rev);
        const next: Stored = existing
            ? { ...existing, rev, name: trimmed, note, code }
            : { rev, firstRev: rev, name: trimmed, note, code };
        this.slots.set(slot, next);
        this.writes += 1;
        this.toView(slot, next);
    }

    /** The save limit, last: 6 writes per fixed 60 s window; raises `revFloor` in the same write. */
    private allow(newRev: number) {
        const now = Date.now();
        if (!this.window || now - this.window.start >= 60_000) {
            this.window = { start: now, count: 1 };
        } else {
            if (this.window.count >= 6) throw new SenderError(TEXT.tooFast);
            this.window.count += 1;
        }
        this.revFloor = Math.max(this.revFloor, newRev);
    }

    /** `delete_loadout`. */
    remove({ slot, baseRev }: DeleteArgs): void {
        if (!Number.isInteger(slot) || slot < 0 || slot >= 10) throw new SenderError(TEXT.slot);
        const existing = this.slots.get(slot);
        if (!existing || baseRev < existing.firstRev) return;
        if (existing.rev !== baseRev) throw new SenderError(TEXT.changed);
        this.slots.delete(slot);
        this.toView(slot, null);
    }

    /** A loadout that exists before the page opens (made by a save, so its version follows the rules). */
    seed(slot: number, name: string, code = ACHERON, note = ''): MyLoadoutRow {
        const saved = this.window;
        this.save({ slot, baseRev: 0, name, note, code });
        this.window = saved;
        this.writes -= 1;
        const s = this.slots.get(slot) as Stored;
        return { slot, rev: s.rev, name: s.name, note: s.note, code: s.code };
    }

    /** The current version in a slot (0: empty). */
    rev(slot: number): number {
        return this.slots.get(slot)?.rev ?? 0;
    }

    /** Another device's save (same account: it counts on the same limit). Based on the current version. */
    elsewhere(slot: number, name: string, code = ACHERON, note = '') {
        this.save({ slot, baseRev: this.rev(slot), name, note, code });
    }
    /** Another device deletes the loadout in `slot`. */
    deleteElsewhere(slot: number) {
        this.remove({ slot, baseRev: this.rev(slot) });
    }

    /** What is stored, in slot order. */
    list(): { slot: number; name: string; code: string; rev: number }[] {
        return [...this.slots.entries()]
            .sort(([a], [b]) => a - b)
            .map(([slot, s]) => ({ slot, name: s.name, code: s.code, rev: s.rev }));
    }
}

export type Conn = MockConnection & {
    db: MockConnection['db'] & { viewMyLoadouts: MockTable<MyLoadoutRow> };
    reducers: {
        saveLoadout: ReturnType<typeof vi.fn<LoadoutReducersLike['saveLoadout']>>;
        deleteLoadout: ReturnType<typeof vi.fn<LoadoutReducersLike['deleteLoadout']>>;
    };
    server: LoadoutServer;
};

/** A mock connection whose loadout reducers are the server double. */
export function makeConn(): Conn {
    const c = new MockConnection() as Conn;
    const view = new MockTable<MyLoadoutRow>();
    Object.assign(c.db, { viewMyLoadouts: view });
    const server = new LoadoutServer(view);
    c.server = server;
    c.reducers = {
        saveLoadout: vi.fn<LoadoutReducersLike['saveLoadout']>(async (a) => server.save(a)),
        deleteLoadout: vi.fn<LoadoutReducersLike['deleteLoadout']>(async (a) => server.remove(a)),
    } as unknown as Conn['reducers'];
    return c;
}

export const MEMBER = {
    ready: true,
    user: { id: 7, role: { tag: 'User' }, isGuest: false },
} as const;
export const VISITOR = { ready: true } as const;
export const GUEST = {
    ready: true,
    user: { id: 9, role: { tag: 'User' }, isGuest: true },
} as const;

export function seedReference(conn: Conn, profile?: { id: number; isGuest?: boolean }) {
    conn.db.hsrCharacter.seed(...CHARACTERS);
    conn.db.hsrLightcone.seed(...LIGHTCONES);
    conn.db.hsrCharacterCost.seed(
        characterCost('acheron', 7),
        characterCost('clara', 2),
        characterCost('pela', 1),
    );
    if (profile)
        conn.db.viewMyProfile.seed(
            profileRow({ id: profile.id, isGuest: profile.isGuest ?? false }),
        );
}

/**
 * Opens the page as member 7 with `rows` already on the server (each made by `server.seed`, so versions are
 * real) and the view's first result in.
 */
export async function openMember(
    conn: Conn,
    rows: { slot: number; name: string; code?: string; note?: string }[] = [],
    path = '/teambuilder',
) {
    for (const r of rows) conn.server.seed(r.slot, r.name, r.code, r.note);
    const view = conn.db.viewMyLoadouts;
    const seeded = [...view.rows];
    view.rows = [];
    const result = renderWithConnection(path, conn, MEMBER as never);
    await screen.findByRole('heading', { level: 1 });
    seedReference(conn, { id: 7 });
    view.seed(...seeded);
    await act(async () => conn.applyAll());
    // A second pass: the loadout view subscribes once the profile says "verified".
    await act(async () => conn.applyAll());
    return result;
}

export async function openVisitor(conn: Conn, path = '/teambuilder', who = VISITOR) {
    const result = renderWithConnection(path, conn, who as never);
    await screen.findByRole('heading', { level: 1 });
    seedReference(conn, who === GUEST ? { id: 9, isGuest: true } : undefined);
    await act(async () => conn.applyAll());
    await act(async () => conn.applyAll());
    return result;
}

/** The connection drops (the SDK's `reconnecting`). */
export const drop = () => act(() => setConnectionStatus({ state: 'reconnecting', reason: 'lost' }));
/**
 * The connection comes back in the SDK's order: `connected` first (the old rows still cached), then the replay
 * brings the rows changed meanwhile, then each subscription's `onApplied`. `deliver: false`: the replay is applied
 * but the view's held-back changes still lag (a slow view; the rows count as fresh).
 */
export async function reconnect(conn: Conn, { replay = true, deliver = true } = {}) {
    act(() => setConnectionStatus({ state: 'connected' }));
    await act(async () => {});
    if (!replay) return;
    await act(async () => {
        if (deliver) {
            conn.server.holdView = false;
            conn.server.flushView();
        }
        conn.applyAll();
    });
}

/** A reload of the page as member 7 on a new connection to the same server. */
export async function reload(conn: Conn, path = '/teambuilder'): Promise<Conn> {
    const next = makeConn();
    next.server = conn.server;
    conn.server.attach(next.db.viewMyLoadouts);
    next.reducers.saveLoadout.mockImplementation(async (a) => next.server.save(a));
    next.reducers.deleteLoadout.mockImplementation(async (a) => next.server.remove(a));
    const rows = [...next.db.viewMyLoadouts.rows];
    next.db.viewMyLoadouts.rows = [];
    renderWithConnection(path, next, MEMBER as never);
    await screen.findByRole('heading', { level: 1 });
    seedReference(next, { id: 7 });
    next.db.viewMyLoadouts.seed(...rows);
    await act(async () => next.applyAll());
    await act(async () => next.applyAll());
    return next;
}

export const fakeTimers = () =>
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
export const later = async (ms: number) => {
    await act(async () => {
        vi.advanceTimersByTime(ms);
    });
};

/** A stored draft (another visit's, released: `tab` null unless given). */
export function draft(
    over: Partial<Draft> & { code: string; baseRev: number; name?: string },
): Draft {
    const at = over.at ?? Date.UTC(2026, 10, 16, 9, 30);
    return {
        name: 'New Loadout',
        note: '',
        tab: null,
        seen: at,
        sent: [],
        held: null as Hold | null,
        keep: false,
        ...over,
        at,
    };
}
export const putDrafts = (drafts: Record<string, Draft>, user = 7) =>
    localStorage.setItem(draftsKey(user), JSON.stringify(drafts));
export const storedDrafts = (user = 7) =>
    JSON.parse(localStorage.getItem(draftsKey(user)) ?? 'null') as Record<string, Draft> | null;
export const putActive = (key: string, rev?: number, user = 7) =>
    localStorage.setItem(
        ACTIVE_KEY,
        JSON.stringify({ kind: 'account', key, user, ...(rev !== undefined ? { rev } : {}) }),
    );
export const browserList = () =>
    JSON.parse(localStorage.getItem(BROWSER_KEY) ?? 'null') as {
        loadouts: { key: string; name: string; note: string; code: string }[];
    } | null;

/** The calls of `save_loadout` as `slot/base/name/code`. */
export const saves = (conn: Conn) =>
    conn.reducers.saveLoadout.mock.calls.map(([a]) => `${a.slot}/${a.baseRev}/${a.name}/${a.code}`);

export const card = (name: string) =>
    screen.getAllByRole('button', { name: new RegExp(`^${name},`) })[0] as HTMLElement;
export const nameField = () =>
    screen.getByRole('textbox', { name: 'Rename active loadout' }) as HTMLInputElement;
export const noteField = () => screen.getByRole('textbox', { name: 'Note' }) as HTMLTextAreaElement;
export const caret = () => screen.getByRole('button', { name: 'Switch loadout' });
export const slotNames = () =>
    [...document.querySelectorAll('[data-slot]')].map(
        (li) => li.querySelector('h3')?.textContent ?? null,
    );
export const ringText = () => document.querySelector('[data-state]')?.textContent ?? null;
/**
 * S14.3g: the save indicator's words for a good state (saved, waiting, saving): visually hidden text, read with the
 * name field (its description), never shown. `saidText`: what it says now (null: no such text). `said`: finds the
 * hidden text with these words (throws when they are missing or only visible elsewhere).
 */
export const saidText = (root: ParentNode = document) =>
    root.querySelector('[data-save-said]')?.textContent ?? null;
export const said = (text: string) => screen.getByText(text, { selector: '[data-save-said]' });
/** The indicator's icon (`ring`, `ring-full`, `check`, `floppy`, `warning`), or null when there is none. */
export const saveIcon = () =>
    document.querySelector('[data-save-icon]')?.getAttribute('data-save-icon') ?? null;
export const choice = () => screen.queryByRole('button', { name: 'Keep my changes' });
export const deletedChoice = () => screen.queryByRole('button', { name: 'Save as a new loadout' });

// jsdom may lack the modal dialog methods: a small stand-in with the same events.
const proto = HTMLDialogElement.prototype as HTMLDialogElement & Record<string, unknown>;
const nativeShow = proto.showModal;
const nativeClose = proto.close;
export function installDialog() {
    if (typeof nativeShow !== 'function') {
        proto.showModal = function (this: HTMLDialogElement) {
            this.setAttribute('open', '');
        };
    }
    proto.close = function (this: HTMLDialogElement, value?: string) {
        if (value !== undefined) this.returnValue = value;
        this.removeAttribute('open');
        this.dispatchEvent(new Event('close'));
    };
}
export function removeDialog() {
    proto.close = nativeClose;
    if (typeof nativeShow !== 'function') Reflect.deleteProperty(proto, 'showModal');
}
