import { useEffect, useRef, useState } from 'react';
import { useStdbConnection } from './connectionContext';
import { connectionStatusStore } from './connectionStatus';
import type { SubscriptionHandleLike } from './types';

/*
 * A route's own subscriptions (CLAUDE.md §4, upgrade report R5): one subscription per query,
 * subscribed on mount, every handle kept, all unsubscribed on unmount and whenever the list
 * changes. The provider replays live subscriptions after a reconnect, so a handle that is never
 * unsubscribed would be replayed for the rest of the session.
 *
 * Queries are SQL strings: `toSql(tables.x)` for a table or view, `SELECT * FROM view_x(42)` for a
 * view with arguments. A changed list unsubscribes the old set before subscribing the new one
 * (effect cleanup order), which is what views with arguments need (one argument set at a time).
 *
 * The list is compared in order: the same queries in a different order count as a new list and
 * resubscribe. Callers pass a list in a fixed order (a constant, or built the same way each render).
 */

export type RouteSubscriptionState = {
    /** Every query has had its first result. */
    ready: boolean;
    /** The first subscription error, if any. */
    error?: string;
};

/**
 * S14.3c-sync (second review N1): `fresh` is true while every query has had a result since the connection was last
 * not open. The SDK reports a reconnect (status `connected`) before it replays the subscriptions, and keeps the old
 * rows until the replay lands; `ready` stays true through that gap, `fresh` does not. A page that writes on the
 * strength of what it reads (the team builder's loadout sync) waits for `fresh`.
 */
export type FreshRouteSubscriptionState = RouteSubscriptionState & { fresh: boolean };

const isOpen = () => connectionStatusStore.getSnapshot().status.state === 'connected';

/** Duplicates dropped, order kept: one subscription per query. */
function unique(queries: readonly string[]): { list: string[]; dropped: string[] } {
    const seen = new Set<string>();
    const list: string[] = [];
    const dropped: string[] = [];
    for (const q of queries) {
        if (seen.has(q)) dropped.push(q);
        else {
            seen.add(q);
            list.push(q);
        }
    }
    return { list, dropped };
}

export function useRouteSubscriptions(queries: readonly string[]): RouteSubscriptionState {
    const { ready, error } = useFreshRouteSubscriptions(queries);
    return { ready, error };
}

/** `useRouteSubscriptions` plus `fresh` (above). */
export function useFreshRouteSubscriptions(
    queries: readonly string[],
): FreshRouteSubscriptionState {
    const conn = useStdbConnection();
    // A stable key (JSON, so any character in a query is safe): a new array with the same
    // queries does not resubscribe.
    const { list: uniqueList, dropped } = unique(queries);
    const key = JSON.stringify(uniqueList);
    // A duplicate is a caller bug: say so once per mount (dev only), not on every render.
    const warned = useRef(false);
    const firstDropped = dropped[0];
    useEffect(() => {
        if (!import.meta.env.DEV || warned.current || firstDropped === undefined) return;
        warned.current = true;
        console.warn(`[stdb] duplicate route subscription dropped: ${firstDropped}`);
    }, [firstDropped]);
    const [state, setState] = useState<FreshRouteSubscriptionState & { key: string }>({
        key,
        ready: false,
        fresh: false,
    });

    useEffect(() => {
        const list = JSON.parse(key) as string[];
        // A new list starts clean: no error, not ready (ready at once when there is nothing).
        setState({ key, ready: list.length === 0, fresh: list.length === 0 });
        if (!conn || list.length === 0) return;

        let active = true;
        const applied = new Set<string>();
        const failed = new Set<string>();
        // Results since the connection was last not open (N1).
        let fresh = new Set<string>();
        const stopWatch = connectionStatusStore.subscribe(() => {
            if (!active || isOpen() || fresh.size === 0) return;
            fresh = new Set();
            setState((s) => (s.fresh ? { ...s, fresh: false } : s));
        });
        const handles: SubscriptionHandleLike[] = list.map((query) =>
            conn
                .subscriptionBuilder()
                .onApplied(() => {
                    // Fires again after each replay (reconnect); the sets make that harmless.
                    if (!active) return;
                    applied.add(query);
                    fresh.add(query);
                    failed.delete(query);
                    if (applied.size === list.length && failed.size === 0) {
                        const all = fresh.size === list.length;
                        setState((s) => ({ ...s, key, ready: true, fresh: all }));
                    }
                })
                .onError((_ctx, error) => {
                    // Also after a replay: the query is no longer live, so the route is not ready.
                    if (!active) return;
                    applied.delete(query);
                    fresh.delete(query);
                    failed.add(query);
                    setState((s) => ({
                        key,
                        ready: false,
                        fresh: false,
                        error: s.error ?? `${query}: ${error?.message ?? 'subscription failed'}`,
                    }));
                })
                .subscribe(query),
        );

        return () => {
            active = false;
            stopWatch();
            for (const handle of handles) if (!handle.isEnded()) handle.unsubscribe();
        };
    }, [conn, key]);

    // Until the effect has run for a new list, report the new list as not ready.
    if (state.key !== key) return { ready: key === '[]', fresh: key === '[]' };
    return { ready: state.ready, error: state.error, fresh: state.fresh };
}
