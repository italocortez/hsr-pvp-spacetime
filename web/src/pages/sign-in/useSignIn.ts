import { tables } from '@bindings/index';
import type { LoginStatus } from '@shared/auth-flow';
import { useRouter } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toSql } from 'spacetimedb';
import { useAuth } from '@/auth/authStore';
import { safeNextPath } from '@/auth/loginSearch';
import {
    type CookieJar,
    discardConfirmToken,
    documentCookies,
    forgetFlow,
    isSenderError,
    liveCode,
    makeNonce,
    type PendingAccount,
    pendingConfirm,
    pendingRow,
    postStart,
    readFlow,
    refusalText,
    rememberFlow,
    type StorageLike,
    samePending,
    takeConfirmToken,
    takeRefusalText,
} from '@/auth/signIn';
import { useStdbConnection } from '@/stdb/connectionContext';
import { NotConnectedError, useReducerCall } from '@/stdb/useReducerCall';
import { useRouteSubscriptions } from '@/stdb/useRouteSubscriptions';
import { useRows } from '@/stdb/useRows';

/** Subscribed only between the start of a flow and its end (egress, CLAUDE.md §2). */
export const LINK_REQUEST_QUERY = toSql(tables.viewMyLinkRequest);

/** How long the start may take, from the click to the request to the function. */
export const CODE_WAIT_MS = 10_000;

/** How long the return may stay on "checking" before it gives up. */
export const CHECK_WAIT_MS = 10_000;

/**
 * Why a flow failed, when the fixed line is not enough: `tooLong` (no usable row on return, or it
 * expired before the click), `changed` (the pending account changed or disappeared while the
 * panel was open: another tab started a flow), `unknown` (the connection dropped during a call).
 */
export type FailReason = 'tooLong' | 'changed' | 'unknown';

export type SignInPhase =
    | { kind: 'idle' }
    | { kind: 'starting' }
    | { kind: 'notConfigured' }
    | { kind: 'checking' }
    /** `handle` is always the live row's: the panel shows this phase only while the row is the one first shown. */
    | { kind: 'confirm'; handle: string }
    | { kind: 'confirming'; handle: string }
    | { kind: 'linked' }
    | { kind: 'refused'; text?: string }
    | { kind: 'failed'; reason?: FailReason }
    | { kind: 'cancelled' };

/** The internal state: `confirm` keeps the pending account first shown (handle and expiry). */
type State = Exclude<SignInPhase, { kind: 'confirm' }> | { kind: 'confirm'; shown: PendingAccount };

/** What the hook reaches outside React; tests replace it. */
export interface SignInIo {
    cookies: CookieJar;
    /** undefined: the tab's sessionStorage. */
    storage?: StorageLike;
    fetch: typeof fetch;
    assign: (url: string) => void;
    now: () => number;
}

export const defaultSignInIo: SignInIo = {
    cookies: documentCookies,
    fetch: (input, init) => fetch(input, init),
    assign: (url) => window.location.assign(url),
    now: () => Date.now(),
};

/**
 * The sign-in panel's state machine (`/?login=1`). `status` is the return word of the function
 * (read once, then dropped from the URL); `next` comes from the URL at start and from the tab's
 * flow marker on return, re-validated with `safeNextPath` before any navigation.
 */
export function useSignIn(
    { status, next }: { status?: LoginStatus; next?: string },
    io: SignInIo = defaultSignInIo,
) {
    const auth = useAuth();
    const router = useRouter();
    const conn = useStdbConnection();
    const [state, setState] = useState<State>(() =>
        status ? { kind: 'checking' } : { kind: 'idle' },
    );
    const [watching, setWatching] = useState(false);
    const sub = useRouteSubscriptions(watching ? [LINK_REQUEST_QUERY] : []);
    const rows = useRows((c) => c.db.viewMyLinkRequest, sub.ready);
    // On return the URL has no `next`: it comes from this tab's flow marker (read, not consumed).
    const nextRef = useRef(safeNextPath(next) ?? (status ? readFlow(io.storage)?.next : undefined));
    const handledStatus = useRef(false);
    const posted = useRef(false);
    const redirected = useRef(false);
    // Each start, failure and cancel opens a new attempt; late answers of an older one are dropped.
    const attempt = useRef(0);
    const pendingStart = useRef(0);
    const alive = useRef(true);
    const authRef = useRef(auth);
    authRef.current = auth;

    useEffect(() => {
        alive.current = true;
        return () => {
            alive.current = false;
        };
    }, []);

    const loginAsGuest = useReducerCall((r) => r.loginAsGuest({}));
    const requestLinkCode = useReducerCall((r, a: { clientNonce: string }) => r.requestLinkCode(a));
    const confirmLink = useReducerCall((r, a: { confirmToken: string }) => r.confirmLink(a));

    const fail = useCallback((reason?: FailReason) => {
        attempt.current += 1;
        setWatching(false);
        setState(reason ? { kind: 'failed', reason } : { kind: 'failed' });
    }, []);

    /** A rejected reducer call: the module's text for a refusal; otherwise the result is unknown. */
    const failFromError = useCallback(
        (error: unknown) => {
            if (error instanceof NotConnectedError) fail();
            else if (isSenderError(error)) {
                attempt.current += 1;
                setWatching(false);
                setState({ kind: 'refused', text: refusalText(error) || undefined });
            } else fail('unknown');
        },
        [fail],
    );

    // The pending account as the view shows it now (the panel renders this, never a stored copy).
    const live = pendingRow(rows);
    const changed = state.kind === 'confirm' && !samePending(live, state.shown);

    // A signed-in (non-guest) user does not sign in again: to `next`, else `/`.
    useEffect(() => {
        if (redirected.current || !auth.ready || !auth.user || auth.user.isGuest) return;
        if (state.kind === 'confirming') return;
        redirected.current = true;
        setWatching(false);
        void router.navigate({ href: safeNextPath(nextRef.current) ?? '/', replace: true });
    }, [auth, state.kind, router]);

    // The return from the function: read `status` once, drop it from the URL.
    useEffect(() => {
        if (handledStatus.current || !status || !auth.ready) return;
        handledStatus.current = true;
        const flow = readFlow(io.storage);
        if (flow?.next) nextRef.current = flow.next;
        if (auth.user && !auth.user.isGuest) {
            // Already signed in: the redirect effect moves on to `next`; nothing to confirm.
            discardConfirmToken(io.cookies);
            forgetFlow(io.storage);
            return;
        }
        void router.navigate({
            to: '/',
            search: { login: 1, next: nextRef.current, status: undefined },
            replace: true,
        });
        if (status !== 'confirm') {
            forgetFlow(io.storage);
            if (status === 'refused')
                setState({ kind: 'refused', text: takeRefusalText(io.cookies) });
            else if (status === 'cancelled') setState({ kind: 'cancelled' });
            else setState({ kind: 'failed' });
            return;
        }
        // Another tab (no marker) cannot confirm; its cookie is left to expire.
        if (!flow) {
            setState({ kind: 'failed' });
            return;
        }
        if (!auth.user) {
            discardConfirmToken(io.cookies);
            forgetFlow(io.storage);
            setState({ kind: 'failed' });
            return;
        }
        setWatching(true);
    }, [status, auth, io, router]);

    // Return: once the view has answered, show the pending account or "took too long".
    useEffect(() => {
        if (state.kind !== 'checking' || !watching) return;
        if (sub.error) {
            discardConfirmToken(io.cookies);
            forgetFlow(io.storage);
            fail();
            return;
        }
        if (!sub.ready) return;
        const pending = pendingConfirm(rows, io.now());
        if (pending) {
            setState({ kind: 'confirm', shown: pending });
            return;
        }
        discardConfirmToken(io.cookies);
        forgetFlow(io.storage);
        fail('tooLong');
    }, [state.kind, watching, sub.ready, sub.error, rows, io, fail]);

    // Return: "checking" gives up after CHECK_WAIT_MS (no profile, no view answer).
    useEffect(() => {
        if (state.kind !== 'checking') return;
        const timer = setTimeout(() => {
            if (readFlow(io.storage)) {
                discardConfirmToken(io.cookies);
                forgetFlow(io.storage);
            }
            fail();
        }, CHECK_WAIT_MS);
        return () => clearTimeout(timer);
    }, [state.kind, io, fail]);

    // Confirm panel open: the row changed (another handle, another flow) or disappeared. The
    // cookie is left alone: it may hold the token of the flow that replaced this one.
    useEffect(() => {
        if (!changed) return;
        forgetFlow(io.storage);
        fail('changed');
    }, [changed, io, fail]);

    // Start, step 2: once the profile view has answered, become a guest if needed and ask for a code.
    const runStart = useCallback(
        async (mine: number) => {
            const current = () => alive.current && attempt.current === mine;
            const user = authRef.current.user;
            // A member never reaches here (the redirect effect moves on); never make them a guest.
            if (user && !user.isGuest) return;
            try {
                // This is the moment a visitor becomes a guest.
                if (!user) await loginAsGuest();
                if (!current()) return;
                await requestLinkCode({ clientNonce: makeNonce() });
            } catch (error) {
                if (current()) failFromError(error);
                return;
            }
            // Only now: the view is subscribed after the code exists.
            if (current()) setWatching(true);
        },
        [loginAsGuest, requestLinkCode, failFromError],
    );

    useEffect(() => {
        if (state.kind !== 'starting' || !auth.ready || pendingStart.current === 0) return;
        const mine = pendingStart.current;
        pendingStart.current = 0;
        void runStart(mine);
    }, [state.kind, auth.ready, runStart]);

    // Start, step 3: once the code is in the view, hand it to the function and leave for Discord.
    useEffect(() => {
        if (state.kind !== 'starting' || !watching) return;
        if (sub.error) {
            fail();
            return;
        }
        if (!sub.ready || posted.current) return;
        const code = liveCode(rows, io.now());
        if (!code) return;
        posted.current = true;
        const mine = attempt.current;
        void postStart(code, io.fetch).then((answer) => {
            // Unmounted, failed or cancelled meanwhile: no marker, no navigation.
            if (!alive.current || attempt.current !== mine) return;
            if (answer.kind === 'redirect') {
                // The view stays subscribed until the page leaves for Discord.
                if (!rememberFlow(nextRef.current, io.storage)) {
                    fail();
                    return;
                }
                io.assign(answer.url);
                return;
            }
            setWatching(false);
            setState(
                answer.kind === 'notConfigured' ? { kind: 'notConfigured' } : { kind: 'failed' },
            );
        });
    }, [state.kind, watching, sub.ready, sub.error, rows, io, fail]);

    // Start: the whole start (profile, reducers, code) must reach the function within CODE_WAIT_MS.
    useEffect(() => {
        if (state.kind !== 'starting') return;
        const timer = setTimeout(() => {
            if (!posted.current) fail();
        }, CODE_WAIT_MS);
        return () => clearTimeout(timer);
    }, [state.kind, fail]);

    /** Start, step 1: the click. The work waits for the profile view (`auth.ready`). */
    const start = useCallback(() => {
        attempt.current += 1;
        pendingStart.current = attempt.current;
        posted.current = false;
        setState({ kind: 'starting' });
    }, []);

    /**
     * The click on "Link this account". `shownHandle` is the handle on screen at the click. Calls
     * `confirm_link` only when the live row is still the one first shown with that handle, is
     * unexpired by the browser's clock, and the profile is still a guest.
     */
    const confirm = useCallback(
        async (shownHandle: string) => {
            if (state.kind !== 'confirm') return;
            const now = [...(conn?.db.viewMyLinkRequest?.iter() ?? [])];
            const row = pendingRow(now);
            if (!row || !samePending(row, state.shown) || row.handle !== shownHandle) {
                forgetFlow(io.storage);
                fail('changed');
                return;
            }
            if (row.expiresAt <= io.now()) {
                discardConfirmToken(io.cookies);
                forgetFlow(io.storage);
                fail('tooLong');
                return;
            }
            if (!authRef.current.user?.isGuest) {
                discardConfirmToken(io.cookies);
                forgetFlow(io.storage);
                fail();
                return;
            }
            // Read and delete at once: the token is used for one attempt only.
            const token = takeConfirmToken(io.cookies);
            forgetFlow(io.storage);
            if (!token) {
                fail();
                return;
            }
            attempt.current += 1;
            const mine = attempt.current;
            setState({ kind: 'confirming', handle: row.handle });
            try {
                await confirmLink({ confirmToken: token });
            } catch (error) {
                if (alive.current && attempt.current === mine) failFromError(error);
                return;
            }
            if (!alive.current || attempt.current !== mine) return;
            // Linked: the profile view turns into the signed-in user by itself (same identity, no
            // reconnect); the redirect effect then moves on to `next`.
            setWatching(false);
            setState({ kind: 'linked' });
        },
        [state, conn, io, confirmLink, fail, failFromError],
    );

    const cancel = useCallback(() => {
        attempt.current += 1;
        discardConfirmToken(io.cookies);
        forgetFlow(io.storage);
        setWatching(false);
        setState({ kind: 'idle' });
    }, [io]);

    // What the panel shows: the confirm state carries the live handle; a changed row is already
    // the failed state in this render (the effect above makes it stick).
    let phase: SignInPhase;
    if (state.kind !== 'confirm') phase = state;
    else if (changed || !live) phase = { kind: 'failed', reason: 'changed' };
    else phase = { kind: 'confirm', handle: live.handle };

    return { phase, start, confirm, cancel, watching };
}
