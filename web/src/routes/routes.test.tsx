import { act, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { setAuthSnapshot } from '@/auth/authStore';
import { AUTH, renderWithRouter } from '@/test/renderWithRouter';

/*
 * The real `App` and route tree with the app's router options (docs/frontend/pages.md
 * "Routes (M4)", guards, the `next` rule, A169 plain-text search). `href` is path + search + hash
 * as the router holds it after redirects and search rewrites.
 */
type Rendered = ReturnType<typeof renderWithRouter>;
const href = ({ router }: Rendered) => router.state.location.href;

/** Waits until the router has finished loading `expected` (not merely started on it). */
async function expectResolved(rendered: Rendered, expected: string) {
    await waitFor(() => {
        expect(rendered.router.state.resolvedLocation?.href).toBe(expected);
        expect(href(rendered)).toBe(expected);
    });
}

/** Waits for the one h1 on screen and checks its text. */
async function expectHeadline(text: string) {
    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent(text);
}

/** Waits for the standby pill naming `module`. */
async function expectStandbyModule(module: string) {
    await expectHeadline('Module offline.');
    expect(screen.getByText(module)).toBeInTheDocument();
}

describe('guards: visitors are sent to sign in', () => {
    it('visitor on /lobby/123 ends on /?login=1&next=%2Flobby%2F123', async () => {
        const r = renderWithRouter('/lobby/123', AUTH.visitor);
        await expectResolved(r, '/?login=1&next=%2Flobby%2F123');
        // M5b: /?login=1 renders the sign-in panel (was the standby page).
        await expectHeadline('Sign in.');
        expect(screen.queryByText('Lobby Room')).toBeNull();
    });

    it('visitor on /profile is redirected to sign in with next=/profile', async () => {
        const r = renderWithRouter('/profile', AUTH.visitor);
        await expectResolved(r, '/?login=1&next=%2Fprofile');
        expect(screen.queryByText('Profile')).toBeNull();
    });

    it('visitor on /admin is redirected to sign in with next=/admin', async () => {
        const r = renderWithRouter('/admin', AUTH.visitor);
        await expectResolved(r, '/?login=1&next=%2Fadmin');
        expect(screen.queryByText('Admin Console')).toBeNull();
        // M5b: the sign-in eyebrow reads "Access // Sign in"; the no-access page must not show.
        expect(screen.queryByText(/Access denied/)).toBeNull();
    });
});

describe('guards: signed-in users', () => {
    it('guest on /profile renders the profile placeholder (guests count as signed in)', async () => {
        const r = renderWithRouter('/profile', AUTH.guest);
        await expectStandbyModule('Profile');
        expect(href(r)).toBe('/profile');
    });

    it.each([
        ['guest', AUTH.guest],
        ['member', AUTH.member],
        ['tournament host', AUTH.tournamentHost],
    ])('%s on /admin sees "Access denied" and the path stays /admin', async (_label, auth) => {
        const r = renderWithRouter('/admin', auth);
        await expectHeadline('Access denied.');
        expect(screen.queryByText('Admin Console')).toBeNull();
        expect(href(r)).toBe('/admin');
    });

    it.each([
        ['moderator', AUTH.moderator],
        ['admin', AUTH.admin],
    ])('%s on /admin sees the admin placeholder', async (_label, auth) => {
        const r = renderWithRouter('/admin', auth);
        await expectStandbyModule('Admin Console');
        expect(href(r)).toBe('/admin');
    });
});

describe('guards: live auth changes', () => {
    it('member to visitor on /profile redirects to sign in', async () => {
        const r = renderWithRouter('/profile', AUTH.member);
        await expectStandbyModule('Profile');
        act(() => setAuthSnapshot(AUTH.visitor));
        await expectResolved(r, '/?login=1&next=%2Fprofile');
        await waitFor(() => expect(screen.queryByText('Profile')).toBeNull());
    });

    it('member to moderator and back on /admin switches the view in place, path unchanged', async () => {
        const r = renderWithRouter('/admin', AUTH.member);
        await expectHeadline('Access denied.');
        act(() => setAuthSnapshot(AUTH.moderator));
        await expectStandbyModule('Admin Console');
        act(() => setAuthSnapshot(AUTH.member));
        await expectHeadline('Access denied.');
        expect(href(r)).toBe('/admin');
    });

    it('not ready on a guarded route renders no main and does not redirect', async () => {
        const r = renderWithRouter('/profile', AUTH.notReady);
        await expectResolved(r, '/profile');
        expect(screen.queryByRole('main')).toBeNull();
    });

    it('not ready to ready as a visitor redirects to sign in', async () => {
        const r = renderWithRouter('/profile', AUTH.notReady);
        await expectResolved(r, '/profile');
        act(() => setAuthSnapshot(AUTH.visitor));
        await expectResolved(r, '/?login=1&next=%2Fprofile');
        await expectHeadline('Sign in.'); // M5b: the sign-in panel (was the standby page)
    });

    it('not ready to ready as a member renders the route', async () => {
        const r = renderWithRouter('/profile', AUTH.notReady);
        await expectResolved(r, '/profile');
        act(() => setAuthSnapshot(AUTH.member));
        await expectStandbyModule('Profile');
        expect(href(r)).toBe('/profile');
    });
});

describe('straight 404 under guarded areas and elsewhere', () => {
    for (const path of ['/admin/zzz', '/profile/zzz', '/lobby', '/does-not-exist']) {
        it.each([
            ['visitor', AUTH.visitor],
            ['admin', AUTH.admin],
        ])(`${path} shows "Page not found" for %s, path unchanged`, async (_label, auth) => {
            const r = renderWithRouter(path, auth);
            await expectHeadline('Page not found.');
            expect(href(r)).toBe(path);
        });
    }
});

describe('search params', () => {
    it('/standby?module=Tournaments shows the pill and sets the title', async () => {
        const r = renderWithRouter('/standby?module=Tournaments');
        await expectStandbyModule('Tournaments');
        await waitFor(() =>
            expect(document.title).toBe('Tournaments — Standby — IPC Battlegrounds'),
        );
        expect(href(r)).toBe('/standby?module=Tournaments');
    });

    it('/standby?module=123 keeps the plain text value (no JSON quoting)', async () => {
        const r = renderWithRouter('/standby?module=123');
        await expectStandbyModule('123');
        expect(href(r)).toBe('/standby?module=123');
    });

    it('/standby?module=a&module=b drops the repeated key and ends on /standby', async () => {
        const r = renderWithRouter('/standby?module=a&module=b');
        await expectResolved(r, '/standby');
        await expectHeadline('Module offline.');
        expect(screen.queryByText('Requested module')).toBeNull();
    });

    // M5b: a page with login=1 is the sign-in panel (was the standby page).
    it.each([
        ['/?next=//evil.example', '/', 'Module offline.'],
        ['/?next=https://evil.example', '/', 'Module offline.'],
        ['/?login=1&next=/%5Cevil.example', '/?login=1', 'Sign in.'],
    ])('%s drops the unsafe next and ends on %s', async (start, end, headline) => {
        const r = renderWithRouter(start);
        await expectResolved(r, end);
        await expectHeadline(headline);
    });

    it('keeps an unknown search key in the URL', async () => {
        const r = renderWithRouter('/standby?module=Lobbies&utm=x');
        await expectStandbyModule('Lobbies');
        expect(r.router.state.location.search).toMatchObject({ module: 'Lobbies', utm: 'x' });
        expect(href(r)).toContain('utm=x');
    });
});
