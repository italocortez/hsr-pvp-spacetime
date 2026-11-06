/**
 * WebSocket connection helper for scripts/stdb/*.ts.
 *
 * - Fails fast: a connect error, a timeout, or any disconnect the script did not ask for exits 1
 *   (upgrade report R6: since SDK 2.10 mid-session errors arrive at onDisconnect, not onConnectError,
 *   so a script without onDisconnect would hang).
 * - Tokens are passed in, never logged.
 */

import type { BackendEnv } from '../../shared/stdb-targets';
import { DbConnection } from '../../web/src/module_bindings';

export interface ScriptConnection {
    conn: DbConnection;
    identityHex: string;
    /** The token the server issued or accepted (a fresh one for token-less connections). Never log it. */
    token: string;
    /** Intended disconnect: does not trigger the fail-fast exit. */
    close: () => void;
}

export interface ConnectOptions {
    backend: BackendEnv;
    /** Omit for a token-less connection (mints a fresh identity + token). */
    token?: string;
    /** Log prefix, e.g. 'bootstrap:owner'. */
    label: string;
    timeoutMs?: number;
}

export function connect(opts: ConnectOptions): Promise<ScriptConnection> {
    const { backend, token, label, timeoutMs = 30_000 } = opts;
    let closing = false;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            console.error(
                `[${label}] connection timeout (${timeoutMs / 1000}s) to ${backend.dbName}`,
            );
            process.exit(1);
        }, timeoutMs);

        let builder = DbConnection.builder()
            .withUri(backend.host)
            .withDatabaseName(backend.dbName)
            .withConfirmedReads(false);
        if (token) builder = builder.withToken(token);

        builder
            .onConnect((conn, identity, issuedToken) => {
                clearTimeout(timer);
                resolve({
                    conn,
                    identityHex: identity.toHexString(),
                    token: issuedToken,
                    close: () => {
                        closing = true;
                        conn.disconnect();
                    },
                });
            })
            .onConnectError((_ctx, err) => {
                clearTimeout(timer);
                reject(new Error(`[${label}] connection to ${backend.dbName} failed: ${err}`));
            })
            .onDisconnect((_ctx, err) => {
                if (closing) return;
                console.error(
                    `[${label}] disconnected unexpectedly from ${backend.dbName}${err ? `: ${err}` : ''}`,
                );
                process.exit(1);
            })
            .build();
    });
}

/** Subscribe to exactly the given SQL queries and resolve once the initial rows are applied. */
export function subscribeOnly(
    conn: DbConnection,
    queries: string[],
    label: string,
    timeoutMs = 30_000,
): Promise<void> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new Error(`[${label}] subscription timeout (${timeoutMs / 1000}s)`)),
            timeoutMs,
        );
        conn.subscriptionBuilder()
            .onApplied(() => {
                clearTimeout(timer);
                resolve();
            })
            .onError((_ctx) => {
                clearTimeout(timer);
                reject(new Error(`[${label}] subscription failed: ${queries.join('; ')}`));
            })
            .subscribe(queries);
    });
}

/** Poll the client cache until `find` returns a value (subscription updates trail reducer commits). */
export function waitFor<T>(
    find: () => T | undefined,
    what: string,
    timeoutMs = 10_000,
): Promise<T> {
    return new Promise((resolve, reject) => {
        const start = Date.now();
        const check = () => {
            const v = find();
            if (v !== undefined) return resolve(v);
            if (Date.now() - start > timeoutMs)
                return reject(new Error(`timeout waiting for ${what}`));
            setTimeout(check, 200);
        };
        check();
    });
}
