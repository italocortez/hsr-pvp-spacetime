import { MAINTENANCE_REFUSAL, retryConnection, setConnectionStatus } from '@/stdb/connectionStatus';

/*
 * Dev only (imported behind `import.meta.env.DEV` in main.tsx): forces a connection status from
 * the console to check the splashes. The live connection keeps running; its next event (or
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
} as const;

declare global {
    interface Window {
        __devConnection?: (state: keyof typeof STATES) => void;
    }
}

export function installDevConnection(): void {
    window.__devConnection = (state) => STATES[state]();
}
