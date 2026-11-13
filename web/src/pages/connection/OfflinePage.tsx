import { ConnectionSplash } from '@/components/ConnectionSplash/ConnectionSplash';
import { useDocumentTitle } from '@/lib/useDocumentTitle';

/** The connection failed and the SDK is not retrying it (shown in place of every route). */
export function OfflinePage({ onRetry }: { onRetry: () => void }) {
    useDocumentTitle('Connection lost — IPC Battlegrounds');

    return (
        <ConnectionSplash
            eyebrow="Error // Offline"
            hudLabel="SYS://OFFLINE"
            hudCoord="Sector 00 · Offline"
            title={
                <>
                    Connection <em>lost.</em>
                </>
            }
            lede="The link to the IPC servers is down. Check your connection and try again."
            onRetry={onRetry}
        />
    );
}
