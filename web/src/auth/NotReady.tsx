import { useDocumentTitle } from '@/lib/useDocumentTitle';

/** Neutral title for a guarded layout that renders nothing yet (the previous page's would stay). */
export const NEUTRAL_TITLE = 'IPC Battlegrounds';

/**
 * What a guarded layout renders while auth is not ready, or for the one render without a user
 * before the sign-in redirect lands: nothing (the void background) under a neutral title.
 */
export function NotReady() {
    useDocumentTitle(NEUTRAL_TITLE);
    return null;
}
