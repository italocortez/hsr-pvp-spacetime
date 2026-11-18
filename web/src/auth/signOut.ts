import { resolveBrowserEnv } from '@shared/stdb-targets';
import { deleteStoredToken } from '@/stdb/tokenStorage';

/**
 * Signs out (M5b; called from the account menu in the bar, S14.1): forgets the stored SpacetimeDB
 * token and reloads, so the next connection is a new anonymous identity. The account itself is
 * not touched; signing in again goes through Discord. The token helpers hold no SDK code, so this
 * is in the entry chunk and a click never waits on (or fails for) a chunk download.
 *
 * `to` (SUS2 fix pass, A214(4)): load that address instead of reloading the current one (the
 * suspended screen passes `/`). Without it the page reloads in place, as before.
 */
export function signOut({
    tokenStorageKey = resolveBrowserEnv(import.meta.env).tokenStorageKey,
    reload = () => window.location.reload(),
    to,
    assign = (href: string) => window.location.assign(href),
}: {
    tokenStorageKey?: string;
    reload?: () => void;
    to?: string;
    assign?: (href: string) => void;
} = {}): void {
    deleteStoredToken(tokenStorageKey);
    if (to === undefined) reload();
    else assign(to);
}
