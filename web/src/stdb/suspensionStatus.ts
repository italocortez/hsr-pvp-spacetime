import { useSyncExternalStore } from 'react';

/*
 * SUS2: whether the viewer's account is suspended, an external store like `auth/authStore.ts`.
 * Written by Layer 0 (`layer0.ts`) from `view_my_suspension` (one row while suspended, none
 * otherwise), read by the root layout (`SuspensionGate`). No SDK code here: the root layout is in
 * the entry chunk (`entryChunk.test.ts`).
 *
 * False until Layer 0 says otherwise; a connection that goes away leaves the last answer in place
 * (as the auth store does), and the next connection's first result replaces it.
 */

let suspended = false;
const listeners = new Set<() => void>();

export const suspensionStore = {
    getSnapshot(): boolean {
        return suspended;
    },
    subscribe(listener: () => void): () => void {
        listeners.add(listener);
        return () => {
            listeners.delete(listener);
        };
    },
};

/** Sets the flag and notifies subscribers (a no-op when unchanged). */
export function setSuspended(next: boolean): void {
    if (next === suspended) return;
    suspended = next;
    for (const listener of listeners) listener();
}

/** True while the viewer's account is suspended; re-renders on change. */
export function useSuspended(): boolean {
    return useSyncExternalStore(suspensionStore.subscribe, suspensionStore.getSnapshot);
}
