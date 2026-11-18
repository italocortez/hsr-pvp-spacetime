import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Dialog } from '@/components/Dialog/Dialog';
import type { SignInDialogType } from '@/pages/sign-in/signInDialogState';
import { AUTH, renderWithRouter } from '@/test/renderWithRouter';

/*
 * T-S14.4b: the sign-in dialog's place in the shell, with its chunk replaced by a controllable stand-in.
 * S14.4b-fix (review B, S1 and S6): there is no frame any more. Until the chunk is in nothing shows, then the dialog
 * opens once (one element, one mount); a chunk already preloaded opens at once; a failed load follows the link to the
 * full-screen panel. The chunk is preloaded when the browser is idle after the bar shows "Sign in".
 */

const chunk = vi.hoisted(() => ({
    load: (): Promise<unknown> => Promise.reject(new Error('not set')),
    loaded: undefined as unknown,
}));

vi.mock('@/pages/sign-in/signInDialogState', async (original) => ({
    ...(await original<typeof import('@/pages/sign-in/signInDialogState')>()),
    loadSignInDialog: () => chunk.load(),
    loadedSignInDialog: () => chunk.loaded,
}));

/** The stand-in chunk: a real shared Dialog, counting its mounts. */
const mounts = { count: 0 };
const Loaded: SignInDialogType = ({ onClose, trigger }) => {
    useEffect(() => {
        mounts.count += 1;
    }, []);
    return (
        <Dialog
            open
            onClose={onClose}
            title="Enter the Battlegrounds"
            closeLabel="Close sign-in"
            returnFocus={trigger}
        >
            <button type="button">Sign in with Discord</button>
        </Dialog>
    );
};

afterEach(() => {
    vi.restoreAllMocks();
    chunk.loaded = undefined;
    mounts.count = 0;
});

describe('the sign-in dialog host', () => {
    it('nothing while the chunk loads; then the dialog, opened once', async () => {
        const user = userEvent.setup();
        let resolve: () => void = () => {};
        chunk.load = () =>
            new Promise((r) => {
                resolve = () => r(Loaded);
            });
        renderWithRouter('/lobbies', AUTH.visitor);
        const link = await screen.findByRole('link', { name: 'Sign in' });
        await user.click(link);
        expect(screen.queryByRole('dialog')).toBeNull();
        const added: Node[] = [];
        const watch = new MutationObserver((records) => {
            for (const r of records)
                for (const n of r.addedNodes) if (n.nodeName === 'DIALOG') added.push(n);
        });
        watch.observe(document.body, { childList: true, subtree: true });
        await act(async () => resolve());
        const d = await screen.findByRole('dialog', { name: 'Enter the Battlegrounds' });
        expect(within(d).getByRole('button', { name: 'Sign in with Discord' })).toHaveFocus();
        await act(() => new Promise((r) => setTimeout(r, 20)));
        watch.disconnect();
        expect(added).toHaveLength(1);
        expect(mounts.count).toBe(1);
        expect(screen.getByRole('dialog')).toBe(d);
    });

    it('a chunk already preloaded: the dialog at once, mounted once', async () => {
        const user = userEvent.setup();
        chunk.loaded = Loaded;
        chunk.load = () => Promise.resolve(Loaded);
        renderWithRouter('/lobbies', AUTH.visitor);
        await user.click(await screen.findByRole('link', { name: 'Sign in' }));
        expect(screen.getByRole('dialog', { name: 'Enter the Battlegrounds' })).toBeInTheDocument();
        await act(() => new Promise((r) => setTimeout(r, 20)));
        expect(mounts.count).toBe(1);
    });

    it('a failed load: the click follows the link to the full-screen panel', async () => {
        const user = userEvent.setup();
        chunk.load = () =>
            Promise.reject(new TypeError('Failed to fetch dynamically imported module'));
        const r = renderWithRouter('/lobbies', AUTH.visitor);
        await user.click(await screen.findByRole('link', { name: 'Sign in' }));
        await waitFor(
            () => expect(r.router.state.location.href).toBe('/?login=1&next=%2Flobbies'),
            { timeout: 10_000 },
        );
        expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('a guest: the dialog closes from its close button, focus back on "Sign in"', async () => {
        const user = userEvent.setup();
        chunk.load = () => Promise.resolve(Loaded);
        renderWithRouter('/lobbies', AUTH.guest);
        const link = await screen.findByRole('link', { name: 'Sign in' });
        await user.click(link);
        const d = await screen.findByRole('dialog', { name: 'Enter the Battlegrounds' });
        await user.click(within(d).getByRole('button', { name: 'Close sign-in' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(link).toHaveFocus();
    });

    it('a member has no "Sign in" and no dialog', async () => {
        renderWithRouter('/lobbies', AUTH.member);
        await screen.findByRole('heading', { level: 1 });
        expect(screen.queryByRole('link', { name: 'Sign in' })).toBeNull();
        expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('the bar shows "Sign in": the chunk is preloaded when the browser is idle; a member: not', async () => {
        const idle = vi.fn((_run: () => void, _options?: { timeout: number }) => 1);
        const cancel = vi.fn();
        vi.stubGlobal('requestIdleCallback', idle);
        vi.stubGlobal('cancelIdleCallback', cancel);
        try {
            const visitor = renderWithRouter('/lobbies', AUTH.visitor);
            await screen.findByRole('link', { name: 'Sign in' });
            expect(idle).toHaveBeenCalledTimes(1);
            expect(idle.mock.calls[0]?.[1]).toEqual({ timeout: 4000 });
            visitor.unmount();
            expect(cancel).toHaveBeenCalledWith(1);
            idle.mockClear();
            renderWithRouter('/lobbies', AUTH.member);
            await screen.findByRole('heading', { level: 1 });
            expect(idle).not.toHaveBeenCalled();
        } finally {
            vi.unstubAllGlobals();
        }
    });
});
