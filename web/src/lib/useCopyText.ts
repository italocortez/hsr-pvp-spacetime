import { useCallback, useEffect, useRef, useState } from 'react';

export type CopyState = 'idle' | 'copied' | 'failed';

/** How long the "Copied!" / "Copy failed" state stays (the mockup's 2s). */
export const COPY_FEEDBACK_MS = 2000;

/** The last message announced on the page: a repeat gets a no-break space so it is read again. */
let lastMessage = '';

/**
 * Shared since S14.4c (the landing page's Discord pill and the lobby placeholder's join code); it lived in
 * `pages/landing/` before.
 *
 * Copies one fixed text with the Async Clipboard API (web-guidance `copy-button.md`): the state
 * drives the button's look, `message` fills the page's live region. A refused or missing
 * clipboard is the failure state, shown and announced like a success. A repeat click restarts
 * the timer; the button is never disabled. No `execCommand` fallback: the site is served over
 * HTTPS, where the API exists (the guide's "last resort" is for hosts we do not control).
 */
export function useCopyText(text: string, messages: { copied: string; failed: string }) {
    const [state, setState] = useState<CopyState>('idle');
    const [message, setMessage] = useState('');
    const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const run = useRef(0);

    useEffect(() => () => clearTimeout(timer.current), []);

    const report = useCallback(
        (ok: boolean) => {
            clearTimeout(timer.current);
            let next = ok ? messages.copied : messages.failed;
            if (next === lastMessage) next += ' ';
            lastMessage = next;
            setState(ok ? 'copied' : 'failed');
            setMessage(next);
            timer.current = setTimeout(() => {
                setState('idle');
                setMessage('');
            }, COPY_FEEDBACK_MS);
        },
        [messages.copied, messages.failed],
    );

    const copy = useCallback(async () => {
        const id = ++run.current;
        let ok = true;
        try {
            await navigator.clipboard.writeText(text);
        } catch {
            ok = false;
        }
        // A later click has started its own copy: its outcome is the one to show.
        if (id === run.current) report(ok);
    }, [text, report]);

    return { state, message, copy };
}
