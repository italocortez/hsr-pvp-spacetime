import { act, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    type ConnectionStatus,
    resetConnectionStatus,
    setConnectionStatus,
} from '@/stdb/connectionStatus';
import {
    ConnectionBanner,
    RECONNECTING_NOTICE_MS,
    useReconnectingNotice,
} from './ConnectionBanner';

/* T-SHELL (S14.1): the reconnecting banner appears only after 2 s of `reconnecting`. */

const RECONNECTING: ConnectionStatus = { state: 'reconnecting', reason: 'Connection lost' };
const set = (status: ConnectionStatus) => act(() => setConnectionStatus(status));
const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));

beforeEach(() => {
    vi.useFakeTimers();
    resetConnectionStatus();
});
afterEach(() => {
    vi.useRealTimers();
    resetConnectionStatus();
});

describe('useReconnectingNotice', () => {
    it('the delay is 2 seconds', () => {
        expect(RECONNECTING_NOTICE_MS).toBe(2000);
    });

    it('never shows for the first connecting, however long it lasts', () => {
        const { result } = renderHook(() => useReconnectingNotice());
        advance(60_000);
        expect(result.current).toBe(false);
    });

    it('nothing before 2 s of reconnecting, shown at 2 s', () => {
        const { result } = renderHook(() => useReconnectingNotice());
        set({ state: 'connected' });
        set(RECONNECTING);
        advance(1999);
        expect(result.current).toBe(false);
        advance(1);
        expect(result.current).toBe(true);
    });

    it('a blip that recovers within 2 s shows nothing', () => {
        const { result } = renderHook(() => useReconnectingNotice());
        set(RECONNECTING);
        advance(1500);
        set({ state: 'connected' });
        advance(5000);
        expect(result.current).toBe(false);
    });

    it('gone on recovery, and a new drop waits 2 s again', () => {
        const { result } = renderHook(() => useReconnectingNotice());
        set(RECONNECTING);
        advance(2000);
        expect(result.current).toBe(true);
        set({ state: 'connected' });
        expect(result.current).toBe(false);
        set(RECONNECTING);
        advance(1999);
        expect(result.current).toBe(false);
        advance(1);
        expect(result.current).toBe(true);
    });

    it('a new reason while reconnecting does not restart the delay', () => {
        const { result } = renderHook(() => useReconnectingNotice());
        set(RECONNECTING);
        advance(1500);
        set({ state: 'reconnecting', reason: 'Reconnect failed' });
        advance(500);
        expect(result.current).toBe(true);
    });

    it('a change to failed hides it (the offline splash takes over)', () => {
        const { result } = renderHook(() => useReconnectingNotice());
        set(RECONNECTING);
        advance(2000);
        set({ state: 'failed', kind: 'offline', reason: 'x', recovery: 'retry' });
        expect(result.current).toBe(false);
    });
});

describe('ConnectionBanner', () => {
    it('a polite live region that holds "Reconnecting…" only while the notice is due', () => {
        const { container } = render(<ConnectionBanner />);
        const region = container.querySelector('[data-connection-banner]') as HTMLElement;
        expect(region).toHaveAttribute('aria-live', 'polite');
        expect(region).toBeEmptyDOMElement();
        set(RECONNECTING);
        advance(1999);
        expect(region).toBeEmptyDOMElement();
        advance(1);
        expect(screen.getByText('Reconnecting…')).toBeInTheDocument();
        set({ state: 'connected' });
        expect(region).toBeEmptyDOMElement();
    });
});
