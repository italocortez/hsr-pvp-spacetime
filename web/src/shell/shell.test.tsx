import {
    createMemoryHistory,
    createRootRoute,
    createRoute,
    createRouter,
    Outlet,
    RouterProvider,
} from '@tanstack/react-router';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AuthSnapshot, setAuthSnapshot } from '@/auth/authStore';
import { loadSignInPage } from '@/pages/sign-in/signInPanel';
import { AUTH, renderWithRouter } from '@/test/renderWithRouter';
import { accountActions, initialOf } from './AccountArea';
import { NAV_ITEMS } from './NavBar';
import { RouteAnnouncer } from './RouteAnnouncer';

// The real sign-out reloads the page; this stands in for it (and proves the call is synchronous).
const { signOutMock } = vi.hoisted(() => ({ signOutMock: vi.fn() }));
vi.mock('@/auth/signOut', () => ({ signOut: signOutMock }));

/*
 * T-SHELL (S14.1): the app shell through the real App and route tree (memory history): which
 * screens are inside it, the landmarks, the bar's items and active state, the admin item, the
 * account area per auth state, the account menu by keyboard and pointer, the scroll chevrons,
 * and focus plus announcement after a client-side navigation.
 */

const named = (auth: AuthSnapshot, displayName: string): AuthSnapshot =>
    auth.user ? { ...auth, user: { ...auth.user, displayName } } : auth;
const MEMBER = named(AUTH.member, 'Trailblazer');
const GUEST = named(AUTH.guest, 'Guest 0001');
const MODERATOR = named(AUTH.moderator, 'March 7th');
const ADMIN = named(AUTH.admin, 'Nathyron');

type Rendered = ReturnType<typeof renderWithRouter>;

async function resolved(r: Rendered, href: string) {
    await waitFor(() => {
        expect(r.router.state.resolvedLocation?.href).toBe(href);
    });
}

/** The page's h1 once rendered. */
const headline = () => screen.findByRole('heading', { level: 1 });
const primaryNav = () => screen.queryByRole('navigation', { name: 'Primary' });
const announcer = () => document.querySelector('[data-route-announcer]') as HTMLElement;

// `/?login=1` resolves only once the sign-in panel's chunk has loaded (the `/` loader). Loaded
// once up front so no case waits on a module transform; the cold path is pinned in
// signInFocus.test.tsx and signInFrame.test.tsx.
// (Awaited in a block: a hook that returns a function has it called as its teardown.)
beforeAll(async () => {
    await loadSignInPage();
}, 30_000);

afterEach(() => {
    vi.restoreAllMocks();
});

describe('which screens render inside the shell', () => {
    it.each([
        ['/', AUTH.visitor],
        // S14.2: /costs is ported (its own test file covers it); /lobbies stands in as a visitor.
        ['/lobbies', AUTH.visitor],
        ['/teambuilder', AUTH.visitor],
        ['/lobbies', GUEST],
        ['/profile', MEMBER],
        ['/calendar', MEMBER],
        ['/tournaments', MEMBER],
        ['/lobby/123', MEMBER],
        ['/admin', MODERATOR],
        ['/admin', ADMIN],
    ])('%s: one main, one h1, the named Primary nav, a banner header', async (path, auth) => {
        renderWithRouter(path, auth);
        expect(await headline()).toHaveTextContent('Module offline.');
        expect(screen.getAllByRole('main')).toHaveLength(1);
        expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
        expect(screen.getAllByRole('navigation')).toHaveLength(1);
        expect(primaryNav()).toBeInTheDocument();
        expect(screen.getByRole('banner')).toBeInTheDocument();
        // The standby block inside the shell has no second brand link.
        expect(screen.queryAllByRole('link', { name: 'IPC Battlegrounds' })).toHaveLength(1);
        expect(screen.getByRole('main')).toHaveAttribute('id', 'main');
    });

    it.each([
        ['/standby', AUTH.visitor, 'Module offline.'],
        ['/standby?module=Tournaments', MEMBER, 'Module offline.'],
        ['/?login=1', AUTH.visitor, 'Sign in.'],
        ['/does-not-exist', AUTH.visitor, 'Page not found.'],
        ['/admin/zzz', ADMIN, 'Page not found.'],
        ['/lobby/abc', MEMBER, 'Lobby not found.'],
        ['/admin', MEMBER, 'Access denied.'],
        ['/admin', GUEST, 'Access denied.'],
    ])('%s is a splash: no bar, its own one main and one h1', async (path, auth, text) => {
        renderWithRouter(path, auth);
        expect(await headline()).toHaveTextContent(text);
        expect(primaryNav()).toBeNull();
        expect(screen.queryByRole('banner')).toBeNull();
        expect(screen.queryByRole('link', { name: 'Skip to main content' })).toBeNull();
        expect(screen.getAllByRole('main')).toHaveLength(1);
        expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    });

    it('a live role change on /admin switches between the splash and the shell in place', async () => {
        const r = renderWithRouter('/admin', MEMBER);
        expect(await headline()).toHaveTextContent('Access denied.');
        expect(primaryNav()).toBeNull();
        act(() => setAuthSnapshot(MODERATOR));
        await waitFor(() => expect(primaryNav()).toBeInTheDocument());
        expect(await headline()).toHaveTextContent('Module offline.');
        expect(r.router.state.location.href).toBe('/admin');
    });
});

describe('skip link', () => {
    it('is the first focusable element and moves focus to main', async () => {
        const user = userEvent.setup();
        renderWithRouter('/costs', AUTH.visitor);
        await headline();
        await user.tab();
        const skip = screen.getByRole('link', { name: 'Skip to main content' });
        expect(skip).toHaveFocus();
        await user.keyboard('{Enter}');
        expect(screen.getByRole('main')).toHaveFocus();
    });
});

describe('bar items and active state', () => {
    it('lists the five items in the mockups order, as router links', async () => {
        renderWithRouter('/costs', AUTH.visitor);
        await headline();
        const links = within(primaryNav() as HTMLElement).getAllByRole('link');
        expect(links.map((l) => l.textContent)).toEqual(NAV_ITEMS.map((i) => i.label));
        expect(links.map((l) => l.getAttribute('href'))).toEqual(NAV_ITEMS.map((i) => i.to));
    });

    it.each([
        ['/lobbies', 'Lobbies', AUTH.visitor],
        ['/teambuilder', 'Team Builder', AUTH.visitor],
        ['/costs', 'Cost Tables', AUTH.visitor],
        ['/tournaments', 'Tournaments', MEMBER],
        ['/calendar', 'Calendar', MEMBER],
    ])('%s marks "%s" as the current page, and only it', async (path, label, auth) => {
        renderWithRouter(path, auth);
        await headline();
        const nav = primaryNav() as HTMLElement;
        for (const link of within(nav).getAllByRole('link')) {
            if (link.textContent === label) expect(link).toHaveAttribute('aria-current', 'page');
            else expect(link).not.toHaveAttribute('aria-current');
        }
        expect(screen.getByRole('link', { name: 'IPC Battlegrounds' })).not.toHaveAttribute(
            'aria-current',
        );
    });

    it('the home mark is current on / (and on no item)', async () => {
        renderWithRouter('/', AUTH.visitor);
        await headline();
        expect(screen.getByRole('link', { name: 'IPC Battlegrounds' })).toHaveAttribute(
            'aria-current',
            'page',
        );
        for (const link of within(primaryNav() as HTMLElement).getAllByRole('link')) {
            expect(link).not.toHaveAttribute('aria-current');
        }
    });

    it('/profile and /lobby/123 mark no item', async () => {
        renderWithRouter('/lobby/123', MEMBER);
        await headline();
        for (const link of within(primaryNav() as HTMLElement).getAllByRole('link')) {
            expect(link).not.toHaveAttribute('aria-current');
        }
    });

    it('a click on an item navigates without a reload and moves the current mark', async () => {
        const user = userEvent.setup();
        const r = renderWithRouter('/costs', AUTH.visitor);
        await headline();
        await user.click(screen.getByRole('link', { name: 'Team Builder' }));
        await resolved(r, '/teambuilder');
        expect(screen.getByRole('link', { name: 'Team Builder' })).toHaveAttribute(
            'aria-current',
            'page',
        );
        expect(screen.getByRole('link', { name: 'Cost Tables' })).not.toHaveAttribute(
            'aria-current',
        );
    });
});

describe('the admin item', () => {
    it.each([
        ['visitor', AUTH.visitor],
        ['guest', GUEST],
        ['member', MEMBER],
        ['tournament host', named(AUTH.tournamentHost, 'Host')],
    ])('is absent for a %s', async (_label, auth) => {
        renderWithRouter('/costs', auth);
        await headline();
        expect(screen.queryByRole('link', { name: 'Admin Console' })).toBeNull();
    });

    it.each([
        ['moderator', MODERATOR],
        ['admin', ADMIN],
    ])('is shown to a %s and links to /admin', async (_label, auth) => {
        renderWithRouter('/costs', auth);
        await headline();
        const gear = screen.getByRole('link', { name: 'Admin Console' });
        expect(gear).toHaveAttribute('href', '/admin');
        expect(gear).not.toHaveAttribute('aria-current');
    });

    it('is current on /admin', async () => {
        renderWithRouter('/admin', ADMIN);
        await headline();
        expect(screen.getByRole('link', { name: 'Admin Console' })).toHaveAttribute(
            'aria-current',
            'page',
        );
    });

    it('appears and goes with a live role change', async () => {
        renderWithRouter('/costs', MEMBER);
        await headline();
        expect(screen.queryByRole('link', { name: 'Admin Console' })).toBeNull();
        act(() => setAuthSnapshot(ADMIN));
        expect(await screen.findByRole('link', { name: 'Admin Console' })).toBeInTheDocument();
        act(() => setAuthSnapshot(MEMBER));
        await waitFor(() =>
            expect(screen.queryByRole('link', { name: 'Admin Console' })).toBeNull(),
        );
    });
});

describe('account area', () => {
    const slot = () => document.querySelector('[data-account-slot]') as HTMLElement;

    it('not ready: a hidden placeholder, no control; the slot keeps its class when ready', async () => {
        // An unported page (S14.2: /costs now has buttons of its own).
        renderWithRouter('/teambuilder', AUTH.notReady);
        await headline();
        const before = slot().className;
        const placeholder = slot().querySelector('[data-account="pending"]');
        expect(placeholder).toHaveAttribute('aria-hidden', 'true');
        expect(screen.queryByRole('link', { name: 'Sign in' })).toBeNull();
        expect(screen.queryByRole('button', { name: /./ })).toBeNull();

        act(() => setAuthSnapshot(AUTH.visitor));
        expect(await screen.findByRole('link', { name: 'Sign in' })).toBeInTheDocument();
        expect(slot().className).toBe(before);
        expect(slot().querySelector('[data-account="pending"]')).toBeNull();

        act(() => setAuthSnapshot(MEMBER));
        expect(await screen.findByRole('button', { name: 'Trailblazer' })).toBeInTheDocument();
        expect(slot().className).toBe(before);
    });

    it.each([
        ['visitor', AUTH.visitor],
        ['guest', GUEST],
    ])('%s: "Sign in" links to /?login=1 with next = this page', async (_label, auth) => {
        renderWithRouter('/costs', auth);
        await headline();
        expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute(
            'href',
            '/?login=1&next=%2Fcosts',
        );
        expect(screen.queryByRole('button', { name: /Guest/ })).toBeNull();
    });

    it('the next of "Sign in" keeps the search and hash of the page', async () => {
        renderWithRouter('/costs?el=fire#top', AUTH.visitor);
        await headline();
        const href = screen.getByRole('link', { name: 'Sign in' }).getAttribute('href') ?? '';
        expect(new URLSearchParams(href.split('?')[1]).get('next')).toBe('/costs?el=fire#top');
        expect(new URLSearchParams(href.split('?')[1]).get('login')).toBe('1');
    });

    it('a click on "Sign in" opens the sign-in panel, and it returns to the page after', async () => {
        const user = userEvent.setup();
        const r = renderWithRouter('/teambuilder', AUTH.visitor);
        await headline();
        await user.click(screen.getByRole('link', { name: 'Sign in' }));
        await resolved(r, '/?login=1&next=%2Fteambuilder');
        expect(await headline()).toHaveTextContent('Sign in.');
        expect(primaryNav()).toBeNull();
    });

    it('member: the chip names the user, shows the initial, and is a closed menu button', async () => {
        renderWithRouter('/costs', MEMBER);
        await headline();
        const trigger = screen.getByRole('button', { name: 'Trailblazer' });
        expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
        expect(trigger).toHaveAttribute('aria-expanded', 'false');
        expect(trigger).toHaveTextContent('T');
        expect(screen.queryByRole('menu')).toBeNull();
        expect(screen.queryByRole('link', { name: 'Sign in' })).toBeNull();
    });

    it('member without a display name: "Account"', async () => {
        renderWithRouter('/costs', AUTH.member);
        await headline();
        expect(screen.getByRole('button', { name: 'Account' })).toBeInTheDocument();
    });

    it('initialOf takes the first grapheme and upper-cases it', () => {
        expect(initialOf('kafka')).toBe('K');
        expect(initialOf('  march')).toBe('M');
        expect(initialOf('\u{1F600}x')).toBe('\u{1F600}');
        expect(initialOf('')).toBe('?');
        // A letter with a combining mark, an emoji sequence and a flag stay whole.
        expect(initialOf('éclair')).toBe('É');
        expect(initialOf('\u{1F469}‍\u{1F680}x')).toBe('\u{1F469}‍\u{1F680}');
        expect(initialOf('\u{1F1EF}\u{1F1F5}x')).toBe('\u{1F1EF}\u{1F1F5}');
    });

    it('initialOf never turns one character into two (ß upper-cases to "SS")', () => {
        expect(initialOf('ßtrasse')).toBe('ß');
        expect(initialOf('ŉx')).toBe('ŉ');
    });

    it('initialOf falls back to one whole code point without Intl.Segmenter', () => {
        const segmenter = Intl.Segmenter;
        // biome-ignore lint/suspicious/noExplicitAny: removing a built-in for this case only
        delete (Intl as any).Segmenter;
        try {
            expect(initialOf('\u{1F600}x')).toBe('\u{1F600}');
            expect(initialOf('kafka')).toBe('K');
        } finally {
            Object.defineProperty(Intl, 'Segmenter', {
                value: segmenter,
                configurable: true,
                writable: true,
            });
        }
    });
});

describe('account menu', () => {
    async function setup(path = '/costs') {
        const user = userEvent.setup();
        const r = renderWithRouter(path, MEMBER);
        await headline();
        const trigger = screen.getByRole('button', { name: 'Trailblazer' });
        return { user, r, trigger };
    }
    const item = (name: string) => screen.getByRole('menuitem', { name });

    it('Enter opens it and focuses Profile; arrows, Home and End move; Escape closes to the trigger', async () => {
        const { user, trigger } = await setup();
        trigger.focus();
        await user.keyboard('{Enter}');
        expect(trigger).toHaveAttribute('aria-expanded', 'true');
        expect(screen.getByRole('menu', { name: 'Trailblazer' })).toBeVisible();
        expect(item('Profile')).toHaveFocus();
        await user.keyboard('{ArrowDown}');
        expect(item('Sign out')).toHaveFocus();
        await user.keyboard('{ArrowDown}');
        expect(item('Profile')).toHaveFocus();
        await user.keyboard('{ArrowUp}');
        expect(item('Sign out')).toHaveFocus();
        await user.keyboard('{Home}');
        expect(item('Profile')).toHaveFocus();
        await user.keyboard('{End}');
        expect(item('Sign out')).toHaveFocus();
        await user.keyboard('{Escape}');
        expect(screen.queryByRole('menuitem')).toBeNull();
        expect(trigger).toHaveAttribute('aria-expanded', 'false');
        expect(trigger).toHaveFocus();
    });

    it('ArrowDown on the trigger opens it and enters it', async () => {
        const { user, trigger } = await setup();
        trigger.focus();
        await user.keyboard('{ArrowDown}');
        expect(trigger).toHaveAttribute('aria-expanded', 'true');
        expect(item('Profile')).toHaveFocus();
    });

    it('a pointer click opens it with focus left on the trigger; a second click closes it', async () => {
        const { user, trigger } = await setup();
        await user.click(trigger);
        expect(trigger).toHaveAttribute('aria-expanded', 'true');
        expect(item('Profile')).toBeInTheDocument();
        expect(trigger).toHaveFocus();
        await user.click(trigger);
        expect(trigger).toHaveAttribute('aria-expanded', 'false');
        expect(screen.queryByRole('menuitem')).toBeNull();
    });

    it('the items are out of the Tab order; Tab leaves and closes it (no trap)', async () => {
        const { user, trigger } = await setup();
        trigger.focus();
        await user.keyboard('{Enter}');
        expect(item('Profile')).toHaveAttribute('tabindex', '-1');
        expect(item('Sign out')).toHaveAttribute('tabindex', '-1');
        await user.tab();
        expect(screen.queryByRole('menuitem')).toBeNull();
        expect(trigger).toHaveAttribute('aria-expanded', 'false');
    });

    it('a pointer press outside closes it (no focus change involved)', async () => {
        const { user, trigger } = await setup();
        await user.click(trigger);
        expect(trigger).toHaveAttribute('aria-expanded', 'true');
        // A press on the page background: no focus moves, so only the pointer listener can close.
        fireEvent.pointerDown(document.body);
        expect(trigger).toHaveAttribute('aria-expanded', 'false');
        expect(screen.queryByRole('menuitem')).toBeNull();
    });

    it('focus moving outside closes it (no pointer press involved)', async () => {
        const { user, trigger } = await setup();
        await user.click(trigger);
        expect(trigger).toHaveAttribute('aria-expanded', 'true');
        act(() => screen.getByRole('link', { name: 'IPC Battlegrounds' }).focus());
        expect(trigger).toHaveAttribute('aria-expanded', 'false');
        expect(screen.queryByRole('menuitem')).toBeNull();
    });

    it('Escape on the trigger (after a pointer open) closes it and keeps focus on the trigger', async () => {
        const { user, trigger } = await setup();
        await user.click(trigger);
        expect(trigger).toHaveFocus();
        await user.keyboard('{Escape}');
        expect(trigger).toHaveAttribute('aria-expanded', 'false');
        expect(screen.queryByRole('menuitem')).toBeNull();
        expect(trigger).toHaveFocus();
    });

    it('Space on Profile navigates to /profile like Enter', async () => {
        const { user, r, trigger } = await setup();
        trigger.focus();
        await user.keyboard('{Enter}');
        expect(item('Profile')).toHaveFocus();
        await user.keyboard(' ');
        await resolved(r, '/profile');
        expect(screen.queryByRole('menuitem')).toBeNull();
    });

    it('Profile navigates to /profile and the menu closes', async () => {
        const { user, r, trigger } = await setup();
        trigger.focus();
        await user.keyboard('{Enter}');
        await user.keyboard('{Enter}');
        await resolved(r, '/profile');
        expect(screen.queryByRole('menuitem')).toBeNull();
        expect(screen.getByRole('button', { name: 'Trailblazer' })).toHaveAttribute(
            'aria-expanded',
            'false',
        );
    });

    it('a navigation from elsewhere (a bar link) closes it', async () => {
        const { r, trigger } = await setup();
        fireEvent.click(trigger, { detail: 1 });
        expect(item('Profile')).toBeInTheDocument();
        act(() => {
            void r.router.navigate({ to: '/lobbies' });
        });
        await resolved(r, '/lobbies');
        await waitFor(() => expect(screen.queryByRole('menuitem')).toBeNull());
    });

    it('Sign out signs out on the click itself (a static import, no chunk to wait for)', async () => {
        const { user, trigger } = await setup();
        await user.click(trigger);
        signOutMock.mockClear();
        await user.click(item('Sign out'));
        expect(signOutMock).toHaveBeenCalledTimes(1);
    });

    it('Sign out calls signOut once and closes the menu', async () => {
        const signOut = vi.spyOn(accountActions, 'signOut').mockImplementation(() => {});
        const { user, trigger } = await setup();
        await user.click(trigger);
        await user.click(item('Sign out'));
        expect(signOut).toHaveBeenCalledTimes(1);
        expect(screen.queryByRole('menuitem')).toBeNull();
    });
});

describe('the items row (above the menu switch point): the items scroll, with pointer-only chevrons', () => {
    it('the chevrons are out of the Tab order and hidden from assistive technology', async () => {
        const { container } = renderWithRouter('/costs', AUTH.visitor);
        await headline();
        for (const side of ['left', 'right']) {
            const chevron = container.querySelector(`[data-chevron="${side}"]`);
            expect(chevron).toHaveAttribute('tabindex', '-1');
            expect(chevron).toHaveAttribute('aria-hidden', 'true');
        }
        expect(screen.queryByRole('button', { name: /scroll/i })).toBeNull();
    });

    it('a press on a chevron never moves focus to it (pointer and mouse down are cancelled)', async () => {
        const { container } = renderWithRouter('/costs', AUTH.visitor);
        await headline();
        for (const side of ['left', 'right']) {
            const chevron = container.querySelector(`[data-chevron="${side}"]`) as Element;
            // fireEvent returns false when a handler called preventDefault.
            expect(fireEvent.pointerDown(chevron)).toBe(false);
            expect(fireEvent.mouseDown(chevron)).toBe(false);
        }
    });

    describe('a focused item is scrolled wholly into view', () => {
        const scrollIntoView = vi.fn();
        beforeEach(() => {
            scrollIntoView.mockClear();
            Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
                value: scrollIntoView,
                configurable: true,
                writable: true,
            });
        });
        afterEach(() => {
            delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
            delete (window as { matchMedia?: unknown }).matchMedia;
        });

        it('on focus, nearest on both axes, smooth by default', async () => {
            const user = userEvent.setup();
            renderWithRouter('/costs', AUTH.visitor);
            await headline();
            await user.tab(); // skip link
            await user.tab(); // home mark
            await user.tab(); // Lobbies
            const lobbies = screen.getByRole('link', { name: 'Lobbies' });
            expect(lobbies).toHaveFocus();
            expect(scrollIntoView).toHaveBeenCalledTimes(1);
            expect(scrollIntoView.mock.contexts[0]).toBe(lobbies);
            expect(scrollIntoView).toHaveBeenCalledWith({
                inline: 'nearest',
                block: 'nearest',
                behavior: 'smooth',
            });
        });

        it('without smooth scrolling under reduced motion', async () => {
            Object.defineProperty(window, 'matchMedia', {
                configurable: true,
                writable: true,
                value: (query: string) => ({
                    matches: query === '(prefers-reduced-motion: reduce)',
                    media: query,
                    addEventListener() {},
                    removeEventListener() {},
                }),
            });
            renderWithRouter('/costs', AUTH.visitor);
            await headline();
            act(() => screen.getByRole('link', { name: 'Calendar' }).focus());
            expect(scrollIntoView).toHaveBeenCalledWith({
                inline: 'nearest',
                block: 'nearest',
                behavior: 'auto',
            });
        });
    });

    it('a window resize re-centres the current item when it is not wholly visible', async () => {
        const { container } = renderWithRouter('/calendar', MEMBER);
        await headline();
        const list = container.querySelector('nav ul') as HTMLElement;
        const current = list.querySelector('[aria-current="page"]') as HTMLElement;
        // jsdom has no layout: give the list and the current item a narrow-screen geometry.
        let scrollLeft = 0;
        Object.defineProperty(list, 'clientWidth', { configurable: true, value: 136 });
        Object.defineProperty(list, 'scrollLeft', {
            configurable: true,
            get: () => scrollLeft,
            set: (v: number) => {
                scrollLeft = v;
            },
        });
        Object.defineProperty(current, 'offsetLeft', { configurable: true, value: 560 });
        Object.defineProperty(current, 'offsetWidth', { configurable: true, value: 113 });
        act(() => {
            window.dispatchEvent(new Event('resize'));
        });
        // Centred: 560 - (136 - 113) / 2.
        expect(scrollLeft).toBe(548.5);
        scrollLeft = 0;
        act(() => {
            window.dispatchEvent(new Event('orientationchange'));
        });
        expect(scrollLeft).toBe(548.5);
    });

    it('a chevron click scrolls the list by 150px in its direction', async () => {
        const scrollBy = vi.fn();
        Object.defineProperty(HTMLElement.prototype, 'scrollBy', {
            value: scrollBy,
            configurable: true,
            writable: true,
        });
        const { container } = renderWithRouter('/costs', AUTH.visitor);
        await headline();
        fireEvent.click(container.querySelector('[data-chevron="right"]') as Element);
        fireEvent.click(container.querySelector('[data-chevron="left"]') as Element);
        expect(scrollBy.mock.calls.map(([arg]) => arg.left)).toEqual([150, -150]);
        delete (HTMLElement.prototype as { scrollBy?: unknown }).scrollBy;
    });

    it('Tab reaches every item in order (the keyboard path through a scrolled list)', async () => {
        const user = userEvent.setup();
        renderWithRouter('/costs', AUTH.visitor);
        await headline();
        await user.tab(); // skip link
        await user.tab(); // home mark
        expect(screen.getByRole('link', { name: 'IPC Battlegrounds' })).toHaveFocus();
        for (const { label } of NAV_ITEMS) {
            await user.tab();
            expect(screen.getByRole('link', { name: label })).toHaveFocus();
        }
        await user.tab();
        expect(screen.getByRole('link', { name: 'Sign in' })).toHaveFocus();
    });
});

describe('focus and announcement after navigation', () => {
    it('the first load moves no focus and announces nothing', async () => {
        renderWithRouter('/costs', AUTH.visitor);
        await headline();
        await act(() => new Promise((r) => setTimeout(r, 20)));
        expect(document.body).toHaveFocus();
        expect(announcer()).toHaveTextContent('');
        expect(announcer()).toHaveAttribute('aria-live', 'polite');
    });

    it('a first load that a guard redirects moves no focus either', async () => {
        const r = renderWithRouter('/profile', AUTH.visitor);
        await resolved(r, '/?login=1&next=%2Fprofile');
        await headline();
        await act(() => new Promise((r2) => setTimeout(r2, 20)));
        expect(document.body).toHaveFocus();
        expect(announcer()).toHaveTextContent('');
    });

    it('a guard redirect when the profile arrives after load (no input yet) moves no focus', async () => {
        const r = renderWithRouter('/lobby/123', AUTH.notReady);
        await resolved(r, '/lobby/123');
        await act(() => new Promise((r2) => setTimeout(r2, 20)));
        act(() => setAuthSnapshot(AUTH.visitor));
        await resolved(r, '/?login=1&next=%2Flobby%2F123');
        await headline();
        await act(() => new Promise((r2) => setTimeout(r2, 20)));
        expect(document.body).toHaveFocus();
        expect(announcer()).toHaveTextContent('');
    });

    it('the same redirect after the viewer has pressed a key moves focus and announces', async () => {
        const user = userEvent.setup();
        const r = renderWithRouter('/lobby/123', AUTH.notReady);
        await resolved(r, '/lobby/123');
        await act(() => new Promise((r2) => setTimeout(r2, 20)));
        await user.keyboard('{Shift}');
        act(() => setAuthSnapshot(AUTH.visitor));
        await resolved(r, '/?login=1&next=%2Flobby%2F123');
        await waitFor(() => expect(announcer()).toHaveTextContent('Sign in — IPC Battlegrounds'));
        expect(screen.getByRole('heading', { level: 1 })).toHaveFocus();
    });

    it('the first load moves no focus and announces nothing, even after an early key press', async () => {
        // Pins the first-load rule on its own: the viewer has given input (so the first-input
        // rule would allow it), yet the first page is not a navigation.
        const user = userEvent.setup();
        renderWithRouter('/costs', AUTH.visitor);
        await user.keyboard('{Shift}');
        await headline();
        await act(() => new Promise((r) => setTimeout(r, 100)));
        expect(document.body).toHaveFocus();
        expect(announcer()).toHaveTextContent('');
    });

    it('a click counts as the first input (a screen reader in browse mode clicks, no key or pointer)', async () => {
        const r = renderWithRouter('/lobby/123', AUTH.notReady);
        await resolved(r, '/lobby/123');
        await act(() => new Promise((r2) => setTimeout(r2, 50)));
        // A synthetic click only: no keydown, no pointerdown.
        fireEvent.click(document.body);
        act(() => setAuthSnapshot(AUTH.visitor));
        await resolved(r, '/?login=1&next=%2Flobby%2F123');
        await waitFor(() => expect(announcer()).toHaveTextContent('Sign in — IPC Battlegrounds'));
        expect(screen.getByRole('heading', { level: 1 })).toHaveFocus();
    });

    it('a navigation that keeps the path but changes the page (/ to /?login=1) counts', async () => {
        const r = renderWithRouter('/', AUTH.visitor);
        await headline();
        await act(() => new Promise((r2) => setTimeout(r2, 50)));
        fireEvent.keyDown(document.body, { key: 'Shift' });
        act(() => {
            void r.router.navigate({ to: '/', search: { login: 1 } });
        });
        await resolved(r, '/?login=1');
        await waitFor(() => expect(announcer()).toHaveTextContent('Sign in — IPC Battlegrounds'));
        const h1 = screen.getByRole('heading', { level: 1 });
        expect(h1).toHaveTextContent('Sign in.');
        expect(h1).toHaveFocus();
    });

    it('a client-side navigation focuses the new h1 and announces the new title', async () => {
        const user = userEvent.setup();
        const r = renderWithRouter('/costs', AUTH.visitor);
        await headline();
        await user.click(screen.getByRole('link', { name: 'Lobbies' }));
        await resolved(r, '/lobbies');
        await waitFor(() =>
            expect(announcer()).toHaveTextContent('Lobbies — Standby — IPC Battlegrounds'),
        );
        const h1 = screen.getByRole('heading', { level: 1 });
        expect(h1).toHaveFocus();
        expect(h1).toHaveAttribute('tabindex', '-1');
        expect(within(screen.getByRole('main')).getByRole('heading', { level: 1 })).toBe(h1);
    });

    it('a navigation to a splash focuses the splash h1 (same path, new page: the sign-in panel)', async () => {
        const user = userEvent.setup();
        const r = renderWithRouter('/', AUTH.visitor);
        await headline();
        await user.click(screen.getByRole('link', { name: 'Sign in' }));
        await resolved(r, '/?login=1&next=%2F');
        await waitFor(() => expect(announcer()).toHaveTextContent('Sign in — IPC Battlegrounds'));
        expect(screen.getByRole('heading', { level: 1 })).toHaveFocus();
    });

    it('a page with no h1 (not ready on a guarded route) gets focus on main', async () => {
        const user = userEvent.setup();
        const r = renderWithRouter('/costs', AUTH.notReady);
        await headline();
        await user.click(screen.getByRole('link', { name: 'Calendar' }));
        await resolved(r, '/calendar');
        await waitFor(() => expect(screen.getByRole('main')).toHaveFocus());
        expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
        await waitFor(() => expect(announcer()).toHaveTextContent('IPC Battlegrounds'));
    });

    it('a search or hash change that keeps the page and its title moves nothing (after input)', async () => {
        const r = renderWithRouter('/costs', AUTH.visitor);
        await headline();
        await act(() => new Promise((r2) => setTimeout(r2, 60)));
        // Input first, so only the same-page rule can keep this quiet.
        fireEvent.keyDown(document.body, { key: 'Shift' });
        act(() => r.router.history.push('/costs?el=fire'));
        await waitFor(() => expect(r.router.state.resolvedLocation?.href).toBe('/costs?el=fire'));
        await act(() => new Promise((r2) => setTimeout(r2, 100)));
        act(() => r.router.history.push('/costs?el=fire#x'));
        await waitFor(() => expect(r.router.state.resolvedLocation?.hash).toBe('x'));
        await act(() => new Promise((r2) => setTimeout(r2, 100)));
        expect(document.body).toHaveFocus();
        expect(announcer()).toHaveTextContent('');
    });

    it('a search change in the first moments of the first page (after input) moves nothing', async () => {
        // A page that rewrites its own address before it settled (the costs page dropping an
        // unknown set id): the first page's key is recorded at once, so the new address is the
        // same page with no title read yet, not a navigation.
        const r = renderWithRouter('/costs', AUTH.visitor);
        let pushed = false;
        // A few ms after the first page resolved: the announcer has seen it, but its title is
        // not read yet (that takes two checks 16 ms apart). Input first, so only the same-page
        // rule can keep this quiet.
        const off = r.router.subscribe('onResolved', () => {
            if (pushed) return;
            pushed = true;
            setTimeout(() => {
                fireEvent.keyDown(document.body, { key: 'Shift' });
                r.router.history.replace('/costs?el=fire');
            }, 4);
        });
        await resolved(r, '/costs?el=fire');
        off();
        await headline();
        await act(() => new Promise((r2) => setTimeout(r2, 150)));
        expect(document.body).toHaveFocus();
        expect(announcer()).toHaveTextContent('');
    });

    it('two quick navigations: one announcement, for the last page', async () => {
        const r = renderWithRouter('/costs', AUTH.visitor);
        await headline();
        await act(() => new Promise((r2) => setTimeout(r2, 60)));
        fireEvent.keyDown(document.body, { key: 'Shift' });
        const said: string[] = [];
        const observer = new MutationObserver(() => said.push(announcer().textContent ?? ''));
        observer.observe(announcer(), { childList: true, characterData: true, subtree: true });
        // The second one starts the moment the first resolves, before that page can settle
        // (two checks 16 ms apart).
        const off = r.router.subscribe('onResolved', ({ toLocation }) => {
            if (toLocation.pathname === '/lobbies') r.router.history.push('/teambuilder');
        });
        act(() => r.router.history.push('/lobbies'));
        await waitFor(() => expect(r.router.state.resolvedLocation?.href).toBe('/teambuilder'));
        off();
        await waitFor(() => expect(announcer()).toHaveTextContent(/^Team Builder/));
        await act(() => new Promise((r2) => setTimeout(r2, 100)));
        observer.disconnect();
        expect(said.filter((s) => s !== '')).toEqual([document.title]);
    });

    it('a title set late (after the router resolved) is the one announced', async () => {
        const r = renderWithRouter('/costs', AUTH.visitor);
        await headline();
        await act(() => new Promise((r2) => setTimeout(r2, 60)));
        fireEvent.keyDown(document.body, { key: 'Shift' });
        const off = r.router.subscribe('onResolved', () => {
            setTimeout(() => {
                document.title = 'Late title';
            }, 5);
        });
        act(() => r.router.history.push('/lobbies'));
        await waitFor(() => expect(announcer()).toHaveTextContent('Late title'));
        off();
        expect(announcer()).not.toHaveTextContent('Lobbies');
    });
});

describe('the announcer without a main (a bare router)', () => {
    it('never focuses or announces, and its checks stop at the cap', async () => {
        const root = createRootRoute({
            component: () => (
                <>
                    <Outlet />
                    <RouteAnnouncer />
                </>
            ),
        });
        const page = (path: string, title: string) =>
            createRoute({
                getParentRoute: () => root,
                path,
                component: () => {
                    document.title = title;
                    return <h1>{title}</h1>;
                },
            });
        const router = createRouter({
            routeTree: root.addChildren([page('/a', 'Page A'), page('/b', 'Page B')]),
            history: createMemoryHistory({ initialEntries: ['/a'] }),
        });
        const query = vi.spyOn(document, 'querySelector');
        render(<RouterProvider router={router} />);
        await screen.findByRole('heading', { name: 'Page A' });
        fireEvent.keyDown(document.body, { key: 'Shift' });
        const mainChecks = () => query.mock.calls.filter(([s]) => s === 'main').length;
        act(() => router.history.push('/b'));
        await screen.findByRole('heading', { name: 'Page B' });
        const base = mainChecks();
        // Up to 60 checks 16 ms apart for the page, then the loop ends.
        await waitFor(() => expect(mainChecks() - base).toBeGreaterThanOrEqual(55), {
            timeout: 4000,
        });
        await act(() => new Promise((r2) => setTimeout(r2, 200)));
        const atCap = mainChecks();
        expect(atCap - base).toBeLessThanOrEqual(60);
        await act(() => new Promise((r2) => setTimeout(r2, 200)));
        expect(mainChecks()).toBe(atCap);
        expect(document.body).toHaveFocus();
        expect(announcer()).toHaveTextContent('');
    }, 10_000);
});
