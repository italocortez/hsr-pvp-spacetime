import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INTRO_KEY } from '@/components/PageIntro/PageIntro';
import { setConnectionStatus } from '@/stdb/connectionStatus';
import { ACTIVE_KEY, BROWSER_KEY, DRAFTS_PREFIX, draftsKey } from './loadoutStorage';
import {
    ACHERON,
    type Conn,
    draft,
    drop,
    GUEST,
    installDialog,
    makeConn,
    openMember,
    openVisitor,
    putActive,
    putDrafts,
    reconnect,
    removeDialog,
} from './loadoutTestKit';
import { DRAFT_KEY, PREVIOUS_KEY } from './teamStorage';
import { LOADOUTS_QUERY } from './useLoadouts';

/*
 * T-S14.3c: saved loadouts on the team builder, through the real router and shell with the mock connection.
 * Browser loadouts for a visitor or guest (create, rename, Untitled, duplicate, delete with the dialog, the limit
 * of 5, a reload keeps them, the menu by keyboard, the sign-in hint), account loadouts for a verified member (the
 * view, autosave after the wait, the ring's states, a refused save keeps the draft and retries, slot taken,
 * sign-out drops the subscription), "Copy to my account" and its limit, the share link, the note counter, and
 * storage that refuses every access. S14.3c-sync: the loadout reducers are the server double of `loadoutTestKit.ts`
 * (versions, refusals, the limit), so the calls carry `baseRev` and saves reach the view as the server's would.
 */

let conn: Conn;

function clearStorage() {
    try {
        for (const k of [INTRO_KEY, DRAFT_KEY, PREVIOUS_KEY, BROWSER_KEY, ACTIVE_KEY, draftsKey(7)])
            localStorage.removeItem(k);
    } catch {}
}

beforeEach(() => {
    conn = makeConn();
    clearStorage();
    setConnectionStatus({ state: 'connected' });
    installDialog();
});
afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    removeDialog();
});

/** Fake time for the autosave waits; real time still runs, so Testing Library's waits work. */
const fakeTimers = () =>
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout', 'Date'] });

type RowSeed = { slot: number; name: string; code?: string; note?: string };

async function open(
    path = '/teambuilder',
    who: 'visitor' | 'member' | 'guest' = 'visitor',
    rows: RowSeed[] = [],
) {
    if (who === 'member') return openMember(conn, rows, path);
    return openVisitor(conn, path, who === 'guest' ? GUEST : undefined);
}

const card = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name},`) });
const nameField = () =>
    screen.getByRole('textbox', { name: 'Rename active loadout' }) as HTMLInputElement;
const caret = () => screen.getByRole('button', { name: 'Switch loadout' });
const slotNames = () =>
    [...document.querySelectorAll('[data-slot]')].map(
        (li) => li.querySelector('h3')?.textContent ?? null,
    );
const stored = () =>
    JSON.parse(localStorage.getItem(BROWSER_KEY) ?? 'null') as {
        loadouts: { name: string; note: string; code: string }[];
    } | null;
const row = (slot: number, name: string, code = ACHERON, note = ''): RowSeed => ({
    slot,
    name,
    note,
    code,
});

describe('browser loadouts (visitor)', () => {
    it('the first edit makes a loadout in this browser; a reload keeps it', async () => {
        const user = userEvent.setup();
        const first = await open();
        expect(screen.getByText(/Your first change saves it as a loadout/)).toBeInTheDocument();
        expect(nameField().value).toBe('New Loadout');
        await user.click(card('Acheron'));
        expect(stored()?.loadouts).toEqual([
            { key: expect.any(String), name: 'New Loadout', note: '', code: ACHERON },
        ]);
        expect(screen.getByText('Saved in this browser')).toBeInTheDocument();
        first.unmount();
        conn = makeConn();
        await open();
        expect(slotNames()).toEqual(['Acheron', null, null, null]);
        expect(nameField().value).toBe('New Loadout');
        expect(screen.getByText('Saved in this browser')).toBeInTheDocument();
    });

    it('rename; a blank name becomes Untitled on blur', async () => {
        const user = userEvent.setup();
        await open();
        await user.click(card('Acheron'));
        await user.clear(nameField());
        await user.type(nameField(), '  Acheron Hyper ');
        await user.tab();
        expect(nameField().value).toBe('Acheron Hyper');
        expect(stored()?.loadouts[0]?.name).toBe('Acheron Hyper');
        await user.clear(nameField());
        await user.tab();
        expect(nameField().value).toBe('Untitled');
        expect(stored()?.loadouts[0]?.name).toBe('Untitled');
        expect(nameField()).toHaveAttribute('maxlength', '40');
    });

    it('New Loadout starts empty and selects its name; the menu switches back with the team', async () => {
        const user = userEvent.setup();
        await open();
        await user.click(card('Acheron'));
        await user.click(screen.getByRole('button', { name: 'New Loadout' }));
        expect(slotNames()).toEqual([null, null, null, null]);
        await waitFor(() => expect(nameField()).toHaveFocus());
        await user.keyboard('Clara team');
        await user.keyboard('{Enter}');
        await user.click(card('Clara'));
        expect(stored()?.loadouts.map((l) => l.name)).toEqual(['New Loadout', 'Clara team']);
        await user.click(caret());
        await user.click(screen.getByRole('menuitemradio', { name: /New Loadout/ }));
        expect(slotNames()).toEqual(['Acheron', null, null, null]);
        expect(nameField().value).toBe('New Loadout');
        expect(caret()).toHaveFocus();
    });

    it('Duplicate makes "<name> Copy" right after it, active', async () => {
        const user = userEvent.setup();
        await open();
        await user.click(card('Pela'));
        await user.click(caret());
        await user.click(screen.getByRole('menuitem', { name: 'Duplicate New Loadout' }));
        expect(stored()?.loadouts.map((l) => l.name)).toEqual(['New Loadout', 'New Loadout Copy']);
        expect(nameField().value).toBe('New Loadout Copy');
        expect(slotNames()).toEqual(['Pela', null, null, null]);
    });

    it('Delete asks first: Cancel (and Escape) keep it, Delete removes it; focus returns to the caret', async () => {
        const user = userEvent.setup();
        await open();
        await user.click(card('Pela'));
        await user.click(caret());
        await user.click(screen.getByRole('menuitem', { name: 'Delete New Loadout' }));
        const dialog = screen.getByRole('dialog', { name: 'Delete New Loadout?' });
        expect(within(dialog).getByText(/removed from this browser/)).toBeInTheDocument();
        expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
        await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
        expect(stored()?.loadouts).toHaveLength(1);
        expect(caret()).toHaveFocus();
        await user.click(caret());
        await user.click(screen.getByRole('menuitem', { name: 'Delete New Loadout' }));
        await user.click(screen.getByRole('button', { name: 'Delete' }));
        await waitFor(() => expect(stored()?.loadouts).toEqual([]));
        expect(caret()).toHaveFocus();
        // The team stays on the page as the working loadout.
        expect(slotNames()).toEqual(['Pela', null, null, null]);
    });

    it('five at most: the sixth is refused with a line', async () => {
        const user = userEvent.setup();
        await open();
        await user.click(card('Pela'));
        for (let i = 0; i < 4; i++)
            await user.click(screen.getByRole('button', { name: 'New Loadout' }));
        expect(stored()?.loadouts).toHaveLength(5);
        await user.click(screen.getByRole('button', { name: 'New Loadout' }));
        expect(stored()?.loadouts).toHaveLength(5);
        expect(
            screen.getByText('This browser already holds 5 loadouts. Delete one first.', {
                selector: 'p:not([role])',
            }),
        ).toBeInTheDocument();
    });

    it('the menu by keyboard: Enter enters at the active one, arrows, Home, End, type-ahead, Escape back', async () => {
        const user = userEvent.setup();
        await open();
        await user.click(card('Pela'));
        await user.clear(nameField());
        await user.type(nameField(), 'Bravo');
        await user.click(screen.getByRole('button', { name: 'New Loadout' }));
        await user.keyboard('Alpha{Enter}');
        caret().focus();
        await user.keyboard('{Enter}');
        expect(caret()).toHaveAttribute('aria-expanded', 'true');
        expect(screen.getByRole('menuitemradio', { name: /Alpha/ })).toHaveFocus();
        await user.keyboard('{Home}');
        expect(screen.getByRole('menuitemradio', { name: /Bravo/ })).toHaveFocus();
        await user.keyboard('{ArrowDown}');
        expect(screen.getByRole('menuitem', { name: 'Duplicate Bravo' })).toHaveFocus();
        await user.keyboard('{End}');
        expect(screen.getByRole('menuitem', { name: 'Delete Alpha' })).toHaveFocus();
        await user.keyboard('b');
        expect(screen.getByRole('menuitemradio', { name: /Bravo/ })).toHaveFocus();
        await user.keyboard('{Escape}');
        expect(caret()).toHaveFocus();
        expect(caret()).toHaveAttribute('aria-expanded', 'false');
        expect(screen.queryByRole('menuitemradio')).toBeNull();
    });

    it('a visitor and a guest see the sign-in line; the menu has one list', async () => {
        const user = userEvent.setup();
        const r = await open();
        const link = screen.getByRole('link', { name: 'Sign in with Discord' });
        expect(link.getAttribute('href')).toMatch(/login=1/);
        expect(screen.getByText(/keep up to 10 loadouts on your account/)).toBeInTheDocument();
        await user.click(caret());
        expect(screen.getByText('Saved loadouts')).toBeInTheDocument();
        expect(screen.queryByText('On your account')).toBeNull();
        r.unmount();
        conn = makeConn();
        await open('/teambuilder', 'guest');
        expect(screen.getByRole('link', { name: 'Sign in with Discord' })).toBeInTheDocument();
        expect(conn.liveQueries()).not.toContain(LOADOUTS_QUERY);
    });

    it('the note: a counter, a cap of 1,000, kept with the loadout', async () => {
        const user = userEvent.setup();
        await open();
        const note = screen.getByRole('textbox', { name: 'Note' });
        expect(note).toHaveAttribute('maxlength', '1000');
        expect(note).toHaveAccessibleDescription('0 / 1,000 characters');
        await user.type(note, 'Pela first.');
        expect(screen.getByText(/^11 \/ 1,000/)).toBeInTheDocument();
        expect(stored()?.loadouts[0]?.note).toBe('Pela first.');
        fireEvent.change(note, { target: { value: 'n'.repeat(1000) } });
        expect(screen.getByText(/^1,000 \/ 1,000/)).toBeInTheDocument();
    });

    it('a shared link opens as its own unsaved loadout; Restore goes back to the saved one', async () => {
        const user = userEvent.setup();
        const first = await open();
        await user.click(card('Acheron'));
        first.unmount();
        conn = makeConn();
        await open('/teambuilder?team=1.pela-6._._._.as-c-0-3000-1500');
        expect(nameField().value).toBe('Shared team');
        expect(slotNames()).toEqual(['Pela', null, null, null]);
        expect(stored()?.loadouts.map((l) => l.code)).toEqual([ACHERON]);
        await user.click(screen.getByRole('button', { name: 'Restore my previous team' }));
        expect(nameField().value).toBe('New Loadout');
        expect(slotNames()).toEqual(['Acheron', null, null, null]);
    });

    it('a shared link, then an edit: it becomes a second loadout and the first is untouched', async () => {
        const user = userEvent.setup();
        const first = await open();
        await user.click(card('Acheron'));
        first.unmount();
        conn = makeConn();
        await open('/teambuilder?team=1.pela-6._._._.as-c-0-3000-1500');
        await user.click(card('Clara'));
        expect(stored()?.loadouts.map((l) => l.name)).toEqual(['New Loadout', 'Shared team']);
        expect(stored()?.loadouts[0]?.code).toBe(ACHERON);
    });
});

describe('the share link', () => {
    it('Copy link writes the page address with the team; the confirmation is a status', async () => {
        const user = userEvent.setup();
        await open();
        await user.click(card('Acheron'));
        const write = vi.fn(async (_t: string) => {});
        Object.defineProperty(navigator, 'clipboard', {
            value: { writeText: write },
            configurable: true,
        });
        await user.click(screen.getByRole('button', { name: 'Copy link' }));
        expect(write).toHaveBeenCalledWith(`${window.location.origin}/teambuilder?team=${ACHERON}`);
        await waitFor(() =>
            expect(screen.getByText('Link copied.')).toHaveAttribute('role', 'status'),
        );
    });

    it('no clipboard: the link is shown in a field, focused and selected', async () => {
        const user = userEvent.setup();
        await open();
        await user.click(card('Acheron'));
        Object.defineProperty(navigator, 'clipboard', {
            value: { writeText: () => Promise.reject(new Error('denied')) },
            configurable: true,
        });
        await user.click(screen.getByRole('button', { name: 'Copy link' }));
        const field = (await screen.findByRole('textbox', {
            name: 'Link to this team',
        })) as HTMLInputElement;
        expect(field.value).toBe(`${window.location.origin}/teambuilder?team=${ACHERON}`);
        await waitFor(() => expect(field).toHaveFocus());
        expect(screen.getByText(/could not be copied/)).toBeInTheDocument();
    });
});

describe('storage unavailable', () => {
    it('every access throws: the page still builds and keeps loadouts for the visit', async () => {
        const user = userEvent.setup();
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
            throw new DOMException('blocked', 'SecurityError');
        });
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new DOMException('blocked', 'SecurityError');
        });
        vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
            throw new DOMException('blocked', 'SecurityError');
        });
        await open();
        expect(screen.getByText(/Browser storage is off/)).toBeInTheDocument();
        await user.click(card('Acheron'));
        expect(screen.getByText(/kept for this visit only/)).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'New Loadout' }));
        await user.click(caret());
        expect(screen.getAllByRole('menuitemradio')).toHaveLength(2);
    });
});

describe('account loadouts (verified member)', () => {
    it('subscribes view_my_loadouts on this route only while verified, and lists it', async () => {
        const user = userEvent.setup();
        const r = await open('/teambuilder', 'member', [
            row(0, 'Hyper'),
            row(3, 'Clara', '1.clara-0._._._.as-c-0-3000-1500'),
        ]);
        expect(conn.liveQueries()).toContain(LOADOUTS_QUERY);
        await user.click(caret());
        const group = screen.getByRole('group', { name: /On your account/ });
        expect(
            within(group)
                .getAllByRole('menuitemradio')
                .map((b) => b.getAttribute('data-name')),
        ).toEqual(['Hyper', 'Clara']);
        expect(within(group).getByRole('menuitemradio', { name: /Clara/ })).toHaveAccessibleName(
            /^Clara.*1 of 4 slots$/,
        );
        await user.click(within(group).getByRole('menuitemradio', { name: /Clara/ }));
        expect(slotNames()).toEqual(['Clara', null, null, null]);
        expect(screen.getByText('Saved to your account')).toBeInTheDocument();
        r.unmount();
        expect(conn.liveQueries()).not.toContain(LOADOUTS_QUERY);
    });

    it('sign-out drops the subscription and shows the browser list again', async () => {
        await open('/teambuilder', 'member', [row(0, 'Hyper')]);
        expect(conn.liveQueries()).toContain(LOADOUTS_QUERY);
        await act(async () => conn.db.viewMyProfile.delete(conn.db.viewMyProfile.rows[0] as never));
        await waitFor(() => expect(conn.liveQueries()).not.toContain(LOADOUTS_QUERY));
        expect(screen.getByRole('link', { name: 'Sign in with Discord' })).toBeInTheDocument();
    });

    it('autosave: an edit waits 60 s (the ring), then saves; "Auto saved"; the draft goes when the row matches', async () => {
        fakeTimers();
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        await open('/teambuilder', 'member');
        await user.click(card('Acheron'));
        expect(screen.getByText('Saving soon')).toBeInTheDocument();
        const drafts = JSON.parse(localStorage.getItem(draftsKey(7)) ?? '{}');
        expect(drafts['0']).toMatchObject({ name: 'New Loadout', code: ACHERON });
        expect(conn.reducers.saveLoadout).not.toHaveBeenCalled();
        // Each edit restarts the wait.
        await act(async () => vi.advanceTimersByTime(40_000));
        await user.click(card('Pela'));
        await act(async () => vi.advanceTimersByTime(40_000));
        expect(conn.reducers.saveLoadout).not.toHaveBeenCalled();
        await act(async () => vi.advanceTimersByTime(21_000));
        const code = '1.acheron-0.pela-6._._.as-c-0-3000-1500';
        expect(conn.reducers.saveLoadout).toHaveBeenCalledTimes(1);
        expect(conn.reducers.saveLoadout).toHaveBeenCalledWith({
            slot: 0,
            baseRev: 0,
            name: 'New Loadout',
            note: '',
            code,
        });
        await waitFor(() => expect(screen.getByText('Auto saved')).toBeInTheDocument());
        // The row arrived with the server's version; the draft goes once it holds it.
        expect(conn.server.list()).toEqual([{ slot: 0, name: 'New Loadout', code, rev: 1 }]);
        await waitFor(() => expect(localStorage.getItem(draftsKey(7))).toBeNull());
        // The next edit is based on that version.
        await user.click(card('Clara'));
        await act(async () => vi.advanceTimersByTime(61_000));
        expect(conn.reducers.saveLoadout.mock.calls[1]?.[0]).toMatchObject({ slot: 0, baseRev: 1 });
    });

    it('the ceiling: 5 minutes of edits save anyway', async () => {
        fakeTimers();
        await open('/teambuilder', 'member');
        const names = ['Acheron', 'Pela', 'Clara'];
        for (let i = 0; i < 7; i++) {
            fireEvent.click(card(names[i % 3] as string));
            await act(async () => vi.advanceTimersByTime(45_000));
        }
        expect(conn.reducers.saveLoadout).toHaveBeenCalledTimes(1);
    });

    it('a too-fast refusal: "Not saved yet" with the server text, the draft stays, retried later', async () => {
        fakeTimers();
        const TOO_FAST =
            'Your loadout was not saved yet: too many saves in a short time. It will be saved in a moment.';
        conn.reducers.saveLoadout.mockRejectedValueOnce(new Error(TOO_FAST));
        await open('/teambuilder', 'member');
        fireEvent.click(card('Acheron'));
        await act(async () => vi.advanceTimersByTime(60_000));
        await waitFor(() => expect(screen.getByText('Not saved yet')).toBeInTheDocument());
        expect(screen.getByText(TOO_FAST)).toBeInTheDocument();
        expect(nameField()).toHaveAccessibleDescription(expect.stringContaining('Not saved yet'));
        expect(localStorage.getItem(draftsKey(7))).not.toBeNull();
        await act(async () => vi.advanceTimersByTime(10_000));
        expect(conn.reducers.saveLoadout).toHaveBeenCalledTimes(2);
        await waitFor(() => expect(screen.getByText('Auto saved')).toBeInTheDocument());
    });

    it('slot taken (another device): saved again in the next free slot', async () => {
        fakeTimers();
        conn.reducers.saveLoadout.mockImplementationOnce(async (a) => {
            // Another device's new loadout reaches the server first.
            conn.server.elsewhere(0, 'Elsewhere');
            conn.server.save(a);
        });
        await open('/teambuilder', 'member');
        fireEvent.click(card('Pela'));
        await act(async () => vi.advanceTimersByTime(60_000));
        await waitFor(() => expect(conn.reducers.saveLoadout).toHaveBeenCalledTimes(2));
        expect(conn.reducers.saveLoadout.mock.calls[1]?.[0]).toMatchObject({
            slot: 1,
            baseRev: 0,
        });
        expect(conn.server.list().map((r) => r.name)).toEqual(['Elsewhere', 'New Loadout']);
    });

    it('offline: the ring says so, edits go on; back online (rows replayed) the draft is sent', async () => {
        fakeTimers();
        putActive('0', 1);
        await open('/teambuilder', 'member', [row(0, 'Hyper')]);
        drop();
        fireEvent.click(card('Pela'));
        await act(async () => vi.advanceTimersByTime(61_000));
        expect(screen.getByText('Not saved yet')).toBeInTheDocument();
        expect(screen.getByText(/No connection/, { selector: 'span' })).toBeInTheDocument();
        expect(conn.reducers.saveLoadout).not.toHaveBeenCalled();
        await reconnect(conn);
        await waitFor(() => expect(conn.reducers.saveLoadout).toHaveBeenCalledTimes(1));
    });

    it('on load, a draft left from last time (on the current version) is applied and sent', async () => {
        putDrafts({ 0: draft({ name: 'Hyper', note: 'kept', code: ACHERON, baseRev: 1 }) });
        putActive('0', 1);
        await open('/teambuilder', 'member', [row(0, 'Hyper')]);
        await waitFor(() => expect(conn.reducers.saveLoadout).toHaveBeenCalledTimes(1));
        expect(conn.reducers.saveLoadout.mock.calls[0]?.[0]).toMatchObject({
            slot: 0,
            baseRev: 1,
            note: 'kept',
        });
        expect(screen.getByRole('textbox', { name: 'Note' })).toHaveValue('kept');
    });

    it('Delete on the account asks first and calls delete_loadout on the version shown', async () => {
        const user = userEvent.setup();
        await open('/teambuilder', 'member', [row(2, 'Hyper')]);
        await user.click(caret());
        await user.click(screen.getByRole('menuitem', { name: 'Delete Hyper' }));
        expect(screen.getByText(/removed from your account, on every device/)).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Delete' }));
        await waitFor(() =>
            expect(conn.reducers.deleteLoadout).toHaveBeenCalledWith({ slot: 2, baseRev: 1 }),
        );
        await waitFor(() => expect(conn.server.list()).toEqual([]));
    });

    it('the ring: "Saving…" while the save flies (announced only when it lands), then "Auto saved"', async () => {
        fakeTimers();
        let land: () => void = () => {};
        conn.reducers.saveLoadout.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    land = resolve;
                }),
        );
        await open('/teambuilder', 'member', [row(0, 'Hyper')]);
        fireEvent.click(card('Pela'));
        // The account list has one loadout; the first edit of the working loadout makes slot 1.
        await act(async () => vi.advanceTimersByTime(60_000));
        expect(screen.getByText('Saving…')).toBeInTheDocument();
        expect(conn.reducers.saveLoadout.mock.calls[0]?.[0]).toMatchObject({
            slot: 1,
            baseRev: 0,
        });
        await act(async () => land());
        await waitFor(() => expect(screen.getByText('Auto saved')).toBeInTheDocument());
        await waitFor(() =>
            expect(
                screen.getByText('Auto saved.', { selector: '[role="status"]' }),
            ).toBeInTheDocument(),
        );
    });

    it('a switch saves the loadout being left at once (no wait)', async () => {
        const user = userEvent.setup();
        await open('/teambuilder', 'member', [
            row(0, 'Hyper'),
            row(1, 'Other', '1.clara-0._._._.as-c-0-3000-1500'),
        ]);
        await user.click(caret());
        await user.click(screen.getByRole('menuitemradio', { name: /Hyper/ }));
        await user.click(card('Pela'));
        expect(conn.reducers.saveLoadout).not.toHaveBeenCalled();
        await user.click(caret());
        await user.click(screen.getByRole('menuitemradio', { name: /Other/ }));
        await waitFor(() =>
            expect(conn.reducers.saveLoadout).toHaveBeenCalledWith(
                expect.objectContaining({
                    slot: 0,
                    baseRev: 1,
                    code: '1.acheron-0.pela-6._._.as-c-0-3000-1500',
                }),
            ),
        );
        expect(slotNames()).toEqual(['Clara', null, null, null]);
    });
});

describe('two tabs', () => {
    it('another tab adds a browser loadout: this tab lists it without dropping its own', async () => {
        const user = userEvent.setup();
        await open();
        await user.click(card('Acheron'));
        const mine = stored()?.loadouts ?? [];
        const theirs = { key: 'b-other', name: 'From the other tab', note: '', code: ACHERON };
        localStorage.setItem(BROWSER_KEY, JSON.stringify({ v: 1, loadouts: [...mine, theirs] }));
        act(() => {
            window.dispatchEvent(new StorageEvent('storage', { key: BROWSER_KEY }));
        });
        await user.click(caret());
        expect(
            screen.getByRole('menuitemradio', { name: /From the other tab/ }),
        ).toBeInTheDocument();
        await user.keyboard('{Escape}');
        await user.click(card('Pela'));
        expect(stored()?.loadouts.map((l) => l.name)).toEqual([
            'New Loadout',
            'From the other tab',
        ]);
    });
});

describe('Copy to my account', () => {
    it('a browser loadout is copied into the lowest free slot at once; the browser copy stays', async () => {
        const user = userEvent.setup();
        // A browser loadout from before sign-in.
        localStorage.setItem(
            BROWSER_KEY,
            JSON.stringify({
                v: 1,
                loadouts: [{ key: 'b-1', name: 'Local', note: '', code: ACHERON }],
            }),
        );
        await open('/teambuilder', 'member', [row(0, 'Hyper')]);
        await user.click(caret());
        expect(screen.getByRole('group', { name: /In this browser/ })).toBeInTheDocument();
        await user.click(screen.getByRole('menuitem', { name: 'Copy Local to my account' }));
        await waitFor(() =>
            expect(conn.reducers.saveLoadout).toHaveBeenCalledWith({
                slot: 1,
                baseRev: 0,
                name: 'Local',
                note: '',
                code: ACHERON,
            }),
        );
        expect(stored()?.loadouts).toHaveLength(1);
    });

    it('refused clearly when the account holds 10', async () => {
        const user = userEvent.setup();
        localStorage.setItem(
            BROWSER_KEY,
            JSON.stringify({
                v: 1,
                loadouts: [{ key: 'b-1', name: 'Local', note: '', code: ACHERON }],
            }),
        );
        await open(
            '/teambuilder',
            'member',
            Array.from({ length: 10 }, (_, i) => row(i, `L${i}`)),
        );
        await user.click(caret());
        await user.click(screen.getByRole('menuitem', { name: 'Copy Local to my account' }));
        expect(
            screen.getByText('Your account already holds 10 loadouts. Delete one first.', {
                selector: 'p:not([role])',
            }),
        ).toBeInTheDocument();
        expect(conn.reducers.saveLoadout).not.toHaveBeenCalled();
    });
});

// The drafts key is per account.
it('drafts are kept per account', () => {
    expect(draftsKey(7)).toBe(`${DRAFTS_PREFIX}7`);
});
