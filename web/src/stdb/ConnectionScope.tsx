import { type ReactNode, useEffect } from 'react';
import {
    getCurrentConnection,
    StdbConnectionContext,
    setCurrentConnection,
} from './connectionContext';
import { startLayer0 } from './layer0';
import { resumeReferenceSet } from './referenceSet';
import type { StdbConnectionLike } from './types';

/**
 * Hands the live connection to the app: the context for the hooks (`useRouteSubscriptions`,
 * `useReferenceSet`), Layer 0 for the session, and a started reference set carried over when the
 * provider's manager replaces the connection object. Tests mount it with the mock connection.
 */
export function ConnectionScope({
    connection,
    children,
}: {
    connection: StdbConnectionLike | null;
    children?: ReactNode;
}) {
    useEffect(() => {
        setCurrentConnection(connection);
        if (!connection) return;
        const stopLayer0 = startLayer0(connection);
        resumeReferenceSet(connection);
        return () => {
            stopLayer0();
            if (getCurrentConnection() === connection) setCurrentConnection(null);
        };
    }, [connection]);

    return (
        <StdbConnectionContext.Provider value={connection}>
            {children}
        </StdbConnectionContext.Provider>
    );
}
