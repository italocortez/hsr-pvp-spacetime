import type { MouseEvent } from 'react';
import { Dialog } from '@/components/Dialog/Dialog';
import { DiscordIcon } from '@/components/DiscordIcon/DiscordIcon';
import { PersonIcon } from '@/components/PersonIcon/PersonIcon';
import styles from './SignInDialog.module.css';
import { SIGN_IN_TEXT, SIGN_IN_DIALOG_TEXT as TEXT } from './signInText';

export type SignInDialogViewProps = {
    /** `choose`: the two ways in; `created`: the new guest's name and "Enter Battlegrounds". */
    view: 'choose' | 'created';
    /** The guest's name from the profile view: a guest who opened the dialog, or the guest just created. */
    guestName?: string;
    /** A call is in flight (Discord start, guest creation): the dialog cannot be dismissed. */
    busy: boolean;
    /** The two buttons do nothing (busy, still connecting, the chunk still loading). */
    disabled: boolean;
    /** One line under the buttons, read out politely: progress, a refusal, a failure. */
    message?: string;
    onDiscord: () => void;
    /** A visitor's "Continue as Guest" (a guest's closes the dialog instead). */
    onGuest: () => void;
    onClose: (value: string) => void;
    returnFocus: HTMLElement | null;
    /** The chunk did not load: "Try again" loads it again. */
    onRetryLoad?: () => void;
};

/**
 * The sign-in dialog's markup (S14.4b; design/mockups/index.html sign-in dialog), no SDK code: the loaded dialog
 * (`SignInDialog.tsx`, its own chunk) and the frame shown while that chunk loads (`shell/SignInDialogHost.tsx`, in
 * the entry chunk) both render it. The buttons that cannot act are `aria-disabled`, not `disabled`, so the one just
 * pressed keeps focus while its call runs. "Continue as Guest" for a guest and "Enter Battlegrounds" close the dialog
 * (submit buttons with a value); the others are plain buttons.
 */
export function SignInDialogView({
    view,
    guestName,
    busy,
    disabled,
    message,
    onDiscord,
    onGuest,
    onClose,
    returnFocus,
    onRetryLoad,
}: SignInDialogViewProps) {
    const created = view === 'created';
    const act = (run: () => void) => (event: MouseEvent<HTMLButtonElement>) => {
        event.preventDefault();
        if (!disabled) run();
    };
    return (
        <Dialog
            open
            onClose={onClose}
            className={created ? `${styles.dialog} ${styles.createdDialog}` : styles.dialog}
            title={created ? TEXT.createdTitle : TEXT.title}
            description={created ? undefined : TEXT.lede}
            closeLabel={TEXT.close}
            dismissible={!busy}
            returnFocus={returnFocus}
            focusKey={view}
            data-sign-in-dialog=""
        >
            {created ? (
                <div className={styles.created}>
                    <p className={styles.guestName}>{guestName}</p>
                    <p className={styles.meta}>{TEXT.createdMeta}</p>
                    <button type="submit" value="enter" className={`${styles.cta} ${styles.enter}`}>
                        {TEXT.enter}
                        <span className={styles.arrow} aria-hidden="true" />
                    </button>
                </div>
            ) : (
                <>
                    <div className={styles.buttons}>
                        <button
                            type="button"
                            className={`${styles.cta} ${styles.discord}`}
                            onClick={act(onDiscord)}
                            aria-disabled={disabled}
                        >
                            <DiscordIcon className={styles.icon} />
                            {TEXT.discord}
                        </button>
                        <p className={styles.or} aria-hidden="true">
                            {TEXT.or}
                        </p>
                        {guestName ? (
                            <button
                                type="submit"
                                value="guest"
                                className={`${styles.cta} ${styles.guest}`}
                                onClick={(event) => {
                                    if (busy) event.preventDefault();
                                }}
                                aria-disabled={busy}
                            >
                                <PersonIcon className={styles.icon} />
                                {TEXT.guest}
                            </button>
                        ) : (
                            <button
                                type="button"
                                className={`${styles.cta} ${styles.guest}`}
                                onClick={act(onGuest)}
                                aria-disabled={disabled}
                            >
                                <PersonIcon className={styles.icon} />
                                {TEXT.guest}
                            </button>
                        )}
                    </div>
                    <p className={styles.message} role="status">
                        {message}
                    </p>
                    {onRetryLoad && (
                        <button type="button" className={styles.retry} onClick={onRetryLoad}>
                            {SIGN_IN_TEXT.tryAgain}
                        </button>
                    )}
                    <p className={styles.fine}>
                        {guestName ? TEXT.playingAs(guestName) : TEXT.fine}
                    </p>
                </>
            )}
        </Dialog>
    );
}
