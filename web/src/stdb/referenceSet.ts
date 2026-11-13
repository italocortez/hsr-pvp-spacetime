import { tables } from '@bindings/index';
import type {
    Archetype,
    CostSet,
    HsrCharacter,
    HsrCharacterArchetype,
    HsrLightcone,
} from '@bindings/types';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { toSql } from 'spacetimedb';
import { useStdbConnection } from './connectionContext';
import type { KeylessTableLike, StdbConnectionLike, SubscriptionHandleLike } from './types';

/*
 * The public reference set (docs/frontend/subscriptions.md Decision 1): started by the first
 * caller of `useReferenceSet()`, then kept for the whole session and never stopped. `/` and
 * `/profile` never call it; in M6 no route does.
 *
 * The three cost tables (`hsr_character_cost`, `hsr_lightcone_cost`, `hsr_synergy_cost`) are not
 * subscribed yet: the module has no "active" cost set to filter them by (a lobby picks any
 * published set, or the default set 0), so the filter is an open question for the user (M6 hand-back).
 */

export const REFERENCE_QUERIES = [
    toSql(tables.hsrCharacter),
    toSql(tables.hsrLightcone),
    toSql(tables.archetype),
    toSql(tables.hsrCharacterArchetype),
    toSql(tables.viewPublishedCostSets),
] as const;

type Rows = {
    characters: readonly HsrCharacter[];
    lightcones: readonly HsrLightcone[];
    archetypes: readonly Archetype[];
    characterArchetypes: readonly HsrCharacterArchetype[];
    costSets: readonly CostSet[];
};
type Key = keyof Rows;
/**
 * `ready`: every source has had a first result (on some connection). `error`: the first failed
 * subscription on the current connection, if any.
 */
type Snapshot = Rows & { ready: boolean; error?: string };

const EMPTY: Snapshot = {
    ready: false,
    characters: [],
    lightcones: [],
    archetypes: [],
    characterArchetypes: [],
    costSets: [],
};

let snapshot: Snapshot = EMPTY;
const listeners = new Set<() => void>();
let requested = false;
let startedOn: StdbConnectionLike | null = null;
let stopCurrent: (() => void) | null = null;

function publish(next: Snapshot): void {
    snapshot = next;
    for (const listener of listeners) listener();
}

function startOn(conn: StdbConnectionLike): void {
    if (startedOn === conn) return;
    // The provider's manager replaced the connection object: the old one is closed for good.
    // Its rows stay published until the new subscriptions have applied (no empty flash).
    stopCurrent?.();
    startedOn = conn;
    if (snapshot.error !== undefined) publish({ ...snapshot, error: undefined });

    const sources: { [K in Key]: KeylessTableLike<Rows[K][number]> } = {
        characters: conn.db.hsrCharacter,
        lightcones: conn.db.hsrLightcone,
        archetypes: conn.db.archetype,
        characterArchetypes: conn.db.hsrCharacterArchetype,
        costSets: conn.db.viewPublishedCostSets,
    };
    const keys = Object.keys(sources) as Key[];
    const applied = new Set<Key>();
    const dirty = new Set<Key>();
    let flushQueued = false;
    let stopped = false;

    // One read of the cache per table per burst: the initial result inserts every row one by one.
    const flush = () => {
        flushQueued = false;
        if (stopped || dirty.size === 0) return;
        const next: Snapshot = { ...snapshot };
        for (const key of dirty) {
            // A source not applied yet on this connection keeps the previous connection's rows.
            if (applied.has(key)) (next as Record<Key, unknown>)[key] = [...sources[key].iter()];
        }
        dirty.clear();
        next.ready = snapshot.ready || applied.size === keys.length;
        publish(next);
    };
    const markDirty = (key: Key) => {
        dirty.add(key);
        if (!flushQueued) {
            flushQueued = true;
            queueMicrotask(flush);
        }
    };

    const callbacks = keys.map((key) => {
        const cb = () => markDirty(key);
        sources[key].onInsert(cb);
        sources[key].onDelete(cb);
        return { key, cb };
    });
    const handles: SubscriptionHandleLike[] = keys.map((key, i) =>
        conn
            .subscriptionBuilder()
            .onApplied(() => {
                applied.add(key);
                markDirty(key);
            })
            .onError((_ctx, error) => {
                if (stopped) return;
                const query = REFERENCE_QUERIES[i];
                console.error(`[stdb] reference subscription failed: ${query}`, error);
                if (snapshot.error === undefined) {
                    publish({
                        ...snapshot,
                        error: `${query}: ${error?.message ?? 'subscription failed'}`,
                    });
                }
            })
            .subscribe(REFERENCE_QUERIES[i] as string),
    );
    // hsr_character, hsr_lightcone, archetype and the cost-set view have primary keys: an
    // updated row arrives as an update.
    const updatables = [
        conn.db.hsrCharacter,
        conn.db.hsrLightcone,
        conn.db.archetype,
        conn.db.viewPublishedCostSets,
    ] as const;
    const updateKeys: Key[] = ['characters', 'lightcones', 'archetypes', 'costSets'];
    const updateCallbacks = updatables.map((table, i) => {
        const cb = () => markDirty(updateKeys[i] as Key);
        table.onUpdate(cb);
        return cb;
    });

    stopCurrent = () => {
        stopped = true;
        for (const { key, cb } of callbacks) {
            sources[key].removeOnInsert(cb);
            sources[key].removeOnDelete(cb);
        }
        updatables.forEach((table, i) => {
            const cb = updateCallbacks[i];
            if (cb) table.removeOnUpdate(cb);
        });
        for (const handle of handles) if (!handle.isEnded()) handle.unsubscribe();
    };
}

/** Starts the reference set on `conn` (once per session; a no-op when already running there). */
export function requestReferenceSet(conn: StdbConnectionLike): void {
    requested = true;
    startOn(conn);
}

/** Called for every new connection object: carries a started reference set over to it. */
export function resumeReferenceSet(conn: StdbConnectionLike): void {
    if (requested) startOn(conn);
}

/** Whether anything has asked for the reference set this session. */
export function isReferenceSetRequested(): boolean {
    return requested;
}

/** Test helper: forget the session's reference set. */
export function resetReferenceSetForTests(): void {
    stopCurrent?.();
    stopCurrent = null;
    startedOn = null;
    requested = false;
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
 * it is never stopped. Maps are rebuilt only when their row array changes.
 */
export function useReferenceSet() {
    const conn = useStdbConnection();
    useEffect(() => {
        if (conn) requestReferenceSet(conn);
    }, [conn]);

    const rows = useSyncExternalStore(subscribe, () => snapshot);
    const { characters, lightcones, archetypes, characterArchetypes } = rows;

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

    return {
        ...rows,
        characterByName,
        lightconeByName,
        archetypeById,
        archetypeIdsByCharacter,
    };
}
