import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { loadedSignInPage } from '@/pages/sign-in/signInPanel';
import { AUTH, renderWithRouter } from '@/test/renderWithRouter';

/*
 * T-SHELL (S14.1 fix pass): a hard load of `/?login=1` (the Discord return) with the panel's
 * chunk cold (this file loads it for the first time; vitest gives each file its own module
 * registry) paints the panel's splash frame with its `h1` while the chunk loads, not a blank
 * page. Keep this the only test here.
 */

describe('hard load of the sign-in panel (cold chunk)', () => {
    it('shows the splash frame and its h1 before the panel chunk has loaded', async () => {
        const r = renderWithRouter('/?login=1', AUTH.visitor);
        const h1 = await screen.findByRole('heading', { level: 1 });
        // Still loading: the frame, not the panel.
        expect(loadedSignInPage()).toBeUndefined();
        expect(h1).toHaveTextContent('Sign in.');
        expect(screen.getAllByRole('main')).toHaveLength(1);
        expect(screen.queryByRole('navigation', { name: 'Primary' })).toBeNull();
        expect(screen.getByRole('button', { name: 'Sign in with Discord' })).toBeDisabled();
        expect(document.title).toBe('Sign in — IPC Battlegrounds');
        // Then the panel replaces it once the router resolves.
        // The router waits on the chunk: a cold module transform can take over a second.
        await waitFor(() => expect(r.router.state.resolvedLocation?.href).toBe('/?login=1'), {
            timeout: 20_000,
        });
        expect(loadedSignInPage()).toBeDefined();
        expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Sign in.');
    }, 30_000);
});
