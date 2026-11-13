import { createContext, useContext } from 'react';
import type { StdbConnectionLike } from './types';

/** The live connection for the hooks; provided by `ConnectionScope`. */
export const StdbConnectionContext = createContext<StdbConnectionLike | null>(null);

let current: StdbConnectionLike | null = null;

/** The current connection, outside React (the dev egress meter). */
export function getCurrentConnection(): StdbConnectionLike | null {
    return current;
}

/** Set by `ConnectionScope` only. */
export function setCurrentConnection(conn: StdbConnectionLike | null): void {
    current = conn;
}

/** The current connection, or null before the provider has built one. */
export function useStdbConnection(): StdbConnectionLike | null {
    return useContext(StdbConnectionContext);
}
