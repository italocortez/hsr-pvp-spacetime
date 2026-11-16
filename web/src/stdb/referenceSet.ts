import type {
    Archetype,
    CostSet,
    HsrCharacter,
    HsrCharacterArchetype,
    HsrCharacterCost,
    HsrLightcone,
    HsrLightconeCost,
    HsrSynergyCost,
} from '@bindings/types';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { useStdbConnection } from './connectionContext';
import { buildCostLookup, rowsOfSet } from './costLookup';
import { costQueryList, DEFAULT_COST_SET_ID } from './costQueries';
import type { KeylessTableLike, StdbConnectionLike, SubscriptionHandleLike } from './types';

/*
 * The public reference set (docs/frontend/subscriptions.md Decision 1): started by the first
 * caller of `useReferenceSet()`, then kept for the whole session and never stopped. `/` and
 * `/profile` never call it.
 *
 * Two groups, each started once per session by the first route that needs it and carried over
 * to every new connection object:
 * - the base group: characters, light cones, archetypes, the character-archetype links and the
 *   published cost sets (five queries);
 * - the default cost set (S14.2, user ruling 2026-11-16): the three cost tables filtered on
 *   `cost_set_id = 0`, asked for with `useReferenceSet({ costs: true })`. A custom set is never
 *   part of it: a page subscribes that one itself (`costQueryList(id)`), so the queries stay
 *   disjoint, and rows are always read through `rowsOfSet(..., 0)` because the client cache is shared.
 *
 * The SQL is plain text (no SDK import here), so a page chunk that uses this hook does not pull
 * the SDK in statically; `costQueries.test.ts` checks the text against the SDK's query builder.
 */

export const REFERENCE_QUERIES = [
    'SELECT * FROM "hsr_character"',
    'SELECT * FROM "hsr_lightcone"',
    'SELECT * FROM "archetype"',
    'SELECT * FROM "hsr_character_archetype"',
    'SELECT * FROM "view_published_cost_sets"',
] as const;

/** The default cost set's three queries (characters, light cones, synergies). */
export const DEFAULT_COST_QUERIES: readonly string[] = costQueryList(DEFAULT_COST_SET_ID);

type BaseRows = {
    characters: readonly HsrCharacter[];
    lightcones: readonly HsrLightcone[];
    archetypes: readonly Archetype[];
    characterArchetypes: readonly HsrCharacterArchetype[];
    costSets: readonly CostSet[];
};
type CostRows = {
    characterCosts: readonly HsrCharacterCost[];
    lightconeCosts: readonly HsrLightconeCost[];
    synergyCosts: readonly HsrSynergyCost[];
};
type Rows = BaseRows & CostRows;

/**
 * `ready`: every source of the group has had a first result (on some connection). `stale`: the
 * connection was replaced and the rows shown are the previous connection's until every source has
 * applied on the new one. `error`: the first failed subscription of the group on the current
 * connection, if any. The `costs...` fields are the same for the default cost set.
 */
type Snapshot = Rows & {
    ready: boolean;
    stale: boolean;
    error?: string;
    costsReady: boolean;
    costsStale: boolean;
    costsError?: string;
};

const EMPTY: Snapshot = {
    ready: false,
    stale: false,
    costsReady: false,
    costsStale: false,
    characters: [],
    lightcones: [],
    archetypes: [],
    characterArchetypes: [],
    costSets: [],
    characterCosts: [],
    lightconeCosts: [],
    synergyCosts: [],
};

let snapshot: Snapshot = EMPTY;
const listeners = new Set<() => void>();

function publish(next: Snapshot): void {
    snapshot = next;
    for (const listener of listeners) listener();
}

type AnyTable = KeylessTableLike<unknown> & {
    onUpdate?: (cb: (...args: never[]) => void) => void;
    removeOnUpdate?: (cb: (...args: never[]) => void) => void;
};

/** One group of session-long subscriptions and the snapshot fields it writes. */
type Group = {
    readonly name: string;
    readonly queries: readonly string[];
    /** Snapshot keys, one per query, in query order. */
    readonly keys: readonly (keyof Rows)[];
    readonly readyKey: 'ready' | 'costsReady';
    readonly staleKey: 'stale' | 'costsStale';
    readonly errorKey: 'error' | 'costsError';
    /** The cache handle of each key (undefined: the connection lacks it). */
    tables(conn: StdbConnectionLike): (AnyTable | undefined)[];
    /** Reads one key's rows from its cache handle. */
    read(key: keyof Rows, table: AnyTable): unknown[];
    requested: boolean;
    startedOn: StdbConnectionLike | null;
    stop: (() => void) | null;
};

const base: Group = {
    name: 'reference',
    queries: REFERENCE_QUERIES,
    keys: ['characters', 'lightcones', 'archetypes', 'characterArchetypes', 'costSets'],
    readyKey: 'ready',
    staleKey: 'stale',
    errorKey: 'error',
    tables: (conn) =>
        [
            conn.db.hsrCharacter,
            conn.db.hsrLightcone,
            conn.db.archetype,
            conn.db.hsrCharacterArchetype,
            conn.db.viewPublishedCostSets,
        ] as AnyTable[],
    read: (_key, table) => [...table.iter()],
    requested: false,
    startedOn: null,
    stop: null,
};

const costs: Group = {
    name: 'default cost set',
    queries: DEFAULT_COST_QUERIES,
    keys: ['characterCosts', 'lightconeCosts', 'synergyCosts'],
    readyKey: 'costsReady',
    staleKey: 'costsStale',
    errorKey: 'costsError',
    tables: (conn) =>
        [conn.db.hsrCharacterCost, conn.db.hsrLightconeCost, conn.db.hsrSynergyCost] as (
            | AnyTable
            | undefined
        )[],
    // The cache may also hold a custom set a page subscribed: keep set 0 only.
    read: (_key, table) =>
        rowsOfSet(table.iter() as Iterable<{ costSetId: number }>, DEFAULT_COST_SET_ID),
    requested: false,
    startedOn: null,
    stop: null,
};

function startGroup(group: Group, conn: StdbConnectionLike, restart = false): void {
    if (group.startedOn === conn && !restart) return;
    // The provider's manager replaced the connection object: the old one is closed for good.
    // Its rows stay published until the new subscriptions have applied (no empty flash).
    group.stop?.();
    const swapped = group.startedOn !== null && group.startedOn !== conn;
    group.startedOn = conn;
    // A new connection (or a retry): the old error no longer applies; rows of the old connection
    // are stale until the new subscriptions apply (a first start has no rows to be stale).
    if (snapshot[group.errorKey] !== undefined || swapped) {
        publish({ ...snapshot, [group.errorKey]: undefined, [group.staleKey]: swapped });
    }

    const tables = group.tables(conn);
    const keys = group.keys;
    const applied = new Set<keyof Rows>();
    const dirty = new Set<keyof Rows>();
    let flushQueued = false;
    let stopped = false;

    const missing = keys.filter((_k, i) => tables[i] === undefined);
    if (missing.length > 0) {
        group.stop = () => {
            stopped = true;
        };
        publish({
            ...snapshot,
            [group.errorKey]: `${group.name}: the connection has no table for ${missing.join(', ')}`,
        });
        return;
    }

    // One read of the cache per table per burst: the initial result inserts every row one by one.
    const flush = () => {
        flushQueued = false;
        if (stopped || dirty.size === 0) return;
        const next: Snapshot = { ...snapshot };
        for (const key of dirty) {
            const table = tables[keys.indexOf(key)] as AnyTable;
            // A source not applied yet on this connection keeps the previous connection's rows.
            if (applied.has(key))
                (next as Record<keyof Rows, unknown>)[key] = group.read(key, table);
        }
        dirty.clear();
        next[group.readyKey] = snapshot[group.readyKey] || applied.size === keys.length;
        if (applied.size === keys.length) next[group.staleKey] = false;
        publish(next);
    };
    const markDirty = (key: keyof Rows) => {
        dirty.add(key);
        if (!flushQueued) {
            flushQueued = true;
            queueMicrotask(flush);
        }
    };

    // Inserts and deletes on every source; updates where the handle has them (tables and views
    // with a primary key).
    const callbacks = keys.map((key, i) => {
        const table = tables[i] as AnyTable;
        const cb = () => markDirty(key);
        table.onInsert(cb);
        table.onDelete(cb);
        table.onUpdate?.(cb);
        return { table, cb };
    });
    const handles: SubscriptionHandleLike[] = keys.map((key, i) => {
        const query = group.queries[i] as string;
        return conn
            .subscriptionBuilder()
            .onApplied(() => {
                applied.add(key);
                markDirty(key);
            })
            .onError((_ctx, error) => {
                if (stopped) return;
                console.error(`[stdb] ${group.name} subscription failed: ${query}`, error);
                if (snapshot[group.errorKey] === undefined) {
                    publish({
                        ...snapshot,
                        [group.errorKey]: `${query}: ${error?.message ?? 'subscription failed'}`,
                    });
                }
            })
            .subscribe(query);
    });

    group.stop = () => {
        stopped = true;
        for (const { table, cb } of callbacks) {
            table.removeOnInsert(cb);
            table.removeOnDelete(cb);
            table.removeOnUpdate?.(cb);
        }
        for (const handle of handles) if (!handle.isEnded()) handle.unsubscribe();
    };
}

/** Starts the base reference set on `conn` (once per session; a no-op when already running there). */
export function requestReferenceSet(conn: StdbConnectionLike): void {
    base.requested = true;
    startGroup(base, conn);
}

/** Starts the default cost set's three queries on `conn` (once per session, kept like the base). */
export function requestDefaultCostSet(conn: StdbConnectionLike): void {
    costs.requested = true;
    startGroup(costs, conn);
}

/** Called for every new connection object: carries the started groups over to it. */
export function resumeReferenceSet(conn: StdbConnectionLike): void {
    if (base.requested) startGroup(base, conn);
    if (costs.requested) startGroup(costs, conn);
}

/**
 * Subscribes again the group(s) that failed on the current connection (the "Retry" of a page's
 * inline error). Groups without an error are left alone.
 */
export function retryReferenceSet(): void {
    for (const group of [base, costs]) {
        if (snapshot[group.errorKey] !== undefined && group.startedOn) {
            startGroup(group, group.startedOn, true);
        }
    }
}

/** Whether anything has asked for the (base) reference set this session. */
export function isReferenceSetRequested(): boolean {
    return base.requested;
}

/** Whether anything has asked for the default cost set this session. */
export function isDefaultCostSetRequested(): boolean {
    return costs.requested;
}

/** Test helper: forget the session's reference set. */
export function resetReferenceSetForTests(): void {
    for (const group of [base, costs]) {
        group.stop?.();
        group.stop = null;
        group.startedOn = null;
        group.requested = false;
    }
    publish(EMPTY);
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/**
 * The reference rows and their lookup maps. The first call in a session starts the subscription;
 * it is never stopped. With `{ costs: true }` the default cost set joins it (also for the rest of
 * the session). Maps are rebuilt only when their row array changes.
 */
export function useReferenceSet(options?: { costs?: boolean }) {
    const conn = useStdbConnection();
    const wantCosts = options?.costs === true;
    useEffect(() => {
        if (!conn) return;
        requestReferenceSet(conn);
        if (wantCosts) requestDefaultCostSet(conn);
    }, [conn, wantCosts]);

    const rows = useSyncExternalStore(subscribe, () => snapshot);
    const {
        characters,
        lightcones,
        archetypes,
        characterArchetypes,
        characterCosts,
        lightconeCosts,
        synergyCosts,
    } = rows;

    const characterByName = useMemo(
        () => new Map(characters.map((c) => [c.name, c] as const)),
        [characters],
    );
    const lightconeByName = useMemo(
        () => new Map(lightcones.map((l) => [l.name, l] as const)),
        [lightcones],
    );
    const archetypeById = useMemo(
        () => new Map(archetypes.map((a) => [a.id, a] as const)),
        [archetypes],
    );
    const archetypeIdsByCharacter = useMemo(() => {
        const map = new Map<string, number[]>();
        for (const link of characterArchetypes) {
            const list = map.get(link.characterName);
            if (list) list.push(link.archetypeId);
            else map.set(link.characterName, [link.archetypeId]);
        }
        return map;
    }, [characterArchetypes]);
    /** The default set's cost rows by name, game mode and draft mode. */
    const defaultCosts = useMemo(
        () => buildCostLookup(characterCosts, lightconeCosts, synergyCosts),
        [characterCosts, lightconeCosts, synergyCosts],
    );

    return {
        ...rows,
        characterByName,
        lightconeByName,
        archetypeById,
        archetypeIdsByCharacter,
        defaultCosts,
    };
}
