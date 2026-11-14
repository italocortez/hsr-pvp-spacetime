import type { MyProfileRow } from '@bindings/types';
import { CONFIRM_COOKIE, REFUSAL_COOKIE } from '@shared/auth-flow';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { SenderError, UnknownCallResultError } from 'spacetimedb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FLOW_KEY } from '@/auth/signIn';
import { setConnectionStatus } from '@/stdb/connectionStatus';
import { LAYER0_QUERIES } from '@/stdb/layer0';
import { profileRow } from '@/test/mockConnection';
import {
    linkRow,
    memoryJar,
    memoryStorage,
    type SignInMock,
    signInConnection,
} from '@/test/mockSignIn';
import { renderWithConnection } from '@/test/renderWithConnection';
import { defaultSignInIo, LINK_REQUEST_QUERY, type SignInIo } from './useSignIn';

/*
 * T-M5b: the sign-in panel on `/?login=1` through the real App and route tree, with the mock
 * connection (reducers and view_my_link_request), an in-memory cookie jar and session storage, a
 * stubbed fetch and a recorded `location.assign`. No network.
 */

const TOKEN = `${'Q'.repeat(42)}A`;
const CODE = 'k'.repeat(32);
const DISCORD_URL = 'https://discord.com/oauth2/authorize?state=s';

const saved: SignInIo = { ...defaultSignInIo };
let jar: ReturnType<typeof memoryJar>;
let storage: ReturnType<typeof memoryStorage>;
let fetchMock: ReturnType<typeof vi.fn>;
let assign: ReturnType<typeof vi.fn>;

beforeEach(() => {
    jar = memoryJar();
    storage = memoryStorage();
    fetchMock = vi.fn(async () => Response.json({ url: DISCORD_URL }));
    assign = vi.fn();
    Object.assign(defaultSignInIo, {
        cookies: jar.jar,
        storage,
        fetch: fetchMock as unknown as typeof fetch,
        assign,
        now: () => Date.now(),
    });
    setConnectionStatus({ state: 'connected' });
});
afterEach(() => {
    Object.assign(defaultSignInIo, saved);
});

const guest = () => profileRow({ id: 11, isGuest: true, username: 'Guest_1' });
const member = () => profileRow({ id: 11, isGuest: false, username: 'kafka_handle' });

/** The app at `path` with Layer 0 applied: a visitor (no profile row) or the given row. */
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

const headline = async (text: string) =>
    waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(text));
const subscribedToLinkView = (conn: SignInMock) => conn.liveQueries().includes(LINK_REQUEST_QUERY);
const href = (r: { router: { state: { location: { href: string } } } }) =>
    r.router.state.location.href;

describe('the panel', () => {
    it('one main, one h1, the proposed wording, and no link-view subscription', async () => {
        const { conn } = renderAt('/?login=1&next=%2Fprofile');
        await headline('Sign in.');
        expect(screen.getAllByRole('main')).toHaveLength(1);
        expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
        expect(screen.getByText('Access // Sign in')).toBeInTheDocument();
        expect(
            screen.getByText('Sign in with Discord to join lobbies and tournaments.'),
        ).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Sign in with Discord' })).toBeEnabled();
        await waitFor(() => expect(document.title).toBe('Sign in — IPC Battlegrounds'));
        expect(subscribedToLinkView(conn)).toBe(false);
    });

    it('a visitor on / without login=1 sees the standby page', async () => {
        renderAt('/');
        await headline('Module offline.');
    });

    it('a signed-in member on /?login=1 is sent to next', async () => {
        const r = renderAt('/?login=1&next=%2Fcalendar', member());
        await waitFor(() => expect(href(r)).toBe('/calendar'));
    });

    it('a signed-in member on /?login=1 without next goes to /', async () => {
        const r = renderAt('/?login=1', member());
        await waitFor(() => expect(href(r)).toBe('/'));
        await headline('Module offline.');
    });
});

describe('start', () => {
    it('a visitor: login_as_guest, then request_link_code with a fresh nonce, then (only then) the view, then the function, then Discord', async () => {
        const { conn } = renderAt('/?login=1&next=%2Fprofile');
        await headline('Sign in.');
        conn.reducers.requestLinkCode.mockImplementation(async () => {
            expect(subscribedToLinkView(conn)).toBe(false);
        });
        fireEvent.click(screen.getByRole('button', { name: 'Sign in with Discord' }));
        await waitFor(() => expect(subscribedToLinkView(conn)).toBe(true));
        expect(conn.reducers.loginAsGuest).toHaveBeenCalledWith({});
        const nonce = conn.reducers.requestLinkCode.mock.calls[0]?.[0].clientNonce;
        expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(screen.getByRole('button', { name: 'Sign in with Discord' })).toBeDisabled();

        conn.db.viewMyLinkRequest.seed(linkRow({ code: CODE }));
        act(() => conn.apply(LINK_REQUEST_QUERY));
        await waitFor(() => expect(assign).toHaveBeenCalledWith(DISCORD_URL));
        const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(path).toBe('/api/auth/discord/start');
        expect(JSON.parse(String(init.body))).toEqual({ linkCode: CODE });
        const marker = JSON.parse(storage.map.get(FLOW_KEY) ?? '{}') as {
            id?: string;
            next?: string;
        };
        expect(marker.id).toBeTruthy();
        expect(marker.next).toBe('/profile');
    });

    it('a guest does not call login_as_guest again', async () => {
        const { conn } = renderAt('/?login=1', guest());
        await headline('Sign in.');
        fireEvent.click(screen.getByRole('button', { name: 'Sign in with Discord' }));
        await waitFor(() => expect(conn.reducers.requestLinkCode).toHaveBeenCalled());
        expect(conn.reducers.loginAsGuest).not.toHaveBeenCalled();
    });

    it('not configured: the line, Try again, and the view dropped', async () => {
        fetchMock.mockImplementation(async () =>
            Response.json(
                { error: 'not_configured', missing: ['DISCORD_CLIENT_ID'] },
                { status: 500 },
            ),
        );
        const { conn } = renderAt('/?login=1', guest());
        await headline('Sign in.');
        fireEvent.click(screen.getByRole('button', { name: 'Sign in with Discord' }));
        await waitFor(() => expect(subscribedToLinkView(conn)).toBe(true));
        conn.db.viewMyLinkRequest.seed(linkRow({ code: CODE }));
        act(() => conn.apply(LINK_REQUEST_QUERY));
        expect(await screen.findByRole('status')).toHaveTextContent(
            'Sign-in is not configured on this machine.',
        );
        expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled();
        expect(subscribedToLinkView(conn)).toBe(false);
        expect(assign).not.toHaveBeenCalled();
        expect(storage.map.has(FLOW_KEY)).toBe(false);
    });

    it('a module refusal at request time shows its text', async () => {
        const { conn } = renderAt('/?login=1', guest());
        conn.reducers.requestLinkCode.mockRejectedValueOnce(
            new SenderError('New guest accounts are temporarily disabled.'),
        );
        await headline('Sign in.');
        fireEvent.click(screen.getByRole('button', { name: 'Sign in with Discord' }));
        await headline('Sign-in refused.');
        expect(
            screen.getByText('New guest accounts are temporarily disabled.'),
        ).toBeInTheDocument();
        expect(subscribedToLinkView(conn)).toBe(false);
    });

    it('not connected: failed, nothing queued', async () => {
        const { conn } = renderAt('/?login=1', guest());
        await headline('Sign in.');
        act(() => setConnectionStatus({ state: 'reconnecting', reason: 'x' }));
        fireEvent.click(screen.getByRole('button', { name: 'Sign in with Discord' }));
        await headline('Sign-in failed.');
        expect(conn.reducers.requestLinkCode).not.toHaveBeenCalled();
    });
});

describe('return: status=confirm', () => {
    function returning(profile: MyProfileRow | undefined, withMarker = true) {
        if (withMarker)
            storage.map.set(FLOW_KEY, JSON.stringify({ id: 'marker', next: '/profile' }));
        jar.cookies.set(CONFIRM_COOKIE, TOKEN);
        return renderAt('/?login=1&status=confirm', profile);
    }

    it('shows the pending handle, confirms with the token (cookie deleted first), then moves to next', async () => {
        const r = returning(guest());
        await waitFor(() => expect(subscribedToLinkView(r.conn)).toBe(true));
        await waitFor(() => expect(href(r)).toBe('/?login=1&next=%2Fprofile'));
        r.conn.db.viewMyLinkRequest.seed(
            linkRow({ awaitingConfirm: true, pendingProviderName: 'kafka_handle', inMs: 120_000 }),
        );
        act(() => r.conn.apply(LINK_REQUEST_QUERY));
        await headline('Link account.');
        expect(screen.getByText('kafka_handle')).toBeInTheDocument();
        expect(screen.getByText(/You are about to link the Discord account/)).toBeInTheDocument();
        expect(jar.events).toEqual([]); // nothing read before the click

        r.conn.reducers.confirmLink.mockImplementation(async () => {
            expect(jar.cookies.has(CONFIRM_COOKIE)).toBe(false);
        });
        fireEvent.click(screen.getByRole('button', { name: 'Link this account' }));
        await waitFor(() =>
            expect(r.conn.reducers.confirmLink).toHaveBeenCalledWith({ confirmToken: TOKEN }),
        );
        expect(jar.events.slice(0, 2)).toEqual([
            `read ${CONFIRM_COOKIE}`,
            `remove ${CONFIRM_COOKIE}`,
        ]);
        expect(storage.map.has(FLOW_KEY)).toBe(false);
        await waitFor(() => expect(subscribedToLinkView(r.conn)).toBe(false));

        // The profile view follows the link on the same connection.
        const before = [...r.conn.db.viewMyProfile.iter()][0] as MyProfileRow;
        act(() => r.conn.db.viewMyProfile.update(before, member()));
        await waitFor(() => expect(href(r)).toBe('/profile'));
        expect(r.conn.reducers.confirmLink).toHaveBeenCalledTimes(1);
    });

    it('the handle is rendered as text, never HTML', async () => {
        const r = returning(guest());
        await waitFor(() => expect(subscribedToLinkView(r.conn)).toBe(true));
        r.conn.db.viewMyLinkRequest.seed(
            linkRow({
                awaitingConfirm: true,
                pendingProviderName: '<img src=x onerror=alert(1)>',
                inMs: 120_000,
            }),
        );
        act(() => r.conn.apply(LINK_REQUEST_QUERY));
        await headline('Link account.');
        expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
        expect(document.querySelector('main img[src="x"]')).toBeNull();
    });

    it('no tab marker (another tab): failed, no subscription, the cookie left alone', async () => {
        const r = returning(guest(), false);
        await headline('Sign-in failed.');
        expect(screen.getByText('Nothing was changed. You can try again.')).toBeInTheDocument();
        expect(subscribedToLinkView(r.conn)).toBe(false);
        expect(jar.cookies.get(CONFIRM_COOKIE)).toBe(TOKEN);
        expect(r.conn.reducers.confirmLink).not.toHaveBeenCalled();
    });

    it('a row expired by the browser clock: "took too long", the token dropped', async () => {
        const r = returning(guest());
        await waitFor(() => expect(subscribedToLinkView(r.conn)).toBe(true));
        r.conn.db.viewMyLinkRequest.seed(
            linkRow({ awaitingConfirm: true, pendingProviderName: 'kafka', inMs: -1000 }),
        );
        act(() => r.conn.apply(LINK_REQUEST_QUERY));
        await headline('Sign-in failed.');
        expect(
            screen.getByText('The sign-in took too long. Please try again.'),
        ).toBeInTheDocument();
        expect(jar.cookies.has(CONFIRM_COOKIE)).toBe(false);
        expect(storage.map.has(FLOW_KEY)).toBe(false);
        await waitFor(() => expect(subscribedToLinkView(r.conn)).toBe(false));
        expect(r.conn.reducers.confirmLink).not.toHaveBeenCalled();
    });

    it('no row at all: "took too long"', async () => {
        const r = returning(guest());
        await waitFor(() => expect(subscribedToLinkView(r.conn)).toBe(true));
        act(() => r.conn.apply(LINK_REQUEST_QUERY));
        await headline('Sign-in failed.');
        expect(
            screen.getByText('The sign-in took too long. Please try again.'),
        ).toBeInTheDocument();
    });

    it('a visitor (no profile) cannot confirm: failed, the token dropped', async () => {
        const r = returning(undefined);
        await headline('Sign-in failed.');
        expect(jar.cookies.has(CONFIRM_COOKIE)).toBe(false);
        expect(subscribedToLinkView(r.conn)).toBe(false);
    });

    it('a member (not a guest) is sent to next instead', async () => {
        const r = returning(member());
        await waitFor(() => expect(href(r)).toBe('/profile'));
        expect(r.conn.reducers.confirmLink).not.toHaveBeenCalled();
    });

    it('the module refuses the confirmation: its text; one attempt only', async () => {
        const r = returning(guest());
        await waitFor(() => expect(subscribedToLinkView(r.conn)).toBe(true));
        r.conn.db.viewMyLinkRequest.seed(
            linkRow({ awaitingConfirm: true, pendingProviderName: 'kafka', inMs: 120_000 }),
        );
        act(() => r.conn.apply(LINK_REQUEST_QUERY));
        await headline('Link account.');
        r.conn.reducers.confirmLink.mockRejectedValueOnce(
            new SenderError('This sign-in could not be confirmed.'),
        );
        fireEvent.click(screen.getByRole('button', { name: 'Link this account' }));
        await headline('Sign-in refused.');
        expect(screen.getByText('This sign-in could not be confirmed.')).toBeInTheDocument();
        expect(jar.cookies.has(CONFIRM_COOKIE)).toBe(false);
        expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled();
        expect(r.conn.reducers.confirmLink).toHaveBeenCalledTimes(1);
    });

    it('Cancel drops the token, the marker and the view, and shows the sign-in panel', async () => {
        const r = returning(guest());
        await waitFor(() => expect(subscribedToLinkView(r.conn)).toBe(true));
        r.conn.db.viewMyLinkRequest.seed(
            linkRow({ awaitingConfirm: true, pendingProviderName: 'kafka', inMs: 120_000 }),
        );
        act(() => r.conn.apply(LINK_REQUEST_QUERY));
        await headline('Link account.');
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        await headline('Sign in.');
        expect(jar.cookies.has(CONFIRM_COOKIE)).toBe(false);
        expect(storage.map.has(FLOW_KEY)).toBe(false);
        await waitFor(() => expect(subscribedToLinkView(r.conn)).toBe(false));
        expect(r.conn.reducers.confirmLink).not.toHaveBeenCalled();
    });
});

describe('the confirm click links the account the panel shows (fix pass)', () => {
    const OTHER_TOKEN = `${'R'.repeat(42)}A`;
    const CHANGED = 'The sign-in changed in another tab. Please try again.';

    /** The confirm panel for `handle`, the row expiring in `inMs`. */
    async function confirmPanel(handle = 'kafka', inMs = 120_000) {
        storage.map.set(FLOW_KEY, JSON.stringify({ id: 'marker', next: '/profile' }));
        jar.cookies.set(CONFIRM_COOKIE, TOKEN);
        const r = renderAt('/?login=1&status=confirm', guest());
        await waitFor(() => expect(subscribedToLinkView(r.conn)).toBe(true));
        const row = linkRow({ awaitingConfirm: true, pendingProviderName: handle, inMs });
        r.conn.db.viewMyLinkRequest.seed(row);
        act(() => r.conn.apply(LINK_REQUEST_QUERY));
        await headline('Link account.');
        expect(screen.getByText(handle)).toBeInTheDocument();
        return { ...r, row };
    }

    it('two tabs: the row is replaced by another flow and the cookie holds its token: the changed state, no call, cookie untouched', async () => {
        const r = await confirmPanel('kafka');
        // Tab B (same identity) starts and finishes its own flow: a new pending row, a new token.
        const replacement = linkRow({
            awaitingConfirm: true,
            pendingProviderName: 'blade',
            inMs: 119_000,
        });
        act(() => {
            r.conn.db.viewMyLinkRequest.insert(replacement);
            r.conn.db.viewMyLinkRequest.delete(r.row);
        });
        jar.cookies.set(CONFIRM_COOKIE, OTHER_TOKEN);
        await headline('Sign-in failed.');
        expect(screen.getByText(CHANGED)).toBeInTheDocument();
        expect(screen.queryByText('blade')).toBeNull();
        expect(screen.queryByRole('button', { name: 'Link this account' })).toBeNull();
        expect(r.conn.reducers.confirmLink).not.toHaveBeenCalled();
        expect(jar.cookies.get(CONFIRM_COOKIE)).toBe(OTHER_TOKEN);
        expect(storage.map.has(FLOW_KEY)).toBe(false);
        await waitFor(() => expect(subscribedToLinkView(r.conn)).toBe(false));
    });

    it('the same handle in a new flow (another expiry) is a change too', async () => {
        const r = await confirmPanel('kafka');
        const replacement = linkRow({
            awaitingConfirm: true,
            pendingProviderName: 'kafka',
            inMs: 110_000,
        });
        act(() => {
            r.conn.db.viewMyLinkRequest.insert(replacement);
            r.conn.db.viewMyLinkRequest.delete(r.row);
        });
        await headline('Sign-in failed.');
        expect(screen.getByText(CHANGED)).toBeInTheDocument();
        expect(r.conn.reducers.confirmLink).not.toHaveBeenCalled();
    });

    it('the row disappears (another tab requested a new code): the changed state, no call', async () => {
        const r = await confirmPanel('kafka');
        act(() => r.conn.db.viewMyLinkRequest.delete(r.row));
        await headline('Sign-in failed.');
        expect(screen.getByText(CHANGED)).toBeInTheDocument();
        expect(r.conn.reducers.confirmLink).not.toHaveBeenCalled();
        expect(jar.cookies.get(CONFIRM_COOKIE)).toBe(TOKEN);
    });

    it('a change in the cache that has not rendered yet is caught at the click', async () => {
        const r = await confirmPanel('kafka');
        const replacement = linkRow({
            awaitingConfirm: true,
            pendingProviderName: 'blade',
            inMs: 119_000,
        });
        // Straight into the cache, no row event: the panel still shows kafka when the click lands.
        r.conn.db.viewMyLinkRequest.rows = [replacement];
        fireEvent.click(screen.getByRole('button', { name: 'Link this account' }));
        await headline('Sign-in failed.');
        expect(screen.getByText(CHANGED)).toBeInTheDocument();
        expect(r.conn.reducers.confirmLink).not.toHaveBeenCalled();
        expect(jar.cookies.get(CONFIRM_COOKIE)).toBe(TOKEN);
    });

    it('the click re-checks expiry by the browser clock: expired since the panel opened, "took too long", no call', async () => {
        const r = await confirmPanel('kafka', 5_000);
        const later = Date.now() + 6_000;
        defaultSignInIo.now = () => later;
        fireEvent.click(screen.getByRole('button', { name: 'Link this account' }));
        await headline('Sign-in failed.');
        expect(
            screen.getByText('The sign-in took too long. Please try again.'),
        ).toBeInTheDocument();
        expect(r.conn.reducers.confirmLink).not.toHaveBeenCalled();
        expect(jar.cookies.has(CONFIRM_COOKIE)).toBe(false);
    });

    it('the click re-checks the guest state: no profile any more, failed, no call', async () => {
        const r = await confirmPanel('kafka');
        const profile = [...r.conn.db.viewMyProfile.iter()][0] as MyProfileRow;
        act(() => r.conn.db.viewMyProfile.delete(profile));
        fireEvent.click(screen.getByRole('button', { name: 'Link this account' }));
        await headline('Sign-in failed.');
        expect(screen.getByText('Nothing was changed. You can try again.')).toBeInTheDocument();
        expect(r.conn.reducers.confirmLink).not.toHaveBeenCalled();
        expect(jar.cookies.has(CONFIRM_COOKIE)).toBe(false);
    });

    it('confirm_link fails with no refusal (connection lost, unknown result): the unknown-result line', async () => {
        const r = await confirmPanel('kafka');
        r.conn.reducers.confirmLink.mockRejectedValueOnce(new UnknownCallResultError());
        fireEvent.click(screen.getByRole('button', { name: 'Link this account' }));
        await headline('Sign-in failed.');
        expect(
            screen.getByText(
                'The connection dropped. The result is unknown: reload and check before trying again.',
            ),
        ).toBeInTheDocument();
        expect(r.conn.reducers.confirmLink).toHaveBeenCalledTimes(1);
    });
});

describe('start robustness (fix pass)', () => {
    const UNKNOWN =
        'The connection dropped. The result is unknown: reload and check before trying again.';

    it('request_link_code fails with a plain error (not a refusal): the unknown-result line', async () => {
        const { conn } = renderAt('/?login=1', guest());
        conn.reducers.requestLinkCode.mockRejectedValueOnce(new Error('socket closed'));
        await headline('Sign in.');
        fireEvent.click(screen.getByRole('button', { name: 'Sign in with Discord' }));
        await headline('Sign-in failed.');
        expect(screen.getByText(UNKNOWN)).toBeInTheDocument();
        expect(screen.queryByText('socket closed')).toBeNull();
    });

    it('waits for the profile view: a member whose profile arrives late is never made a guest', async () => {
        const conn = signInConnection();
        const r = renderWithConnection('/?login=1&next=%2Fcalendar', conn);
        await headline('Sign in.');
        fireEvent.click(screen.getByRole('button', { name: 'Sign in with Discord' }));
        await new Promise((done) => setTimeout(done, 20));
        expect(conn.reducers.loginAsGuest).not.toHaveBeenCalled();
        expect(conn.reducers.requestLinkCode).not.toHaveBeenCalled();
        conn.db.viewMyProfile.seed(member());
        act(() => {
            conn.apply(LAYER0_QUERIES.profile);
            conn.apply(LAYER0_QUERIES.lobbies);
        });
        await waitFor(() => expect(r.router.state.location.href).toBe('/calendar'));
        expect(conn.reducers.loginAsGuest).not.toHaveBeenCalled();
        expect(conn.reducers.requestLinkCode).not.toHaveBeenCalled();
    });

    it('waits for the profile view: a visitor becomes a guest once it has answered', async () => {
        const conn = signInConnection();
        renderWithConnection('/?login=1', conn);
        await headline('Sign in.');
        fireEvent.click(screen.getByRole('button', { name: 'Sign in with Discord' }));
        await new Promise((done) => setTimeout(done, 20));
        expect(conn.reducers.loginAsGuest).not.toHaveBeenCalled();
        act(() => {
            conn.apply(LAYER0_QUERIES.profile);
            conn.apply(LAYER0_QUERIES.lobbies);
        });
        await waitFor(() => expect(conn.reducers.loginAsGuest).toHaveBeenCalledTimes(1));
        await waitFor(() => expect(conn.reducers.requestLinkCode).toHaveBeenCalledTimes(1));
    });

    it('the panel unmounts while start waits for the function: no marker, no navigation', async () => {
        let answer: (res: Response) => void = () => {};
        fetchMock.mockImplementation(() => new Promise<Response>((done) => (answer = done)));
        const { conn, unmount } = renderAt('/?login=1', guest());
        await headline('Sign in.');
        fireEvent.click(screen.getByRole('button', { name: 'Sign in with Discord' }));
        await waitFor(() => expect(subscribedToLinkView(conn)).toBe(true));
        conn.db.viewMyLinkRequest.seed(linkRow({ code: CODE }));
        act(() => conn.apply(LINK_REQUEST_QUERY));
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        unmount();
        answer(Response.json({ url: DISCORD_URL }));
        await new Promise((done) => setTimeout(done, 20));
        expect(assign).not.toHaveBeenCalled();
        expect(storage.map.has(FLOW_KEY)).toBe(false);
    });

    it('the function answers an address that is not Discord: failed, no navigation, no marker', async () => {
        fetchMock.mockImplementation(async () => Response.json({ url: 'https://evil.example/x' }));
        const { conn } = renderAt('/?login=1', guest());
        await headline('Sign in.');
        fireEvent.click(screen.getByRole('button', { name: 'Sign in with Discord' }));
        await waitFor(() => expect(subscribedToLinkView(conn)).toBe(true));
        conn.db.viewMyLinkRequest.seed(linkRow({ code: CODE }));
        act(() => conn.apply(LINK_REQUEST_QUERY));
        await headline('Sign-in failed.');
        expect(assign).not.toHaveBeenCalled();
        expect(storage.map.has(FLOW_KEY)).toBe(false);
    });
});

describe('checking gives up', () => {
    afterEach(() => vi.useRealTimers());

    it('no answer from the view within 10 s: the failed state, the token and marker dropped', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        storage.map.set(FLOW_KEY, JSON.stringify({ id: 'marker' }));
        jar.cookies.set(CONFIRM_COOKIE, TOKEN);
        const r = renderAt('/?login=1&status=confirm', guest());
        await waitFor(() => expect(subscribedToLinkView(r.conn)).toBe(true));
        // The view never answers.
        expect(screen.getByRole('button', { name: 'Sign in with Discord' })).toBeDisabled();
        act(() => vi.advanceTimersByTime(10_000));
        await headline('Sign-in failed.');
        expect(screen.getByText('Nothing was changed. You can try again.')).toBeInTheDocument();
        expect(jar.cookies.has(CONFIRM_COOKIE)).toBe(false);
        expect(storage.map.has(FLOW_KEY)).toBe(false);
        expect(r.conn.reducers.confirmLink).not.toHaveBeenCalled();
    });
});

describe('late answers and timeouts (last pass)', () => {
    afterEach(() => vi.useRealTimers());

    /** A promise the test settles by hand. */
    function deferred<T = void>() {
        let resolve: (value: T) => void = () => {};
        let reject: (error: unknown) => void = () => {};
        const promise = new Promise<T>((res, rej) => {
            resolve = res;
            reject = rej;
        });
        return { promise, resolve, reject };
    }
    const tick = () => act(() => new Promise((done) => setTimeout(done, 20)));

    /** From the sign-in panel to the start POST in flight (the code row applied). */
    async function toThePost(conn: SignInMock) {
        await headline('Sign in.');
        fireEvent.click(screen.getByRole('button', { name: 'Sign in with Discord' }));
        await waitFor(() => expect(subscribedToLinkView(conn)).toBe(true));
        conn.db.viewMyLinkRequest.seed(linkRow({ code: CODE }));
        act(() => conn.apply(LINK_REQUEST_QUERY));
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    }

    it('a hung start POST: failed after 10 s, the panel usable again, no navigation', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        fetchMock.mockImplementation(() => new Promise<Response>(() => {}));
        const { conn } = renderAt('/?login=1', guest());
        await toThePost(conn);
        expect(screen.getByRole('button', { name: 'Sign in with Discord' })).toBeDisabled();
        await act(() => vi.advanceTimersByTimeAsync(10_000));
        await headline('Sign-in failed.');
        expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled();
        expect(assign).not.toHaveBeenCalled();
        expect(storage.map.has(FLOW_KEY)).toBe(false);
        await waitFor(() => expect(subscribedToLinkView(conn)).toBe(false));
    });

    it('a late start answer after a failure (the view errored during the POST) does not navigate', async () => {
        const post = deferred<Response>();
        fetchMock.mockImplementation(() => post.promise);
        const { conn } = renderAt('/?login=1', guest());
        await toThePost(conn);
        const sub = conn.live().find((s) => s.query === LINK_REQUEST_QUERY);
        act(() => sub?.fail('view failed'));
        await headline('Sign-in failed.');
        post.resolve(Response.json({ url: DISCORD_URL }));
        await tick();
        expect(assign).not.toHaveBeenCalled();
        expect(storage.map.has(FLOW_KEY)).toBe(false);
        await headline('Sign-in failed.');
    });

    it('a failure between login_as_guest and request_link_code (the 10 s start limit) stops the flow', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const guestCall = deferred();
        const conn = signInConnection();
        conn.reducers.loginAsGuest.mockImplementation(() => guestCall.promise);
        renderWithConnection('/?login=1', conn);
        act(() => {
            conn.apply(LAYER0_QUERIES.profile);
            conn.apply(LAYER0_QUERIES.lobbies);
        });
        await headline('Sign in.');
        fireEvent.click(screen.getByRole('button', { name: 'Sign in with Discord' }));
        await waitFor(() => expect(conn.reducers.loginAsGuest).toHaveBeenCalledTimes(1));
        await act(() => vi.advanceTimersByTimeAsync(10_000));
        await headline('Sign-in failed.');
        guestCall.resolve();
        await tick();
        expect(conn.reducers.requestLinkCode).not.toHaveBeenCalled();
        expect(subscribedToLinkView(conn)).toBe(false);
        await headline('Sign-in failed.');
    });

    it('leaving the panel between login_as_guest and request_link_code stops the flow', async () => {
        const guestCall = deferred();
        const conn = signInConnection();
        conn.reducers.loginAsGuest.mockImplementation(() => guestCall.promise);
        const r = renderWithConnection('/?login=1', conn);
        act(() => {
            conn.apply(LAYER0_QUERIES.profile);
            conn.apply(LAYER0_QUERIES.lobbies);
        });
        await headline('Sign in.');
        fireEvent.click(screen.getByRole('button', { name: 'Sign in with Discord' }));
        await waitFor(() => expect(conn.reducers.loginAsGuest).toHaveBeenCalledTimes(1));
        act(() => {
            void r.router.navigate({ href: '/' });
        });
        await headline('Module offline.');
        guestCall.resolve();
        await tick();
        expect(conn.reducers.requestLinkCode).not.toHaveBeenCalled();
    });

    it.each([
        ['resolves', (d: ReturnType<typeof deferred<void>>) => d.resolve()],
        ['is refused', (d: ReturnType<typeof deferred<void>>) => d.reject(new SenderError('No.'))],
    ])(
        'leaving the panel while confirm_link is in flight: when it %s, nothing navigates or changes',
        async (_l, settle) => {
            storage.map.set(FLOW_KEY, JSON.stringify({ id: 'marker', next: '/profile' }));
            jar.cookies.set(CONFIRM_COOKIE, TOKEN);
            const r = renderAt('/?login=1&status=confirm', guest());
            await waitFor(() => expect(subscribedToLinkView(r.conn)).toBe(true));
            r.conn.db.viewMyLinkRequest.seed(
                linkRow({ awaitingConfirm: true, pendingProviderName: 'kafka', inMs: 120_000 }),
            );
            act(() => r.conn.apply(LINK_REQUEST_QUERY));
            await headline('Link account.');
            const call = deferred();
            r.conn.reducers.confirmLink.mockImplementation(() => call.promise);
            fireEvent.click(screen.getByRole('button', { name: 'Link this account' }));
            await waitFor(() => expect(r.conn.reducers.confirmLink).toHaveBeenCalledTimes(1));
            // The confirming panel offers no Cancel; leaving the panel is the cancel that can happen.
            expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
            act(() => {
                void r.router.navigate({ href: '/' });
            });
            await headline('Module offline.');
            settle(call);
            const before = [...r.conn.db.viewMyProfile.iter()][0] as MyProfileRow;
            act(() => r.conn.db.viewMyProfile.update(before, member()));
            await tick();
            // A live hook would have sent the member to next (/profile) or shown the refusal.
            expect(href(r)).toBe('/');
            await headline('Module offline.');
        },
    );

    it('a same-handle row of a new flow, in the cache but not rendered yet, is caught at the click', async () => {
        storage.map.set(FLOW_KEY, JSON.stringify({ id: 'marker', next: '/profile' }));
        jar.cookies.set(CONFIRM_COOKIE, TOKEN);
        const r = renderAt('/?login=1&status=confirm', guest());
        await waitFor(() => expect(subscribedToLinkView(r.conn)).toBe(true));
        r.conn.db.viewMyLinkRequest.seed(
            linkRow({ awaitingConfirm: true, pendingProviderName: 'kafka', inMs: 120_000 }),
        );
        act(() => r.conn.apply(LINK_REQUEST_QUERY));
        await headline('Link account.');
        r.conn.db.viewMyLinkRequest.rows = [
            linkRow({ awaitingConfirm: true, pendingProviderName: 'kafka', inMs: 110_000 }),
        ];
        fireEvent.click(screen.getByRole('button', { name: 'Link this account' }));
        await headline('Sign-in failed.');
        expect(
            screen.getByText('The sign-in changed in another tab. Please try again.'),
        ).toBeInTheDocument();
        expect(r.conn.reducers.confirmLink).not.toHaveBeenCalled();
        expect(jar.cookies.get(CONFIRM_COOKIE)).toBe(TOKEN);
    });

    it("the checking timeout in a tab without a marker leaves the cookie alone (it may be another tab's)", async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        jar.cookies.set(CONFIRM_COOKIE, TOKEN);
        // No marker, and the profile view never answers: the panel stays on "checking".
        const conn = signInConnection();
        renderWithConnection('/?login=1&status=confirm', conn);
        await waitFor(() =>
            expect(screen.getByRole('button', { name: 'Sign in with Discord' })).toBeDisabled(),
        );
        await act(() => vi.advanceTimersByTimeAsync(10_000));
        await headline('Sign-in failed.');
        expect(jar.cookies.get(CONFIRM_COOKIE)).toBe(TOKEN);
        expect(jar.events.filter((e) => e.startsWith('remove'))).toEqual([]);
        expect(conn.reducers.confirmLink).not.toHaveBeenCalled();
    });
});

describe('return: refused, cancelled, failed', () => {
    it('refused: the text from the cookie, as text, and the cookie deleted', async () => {
        const text = '<b>You are banned</b> & "more"';
        jar.cookies.set(REFUSAL_COOKIE, encodeURIComponent(text));
        storage.map.set(FLOW_KEY, JSON.stringify({ id: 'm' }));
        const r = renderAt('/?login=1&status=refused', guest());
        await headline('Sign-in refused.');
        expect(screen.getByText(text)).toBeInTheDocument();
        expect(document.querySelector('main b')).toBeNull();
        expect(jar.cookies.has(REFUSAL_COOKIE)).toBe(false);
        expect(storage.map.has(FLOW_KEY)).toBe(false);
        await waitFor(() => expect(href(r)).toBe('/?login=1'));
        expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    });

    it('refused without a cookie: the fixed line', async () => {
        renderAt('/?login=1&status=refused', guest());
        await headline('Sign-in refused.');
        expect(screen.getByText('Nothing was changed. You can try again.')).toBeInTheDocument();
    });

    it.each(['cancelled', 'failed'])(
        '%s: "Sign-in failed." with the fixed line and Try again',
        async (status) => {
            renderAt(`/?login=1&status=${status}`, guest());
            await headline('Sign-in failed.');
            expect(screen.getByText('Nothing was changed. You can try again.')).toBeInTheDocument();
            expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
        },
    );

    it('Try again starts a new flow', async () => {
        const { conn } = renderAt('/?login=1&status=failed', guest());
        await headline('Sign-in failed.');
        fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
        await waitFor(() => expect(conn.reducers.requestLinkCode).toHaveBeenCalledTimes(1));
    });

    it('a code or token in the URL is never used', async () => {
        storage.map.set(FLOW_KEY, JSON.stringify({ id: 'm' }));
        const r = renderAt(
            `/?login=1&status=confirm&token=${TOKEN}&confirmToken=${TOKEN}&code=${CODE}`,
            guest(),
        );
        await waitFor(() => expect(subscribedToLinkView(r.conn)).toBe(true));
        r.conn.db.viewMyLinkRequest.seed(
            linkRow({ awaitingConfirm: true, pendingProviderName: 'kafka', inMs: 120_000 }),
        );
        act(() => r.conn.apply(LINK_REQUEST_QUERY));
        await headline('Link account.');
        fireEvent.click(screen.getByRole('button', { name: 'Link this account' }));
        // No cookie: the URL's token is not a substitute.
        await headline('Sign-in failed.');
        expect(r.conn.reducers.confirmLink).not.toHaveBeenCalled();
    });
});
