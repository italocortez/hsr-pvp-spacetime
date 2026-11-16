import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AuthSnapshot, setAuthSnapshot } from '@/auth/authStore';
import { loadSignInPage } from '@/pages/sign-in/signInPanel';
import { resetConnectionStatus, setConnectionStatus } from '@/stdb/connectionStatus';
import { AUTH, renderWithRouter } from '@/test/renderWithRouter';
import { NAV_ITEMS } from './NavBar';
import { currentItem, customMediaQuery, NAV_MENU_QUERY } from './PhoneMenu';

/*
 * T-PHONEMENU (S14.1b): the bar's menu form through the real App and route tree. jsdom has no
 * layout, so the switch point is driven by a mocked `matchMedia` (the bar reads it through
 * `useMenuForm`); the CSS look is checked in the browser pass.
 */

// The query the mock answers for: the bar's switch point.
const NARROW_QUERY = NAV_MENU_QUERY;

const named = (auth: AuthSnapshot, displayName: string): AuthSnapshot =>
    auth.user ? { ...auth, user: { ...auth.user, displayName } } : auth;
const MEMBER = named(AUTH.member, 'Trailblazer');
const GUEST = named(AUTH.guest, 'Guest 0001');
const MODERATOR = named(AUTH.moderator, 'March 7th');
const ADMIN = named(AUTH.admin, 'Nathyron');

// A controllable media query list for the narrow rule; every other query does not match.
let narrow = true;
const listeners = new Set<() => void>();
function installMatchMedia() {
    Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        writable: true,
        value: (query: string) => ({
            matches: query === NARROW_QUERY ? narrow : false,
            media: query,
            addEventListener: (_type: string, listener: () => void) => {
                if (query === NARROW_QUERY) listeners.add(listener);
            },
            removeEventListener: (_type: string, listener: () => void) => {
                listeners.delete(listener);
            },
        }),
    });
}
function setNarrow(value: boolean) {
    narrow = value;
    act(() => {
        for (const listener of [...listeners]) listener();
    });
}

beforeAll(async () => {
    await loadSignInPage();
}, 30_000);

beforeEach(() => {
    narrow = true;
    listeners.clear();
    installMatchMedia();
    resetConnectionStatus();
});

afterEach(() => {
    delete (window as { matchMedia?: unknown }).matchMedia;
    resetConnectionStatus();
    vi.restoreAllMocks();
});

type Rendered = ReturnType<typeof renderWithRouter>;

async function resolved(r: Rendered, href: string) {
    await waitFor(() => expect(r.router.state.resolvedLocation?.href).toBe(href));
}

const headline = () => screen.findByRole('heading', { level: 1 });
const primaryNav = () => screen.queryByRole('navigation', { name: 'Primary' });
const menuButton = () => screen.getByRole('button', { name: 'Menu' });
const panel = () => document.getElementById(menuButton().getAttribute('aria-controls') ?? '');
const panelLinks = () => within(panel() as HTMLElement).queryAllByRole('link');
const pageName = () => document.querySelector('[data-current-page]');
const announcer = () => document.querySelector('[data-route-announcer]') as HTMLElement;

async function setup(path = '/costs', auth: AuthSnapshot = AUTH.visitor) {
    const user = userEvent.setup();
    const r = renderWithRouter(path, auth);
    await headline();
    return { user, r, button: menuButton() };
}

describe('the switch point', () => {
    it('the script reads --nav-menu from styles/media.css, a max-width step of the scale', () => {
        // jsdom gives this file a non-file import.meta.url: the web folder is found from the cwd
        // (the repo root under `npm test`, or web/ itself), as in devGuard.config.test.ts.
        const root = [join(process.cwd(), 'web'), process.cwd()].find((d) =>
            existsSync(join(d, 'vite.config.ts')),
        ) as string;
        const media = readFileSync(join(root, 'src/styles/media.css'), 'utf8');
        expect(media.match(/@custom-media\s+--nav-menu\s/g)).toHaveLength(1);
        expect(NAV_MENU_QUERY).toBe(customMediaQuery(media, '--nav-menu'));
        const width = /^\(max-width: (\d+)px\)$/.exec(NAV_MENU_QUERY)?.[1];
        expect(['480', '560', '768', '1040', '1120']).toContain(width);
    });

    it('a missing custom media name is an error, not a silent default', () => {
        expect(() =>
            customMediaQuery('@custom-media --bp-sm (max-width: 560px);', '--nav-menu'),
        ).toThrow('@custom-media --nav-menu is not defined');
    });

    it('below it: one Primary nav with the menu button, no items row, no chevrons', async () => {
        const { button } = await setup();
        expect(screen.getAllByRole('navigation')).toHaveLength(1);
        const nav = primaryNav() as HTMLElement;
        expect(nav).toContainElement(button);
        expect(document.querySelector('[data-chevron]')).toBeNull();
        expect(within(nav).queryAllByRole('link')).toHaveLength(0);
        expect(within(nav).queryByRole('list')).toBeNull();
    });

    it('above it: one Primary nav with the items row, no menu button', async () => {
        narrow = false;
        renderWithRouter('/costs', AUTH.visitor);
        await headline();
        expect(screen.getAllByRole('navigation')).toHaveLength(1);
        expect(screen.queryByRole('button', { name: 'Menu' })).toBeNull();
        expect(pageName()).toBeNull();
        const links = within(primaryNav() as HTMLElement).getAllByRole('link');
        expect(links.map((l) => l.textContent)).toEqual(NAV_ITEMS.map((i) => i.label));
    });

    it('growing past it closes the panel and shows the row; narrowing again shows it closed', async () => {
        const { user, button } = await setup();
        await user.click(button);
        expect(panelLinks()).toHaveLength(NAV_ITEMS.length);
        setNarrow(false);
        expect(screen.queryByRole('button', { name: 'Menu' })).toBeNull();
        expect(screen.getAllByRole('navigation')).toHaveLength(1);
        expect(within(primaryNav() as HTMLElement).getAllByRole('link')).toHaveLength(
            NAV_ITEMS.length,
        );
        setNarrow(true);
        expect(menuButton()).toHaveAttribute('aria-expanded', 'false');
        expect(panelLinks()).toHaveLength(0);
    });
});

describe('the menu button', () => {
    it('is named "Menu", collapsed, and controls the hidden panel inside the nav', async () => {
        const { button } = await setup();
        expect(button).toHaveAttribute('type', 'button');
        expect(button).toHaveAttribute('aria-expanded', 'false');
        expect(button).not.toHaveAttribute('aria-haspopup');
        const p = panel() as HTMLElement;
        expect(p).toBeInTheDocument();
        expect(p).not.toBeVisible();
        expect(primaryNav()).toContainElement(p);
        expect(panelLinks()).toHaveLength(0);
    });

    it('a pointer click opens it with focus left on the button; a second click closes it', async () => {
        const { user, button } = await setup();
        await user.click(button);
        expect(button).toHaveAttribute('aria-expanded', 'true');
        expect(panel()).toBeVisible();
        expect(button).toHaveFocus();
        await user.click(button);
        expect(button).toHaveAttribute('aria-expanded', 'false');
        expect(panelLinks()).toHaveLength(0);
    });

    it.each([
        ['Enter', '{Enter}'],
        ['Space', ' '],
    ])('%s opens it and focuses the first link', async (_label, key) => {
        const { user, button } = await setup();
        button.focus();
        await user.keyboard(key);
        expect(button).toHaveAttribute('aria-expanded', 'true');
        expect(screen.getByRole('link', { name: 'Lobbies' })).toHaveFocus();
    });

    it('lists every item in order as router links, the current one marked', async () => {
        const { user, button } = await setup('/costs');
        await user.click(button);
        const links = panelLinks();
        expect(links.map((l) => l.textContent)).toEqual(NAV_ITEMS.map((i) => i.label));
        expect(links.map((l) => l.getAttribute('href'))).toEqual(NAV_ITEMS.map((i) => i.to));
        for (const link of links) {
            if (link.textContent === 'Cost Tables') {
                expect(link).toHaveAttribute('aria-current', 'page');
            } else expect(link).not.toHaveAttribute('aria-current');
        }
        // A disclosure, not an application menu: no menu roles, links in the Tab order.
        expect(screen.queryByRole('menu')).toBeNull();
        for (const link of links) expect(link).not.toHaveAttribute('tabindex');
    });

    it('the page behind is not made inert', async () => {
        const { user, button } = await setup();
        await user.click(button);
        expect(screen.getByRole('main')).not.toHaveAttribute('inert');
        expect(screen.getByRole('main')).not.toHaveAttribute('aria-hidden');
    });
});

describe('closing', () => {
    it('Escape from a link closes it and returns focus to the button', async () => {
        const { user, button } = await setup();
        button.focus();
        await user.keyboard('{Enter}');
        await user.tab();
        expect(screen.getByRole('link', { name: 'Team Builder' })).toHaveFocus();
        await user.keyboard('{Escape}');
        expect(button).toHaveAttribute('aria-expanded', 'false');
        expect(panelLinks()).toHaveLength(0);
        expect(button).toHaveFocus();
    });

    it('Escape after a pointer open closes it and keeps focus on the button', async () => {
        const { user, button } = await setup();
        await user.click(button);
        await user.keyboard('{Escape}');
        expect(button).toHaveAttribute('aria-expanded', 'false');
        expect(button).toHaveFocus();
    });

    it('a pointer press outside closes it', async () => {
        const { user, button } = await setup();
        await user.click(button);
        fireEvent.pointerDown(document.body);
        expect(button).toHaveAttribute('aria-expanded', 'false');
        expect(panelLinks()).toHaveLength(0);
    });

    it('focus moving outside closes it', async () => {
        const { user, button } = await setup();
        await user.click(button);
        act(() => screen.getByRole('link', { name: 'IPC Battlegrounds' }).focus());
        expect(button).toHaveAttribute('aria-expanded', 'false');
    });

    it('Tab past the last link leaves to the account control and closes it (no trap)', async () => {
        const { user, button } = await setup();
        button.focus();
        await user.keyboard('{Enter}');
        for (const { label } of NAV_ITEMS.slice(1)) {
            await user.tab();
            expect(screen.getByRole('link', { name: label })).toHaveFocus();
        }
        await user.tab();
        expect(screen.getByRole('link', { name: 'Sign in' })).toHaveFocus();
        expect(button).toHaveAttribute('aria-expanded', 'false');
        expect(panelLinks()).toHaveLength(0);
    });

    it('Shift+Tab from the first link goes back to the button and keeps it open', async () => {
        const { user, button } = await setup();
        button.focus();
        await user.keyboard('{Enter}');
        await user.tab({ shift: true });
        expect(button).toHaveFocus();
        expect(button).toHaveAttribute('aria-expanded', 'true');
    });

    it('a navigation from elsewhere closes it', async () => {
        const { r, user, button } = await setup();
        await user.click(button);
        act(() => {
            void r.router.navigate({ to: '/lobbies' });
        });
        await resolved(r, '/lobbies');
        await waitFor(() => expect(panelLinks()).toHaveLength(0));
        expect(menuButton()).toHaveAttribute('aria-expanded', 'false');
    });

    it('the back button closes it', async () => {
        const { r, user } = await setup('/costs');
        act(() => {
            void r.router.navigate({ to: '/lobbies' });
        });
        await resolved(r, '/lobbies');
        await user.click(menuButton());
        expect(panelLinks()).toHaveLength(NAV_ITEMS.length);
        act(() => r.router.history.back());
        await resolved(r, '/costs');
        await waitFor(() => expect(panelLinks()).toHaveLength(0));
        expect(menuButton()).toHaveAttribute('aria-expanded', 'false');
    });

    it('a connection splash replacing the shell drops it; the shell comes back closed', async () => {
        const { user, button } = await setup();
        await user.click(button);
        act(() =>
            setConnectionStatus({
                state: 'failed',
                kind: 'offline',
                reason: 'down',
                recovery: 'retry',
            }),
        );
        expect(primaryNav()).toBeNull();
        act(() => setConnectionStatus({ state: 'connecting' }));
        await waitFor(() => expect(primaryNav()).toBeInTheDocument());
        expect(menuButton()).toHaveAttribute('aria-expanded', 'false');
        expect(panelLinks()).toHaveLength(0);
    });
});

describe('choosing a link', () => {
    it('another page: navigates, closes, and the announcer focuses the new h1', async () => {
        const { user, r, button } = await setup('/costs');
        await user.click(button);
        await user.click(within(panel() as HTMLElement).getByRole('link', { name: 'Lobbies' }));
        await resolved(r, '/lobbies');
        expect(panelLinks()).toHaveLength(0);
        expect(menuButton()).toHaveAttribute('aria-expanded', 'false');
        await waitFor(() =>
            expect(announcer()).toHaveTextContent('Lobbies — Standby — IPC Battlegrounds'),
        );
        expect(screen.getByRole('heading', { level: 1 })).toHaveFocus();
    });

    it('by keyboard: Enter on a link navigates and closes', async () => {
        const { user, r, button } = await setup('/costs');
        button.focus();
        await user.keyboard('{Enter}');
        await user.tab();
        await user.keyboard('{Enter}');
        await resolved(r, '/teambuilder');
        expect(panelLinks()).toHaveLength(0);
        expect(pageName()).toHaveTextContent('Team Builder');
    });

    it('the page already shown: closes, focus back on the button, no navigation', async () => {
        const { user, r, button } = await setup('/costs');
        await user.click(button);
        await user.click(within(panel() as HTMLElement).getByRole('link', { name: 'Cost Tables' }));
        expect(button).toHaveAttribute('aria-expanded', 'false');
        expect(panelLinks()).toHaveLength(0);
        expect(button).toHaveFocus();
        await act(() => new Promise((r2) => setTimeout(r2, 50)));
        expect(r.router.state.location.href).toBe('/costs');
        expect(announcer()).toHaveTextContent('');
    });

    it('the same page with a search: goes to the bare path, as the row does; focus on the button', async () => {
        const { user, r, button } = await setup('/costs?el=fire');
        await user.click(button);
        await user.click(within(panel() as HTMLElement).getByRole('link', { name: 'Cost Tables' }));
        await resolved(r, '/costs');
        expect(panelLinks()).toHaveLength(0);
        await waitFor(() => expect(menuButton()).toHaveFocus());
    });

    it('the row (above the switch point) also drops the search for the current page', async () => {
        narrow = false;
        const user = userEvent.setup();
        const r = renderWithRouter('/costs?el=fire', AUTH.visitor);
        await headline();
        await user.click(screen.getByRole('link', { name: 'Cost Tables' }));
        await resolved(r, '/costs');
    });

    it('a Ctrl or Meta click is left to the browser: not prevented, the panel stays open', async () => {
        const { user, r, button } = await setup('/costs');
        await user.click(button);
        for (const modifier of [{ ctrlKey: true }, { metaKey: true }]) {
            const link = within(panel() as HTMLElement).getByRole('link', { name: 'Lobbies' });
            // fireEvent returns false only when a handler called preventDefault.
            expect(fireEvent.click(link, { button: 0, ...modifier })).toBe(true);
            expect(button).toHaveAttribute('aria-expanded', 'true');
        }
        await act(() => new Promise((r2) => setTimeout(r2, 50)));
        expect(r.router.state.location.href).toBe('/costs');
    });

    it('a guarded page as a visitor: the guard sends to the sign-in panel with next', async () => {
        const { user, r, button } = await setup('/costs');
        await user.click(button);
        await user.click(within(panel() as HTMLElement).getByRole('link', { name: 'Tournaments' }));
        await resolved(r, '/?login=1&next=%2Ftournaments');
        expect(await headline()).toHaveTextContent('Sign in.');
        expect(primaryNav()).toBeNull();
    });
});

describe('the page name beside the button', () => {
    it.each([
        ['/lobbies', 'Lobbies', AUTH.visitor],
        ['/teambuilder', 'Team Builder', AUTH.visitor],
        ['/costs', 'Cost Tables', AUTH.visitor],
        ['/tournaments', 'Tournaments', MEMBER],
        ['/calendar', 'Calendar', MEMBER],
    ])(
        '%s shows "%s" as plain text hidden from assistive technology',
        async (path, label, auth) => {
            await setup(path, auth);
            const name = pageName() as HTMLElement;
            expect(name).toHaveTextContent(label);
            expect(name.tagName).toBe('SPAN');
            expect(name).toHaveAttribute('aria-hidden', 'true');
            expect(primaryNav()).toContainElement(name);
        },
    );

    it.each([
        ['/', AUTH.visitor],
        ['/profile', MEMBER],
        ['/lobby/123', MEMBER],
    ])('%s is not a bar item: nothing beside the button', async (path, auth) => {
        await setup(path, auth);
        expect(menuButton()).toBeInTheDocument();
        expect(pageName()).toBeNull();
    });

    it('follows the page after a navigation', async () => {
        const { r } = await setup('/costs');
        act(() => {
            void r.router.navigate({ to: '/calendar' });
        });
        await waitFor(() => expect(pageName()).toHaveTextContent('Calendar'));
    });
});

describe('admin', () => {
    it.each([
        ['visitor', AUTH.visitor],
        ['guest', GUEST],
        ['member', MEMBER],
        ['tournament host', named(AUTH.tournamentHost, 'Host')],
    ])('a %s sees no Admin row and no gear', async (_label, auth) => {
        const { user, button } = await setup('/costs', auth);
        await user.click(button);
        expect(within(panel() as HTMLElement).queryByRole('link', { name: 'Admin' })).toBeNull();
        expect(panelLinks()).toHaveLength(NAV_ITEMS.length);
        expect(screen.queryByRole('link', { name: 'Admin Console' })).toBeNull();
    });

    it.each([
        ['moderator', MODERATOR],
        ['admin', ADMIN],
    ])('a %s gets the Admin row last, and no gear', async (_label, auth) => {
        const { user, button } = await setup('/costs', auth);
        expect(screen.queryByRole('link', { name: 'Admin Console' })).toBeNull();
        await user.click(button);
        const links = panelLinks();
        expect(links).toHaveLength(NAV_ITEMS.length + 1);
        expect(links.at(-1)).toHaveTextContent('Admin');
        expect(links.at(-1)).toHaveAttribute('href', '/admin');
        expect(links.at(-1)).not.toHaveAttribute('aria-current');
    });

    it('on /admin the Admin row is current and named beside the button', async () => {
        const { user, button } = await setup('/admin', ADMIN);
        expect(pageName()).toHaveTextContent('Admin');
        await user.click(button);
        expect(within(panel() as HTMLElement).getByRole('link', { name: 'Admin' })).toHaveAttribute(
            'aria-current',
            'page',
        );
    });

    it('the Admin row follows a live role change', async () => {
        const { user } = await setup('/costs', MEMBER);
        act(() => setAuthSnapshot(ADMIN));
        await user.click(menuButton());
        expect(
            within(panel() as HTMLElement).getByRole('link', { name: 'Admin' }),
        ).toBeInTheDocument();
    });
});

describe('the reconnecting line', () => {
    it('moves below the open panel and back when it closes', async () => {
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
            height: 255,
        } as DOMRect);
        const { user, button } = await setup();
        const region = document.querySelector('[data-connection-banner]') as HTMLElement;
        expect(region.style.getPropertyValue('--menu-inset')).toBe('');
        await user.click(button);
        expect(region.style.getPropertyValue('--menu-inset')).toBe('255px');
        await user.click(button);
        expect(region.style.getPropertyValue('--menu-inset')).toBe('');
    });
});

describe('focus when the bar switches form', () => {
    it('a focused panel link: growing past the switch point focuses the current row link', async () => {
        const { user, button } = await setup('/costs');
        button.focus();
        await user.keyboard('{Enter}');
        expect(screen.getByRole('link', { name: 'Lobbies' })).toHaveFocus();
        setNarrow(false);
        const row = screen.getByRole('link', { name: 'Cost Tables' });
        expect(row).toHaveAttribute('aria-current', 'page');
        expect(row).toHaveFocus();
    });

    it('on a page that is not a bar item, growing focuses the first row link', async () => {
        const { user, button } = await setup('/profile', MEMBER);
        button.focus();
        await user.keyboard('{Enter}');
        setNarrow(false);
        expect(screen.getByRole('link', { name: 'Lobbies' })).toHaveFocus();
    });

    it('the closed Menu button focused: growing focuses the current row link', async () => {
        const { button } = await setup('/teambuilder');
        act(() => button.focus());
        setNarrow(false);
        expect(screen.getByRole('link', { name: 'Team Builder' })).toHaveFocus();
    });

    it('a focused row link: narrowing focuses the Menu button', async () => {
        narrow = false;
        renderWithRouter('/costs', AUTH.visitor);
        await headline();
        act(() => screen.getByRole('link', { name: 'Calendar' }).focus());
        setNarrow(true);
        expect(menuButton()).toHaveFocus();
    });

    it('focus elsewhere (the account control): nothing moves either way', async () => {
        await setup('/costs');
        const signIn = screen.getByRole('link', { name: 'Sign in' });
        act(() => signIn.focus());
        setNarrow(false);
        expect(signIn).toHaveFocus();
        setNarrow(true);
        expect(signIn).toHaveFocus();
    });
});

describe('focus when the focused row goes away', () => {
    it('staff losing the role with focus on the Admin row: focus moves to the Menu button', async () => {
        const { user, button } = await setup('/costs', ADMIN);
        button.focus();
        await user.keyboard('{Enter}');
        const admin = within(panel() as HTMLElement).getByRole('link', { name: 'Admin' });
        act(() => admin.focus());
        act(() => setAuthSnapshot(MEMBER));
        await waitFor(() =>
            expect(
                within(panel() as HTMLElement).queryByRole('link', { name: 'Admin' }),
            ).toBeNull(),
        );
        expect(menuButton()).toHaveAttribute('aria-expanded', 'true');
        expect(menuButton()).toHaveFocus();
    });
});

describe('more closing and lifecycle rules', () => {
    it('a navigation that keeps the page (a search-only change) still closes it', async () => {
        const { r, user, button } = await setup('/costs');
        await user.click(button);
        act(() => r.router.history.push('/costs?el=fire'));
        await waitFor(() => expect(r.router.state.resolvedLocation?.href).toBe('/costs?el=fire'));
        await waitFor(() => expect(button).toHaveAttribute('aria-expanded', 'false'));
        expect(panelLinks()).toHaveLength(0);
    });

    it('the links exist in the DOM only while the panel is open (hidden content included)', async () => {
        const { user, button } = await setup('/costs');
        const p = panel() as HTMLElement;
        expect(p.querySelectorAll('a')).toHaveLength(0);
        expect(within(p).queryAllByRole('link', { hidden: true })).toHaveLength(0);
        await user.click(button);
        expect(p.querySelectorAll('a')).toHaveLength(NAV_ITEMS.length);
        await user.click(button);
        expect(p.querySelectorAll('a')).toHaveLength(0);
    });

    it('Escape with focus outside the nav closes it without pulling focus to the button', async () => {
        const { button } = await setup('/costs');
        const signIn = screen.getByRole('link', { name: 'Sign in' });
        act(() => signIn.focus());
        // A press that does not move focus (a browser where buttons take no focus on click).
        fireEvent.click(button, { detail: 1 });
        expect(button).toHaveAttribute('aria-expanded', 'true');
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(button).toHaveAttribute('aria-expanded', 'false');
        expect(signIn).toHaveFocus();
    });

    it('the document listeners are added on open and the same ones removed on close', async () => {
        const add = vi.spyOn(document, 'addEventListener');
        const remove = vi.spyOn(document, 'removeEventListener');
        const { user, button } = await setup('/costs');
        const types = ['pointerdown', 'focusin', 'keydown'];
        const mine = (calls: unknown[][]) =>
            calls
                .filter(([type]) => types.includes(type as string))
                .map(([type, fn]) => [type, fn]);
        add.mockClear();
        remove.mockClear();
        await user.click(button);
        const added = mine(add.mock.calls);
        expect(added.map(([type]) => type).sort()).toEqual([...types].sort());
        await user.click(button);
        const removed = mine(remove.mock.calls);
        for (const pair of added) expect(removed).toContainEqual(pair);
    });

    it('the matchMedia listener is removed when the bar unmounts', async () => {
        const r = renderWithRouter('/costs', AUTH.visitor);
        await headline();
        expect(listeners.size).toBeGreaterThan(0);
        r.unmount();
        expect(listeners.size).toBe(0);
    });
});

describe('which item is current', () => {
    it('an item is current on its path and below it, never on a mere prefix', () => {
        expect(currentItem(NAV_ITEMS, '/lobbies')?.label).toBe('Lobbies');
        expect(currentItem(NAV_ITEMS, '/lobbies/x')?.label).toBe('Lobbies');
        expect(currentItem(NAV_ITEMS, '/lobbiesx')).toBeUndefined();
        expect(currentItem(NAV_ITEMS, '/lobby/123')).toBeUndefined();
        expect(currentItem(NAV_ITEMS, '/')).toBeUndefined();
    });
});
