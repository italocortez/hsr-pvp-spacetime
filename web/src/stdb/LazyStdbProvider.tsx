import { type ComponentType, type ReactNode, useEffect, useState } from 'react';
import { StdbConnectionContext, useStdbConnection } from './connectionContext';
import { failConnection } from './connectionStatus';
import type { StdbConnectionLike } from './types';

/*
 * The entry point of the connection layer (S14.1, A171 item 2): the app renders at once, and the
 * SpacetimeDB SDK, the generated bindings and the connection code (`StdbProvider.tsx` and what it
 * imports) load in their own chunk after the first render. This file and `connectionContext.ts`
 * import no SDK code, so the entry chunk carries none.
 *
 * The tree stays stable: the app always sits under one `StdbConnectionContext.Provider` here, and
 * `StdbProvider` (the maintenance gate, the SDK provider, `ConnectionScope` with Layer 0) is
 * rendered BESIDE it once loaded, with a reporter as its only child that hands the scope's
 * connection up. So the app mounts once per page load, as before; it sees the connection one
 * commit after `ConnectionScope` does. Until the chunk arrives the status is `connecting` and the
 * auth store not ready: public routes render, guarded routes wait, as during a slow connect.
 */

type ProviderModule = { StdbProvider: ComponentType<{ children?: ReactNode }> };

/** The connection chunk. Tests pass their own loader (no SDK, no socket). */
export const loadStdbProvider = (): Promise<ProviderModule> => import('./StdbProvider');

export function LazyStdbProvider({
    children,
    load = loadStdbProvider,
}: {
    children?: ReactNode;
    load?: () => Promise<ProviderModule>;
}) {
    const [Provider, setProvider] = useState<ProviderModule['StdbProvider'] | null>(null);
    const [connection, setConnection] = useState<StdbConnectionLike | null>(null);

    useEffect(() => {
        let live = true;
        load().then(
            (module) => {
                if (live) setProvider(() => module.StdbProvider);
            },
            (error: unknown) => {
                // The chunk did not load (network, a deploy replaced it): the offline splash, and
                // its Retry reloads the page, which fetches the current chunk names.
                if (live) failConnection(error, 'reload');
            },
        );
        return () => {
            live = false;
        };
    }, [load]);

    return (
        <>
            {Provider ? (
                <Provider>
                    <ReportConnection report={setConnection} />
                </Provider>
            ) : null}
            <StdbConnectionContext.Provider value={connection}>
                {children}
            </StdbConnectionContext.Provider>
        </>
    );
}

/** Inside the loaded provider: hands the scope's current connection up (null when it goes). */
function ReportConnection({ report }: { report: (c: StdbConnectionLike | null) => void }) {
    const connection = useStdbConnection();
    useEffect(() => {
        report(connection);
    }, [connection, report]);
    useEffect(() => () => report(null), [report]);
    return null;
}
