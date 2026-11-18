import { useRouterState } from '@tanstack/react-router';
import { type MouseEvent, type ReactNode, useState } from 'react';
import { useAuth } from '@/auth/authStore';
import styles from './AppShell.module.css';
import { ConnectionBanner } from './ConnectionBanner';
import { NavBar } from './NavBar';
import { RouteAnnouncer } from './RouteAnnouncer';
import { SignInDialogHost } from './SignInDialogHost';
import { InShellContext } from './shellContext';
import { isSplashScreen } from './splash';

export const MAIN_ID = 'main';

/**
 * The app shell (S14.1), rendered by the root layout around every route: the skip link, the
 * navigation bar, the reconnecting banner and the one `main`. Splash screens (standby, sign-in,
 * not found, no access: `splash.ts`) render bare instead, with their own `main`; the offline and
 * maintenance splashes replace the whole tree one level up (`ConnectionGate`). The route
 * announcer stays mounted in both forms.
 */
export function AppShell({ children }: { children?: ReactNode }) {
    const auth = useAuth();
    const splash = useRouterState({ select: (s) => isSplashScreen(s.matches, auth) });
    // The phone menu's open panel height: the reconnecting line moves below it (S14.1b).
    const [menuInset, setMenuInset] = useState(0);

    return (
        <>
            {splash ? (
                children
            ) : (
                <InShellContext.Provider value={true}>
                    <a className={styles.skipLink} href={`#${MAIN_ID}`} onClick={skipToMain}>
                        Skip to main content
                    </a>
                    <NavBar auth={auth} onMenuInset={setMenuInset} />
                    <ConnectionBanner inset={menuInset} />
                    <main id={MAIN_ID} className={styles.main} tabIndex={-1}>
                        {children}
                    </main>
                    <SignInDialogHost />
                </InShellContext.Provider>
            )}
            <RouteAnnouncer />
        </>
    );
}

/** Moves focus to `main` without a history entry (a plain fragment jump would go through the router). */
function skipToMain(event: MouseEvent<HTMLAnchorElement>): void {
    event.preventDefault();
    document.getElementById(MAIN_ID)?.focus();
}
