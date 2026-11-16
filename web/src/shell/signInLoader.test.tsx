import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pageReload } from '@/stdb/connectionStatus';
import { AUTH, renderWithRouter } from '@/test/renderWithRouter';

/*
 * T-SHELL (S14.1 last pass): the `/` route's loader and the sign-in panel's chunk, with the chunk
 * replaced by a controllable stand-in: a load that stays pending (the frame is committed before
 * it resolves), and a load that fails (the offline splash with a reloading Retry), on a click from
 * another page and on a hard load.
 */

type Panel = () => JSX.Element;
const chunk = vi.hoisted(() => ({
    loaded: undefined as Panel | undefined,
    load: (): Promise<Panel> => Promise.reject(new Error('not set')),
}));

vi.mock('@/pages/sign-in/signInPanel', () => ({
    loadSignInPage: () => chunk.load(),
    loadedSignInPage: () => chunk.loaded,
}));

const Panel: Panel = () => (
    <main>
        <h1>Panel loaded.</h1>
    </main>
);

/** A chunk load that resolves when the test says so. */
function deferredChunk() {
    let resolve: () => void = () => {};
    chunk.load = () =>
        new Promise<Panel>((r) => {
            resolve = () => {
                chunk.loaded = Panel;
                r(Panel);
            };
        });
    return { resolve: () => resolve() };
}

function failingChunk() {
    // The router logs a loader's error; expected here, so kept out of the test output.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    chunk.load = () => Promise.reject(new TypeError('Failed to fetch dynamically imported module'));
}

afterEach(() => {
    chunk.loaded = undefined;
    vi.restoreAllMocks();
});

describe('the sign-in panel chunk loads (pendingMs: 0)', () => {
    it('a click from /teambuilder commits the frame before the chunk resolves, then the panel', async () => {
        const user = userEvent.setup();
        const pending = deferredChunk();
        const r = renderWithRouter('/teambuilder', AUTH.visitor);
        await screen.findByRole('heading', { level: 1, name: /Module/ });
        await user.click(screen.getByRole('link', { name: 'Sign in' }));
        // Still loading: the frame (its h1 and the disabled button), outside the shell.
        expect(await screen.findByRole('heading', { level: 1, name: 'Sign in.' })).toBeVisible();
        expect(screen.getByRole('button', { name: 'Sign in with Discord' })).toBeDisabled();
        expect(screen.queryByRole('navigation', { name: 'Primary' })).toBeNull();
        expect(r.router.state.resolvedLocation?.href).toBe('/teambuilder');
        act(() => pending.resolve());
        await waitFor(() =>
            expect(r.router.state.resolvedLocation?.href).toBe('/?login=1&next=%2Fteambuilder'),
        );
        expect(
            await screen.findByRole('heading', { level: 1, name: 'Panel loaded.' }),
        ).toBeVisible();
    });
});

describe('the sign-in panel chunk fails to load', () => {
    async function expectLoadFailed() {
        expect(
            await screen.findByRole('heading', { level: 1, name: 'Connection lost.' }),
        ).toBeVisible();
        expect(
            screen.getByText('The page could not be loaded. Check your connection and try again.'),
        ).toBeInTheDocument();
        expect(screen.getAllByRole('main')).toHaveLength(1);
        expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
        expect(screen.queryByRole('navigation', { name: 'Primary' })).toBeNull();
        await waitFor(() => expect(document.title).toBe('Connection lost — IPC Battlegrounds'));
    }

    it('on a click from /teambuilder: the offline splash, and Retry reloads the page', async () => {
        const user = userEvent.setup();
        const reload = vi.spyOn(pageReload, 'run').mockImplementation(() => {});
        failingChunk();
        renderWithRouter('/teambuilder', AUTH.visitor);
        await screen.findByRole('heading', { level: 1, name: /Module/ });
        await user.click(screen.getByRole('link', { name: 'Sign in' }));
        await expectLoadFailed();
        await user.click(screen.getByRole('button', { name: 'Retry' }));
        expect(reload).toHaveBeenCalledTimes(1);
    });

    it('on a hard load of /?login=1: the offline splash, and Retry reloads the page', async () => {
        const user = userEvent.setup();
        const reload = vi.spyOn(pageReload, 'run').mockImplementation(() => {});
        failingChunk();
        renderWithRouter('/?login=1', AUTH.visitor);
        await expectLoadFailed();
        await user.click(screen.getByRole('button', { name: 'Retry' }));
        expect(reload).toHaveBeenCalledTimes(1);
    });
});
