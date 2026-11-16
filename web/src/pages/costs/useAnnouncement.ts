import { useEffect, useRef, useState } from 'react';

/**
 * The text for the page's one polite status region (S14.2).
 *
 * - `text` (the count): announced once it has held still for `delayMs`, so typing in the search
 *   announces the count once, not per key. The first value after `enabled` turns true is taken
 *   as the starting point and not announced (the route announcer has just read the page's
 *   title); later changes are.
 * - `notice` (the unknown-set fallback): announced as soon as it appears, apart from the count's
 *   starting point, so a hard load of a bad address says it too. Set after the first commit, so
 *   the region is already in the page when its text changes.
 */
export function useAnnouncement(
    text: string,
    enabled: boolean,
    notice = '',
    delayMs = 600,
): string {
    const [message, setMessage] = useState('');
    const baseline = useRef<string | null>(null);

    useEffect(() => {
        if (!enabled) return;
        if (baseline.current === null) {
            baseline.current = text;
            return;
        }
        if (text === baseline.current) return;
        const timer = setTimeout(() => {
            baseline.current = text;
            setMessage(text);
        }, delayMs);
        return () => clearTimeout(timer);
    }, [text, enabled, delayMs]);

    // The notice going away empties the region if it still holds the notice (a screen reader's
    // review of the region then finds nothing stale); a count announced since stays.
    const shownNotice = useRef('');
    useEffect(() => {
        if (notice !== '') {
            shownNotice.current = notice;
            setMessage(notice);
        } else if (shownNotice.current !== '') {
            const gone = shownNotice.current;
            shownNotice.current = '';
            setMessage((current) => (current === gone ? '' : current));
        }
    }, [notice]);

    return message;
}
