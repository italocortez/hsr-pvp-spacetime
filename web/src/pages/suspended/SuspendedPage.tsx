import { useEffect } from 'react';
import { IpcActionButton } from '@/components/IpcButton/IpcButton';
import { SplashLayout } from '@/components/SplashLayout/SplashLayout';
import { useDocumentTitle } from '@/lib/useDocumentTitle';

const IMAGE = { src: '/standby.webp', width: 1920, height: 1080 };

/** The page's words (docs/frontend/pages.md "Suspended (SUS2)"): no date, no reason, no staff name. */
export const SUSPENDED_TEXT = {
    title: 'Account suspended',
    body: 'This account is suspended. You cannot use the site with it.',
    signOut: 'Sign out',
} as const;

/**
 * The viewer's account is suspended (SUS2, A213, A214): shown in place of every route, outside the
 * shell, by `SuspensionGate`. One action, "Sign out" (A214 item 4), which makes the browser a
 * visitor again. The screen usually replaces a page the viewer was using, whose focused control is
 * gone: focus moves to the heading (no scroll), as the route announcer does after a navigation.
 */
export function SuspendedPage({ onSignOut }: { onSignOut: () => void }) {
    useDocumentTitle('Account suspended — IPC Battlegrounds');

    useEffect(() => {
        const heading = document.querySelector<HTMLElement>('main h1');
        if (!heading) return;
        if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
        heading.focus({ preventScroll: true });
    }, []);

    return (
        <SplashLayout
            image={IMAGE}
            brandLink={false}
            eyebrow="Status // Suspended"
            title={
                <>
                    Account <em>suspended</em>
                </>
            }
            lede={SUSPENDED_TEXT.body}
            action={<IpcActionButton onClick={onSignOut}>{SUSPENDED_TEXT.signOut}</IpcActionButton>}
        />
    );
}
