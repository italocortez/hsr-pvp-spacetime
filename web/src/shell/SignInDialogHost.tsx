import { useNavigate, useRouterState } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '@/auth/authStore';
import { loginSearchFor } from '@/auth/loginSearch';
import {
    closeSignInDialog,
    loadedSignInDialog,
    loadSignInDialog,
    type SignInDialogType,
    useSignInDialogState,
} from '@/pages/sign-in/signInDialogState';

/**
 * The sign-in dialog's place in the shell (S14.4b): rendered while the bar's "Sign in" has opened it. The dialog is
 * its own chunk (with the shared Dialog), preloaded when the browser is idle after the bar first shows "Sign in", so
 * the first click usually finds it in. Until it is in, nothing shows, and the dialog then opens once (one element,
 * one entrance, one focus placement). If the chunk fails to load, the click follows the link it is: the full-screen
 * sign-in panel, whose own loader has a failure screen. It lives inside the shell, so a splash (sign-in panel,
 * offline, maintenance, suspended) replaces it with everything else. A viewer who turns into a member while it is
 * open (a link finished in another tab) has nothing to sign in to: it closes.
 */
export function SignInDialogHost() {
    const { open, trigger } = useSignInDialogState();
    const auth = useAuth();
    const member = auth.user !== undefined && !auth.user.isGuest;
    const [Loaded, setLoaded] = useState<SignInDialogType | undefined>(loadedSignInDialog);
    // Preloaded after the shell mounted: read at render, so the first open is already the dialog.
    const Ready = Loaded ?? loadedSignInDialog();
    const navigate = useNavigate();

    useEffect(() => {
        if (open && member) closeSignInDialog();
    }, [open, member]);

    // Another page (the browser's back button) or a splash in place of the shell: the dialog does not wait for the
    // shell to come back.
    const pathname = useRouterState({ select: (s) => s.location.pathname });
    const href = useRouterState({ select: (s) => s.location.href });
    const page = useRef(href);
    page.current = href;
    const shownOn = useRef(pathname);
    useEffect(() => {
        if (shownOn.current === pathname) return;
        shownOn.current = pathname;
        closeSignInDialog();
    }, [pathname]);
    useEffect(() => () => closeSignInDialog(), []);

    useEffect(() => {
        if (!open || Ready) return;
        let live = true;
        loadSignInDialog().then(
            (component) => {
                if (live) setLoaded(() => component);
            },
            () => {
                if (!live) return;
                // The link's own destination: the full-screen panel, coming back to this page.
                closeSignInDialog();
                void navigate({ to: '/', search: loginSearchFor(page.current) });
            },
        );
        return () => {
            live = false;
        };
    }, [open, Ready, navigate]);

    if (!open || member || !Ready) return null;
    return <Ready onClose={closeSignInDialog} trigger={trigger} />;
}
