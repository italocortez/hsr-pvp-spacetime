import { useEffect, useMemo, useReducer } from 'react';
import { useStdbConnection } from './connectionContext';
import type { KeylessTableLike, StdbConnectionLike, TableLike } from './types';

/*
 * The current rows of one table or view from the connection's client cache (A173), following
 * inserts, updates and deletes. Rows are read from the cache during render, keyed on a version
 * that the row callbacks bump, so a render always shows the cache as it is now.
 *
 * Row callbacks only schedule the bump (one microtask, coalesced): the SDK fires all callbacks of
 * one transaction in a row, so a keyless view whose row is replaced (an insert plus a delete) is
 * read once, after both, and the two rows that may be visible inside a single callback are never
 * shown (docs/auth/architecture.md "Requirements for M5b", item 8).
 *
 * The caller owns the subscription (`useRouteSubscriptions`); pass its `ready` (or any value that
 * changes when the subscription's first result lands) as `refreshKey`, since rows that arrive
 * with a first result do not always come with row events.
 */

const EMPTY: readonly never[] = [];

type AnyTable<Row> = TableLike<Row> | KeylessTableLike<Row>;

export function useRows<Row>(
    select: (conn: StdbConnectionLike) => AnyTable<Row> | undefined,
    refreshKey?: unknown,
): readonly Row[] {
    const conn = useStdbConnection();
    const table = conn ? select(conn) : undefined;
    const [version, bump] = useReducer((n: number) => n + 1, 0);

    useEffect(() => {
        if (!table) return;
        let active = true;
        let scheduled = false;
        const schedule = () => {
            if (scheduled) return;
            scheduled = true;
            queueMicrotask(() => {
                scheduled = false;
                if (active) bump();
            });
        };
        table.onInsert(schedule);
        table.onDelete(schedule);
        const keyed = 'onUpdate' in table ? (table as TableLike<Row>) : undefined;
        keyed?.onUpdate(schedule);
        // Rows may have changed between the render and this effect.
        bump();
        return () => {
            active = false;
            table.removeOnInsert(schedule);
            table.removeOnDelete(schedule);
            keyed?.removeOnUpdate(schedule);
        };
    }, [table]);

    // biome-ignore lint/correctness/useExhaustiveDependencies: version and refreshKey mean "the cache changed"
    return useMemo(() => (table ? [...table.iter()] : EMPTY), [table, version, refreshKey]);
}
