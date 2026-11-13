import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { ConnectionScope } from './ConnectionScope';
import { failConnection, useConnectionGeneration, useConnectionStatus } from './connectionStatus';
import { fetchMaintenance, maintenanceSkipped } from './statusFile';
import type { StdbConnectionLike } from './types';

/*
 * Reads the maintenance status file (`statusFile.ts`) and decides whether a connection may exist.
 *
 * Tree: one permanent `ConnectionScope` wraps the app and never changes type, so the app mounts
 * once per page load. The connector (the SDK provider in the app, a test double in tests) is
 * rendered beside it only while the gate is open, and hands its connection up through `report`.
 *
 * Reads:
 * - Page load and every Retry click (new generation): read at once, aborting a read in flight.
 *   On the maintenance splash that read decides whether to connect; on the offline splash it runs
 *   in parallel with the rebuild, so maintenance shows without waiting for the timer.
 * - Gate closed and the status not `failed` without a Retry click: if a `true` answer closed it in
 *   this generation (a late SDK event moved the status), show maintenance again without a read;
 *   otherwise read once the minimum gap allows, so the app never sits with no splash and no
 *   connection.
 * - Gate open and the connection in trouble (`reconnecting`, or `failed` but not maintenance),
 *   per episode (from the change into trouble until it ends): see the trouble effect below. A tab
 *   that was connected when maintenance began keeps `reconnecting` (the SDK retries inside the
 *   connection), so this is how it finds out. Hidden tabs wait until visible. Recovery stops the
 *   timer and aborts a trouble read in flight.
 * - At most one read in flight. A read that was aborted or replaced is ignored when it lands.
 *
 * Answer `true`: status `failed`/`maintenance` (the root shows the maintenance splash) and the
 * connector unmounts, which releases the SDK provider's manager and disconnects (no socket, no
 * rebuilds, no reconnect loop). Answer `false`: the gate opens; while reconnecting nothing visible
 * changes. `?maintenance=skip` (statusFile.ts) opens it without reading.
 */

const MAINTENANCE_REASON = 'Maintenance (status file)';

/** Orchestrator's choices (M7 fix pass): re-read period while in trouble, minimum gap. */
export const RECHECK_MS = 60_000;
export const MIN_GAP_MS = 30_000;

type Report = (connection: StdbConnectionLike | null) => void;
type ReadKind = 'retry' | 'gate' | 'trouble';

export function MaintenanceGate({
    children,
    connector,
    readStatus = (signal) => fetchMaintenance(undefined, undefined, signal),
}: {
    children?: ReactNode;
    /** Builds the connection and reports it (null when it goes); rendered only while open. */
    connector: (report: Report) => ReactNode;
    /** Resolves true for maintenance; never rejects. Tests pass a stub (no network). */
    readStatus?: (signal: AbortSignal) => Promise<boolean>;
}) {
    const generation = useConnectionGeneration();
    const status = useConnectionStatus();
    const [open, setOpen] = useState(false);
    const [reading, setReading] = useState(false);
    // Bumped when a read lands: the re-read timer schedules the next one even when `reading`
    // went true and false within one render.
    const [settled, setSettled] = useState(0);
    const [connection, setConnection] = useState<StdbConnectionLike | null>(null);

    const inFlight = useRef<{ controller: AbortController; kind: ReadKind } | null>(null);
    const lastReadAt = useRef(Number.NEGATIVE_INFINITY);
    const seenGeneration = useRef<number | null>(null);
    /** The generation in which a `true` answer closed the gate (null: not closed by an answer). */
    const closedGeneration = useRef<number | null>(null);
    const currentGeneration = useRef(generation);
    currentGeneration.current = generation;
    /** The current trouble episode: from the change into trouble until it ends. */
    const episode = useRef<{ start: number; reads: number; readWhileFailed: boolean } | null>(null);
    const read = useRef(readStatus);
    read.current = readStatus;

    // Hidden tabs skip the periodic trouble re-read until they are visible again.
    const [hidden, setHidden] = useState(() => globalThis.document?.hidden === true);
    useEffect(() => {
        const update = () => setHidden(document.hidden);
        document.addEventListener('visibilitychange', update);
        return () => document.removeEventListener('visibilitychange', update);
    }, []);

    const abortRead = useCallback(() => {
        inFlight.current?.controller.abort();
        inFlight.current = null;
        setReading(false);
    }, []);

    const startRead = useCallback((kind: ReadKind) => {
        if (maintenanceSkipped()) {
            setOpen(true);
            return;
        }
        if (inFlight.current) {
            if (kind !== 'retry') return;
            inFlight.current.controller.abort();
        }
        const entry = { controller: new AbortController(), kind };
        inFlight.current = entry;
        lastReadAt.current = Date.now();
        setReading(true);
        void read.current(entry.controller.signal).then((maintenance) => {
            // Aborted, replaced or unmounted since: a stale answer changes nothing.
            if (inFlight.current !== entry) return;
            inFlight.current = null;
            setReading(false);
            setSettled((n) => n + 1);
            if (maintenance) {
                closedGeneration.current = currentGeneration.current;
                failConnection(new Error(MAINTENANCE_REASON), 'retry', 'maintenance');
                setOpen(false);
            } else setOpen(true);
        });
    }, []);

    // Page load and every Retry click: read at once (the generation counts Retry clicks).
    useEffect(() => {
        if (seenGeneration.current === generation) return;
        seenGeneration.current = generation;
        startRead('retry');
    }, [generation, startRead]);

    // Gate closed and not on a splash, without a Retry click. Closed by a `true` answer in this
    // generation (a late SDK event moved the status): show maintenance again, no read. Otherwise
    // read once the gap allows.
    useEffect(() => {
        if (open || status.state === 'failed') return;
        if (closedGeneration.current === generation) {
            failConnection(new Error(MAINTENANCE_REASON), 'retry', 'maintenance');
            return;
        }
        if (reading) return;
        const delay = Math.max(0, MIN_GAP_MS - (Date.now() - lastReadAt.current));
        const timer = setTimeout(() => startRead('gate'), delay);
        return () => clearTimeout(timer);
    }, [open, status, generation, reading, startRead]);

    // Gate open and the connection in trouble (one episode from the change into trouble until it
    // ends). `failed`: read once MIN_GAP_MS has passed since the previous read. `reconnecting`:
    // the first read MIN_GAP_MS after the episode began (a short blip reads nothing), and not
    // sooner than MIN_GAP_MS after the previous read. Then every RECHECK_MS while it lasts,
    // whatever the reason text does; a change to `failed` inside the episode may read once more
    // as soon as the gap allows. Hidden tabs wait until visible.
    const trouble =
        status.state === 'reconnecting' ||
        (status.state === 'failed' && status.kind !== 'maintenance');
    useEffect(() => {
        if (open && trouble) {
            episode.current ??= { start: Date.now(), reads: 0, readWhileFailed: false };
        } else episode.current = null;
    }, [open, trouble]);
    const failedNow = status.state === 'failed';
    // biome-ignore lint/correctness/useExhaustiveDependencies: `settled` re-arms the timer after each read
    useEffect(() => {
        const ep = episode.current;
        if (!open || !trouble || !ep || reading || hidden || maintenanceSkipped()) return;
        let due: number;
        if (failedNow && !ep.readWhileFailed) due = lastReadAt.current + MIN_GAP_MS;
        else if (ep.reads === 0) due = Math.max(ep.start, lastReadAt.current) + MIN_GAP_MS;
        else due = lastReadAt.current + RECHECK_MS;
        const timer = setTimeout(
            () => {
                ep.reads++;
                if (failedNow) ep.readWhileFailed = true;
                startRead('trouble');
            },
            Math.max(0, due - Date.now()),
        );
        return () => clearTimeout(timer);
    }, [open, trouble, failedNow, reading, hidden, startRead, settled]);

    // Recovered: a trouble read still in flight is stale (a Retry read keeps going).
    useEffect(() => {
        if (open && !trouble && inFlight.current?.kind === 'trouble') abortRead();
    }, [open, trouble, abortRead]);

    // Unmount: abort and forget a read in flight (deferred, so StrictMode's remount keeps it).
    const mounted = useRef(false);
    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
            queueMicrotask(() => {
                if (mounted.current) return;
                inFlight.current?.controller.abort();
                inFlight.current = null;
            });
        };
    }, []);

    return (
        <>
            {open ? connector(setConnection) : null}
            <ConnectionScope connection={open ? connection : null}>{children}</ConnectionScope>
        </>
    );
}
