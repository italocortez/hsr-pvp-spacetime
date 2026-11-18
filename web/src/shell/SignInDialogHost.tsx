import { useRouterState } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '@/auth/authStore';
import { SignInDialogView } from '@/pages/sign-in/SignInDialogView';
import {
    closeSignInDialog,
    loadedSignInDialog,
    loadSignInDialog,
    type SignInDialogType,
    useSignInDialogState,
} from '@/pages/sign-in/signInDialogState';
import { SIGN_IN_DIALOG_TEXT } from '@/pages/sign-in/signInText';

const noop = () => {};

/**
 * The sign-in dialog's place in the shell (S14.4b): rendered while the bar's "Sign in" has opened it. The dialog is
 * its own chunk; until it arrives the same dialog shows as an inert frame (buttons that do nothing), and if the chunk
 * fails to load the frame says so with "Try again". It lives inside the shell, so a splash (sign-in panel, offline,
 * maintenance, suspended) replaces it with everything else. A viewer who turns into a member while it is open (a
 * link finished in another tab) has nothing to sign in to: it closes.
 */
export function SignInDialogHost() {
    const { open, trigger } = useSignInDialogState();
    const auth = useAuth();
    const member = auth.user !== undefined && !auth.user.isGuest;
    const [Loaded, setLoaded] = useState<SignInDialogType | undefined>(loadedSignInDialog);
    const [failed, setFailed] = useState(false);
    const [attempt, setAttempt] = useState(0);

    useEffect(() => {
        if (open && member) closeSignInDialog();
    }, [open, member]);

    // Another page (the browser's back button) or a splash in place of the shell: the dialog does not wait for the
    // shell to come back.
    const pathname = useRouterState({ select: (s) => s.location.pathname });
    const shownOn = useRef(pathname);
    useEffect(() => {
        if (shownOn.current === pathname) return;
        shownOn.current = pathname;
        closeSignInDialog();
    }, [pathname]);
    useEffect(() => () => closeSignInDialog(), []);

    // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is a retry of the load
    useEffect(() => {
        if (!open || Loaded) return;
        let live = true;
        setFailed(false);
        loadSignInDialog().then(
            (component) => {
                if (live) setLoaded(() => component);
            },
            () => {
                if (live) setFailed(true);
            },
        );
        return () => {
            live = false;
        };
    }, [open, Loaded, attempt]);

    if (!open || member) return null;
    if (Loaded) return <Loaded onClose={closeSignInDialog} trigger={trigger} />;
    return (
        <SignInDialogView
            view="choose"
            busy={false}
            disabled
            message={failed ? SIGN_IN_DIALOG_TEXT.loadFailed : undefined}
            onDiscord={noop}
            onGuest={noop}
            onClose={closeSignInDialog}
            returnFocus={trigger}
            onRetryLoad={failed ? () => setAttempt((n) => n + 1) : undefined}
        />
    );
}
