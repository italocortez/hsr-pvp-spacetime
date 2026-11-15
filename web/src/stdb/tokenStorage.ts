/*
 * The stored SpacetimeDB token (one `localStorage` key per target database). No SDK import: the
 * connection builder (`connection.ts`, in the SDK chunk) and sign-out (`auth/signOut.ts`, in the
 * entry chunk, S14.1) both use these, and sign-out must not wait on a chunk to forget the token.
 */

/** The stored SDK token, or undefined (none yet, empty, or storage blocked). */
export function readStoredToken(key: string): string | undefined {
    try {
        return globalThis.localStorage?.getItem(key) || undefined;
    } catch {
        return undefined;
    }
}

/** Saves the SDK token (never an empty one); a blocked storage only costs the identity next visit. */
export function storeToken(key: string, token: string | undefined): void {
    if (!token) return;
    try {
        globalThis.localStorage?.setItem(key, token);
    } catch {
        // Storage blocked (private window, site data off): the app keeps working this session.
    }
}

/** Forgets the stored SDK token (the next connection is a new anonymous identity). */
export function deleteStoredToken(key: string): void {
    try {
        globalThis.localStorage?.removeItem(key);
    } catch {
        // Storage blocked: nothing was stored either.
    }
}
