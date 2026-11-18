import type { MyProfileRow } from '@bindings/types';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SenderError } from 'spacetimedb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FLOW_KEY } from '@/auth/signIn';
import { setConnectionStatus } from '@/stdb/connectionStatus';
import { LAYER0_QUERIES } from '@/stdb/layer0';
import { profileRow } from '@/test/mockConnection';
import { linkRow, memoryJar, memoryStorage, signInConnection } from '@/test/mockSignIn';
import { renderWithConnection } from '@/test/renderWithConnection';
import { defaultSignInIo, LINK_REQUEST_QUERY, type SignInIo } from './useSignIn';

/*
 * T-S14.4b: the sign-in dialog through the real App, route tree and shell, with the mock connection (reducers, the
 * profile and link views), an in-memory cookie jar and session storage, a stubbed fetch and a recorded
 * `location.assign`. No network. The bar's "Sign in" opens it on the page; the address never changes.
 */

const CODE = 'k'.repeat(32);
const DISCORD_URL = 'https://discord.com/oauth2/authorize?state=s';
const GUEST_NAME = 'Guest_0a1b2c3d';

const saved: SignInIo = { ...defaultSignInIo };
let storage: ReturnType<typeof memoryStorage>;
let assign: ReturnType<typeof vi.fn>;

beforeEach(() => {
    storage = memoryStorage();
    assign = vi.fn();
    Object.assign(defaultSignInIo, {
        cookies: memoryJar().jar,
        storage,
        fetch: vi.fn(async () => Response.json({ url: DISCORD_URL })) as unknown as typeof fetch,
        assign,
        now: () => Date.now(),
    });
    setConnectionStatus({ state: 'connected' });
});
afterEach(() => {
    Object.assign(defaultSignInIo, saved);
});

const guestRow = () =>
    profileRow({ id: 11, isGuest: true, username: GUEST_NAME, displayName: GUEST_NAME });

function renderAt(path: string, profile?: MyProfileRow) {
    const conn = signInConnection();
    if (profile) conn.db.viewMyProfile.seed(profile);
    const rendered = renderWithConnection(path, conn);
    act(() => {
        conn.apply(LAYER0_QUERIES.profile);
        conn.apply(LAYER0_QUERIES.lobbies);
    });
    return { conn, ...rendered };
}

const signInLink = () => screen.findByRole('link', { name: 'Sign in' });
const theDialog = () => screen.getByRole('dialog');
/** Opens the dialog and waits for its chunk: the buttons act once it is in. */
async function open(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await signInLink());
    // The first open shows the frame while the chunk loads, then the loaded dialog (another element): query again.
    await waitFor(
        () =>
            expect(
                within(screen.getByRole('dialog', { name: 'Enter the Battlegrounds' })).getByRole(
                    'button',
                    { name: 'Sign in with Discord' },
                ),
            ).toHaveAttribute('aria-disabled', 'false'),
        { timeout: 10_000 },
    );
    return screen.getByRole('dialog', { name: 'Enter the Battlegrounds' });
}

describe('opening', () => {
    it('a visitor: the dialog over the page, the user’s lede, Discord focused, the address unchanged', async () => {
        const user = userEvent.setup();
        const r = renderAt('/lobbies');
        const d = await open(user);
        expect(d).toHaveAccessibleDescription(
            'Sign in with Discord to get access to all our lobby, tournament and calendar features!',
        );
        expect(within(d).getByRole('button', { name: 'Sign in with Discord' })).toHaveFocus();
        expect(within(d).getByRole('button', { name: 'Continue as Guest' })).toBeInTheDocument();
        expect(within(d).getByText('Guest accounts are kept in this browser only.')).toBeVisible();
        expect(r.router.state.location.href).toBe('/lobbies');
        expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument();
    });

    it('a modified click leaves the link alone (the full-screen panel in a new tab)', async () => {
        renderAt('/lobbies');
        const link = await signInLink();
        expect(fireEvent.click(link, { button: 0, ctrlKey: true })).toBe(true);
        expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('the close button closes it and focus returns to "Sign in"', async () => {
        const user = userEvent.setup();
        renderAt('/lobbies');
        const d = await open(user);
        await user.click(within(d).getByRole('button', { name: 'Close sign-in' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(await signInLink()).toHaveFocus();
    });

    it('still connecting: the line says so and the buttons do nothing', async () => {
        const user = userEvent.setup();
        const { conn } = renderAt('/lobbies');
        const d = await open(user);
        act(() => setConnectionStatus({ state: 'reconnecting', reason: 'x' }));
        await waitFor(() =>
            expect(within(d).getByRole('status')).toHaveTextContent('Connecting to the server…'),
        );
        const guest = within(d).getByRole('button', { name: 'Continue as Guest' });
        expect(guest).toHaveAttribute('aria-disabled', 'true');
        await user.click(guest);
        expect(conn.reducers.loginAsGuest).not.toHaveBeenCalled();
    });
});

describe('Continue as Guest', () => {
    it('a visitor becomes a guest; the name from the profile view; Enter Battlegrounds closes it', async () => {
        const user = userEvent.setup();
        const { conn, router } = renderAt('/lobbies');
        conn.reducers.loginAsGuest.mockImplementation(async () => {
            conn.db.viewMyProfile.insert(guestRow());
        });
        const d = await open(user);
        await user.click(within(d).getByRole('button', { name: 'Continue as Guest' }));
        expect(conn.reducers.loginAsGuest).toHaveBeenCalledExactlyOnceWith({});
        expect(
            await screen.findByRole('dialog', { name: 'Guest account created' }),
        ).toBeInTheDocument();
        expect(within(theDialog()).getByText(GUEST_NAME)).toBeVisible();
        const enter = within(theDialog()).getByRole('button', { name: 'Enter Battlegrounds' });
        expect(enter).toHaveFocus();
        await user.click(enter);
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(router.state.location.href).toBe('/lobbies');
        // A guest still sees "Sign in" (to link Discord), and it has focus back.
        expect(await signInLink()).toHaveFocus();
    });

    it('while the guest is being created: the line says so, Escape and the close button do nothing', async () => {
        const user = userEvent.setup();
        const { conn } = renderAt('/lobbies');
        let finish: () => void = () => {};
        conn.reducers.loginAsGuest.mockImplementation(
            () =>
                new Promise<void>((resolve) => {
                    finish = () => {
                        conn.db.viewMyProfile.insert(guestRow());
                        resolve();
                    };
                }),
        );
        const d = await open(user);
        const guest = within(d).getByRole('button', { name: 'Continue as Guest' });
        await user.click(guest);
        expect(within(d).getByRole('status')).toHaveTextContent('Creating your guest account…');
        expect(guest).toHaveFocus();
        expect(fireEvent(d, new Event('cancel', { cancelable: true }))).toBe(false);
        expect(within(d).getByRole('button', { name: 'Close sign-in' })).toBeDisabled();
        await act(async () => finish());
        expect(
            await screen.findByRole('dialog', { name: 'Guest account created' }),
        ).toBeInTheDocument();
    });

    it('a refusal shows the module’s sentence; the dialog stays', async () => {
        const user = userEvent.setup();
        const { conn } = renderAt('/lobbies');
        conn.reducers.loginAsGuest.mockRejectedValueOnce(
            new SenderError('New guest accounts are temporarily disabled.'),
        );
        const d = await open(user);
        await user.click(within(d).getByRole('button', { name: 'Continue as Guest' }));
        await waitFor(() =>
            expect(within(d).getByRole('status')).toHaveTextContent(
                'New guest accounts are temporarily disabled.',
            ),
        );
        expect(within(d).getByRole('button', { name: 'Continue as Guest' })).toHaveAttribute(
            'aria-disabled',
            'false',
        );
    });

    it('a guest who opens it: their name, and "Continue as Guest" just closes it', async () => {
        const user = userEvent.setup();
        const { conn } = renderAt('/lobbies', guestRow());
        const d = await open(user);
        expect(within(d).getByText(`You are playing as ${GUEST_NAME}.`)).toBeVisible();
        await user.click(within(d).getByRole('button', { name: 'Continue as Guest' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(conn.reducers.loginAsGuest).not.toHaveBeenCalled();
    });
});

describe('Sign in with Discord', () => {
    it('a visitor: guest, code, the view, the function, then Discord, coming back to this page', async () => {
        const user = userEvent.setup();
        const { conn } = renderAt('/lobbies');
        const d = await open(user);
        await user.click(within(d).getByRole('button', { name: 'Sign in with Discord' }));
        expect(within(d).getByRole('status')).toHaveTextContent('Opening Discord…');
        await waitFor(() => expect(conn.liveQueries()).toContain(LINK_REQUEST_QUERY));
        expect(conn.reducers.loginAsGuest).toHaveBeenCalledWith({});
        conn.db.viewMyLinkRequest.seed(linkRow({ code: CODE }));
        act(() => conn.apply(LINK_REQUEST_QUERY));
        await waitFor(() => expect(assign).toHaveBeenCalledWith(DISCORD_URL));
        const marker = JSON.parse(storage.map.get(FLOW_KEY) ?? '{}') as { next?: string };
        expect(marker.next).toBe('/lobbies');
    });

    it('a guest links: no new guest; a refusal shows the module’s sentence', async () => {
        const user = userEvent.setup();
        const { conn } = renderAt('/lobbies', guestRow());
        conn.reducers.requestLinkCode.mockRejectedValueOnce(
            new SenderError('The site is in maintenance. Please try again later.'),
        );
        const d = await open(user);
        await user.click(within(d).getByRole('button', { name: 'Sign in with Discord' }));
        await waitFor(() =>
            expect(within(d).getByRole('status')).toHaveTextContent(
                'The site is in maintenance. Please try again later.',
            ),
        );
        expect(conn.reducers.loginAsGuest).not.toHaveBeenCalled();
    });
});

describe('the profile turns into a member while it is open', () => {
    it('the dialog closes, and nothing navigates', async () => {
        const user = userEvent.setup();
        const { conn, router } = renderAt('/lobbies', guestRow());
        await open(user);
        const row = [...conn.db.viewMyProfile.iter()][0] as MyProfileRow;
        act(() =>
            conn.db.viewMyProfile.update(row, { ...row, isGuest: false, displayName: 'kafka' }),
        );
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(router.state.location.href).toBe('/lobbies');
    });
});
