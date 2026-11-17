import type { Draft } from '@shared/loadouts';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InternalError } from 'spacetimedb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INTRO_KEY } from '@/components/PageIntro/PageIntro';
import { setConnectionStatus } from '@/stdb/connectionStatus';
import { renderWithConnection } from '@/test/renderWithConnection';
import { ACTIVE_KEY, BROWSER_KEY, draftsKey, PRESENCE_KEY } from './loadoutStorage';
import {
    ACHERON,
    CLARA,
    type Conn,
    card,
    caret,
    draft,
    drop,
    fakeTimers,
    installDialog,
    later,
    MEMBER,
    makeConn,
    nameField,
    noteField,
    openMember,
    PELA,
    putActive,
    putDrafts,
    removeDialog,
    ringText,
    saves,
    seedReference,
    storedDrafts,
} from './loadoutTestKit';
import { DRAFT_KEY, PREVIOUS_KEY } from './teamStorage';

/*
 * T-S14.3c-fix3: the last fixes to the account sync after the third review (tmp/teambuilder/review3-s14-3c.md).
 *
 * Two tabs are two real pages on one mock connection (the same account, the same server double): each has its own
 * tab id, scheduler and presence. Storage is shared (one jsdom window); the `storage` event a browser sends to the
 * other tabs is sent here by a bridge after each write to a loadout key, to both pages (the writer only re-reads).
 * Without Web Locks in jsdom the presence is the heartbeat; one test installs a stand-in lock manager.
 */

let conn: Conn;

beforeEach(() => {
    conn = makeConn();
    const keys = [INTRO_KEY, DRAFT_KEY, PREVIOUS_KEY, BROWSER_KEY, ACTIVE_KEY, PRESENCE_KEY];
    for (const k of [...keys, draftsKey(7)]) localStorage.removeItem(k);
    setConnectionStatus({ state: 'connected' });
    installDialog();
});
afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    removeDialog();
    Reflect.deleteProperty(navigator, 'locks');
});

const T2 = '1.acheron-0.pela-6._._.as-c-0-3000-1500';

/** Delivers a `storage` event after each write to the drafts key, as a browser does in the other tabs. */
function bridgeStorage() {
    const proto = Object.getPrototypeOf(localStorage) as Storage;
    const set = proto.setItem;
    const remove = proto.removeItem;
    const tell = (key: string) => {
        if (key !== draftsKey(7)) return;
        queueMicrotask(() =>
            act(() => {
                window.dispatchEvent(new StorageEvent('storage', { key }));
            }),
        );
    };
    vi.spyOn(proto, 'setItem').mockImplementation(function (this: Storage, k, v) {
        set.call(this, k, v);
        tell(k);
    });
    vi.spyOn(proto, 'removeItem').mockImplementation(function (this: Storage, k) {
        remove.call(this, k);
        tell(k);
    });
}

/** Two pages (tabs) of member 7 on the same server, the loadout in slot 0 active in both. */
async function openTwoTabs() {
    conn.server.seed(0, 'Hyper');
    const seeded = [...conn.db.viewMyLoadouts.rows];
    conn.db.viewMyLoadouts.rows = [];
    putActive('0', 1);
    const one = renderWithConnection('/teambuilder', conn, MEMBER as never);
    const two = renderWithConnection('/teambuilder', conn, MEMBER as never);
    await waitFor(() => expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(2));
    seedReference(conn, { id: 7 });
    conn.db.viewMyLoadouts.seed(...seeded);
    await act(async () => conn.applyAll());
    await act(async () => conn.applyAll());
    const ring = (c: HTMLElement) => c.querySelector('[data-state]')?.textContent ?? null;
    const pick = (c: HTMLElement, name: string) =>
        fireEvent.click(
            within(c).getAllByRole('button', { name: new RegExp(`^${name},`) })[0] as HTMLElement,
        );
    return { one, two, ring, pick };
}

const failEverySave = () =>
    conn.reducers.saveLoadout.mockImplementation(async () => {
        throw new InternalError('out of energy');
    });

describe('two tabs: a live tab keeps its draft however long it waits (review S1)', () => {
    it('a failing save: five tries in all across both tabs in 20 minutes, as for one tab; no take-over', async () => {
        fakeTimers();
        bridgeStorage();
        failEverySave();
        const { one, two, ring, pick } = await openTwoTabs();
        pick(one.container, 'Pela');
        await later(61_000);
        expect(saves(conn)).toHaveLength(1);
        await waitFor(() => expect(ring(two.container)).toMatch(/another tab/));
        for (let i = 0; i < 40; i++) await later(30_000);
        expect(saves(conn)).toHaveLength(5);
        // The owner is still tab one: tab two never took it over.
        expect(ring(one.container)).toMatch(/after your next change/);
        expect(ring(two.container)).toMatch(/another tab/);
        expect(storedDrafts()?.['0']?.wait).toMatchObject({
            reason: 'server-stopped',
            failures: 5,
        });
    });

    it('a draft parked by a content refusal waits past 90 s: no take-over, no second call', async () => {
        fakeTimers();
        bridgeStorage();
        conn.server.known.delete('pela');
        const { one, two, ring, pick } = await openTwoTabs();
        pick(one.container, 'Pela');
        await later(61_000);
        expect(saves(conn)).toHaveLength(1);
        for (let i = 0; i < 20; i++) await later(30_000);
        expect(saves(conn)).toHaveLength(1);
        expect(ring(one.container)).toMatch(/Unknown character/);
        expect(ring(two.container)).toMatch(/another tab/);
    });

    it('leaving with the other tab open: the save sent on the way out is not sent again (review M4)', async () => {
        fakeTimers();
        bridgeStorage();
        const { one, two, ring, pick } = await openTwoTabs();
        pick(one.container, 'Pela');
        await later(5_000);
        expect(saves(conn)).toEqual([]);
        // The row of the save sent on the way out is a moment late.
        conn.server.holdView = true;
        one.unmount();
        await later(2_000);
        expect(saves(conn)).toEqual([`0/1/Hyper/${T2}`]);
        await act(async () => {
            conn.server.holdView = false;
            conn.server.flushView();
        });
        await later(120_000);
        expect(saves(conn)).toHaveLength(1);
        await waitFor(() => expect(storedDrafts()).toBeNull());
        expect(conn.server.list()).toEqual([{ slot: 0, name: 'Hyper', code: T2, rev: 2 }]);
        expect(ring(two.container)).toMatch(/Auto saved/);
    });
});

describe('a tab that is really gone: taken over once, its waiting state inherited (review S1)', () => {
    const gone = (wait: Draft['wait']) =>
        draft({ name: 'Hyper', code: CLARA, baseRev: 1, tab: 't-gone', seen: Date.now(), wait });

    it('heartbeat: taken over 90 s after its last sign of life; one more try, then stopped (5 in all)', async () => {
        fakeTimers();
        putActive('0', 1);
        failEverySave();
        putDrafts({
            0: gone({
                reason: 'server-error',
                failures: 4,
                retryAt: Date.now() + 20_000,
                message: null,
            }),
        });
        await openMember(conn, [{ slot: 0, name: 'Hyper' }]);
        await later(60_000);
        expect(saves(conn)).toEqual([]);
        expect(ringText()).toMatch(/another tab/);
        await later(31_000);
        await waitFor(() => expect(saves(conn)).toHaveLength(1));
        expect(storedDrafts()?.['0']).toMatchObject({ tab: expect.not.stringMatching(/t-gone/) });
        for (let i = 0; i < 20; i++) await later(30_000);
        expect(saves(conn)).toHaveLength(1);
        expect(ringText()).toMatch(/after your next change/);
    });

    it('heartbeat: a tab that still beats keeps its draft, however old the draft', async () => {
        fakeTimers();
        putActive('0', 1);
        putDrafts({ 0: gone(null) });
        await openMember(conn, [{ slot: 0, name: 'Hyper' }]);
        for (let i = 0; i < 10; i++) {
            localStorage.setItem(PRESENCE_KEY, JSON.stringify({ 't-gone': Date.now() }));
            await later(30_000);
        }
        expect(saves(conn)).toEqual([]);
        expect(ringText()).toMatch(/another tab/);
    });

    it('Web Locks: taken over the moment its lock is free, not before; a parked draft stays parked', async () => {
        fakeTimers();
        const locks = installLocks();
        const releaseGone = locks.hold('hsrpvp.teambuilder.tab.t-gone');
        putActive('0', 1);
        putDrafts({
            0: gone({ reason: 'server-stopped', failures: 5, retryAt: null, message: null }),
        });
        await openMember(conn, [{ slot: 0, name: 'Hyper' }]);
        await later(10 * 60_000);
        expect(ringText()).toMatch(/another tab/);
        expect(storedDrafts()?.['0']?.tab).toBe('t-gone');
        await act(async () => releaseGone());
        await waitFor(() => expect(storedDrafts()?.['0']?.tab).not.toBe('t-gone'));
        await later(5 * 60_000);
        expect(saves(conn)).toEqual([]);
        expect(ringText()).toMatch(/after your next change/);
        // An edit frees it, as in the tab that had it.
        fireEvent.click(card('Pela'));
        await later(61_000);
        expect(saves(conn)).toHaveLength(1);
    });
});

describe('the ring never says saved over an unsent draft (review S2)', () => {
    it('another tab’s draft of the active loadout is released while this tab is offline: "Not saved yet", no connection', async () => {
        putActive('0', 1);
        await openMember(conn, [{ slot: 0, name: 'Hyper' }]);
        expect(ringText()).toMatch(/Saved to your account/);
        drop();
        putDrafts({ 0: draft({ name: 'Hyper', code: PELA, baseRev: 1, tab: null }) });
        act(() => {
            window.dispatchEvent(new StorageEvent('storage', { key: draftsKey(7) }));
        });
        await waitFor(() => expect(ringText()).toMatch(/^Not saved yet/));
        expect(ringText()).toMatch(/No connection/);
        expect(ringText()).not.toMatch(/Saved to your account|Auto saved/);
    });
});

describe('a rename or a note before the account list is here (review M5)', () => {
    it('is kept and written into the restored loadout once the list arrives', async () => {
        fakeTimers();
        conn.server.seed(0, 'Hyper');
        const rows = [...conn.db.viewMyLoadouts.rows];
        conn.db.viewMyLoadouts.rows = [];
        putActive('0', 1);
        renderWithConnection('/teambuilder', conn, MEMBER as never);
        await screen.findByRole('heading', { level: 1 });
        seedReference(conn, { id: 7 });
        const notLoadouts = async () =>
            act(async () => {
                for (const s of conn.live()) if (!/view_my_loadouts/.test(s.query)) s.apply();
            });
        await notLoadouts();
        await notLoadouts();
        fireEvent.change(nameField(), { target: { value: 'Early name' } });
        fireEvent.change(noteField(), { target: { value: 'early note' } });
        conn.db.viewMyLoadouts.seed(...rows);
        await act(async () => conn.applyAll());
        await waitFor(() => expect(nameField().value).toBe('Early name'));
        await later(61_000);
        expect(conn.reducers.saveLoadout.mock.calls.map(([a]) => a)).toEqual([
            { slot: 0, baseRev: 1, name: 'Early name', note: 'early note', code: ACHERON },
        ]);
    });
});

describe('storage that refuses one write (review M2)', () => {
    it('is tried again on the next change; a settled draft is not left in storage', async () => {
        fakeTimers();
        putActive('0', 1);
        await openMember(conn, [{ slot: 0, name: 'Hyper' }]);
        const proto = Object.getPrototypeOf(localStorage) as Storage;
        const set = proto.setItem;
        let refuse = true;
        vi.spyOn(proto, 'setItem').mockImplementation(function (this: Storage, k, v) {
            if (refuse && k === draftsKey(7)) {
                refuse = false;
                throw new DOMException('full', 'QuotaExceededError');
            }
            set.call(this, k, v);
        });
        fireEvent.click(card('Pela'));
        expect(refuse).toBe(false);
        fireEvent.click(card('Clara'));
        expect(storedDrafts()?.['0']).toMatchObject({
            code: '1.acheron-0.pela-6.clara-0._.as-c-0-3000-1500',
        });
        await later(61_000);
        expect(saves(conn)).toHaveLength(1);
        await waitFor(() => expect(storedDrafts()).toBeNull());
    });
});

describe('a delete states the version seen when its dialog opened (review M3)', () => {
    it('a newer copy arrives behind the open dialog: not deleted, the dialog says so and asks again', async () => {
        const user = userEvent.setup();
        await openMember(conn, [{ slot: 2, name: 'Hyper' }]);
        await user.click(caret());
        await user.click(screen.getByRole('menuitemradio', { name: /^Hyper,/ }));
        await user.click(caret());
        await user.click(screen.getByRole('menuitem', { name: 'Delete Hyper' }));
        // While the dialog is open, another device saves; its row arrives here.
        await act(async () => conn.server.elsewhere(2, 'Hyper', CLARA, 'from the phone'));
        await user.click(screen.getByRole('button', { name: 'Delete' }));
        await waitFor(() =>
            expect(screen.getByRole('dialog', { name: 'Delete Hyper?' })).toHaveTextContent(
                'This loadout was changed on another device. The newer copy is on the page now.',
            ),
        );
        expect(conn.reducers.deleteLoadout).not.toHaveBeenCalled();
        expect(conn.server.list()).toMatchObject([{ slot: 2, code: CLARA, rev: 2 }]);
        await user.click(screen.getByRole('button', { name: 'Delete' }));
        await waitFor(() => expect(conn.server.list()).toEqual([]));
        expect(conn.reducers.deleteLoadout.mock.calls[0]?.[0]).toEqual({ slot: 2, baseRev: 2 });
    });
});

// ── A stand-in for `navigator.locks` (exclusive locks, queued in order, abortable while waiting).

type Waiter = { grant: () => void; abort: () => void };

function installLocks() {
    const held = new Set<string>();
    const queues = new Map<string, Waiter[]>();
    const free = (name: string) => {
        held.delete(name);
        const next = queues.get(name)?.shift();
        if (next) next.grant();
    };
    const request = (
        name: string,
        a: { signal?: AbortSignal } | (() => unknown),
        b?: () => unknown,
    ): Promise<unknown> => {
        const cb = (typeof a === 'function' ? a : b) as () => unknown;
        const signal = typeof a === 'function' ? undefined : a.signal;
        return new Promise((resolve, reject) => {
            const w: Waiter = {
                grant: () => {
                    held.add(name);
                    Promise.resolve()
                        .then(cb)
                        .then(
                            (v) => {
                                free(name);
                                resolve(v);
                            },
                            (e) => {
                                free(name);
                                reject(e);
                            },
                        );
                },
                abort: () => reject(new DOMException('aborted', 'AbortError')),
            };
            signal?.addEventListener('abort', () => {
                const q = queues.get(name) ?? [];
                if (q.includes(w)) {
                    queues.set(
                        name,
                        q.filter((x) => x !== w),
                    );
                    w.abort();
                }
            });
            if (!held.has(name)) w.grant();
            else queues.set(name, [...(queues.get(name) ?? []), w]);
        });
    };
    Object.defineProperty(navigator, 'locks', { value: { request }, configurable: true });
    return {
        /** A lock held by a tab outside the test (its tab "closes" when the returned function runs). */
        hold(name: string): () => void {
            let release: () => void = () => {};
            void request(name, () => new Promise<void>((r) => (release = r)));
            return () => release();
        },
    };
}
