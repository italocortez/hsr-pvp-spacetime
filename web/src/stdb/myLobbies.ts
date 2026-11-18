import type { MyLobbyListRow } from '@bindings/types';
import { useSyncExternalStore } from 'react';

/*
 * The viewer's lobbies (`view_my_lobbies`, Layer 0): the rows and whether the view has had its first result on the
 * current connection. Layer 0 (`layer0.ts`) writes it; pages read it. Kept apart from `layer0.ts` since S14.4c so a
 * page chunk can read it without the SDK (`layer0.ts` builds its SQL with the SDK's `toSql`): the landing page's
 * "Play Now" (the one-lobby rule) and the lobby placeholder at `/lobby/$lobbyId`.
 */

export type MyLobbiesState = {
    rows: readonly MyLobbyListRow[];
    /** The view's first result has arrived on the current connection. */
    ready: boolean;
};

const EMPTY: MyLobbiesState = { rows: [], ready: false };
let state: MyLobbiesState = EMPTY;
const listeners = new Set<() => void>();

/** Layer 0's writer: the rows after a change (`ready` once the view has applied), or nothing (stopped). */
export function setMyLobbies(rows: readonly MyLobbyListRow[], ready: boolean): void {
    if (state.ready === ready && rows.length === 0 && state.rows.length === 0) return;
    state = { rows, ready };
    for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/** The current state, outside React (a handler that has just awaited a call). */
export function getMyLobbies(): MyLobbiesState {
    return state;
}

/** Calls `listener` on every change; returns the unsubscribe. */
export function subscribeMyLobbies(listener: () => void): () => void {
    return subscribe(listener);
}

/** The viewer's lobbies (`view_my_lobbies`), empty until the first result. */
export function useMyLobbies(): readonly MyLobbyListRow[] {
    return useSyncExternalStore(subscribe, () => state.rows);
}

/** The rows and whether they have arrived. */
export function useMyLobbiesState(): MyLobbiesState {
    return useSyncExternalStore(subscribe, () => state);
}
