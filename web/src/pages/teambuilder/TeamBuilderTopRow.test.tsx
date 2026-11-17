import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INTRO_KEY } from '@/components/PageIntro/PageIntro';
import { setConnectionStatus } from '@/stdb/connectionStatus';
import { costSet } from '@/test/costFixtures';
import { LINK_COPIED, SIGN_IN_HINT } from './LoadoutsPanel';
import { ACTIVE_KEY, BROWSER_KEY, draftsKey } from './loadoutStorage';
import {
    type Conn,
    card,
    GUEST,
    installDialog,
    makeConn,
    nameField,
    openMember,
    openVisitor,
    removeDialog,
} from './loadoutTestKit';
import { PICTURE_COPIED, PICTURE_HIDE, PICTURE_SAVED } from './PictureActions';
import { KEPT_BIDS, LOADED_FROM_LINK } from './TeamBuilderPage';
import { DRAFT_KEY, PREVIOUS_KEY } from './teamStorage';

/*
 * T-S14.3f: the balanced top row (Loadouts beside Modes). What jsdom can prove: where each piece sits in the DOM
 * (which card, which row, in what order), that the confirmations of Copy link, Copy image and Download all speak
 * from the one status place beside the hide option (present and empty before a press, a live region, the name row
 * untouched), that the sign-in line is the whole sentence for a visitor and a guest and absent for a member, where
 * the sometimes-notices render, and the Tab order across the two cards. What it cannot prove: heights, that the two
 * cards end level, that nothing overlaps; those are the browser checks (docs/log/2026-11-17-s14-3f.md).
 */

let conn: Conn;

class FakeClipboardItem {
    constructor(public items: Record<string, Promise<Blob> | Blob>) {}
}

/** A canvas context that draws nothing: enough for the picture to be made. */
function fakeContext(): CanvasRenderingContext2D {
    const noop = () => undefined;
    return new Proxy(
        {
            font: '',
            measureText: (t: string) => ({ width: Array.from(t).length * 7 }),
            createLinearGradient: () => ({ addColorStop: noop }),
        } as Record<string, unknown>,
        { get: (target, key) => (key in target ? target[key as string] : noop) },
    ) as unknown as CanvasRenderingContext2D;
}

class FakeImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    crossOrigin: string | null = null;
    decoding = 'auto';
    naturalWidth = 200;
    naturalHeight = 300;
    private url = '';
    get src() {
        return this.url;
    }
    set src(value: string) {
        this.url = value;
        setTimeout(() => this.onload?.(), 0);
    }
}

beforeEach(() => {
    conn = makeConn();
    try {
        for (const k of [INTRO_KEY, DRAFT_KEY, PREVIOUS_KEY, BROWSER_KEY, ACTIVE_KEY, draftsKey(7)])
            localStorage.removeItem(k);
    } catch {}
    setConnectionStatus({ state: 'connected' });
    installDialog();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
        () => fakeContext() as never,
    );
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((cb) => {
        setTimeout(() => cb(new Blob(['png'], { type: 'image/png' })), 0);
    });
    vi.stubGlobal('Image', FakeImage);
    vi.stubGlobal('ClipboardItem', FakeClipboardItem);
    URL.createObjectURL = vi.fn(() => 'blob:picture');
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
});
afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    removeDialog();
});

/** user-event puts its own clipboard on `navigator` at setup: the stand-in goes on after it. */
function setupUser() {
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
            write: vi.fn(async (items: FakeClipboardItem[]) => {
                await items[0]?.items['image/png'];
            }),
            writeText: vi.fn(async () => undefined),
        },
    });
    return user;
}

const loadoutsCard = () => screen.getByRole('region', { name: 'Loadouts' });
const modesCard = () => screen.getByRole('region', { name: 'Modes' });
const hideBox = () => screen.getByRole('checkbox', { name: PICTURE_HIDE });
/** The option row: the hide option's label, then the one status place (both confirmations). */
const optionRow = () => hideBox().closest('label')?.parentElement as HTMLElement;
const statusesIn = (el: HTMLElement) => within(el).queryAllByRole('status');
/** `a` comes before `b` in document order. */
const before = (a: Element, b: Element) =>
    Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

describe('the status place beside the hide option (S14.3f)', () => {
    it('is there and empty before any press, in the Loadouts card, after the four actions', async () => {
        await openVisitor(conn);
        const row = optionRow();
        expect(loadoutsCard()).toContainElement(row);
        const statuses = statusesIn(row);
        expect(statuses).toHaveLength(2);
        for (const s of statuses) {
            expect(s).toHaveTextContent('');
            expect(s).not.toHaveAttribute('data-show');
        }
        expect(before(screen.getByRole('button', { name: 'Download' }), row)).toBe(true);
        // Not in the name's row: a confirmation never sits over the name.
        expect(row).not.toContainElement(nameField());
    });

    it('Copy link, Copy image and Download each speak from it, and the name row keeps its place', async () => {
        const user = setupUser();
        await openVisitor(conn);
        await user.click(card('Acheron'));
        await waitFor(() =>
            expect(screen.getByRole('button', { name: 'Copy image' })).toBeEnabled(),
        );
        const row = optionRow();
        const nameRow = nameField().closest('div')?.parentElement as HTMLElement;

        await user.click(screen.getByRole('button', { name: 'Copy link' }));
        await waitFor(() =>
            expect(within(row).getByText(LINK_COPIED)).toHaveAttribute('role', 'status'),
        );
        expect(within(row).getByText(LINK_COPIED)).toHaveAttribute('data-show');

        await user.click(screen.getByRole('button', { name: 'Copy image' }));
        await waitFor(() =>
            expect(statusesIn(row).some((s) => s.textContent === PICTURE_COPIED)).toBe(true),
        );

        await user.click(screen.getByRole('button', { name: 'Download' }));
        await waitFor(() =>
            expect(
                statusesIn(row).some(
                    (s) => s.textContent === PICTURE_SAVED('team-new-loadout.png'),
                ),
            ).toBe(true),
        );
        // Every confirmation stayed in the option row: none landed in the name row or elsewhere in the card.
        const spoken = within(loadoutsCard())
            .queryAllByRole('status')
            .filter((s) => s.textContent);
        expect(spoken.length).toBeGreaterThan(0);
        for (const s of spoken) expect(row).toContainElement(s);
        expect(nameRow).toContainElement(nameField());
        expect(nameRow).not.toContainElement(row);
    });
});

describe('the sign-in line (S14.3f)', () => {
    const line = () => screen.queryByText(/keep up to 10 loadouts on your account/)?.closest('p');

    it('a visitor: the whole sentence, one link at its start, the card’s last row after the option row', async () => {
        await openVisitor(conn);
        const p = line() as HTMLElement;
        expect(p).toHaveTextContent(SIGN_IN_HINT);
        expect(p.textContent).toBe(SIGN_IN_HINT);
        const links = within(p).getAllByRole('link');
        expect(links).toHaveLength(1);
        expect(links[0]).toHaveAccessibleName('Sign in with Discord');
        expect(links[0]?.getAttribute('href')).toMatch(/login=1/);
        expect(loadoutsCard()).toContainElement(p);
        expect(before(optionRow(), p)).toBe(true);
    });

    it('a guest sees it too', async () => {
        await openVisitor(conn, '/teambuilder', GUEST);
        expect(line()?.textContent).toBe(SIGN_IN_HINT);
    });

    it('a member: no sign-in line; the option row and its status place stay', async () => {
        await openMember(conn);
        expect(line()).toBeFalsy();
        expect(screen.queryByRole('link', { name: 'Sign in with Discord' })).toBeNull();
        expect(statusesIn(optionRow())).toHaveLength(2);
    });
});

describe('the notices that show only sometimes (S14.3f)', () => {
    it('the link notice with Restore: in the Modes card, under the game mode', async () => {
        const user = userEvent.setup();
        const first = await openVisitor(conn);
        await user.click(card('Acheron'));
        first.unmount();
        conn = makeConn();
        await openVisitor(conn, '/teambuilder?team=1.pela-6._._._.as-c-0-3000-1500');
        const modes = modesCard();
        const notice = within(modes).getByText(LOADED_FROM_LINK);
        const restore = within(modes).getByRole('button', { name: 'Restore my previous team' });
        expect(within(modes).getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
        expect(before(screen.getByRole('group', { name: 'Game Mode' }), notice)).toBe(true);
        expect(before(notice, restore)).toBe(true);
        expect(within(loadoutsCard()).queryByText(LOADED_FROM_LINK)).toBeNull();
    });

    it('"Auction extra bids are kept": in the Modes card, under the game mode', async () => {
        const user = userEvent.setup();
        await openVisitor(conn);
        await user.click(card('Acheron'));
        await user.click(screen.getByRole('button', { name: 'Auction' }));
        const bid = screen.getByRole('textbox', { name: 'Extra bid for Acheron' });
        await user.clear(bid);
        await user.type(bid, '2');
        await user.tab();
        await user.click(screen.getByRole('button', { name: 'Classic' }));
        const kept = within(modesCard()).getByText(KEPT_BIDS);
        expect(before(screen.getByRole('group', { name: 'Game Mode' }), kept)).toBe(true);
    });

    it('the custom-set lock reason: the disabled tiles’ description, in the Modes card', async () => {
        const user = userEvent.setup();
        await openVisitor(conn);
        conn.db.viewPublishedCostSets.seed(costSet(3, 'Yuji Tournament'));
        await act(async () => conn.applyAll());
        await user.selectOptions(screen.getByRole('combobox', { name: 'Cost Set' }), '3');
        await act(async () => conn.applyAll());
        const moc = within(modesCard()).getByRole('radio', { name: 'Memory of Chaos' });
        expect(moc).toBeDisabled();
        expect(moc).toHaveAccessibleDescription(/Yuji Tournament is for Apocalyptic Shadow only/);
    });

    it('a refused New Loadout (the browser is full): a line in the Loadouts card, after the option row', async () => {
        const user = userEvent.setup();
        await openVisitor(conn);
        await user.click(card('Pela'));
        for (let i = 0; i < 4; i++) {
            await user.click(screen.getByRole('button', { name: 'New Loadout' }));
            await user.click(card('Pela'));
        }
        await user.click(screen.getByRole('button', { name: 'New Loadout' }));
        const refused = screen.getByText(
            'This browser already holds 5 loadouts. Delete one first.',
            { selector: 'p:not([role])' },
        );
        expect(loadoutsCard()).toContainElement(refused);
        expect(before(optionRow(), refused)).toBe(true);
    });
});

describe('the keyboard order across the two cards (S14.3f)', () => {
    it('Tab runs the Loadouts card row by row, then Modes, as they read', async () => {
        const user = userEvent.setup();
        await openVisitor(conn);
        await user.click(card('Acheron'));
        nameField().focus();
        const seen: string[] = [];
        for (let i = 0; i < 10; i++) {
            const el = document.activeElement as HTMLElement;
            seen.push(
                el.getAttribute('aria-label') ??
                    (el.closest('label')?.textContent || el.textContent || '').trim(),
            );
            await user.tab();
        }
        expect(seen).toEqual([
            'Rename active loadout',
            'Switch loadout',
            '+ New Loadout',
            'Copy link',
            'Copy image',
            'Download',
            PICTURE_HIDE,
            'Sign in with Discord',
            'Cost Set',
            'Classic',
        ]);
    });
});
