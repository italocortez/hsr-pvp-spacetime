import { ConnectionSplash } from '@/components/ConnectionSplash/ConnectionSplash';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import { pageReload } from '@/stdb/connectionStatus';

/**
 * A page's code chunk did not load (S14.1: the sign-in panel's chunk, from the `/` route's
 * loader): the offline splash with the load line (orchestrator's wording) and a Retry that
 * reloads the page, which fetches the current chunk names, as for the connection chunk.
 * It lives in the entry chunk, so it can render while the network is down.
 */
export function LoadFailedPage() {
    useDocumentTitle('Connection lost — IPC Battlegrounds');

    return (
        <ConnectionSplash
            eyebrow="Error // Offline"
            hudLabel="SYS://OFFLINE"
            hudCoord={'Sector 00 · Offline'}
            title={
                <>
                    Connection <em>lost.</em>
                </>
            }
            lede="The page could not be loaded. Check your connection and try again."
            onRetry={() => pageReload.run()}
        />
    );
}
