import { useCallback, useRef } from 'react';
import { useStdbConnection } from './connectionContext';
import { connectionStatusStore } from './connectionStatus';
import type { ReducersLike } from './types';

/** A reducer call made while there is no open connection. Nothing is queued. */
export class NotConnectedError extends Error {
    constructor() {
        super('Not connected to the server.');
        this.name = 'NotConnectedError';
    }
}

/**
 * A reducer call on the current connection (A173), in place of the SDK's `useReducer`, which
 * queues calls until a connection exists. This one rejects at once with `NotConnectedError` when
 * there is no connection, or it is not open (connecting, reconnecting, failed); otherwise it
 * returns the reducer's promise, which rejects with the module's refusal text.
 *
 *     const confirm = useReducerCall((r, args: { confirmToken: string }) => r.confirmLink(args));
 *
 * The returned function changes only when the connection object does.
 */
export function useReducerCall<A extends unknown[]>(
    call: (reducers: ReducersLike, ...args: A) => Promise<void>,
): (...args: A) => Promise<void> {
    const conn = useStdbConnection();
    const latest = useRef(call);
    latest.current = call;
    return useCallback(
        (...args: A) => {
            const reducers = conn?.reducers;
            if (!reducers || connectionStatusStore.getSnapshot().status.state !== 'connected') {
                return Promise.reject(new NotConnectedError());
            }
            try {
                return latest.current(reducers, ...args);
            } catch (error) {
                return Promise.reject(error);
            }
        },
        [conn],
    );
}
