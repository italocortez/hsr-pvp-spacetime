import { useSyncExternalStore } from 'react';
import { authStore, setAuthSnapshot } from '@/auth/authStore';

/*
 * Connection status, an external store like `auth/authStore.ts`. Written by the connection
 * callbacks (`connection.ts`) and by Layer 0 (`layer0.ts`), read by the root layout
 * (`ConnectionGate`).
 *
 * - `connecting`: the first attempt (or a Retry) is under way.
 * - `connected`: the socket is open.
 * - `reconnecting`: an established connection dropped and the SDK is retrying on its own.
 * - `failed`: the SDK will not retry this connection, or it is unusable (a Layer 0 subscription
 *   failed, the SDK closed it after a subscription error). When the SDK reported the failure
 *   itself, the React provider's manager may still rebuild in the background (1 s doubling to
 *   30 s), so `failed` can turn into `connected` without a click; Retry makes the next attempt
 *   immediate. `recovery: 'reload'` (a refused stored token) makes Retry reload the page.
 */

/** Exact text of the module's maintenance refusal (`client_connected`, spacetimedb/src/index.ts). */
export const MAINTENANCE_REFUSAL = 'Maintenance mode: connections are not accepted right now.';

export type FailureKind = 'offline' | 'maintenance';

/** How Retry recovers: a fresh builder, or a page reload (a builder cannot drop the provider's token). */
export type Recovery = 'retry' | 'reload';

export type ConnectionStatus =
    | { state: 'connecting' }
    | { state: 'connected' }
    | { state: 'reconnecting'; reason: string }
    | { state: 'failed'; kind: FailureKind; reason: string; recovery: Recovery };

type Snapshot = {
    status: ConnectionStatus;
    /** Bumped by Retry: the provider builds a fresh connection builder for each value. */
    generation: number;
};

let snapshot: Snapshot = { status: { state: 'connecting' }, generation: 0 };
const listeners = new Set<() => void>();

function publish(next: Snapshot): void {
    snapshot = next;
    for (const listener of listeners) listener();
}

export const connectionStatusStore = {
    getSnapshot(): Snapshot {
        return snapshot;
    },
    subscribe(listener: () => void): () => void {
        listeners.add(listener);
        return () => {
            listeners.delete(listener);
        };
    },
};

function sameStatus(a: ConnectionStatus, b: ConnectionStatus): boolean {
    const field = (s: ConnectionStatus, k: 'reason' | 'kind' | 'recovery') =>
        k in s ? (s as Record<string, unknown>)[k] : undefined;
    return (
        a.state === b.state &&
        field(a, 'reason') === field(b, 'reason') &&
        field(a, 'kind') === field(b, 'kind') &&
        field(a, 'recovery') === field(b, 'recovery')
    );
}

/** Replaces the status (no change, no notification). */
export function setConnectionStatus(status: ConnectionStatus): void {
    if (sameStatus(snapshot.status, status)) return;
    publish({ ...snapshot, status });
}

/**
 * The connection is unusable: status `failed` (offline or maintenance, from the error) and auth
 * not ready, so the guards wait and the root shows the splash. Auth is only replaced when it is
 * not already `{ ready: false }`, so a rebuild that fails again does not re-run the guards.
 */
export function failConnection(error: unknown, recovery: Recovery = 'retry'): void {
    setConnectionStatus({
        state: 'failed',
        kind: classifyFailure(error),
        reason: describeError(error, 'Connection failed'),
        recovery,
    });
    const auth = authStore.getSnapshot();
    if (auth.ready || auth.user) setAuthSnapshot({ ready: false });
}

/** The page reload Retry uses for `recovery: 'reload'`; replaceable in tests (jsdom has none). */
export const pageReload = {
    run: (): void => {
        window.location.reload();
    },
};

/**
 * Retry from a failure splash: back to `connecting` with a new builder generation, or a page
 * reload when the failure needs one.
 */
export function retryConnection(): void {
    const { status } = snapshot;
    if (status.state === 'failed' && status.recovery === 'reload') {
        pageReload.run();
        return;
    }
    publish({ status: { state: 'connecting' }, generation: snapshot.generation + 1 });
}

/** The message of `error` and of every `cause` behind it, outermost first. */
function messages(error: unknown): string[] {
    const out: string[] = [];
    let current: unknown = error;
    for (let depth = 0; current !== undefined && current !== null && depth < 5; depth++) {
        if (typeof current === 'string') {
            out.push(current);
            break;
        }
        if (current instanceof Error) {
            out.push(current.message);
            current = current.cause;
        } else break;
    }
    return out;
}

/** A readable reason for the status (the error's message, or a fallback). */
export function describeError(error: unknown, fallback: string): string {
    return messages(error)[0] || fallback;
}

/**
 * `maintenance` when the error (or its cause) carries the module's maintenance refusal, else
 * `offline`. Note: maincloud drops a refused socket without a close frame, so in a browser the
 * text does not reach the client today (docs/frontend/pages.md "Open questions"); the
 * classification is ready for when it does.
 */
export function classifyFailure(error: unknown): FailureKind {
    return messages(error).some((m) => m.includes(MAINTENANCE_REFUSAL)) ? 'maintenance' : 'offline';
}

/** The current status; re-renders on change. */
export function useConnectionStatus(): ConnectionStatus {
    return useSyncExternalStore(connectionStatusStore.subscribe, () => snapshot.status);
}

/** The builder generation (Retry count); re-renders on change. */
export function useConnectionGeneration(): number {
    return useSyncExternalStore(connectionStatusStore.subscribe, () => snapshot.generation);
}

/** Test helper: back to the initial state. */
export function resetConnectionStatus(): void {
    publish({ status: { state: 'connecting' }, generation: 0 });
}
