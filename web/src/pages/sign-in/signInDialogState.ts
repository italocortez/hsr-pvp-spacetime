import { type ComponentType, useSyncExternalStore } from 'react';
import type { SignInDialogProps } from './SignInDialog';

/*
 * The sign-in dialog (S14.4b, A221 R1): whether it is open, the control that opened it (focus goes back there),
 * and its chunk. The dialog calls reducers and uses the generated bindings, so it is a chunk of its own (the entry
 * chunk rule, `stdb/entryChunk.test.ts`): preloaded when the browser is idle after the bar first shows "Sign in",
 * or earlier on a hover or focus of it, and loaded on the first open at the latest. This file holds no SDK code and
 * no dialog markup: it is in the entry chunk with the bar; the dialog itself (and the shared Dialog) is not.
 */

type State = { open: boolean; trigger: HTMLElement | null };

let state: State = { open: false, trigger: null };
const listeners = new Set<() => void>();

function publish(next: State): void {
    state = next;
    for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
};

/** Opens the dialog; `trigger` takes focus back when it closes. */
export function openSignInDialog(trigger: HTMLElement | null = null): void {
    publish({ open: true, trigger });
    void loadSignInDialog().catch(() => {});
}

export function closeSignInDialog(): void {
    if (state.open) publish({ open: false, trigger: state.trigger });
}

/** The dialog's state; re-renders on change. */
export function useSignInDialogState(): State {
    return useSyncExternalStore(subscribe, () => state);
}

// --- the chunk -----------------------------------------------------------------------------------

export type SignInDialogType = ComponentType<SignInDialogProps>;

let loaded: SignInDialogType | undefined;
let loading: Promise<SignInDialogType> | undefined;

/** Loads the dialog's chunk once; a failed load can be retried by the next call. */
export function loadSignInDialog(): Promise<SignInDialogType> {
    if (loaded) return Promise.resolve(loaded);
    loading ??= import('./SignInDialog').then(
        (m) => {
            loaded = m.SignInDialog;
            return loaded;
        },
        (error: unknown) => {
            loading = undefined;
            throw error;
        },
    );
    return loading;
}

/** The dialog once its chunk has loaded, else undefined. */
export function loadedSignInDialog(): SignInDialogType | undefined {
    return loaded;
}

/** Starts loading the chunk (a hover or focus on "Sign in"); a failure waits for the click. */
export function preloadSignInDialog(): void {
    void loadSignInDialog().catch(() => {});
}

/** The longest wait for an idle moment before the preload starts anyway. */
export const IDLE_PRELOAD_TIMEOUT_MS = 4000;
/** Where `requestIdleCallback` is missing: a short delay after the bar's first paint instead. */
export const IDLE_PRELOAD_FALLBACK_MS = 1500;

type IdleWindow = {
    requestIdleCallback?: (run: () => void, options?: { timeout: number }) => number;
    cancelIdleCallback?: (handle: number) => void;
};

/**
 * Preloads the chunk when the browser is idle (the bar shows "Sign in": the first click then finds it in). Returns
 * the cancel, for an effect's cleanup. The load itself happens once (a chunk already in costs nothing). A static file,
 * no database traffic.
 */
export function preloadSignInDialogWhenIdle(): () => void {
    const w = globalThis as IdleWindow;
    if (typeof w.requestIdleCallback === 'function') {
        const handle = w.requestIdleCallback(preloadSignInDialog, {
            timeout: IDLE_PRELOAD_TIMEOUT_MS,
        });
        return () => w.cancelIdleCallback?.(handle);
    }
    const timer = setTimeout(preloadSignInDialog, IDLE_PRELOAD_FALLBACK_MS);
    return () => clearTimeout(timer);
}
