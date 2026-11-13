import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authStore, setAuthSnapshot } from '@/auth/authStore';
import type { StdbConnectionLike } from '@/stdb/types';
import { MockBuilder } from '@/test/mockConnection';
import { isRefusedToken, readStoredToken, storeToken, wireConnectionEvents } from './connection';
import { setCurrentConnection } from './connectionContext';
import {
    classifyFailure,
    connectionStatusStore,
    MAINTENANCE_REFUSAL,
    pageReload,
    resetConnectionStatus,
    retryConnection,
} from './connectionStatus';

/*
 * The connection callbacks (M6 brief items 1 and 3): token storage, the status store and its
 * failure classification, driven by the mock builder.
 */

const KEY = 'wss://maincloud.spacetimedb.com/hsr-spacetimedb-test1/auth_token';
const status = () => connectionStatusStore.getSnapshot().status;
const USER = { ready: true, user: { id: 1, role: { tag: 'User' as const }, isGuest: false } };

let builder: MockBuilder;
beforeEach(() => {
    builder = wireConnectionEvents(new MockBuilder(), KEY);
});
afterEach(() => {
    setCurrentConnection(null);
    resetConnectionStatus();
    setAuthSnapshot({ ready: true });
    localStorage.clear();
    vi.restoreAllMocks();
});

describe('status store', () => {
    it('starts as connecting', () => {
        expect(status()).toEqual({ state: 'connecting' });
    });

    it('connect: connected, and the token is saved under the per-database key', () => {
        builder.connect('tok-1');
        expect(status()).toEqual({ state: 'connected' });
        expect(localStorage.getItem(KEY)).toBe('tok-1');
        expect(readStoredToken(KEY)).toBe('tok-1');
    });

    it('a drop the SDK retries is reconnecting, and the last auth snapshot is kept', () => {
        builder.connect('tok');
        setAuthSnapshot(USER);
        const before = authStore.getSnapshot();
        builder.disconnect(new Error('WebSocket closed (code 1006)'), 1);
        expect(status()).toEqual({
            state: 'reconnecting',
            reason: 'WebSocket closed (code 1006)',
        });
        // A failed retry attempt stays reconnecting.
        builder.connectError(new Error('WebSocket error'), 2);
        expect(status().state).toBe('reconnecting');
        expect(authStore.getSnapshot()).toBe(before);

        builder.automaticReconnect('tok');
        expect(status()).toEqual({ state: 'connected' });
    });

    it('a first connection that fails (no retry from the SDK) is failed/offline, auth not ready', () => {
        setAuthSnapshot(USER);
        builder.connectError(new Error('WebSocket error'));
        expect(status()).toEqual({
            state: 'failed',
            kind: 'offline',
            reason: 'WebSocket error',
            recovery: 'retry',
        });
        expect(authStore.getSnapshot()).toEqual({ ready: false });
    });

    it('a drop the SDK will not retry is failed', () => {
        builder.connect('tok');
        builder.disconnect(new Error('WebSocket closed (code 1008)'));
        expect(status()).toMatchObject({ state: 'failed', kind: 'offline' });
    });

    it('the module maintenance refusal is classified as maintenance', () => {
        builder.connectError(new Error(`WebSocket closed (code 1011: ${MAINTENANCE_REFUSAL})`));
        expect(status()).toMatchObject({ state: 'failed', kind: 'maintenance' });
    });

    it('the SDK closing the current connection itself (error on an applied subscription) is failed', () => {
        builder.connect('tok');
        // The SDK's own disconnect() sets isDisconnectRequested, like an app close; but the
        // connection is still the one the app is using.
        setCurrentConnection(builder.conn as unknown as StdbConnectionLike);
        builder.conn.isDisconnectRequested = true;
        builder.disconnect();
        expect(status()).toMatchObject({ state: 'failed', kind: 'offline', recovery: 'retry' });
        // Retry from there asks for a new connection.
        retryConnection();
        expect(status()).toEqual({ state: 'connecting' });
    });

    it('a close without an error after a failure keeps the first reason', () => {
        builder.connectError(new Error('first'));
        builder.disconnect();
        expect(status()).toMatchObject({ state: 'failed', reason: 'first' });
    });

    it('a close the app asked for (provider unmount) is not a failure', () => {
        builder.connect('tok');
        builder.conn.isDisconnectRequested = true;
        builder.disconnect();
        expect(status()).toEqual({ state: 'connected' });
    });

    it('Retry goes back to connecting and bumps the builder generation', () => {
        builder.connectError(new Error('WebSocket error'));
        const generation = connectionStatusStore.getSnapshot().generation;
        retryConnection();
        expect(status()).toEqual({ state: 'connecting' });
        expect(connectionStatusStore.getSnapshot().generation).toBe(generation + 1);
    });
});

describe('a stored token the server refuses', () => {
    /** The SDK's WebSocketTokenError (sdk/ws.ts): name and HTTP status of the token exchange. */
    function tokenError(status: number) {
        return Object.assign(new Error(`Failed to verify token: ${status} Unauthorized`), {
            name: 'WebSocketTokenError',
            status,
        });
    }

    it.each([401, 403])('%s: the token is deleted and Retry reloads the page', (code) => {
        localStorage.setItem(KEY, 'dead-token');
        const reload = vi.spyOn(pageReload, 'run').mockImplementation(() => {});
        builder.connectError(tokenError(code));
        expect(localStorage.getItem(KEY)).toBeNull();
        // The refused connection is closed, so the provider's manager does not rebuild it.
        expect(builder.conn.disconnects).toBe(1);
        expect(status()).toMatchObject({ state: 'failed', kind: 'offline', recovery: 'reload' });

        const generation = connectionStatusStore.getSnapshot().generation;
        retryConnection();
        expect(reload).toHaveBeenCalledTimes(1);
        expect(connectionStatusStore.getSnapshot().generation).toBe(generation);
    });

    it('another token exchange status (500) keeps the token and Retry builds again', () => {
        localStorage.setItem(KEY, 'tok');
        builder.connectError(tokenError(500));
        expect(localStorage.getItem(KEY)).toBe('tok');
        expect(builder.conn.disconnects).toBe(0);
        expect(status()).toMatchObject({ state: 'failed', recovery: 'retry' });
    });

    it('isRefusedToken needs the SDK error name and a 401 or 403 status', () => {
        expect(isRefusedToken(tokenError(401))).toBe(true);
        expect(isRefusedToken(Object.assign(new Error('x'), { status: 401 }))).toBe(false);
        expect(isRefusedToken(new Error('Failed to verify token: 401'))).toBe(false);
    });
});

describe('auth on failure', () => {
    it('does not publish a new not-ready snapshot when auth is already not ready', () => {
        setAuthSnapshot({ ready: false });
        const before = authStore.getSnapshot();
        builder.connectError(new Error('one'));
        builder.connectError(new Error('two'));
        expect(authStore.getSnapshot()).toBe(before);
    });
});

describe('classifyFailure', () => {
    it.each([
        ['the exact refusal', new Error(MAINTENANCE_REFUSAL), 'maintenance'],
        [
            'the refusal as a cause',
            new Error('Failed', { cause: new Error(MAINTENANCE_REFUSAL) }),
            'maintenance',
        ],
        ['the refusal as a string', MAINTENANCE_REFUSAL, 'maintenance'],
        ['a network error', new Error('WebSocket error'), 'offline'],
        [
            'the reducer maintenance text (not a connect refusal)',
            new Error('The site is in maintenance. Please try again later.'),
            'offline',
        ],
        ['nothing', undefined, 'offline'],
    ])('%s is %s', (_label, error, kind) => {
        expect(classifyFailure(error)).toBe(kind);
    });
});

describe('token storage', () => {
    it('never stores an empty token, and an empty stored value reads as none', () => {
        storeToken(KEY, '');
        expect(localStorage.getItem(KEY)).toBeNull();
        localStorage.setItem(KEY, '');
        expect(readStoredToken(KEY)).toBeUndefined();
        builder.connect('');
        expect(localStorage.getItem(KEY)).toBe('');
    });

    it('blocked storage: reading gives no token and saving does not throw', () => {
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
            throw new DOMException('blocked', 'SecurityError');
        });
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new DOMException('blocked', 'SecurityError');
        });
        expect(readStoredToken(KEY)).toBeUndefined();
        expect(() => storeToken(KEY, 'tok')).not.toThrow();
        // And a connect still reports connected.
        builder.connect('tok');
        expect(status()).toEqual({ state: 'connected' });
    });
});
