import type { ComponentType } from 'react';
import type { CreateLobbyFlowProps } from './CreateLobbyFlow';

/*
 * The create-lobby dialog's chunk (S14.4c): the flow behind the landing page's "Play Now", the dialog and the shared
 * lobby settings form load on first use (a hover or focus on "Play Now" starts it, the click waits for it), so the
 * landing page's own chunk stays small. This file holds no dialog code and no SDK code (the entry chunk rule,
 * `stdb/entryChunk.test.ts`).
 */

export type CreateLobbyFlowType = ComponentType<CreateLobbyFlowProps>;

/** "Play Now"'s line when the chunk does not load (here, so the landing chunk does not carry the dialog's wording). */
export const CREATE_LOBBY_LOAD_FAILED =
    'The lobby form could not be loaded. Check your connection and try again.';

let loaded: CreateLobbyFlowType | undefined;
let loading: Promise<CreateLobbyFlowType> | undefined;

/** Loads the chunk once; a failed load can be retried by the next call. */
export function loadCreateLobbyFlow(): Promise<CreateLobbyFlowType> {
    if (loaded) return Promise.resolve(loaded);
    loading ??= import('./CreateLobbyFlow').then(
        (m) => {
            loaded = m.CreateLobbyFlow;
            return loaded;
        },
        (error: unknown) => {
            loading = undefined;
            throw error;
        },
    );
    return loading;
}

/** The flow once its chunk has loaded, else undefined. */
export function loadedCreateLobbyFlow(): CreateLobbyFlowType | undefined {
    return loaded;
}

/** Starts loading the chunk (a hover or focus on "Play Now"); a failure waits for the click. */
export function preloadCreateLobbyFlow(): void {
    void loadCreateLobbyFlow().catch(() => {});
}
