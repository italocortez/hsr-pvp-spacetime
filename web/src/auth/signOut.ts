import { resolveBrowserEnv } from '@shared/stdb-targets';
import { deleteStoredToken } from '@/stdb/connection';

/**
 * Signs out (M5b; no UI yet, the app shell step adds it): forgets the stored SpacetimeDB token
 * and reloads, so the next connection is a new anonymous identity. The account itself is not
 * touched; signing in again goes through Discord.
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
