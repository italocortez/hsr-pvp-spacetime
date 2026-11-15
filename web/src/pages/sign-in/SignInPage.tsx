import type { LoginStatus } from '@shared/auth-flow';
import type { ReactNode } from 'react';
import { IpcActionButton } from '@/components/IpcButton/IpcButton';
import { SplashLayout } from '@/components/SplashLayout/SplashLayout';
import { useDocumentTitle } from '@/lib/useDocumentTitle';
import styles from './SignInPage.module.css';
import { SIGN_IN_FRAME, SIGN_IN_TEXT, SIGN_IN_TITLE } from './signInText';
import { defaultSignInIo, type SignInIo, type SignInPhase, useSignIn } from './useSignIn';

export { SIGN_IN_TEXT };

type View = { title: ReactNode; lede: ReactNode; notice?: string; action: ReactNode };

/**
 * The sign-in panel on `/?login=1` (M5b), on the splash pattern: one `main`, one `h1`. States:
 * sign in, confirm the pending Discord account, refused (the module's text), failed or cancelled.
 */
export function SignInPage({
    status,
    next,
    io = defaultSignInIo,
}: {
    status?: LoginStatus;
    next?: string;
    io?: SignInIo;
}) {
    const { phase, start, confirm, cancel } = useSignIn({ status, next }, io);
    useDocumentTitle(SIGN_IN_TITLE);
    const view = describe(phase, { start, confirm, cancel });

    return (
        <SplashLayout {...SIGN_IN_FRAME} title={view.title} lede={view.lede} action={view.action}>
            {view.notice && (
                <p className={styles.notice} role="status">
                    {view.notice}
                </p>
            )}
        </SplashLayout>
    );
}

const FAILED_LEDE = {
    tooLong: SIGN_IN_TEXT.tooLong,
    changed: SIGN_IN_TEXT.changed,
    unknown: SIGN_IN_TEXT.unknown,
} as const;

function describe(
    phase: SignInPhase,
    act: { start: () => void; confirm: (shownHandle: string) => void; cancel: () => void },
): View {
    const tryAgain = <IpcActionButton onClick={act.start}>{SIGN_IN_TEXT.tryAgain}</IpcActionButton>;
    switch (phase.kind) {
        case 'confirm':
        case 'confirming':
        case 'linked': {
            const busy = phase.kind !== 'confirm';
            const handle = phase.kind === 'linked' ? '' : phase.handle;
            return {
                title: (
                    <>
                        Link <em>account.</em>
                    </>
                ),
                lede: (
                    <>
                        You are about to link the Discord account{' '}
                        <span className={styles.handle}>{handle}</span>.
                    </>
                ),
                action: (
                    <div className={styles.actions}>
                        {/* The click carries the handle this render shows. */}
                        <IpcActionButton onClick={() => act.confirm(handle)} disabled={busy}>
                            {SIGN_IN_TEXT.confirmButton}
                        </IpcActionButton>
                        <button
                            type="button"
                            className={styles.secondary}
                            onClick={act.cancel}
                            disabled={busy}
                        >
                            {SIGN_IN_TEXT.cancel}
                        </button>
                    </div>
                ),
            };
        }
        case 'refused':
            return {
                title: (
                    <>
                        Sign-in <em>refused.</em>
                    </>
                ),
                lede: phase.text ?? SIGN_IN_TEXT.failedLede,
                action: tryAgain,
            };
        case 'failed':
        case 'cancelled':
            return {
                title: (
                    <>
                        Sign-in <em>failed.</em>
                    </>
                ),
                lede:
                    phase.kind === 'failed' && phase.reason
                        ? FAILED_LEDE[phase.reason]
                        : SIGN_IN_TEXT.failedLede,
                action: tryAgain,
            };
        default: {
            const busy = phase.kind === 'starting' || phase.kind === 'checking';
            const notConfigured = phase.kind === 'notConfigured';
            return {
                title: (
                    <>
                        Sign <em>in.</em>
                    </>
                ),
                lede: SIGN_IN_TEXT.lede,
                notice: notConfigured ? SIGN_IN_TEXT.notConfigured : undefined,
                action: (
                    <IpcActionButton onClick={act.start} disabled={busy}>
                        {notConfigured ? SIGN_IN_TEXT.tryAgain : SIGN_IN_TEXT.button}
                    </IpcActionButton>
                ),
            };
        }
    }
}
