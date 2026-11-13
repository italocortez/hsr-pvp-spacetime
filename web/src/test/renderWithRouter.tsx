import { createMemoryHistory, createRouter } from '@tanstack/react-router';
import { cleanup, render } from '@testing-library/react';
import { afterEach } from 'vitest';
import { App } from '@/App';
import { type AuthSnapshot, setAuthSnapshot } from '@/auth/authStore';
import { router as appRouter } from '@/router';

/** Snapshots for each kind of viewer (same shapes as `auth/devAuth.ts`), plus not-ready. */
export const AUTH = {
    notReady: { ready: false },
    visitor: { ready: true },
    guest: { ready: true, user: { id: 1n, role: { tag: 'User' }, isGuest: true } },
    member: { ready: true, user: { id: 2n, role: { tag: 'User' }, isGuest: false } },
    tournamentHost: {
        ready: true,
        user: { id: 5n, role: { tag: 'TournamentHost' }, isGuest: false },
    },
    moderator: { ready: true, user: { id: 3n, role: { tag: 'Moderator' }, isGuest: false } },
    admin: { ready: true, user: { id: 4n, role: { tag: 'Admin' }, isGuest: false } },
} satisfies Record<string, AuthSnapshot>;

// Unmount first (hooks run in reverse order, so the setup file's cleanup would come after the
// reset), then start the next test as a ready visitor (authStore.ts) with a blank title.
afterEach(() => {
    cleanup();
    setAuthSnapshot(AUTH.visitor);
    document.title = '';
});

/**
 * Renders the real `App` at `path` (path, search and hash) with a memory history and the given
 * auth snapshot. The router is a fresh copy of the app's (same options, so the same not-found
 * mode and plain-text search params). Change auth later with `setAuthSnapshot` inside `act`.
 */
export function renderWithRouter(path: string, auth: AuthSnapshot = AUTH.visitor) {
    setAuthSnapshot(auth);
    const router = createRouter({
        ...appRouter.options,
        history: createMemoryHistory({ initialEntries: [path] }),
        context: { auth },
    });
    return { router, ...render(<App router={router} />) };
}
