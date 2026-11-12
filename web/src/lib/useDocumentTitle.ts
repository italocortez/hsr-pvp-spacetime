import { useEffect } from 'react';

/** Sets `document.title` while the calling page is mounted (SPA titles, WCAG 2.4.2). */
export function useDocumentTitle(title: string): void {
    useEffect(() => {
        document.title = title;
    }, [title]);
}
