import type { MyLinkRequestRow } from '@bindings/types';
import {
    AUTH_START_PATH,
    CONFIRM_COOKIE,
    isBase64Url32,
    isLinkCode,
    READABLE_COOKIE_SAMESITE,
    REFUSAL_COOKIE,
} from '@shared/auth-flow';
import { SenderError } from 'spacetimedb';
import { safeNextPath } from './loginSearch';

/*
 * M5b sign-in logic, no React (docs/auth/architecture.md "Phase M5b execution"):
 *   start   guest (login_as_guest if needed), a 32-byte nonce, request_link_code, the code from
 *           view_my_link_request, POST /api/auth/discord/start, then the browser goes to Discord;
 *   return  /?login=1&status=confirm: only for a flow this tab started, a guest profile and a
 *           pending row unexpired by the browser's clock; one explicit click confirms with the
 *           token from the cookie, which is deleted before the call (one attempt).
 * The page never takes a code or a token from the URL or an input.
 */

// --- the tab's flow marker -------------------------------------------------------------------

/** sessionStorage key: this tab started a sign-in (a random marker, and where to go after). */
export const FLOW_KEY = 'hsr-pvp:sign-in-flow';

export type FlowMarker = { id: string; next?: string };

/** The storage the marker lives in; replaceable in tests. Every access is wrapped in try/catch. */
export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function sessionStore(): StorageLike | undefined {
    try {
        return globalThis.sessionStorage;
    } catch {
        return undefined;
    }
}

/** Remembers that this tab started a flow. False when storage is blocked (the flow then fails on return). */
export function rememberFlow(next: string | undefined, storage = sessionStore()): boolean {
    const marker: FlowMarker = { id: base64Url(randomBytes(16)) };
    const safe = safeNextPath(next);
    if (safe) marker.next = safe;
    try {
        storage?.setItem(FLOW_KEY, JSON.stringify(marker));
        return storage !== undefined;
    } catch {
        return false;
    }
}

/** This tab's marker, or undefined (none, unreadable, or not ours). `next` is re-validated. */
export function readFlow(storage = sessionStore()): FlowMarker | undefined {
    let raw: string | null | undefined;
    try {
        raw = storage?.getItem(FLOW_KEY);
    } catch {
        return undefined;
    }
    if (!raw) return undefined;
    try {
        const parsed = JSON.parse(raw) as { id?: unknown; next?: unknown } | null;
        if (typeof parsed?.id !== 'string' || parsed.id === '') return undefined;
        const next = safeNextPath(parsed.next);
        return next ? { id: parsed.id, next } : { id: parsed.id };
    } catch {
        return undefined;
    }
}

export function forgetFlow(storage = sessionStore()): void {
    try {
        storage?.removeItem(FLOW_KEY);
    } catch {
        // Storage blocked: nothing was stored either.
    }
}

// --- randomness ------------------------------------------------------------------------------

function randomBytes(n: number): Uint8Array {
    const bytes = new Uint8Array(n);
    crypto.getRandomValues(bytes);
    return bytes;
}

/** base64url without padding. */
export function base64Url(bytes: Uint8Array): string {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The `clientNonce` of `request_link_code`: 32 bytes from `crypto.getRandomValues`, 43 characters. */
export function makeNonce(): string {
    return base64Url(randomBytes(32));
}

// --- cookies ---------------------------------------------------------------------------------

/** The two readable cookies the function sets; replaceable in tests (jsdom keeps no Secure cookie on http). */
export interface CookieJar {
    read(name: string): string | undefined;
    remove(name: string): void;
}

export const documentCookies: CookieJar = {
    read(name) {
        for (const part of document.cookie.split(';')) {
            const eq = part.indexOf('=');
            if (eq >= 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
        }
        return undefined;
    },
    remove(name) {
        // A `__Host-` cookie is replaced only with the same prefix rules: Secure, Path=/, no Domain.
        document.cookie = `${name}=; Max-Age=0; Path=/; Secure; SameSite=${READABLE_COOKIE_SAMESITE}`;
    },
};

/** Takes the confirm token: reads it and deletes the cookie at once (one attempt only). */
export function takeConfirmToken(jar: CookieJar = documentCookies): string | undefined {
    const value = jar.read(CONFIRM_COOKIE);
    if (value !== undefined) jar.remove(CONFIRM_COOKIE);
    return isBase64Url32(value) ? value : undefined;
}

/** Drops a confirm token that will not be used. */
export function discardConfirmToken(jar: CookieJar = documentCookies): void {
    if (jar.read(CONFIRM_COOKIE) !== undefined) jar.remove(CONFIRM_COOKIE);
}

/** Takes the module's refusal text (plain text, never HTML) and deletes the cookie. */
export function takeRefusalText(jar: CookieJar = documentCookies): string | undefined {
    const value = jar.read(REFUSAL_COOKIE);
    if (value === undefined) return undefined;
    jar.remove(REFUSAL_COOKIE);
    try {
        const text = decodeURIComponent(value).trim();
        return text === '' ? undefined : text.slice(0, 200);
    } catch {
        return undefined;
    }
}

// --- view_my_link_request rows ---------------------------------------------------------------

export function expiresAtMs(row: MyLinkRequestRow): number {
    return Number(row.expiresAt.microsSinceUnixEpoch / 1000n);
}

/** The newest row by `expiresAt` (a replaced keyless row may briefly show two). */
function newest(rows: readonly MyLinkRequestRow[]): MyLinkRequestRow | undefined {
    let best: MyLinkRequestRow | undefined;
    for (const row of rows) if (!best || expiresAtMs(row) > expiresAtMs(best)) best = row;
    return best;
}

/** The live code to present, if the newest row carries one and has not expired. */
export function liveCode(rows: readonly MyLinkRequestRow[], nowMs: number): string | undefined {
    const row = newest(rows);
    if (!row || row.awaitingConfirm || expiresAtMs(row) <= nowMs) return undefined;
    return isLinkCode(row.code) ? row.code : undefined;
}

/** A pending account as the page shows it: the handle, and the row's expiry as its identity. */
export type PendingAccount = { handle: string; expiresAt: number };

/**
 * The newest row waiting for `confirm_link`, expired or not (undefined when there is none or it
 * has no handle). `expiresAt` is fixed at the presentation, so a different value is another flow.
 */
export function pendingRow(rows: readonly MyLinkRequestRow[]): PendingAccount | undefined {
    const row = newest(rows.filter((r) => r.awaitingConfirm));
    const handle = row?.pendingProviderName ?? '';
    return row && handle !== '' ? { handle, expiresAt: expiresAtMs(row) } : undefined;
}

/** The row waiting for `confirm_link`, if any, unexpired by `nowMs` (the browser's clock). */
export function pendingConfirm(
    rows: readonly MyLinkRequestRow[],
    nowMs: number,
): PendingAccount | undefined {
    const pending = pendingRow(rows);
    return pending && pending.expiresAt > nowMs ? pending : undefined;
}

/** The same pending account (handle and expiry): anything else means the flow changed. */
export function samePending(a: PendingAccount | undefined, b: PendingAccount | undefined): boolean {
    return (
        a !== undefined && b !== undefined && a.handle === b.handle && a.expiresAt === b.expiresAt
    );
}

// --- the start request -----------------------------------------------------------------------

export type StartAnswer =
    | { kind: 'redirect'; url: string }
    | { kind: 'notConfigured' }
    | { kind: 'failed' };

/** POSTs the code to the function (same origin, JSON) and reads its answer. */
export async function postStart(
    linkCode: string,
    fetchImpl: typeof fetch = (input, init) => fetch(input, init),
): Promise<StartAnswer> {
    // A hung function must not leave the panel disabled: after START_TIMEOUT_MS the request is
    // aborted and the answer is "failed", whether or not the fetch honours the abort.
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<StartAnswer>((done) => {
        timer = setTimeout(() => {
            controller.abort();
            done({ kind: 'failed' });
        }, START_TIMEOUT_MS);
    });
    try {
        return await Promise.race([requestStart(linkCode, fetchImpl, controller.signal), timedOut]);
    } finally {
        clearTimeout(timer);
    }
}

/** How long the start request (answer and body) may take. */
export const START_TIMEOUT_MS = 10_000;

async function requestStart(
    linkCode: string,
    fetchImpl: typeof fetch,
    signal: AbortSignal,
): Promise<StartAnswer> {
    let res: Response;
    try {
        res = await fetchImpl(AUTH_START_PATH, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ linkCode }),
            credentials: 'same-origin',
            cache: 'no-store',
            signal,
        });
    } catch {
        return { kind: 'failed' };
    }
    let body: { url?: unknown; error?: unknown } | null = null;
    try {
        body = (await res.json()) as { url?: unknown; error?: unknown } | null;
    } catch {
        body = null;
    }
    if (res.ok && typeof body?.url === 'string' && isFollowable(body.url)) {
        return { kind: 'redirect', url: body.url };
    }
    if (res.status === 500 && body?.error === 'not_configured') return { kind: 'notConfigured' };
    return { kind: 'failed' };
}

/**
 * The only addresses the page leaves for: Discord's own origin, `https://discord.com`. A dev
 * build also follows a loopback `http://127.0.0.1:<port>` or `http://localhost:<port>` (the
 * local Discord stand-in of the M5b check); that rule sits inside `import.meta.env.DEV`, so the
 * production bundle does not contain it (check:patterns gate 3).
 */
export function isFollowable(url: string): boolean {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return false;
    }
    if (parsed.username !== '' || parsed.password !== '') return false;
    // The protocol itself, not only the origin: `blob:https://discord.com/…` has Discord's origin.
    if (parsed.protocol === 'https:' && parsed.origin === 'https://discord.com') return true;
    if (import.meta.env.DEV) {
        return (
            parsed.protocol === 'http:' &&
            /^http:\/\/(?:localhost|127\.0\.0\.1):[0-9]{1,5}$/.test(parsed.origin)
        );
    }
    return false;
}

/**
 * A refusal from the module (the SDK rejects a reducer call with `SenderError` and the module's
 * text). Anything else (a dropped connection, an unknown result, an internal error) is not.
 */
export function isSenderError(error: unknown): error is Error {
    return error instanceof SenderError || (error instanceof Error && error.name === 'SenderError');
}

/** The text of a reducer refusal (the SDK rejects with the module's message). */
export function refusalText(error: unknown): string {
    const text = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
    return text.trim().slice(0, 200);
}
