import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InternalError, UnknownCallResultError } from 'spacetimedb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAuthSnapshot } from '@/auth/authStore';
import { INTRO_KEY } from '@/components/PageIntro/PageIntro';
import { setConnectionStatus } from '@/stdb/connectionStatus';
import { profileRow } from '@/test/mockConnection';
import { renderWithConnection } from '@/test/renderWithConnection';
import { ACTIVE_KEY, BROWSER_KEY, draftsKey } from './loadoutStorage';
import {
    ACHERON,
    browserList,
    CLARA,
    type Conn,
    card,
    caret,
    choice,
    deletedChoice,
    draft,
    drop,
    EMPTY,
    fakeTimers,
    installDialog,
    later,
    MEMBER,
    makeConn,
    nameField,
    noteField,
    openMember,
    openVisitor,
    PELA,
    putActive,
    putDrafts,
    reconnect,
    reload,
    removeDialog,
    ringText,
    said,
    saves,
    seedReference,
    slotNames,
    storedDrafts,
} from './loadoutTestKit';
import { DRAFT_KEY, PREVIOUS_KEY } from './teamStorage';

/*
 * T-S14.3c-sync: the account sync on versions (DECISIONS.md A198), through the real page and the mock connection,
 * with the server double of `loadoutTestKit.ts` (versions, refusals, the save limit). "Another device" is a save or
 * delete made straight on the double, which the view then brings as the server would; `holdView` keeps the view's
 * change back (a dropped connection, a slow view) until a replay delivers it.
 */

let conn: Conn;

beforeEach(() => {
    conn = makeConn();
    const keys = [INTRO_KEY, DRAFT_KEY, PREVIOUS_KEY, BROWSER_KEY, ACTIVE_KEY];
    for (const k of [...keys, draftsKey(7), draftsKey(8)]) localStorage.removeItem(k);
    setConnectionStatus({ state: 'connected' });
    installDialog();
});
afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    removeDialog();
});

const T2 = '1.acheron-0.pela-6._._.as-c-0-3000-1500';
const T3 = '1.acheron-0.pela-6.clara-0._.as-c-0-3000-1500';
const names = () => conn.server.list().map((r) => r.name);

/** The menu's account group lists these names. */
async function accountMenu() {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(caret());
    const group = screen.getByRole('group', { name: /On your account/ });
    const list = within(group)
        .getAllByRole('menuitemradio')
        .map((b) => b.getAttribute('data-name'));
    await user.keyboard('{Escape}');
    return list;
}

/** A draft another tab owns (`tab`), touched just now. */
const live = (over: Parameters<typeof draft>[0], tab: string | null) =>
    draft({ ...over, tab, seen: Date.now() });

/** Another tab of this browser wrote the drafts (the `storage` event it causes here). */
function otherTabWrites(drafts: Record<string, ReturnType<typeof draft>>) {
    putDrafts(drafts);
    act(() => {
        window.dispatchEvent(new StorageEvent('storage', { key: draftsKey(7) }));
    });
}

describe('new loadouts on several devices at once (review B1): never written over each other', () => {
    it('the other device’s row lands before this page sends: moved at once, both exist', async () => {
        fakeTimers();
        await openMember(conn);
        fireEvent.click(card('Clara'));
        expect(storedDrafts()?.['0']).toMatchObject({ code: CLARA, baseRev: 0 });
        await act(async () => conn.server.elsewhere(0, 'Made on the phone'));
        expect(storedDrafts()?.['1']).toMatchObject({ code: CLARA, baseRev: 0 });
        expect(storedDrafts()?.['0']).toBeUndefined();
        await later(61_000);
        expect(saves(conn)).toEqual([`1/0/New Loadout/${CLARA}`]);
        expect(names()).toEqual(['Made on the phone', 'New Loadout']);
        expect(await accountMenu()).toEqual(['Made on the phone', 'New Loadout']);
    });

    it('both send at once and the other lands first: refused "slot already in use", moved, created', async () => {
        fakeTimers();
        conn.reducers.saveLoadout.mockImplementationOnce(async (a) => {
            conn.server.elsewhere(0, 'Made on the phone');
            conn.server.save(a);
        });
        await openMember(conn);
        fireEvent.click(card('Clara'));
        await later(61_000);
        await waitFor(() => expect(saves(conn)).toHaveLength(2));
        expect(saves(conn)).toEqual([`0/0/New Loadout/${CLARA}`, `1/0/New Loadout/${CLARA}`]);
        expect(names()).toEqual(['Made on the phone', 'New Loadout']);
    });

    it('this page lands first; the other device’s then arrives in the next slot: both exist', async () => {
        fakeTimers();
        await openMember(conn);
        fireEvent.click(card('Clara'));
        await later(61_000);
        await act(async () => conn.server.elsewhere(1, 'Made on the phone'));
        await later(120_000);
        expect(saves(conn)).toHaveLength(1);
        expect(names()).toEqual(['New Loadout', 'Made on the phone']);
        await waitFor(() => expect(storedDrafts()).toBeNull());
    });

    it('three devices: B then C arrive before this page sends: one call, slot 2', async () => {
        fakeTimers();
        await openMember(conn);
        fireEvent.click(card('Clara'));
        await act(async () => conn.server.elsewhere(0, 'B'));
        await act(async () => conn.server.elsewhere(1, 'C', PELA));
        await later(62_000);
        expect(saves(conn)).toEqual([`2/0/New Loadout/${CLARA}`]);
        expect(names()).toEqual(['B', 'C', 'New Loadout']);
    });

    it('three devices: C (slot 1) then B (slot 0)', async () => {
        fakeTimers();
        await openMember(conn);
        fireEvent.click(card('Clara'));
        await act(async () => conn.server.elsewhere(1, 'C', PELA));
        await act(async () => conn.server.elsewhere(0, 'B'));
        await later(62_000);
        expect(saves(conn)).toEqual([`2/0/New Loadout/${CLARA}`]);
        expect(names()).toEqual(['B', 'C', 'New Loadout']);
    });

    it('three devices: both land while this page’s saves fly', async () => {
        fakeTimers();
        conn.reducers.saveLoadout
            .mockImplementationOnce(async (a) => {
                conn.server.elsewhere(0, 'B');
                conn.server.save(a);
            })
            .mockImplementationOnce(async (a) => {
                conn.server.elsewhere(1, 'C', PELA);
                conn.server.save(a);
            });
        await openMember(conn);
        fireEvent.click(card('Clara'));
        await later(61_000);
        await later(5_000);
        expect(saves(conn).map((s) => s.slice(0, 4))).toEqual(['0/0/', '1/0/', '2/0/']);
        expect(names()).toEqual(['B', 'C', 'New Loadout']);
    });

    it('on load: a draft never saved meets another loadout in its slot: moved, created', async () => {
        putDrafts({ 0: draft({ name: 'Mine, made offline', code: CLARA, baseRev: 0 }) });
        await openMember(conn, [{ slot: 0, name: 'Made on the phone', note: 'phone note' }]);
        await waitFor(() => expect(saves(conn)).toHaveLength(1));
        expect(conn.reducers.saveLoadout.mock.calls[0]?.[0]).toEqual({
            slot: 1,
            baseRev: 0,
            name: 'Mine, made offline',
            note: '',
            code: CLARA,
        });
        expect(names()).toEqual(['Made on the phone', 'Mine, made offline']);
    });

    it('no free slot: kept unsent with the account-full line; created when a slot frees elsewhere', async () => {
        fakeTimers();
        putDrafts({ 3: draft({ name: 'Mine', code: CLARA, baseRev: 0 }) });
        putActive('3');
        await openMember(
            conn,
            Array.from({ length: 10 }, (_, i) => ({ slot: i, name: `L${i}` })),
        );
        await later(120_000);
        expect(saves(conn)).toEqual([]);
        expect(nameField().value).toBe('Mine');
        expect(screen.getByText('Not saved yet')).toBeInTheDocument();
        expect(
            screen.getByText(
                'Your account already holds 10 loadouts. Delete one to save this one.',
            ),
        ).toBeInTheDocument();
        await act(async () => conn.server.deleteElsewhere(5));
        await waitFor(() => expect(saves(conn)).toHaveLength(1));
        expect(conn.reducers.saveLoadout.mock.calls[0]?.[0]).toMatchObject({
            slot: 5,
            baseRev: 0,
            name: 'Mine',
        });
    });

    it('another tab’s unsent new loadout: this tab takes a different slot', async () => {
        await openMember(conn);
        putDrafts({ 0: live({ name: 'Other tab', code: ACHERON, baseRev: 0 }, 't-x') });
        fireEvent.click(card('Clara'));
        expect(storedDrafts()).toMatchObject({
            0: { name: 'Other tab', code: ACHERON },
            1: { name: 'New Loadout', code: CLARA },
        });
    });
});

describe('a stale draft (A198): the database refuses it; the person chooses', () => {
    const stale = (slot: number, name: string) => ({
        [slot]: draft({ name, code: CLARA, baseRev: 1 }),
    });

    /** Slot `slot` at version 2 (the phone saved it after this browser's draft was made on version 1). */
    async function openStale(
        slot: number,
        name: string,
        extra: { slot: number; name: string }[] = [],
    ) {
        conn.server.seed(slot, name);
        conn.server.elsewhere(slot, name, PELA, 'newer, from the phone');
        putDrafts(stale(slot, name));
        return openMember(conn, extra);
    }

    it('on load, the active loadout: nothing is sent; the choice shows both copies and what differs (N5)', async () => {
        fakeTimers();
        putActive('0', 1);
        await openStale(0, 'Hyper');
        await later(600_000);
        expect(saves(conn)).toEqual([]);
        const group = screen.getByRole('dialog', {
            name: 'Hyper was also changed on another device.',
        });
        expect(
            within(group).getByText(/^In this browser: Hyper, 1 of 4 characters, edited /),
        ).toBeInTheDocument();
        expect(
            within(group).getByText(
                'On your account: Hyper, 1 of 4 characters, changed on another device (time not known).',
            ),
        ).toBeInTheDocument();
        // Same name, same count: the lines say what differs.
        expect(within(group).getByText('The note differs.')).toBeInTheDocument();
        expect(
            within(group).getByText('Team: Clara here; Pela on your account.'),
        ).toBeInTheDocument();
        expect(screen.getByText('Not saved yet')).toBeInTheDocument();
        expect(slotNames()).toEqual(['Clara', null, null, null]);
    });

    it('Keep my changes: asked on its own version (refused as changed), then saved on the version shown', async () => {
        putActive('0', 1);
        await openStale(0, 'Hyper');
        fireEvent.click(screen.getByRole('button', { name: 'Keep my changes' }));
        await waitFor(() => expect(saves(conn)).toHaveLength(2));
        expect(saves(conn)).toEqual([`0/1/Hyper/${CLARA}`, `0/2/Hyper/${CLARA}`]);
        expect(conn.server.list()).toEqual([{ slot: 0, name: 'Hyper', code: CLARA, rev: 3 }]);
        await waitFor(() => expect(choice()).toBeNull());
        await waitFor(() => expect(storedDrafts()).toBeNull());
    });

    it('Use the account copy: the draft goes, the account copy is on the page, nothing is sent', async () => {
        fakeTimers();
        putActive('0', 1);
        await openStale(0, 'Hyper');
        fireEvent.click(screen.getByRole('button', { name: 'Use the account copy' }));
        await waitFor(() => expect(slotNames()).toEqual(['Pela', null, null, null]));
        expect(noteField()).toHaveValue('newer, from the phone');
        expect(storedDrafts()).toBeNull();
        await later(600_000);
        expect(saves(conn)).toEqual([]);
        expect(said('Saved to your account')).toBeInTheDocument();
    });

    it('a loadout that is not active: nothing is sent, the menu marks it, the choice shows when opened', async () => {
        fakeTimers();
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        putActive('0', 1);
        await openStale(1, 'Other', [{ slot: 0, name: 'Hyper' }]);
        await later(600_000);
        expect(saves(conn)).toEqual([]);
        expect(choice()).toBeNull();
        expect(
            screen.getByText(
                'Changed on another device too: Other. Open it to choose which copy to keep.',
            ),
        ).toBeInTheDocument();
        await user.click(caret());
        const other = screen.getByRole('menuitemradio', { name: /Other/ });
        expect(other).toHaveAccessibleName(/changed on another device: choose a copy/);
        await user.click(other);
        expect(choice()).toBeInTheDocument();
        expect(saves(conn)).toEqual([]);
    });

    it('a draft on the current version is sent as usual, with no choice', async () => {
        conn.server.seed(0, 'Hyper');
        putDrafts({ 0: draft({ name: 'Hyper', code: CLARA, baseRev: 1 }) });
        putActive('0', 1);
        await openMember(conn);
        await waitFor(() => expect(saves(conn)).toEqual([`0/1/Hyper/${CLARA}`]));
        expect(choice()).toBeNull();
    });

    it('live (review S8): another device saves while this page’s draft waits: the choice, nothing sent', async () => {
        fakeTimers();
        putActive('0', 1);
        await openMember(conn, [{ slot: 0, name: 'Hyper' }]);
        fireEvent.click(card('Pela'));
        await act(async () => conn.server.elsewhere(0, 'Hyper', CLARA, 'from the phone'));
        await later(120_000);
        expect(saves(conn)).toEqual([]);
        expect(choice()).toBeInTheDocument();
        expect(slotNames()).toEqual(['Acheron', 'Pela', null, null]);
    });

    it('S14.3j: the choice is a modal dialog; Escape leaves it held, the card line opens it again', async () => {
        fakeTimers();
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        putActive('0', 1);
        await openStale(0, 'Hyper');
        const dialog = screen.getByRole('dialog', {
            name: 'Hyper was also changed on another device.',
        }) as HTMLDialogElement;
        expect(dialog).toHaveAttribute('open');
        expect(choice()).toHaveFocus();
        expect(within(dialog).getByText('Nothing is saved until you choose.')).toBeInTheDocument();
        expect(
            within(dialog).getByRole('button', { name: 'Use the account copy' }),
        ).toBeInTheDocument();
        // Escape: a close with no choice. Nothing is saved or dropped; the card says it waits.
        act(() => dialog.close());
        expect(dialog).not.toHaveAttribute('open');
        expect(choice()).toBeNull();
        const again = screen.getByRole('button', { name: 'Choose a copy' });
        expect(again).toHaveFocus();
        expect(
            screen.getByText('Hyper was also changed on another device.', { selector: 'span' }),
        ).toBeInTheDocument();
        await later(600_000);
        expect(saves(conn)).toEqual([]);
        expect(storedDrafts()?.['0']).toMatchObject({ code: CLARA, baseRev: 1 });
        expect(slotNames()).toEqual(['Clara', null, null, null]);
        // Opened again from the card: the same choice, and it still works.
        await user.click(again);
        expect(dialog).toHaveAttribute('open');
        expect(choice()).toHaveFocus();
        expect(screen.queryByRole('button', { name: 'Choose a copy' })).toBeNull();
        await user.click(choice() as HTMLElement);
        await waitFor(() => expect(saves(conn)).toHaveLength(2));
        expect(saves(conn)).toEqual([`0/1/Hyper/${CLARA}`, `0/2/Hyper/${CLARA}`]);
        expect(caret()).toHaveFocus();
        await waitFor(() => expect(choice()).toBeNull());
        expect(dialog).not.toHaveAttribute('open');
    });

    it('S14.3j: two loadouts changed elsewhere: one dialog at a time; the other opens with its loadout', async () => {
        fakeTimers();
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        conn.server.seed(0, 'Hyper');
        conn.server.elsewhere(0, 'Hyper', PELA, 'newer, from the phone');
        conn.server.seed(1, 'Other');
        conn.server.elsewhere(1, 'Other', PELA, 'newer, from the phone');
        putDrafts({ ...stale(0, 'Hyper'), ...stale(1, 'Other') });
        putActive('0', 1);
        await openMember(conn);
        expect(document.querySelectorAll('dialog[open]')).toHaveLength(1);
        expect(
            screen.getByRole('dialog', { name: 'Hyper was also changed on another device.' }),
        ).toHaveAttribute('open');
        expect(
            screen.getByText(
                'Changed on another device too: Other. Open it to choose which copy to keep.',
            ),
        ).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Use the account copy' }));
        await waitFor(() => expect(choice()).toBeNull());
        expect(document.querySelectorAll('dialog[open]')).toHaveLength(0);
        await user.click(caret());
        await user.click(screen.getByRole('menuitemradio', { name: /Other/ }));
        expect(
            screen.getByRole('dialog', { name: 'Other was also changed on another device.' }),
        ).toHaveAttribute('open');
        expect(document.querySelectorAll('dialog[open]')).toHaveLength(1);
        expect(choice()).toHaveFocus();
        expect(saves(conn)).toEqual([]);
    });

    it('the version follows each save: edit, an edit while the save flies, closed; the next visit sends it on the new version', async () => {
        fakeTimers();
        let land: () => void = () => {};
        conn.reducers.saveLoadout.mockImplementationOnce(
            (a) =>
                new Promise<void>((resolve) => {
                    land = () => {
                        conn.server.save(a);
                        resolve();
                    };
                }),
        );
        putActive('0', 1);
        const first = await openMember(conn, [{ slot: 0, name: 'Hyper' }]);
        fireEvent.click(card('Pela'));
        await later(61_000);
        fireEvent.click(card('Clara'));
        await act(async () => land());
        drop();
        first.unmount();
        expect(conn.server.list()).toEqual([{ slot: 0, name: 'Hyper', code: T2, rev: 2 }]);
        vi.useRealTimers();
        setConnectionStatus({ state: 'connected' });
        conn = await reload(conn);
        await waitFor(() => expect(saves(conn)).toEqual([`0/2/Hyper/${T3}`]));
        expect(choice()).toBeNull();
    });
});

describe('reconnect (second review N1): nothing is sent before the rows are fresh', () => {
    it('a draft that waited offline, the loadout saved elsewhere meanwhile: no send on "connected"; the choice after the replay', async () => {
        fakeTimers();
        putActive('0', 1);
        await openMember(conn, [{ slot: 0, name: 'Hyper' }]);
        fireEvent.click(card('Pela'));
        drop();
        conn.server.holdView = true;
        conn.server.elsewhere(0, 'Hyper', CLARA, 'from the phone');
        await later(120_000);
        expect(saves(conn)).toEqual([]);
        await reconnect(conn, { replay: false });
        await later(30_000);
        // Connected, but the old rows are still cached: nothing goes.
        expect(saves(conn)).toEqual([]);
        await reconnect(conn);
        await later(120_000);
        expect(saves(conn)).toEqual([]);
        expect(choice()).toBeInTheDocument();
        expect(conn.server.list()[0]?.code).toBe(CLARA);
    });

    it('nothing changed elsewhere: sent once the replay is in', async () => {
        fakeTimers();
        putActive('0', 1);
        await openMember(conn, [{ slot: 0, name: 'Hyper' }]);
        fireEvent.click(card('Pela'));
        drop();
        await later(120_000);
        await reconnect(conn, { replay: false });
        await later(10_000);
        expect(saves(conn)).toEqual([]);
        await reconnect(conn);
        await waitFor(() => expect(saves(conn)).toEqual([`0/1/Hyper/${T2}`]));
    });

    it('the server is the guarantee: a send on rows that lag (a slow view) is refused, never written', async () => {
        fakeTimers();
        putActive('0', 1);
        await openMember(conn, [{ slot: 0, name: 'Hyper' }]);
        conn.server.holdView = true;
        conn.server.elsewhere(0, 'Hyper', CLARA);
        // The page's rows are fresh for this connection but behind the server: the edit goes on version 1.
        fireEvent.click(card('Pela'));
        await later(61_000);
        expect(saves(conn)).toEqual([`0/1/Hyper/${T2}`]);
        expect(conn.server.list()[0]).toMatchObject({ code: CLARA, rev: 2 });
        await waitFor(() => expect(choice()).toBeInTheDocument());
        await act(async () => {
            conn.server.holdView = false;
            conn.server.flushView();
        });
        await later(120_000);
        expect(saves(conn)).toHaveLength(1);
        expect(choice()).toBeInTheDocument();
    });
});

describe('before the account list is here (second review N2)', () => {
    it('member known, list late: an early edit goes into the restored loadout on its stored version: a conflict, not an overwrite', async () => {
        fakeTimers();
        conn.server.seed(0, 'Hyper');
        conn.server.elsewhere(0, 'Hyper', PELA, 'newer, from the phone');
        const rows = [...conn.db.viewMyLoadouts.rows];
        conn.db.viewMyLoadouts.rows = [];
        putActive('0', 1);
        localStorage.setItem(DRAFT_KEY, ACHERON);
        renderWithConnection('/teambuilder', conn, MEMBER as never);
        await screen.findByRole('heading', { level: 1 });
        seedReference(conn, { id: 7 });
        await act(async () => {
            for (const s of conn.live()) if (!/view_my_loadouts/.test(s.query)) s.apply();
        });
        await act(async () => {
            for (const s of conn.live()) if (!/view_my_loadouts/.test(s.query)) s.apply();
        });
        fireEvent.click(card('Clara'));
        expect(storedDrafts()).toBeNull();
        conn.db.viewMyLoadouts.seed(...rows);
        await act(async () => conn.applyAll());
        await later(120_000);
        expect(saves(conn)).toEqual([]);
        expect(storedDrafts()?.['0']).toMatchObject({
            code: T2.replace('pela-6', 'clara-0'),
            baseRev: 1,
        });
        expect(choice()).toBeInTheDocument();
        expect(conn.server.list()[0]?.code).toBe(PELA);
    });

    it('not yet known who the visitor is: the same edit waits, then goes the same way', async () => {
        fakeTimers();
        conn.server.seed(0, 'Hyper');
        conn.server.elsewhere(0, 'Hyper', PELA);
        const rows = [...conn.db.viewMyLoadouts.rows];
        conn.db.viewMyLoadouts.rows = [];
        putActive('0', 1);
        localStorage.setItem(DRAFT_KEY, ACHERON);
        renderWithConnection('/teambuilder', conn, { ready: false } as never);
        await screen.findByRole('heading', { level: 1 });
        seedReference(conn);
        await act(async () => {
            for (const s of conn.live()) if (!/view_my_profile/.test(s.query)) s.apply();
        });
        fireEvent.click(card('Clara'));
        conn.db.viewMyProfile.seed(profileRow({ id: 7, isGuest: false }));
        conn.db.viewMyLoadouts.seed(...rows);
        await act(async () => conn.applyAll());
        await act(async () => conn.applyAll());
        await act(async () => conn.applyAll());
        await later(120_000);
        expect(saves(conn)).toEqual([]);
        expect(choice()).toBeInTheDocument();
        expect(browserList()).toBeNull();
    });
});

describe('two tabs of one browser (second review N3)', () => {
    it('a draft another live tab is writing: this tab never sends it; it follows that tab’s edits; once released it is sent here', async () => {
        fakeTimers();
        conn.server.seed(0, 'Hyper');
        putDrafts({ 0: live({ name: 'Hyper', code: CLARA, baseRev: 1 }, 't-1') });
        putActive('0', 1);
        await openMember(conn);
        await later(70_000);
        expect(saves(conn)).toEqual([]);
        expect(ringText()).toMatch(/Being changed in another tab of this browser/);
        // Tab 1 edits on.
        otherTabWrites({
            0: live({ name: 'Hyper', code: PELA, note: 'tab 1', baseRev: 1 }, 't-1'),
        });
        await waitFor(() => expect(slotNames()).toEqual(['Pela', null, null, null]));
        expect(saves(conn)).toEqual([]);
        // Tab 1 is closed (it releases its drafts): this tab sends the newest at once.
        otherTabWrites({ 0: live({ name: 'Hyper', code: PELA, note: 'tab 1', baseRev: 1 }, null) });
        await waitFor(() => expect(saves(conn)).toEqual([`0/1/Hyper/${PELA}`]));
        expect(conn.server.list()[0]).toMatchObject({ code: PELA, rev: 2 });
    });

    it('this tab’s save lands while the other tab wrote on top: the other tab’s draft stays, no conflict here', async () => {
        fakeTimers();
        let land: () => void = () => {};
        conn.reducers.saveLoadout.mockImplementationOnce(
            (a) =>
                new Promise<void>((resolve) => {
                    land = () => {
                        conn.server.save(a);
                        resolve();
                    };
                }),
        );
        putActive('0', 1);
        await openMember(conn, [{ slot: 0, name: 'Hyper' }]);
        fireEvent.click(card('Pela'));
        await later(61_000);
        expect(saves(conn)).toEqual([`0/1/Hyper/${T2}`]);
        // Tab 2 has loaded this tab's draft (with its send) and edited on top of it.
        const mine = storedDrafts()?.['0'];
        otherTabWrites({
            0: { ...(mine as ReturnType<typeof draft>), code: T3, tab: 't-2', seen: Date.now() },
        });
        await act(async () => land());
        await later(1_000);
        // Not this tab's draft: not removed, not rewritten (its owner rebases it on the row it sees).
        expect(storedDrafts()?.['0']).toMatchObject({ code: T3, baseRev: 1, tab: 't-2' });
        expect(choice()).toBeNull();
        expect(saves(conn)).toHaveLength(1);
    });

    it('a draft whose tab vanished without releasing it (a crash) is taken over after 90 s', async () => {
        fakeTimers();
        putActive('0', 1);
        await openMember(conn, [{ slot: 0, name: 'Hyper' }]);
        otherTabWrites({ 0: live({ name: 'Hyper', code: CLARA, baseRev: 1 }, 't-gone') });
        await later(60_000);
        expect(saves(conn)).toEqual([]);
        await later(31_000);
        await waitFor(() => expect(saves(conn)).toEqual([`0/1/Hyper/${CLARA}`]));
    });
});

describe('deleted on another device (A198 item 3; review N6)', () => {
    it('live, slot left empty: told, nothing sent; "Save as a new loadout" creates it', async () => {
        fakeTimers();
        putActive('0', 1);
        await openMember(conn, [{ slot: 0, name: 'Hyper' }]);
        fireEvent.click(card('Pela'));
        await act(async () => conn.server.deleteElsewhere(0));
        expect(
            screen.getByRole('dialog', { name: 'This loadout was deleted on another device.' }),
        ).toBeInTheDocument();
        await later(120_000);
        expect(saves(conn)).toEqual([]);
        expect(
            screen.getByText(/Deleted on another device. Choose what to do/, { selector: 'span' }),
        ).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Save as a new loadout' }));
        await waitFor(() => expect(saves(conn)).toEqual([`0/0/Hyper/${T2}`]));
        expect(conn.server.list()).toEqual([{ slot: 0, name: 'Hyper', code: T2, rev: 2 }]);
        expect(deletedChoice()).toBeNull();
    });

    it('live, slot reused by another loadout: still "deleted"; saved as new in a free slot, the other kept', async () => {
        fakeTimers();
        putActive('0', 1);
        await openMember(conn, [{ slot: 0, name: 'Hyper' }]);
        fireEvent.click(card('Pela'));
        await act(async () => conn.server.deleteElsewhere(0));
        await act(async () => conn.server.elsewhere(0, 'Fresh idea', CLARA));
        expect(deletedChoice()).toBeInTheDocument();
        expect(choice()).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Save as a new loadout' }));
        await waitFor(() => expect(saves(conn)).toEqual([`1/0/Hyper/${T2}`]));
        expect(names()).toEqual(['Fresh idea', 'Hyper']);
    });

    it('on load: "Discard my changes" drops them; nothing is sent', async () => {
        fakeTimers();
        conn.server.seed(0, 'Hyper');
        conn.server.deleteElsewhere(0);
        putDrafts({ 0: draft({ name: 'Hyper', code: CLARA, baseRev: 1 }) });
        putActive('0', 1);
        await openMember(conn);
        expect(deletedChoice()).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Discard my changes' }));
        await waitFor(() => expect(storedDrafts()).toBeNull());
        await later(120_000);
        expect(saves(conn)).toEqual([]);
        expect(nameField().value).toBe('New Loadout');
        expect(slotNames()).toEqual([null, null, null, null]);
    });

    it('on load, slot reused: shown as changed; Keep asks the server, which says deleted; nothing overwritten', async () => {
        conn.server.seed(0, 'Hyper');
        conn.server.deleteElsewhere(0);
        conn.server.seed(0, 'Fresh idea', PELA);
        putDrafts({ 0: draft({ name: 'Hyper', code: CLARA, baseRev: 1 }) });
        putActive('0', 1);
        await openMember(conn);
        const group = screen.getByRole('dialog', { name: /also changed/ });
        expect(
            within(group).getByText('Name: “Hyper” here, “Fresh idea” on your account.'),
        ).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Keep my changes' }));
        await waitFor(() => expect(deletedChoice()).toBeInTheDocument());
        expect(saves(conn)).toEqual([`0/1/Hyper/${CLARA}`]);
        expect(names()).toEqual(['Fresh idea']);
        fireEvent.click(screen.getByRole('button', { name: 'Save as a new loadout' }));
        await waitFor(() => expect(names()).toEqual(['Fresh idea', 'Hyper']));
    });

    it('S14.3j: the same dialog; Escape keeps the changes held, "Choose what to keep" opens it again', async () => {
        fakeTimers();
        conn.server.seed(0, 'Hyper');
        conn.server.deleteElsewhere(0);
        putDrafts({ 0: draft({ name: 'Hyper', code: CLARA, baseRev: 1 }) });
        putActive('0', 1);
        await openMember(conn);
        const dialog = screen.getByRole('dialog', {
            name: 'This loadout was deleted on another device.',
        }) as HTMLDialogElement;
        expect(deletedChoice()).toHaveFocus();
        act(() => dialog.close());
        expect(deletedChoice()).toBeNull();
        await later(120_000);
        expect(saves(conn)).toEqual([]);
        expect(storedDrafts()?.['0']).toMatchObject({ code: CLARA });
        fireEvent.click(screen.getByRole('button', { name: 'Choose what to keep' }));
        expect(dialog).toHaveAttribute('open');
        expect(deletedChoice()).toHaveFocus();
        fireEvent.click(screen.getByRole('button', { name: 'Discard my changes' }));
        await waitFor(() => expect(storedDrafts()).toBeNull());
        expect(dialog).not.toHaveAttribute('open');
        expect(caret()).toHaveFocus();
    });

    it('refused as deleted while the view lags: the same choice', async () => {
        fakeTimers();
        putActive('0', 1);
        await openMember(conn, [{ slot: 0, name: 'Hyper' }]);
        conn.server.holdView = true;
        conn.server.deleteElsewhere(0);
        fireEvent.click(card('Pela'));
        await later(61_000);
        expect(saves(conn)).toEqual([`0/1/Hyper/${T2}`]);
        await waitFor(() => expect(deletedChoice()).toBeInTheDocument());
        expect(conn.server.list()).toEqual([]);
    });
});

describe('this page’s own save is never a conflict (second review N7)', () => {
    it('the answer comes before its row: "Auto saved", no choice; the row then settles it', async () => {
        fakeTimers();
        putActive('0', 1);
        await openMember(conn, [{ slot: 0, name: 'Hyper' }]);
        conn.server.holdView = true;
        fireEvent.click(card('Pela'));
        await later(61_000);
        await waitFor(() => expect(said('Auto saved')).toBeInTheDocument());
        expect(choice()).toBeNull();
        await act(async () => {
            conn.server.holdView = false;
            conn.server.flushView();
        });
        await waitFor(() => expect(storedDrafts()).toBeNull());
        expect(choice()).toBeNull();
        await later(120_000);
        expect(saves(conn)).toHaveLength(1);
    });

    /** The first save lands on the server, its row never reaches this page and its answer is lost. */
    const landsUnseen = () =>
        conn.reducers.saveLoadout.mockImplementationOnce(async (a) => {
            conn.server.holdView = true;
            conn.server.save(a);
            throw new UnknownCallResultError();
        });

    it('a lost answer that landed, an edit, a reload: sent on the new version, no choice', async () => {
        fakeTimers();
        landsUnseen();
        putActive('0', 1);
        const first = await openMember(conn, [{ slot: 0, name: 'Hyper' }]);
        fireEvent.click(card('Pela'));
        await later(61_000);
        drop();
        fireEvent.click(card('Clara'));
        expect(storedDrafts()?.['0']).toMatchObject({
            code: T3,
            baseRev: 1,
            sent: [{ code: T2, baseRev: 1 }],
        });
        first.unmount();
        vi.useRealTimers();
        setConnectionStatus({ state: 'connected' });
        conn = await reload(conn);
        await waitFor(() => expect(saves(conn)).toEqual([`0/2/Hyper/${T3}`]));
        expect(choice()).toBeNull();
        expect(conn.server.list()).toEqual([{ slot: 0, name: 'Hyper', code: T3, rev: 3 }]);
    });

    it('a lost answer for a new loadout, a reload: no second loadout', async () => {
        fakeTimers();
        landsUnseen();
        const first = await openMember(conn);
        fireEvent.click(card('Pela'));
        await later(61_000);
        drop();
        first.unmount();
        vi.useRealTimers();
        setConnectionStatus({ state: 'connected' });
        conn = await reload(conn);
        await waitFor(() => expect(storedDrafts()).toBeNull());
        expect(names()).toEqual(['New Loadout']);
        expect(saves(conn)).toEqual([]);
        expect(choice()).toBeNull();
    });

    it('a lost answer, the retry refused as changed with the row then holding the draft: settled, no conflict', async () => {
        fakeTimers();
        landsUnseen().mockImplementationOnce(async (a) => {
            // The server sends the transaction's rows before the answer.
            conn.server.holdView = false;
            conn.server.flushView();
            conn.server.save(a);
        });
        putActive('0', 1);
        await openMember(conn, [{ slot: 0, name: 'Hyper' }]);
        fireEvent.click(card('Pela'));
        await later(61_000);
        drop();
        // Back, the replay in, but the view still lags behind the server.
        await reconnect(conn, { deliver: false });
        await later(1_000);
        expect(saves(conn)).toEqual([`0/1/Hyper/${T2}`, `0/1/Hyper/${T2}`]);
        expect(choice()).toBeNull();
        await waitFor(() => expect(storedDrafts()).toBeNull());
        expect(conn.server.list()).toEqual([{ slot: 0, name: 'Hyper', code: T2, rev: 2 }]);
        expect(said('Auto saved')).toBeInTheDocument();
    });
});

describe('a server runtime failure (second review N4)', () => {
    it('retried with backoff and an honest reason, stopped after five; the next edit tries again', async () => {
        fakeTimers();
        conn.reducers.saveLoadout.mockImplementation(async () => {
            throw new InternalError('out of energy');
        });
        await openMember(conn);
        fireEvent.click(card('Acheron'));
        await later(61_000);
        expect(
            screen.getByText(/The server could not save this. Trying again/, { selector: 'span' }),
        ).toBeInTheDocument();
        expect(screen.queryByText(/No connection/)).toBeNull();
        for (let i = 0; i < 60; i++) await later(30_000);
        expect(saves(conn)).toHaveLength(5);
        expect(
            screen.getByText(/after your next change or when the connection comes back/, {
                selector: 'span',
            }),
        ).toBeInTheDocument();
        fireEvent.click(card('Pela'));
        await later(61_000);
        expect(saves(conn)).toHaveLength(6);
    });
});

describe('delete on a version (A198)', () => {
    it('a newer copy elsewhere: refused, the newer copy shows, asked again; a second Delete removes it', async () => {
        const user = userEvent.setup();
        await openMember(conn, [{ slot: 2, name: 'Hyper' }]);
        await user.click(caret());
        await user.click(screen.getByRole('menuitemradio', { name: /^Hyper,/ }));
        conn.server.holdView = true;
        conn.server.elsewhere(2, 'Hyper', CLARA, 'from the phone');
        await user.click(caret());
        await user.click(screen.getByRole('menuitem', { name: 'Delete Hyper' }));
        await user.click(screen.getByRole('button', { name: 'Delete' }));
        await waitFor(() =>
            expect(screen.getByRole('dialog', { name: 'Delete Hyper?' })).toHaveTextContent(
                'This loadout was changed on another device. The newer copy is on the page now.',
            ),
        );
        expect(conn.reducers.deleteLoadout.mock.calls[0]?.[0]).toEqual({ slot: 2, baseRev: 1 });
        expect(names()).toEqual(['Hyper']);
        await act(async () => {
            conn.server.holdView = false;
            conn.server.flushView();
        });
        await waitFor(() => expect(slotNames()).toEqual(['Clara', null, null, null]));
        await user.click(screen.getByRole('button', { name: 'Delete' }));
        await waitFor(() => expect(names()).toEqual([]));
        expect(conn.reducers.deleteLoadout.mock.calls[1]?.[0]).toEqual({ slot: 2, baseRev: 2 });
    });

    it('offline, a new loadout never sent is deleted here without a call (review M4)', async () => {
        const user = userEvent.setup();
        await openMember(conn);
        fireEvent.click(card('Pela'));
        drop();
        await user.click(caret());
        await user.click(screen.getByRole('menuitem', { name: 'Delete New Loadout' }));
        await user.click(screen.getByRole('button', { name: 'Delete' }));
        await waitFor(() => expect(storedDrafts()).toBeNull());
        expect(conn.reducers.deleteLoadout).not.toHaveBeenCalled();
    });
});

describe('the 6-per-minute limit through the page', () => {
    it('seven "Copy to my account" in a minute: six go at once, the seventh a minute later; none lost', async () => {
        fakeTimers();
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        localStorage.setItem(
            BROWSER_KEY,
            JSON.stringify({
                v: 1,
                loadouts: [{ key: 'b-1', name: 'Local', note: '', code: ACHERON }],
            }),
        );
        await openMember(conn);
        for (let i = 0; i < 7; i++) {
            await user.click(caret());
            await user.click(screen.getByRole('menuitem', { name: 'Copy Local to my account' }));
        }
        await later(1_000);
        expect(saves(conn)).toHaveLength(6);
        await later(60_000);
        expect(saves(conn)).toHaveLength(7);
        expect(names()).toHaveLength(7);
        expect(conn.reducers.saveLoadout.mock.calls.every(([a]) => a.baseRev === 0)).toBe(true);
    });
});

describe('the ring follows the scheduler’s clock (review S2)', () => {
    it('a re-render during the wait writes the same timing; it starts where the wait stands', async () => {
        fakeTimers();
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        putActive('0');
        await openMember(conn, [{ slot: 0, name: 'Hyper' }]);
        fireEvent.click(card('Pela'));
        const ring = () =>
            document.querySelector('[data-state="waiting"] [data-fill]') as HTMLElement;
        const timing = () => [
            ring().style.getPropertyValue('--ring-ms'),
            ring().style.getPropertyValue('--ring-delay'),
        ];
        const first = timing();
        expect(first[0]).toBe('60000ms');
        expect(Number(/^-(\d+)ms$/.exec(first[1] ?? '')?.[1])).toBeLessThan(1000);
        await later(30_000);
        await user.type(screen.getByRole('searchbox'), 'cl');
        expect(timing()).toEqual(first);
        fireEvent.click(card('Clara'));
        const second = timing();
        expect(second[0]).toBe('60000ms');
        await later(20_000);
        await user.clear(screen.getByRole('searchbox'));
        expect(timing()).toEqual(second);
    });
});

describe('sign-out and a change of account (review S3)', () => {
    it('the account loadout leaves the page; nothing of it reaches the browser list; the next account sees none of it', async () => {
        putActive('0');
        await openMember(conn, [{ slot: 0, name: 'Private plan', note: 'my private note' }]);
        expect(nameField().value).toBe('Private plan');
        fireEvent.click(card('Pela'));
        await act(async () => conn.db.viewMyProfile.delete(conn.db.viewMyProfile.rows[0] as never));
        await waitFor(() =>
            expect(screen.getByRole('link', { name: 'Sign in with Discord' })).toBeInTheDocument(),
        );
        expect(nameField().value).toBe('New Loadout');
        expect(noteField()).toHaveValue('');
        expect(slotNames()).toEqual([null, null, null, null]);
        expect(localStorage.getItem(DRAFT_KEY)).toBe(EMPTY);
        expect(storedDrafts(7)?.['0']).toMatchObject({
            name: 'Private plan',
            note: 'my private note',
        });
        fireEvent.click(card('Clara'));
        expect(browserList()?.loadouts).toEqual([
            { key: expect.any(String), name: 'New Loadout', note: '', code: CLARA },
        ]);
        await act(async () => conn.db.viewMyProfile.insert(profileRow({ id: 8, isGuest: false })));
        await act(async () => conn.applyAll());
        expect(screen.queryByDisplayValue('Private plan')).toBeNull();
        expect(screen.queryByDisplayValue('my private note')).toBeNull();
        expect(storedDrafts(8)).toBeNull();
    });

    it('the browser loadout shown last before the account one comes back on sign-out', async () => {
        const user = userEvent.setup();
        localStorage.setItem(
            BROWSER_KEY,
            JSON.stringify({
                v: 1,
                loadouts: [{ key: 'b-1', name: 'Local', note: 'mine', code: CLARA }],
            }),
        );
        await openMember(conn, [{ slot: 0, name: 'Private plan', note: 'private' }]);
        await user.click(caret());
        await user.click(screen.getByRole('menuitemradio', { name: /Local/ }));
        await user.click(caret());
        await user.click(screen.getByRole('menuitemradio', { name: /Private plan/ }));
        expect(nameField().value).toBe('Private plan');
        await act(async () => conn.db.viewMyProfile.delete(conn.db.viewMyProfile.rows[0] as never));
        await waitFor(() => expect(nameField().value).toBe('Local'));
        expect(slotNames()).toEqual(['Clara', null, null, null]);
        expect(noteField()).toHaveValue('mine');
    });

    it('a visit after another account signed out elsewhere does not show that account’s team', async () => {
        localStorage.setItem(DRAFT_KEY, ACHERON);
        putActive('0', 1, 7);
        await openVisitor(conn);
        await waitFor(() => expect(slotNames()).toEqual([null, null, null, null]));
        expect(nameField().value).toBe('New Loadout');
    });

    it('sign-out while a save flies, an edit meanwhile: no error, nothing in the browser list, the draft waits in the account’s key', async () => {
        fakeTimers();
        let land: () => void = () => {};
        conn.reducers.saveLoadout.mockImplementationOnce(
            (a) =>
                new Promise<void>((resolve) => {
                    land = () => {
                        conn.server.save(a);
                        resolve();
                    };
                }),
        );
        putActive('0');
        await openMember(conn, [{ slot: 0, name: 'Hyper', note: 'private' }]);
        fireEvent.click(card('Pela'));
        await later(61_000);
        fireEvent.click(card('Clara'));
        await act(async () => conn.db.viewMyProfile.delete(conn.db.viewMyProfile.rows[0] as never));
        await act(async () => land());
        await later(120_000);
        expect(saves(conn)).toHaveLength(1);
        expect(browserList()).toBeNull();
        expect(storedDrafts(7)?.['0']).toMatchObject({ code: T3 });
        expect(nameField().value).toBe('New Loadout');
    });

    it('signed out and in again in one visit (review m2): the waiting draft is sent', async () => {
        fakeTimers();
        putActive('0');
        await openMember(conn, [{ slot: 0, name: 'Hyper' }]);
        fireEvent.click(card('Pela'));
        await act(async () => conn.db.viewMyProfile.delete(conn.db.viewMyProfile.rows[0] as never));
        await act(async () => conn.db.viewMyProfile.insert(profileRow({ id: 7, isGuest: false })));
        await act(async () => conn.applyAll());
        await act(async () => conn.applyAll());
        await later(1_000);
        await waitFor(() => expect(saves(conn)).toEqual([`0/1/Hyper/${T2}`]));
    });
});

describe('before the connection says who the visitor is (review S4)', () => {
    const applyAllButProfile = () => {
        for (const s of conn.live()) if (!/view_my_profile/.test(s.query)) s.apply();
    };

    it('a member: no sign-in line, no browser loadout; the early edit lands in the account once known', async () => {
        renderWithConnection('/teambuilder', conn, { ready: false } as never);
        await screen.findByRole('heading', { level: 1 });
        seedReference(conn);
        await act(async () => applyAllButProfile());
        expect(screen.queryByRole('link', { name: 'Sign in with Discord' })).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'New Loadout' }));
        expect(
            screen.getByText('Still connecting. Try again in a moment.', {
                selector: 'p:not([role])',
            }),
        ).toBeInTheDocument();
        fireEvent.click(card('Clara'));
        fireEvent.change(noteField(), { target: { value: 'typed early' } });
        expect(browserList()).toBeNull();
        expect(noteField()).toHaveValue('typed early');
        conn.db.viewMyProfile.seed(profileRow({ id: 7, isGuest: false }));
        await act(async () => conn.applyAll());
        await act(async () => conn.applyAll());
        await waitFor(() =>
            expect(storedDrafts()?.['0']).toMatchObject({
                code: CLARA,
                note: 'typed early',
                baseRev: 0,
            }),
        );
        expect(browserList()).toBeNull();
    });

    it('a visitor: the early edit becomes a browser loadout once known', async () => {
        renderWithConnection('/teambuilder', conn, { ready: false } as never);
        await screen.findByRole('heading', { level: 1 });
        seedReference(conn);
        await act(async () => applyAllButProfile());
        fireEvent.click(card('Clara'));
        expect(browserList()).toBeNull();
        act(() => setAuthSnapshot({ ready: true }));
        await waitFor(() =>
            expect(browserList()?.loadouts).toEqual([
                { key: expect.any(String), name: 'New Loadout', note: '', code: CLARA },
            ]),
        );
        expect(screen.getByRole('link', { name: 'Sign in with Discord' })).toBeInTheDocument();
    });
});

describe('a shared team and a reload (review S5)', () => {
    const linkNotice = () => screen.queryByText('Loaded a team from a link.', { selector: 'span' });

    it('survives a reload with its notice; leaving it for a saved loadout ends the notice', async () => {
        const user = userEvent.setup();
        const first = await openVisitor(conn);
        await user.click(card('Acheron'));
        first.unmount();
        conn = makeConn();
        const second = await openVisitor(conn, `/teambuilder?team=${PELA}`);
        expect(linkNotice()).toBeInTheDocument();
        second.unmount();
        conn = makeConn();
        await openVisitor(conn);
        expect(nameField().value).toBe('Shared team');
        expect(slotNames()).toEqual(['Pela', null, null, null]);
        expect(linkNotice()).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Restore my previous team' }));
        expect(nameField().value).toBe('New Loadout');
        expect(slotNames()).toEqual(['Acheron', null, null, null]);
        expect(linkNotice()).toBeNull();
    });

    it('switching to a saved loadout ends the notice, also after a reload', async () => {
        const user = userEvent.setup();
        const first = await openVisitor(conn);
        await user.click(card('Acheron'));
        first.unmount();
        conn = makeConn();
        const second = await openVisitor(conn, `/teambuilder?team=${PELA}`);
        await user.click(caret());
        await user.click(screen.getByRole('menuitemradio', { name: /New Loadout/ }));
        expect(linkNotice()).toBeNull();
        expect(localStorage.getItem(PREVIOUS_KEY)).toBeNull();
        second.unmount();
        conn = makeConn();
        await openVisitor(conn);
        expect(nameField().value).toBe('New Loadout');
        expect(slotNames()).toEqual(['Acheron', null, null, null]);
        expect(linkNotice()).toBeNull();
    });
});

describe('an edit taken back (review S6)', () => {
    it('add then remove: nothing is sent, the ring is back to saved', async () => {
        fakeTimers();
        putActive('0');
        await openMember(conn, [{ slot: 0, name: 'Hyper' }]);
        fireEvent.click(card('Pela'));
        expect(said('Saving soon')).toBeInTheDocument();
        fireEvent.click(card('Pela'));
        await waitFor(() => expect(said('Saved to your account')).toBeInTheDocument());
        await later(120_000);
        expect(saves(conn)).toEqual([]);
        expect(storedDrafts()).toBeNull();
    });
});

describe('a loadout deleted elsewhere with no edits here (review M1)', () => {
    it('its team stays as the working loadout with a notice; the slot is free again for a new one', async () => {
        fakeTimers();
        await openMember(conn);
        fireEvent.click(card('Acheron'));
        await later(61_000);
        await waitFor(() => expect(storedDrafts()).toBeNull());
        await act(async () => conn.server.deleteElsewhere(0));
        await waitFor(() =>
            expect(
                within(noticeDialog()).getByText('Its team stays here, not saved.'),
            ).toBeInTheDocument(),
        );
        fireEvent.click(card('Pela'));
        await later(61_000);
        expect(conn.reducers.saveLoadout.mock.calls.at(-1)?.[0]).toMatchObject({
            slot: 0,
            baseRev: 0,
        });
    });

    /** S14.3j: the notice's dialog (its first sentence is the dialog's name). */
    const noticeDialog = () =>
        screen.getByRole('dialog', {
            name: 'This loadout was deleted on another device.',
        }) as HTMLDialogElement;

    async function vanish() {
        fakeTimers();
        await openMember(conn);
        fireEvent.click(card('Acheron'));
        await later(61_000);
        await waitFor(() => expect(storedDrafts()).toBeNull());
        await act(async () => conn.server.deleteElsewhere(0));
    }

    it('S14.3j: the notice is a modal dialog; Dismiss closes it for good, focus on the caret; the team stays', async () => {
        await vanish();
        const dialog = noticeDialog();
        expect(dialog).toHaveAttribute('open');
        expect(dialog).toHaveAttribute('data-notice-dialog');
        const dismiss = within(dialog).getByRole('button', { name: 'Dismiss' });
        expect(dismiss).toHaveFocus();
        fireEvent.click(dismiss);
        expect(dialog).not.toHaveAttribute('open');
        expect(screen.queryByText('Its team stays here, not saved.')).toBeNull();
        expect(caret()).toHaveFocus();
        expect(slotNames()).toEqual(['Acheron', null, null, null]);
        await later(120_000);
        expect(dialog).not.toHaveAttribute('open');
    });

    it('S14.3j: Escape dismisses the notice the same way', async () => {
        await vanish();
        const dialog = noticeDialog();
        act(() => dialog.close());
        expect(dialog).not.toHaveAttribute('open');
        expect(screen.queryByText('Its team stays here, not saved.')).toBeNull();
        expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
        expect(caret()).toHaveFocus();
        expect(slotNames()).toEqual(['Acheron', null, null, null]);
    });

    it('S14.3j: one dialog at a time: a notice that arrives behind the delete dialog opens once it closes', async () => {
        fakeTimers();
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        putActive('0', 1);
        await openMember(conn, [
            { slot: 0, name: 'Hyper' },
            { slot: 1, name: 'Other' },
        ]);
        await user.click(caret());
        await user.click(screen.getByRole('menuitem', { name: 'Delete Other' }));
        const del = screen.getByRole('dialog', { name: 'Delete Other?' });
        await act(async () => conn.server.deleteElsewhere(0));
        await later(1_000);
        // The notice waits: only the delete dialog is open.
        expect(document.querySelectorAll('dialog[open]')).toHaveLength(1);
        expect(del).toHaveAttribute('open');
        expect(screen.queryByText('Its team stays here, not saved.')).toBeNull();
        await user.click(within(del).getByRole('button', { name: 'Cancel' }));
        await waitFor(() => expect(noticeDialog()).toHaveAttribute('open'));
        expect(document.querySelectorAll('dialog[open]')).toHaveLength(1);
        expect(within(noticeDialog()).getByRole('button', { name: 'Dismiss' })).toHaveFocus();
        expect(names()).toEqual(['Other']);
    });

    it('S14.3j: one dialog at a time: a held choice that arrives behind the delete dialog opens once it closes', async () => {
        fakeTimers();
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        putActive('0', 1);
        await openMember(conn, [
            { slot: 0, name: 'Hyper' },
            { slot: 1, name: 'Other' },
        ]);
        fireEvent.click(card('Pela'));
        await user.click(caret());
        await user.click(screen.getByRole('menuitem', { name: 'Delete Other' }));
        const del = screen.getByRole('dialog', { name: 'Delete Other?' });
        await act(async () => conn.server.elsewhere(0, 'Hyper', CLARA, 'from the phone'));
        await later(1_000);
        expect(document.querySelectorAll('dialog[open]')).toHaveLength(1);
        expect(choice()).toBeNull();
        await user.click(within(del).getByRole('button', { name: 'Cancel' }));
        await waitFor(() => expect(choice()).toHaveFocus());
        expect(document.querySelectorAll('dialog[open]')).toHaveLength(1);
        expect(saves(conn)).toEqual([]);
    });
});
