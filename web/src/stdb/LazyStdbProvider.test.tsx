import { createMemoryHistory, createRouter } from '@tanstack/react-router';
import { act, render, screen, waitFor } from '@testing-library/react';
import { type ReactNode, StrictMode, useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '@/App';
import { setAuthSnapshot } from '@/auth/authStore';
import { router as appRouter } from '@/router';
import { MockConnection } from '@/test/mockConnection';
import { StdbConnectionContext, useStdbConnection } from './connectionContext';
import { connectionStatusStore, resetConnectionStatus } from './connectionStatus';
import { LazyStdbProvider } from './LazyStdbProvider';
import type { StdbConnectionLike } from './types';

/*
 * T-SHELL item 7 (S14.1): the connection layer loads after the first render. A public route
 * renders while the connection module has not resolved; once it does, the app receives the
 * connection without remounting; a chunk that fails to load shows the offline splash with a
 * reloading Retry. No SDK and no socket here: the loader is a stub.
 */

type ProviderModule = { StdbProvider: (props: { children?: ReactNode }) => ReactNode };

afterEach(() => {
    resetConnectionStatus();
    setAuthSnapshot({ ready: true });
});

function appAt(path: string) {
    const router = createRouter({
        ...appRouter.options,
        history: createMemoryHistory({ initialEntries: [path] }),
        context: { auth: { ready: false } },
    });
    return <App router={router} />;
}

/** Counts mounts and shows the connection the app sees. */
const mounts = vi.fn();
function Probe() {
    const conn = useStdbConnection();
    useEffect(() => {
        mounts();
    }, []);
    return <output data-testid="conn">{conn ? 'connected' : 'none'}</output>;
}

/** A stand-in for StdbProvider: hands `fakeConn` to its children like ConnectionScope does. */
let fakeConn: StdbConnectionLike | null = null;
function FakeProvider({ children }: { children?: ReactNode }) {
    return (
        <StdbConnectionContext.Provider value={fakeConn}>{children}</StdbConnectionContext.Provider>
    );
}
function fakeModule(conn: StdbConnectionLike): ProviderModule {
    fakeConn = conn;
    return { StdbProvider: FakeProvider };
}

describe('LazyStdbProvider', () => {
    it('a public route renders before the connection module resolves', async () => {
        setAuthSnapshot({ ready: false });
        const load = vi.fn(() => new Promise<ProviderModule>(() => {}));
        render(
            <StrictMode>
                <LazyStdbProvider load={load}>{appAt('/costs')}</LazyStdbProvider>
            </StrictMode>,
        );
        expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent(
            'Module offline.',
        );
        expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument();
        expect(load).toHaveBeenCalled();
        expect(connectionStatusStore.getSnapshot().status).toEqual({ state: 'connecting' });
    });

    it('the app gets the connection once the module resolves, without remounting', async () => {
        mounts.mockClear();
        const conn = new MockConnection();
        let resolve: (m: ProviderModule) => void = () => {};
        const load = () =>
            new Promise<ProviderModule>((r) => {
                resolve = r;
            });
        render(
            <LazyStdbProvider load={load}>
                <Probe />
            </LazyStdbProvider>,
        );
        expect(screen.getByTestId('conn')).toHaveTextContent('none');
        await act(async () => resolve(fakeModule(conn)));
        await waitFor(() => expect(screen.getByTestId('conn')).toHaveTextContent('connected'));
        expect(mounts).toHaveBeenCalledTimes(1);
    });

    it('a chunk that fails to load: failed (offline) with a reloading Retry', async () => {
        const load = () => Promise.reject(new Error('Failed to fetch dynamically imported module'));
        render(
            <LazyStdbProvider load={load}>
                <Probe />
            </LazyStdbProvider>,
        );
        await waitFor(() =>
            expect(connectionStatusStore.getSnapshot().status).toMatchObject({
                state: 'failed',
                kind: 'offline',
                recovery: 'reload',
            }),
        );
    });
});
