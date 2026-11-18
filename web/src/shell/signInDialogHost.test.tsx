import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SignInDialogType } from '@/pages/sign-in/signInDialogState';
import { AUTH, renderWithRouter } from '@/test/renderWithRouter';

/*
 * T-S14.4b: the sign-in dialog's place in the shell, with its chunk replaced by a controllable stand-in: while the
 * chunk loads the same dialog shows as an inert frame; a failed load says so in the frame, and "Try again" loads it
 * again. The dialog is not shown on a splash (the full-screen panel).
 */

const chunk = vi.hoisted(() => ({
    load: (): Promise<unknown> => Promise.reject(new Error('not set')),
}));

vi.mock('@/pages/sign-in/signInDialogState', async (original) => ({
    ...(await original<typeof import('@/pages/sign-in/signInDialogState')>()),
    loadSignInDialog: () => chunk.load(),
    loadedSignInDialog: () => undefined,
}));

const Loaded: SignInDialogType = () => <p>Dialog chunk loaded.</p>;

afterEach(() => {
    vi.restoreAllMocks();
});

describe('the sign-in dialog host', () => {
    it('the frame while the chunk loads: same name, buttons that do nothing; then the dialog', async () => {
        const user = userEvent.setup();
        let resolve: () => void = () => {};
        chunk.load = () =>
            new Promise((r) => {
                resolve = () => r(Loaded);
            });
        renderWithRouter('/lobbies', AUTH.visitor);
        await user.click(await screen.findByRole('link', { name: 'Sign in' }));
        const d = await screen.findByRole('dialog', { name: 'Enter the Battlegrounds' });
        const discord = within(d).getByRole('button', { name: 'Sign in with Discord' });
        expect(discord).toHaveAttribute('aria-disabled', 'true');
        expect(discord).toHaveFocus();
        resolve();
        expect(await screen.findByText('Dialog chunk loaded.')).toBeInTheDocument();
    });

    it('a failed load: the frame says so, and Try again loads it again', async () => {
        const user = userEvent.setup();
        chunk.load = () =>
            Promise.reject(new TypeError('Failed to fetch dynamically imported module'));
        renderWithRouter('/lobbies', AUTH.visitor);
        await user.click(await screen.findByRole('link', { name: 'Sign in' }));
        const d = await screen.findByRole('dialog', { name: 'Enter the Battlegrounds' });
        await waitFor(() =>
            expect(within(d).getByRole('status')).toHaveTextContent(
                'Sign-in could not be loaded. Check your connection and try again.',
            ),
        );
        chunk.load = () => Promise.resolve(Loaded);
        await user.click(within(d).getByRole('button', { name: 'Try again' }));
        expect(await screen.findByText('Dialog chunk loaded.')).toBeInTheDocument();
    });

    it('a guest: the frame closes from its close button, focus back on "Sign in"', async () => {
        const user = userEvent.setup();
        chunk.load = () => new Promise(() => {});
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
});
