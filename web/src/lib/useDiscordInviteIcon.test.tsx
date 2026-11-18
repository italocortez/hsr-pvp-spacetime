import { act, render, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    discordInviteApiUrl,
    entryFromInviteAnswer,
    FAILED_LOOKUP_TTL_MS,
    resetDiscordInviteCacheForTests,
    useDiscordInviteIcon,
} from './useDiscordInviteIcon';

/*
 * T-S14.4p: the Discord icon lookup. `fetch` is mocked in every test; nothing reaches Discord.
 * The answer is checked strictly before an address is built; any failure gives undefined (the
 * caller's fallback); answers are remembered for the session, failures for a short while.
 */

const GUILD = '1234567890123456789';
const HASH = '0123456789abcdef0123456789abcdef';
const ICON = `https://cdn.discordapp.com/icons/${GUILD}/${HASH}.webp?size=128`;

const answer = (guild: unknown) =>
    ({ ok: true, json: () => Promise.resolve({ code: 'HbXErzYVQ5', guild }) }) as Response;

let fetchMock: ReturnType<typeof vi.fn>;

/** Two users of one code at once. */
function Two() {
    const a = useDiscordInviteIcon('HbXErzYVQ5');
    const b = useDiscordInviteIcon('HbXErzYVQ5');
    return <p>{`${a ?? '-'} ${b ?? '-'}`}</p>;
}

beforeEach(() => {
    resetDiscordInviteCacheForTests();
    sessionStorage.clear();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe('useDiscordInviteIcon', () => {
    it('asks the invite endpoint once (GET, no credentials, no headers) and builds the CDN address', async () => {
        fetchMock.mockResolvedValue(answer({ id: GUILD, icon: HASH }));
        const { result } = renderHook(() => useDiscordInviteIcon('HbXErzYVQ5'));
        expect(result.current).toBeUndefined();
        await waitFor(() => expect(result.current).toBe(ICON));
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('https://discord.com/api/v10/invites/HbXErzYVQ5');
        expect(init).toEqual({ method: 'GET', credentials: 'omit' });
    });

    it('an animated icon (a_ prefix) gives its webp address', async () => {
        fetchMock.mockResolvedValue(answer({ id: GUILD, icon: `a_${HASH}` }));
        const { result } = renderHook(() => useDiscordInviteIcon('anim-1'));
        await waitFor(() =>
            expect(result.current).toBe(
                `https://cdn.discordapp.com/icons/${GUILD}/a_${HASH}.webp?size=128`,
            ),
        );
    });

    it('a second render (and a remount) makes no second request: the answer is remembered', async () => {
        fetchMock.mockResolvedValue(answer({ id: GUILD, icon: HASH }));
        const first = renderHook(() => useDiscordInviteIcon('HbXErzYVQ5'));
        await waitFor(() => expect(first.result.current).toBe(ICON));
        first.rerender();
        first.unmount();
        const second = renderHook(() => useDiscordInviteIcon('HbXErzYVQ5'));
        // Known at the first render: no flash of the fallback.
        expect(second.result.current).toBe(ICON);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('the answer survives a fresh in-memory map through sessionStorage (a reload)', async () => {
        fetchMock.mockResolvedValue(answer({ id: GUILD, icon: HASH }));
        const first = renderHook(() => useDiscordInviteIcon('HbXErzYVQ5'));
        await waitFor(() => expect(first.result.current).toBe(ICON));
        first.unmount();
        resetDiscordInviteCacheForTests();
        const { result } = renderHook(() => useDiscordInviteIcon('HbXErzYVQ5'));
        expect(result.current).toBe(ICON);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('a tampered stored entry is checked like an answer and ignored', async () => {
        sessionStorage.setItem(
            'hsr.discordInvite.HbXErzYVQ5',
            JSON.stringify({ kind: 'icon', guildId: 'evil.example/x', icon: HASH }),
        );
        fetchMock.mockResolvedValue(answer({ id: GUILD, icon: HASH }));
        const { result } = renderHook(() => useDiscordInviteIcon('HbXErzYVQ5'));
        expect(result.current).toBeUndefined();
        await waitFor(() => expect(result.current).toBe(ICON));
    });

    it('two tiles of one code share one request', async () => {
        fetchMock.mockResolvedValue(answer({ id: GUILD, icon: HASH }));
        const { container } = render(<Two />);
        await waitFor(() => expect(container.textContent).toBe(`${ICON} ${ICON}`));
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it.each([
        ['a network error', () => Promise.reject(new TypeError('Failed to fetch'))],
        [
            'a 404',
            () => Promise.resolve({ ok: false, json: () => Promise.resolve({}) } as Response),
        ],
        [
            'a body that is not JSON',
            () =>
                Promise.resolve({
                    ok: true,
                    json: () => Promise.reject(new SyntaxError('x')),
                } as Response),
        ],
    ])('%s: undefined (the fallback)', async (_label, reply) => {
        fetchMock.mockImplementation(reply);
        const { result } = renderHook(() => useDiscordInviteIcon('HbXErzYVQ5'));
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        await act(async () => {});
        expect(result.current).toBeUndefined();
    });

    it('a failed lookup is remembered for a short while, then tried again', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
        const first = renderHook(() => useDiscordInviteIcon('HbXErzYVQ5'));
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        await act(async () => {});
        first.unmount();

        const again = renderHook(() => useDiscordInviteIcon('HbXErzYVQ5'));
        await act(async () => {});
        expect(again.result.current).toBeUndefined();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        again.unmount();

        vi.advanceTimersByTime(FAILED_LOOKUP_TTL_MS + 1);
        fetchMock.mockResolvedValue(answer({ id: GUILD, icon: HASH }));
        const later = renderHook(() => useDiscordInviteIcon('HbXErzYVQ5'));
        await waitFor(() => expect(later.result.current).toBe(ICON));
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('a code without the invite shape asks nothing', async () => {
        const { result } = renderHook(() => useDiscordInviteIcon('../users/@me'));
        await act(async () => {});
        expect(result.current).toBeUndefined();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('works without sessionStorage (it throws): the in-memory map still remembers', async () => {
        const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
            throw new Error('SecurityError');
        });
        const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new Error('SecurityError');
        });
        try {
            fetchMock.mockResolvedValue(answer({ id: GUILD, icon: HASH }));
            const first = renderHook(() => useDiscordInviteIcon('HbXErzYVQ5'));
            await waitFor(() => expect(first.result.current).toBe(ICON));
            const second = renderHook(() => useDiscordInviteIcon('HbXErzYVQ5'));
            expect(second.result.current).toBe(ICON);
            expect(fetchMock).toHaveBeenCalledTimes(1);
        } finally {
            getItem.mockRestore();
            setItem.mockRestore();
        }
    });
});

describe('the answer is checked strictly', () => {
    it.each([
        ['no guild', { code: 'x' }],
        ['guild not an object', { guild: 'x' }],
        ['id not digits', { guild: { id: 'abc', icon: HASH } }],
        ['id a number', { guild: { id: 123, icon: HASH } }],
        ['id with a path', { guild: { id: '1/../../x', icon: HASH } }],
        ['icon not hex', { guild: { id: GUILD, icon: 'zz'.repeat(16) } }],
        ['icon too short', { guild: { id: GUILD, icon: 'abc' } }],
        ['icon upper case', { guild: { id: GUILD, icon: HASH.toUpperCase() } }],
        ['icon with a query', { guild: { id: GUILD, icon: `${HASH}?x=1` } }],
        ['icon missing', { guild: { id: GUILD } }],
        ['body null', null],
    ])('%s: no entry (a failed lookup)', (_label, body) => {
        expect(entryFromInviteAnswer(body)).toBeUndefined();
    });

    it('a guild without an icon (null): "none", the fallback without a retry', async () => {
        expect(entryFromInviteAnswer({ guild: { id: GUILD, icon: null } })).toEqual({
            kind: 'none',
        });
        fetchMock.mockResolvedValue(answer({ id: GUILD, icon: null }));
        const first = renderHook(() => useDiscordInviteIcon('no-icon'));
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        await act(async () => {});
        expect(first.result.current).toBeUndefined();
        renderHook(() => useDiscordInviteIcon('no-icon'));
        await act(async () => {});
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('a malformed answer from the endpoint gives the fallback', async () => {
        fetchMock.mockResolvedValue(answer({ id: GUILD, icon: '../../evil' }));
        const { result } = renderHook(() => useDiscordInviteIcon('HbXErzYVQ5'));
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        await act(async () => {});
        expect(result.current).toBeUndefined();
    });

    it('the endpoint address', () => {
        expect(discordInviteApiUrl('HbXErzYVQ5')).toBe(
            'https://discord.com/api/v10/invites/HbXErzYVQ5',
        );
    });
});
