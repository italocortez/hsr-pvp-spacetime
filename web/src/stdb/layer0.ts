import { tables } from '@bindings/index';
import type { MyLobbyListRow, MyProfileRow } from '@bindings/types';
import { useSyncExternalStore } from 'react';
import { toSql } from 'spacetimedb';
import { type AuthSnapshot, authStore, setAuthSnapshot } from '@/auth/authStore';
import { failConnection } from './connectionStatus';
import type { StdbConnectionLike } from './types';

/*
 * Layer 0 (docs/frontend/subscriptions.md Decision 6): on every route, for the whole session,
 * `view_my_profile` and `view_my_lobbies`, nothing else. The profile view feeds the auth store
 * (the router guards); the lobbies view feeds `useMyLobbies()`.
 */

export const LAYER0_QUERIES = {
    profile: toSql(tables.viewMyProfile),
    lobbies: toSql(tables.viewMyLobbies),
} as const;

/** The auth snapshot for the rows of `view_my_profile` (at most one). */
export function profileToAuth(rows: readonly MyProfileRow[]): AuthSnapshot {
    const row = rows[0];
    if (!row) return { ready: true };
    return { ready: true, user: { id: row.id, role: row.role, isGuest: row.isGuest } };
}

function sameAuth(a: AuthSnapshot, b: AuthSnapshot): boolean {
    if (a.ready !== b.ready) return false;
    if (!a.user || !b.user) return a.user === b.user;
    return (
        a.user.id === b.user.id &&
        a.user.role.tag === b.user.role.tag &&
        a.user.isGuest === b.user.isGuest
    );
}

// --- view_my_lobbies rows, for useMyLobbies() --------------------------------------------------

let lobbies: readonly MyLobbyListRow[] = [];
const lobbyListeners = new Set<() => void>();

function setLobbies(next: readonly MyLobbyListRow[]): void {
    if (next.length === 0 && lobbies.length === 0) return;
    lobbies = next;
    for (const listener of lobbyListeners) listener();
}

function subscribeLobbies(listener: () => void): () => void {
    lobbyListeners.add(listener);
    return () => {
        lobbyListeners.delete(listener);
    };
}

/** The viewer's lobbies (`view_my_lobbies`), empty until the first result. No UI uses it yet. */
export function useMyLobbies(): readonly MyLobbyListRow[] {
    return useSyncExternalStore(subscribeLobbies, () => lobbies);
}

// --- the subscriptions ---------------------------------------------------------------------------

/**
 * Subscribes Layer 0 on `conn` and keeps the auth store and the lobby rows in step with the
 * cache. Returns the cleanup (callbacks removed, both handles unsubscribed). Row events before
 * the first `onApplied` are ignored for auth: "no row yet" is not "visitor" until applied.
 */
export function startLayer0(conn: StdbConnectionLike): () => void {
    const { viewMyProfile, viewMyLobbies } = conn.db;
    let profileApplied = false;
    let stopped = false;
    // Set by the first subscription error: from then on this connection says nothing about the
    // viewer. The SDK delivers a failed replay's error first and the deletes of that subscription's
    // cached rows after it (`db_connection_impl.ts` `#applyReplayBatch`); without this flag the
    // profile delete would turn a signed-in user into a visitor under the splash and the guards
    // would send them to sign in.
    let dead = false;

    // Callbacks run after the whole transaction is in the cache, so reading the cache here sees
    // the final state of a role change (delete + insert) at once, never a gap.
    const syncProfile = () => {
        if (stopped || dead || !profileApplied) return;
        const next = profileToAuth([...viewMyProfile.iter()]);
        if (!sameAuth(authStore.getSnapshot(), next)) setAuthSnapshot(next);
    };
    const syncLobbies = () => {
        if (stopped || dead) return;
        setLobbies([...viewMyLobbies.iter()]);
    };

    viewMyProfile.onInsert(syncProfile);
    viewMyProfile.onUpdate(syncProfile);
    viewMyProfile.onDelete(syncProfile);
    viewMyLobbies.onInsert(syncLobbies);
    viewMyLobbies.onUpdate(syncLobbies);
    viewMyLobbies.onDelete(syncLobbies);

    // Layer 0 is what tells the app who the viewer is: without it the guards would wait forever, or
    // keep a user whose view is gone (a failed replay). A subscription error is a connection
    // failure: the splash with Retry, auth not ready, and the connection closed so that Retry
    // builds a new one and subscribes again.
    const failed = (view: string) => (_ctx: unknown, error?: Error) => {
        // A second error (the other view, same frame) keeps the first reason and closes nothing more.
        if (stopped || dead) return;
        dead = true;
        console.error(`[stdb] ${view} subscription failed`, error);
        failConnection(error ?? new Error(`${view} subscription failed`));
        // Not from inside the SDK's message handling.
        queueMicrotask(() => {
            if (!stopped) conn.disconnect();
        });
    };

    const profile = conn
        .subscriptionBuilder()
        .onApplied(() => {
            profileApplied = true;
            syncProfile();
        })
        .onError(failed('view_my_profile'))
        .subscribe(LAYER0_QUERIES.profile);
    const myLobbies = conn
        .subscriptionBuilder()
        .onApplied(syncLobbies)
        .onError(failed('view_my_lobbies'))
        .subscribe(LAYER0_QUERIES.lobbies);

    return () => {
        stopped = true;
        viewMyProfile.removeOnInsert(syncProfile);
        viewMyProfile.removeOnUpdate(syncProfile);
        viewMyProfile.removeOnDelete(syncProfile);
        viewMyLobbies.removeOnInsert(syncLobbies);
        viewMyLobbies.removeOnUpdate(syncLobbies);
        viewMyLobbies.removeOnDelete(syncLobbies);
        for (const handle of [profile, myLobbies]) {
            if (!handle.isEnded()) handle.unsubscribe();
        }
        setLobbies([]);
    };
}
