import type { HsrCharacterCost, HsrLightconeCost, HsrSynergyCost } from '@bindings/types';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { buildCostLookup, type CostLookup, rowsOfSet } from './costLookup';
import { costQueryList } from './costQueries';
import { useRouteSubscriptions } from './useRouteSubscriptions';
import { useRows } from './useRows';

export type CustomCostSet = {
    /** Every query has had its first result (always true without a custom set). */
    ready: boolean;
    error?: string;
    lookup: CostLookup;
    /** Subscribes the set again after an error. */
    retry: () => void;
};

const NO_ROWS: never[] = [];

/**
 * Moved here from pages/costs/useCostSet.ts in S14.3a (the costs page and the team builder share it).
 *
 * A custom cost set's rows (S14.2, user ruling item 2): a route subscription on
 * `cost_set_id = id` for the three cost tables, unsubscribed when the id changes or the page
 * unmounts (`useRouteSubscriptions` unsubscribes the old set before subscribing the new one).
 * `id` 0 (the default set, in the reference set) or `undefined` subscribes nothing. Rows are
 * filtered by `costSetId`, because the cache also holds the default set.
 */
export function useCustomCostSet(id: number | undefined): CustomCostSet {
    // A retry drops the queries for one render, so the failed subscription is replaced.
    const [paused, setPaused] = useState(false);
    useEffect(() => {
        if (paused) setPaused(false);
    }, [paused]);
    const active = id !== undefined && id > 0;
    const queries = useMemo(
        () => (active && !paused ? costQueryList(id) : []),
        [active, paused, id],
    );
    const sub = useRouteSubscriptions(queries);

    const characterRows = useRows((c) => (active ? c.db.hsrCharacterCost : undefined), sub.ready);
    const lightconeRows = useRows((c) => (active ? c.db.hsrLightconeCost : undefined), sub.ready);
    const synergyRows = useRows((c) => (active ? c.db.hsrSynergyCost : undefined), sub.ready);

    const lookup = useMemo(() => {
        if (!active) return buildCostLookup(NO_ROWS, NO_ROWS, NO_ROWS);
        return buildCostLookup(
            rowsOfSet(characterRows as readonly HsrCharacterCost[], id),
            rowsOfSet(lightconeRows as readonly HsrLightconeCost[], id),
            rowsOfSet(synergyRows as readonly HsrSynergyCost[], id),
        );
    }, [active, id, characterRows, lightconeRows, synergyRows]);

    const retry = useCallback(() => setPaused(true), []);
    return { ready: !active || sub.ready, error: active ? sub.error : undefined, lookup, retry };
}
