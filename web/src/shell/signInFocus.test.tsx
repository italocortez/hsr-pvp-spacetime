import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { loadedSignInPage } from '@/pages/sign-in/signInPanel';
import { AUTH, renderWithRouter } from '@/test/renderWithRouter';

/*
 * T-SHELL (S14.1 fix pass): the first navigation to the sign-in panel, with the panel's chunk
 * cold (this file loads it for the first time; vitest gives each file its own module registry).
 * The `/` route's loader loads the chunk before the router resolves, so the route announcer finds
 * the panel's `h1` and its title, not the page that was left. Keep this the only test here.
 */

describe('first navigation to the sign-in panel (cold chunk)', () => {
    it('the first click on "Sign in" from /teambuilder focuses the panel h1 and announces its title', async () => {
        const user = userEvent.setup();
        const r = renderWithRouter('/teambuilder', AUTH.visitor);
        expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent(
            'Module offline.',
        );
        // Cold: nothing in this file has loaded the panel yet.
        expect(loadedSignInPage()).toBeUndefined();
        await user.click(screen.getByRole('link', { name: 'Sign in' }));
        // The router waits on the chunk: a cold module transform can take over a second.
        await waitFor(
            () =>
                expect(r.router.state.resolvedLocation?.href).toBe('/?login=1&next=%2Fteambuilder'),
            { timeout: CHUNK_WAIT_MS },
        );
        // Resolved means loaded: the panel itself renders, not its frame.
        expect(loadedSignInPage()).toBeDefined();
        const announcer = document.querySelector('[data-route-announcer]') as HTMLElement;
        await waitFor(() => expect(announcer).toHaveTextContent('Sign in — IPC Battlegrounds'));
        const h1 = screen.getByRole('heading', { level: 1 });
        expect(h1).toHaveTextContent('Sign in.');
        expect(h1).toHaveFocus();
        expect(h1.isConnected).toBe(true);
        expect(announcer).not.toHaveTextContent('Team Builder');
    }, 30_000);
});

const CHUNK_WAIT_MS = 20_000;
