import { tables } from '@bindings/index';
import type { MyLobbyListRow, MyProfileRow } from '@bindings/types';
import { useSyncExternalStore } from 'react';
import { toSql } from 'spacetimedb';
import { type AuthSnapshot, authStore, setAuthSnapshot } from '@/auth/authStore';
import { failConnection } from './connectionStatus';
import { setSuspended } from './suspensionStatus';
import type { StdbConnectionLike } from './types';

/*
 * Layer 0 (docs/frontend/subscriptions.md Decision 6): on every route, for the whole session,
 * `view_my_profile`, `view_my_lobbies` and (SUS2) `view_my_suspension`, nothing else. The profile
 * view feeds the auth store (the router guards); the lobbies view feeds `useMyLobbies()`; the
 * suspension view feeds the suspension flag (`suspensionStatus.ts`, the root's `SuspensionGate`).
 */

export const LAYER0_QUERIES = {
    profile: toSql(tables.viewMyProfile),
    lobbies: toSql(tables.viewMyLobbies),
    suspension: toSql(tables.viewMySuspension),
} as const;

/** The auth snapshot for the rows of `view_my_profile` (at most one). */
export function profileToAuth(rows: readonly MyProfileRow[]): AuthSnapshot {
    const row = rows[0];
    if (!row) return { ready: true };
    return {
        ready: true,
        user: { id: row.id, role: row.role, isGuest: row.isGuest, displayName: row.displayName },
    };
}

function sameAuth(a: AuthSnapshot, b: AuthSnapshot): boolean {
    if (a.ready !== b.ready) return false;
    if (!a.user || !b.user) return a.user === b.user;
    return (
        a.user.id === b.user.id &&
        a.user.role.tag === b.user.role.tag &&
        a.user.isGuest === b.user.isGuest &&
        a.user.displayName === b.user.displayName
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
 * cache, and (SUS2) the suspension flag. Returns the cleanup (callbacks removed, every handle
 * unsubscribed). Row events before the first `onApplied` of both the profile and the suspension
 * view are ignored for auth: "no row yet" is not "visitor" until applied.
 */
export function startLayer0(conn: StdbConnectionLike): () => void {
    const { viewMyProfile, viewMyLobbies, viewMySuspension } = conn.db;
    let profileApplied = false;
    // SUS2: without the suspension handle (the test doubles of earlier steps) there is nothing to
    // wait for; the generated connection always has it.
    let suspensionApplied = viewMySuspension === undefined;
    let stopped = false;
    // Set by the first subscription error: from then on this connection says nothing about the
    // viewer. The SDK delivers a failed replay's error first and the deletes of that subscription's
    // cached rows after it (`db_connection_impl.ts` `#applyReplayBatch`); without this flag the
    // profile delete would turn a signed-in user into a visitor under the splash and the guards
    // would send them to sign in.
    // The flag does not cover one case: in a replay batch the SDK first calls `onApplied` of the
    // sets that succeeded, then `onError` of the failed one (`#applyReplayBatch`). The applied
    // callbacks run `syncProfile` with the failed set's rows already gone and `dead` still false,
    // so listeners can see a passing "visitor" (or the suspension flag go false) before the error
    // in the same task. No render or redirect happens in between and the end state is the offline
    // splash, but the suspension flag stays false afterwards: after Retry the shell can show until
    // the new connection's first result.
    let dead = false;

    // Callbacks run after the whole transaction is in the cache, so reading the cache here sees
    // the final state of a role change (delete + insert) at once, never a gap.
    //
    // SUS2: the profile and the suspension are read together, once both have had a first result.
    // While suspended the auth store says "not ready" (the account's views answer as for a
    // visitor, so "visitor" would send the guards to the sign-in panel under the suspended
    // screen); when the row goes (lifted) the profile row is back in the same transaction, the
    // user returns and the guards run again on the same address.
    const syncProfile = () => {
        if (stopped || dead || !profileApplied || !suspensionApplied) return;
        const isSuspended =
            viewMySuspension !== undefined && [...viewMySuspension.iter()].length > 0;
        const next: AuthSnapshot = isSuspended
            ? { ready: false }
            : profileToAuth([...viewMyProfile.iter()]);
        // The screen goes up before the auth store changes, and comes down after it.
        if (isSuspended) setSuspended(true);
        if (!sameAuth(authStore.getSnapshot(), next)) setAuthSnapshot(next);
        if (!isSuspended) setSuspended(false);
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
    viewMySuspension?.onInsert(syncProfile);
    viewMySuspension?.onUpdate(syncProfile);
    viewMySuspension?.onDelete(syncProfile);

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
    const mySuspension = viewMySuspension
        ? conn
              .subscriptionBuilder()
              .onApplied(() => {
                  suspensionApplied = true;
                  syncProfile();
              })
              .onError(failed('view_my_suspension'))
              .subscribe(LAYER0_QUERIES.suspension)
        : undefined;

    return () => {
        stopped = true;
        viewMyProfile.removeOnInsert(syncProfile);
        viewMyProfile.removeOnUpdate(syncProfile);
        viewMyProfile.removeOnDelete(syncProfile);
        viewMyLobbies.removeOnInsert(syncLobbies);
        viewMyLobbies.removeOnUpdate(syncLobbies);
        viewMyLobbies.removeOnDelete(syncLobbies);
        viewMySuspension?.removeOnInsert(syncProfile);
        viewMySuspension?.removeOnUpdate(syncProfile);
        viewMySuspension?.removeOnDelete(syncProfile);
        for (const handle of [profile, myLobbies, mySuspension]) {
            if (handle && !handle.isEnded()) handle.unsubscribe();
        }
        setLobbies([]);
    };
}
