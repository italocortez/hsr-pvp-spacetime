import { ErrorSplash } from '@/components/ErrorSplash/ErrorSplash';
import { useDocumentTitle } from '@/lib/useDocumentTitle';

/** A signed-in user without the role for this area (shown in place, the URL stays). */
export function NoAccessPage() {
    useDocumentTitle('Access denied — IPC Battlegrounds');

    return (
        <ErrorSplash
            code="403"
            hudLabel="SYS://RESTRICTED"
            hudCoord="Sector 00 · Restricted"
            title={
                <>
                    Access <em>denied.</em>
                </>
            }
            lede="This area is for IPC staff. If you think this is a mistake, contact an admin."
        />
    );
}
