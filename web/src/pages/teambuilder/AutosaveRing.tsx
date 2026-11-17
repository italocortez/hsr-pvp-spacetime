import type { AutosaveStatus, BlockReason } from '@shared/loadouts';
import { type CSSProperties, useState } from 'react';
import styles from './AutosaveRing.module.css';
import { CheckIcon } from './TeamBuilderIcons';

/*
 * The autosave ring (S14.3c; DECISIONS.md A194 item 5, the user's "small filling white donut"): beside the account
 * loadout's name. It fills over the wait before the save (60 s after the last edit, sooner when the 5 minute
 * ceiling comes first) and starts again on each edit; "Saving…" while the save flies; a check with "Auto saved"
 * once the server copy matches; "Not saved yet" while a draft waits, with the reason beside it.
 *
 * The ring itself is decorative (CSS: a conic gradient through a round mask, filled by animating a registered
 * custom property); the state is the text next to it, which every state shows, in a box of fixed height so nothing
 * moves when it changes. Under reduced motion the ring does not fill: the empty ring and the text show the wait.
 * Announcements are the page's (polite, on a change of state, never on the wait).
 */

export const RING_TEXT = {
    waiting: 'Saving soon',
    saving: 'Saving…',
    autoSaved: 'Auto saved',
    saved: 'Saved to your account',
    blocked: 'Not saved yet',
} as const;

/** Why a draft waits, as the page says it. A server text, when there is one, is used as it is. */
export function reasonText(reason: BlockReason, message: string | null): string {
    if (message) return message;
    switch (reason) {
        case 'offline':
            return 'No connection. Your changes are kept in this browser and saved when the connection is back.';
        case 'too-fast':
        case 'queued':
            return 'Many saves in a short time. Your changes are kept and saved in a moment.';
        case 'full':
            return 'Your account already holds 10 loadouts. Delete one to save this one.';
        case 'refused':
            return 'The server did not take this loadout. Your changes are kept in this browser.';
        case 'conflict':
            return 'Changed on another device too. Choose which copy to keep.';
        case 'deleted':
            return 'Deleted on another device. Choose what to do with your changes.';
        case 'retired':
            return 'This loadout cannot be saved again. Save it as a new loadout.';
        case 'server-error':
            return 'The server could not save this. Trying again in a moment.';
        case 'server-stopped':
            return 'The server could not save this. It is tried again after your next change or when the connection comes back.';
        case 'other-tab':
            return 'Being changed in another tab of this browser. That tab saves it.';
    }
}

export function AutosaveRing({ status, reasonId }: { status: AutosaveStatus; reasonId: string }) {
    if (status.kind === 'saved') {
        return (
            <span className={styles.wrap} data-state="saved">
                <CheckIcon className={styles.check} />
                <span className={styles.label}>
                    {status.everSaved ? RING_TEXT.autoSaved : RING_TEXT.saved}
                </span>
            </span>
        );
    }
    if (status.kind === 'saving') {
        return (
            <span className={styles.wrap} data-state="saving">
                <span className={styles.ring} data-full="" aria-hidden="true" />
                <span className={styles.label}>{RING_TEXT.saving}</span>
            </span>
        );
    }
    if (status.kind === 'blocked') {
        return (
            <span className={styles.wrap} data-state="blocked">
                <span className={styles.ring} aria-hidden="true" />
                <span className={styles.label}>{RING_TEXT.blocked}</span>
                <span id={reasonId} className={styles.reason}>
                    {reasonText(status.reason, status.message)}
                </span>
            </span>
        );
    }
    // Waiting: one wait is one element (keyed by its start and due time); a new edit is a new wait.
    return (
        <span className={styles.wrap} data-state="waiting">
            <RingFill key={`${status.from}-${status.due}`} from={status.from} due={status.due} />
            <span className={styles.label}>{RING_TEXT.waiting}</span>
        </span>
    );
}

/**
 * The fill on the scheduler's clock (fix pass, review S2): the animation runs over the whole wait (`due - from`)
 * and starts where the wait stands when the element mounts (a negative delay of the time already gone). Both are
 * worked out once per wait, so a re-render (a pool search, a filter) writes the same values and the fill never
 * jumps or fills early.
 */
function RingFill({ from, due }: { from: number; due: number }) {
    const [style] = useState(() => {
        const total = Math.max(1, due - from);
        const gone = Math.min(total, Math.max(0, Date.now() - from));
        return { '--ring-ms': `${total}ms`, '--ring-delay': `-${gone}ms` } as CSSProperties;
    });
    return <span className={styles.ring} data-fill="" aria-hidden="true" style={style} />;
}
