import type { DbConnection } from '@bindings/index';
import { resolveBrowserEnv } from '@shared/stdb-targets';
import type { ReactNode } from 'react';
import { useMemo } from 'react';
import { SpacetimeDBProvider, useSpacetimeDB } from 'spacetimedb/react';
import { ConnectionScope } from './ConnectionScope';
import { createConnectionBuilder } from './connection';
import { useConnectionGeneration } from './connectionStatus';
import type { StdbConnectionLike } from './types';

/**
 * The SDK's React provider around the app (main.tsx only; tests mount `ConnectionScope` with the
 * mock connection instead, so no test opens a socket). The provider retains one connection per
 * host and database, survives StrictMode's double mount, forces automatic reconnection and
 * replays subscriptions; when the SDK will not retry (a failed first connection) its manager
 * rebuilds the connection object with backoff.
 *
 * Retry (`retryConnection`) bumps the generation: the provider gets a fresh builder, and when the
 * manager is between rebuilds the new builder connects at once (no page reload).
 */
export function StdbProvider({ children }: { children?: ReactNode }) {
    const generation = useConnectionGeneration();
    // biome-ignore lint/correctness/useExhaustiveDependencies: a new builder per Retry generation
    const builder = useMemo(
        () => createConnectionBuilder(resolveBrowserEnv(import.meta.env)),
        [generation],
    );

    return (
        <SpacetimeDBProvider connectionBuilder={builder}>
            <LiveConnectionScope>{children}</LiveConnectionScope>
        </SpacetimeDBProvider>
    );
}

/** Reads the provider's current connection object; a rebuilt connection re-renders this. */
function LiveConnectionScope({ children }: { children?: ReactNode }) {
    const { getConnection } = useSpacetimeDB();
    // The provider was given our builder, so the untyped connection is the generated `DbConnection`.
    const connection: StdbConnectionLike | null = getConnection() as DbConnection | null;
    return <ConnectionScope connection={connection}>{children}</ConnectionScope>;
}
