import { MAINTENANCE_REFUSAL, retryConnection, setConnectionStatus } from '@/stdb/connectionStatus';
import { setSuspended } from '@/stdb/suspensionStatus';

/*
 * Dev only (imported behind `import.meta.env.DEV` in main.tsx): forces a connection status (or,
 * SUS2, the suspension flag) from the console to check the splashes. The live connection keeps running; its next event (or
 * `'retry'`) replaces the forced state.
 */

const STATES = {
    connecting: () => setConnectionStatus({ state: 'connecting' }),
    connected: () => setConnectionStatus({ state: 'connected' }),
    reconnecting: () => setConnectionStatus({ state: 'reconnecting', reason: 'forced (dev)' }),
    offline: () =>
        setConnectionStatus({
            state: 'failed',
            kind: 'offline',
            reason: 'forced (dev)',
            recovery: 'retry',
        }),
    maintenance: () =>
        setConnectionStatus({
            state: 'failed',
            kind: 'maintenance',
            reason: MAINTENANCE_REFUSAL,
            recovery: 'retry',
        }),
    retry: retryConnection,
    // SUS2: the suspended page without a real suspension; `lifted` takes it down. The next
    // `view_my_suspension` event of the live connection replaces the forced flag.
    suspended: () => setSuspended(true),
    lifted: () => setSuspended(false),
} as const;

declare global {
    interface Window {
        __devConnection?: (state: keyof typeof STATES) => void;
    }
}

export function installDevConnection(): void {
    window.__devConnection = (state) => STATES[state]();
}
