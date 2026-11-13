import { ConnectionSplash } from '@/components/ConnectionSplash/ConnectionSplash';
import { useDocumentTitle } from '@/lib/useDocumentTitle';

/** The module refused the connection: maintenance mode (shown in place of every route). */
export function MaintenancePage({ onRetry }: { onRetry: () => void }) {
    useDocumentTitle('Under maintenance — IPC Battlegrounds');

    return (
        <ConnectionSplash
            eyebrow="Status // Maintenance"
            hudLabel="SYS://MAINTENANCE"
            hudCoord="Sector 00 · Maintenance"
            title={
                <>
                    Under <em>maintenance.</em>
                </>
            }
            // The module's own text for a refused action (MAINTENANCE_TEXT, docs/admin/architecture.md).
            lede="The site is in maintenance. Please try again later."
            onRetry={onRetry}
        />
    );
}
