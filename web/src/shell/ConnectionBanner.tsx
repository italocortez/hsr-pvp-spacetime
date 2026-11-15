import { useEffect, useState } from 'react';
import { useConnectionStatus } from '@/stdb/connectionStatus';
import styles from './ConnectionBanner.module.css';

/** A drop shorter than this shows nothing (orchestrator's choice, S14.1). */
export const RECONNECTING_NOTICE_MS = 2000;

/**
 * True once the connection has been `reconnecting` for `delayMs` without a break; false again on
 * recovery (or any other state). The first `connecting` never counts.
 */
export function useReconnectingNotice(delayMs: number = RECONNECTING_NOTICE_MS): boolean {
    const reconnecting = useConnectionStatus().state === 'reconnecting';
    const [due, setDue] = useState(false);
    useEffect(() => {
        setDue(false);
        if (!reconnecting) return;
        const timer = setTimeout(() => setDue(true), delayMs);
        return () => clearTimeout(timer);
    }, [reconnecting, delayMs]);
    return reconnecting && due;
}

/**
 * The slim "Reconnecting…" line under the bar (S14.1, wording the orchestrator's). Non-blocking:
 * the page stays usable under it. The polite live region is always present, so the text is
 * announced when it appears; the offline and maintenance splashes are separate (ConnectionGate).
 */
export function ConnectionBanner() {
    const show = useReconnectingNotice();
    return (
        <div className={styles.region} aria-live="polite" data-connection-banner="">
            {show && <p className={styles.banner}>{'Reconnecting…'}</p>}
        </div>
    );
}
