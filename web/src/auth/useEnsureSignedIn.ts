import { useCallback, useRef } from 'react';
import { NotConnectedError, useReducerCall } from '@/stdb/useReducerCall';
import { type AuthSnapshot, authStore } from './authStore';

/*
 * Guest on demand (S14.4b, A221 R2): an action that needs an account (the landing page's "Play Now", the sign-in
 * dialog's "Continue as Guest") awaits `ensureSignedIn()` first. A visitor becomes a guest silently (`login_as_guest`,
 * the same reducer the Discord start calls); a guest or a member passes through; a failure comes back to the caller,
 * which shows it. No SDK import (the entry chunk rule): the reducer is reached through the connection at run time.
 */

/** How long it waits for the profile view: first to say who the viewer is, then to show the new guest. */
export const ENSURE_WAIT_MS = 10_000;

export type EnsureSignedInResult =
    /** A guest or a member now. `created`: this call made the guest. */
    | { kind: 'ready'; created: boolean; isGuest: boolean }
    /** The module refused (`text`: its sentence, may be empty): guest creation off, maintenance, a ban. */
    | { kind: 'refused'; text: string }
    /**
     * `notConnected`: no open connection, nothing was sent; `timeout`: the call or the profile view did not answer in
     * time;
     * `unknown`: the call failed another way (the connection dropped: the result is unknown).
     */
    | { kind: 'failed'; reason: 'notConnected' | 'timeout' | 'unknown' };

type AuthSource = Pick<typeof authStore, 'getSnapshot' | 'subscribe'>;

/** The first auth snapshot that passes `test` (the current one included), or null after `ms`. */
export function waitForAuth(
    test: (auth: AuthSnapshot) => boolean,
    ms: number,
    store: AuthSource = authStore,
): Promise<AuthSnapshot | null> {
    const now = store.getSnapshot();
    if (test(now)) return Promise.resolve(now);
    return new Promise((resolve) => {
        const done = (value: AuthSnapshot | null) => {
            clearTimeout(timer);
            unsubscribe();
            resolve(value);
        };
        const unsubscribe = store.subscribe(() => {
            const next = store.getSnapshot();
            if (test(next)) done(next);
        });
        const timer = setTimeout(() => done(null), ms);
    });
}

/** A module refusal: the SDK rejects with an error named `SenderError` (checked by name: no SDK import here). */
function refusalOf(error: unknown): string | undefined {
    if (!(error instanceof Error) || error.name !== 'SenderError') return undefined;
    return error.message.trim().slice(0, 200);
}

const TIMED_OUT = Symbol('timed out');

/** `promise`'s value, or TIMED_OUT after `ms` (the promise's later answer is dropped). */
function withinTime<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), ms);
    });
    return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/**
 * Returns `ensureSignedIn()`: resolves once the viewer is a guest or a member, or with the reason they are not. It
 * never rejects, and every step has a time limit (`waitMs`; the call to `login_as_guest` too). Calls made through the
 * same returned function while one is running share it (one `login_as_guest` from this hook at most); two components
 * that each use the hook can each send one (the module answers the second for an existing user by doing nothing).
 */
export function useEnsureSignedIn(waitMs: number = ENSURE_WAIT_MS) {
    const loginAsGuest = useReducerCall((r) => r.loginAsGuest({}));
    const running = useRef<Promise<EnsureSignedInResult> | null>(null);

    const run = useCallback(async (): Promise<EnsureSignedInResult> => {
        const known = await waitForAuth((a) => a.ready, waitMs);
        if (!known) return { kind: 'failed', reason: 'timeout' };
        if (known.user) return { kind: 'ready', created: false, isGuest: known.user.isGuest };
        try {
            // A half-open connection can hold the call for good: it gets the same time limit as the waits.
            if ((await withinTime(loginAsGuest(), waitMs)) === TIMED_OUT)
                return { kind: 'failed', reason: 'timeout' };
        } catch (error) {
            if (error instanceof NotConnectedError)
                return { kind: 'failed', reason: 'notConnected' };
            const text = refusalOf(error);
            if (text !== undefined) return { kind: 'refused', text };
            return { kind: 'failed', reason: 'unknown' };
        }
        const signed = await waitForAuth((a) => a.ready && a.user !== undefined, waitMs);
        if (!signed?.user) return { kind: 'failed', reason: 'timeout' };
        return { kind: 'ready', created: true, isGuest: signed.user.isGuest };
    }, [loginAsGuest, waitMs]);

    return useCallback((): Promise<EnsureSignedInResult> => {
        if (!running.current) {
            running.current = run().finally(() => {
                running.current = null;
            });
        }
        return running.current;
    }, [run]);
}
