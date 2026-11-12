import type { Role } from '@bindings/types';
import { useSyncExternalStore } from 'react';

/** What the router guards need to know about the viewer. M6 feeds it from the connection. */
export type AuthSnapshot = {
    /** False until the connection has said who the viewer is; guards wait instead of redirecting. */
    ready: boolean;
    /** Absent for a visitor (not signed in). */
    user?: { id: bigint; role: Role; isGuest: boolean };
};

// Until M6 there is no connection: everyone is a ready visitor.
let snapshot: AuthSnapshot = { ready: true };
const listeners = new Set<() => void>();

/** A tiny external store for `useSyncExternalStore`. Snapshots are replaced, never mutated. */
export const authStore = {
    getSnapshot(): AuthSnapshot {
        return snapshot;
    },
    subscribe(listener: () => void): () => void {
        listeners.add(listener);
        return () => {
            listeners.delete(listener);
        };
    },
};

/** Replaces the snapshot and notifies subscribers (the router provider re-runs the guards). */
export function setAuthSnapshot(next: AuthSnapshot): void {
    if (next === snapshot) return;
    snapshot = next;
    for (const listener of listeners) listener();
}

/** The current auth snapshot; re-renders on change. */
export function useAuth(): AuthSnapshot {
    return useSyncExternalStore(authStore.subscribe, authStore.getSnapshot);
}
