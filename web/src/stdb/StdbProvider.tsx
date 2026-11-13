import type { DbConnection } from '@bindings/index';
import { resolveBrowserEnv } from '@shared/stdb-targets';
import type { ReactNode } from 'react';
import { useEffect, useMemo } from 'react';
import { SpacetimeDBProvider, useSpacetimeDB } from 'spacetimedb/react';
import { createConnectionBuilder } from './connection';
import { useConnectionGeneration } from './connectionStatus';
import { MaintenanceGate } from './MaintenanceGate';
import type { StdbConnectionLike } from './types';

type Report = (connection: StdbConnectionLike | null) => void;

/**
 * The connection for the app (main.tsx only; tests mount `ConnectionScope` or `MaintenanceGate`
 * with the mock connection instead, so no test opens a socket).
 *
 * `MaintenanceGate` keeps one permanent `ConnectionScope` around the app and renders the SDK's
 * React provider BESIDE it (not around it), only once the status file has said "not in
 * maintenance"; the provider hands its connection up. So the app never remounts when the provider
 * comes or goes. Consequence: the SDK's own React hooks (`useTable`, `useReducer`,
 * `useSpacetimeDB`) have no provider above the app; the app uses `useStdbConnection` and the
 * hooks in this folder instead. This file is the only importer of `spacetimedb/react`.
 *
 * The provider retains one connection per host and database, survives StrictMode's double mount,
 * forces automatic reconnection and replays subscriptions; when the SDK will not retry (a failed
 * first connection) its manager rebuilds the connection object with backoff. Retry
 * (`retryConnection`) bumps the generation: the provider gets a fresh builder, and when the
 * manager is between rebuilds the new builder connects at once (no page reload).
 */
export function StdbProvider({ children }: { children?: ReactNode }) {
    return (
        <MaintenanceGate connector={(report) => <LiveProvider report={report} />}>
            {children}
        </MaintenanceGate>
    );
}

function LiveProvider({ report }: { report: Report }) {
    const generation = useConnectionGeneration();
    // biome-ignore lint/correctness/useExhaustiveDependencies: a new builder per Retry generation
    const builder = useMemo(
        () => createConnectionBuilder(resolveBrowserEnv(import.meta.env)),
        [generation],
    );

    return (
        <SpacetimeDBProvider connectionBuilder={builder}>
            <ReportConnection report={report} />
        </SpacetimeDBProvider>
    );
}

/** Hands the provider's current connection object up; a rebuilt connection re-renders this. */
function ReportConnection({ report }: { report: Report }) {
    const { getConnection } = useSpacetimeDB();
    // The provider was given our builder, so the untyped connection is the generated `DbConnection`.
    const connection: StdbConnectionLike | null = getConnection() as DbConnection | null;
    useEffect(() => {
        report(connection);
        return () => report(null);
    }, [connection, report]);
    return null;
}
