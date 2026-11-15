import { resolveBrowserEnv } from '@shared/stdb-targets';
import { deleteStoredToken } from '@/stdb/tokenStorage';

/**
 * Signs out (M5b; called from the account menu in the bar, S14.1): forgets the stored SpacetimeDB
 * token and reloads, so the next connection is a new anonymous identity. The account itself is
 * not touched; signing in again goes through Discord. The token helpers hold no SDK code, so this
 * is in the entry chunk and a click never waits on (or fails for) a chunk download.
 */
export function signOut({
    tokenStorageKey = resolveBrowserEnv(import.meta.env).tokenStorageKey,
    reload = () => window.location.reload(),
}: {
    tokenStorageKey?: string;
    reload?: () => void;
} = {}): void {
    deleteStoredToken(tokenStorageKey);
    reload();
}
