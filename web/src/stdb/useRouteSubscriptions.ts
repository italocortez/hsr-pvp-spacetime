import { useEffect, useState } from 'react';
import { useStdbConnection } from './connectionContext';
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
 */

export type RouteSubscriptionState = {
    /** Every query has had its first result. */
    ready: boolean;
    /** The first subscription error, if any. */
    error?: string;
};

/** Duplicates dropped, order kept: one subscription per query. */
function unique(queries: readonly string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const q of queries) {
        if (seen.has(q)) {
            if (import.meta.env.DEV)
                console.warn(`[stdb] duplicate route subscription dropped: ${q}`);
            continue;
        }
        seen.add(q);
        out.push(q);
    }
    return out;
}

export function useRouteSubscriptions(queries: readonly string[]): RouteSubscriptionState {
    const conn = useStdbConnection();
    // A stable key (JSON, so any character in a query is safe): a new array with the same
    // queries does not resubscribe.
    const key = JSON.stringify(unique(queries));
    const [state, setState] = useState<RouteSubscriptionState & { key: string }>({
        key,
        ready: false,
    });

    useEffect(() => {
        const list = JSON.parse(key) as string[];
        // A new list starts clean: no error, not ready (ready at once when there is nothing).
        setState({ key, ready: list.length === 0 });
        if (!conn || list.length === 0) return;

        let active = true;
        const applied = new Set<string>();
        const failed = new Set<string>();
        const handles: SubscriptionHandleLike[] = list.map((query) =>
            conn
                .subscriptionBuilder()
                .onApplied(() => {
                    // Fires again after each replay (reconnect); the set makes that harmless.
                    if (!active) return;
                    applied.add(query);
                    failed.delete(query);
                    if (applied.size === list.length && failed.size === 0) {
                        setState((s) => ({ ...s, key, ready: true }));
                    }
                })
                .onError((_ctx, error) => {
                    // Also after a replay: the query is no longer live, so the route is not ready.
                    if (!active) return;
                    applied.delete(query);
                    failed.add(query);
                    setState((s) => ({
                        key,
                        ready: false,
                        error: s.error ?? `${query}: ${error?.message ?? 'subscription failed'}`,
                    }));
                })
                .subscribe(query),
        );

        return () => {
            active = false;
            for (const handle of handles) if (!handle.isEnded()) handle.unsubscribe();
        };
    }, [conn, key]);

    // Until the effect has run for a new list, report the new list as not ready.
    if (state.key !== key) return { ready: key === '[]' };
    return { ready: state.ready, error: state.error };
}
