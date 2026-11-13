import { DbConnection, type DbConnectionBuilder } from '@bindings/index';
import type { BrowserEnv } from '@shared/stdb-targets';
import { getCurrentConnection } from './connectionContext';
import {
    connectionStatusStore,
    describeError,
    failConnection,
    setConnectionStatus,
} from './connectionStatus';

const getStatus = () => connectionStatusStore.getSnapshot().status;

/*
 * The one `DbConnection` builder of the app. The React provider (`StdbProvider.tsx`) builds the
 * connection from it, forces automatic reconnection on it and replays every registered
 * subscription after a reconnect (spacetimedb 2.15.0 `sdk/connection_manager.ts`,
 * `sdk/db_connection_impl.ts` `#replaySubscriptions`); nothing here reconnects by itself.
 */

/** The stored SDK token, or undefined (none yet, empty, or storage blocked). */
export function readStoredToken(key: string): string | undefined {
    try {
        return globalThis.localStorage?.getItem(key) || undefined;
    } catch {
        return undefined;
    }
}

/** Saves the SDK token (never an empty one); a blocked storage only costs the identity next visit. */
export function storeToken(key: string, token: string | undefined): void {
    if (!token) return;
    try {
        globalThis.localStorage?.setItem(key, token);
    } catch {
        // Storage blocked (private window, site data off): the app keeps working this session.
    }
}

/** Forgets the stored SDK token (the next connection is a new anonymous identity). */
export function deleteStoredToken(key: string): void {
    try {
        globalThis.localStorage?.removeItem(key);
    } catch {
        // Storage blocked: nothing was stored either.
    }
}

/**
 * True when the server refused the stored token at the token exchange
 * (`POST /v1/identity/websocket-token` answered 401 or 403). The SDK's `WebSocketTokenError`
 * (`sdk/ws.ts`) is not exported, so it is recognised by its `name` and numeric `status`.
 */
export function isRefusedToken(error: unknown): boolean {
    if (!(error instanceof Error) || error.name !== 'WebSocketTokenError') return false;
    const status = (error as { status?: unknown }).status;
    return status === 401 || status === 403;
}

/** The builder callbacks the app uses; the generated builder and the test double both have them. */
export interface ConnectionEventsLike {
    onConnect(cb: (conn: unknown, identity: unknown, token: string) => void): unknown;
    onAutomaticReconnect(cb: (conn: unknown, identity: unknown, token: string) => void): unknown;
    onConnectError(
        cb: (ctx: unknown, error: Error, nextAttempt?: number, nextDelayMs?: number) => void,
    ): unknown;
    onDisconnect(
        cb: (ctx: unknown, error?: Error, nextAttempt?: number, nextDelayMs?: number) => void,
    ): unknown;
}

/**
 * True when the app itself closed this connection: the provider's manager calls `disconnect()`
 * 0 ms after the provider let go of it, by which time `ConnectionScope` has already cleared the
 * current connection. The SDK also calls `disconnect()` on itself (a `SubscriptionError` for an
 * applied subscription, `db_connection_impl.ts`); then the connection is still the current one
 * (this callback runs before the manager's own, which drops it), so that is a failure.
 */
function closedByApp(ctx: unknown): boolean {
    const requested =
        typeof ctx === 'object' &&
        ctx !== null &&
        (ctx as { isDisconnectRequested?: unknown }).isDisconnectRequested === true;
    return requested && getCurrentConnection() !== ctx;
}

/**
 * Maps the SDK's lifecycle callbacks onto the status store and saves the token. A defined
 * `nextAttempt` means the SDK is retrying inside the same connection (`reconnecting`); undefined
 * means it will not retry this connection (`failed`).
 */
export function wireConnectionEvents<B extends ConnectionEventsLike>(
    builder: B,
    tokenStorageKey: string,
): B {
    const connected = (_conn: unknown, _identity: unknown, token: string) => {
        storeToken(tokenStorageKey, token);
        setConnectionStatus({ state: 'connected' });
    };
    builder.onConnect(connected);
    builder.onAutomaticReconnect(connected);
    builder.onConnectError((ctx, error, nextAttempt) => {
        if (closedByApp(ctx)) return;
        if (nextAttempt !== undefined) {
            setConnectionStatus({
                state: 'reconnecting',
                reason: describeError(error, 'Reconnect failed'),
            });
        } else if (isRefusedToken(error)) {
            // The stored token is dead; the provider's manager keeps it for its rebuilds, so only
            // a reload (which reads the now empty key) gets a fresh anonymous identity.
            deleteStoredToken(tokenStorageKey);
            failConnection(error, 'reload');
        } else failConnection(error);
    });
    builder.onDisconnect((ctx, error, nextAttempt) => {
        if (closedByApp(ctx)) return;
        if (nextAttempt !== undefined) {
            setConnectionStatus({
                state: 'reconnecting',
                reason: describeError(error, 'Connection lost'),
            });
        } else if (error || getStatus().state !== 'failed') {
            // A close without an error after a failure (Layer 0 closing the connection itself)
            // keeps the first reason.
            failConnection(error ?? new Error('Connection closed'));
        }
    });
    return builder;
}

/**
 * A fresh builder for `env` (one per Retry). Confirmed reads are off: subscription updates arrive
 * as soon as a transaction commits, without waiting for durability (skill "Confirmed Reads",
 * MIGRATION-PLAN 4.4). Drafting is turn-timed, and a crash between commit and fsync is rare.
 */
export function createConnectionBuilder(env: BrowserEnv): DbConnectionBuilder {
    const builder = DbConnection.builder()
        .withUri(env.host)
        .withDatabaseName(env.dbName)
        .withToken(readStoredToken(env.tokenStorageKey))
        .withConfirmedReads(false);
    return wireConnectionEvents(builder, env.tokenStorageKey);
}
