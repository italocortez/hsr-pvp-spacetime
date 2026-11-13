import { createMemoryHistory, createRouter } from '@tanstack/react-router';
import { cleanup, render } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach } from 'vitest';
import { App } from '@/App';
import { type AuthSnapshot, setAuthSnapshot } from '@/auth/authStore';
import { router as appRouter } from '@/router';
import { ConnectionScope } from '@/stdb/ConnectionScope';
import { resetConnectionStatus } from '@/stdb/connectionStatus';
import { resetReferenceSetForTests } from '@/stdb/referenceSet';
import type { MockConnection } from './mockConnection';

// Unmount first, then reset every session store the connection layer keeps.
afterEach(() => {
    cleanup();
    setAuthSnapshot({ ready: true });
    resetConnectionStatus();
    resetReferenceSetForTests();
    document.title = '';
});

/**
 * The real `App` and route tree at `path` (memory history, the app's router options) inside
 * `ConnectionScope` with the mock connection, in StrictMode like main.tsx. Layer 0 starts on the
 * mock; tests apply its subscriptions and change its rows inside `act`.
 */
export function renderWithConnection(
    path: string,
    conn: MockConnection,
    auth: AuthSnapshot = { ready: false },
) {
    setAuthSnapshot(auth);
    const router = createRouter({
        ...appRouter.options,
        history: createMemoryHistory({ initialEntries: [path] }),
        context: { auth },
    });
    const tree = (connection: MockConnection) => (
        <StrictMode>
            <ConnectionScope connection={connection}>
                <App router={router} />
            </ConnectionScope>
        </StrictMode>
    );
    const rendered = render(tree(conn));
    /** The provider handing over a new connection object (a rebuild, or Retry). */
    const rerenderWithConnection = (next: MockConnection) => rendered.rerender(tree(next));
    return { router, rerenderWithConnection, ...rendered };
}
