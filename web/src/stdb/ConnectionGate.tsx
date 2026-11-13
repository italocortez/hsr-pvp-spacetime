import type { ReactNode } from 'react';
import { MaintenancePage } from '@/pages/connection/MaintenancePage';
import { OfflinePage } from '@/pages/connection/OfflinePage';
import { retryConnection, useConnectionStatus } from './connectionStatus';

/**
 * The root layout body: the routes, or a full-page splash once the connection has failed.
 * `connecting` and `reconnecting` block nothing (guarded routes wait on the auth store).
 */
export function ConnectionGate({ children }: { children?: ReactNode }) {
    const status = useConnectionStatus();
    if (status.state !== 'failed') return children;
    return status.kind === 'maintenance' ? (
        <MaintenancePage onRetry={retryConnection} />
    ) : (
        <OfflinePage onRetry={retryConnection} />
    );
}
