import { useRouterState } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '@/auth/authStore';
import { type EnsureSignedInResult, useEnsureSignedIn } from '@/auth/useEnsureSignedIn';
import { useConnectionStatus } from '@/stdb/connectionStatus';
import { SignInDialogView } from './SignInDialogView';
import { SIGN_IN_DIALOG_TEXT, SIGN_IN_TEXT } from './signInText';
import { defaultSignInIo, type SignInIo, type SignInPhase, useSignIn } from './useSignIn';

export type SignInDialogProps = {
    /** The person closed it (Escape, the close button, "Enter Battlegrounds", a guest's "Continue as Guest"). */
    onClose: () => void;
    /** The control that opened it: focus goes back there. */
    trigger: HTMLElement | null;
    io?: SignInIo;
};

type Guest =
    | { kind: 'idle' }
    | { kind: 'creating' }
    | { kind: 'created' }
    | { kind: 'failed'; result: Exclude<EnsureSignedInResult, { kind: 'ready' }> };

/**
 * The sign-in dialog (S14.4b, A221 R1 and R2), opened by the bar's "Sign in" on every page: "Sign in with Discord"
 * starts the same flow as the full-screen panel (`useSignIn`; the browser leaves for Discord and comes back to the
 * panel at `/?login=1`, which then returns to this page), and "Continue as Guest" makes a visitor a guest
 * (`useEnsureSignedIn`, `login_as_guest`) and shows the guest's name from the profile view, with "Enter
 * Battlegrounds" to close. A guest who opens it sees their name and can still sign in with Discord. A member never
 * sees it (the host closes it if the profile turns into one). Its own chunk: it uses the generated bindings.
 */
export function SignInDialog({ onClose, trigger, io = defaultSignInIo }: SignInDialogProps) {
    const auth = useAuth();
    const connection = useConnectionStatus();
    const href = useRouterState({ select: (s) => s.location.href });
    const { phase, start } = useSignIn({ next: href, stay: true }, io);
    const ensureSignedIn = useEnsureSignedIn();
    const [guest, setGuest] = useState<Guest>({ kind: 'idle' });
    // Which button was pressed last: only its failure is shown.
    const [last, setLast] = useState<'discord' | 'guest' | null>(null);
    const alive = useRef(true);
    useEffect(() => {
        alive.current = true;
        return () => {
            alive.current = false;
        };
    }, []);

    const discordBusy = phase.kind === 'starting';
    const guestBusy = guest.kind === 'creating';
    const busy = discordBusy || guestBusy;
    const connected = connection.state === 'connected' && auth.ready;
    const user = auth.user;

    const onDiscord = () => {
        setLast('discord');
        start();
    };

    const onGuest = async () => {
        setLast('guest');
        setGuest({ kind: 'creating' });
        const result = await ensureSignedIn();
        if (!alive.current) return;
        setGuest(result.kind === 'ready' ? { kind: 'created' } : { kind: 'failed', result });
    };

    let message: string | undefined;
    if (guestBusy) message = SIGN_IN_DIALOG_TEXT.creatingGuest;
    else if (discordBusy) message = SIGN_IN_DIALOG_TEXT.openingDiscord;
    else if (!connected) message = SIGN_IN_DIALOG_TEXT.connecting;
    else if (last === 'guest' && guest.kind === 'failed') message = guestFailure(guest.result);
    else if (last === 'discord') message = discordFailure(phase);

    const created = guest.kind === 'created' && user?.isGuest === true;
    return (
        <SignInDialogView
            view={created ? 'created' : 'choose'}
            guestName={user?.isGuest ? user.displayName : undefined}
            busy={busy}
            disabled={busy || !connected}
            message={message}
            onDiscord={onDiscord}
            onGuest={() => void onGuest()}
            onClose={onClose}
            returnFocus={trigger}
        />
    );
}

function guestFailure(result: Exclude<EnsureSignedInResult, { kind: 'ready' }>): string {
    if (result.kind === 'refused') return result.text || SIGN_IN_TEXT.failedLede;
    if (result.reason === 'timeout') return SIGN_IN_TEXT.tooLong;
    if (result.reason === 'unknown') return SIGN_IN_TEXT.unknown;
    return SIGN_IN_TEXT.failedLede;
}

/** The Discord start's end states, in the panel's sentences. */
function discordFailure(phase: SignInPhase): string | undefined {
    switch (phase.kind) {
        case 'refused':
            return phase.text ?? SIGN_IN_TEXT.failedLede;
        case 'failed':
            return phase.reason ? SIGN_IN_TEXT[phase.reason] : SIGN_IN_TEXT.failedLede;
        case 'cancelled':
            return SIGN_IN_TEXT.failedLede;
        case 'notConfigured':
            return SIGN_IN_TEXT.notConfigured;
        default:
            return undefined;
    }
}
