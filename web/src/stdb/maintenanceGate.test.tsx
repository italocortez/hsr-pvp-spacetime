import { createMemoryHistory, createRouter } from '@tanstack/react-router';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { StrictMode, useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { App } from '@/App';
import { setAuthSnapshot } from '@/auth/authStore';
import { router as appRouter } from '@/router';
import { MockConnection } from '@/test/mockConnection';
import {
    connectionStatusStore,
    failConnection,
    resetConnectionStatus,
    retryConnection,
    setConnectionStatus,
} from './connectionStatus';
import { LAYER0_QUERIES } from './layer0';
import { MaintenanceGate, MIN_GAP_MS, RECHECK_MS } from './MaintenanceGate';
import { resetReferenceSetForTests } from './referenceSet';
import { MAINTENANCE_SKIP_KEY } from './statusFile';
import type { StdbConnectionLike } from './types';

/*
 * The maintenance status file in front of the connection (T-M7): the real App and route tree
 * under `MaintenanceGate`, in StrictMode like main.tsx. The status read is a stub and the
 * connector is `FakeProvider`, a component that reports the mock connection up the way the SDK
 * provider does in the app, so nothing opens a socket or touches the network. A connector render
 * is what builds the connection in the app. Fake timers drive the re-read timer; no `waitFor`.
 */

type Report = (connection: StdbConnectionLike | null) => void;
type PendingRead = { resolve: (maintenance: boolean) => void; signal: AbortSignal };

let conn: MockConnection;
/** `auto`: every read answers `maintenance` at once. `manual`: reads wait in `pending`. */
let mode: 'auto' | 'manual';
let maintenance: boolean;
let pending: PendingRead[];
let readStatus: Mock<(signal: AbortSignal) => Promise<boolean>>;
let providerMounts: number;
let connector: Mock<(report: Report) => React.ReactNode>;

function FakeProvider({ report }: { report: Report }) {
    useEffect(() => {
        providerMounts++;
        report(conn);
        return () => report(null);
    }, [report]);
    return null;
}

beforeEach(() => {
    vi.useFakeTimers();
    conn = new MockConnection();
    mode = 'auto';
    maintenance = false;
    pending = [];
    providerMounts = 0;
    readStatus = vi.fn(
        (signal: AbortSignal) =>
            new Promise<boolean>((resolve) => {
                if (mode === 'auto') resolve(maintenance);
                else pending.push({ resolve, signal });
            }),
    );
    connector = vi.fn((report: Report) => <FakeProvider report={report} />);
    setAuthSnapshot({ ready: false });
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
    setAuthSnapshot({ ready: true });
    resetConnectionStatus();
    resetReferenceSetForTests();
    sessionStorage.clear();
    window.history.replaceState(null, '', '/');
    document.title = '';
});

/** Lets promises settle and runs timers up to `ms` from now, inside act. */
async function advance(ms = 0) {
    await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
    });
}

let probeMounts = 0;
function Probe() {
    useEffect(() => {
        probeMounts++;
    }, []);
    return <input aria-label="probe" />;
}

async function renderGate(path: string) {
    const router = createRouter({
        ...appRouter.options,
        history: createMemoryHistory({ initialEntries: [path] }),
        context: { auth: { ready: false } },
    });
    const rendered = render(
        <StrictMode>
            <MaintenanceGate connector={connector} readStatus={readStatus}>
                <Probe />
                <App router={router} />
            </MaintenanceGate>
        </StrictMode>,
    );
    await advance();
    return rendered;
}

const h1 = () => screen.queryByRole('heading', { level: 1 });
const offline = () => failConnection(new Error('WebSocket error'));

function expectMaintenanceSplash() {
    expect(h1()).toHaveTextContent('Under maintenance.');
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getAllByRole('main')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
}

/** Connector rendered and the mock connection in use (Layer 0 subscribed on it). */
function expectConnected() {
    expect(connector).toHaveBeenCalled();
    expect(conn.liveQueries()).toEqual([LAYER0_QUERIES.profile, LAYER0_QUERIES.lobbies]);
}

describe('before the first connection', () => {
    it('a public route renders while the file loads, and nothing connects until it answers', async () => {
        mode = 'manual';
        await renderGate('/');
        expect(h1()).toHaveTextContent('Module offline.');
        expect(connector).not.toHaveBeenCalled();
        expect(connectionStatusStore.getSnapshot().status).toEqual({ state: 'connecting' });

        pending[0]?.resolve(false);
        await advance();
        expectConnected();
    });

    it('the file is read once for the first connection (StrictMode included), and never again while connected', async () => {
        await renderGate('/');
        expectConnected();
        await advance(5 * RECHECK_MS);
        expect(readStatus).toHaveBeenCalledTimes(1);
    });

    it('maintenance true: no connection is built; the maintenance splash shows with one h1, one main and Retry', async () => {
        maintenance = true;
        await renderGate('/lobbies');
        expectMaintenanceSplash();
        expect(connectionStatusStore.getSnapshot().status).toMatchObject({
            state: 'failed',
            kind: 'maintenance',
            recovery: 'retry',
        });
        await advance(5 * RECHECK_MS);
        expect(connector).not.toHaveBeenCalled();
        expect(conn.subscriptions).toHaveLength(0);
        expect(readStatus).toHaveBeenCalledTimes(1);
    });

    it('Retry reads the file again: still in maintenance, the splash stays and nothing connects', async () => {
        maintenance = true;
        await renderGate('/');
        fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
        await advance();
        expect(readStatus).toHaveBeenCalledTimes(2);
        expectMaintenanceSplash();
        expect(connector).not.toHaveBeenCalled();
    });

    it('Retry after the file flips to false connects and the route returns', async () => {
        maintenance = true;
        await renderGate('/');
        expectMaintenanceSplash();
        maintenance = false;
        fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
        await advance();
        expectConnected();
        expect(h1()).toHaveTextContent('Module offline.');
    });

    it('?maintenance=skip connects in spite of maintenance true, without reading the file, and the tab remembers it', async () => {
        maintenance = true;
        window.history.replaceState(null, '', '/?maintenance=skip');
        await renderGate('/');
        expectConnected();
        expect(readStatus).not.toHaveBeenCalled();
        expect(sessionStorage.getItem(MAINTENANCE_SKIP_KEY)).toBe('1');
    });

    it('a late "true" from a reader that ignores the abort cannot write the status after unmount', async () => {
        mode = 'manual';
        const { unmount } = await renderGate('/');
        const read = pending[0];
        unmount();
        await advance();
        read?.resolve(true);
        await advance();
        expect(connectionStatusStore.getSnapshot().status).toEqual({ state: 'connecting' });
    });

    it('unmount aborts a read in flight', async () => {
        mode = 'manual';
        const { unmount } = await renderGate('/');
        const read = pending[0];
        expect(read?.signal.aborted).toBe(false);
        unmount();
        await advance();
        expect(read?.signal.aborted).toBe(true);
    });
});

describe('stable tree', () => {
    it('the app mounts once: an input keeps its node, value and focus across the answer and a maintenance on/off change', async () => {
        mode = 'manual';
        probeMounts = 0;
        await renderGate('/');
        const input = screen.getByLabelText('probe') as HTMLInputElement;
        const heading = h1();
        const mountsAfterStart = probeMounts;
        input.focus();
        fireEvent.change(input, { target: { value: 'typed' } });

        // The answer: the connector appears beside the app.
        pending[0]?.resolve(false);
        await advance();
        expectConnected();
        expect(h1()).toBe(heading);

        // Maintenance on: a failure, then the re-read says true.
        act(offline);
        await advance(MIN_GAP_MS);
        pending[1]?.resolve(true);
        await advance();
        expectMaintenanceSplash();

        // Maintenance off: Retry.
        fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
        await advance();
        pending[2]?.resolve(false);
        await advance();
        expect(h1()).toHaveTextContent('Module offline.');

        expect(screen.getByLabelText('probe')).toBe(input);
        expect(input.value).toBe('typed');
        expect(document.activeElement).toBe(input);
        expect(probeMounts).toBe(mountsAfterStart);
    });
});

describe('after a failed connection', () => {
    it('failed, then the file says maintenance: the timer re-read shows the maintenance splash without a click, and the connector goes', async () => {
        await renderGate('/');
        expectConnected();
        const mountsBefore = providerMounts;

        maintenance = true;
        act(offline);
        expect(h1()).toHaveTextContent('Connection lost.');
        await advance(MIN_GAP_MS - 1);
        expect(readStatus).toHaveBeenCalledTimes(1);
        await advance(1);
        expect(readStatus).toHaveBeenCalledTimes(2);
        expectMaintenanceSplash();
        // The connector unmounted: Layer 0 let go of its subscriptions.
        expect(conn.live()).toHaveLength(0);

        maintenance = false;
        fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
        await advance();
        expect(providerMounts).toBeGreaterThan(mountsBefore);
        expect(conn.liveQueries()).toEqual([LAYER0_QUERIES.profile, LAYER0_QUERIES.lobbies]);
    });

    it('while failed and not in maintenance, the file is read every RECHECK_MS; recovery stops the timer', async () => {
        await renderGate('/');
        act(offline);
        await advance(MIN_GAP_MS);
        expect(readStatus).toHaveBeenCalledTimes(2);
        await advance(RECHECK_MS - 1);
        expect(readStatus).toHaveBeenCalledTimes(2);
        await advance(1);
        expect(readStatus).toHaveBeenCalledTimes(3);
        expect(h1()).toHaveTextContent('Connection lost.');

        act(() => setConnectionStatus({ state: 'connected' }));
        await advance(5 * RECHECK_MS);
        expect(readStatus).toHaveBeenCalledTimes(3);
    });

    it('a second failure reason in the same episode keeps the RECHECK_MS rhythm', async () => {
        await renderGate('/');
        act(offline);
        await advance(MIN_GAP_MS); // read 2 at 30 s
        expect(readStatus).toHaveBeenCalledTimes(2);
        await advance(10_000);
        act(() => failConnection(new Error('Another failure')));
        await advance(RECHECK_MS - 10_000 - 1);
        expect(readStatus).toHaveBeenCalledTimes(2);
        await advance(1); // 60 s after read 2
        expect(readStatus).toHaveBeenCalledTimes(3);
    });

    it('a failure right after a read waits MIN_GAP_MS; recovery before it fires reads nothing', async () => {
        await renderGate('/');
        await advance(10_000);
        act(offline);
        act(() => setConnectionStatus({ state: 'connected' }));
        await advance(5 * RECHECK_MS);
        expect(readStatus).toHaveBeenCalledTimes(1);
    });

    it('never more than one read in flight', async () => {
        await renderGate('/');
        mode = 'manual';
        act(offline);
        await advance(MIN_GAP_MS);
        expect(pending).toHaveLength(1);
        act(() => failConnection(new Error('Another failure')));
        await advance(5 * RECHECK_MS);
        expect(readStatus).toHaveBeenCalledTimes(2);
    });

    it('a read in flight at recovery is aborted and its late "true" changes nothing', async () => {
        await renderGate('/');
        mode = 'manual';
        act(offline);
        await advance(MIN_GAP_MS);
        const read = pending[0];
        act(() => setConnectionStatus({ state: 'connected' }));
        await advance();
        expect(read?.signal.aborted).toBe(true);
        read?.resolve(true);
        await advance();
        expect(connectionStatusStore.getSnapshot().status).toEqual({ state: 'connected' });
        expect(conn.live()).toHaveLength(2);
    });

    it('Retry on the offline splash reads the file at once, in parallel with the rebuild, and aborts a read in flight', async () => {
        await renderGate('/');
        mode = 'manual';
        act(offline);
        await advance(MIN_GAP_MS);
        const stale = pending[0];
        fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
        await advance();
        expect(stale?.signal.aborted).toBe(true);
        expect(readStatus).toHaveBeenCalledTimes(3);
        // The rebuild does not wait for the answer: the route is back, the connector stayed.
        expect(h1()).toHaveTextContent('Module offline.');
        expect(conn.live()).toHaveLength(2);
        stale?.resolve(true);
        await advance();
        expect(connectionStatusStore.getSnapshot().status).toEqual({ state: 'connecting' });
        pending[1]?.resolve(false);
        await advance();
        expect(h1()).toHaveTextContent('Module offline.');
        expect(conn.live()).toHaveLength(2);
    });

    it('Retry on the offline splash during maintenance shows the maintenance splash at once, without the 30 s gap', async () => {
        await renderGate('/');
        act(offline);
        maintenance = true;
        fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
        await advance();
        expect(readStatus).toHaveBeenCalledTimes(2);
        expectMaintenanceSplash();
        expect(conn.live()).toHaveLength(0);
    });

    it('after a read aborted at recovery, the next failure reads again', async () => {
        await renderGate('/');
        mode = 'manual';
        act(offline);
        await advance(MIN_GAP_MS);
        expect(readStatus).toHaveBeenCalledTimes(2);
        act(() => setConnectionStatus({ state: 'connected' }));
        await advance();
        expect(pending[0]?.signal.aborted).toBe(true);
        act(() => failConnection(new Error('Another failure')));
        await advance(MIN_GAP_MS);
        expect(readStatus).toHaveBeenCalledTimes(3);
    });

    it('with the skip flag, a failure reads no file and stays on the offline splash', async () => {
        maintenance = true;
        sessionStorage.setItem(MAINTENANCE_SKIP_KEY, '1');
        await renderGate('/');
        expectConnected();
        act(offline);
        await advance(5 * RECHECK_MS);
        expect(h1()).toHaveTextContent('Connection lost.');
        expect(readStatus).not.toHaveBeenCalled();
    });
});

describe('a connected tab whose connection drops (reconnecting)', () => {
    const reconnecting = () =>
        setConnectionStatus({ state: 'reconnecting', reason: 'Connection lost' });

    it('reads after the gap, then every RECHECK_MS; "false" changes nothing visible; "true" shows the maintenance splash and removes the connector', async () => {
        await renderGate('/');
        expectConnected();
        act(reconnecting);
        await advance(MIN_GAP_MS - 1);
        expect(readStatus).toHaveBeenCalledTimes(1);
        await advance(1);
        expect(readStatus).toHaveBeenCalledTimes(2);
        // No splash while reconnecting, as before.
        expect(h1()).toHaveTextContent('Module offline.');
        expect(connectionStatusStore.getSnapshot().status.state).toBe('reconnecting');
        expect(conn.live()).toHaveLength(2);

        // One period at a time: the timer re-arms after each read.
        await advance(RECHECK_MS - 1);
        expect(readStatus).toHaveBeenCalledTimes(2);
        await advance(1);
        expect(readStatus).toHaveBeenCalledTimes(3);

        maintenance = true;
        await advance(RECHECK_MS);
        expect(readStatus).toHaveBeenCalledTimes(4);
        expectMaintenanceSplash();
        expect(connectionStatusStore.getSnapshot().status).toMatchObject({
            state: 'failed',
            kind: 'maintenance',
        });
        // The connector unmounted (the SDK provider's release ends its reconnect loop).
        expect(conn.live()).toHaveLength(0);
        await advance(RECHECK_MS);
        expect(readStatus).toHaveBeenCalledTimes(4);
    });

    it('recovery to connected stops the timer', async () => {
        await renderGate('/');
        act(reconnecting);
        await advance(MIN_GAP_MS);
        expect(readStatus).toHaveBeenCalledTimes(2);
        act(() => setConnectionStatus({ state: 'connected' }));
        await advance(RECHECK_MS);
        await advance(RECHECK_MS);
        expect(readStatus).toHaveBeenCalledTimes(2);
    });

    it('a recovery before the gap reads nothing', async () => {
        await renderGate('/');
        act(reconnecting);
        await advance(MIN_GAP_MS - 1000);
        act(() => setConnectionStatus({ state: 'connected' }));
        await advance(RECHECK_MS);
        expect(readStatus).toHaveBeenCalledTimes(1);
    });
});

describe('trouble episodes and hidden tabs', () => {
    const TEN_MIN = 10 * RECHECK_MS;
    const reconnecting = (reason = 'Connection lost') =>
        setConnectionStatus({ state: 'reconnecting', reason });
    let hiddenValue = false;

    beforeEach(() => {
        hiddenValue = false;
        Object.defineProperty(document, 'hidden', {
            configurable: true,
            get: () => hiddenValue,
        });
    });
    afterEach(() => {
        // Back to jsdom's own getter on the prototype.
        Reflect.deleteProperty(document, 'hidden');
    });
    const setHidden = (value: boolean) =>
        act(() => {
            hiddenValue = value;
            document.dispatchEvent(new Event('visibilitychange'));
        });

    it('a 3 s reconnecting blip on a tab whose last read is 10 minutes old reads nothing', async () => {
        await renderGate('/');
        await advance(TEN_MIN);
        act(() => reconnecting());
        await advance(3000);
        act(() => setConnectionStatus({ state: 'connected' }));
        await advance(RECHECK_MS);
        await advance(RECHECK_MS);
        expect(readStatus).toHaveBeenCalledTimes(1);
    });

    it('a reconnecting episode reads 30 s after it began, then 60 s later, even when the last read is old', async () => {
        await renderGate('/');
        await advance(TEN_MIN);
        act(() => reconnecting());
        await advance(MIN_GAP_MS - 1);
        expect(readStatus).toHaveBeenCalledTimes(1);
        await advance(1);
        expect(readStatus).toHaveBeenCalledTimes(2);
        await advance(RECHECK_MS - 1);
        expect(readStatus).toHaveBeenCalledTimes(2);
        await advance(1);
        expect(readStatus).toHaveBeenCalledTimes(3);
    });

    it('alternating reconnecting reasons keep the 60 s rhythm', async () => {
        await renderGate('/');
        await advance(TEN_MIN);
        act(() => reconnecting('Connection lost'));
        await advance(MIN_GAP_MS);
        expect(readStatus).toHaveBeenCalledTimes(2);
        for (let step = 0; step < 5; step++) {
            await advance(10_000);
            act(() => reconnecting(step % 2 === 0 ? 'Reconnect failed' : 'Connection lost'));
        }
        await advance(RECHECK_MS - 50_000 - 1);
        expect(readStatus).toHaveBeenCalledTimes(2);
        await advance(1);
        expect(readStatus).toHaveBeenCalledTimes(3);
    });

    it('a failed episode on a tab whose last read is old reads at once', async () => {
        await renderGate('/');
        await advance(TEN_MIN);
        act(offline);
        await advance();
        expect(readStatus).toHaveBeenCalledTimes(2);
    });

    it('reconnecting that turns into failed inside the episode reads at once when the gap allows', async () => {
        await renderGate('/');
        await advance(TEN_MIN);
        act(() => reconnecting());
        await advance(10_000);
        expect(readStatus).toHaveBeenCalledTimes(1);
        act(offline);
        await advance();
        expect(readStatus).toHaveBeenCalledTimes(2);
        // Then the 60 s rhythm.
        await advance(RECHECK_MS - 1);
        expect(readStatus).toHaveBeenCalledTimes(2);
        await advance(1);
        expect(readStatus).toHaveBeenCalledTimes(3);
    });

    it('a hidden tab skips the trouble re-read and reads when it becomes visible', async () => {
        await renderGate('/');
        await advance(TEN_MIN);
        setHidden(true);
        act(offline);
        await advance(RECHECK_MS);
        await advance(RECHECK_MS);
        expect(readStatus).toHaveBeenCalledTimes(1);
        setHidden(false);
        await advance();
        expect(readStatus).toHaveBeenCalledTimes(2);
    });

    it('a tab that becomes visible inside the gap still waits for it', async () => {
        await renderGate('/');
        act(offline);
        setHidden(true);
        await advance(10_000);
        setHidden(false);
        await advance(MIN_GAP_MS - 10_000 - 1);
        expect(readStatus).toHaveBeenCalledTimes(1);
        await advance(1);
        expect(readStatus).toHaveBeenCalledTimes(2);
    });

    it('a hidden tab still reads at page load and on a Retry click', async () => {
        hiddenValue = true;
        maintenance = true;
        await renderGate('/');
        expect(readStatus).toHaveBeenCalledTimes(1);
        expectMaintenanceSplash();
        maintenance = false;
        fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
        await advance();
        expect(readStatus).toHaveBeenCalledTimes(2);
        expectConnected();
    });
});

describe('gate closed', () => {
    it('closed by a "true" answer, a late SDK event that moves the status shows maintenance again at once, without a read', async () => {
        maintenance = true;
        await renderGate('/');
        expectMaintenanceSplash();
        act(() => setConnectionStatus({ state: 'connected' }));
        await advance();
        expectMaintenanceSplash();
        act(() => setConnectionStatus({ state: 'reconnecting', reason: 'late' }));
        await advance();
        expectMaintenanceSplash();
        await advance(RECHECK_MS);
        expect(readStatus).toHaveBeenCalledTimes(1);
        expect(connector).not.toHaveBeenCalled();
    });

    it('after an offline Retry and a "true" read, a late SDK event does not force a read', async () => {
        await renderGate('/');
        act(offline);
        maintenance = true;
        fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
        await advance();
        expectMaintenanceSplash();
        expect(readStatus).toHaveBeenCalledTimes(2);
        act(() => setConnectionStatus({ state: 'connecting' }));
        await advance(RECHECK_MS);
        expectMaintenanceSplash();
        expect(readStatus).toHaveBeenCalledTimes(2);
    });

    it('a second Retry aborts the first Retry read; its stale "true" changes nothing', async () => {
        maintenance = true;
        await renderGate('/');
        mode = 'manual';
        fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
        await advance();
        const stale = pending[0];
        act(retryConnection);
        await advance();
        expect(stale?.signal.aborted).toBe(true);
        pending[1]?.resolve(false);
        await advance();
        expectConnected();
        stale?.resolve(true);
        await advance();
        expect(connectionStatusStore.getSnapshot().status).toEqual({ state: 'connecting' });
        expect(conn.live()).toHaveLength(2);
    });

    it('a forced offline status with the gate closed starts no timer and no connection', async () => {
        maintenance = true;
        await renderGate('/');
        act(() =>
            setConnectionStatus({
                state: 'failed',
                kind: 'offline',
                reason: 'forced (dev)',
                recovery: 'retry',
            }),
        );
        await advance(5 * RECHECK_MS);
        expect(readStatus).toHaveBeenCalledTimes(1);
        expect(connector).not.toHaveBeenCalled();
    });
});
