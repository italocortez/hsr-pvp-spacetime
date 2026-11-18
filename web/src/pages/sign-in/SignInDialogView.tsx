import { type MouseEvent, useId } from 'react';
import { Dialog } from '@/components/Dialog/Dialog';
import { DiscordIcon } from '@/components/DiscordIcon/DiscordIcon';
import { PersonIcon } from '@/components/PersonIcon/PersonIcon';
import slanted from '@/styles/slantedFocus.module.css';
import styles from './SignInDialog.module.css';
import { SIGN_IN_DIALOG_TEXT as TEXT } from './signInText';

export type SignInDialogViewProps = {
    /** `choose`: the two ways in; `created`: the new guest's name and "Enter Battlegrounds". */
    view: 'choose' | 'created';
    /** The guest's name from the profile view: a guest who opened the dialog, or the guest just created. */
    guestName?: string;
    /** A call is in flight (Discord start, guest creation). The person can still close the dialog. */
    busy: boolean;
    /** The two buttons do nothing (busy, still connecting). */
    disabled: boolean;
    /** One line under the buttons, read out politely: progress, a refusal, a failure. */
    message?: string;
    onDiscord: () => void;
    /** A visitor's "Continue as Guest" (a guest's closes the dialog instead). */
    onGuest: () => void;
    onClose: (value: string) => void;
    returnFocus: HTMLElement | null;
};

const cta = `${styles.cta} ${slanted.slanted}`;

/**
 * The sign-in dialog's markup (S14.4b; design/mockups/index.html sign-in dialog), no SDK code; `SignInDialog.tsx`
 * renders it. The buttons that cannot act are `aria-disabled`, not `disabled`, so the one just pressed keeps focus
 * while its call runs. The dialog can always be closed: a call left behind has its answer dropped (S14.4b-fix S2).
 * "Continue as Guest" for a guest and "Enter Battlegrounds" close the dialog (submit buttons with a value); the
 * others are plain buttons. The angled buttons draw their fill as a clipped layer and take the shared slanted focus
 * ring (`styles/slantedFocus.module.css`).
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
}: SignInDialogViewProps) {
    const id = useId();
    const created = view === 'created';
    const act = (run: () => void) => (event: MouseEvent<HTMLButtonElement>) => {
        event.preventDefault();
        if (!disabled) run();
    };
    const fill = <span className={styles.fill} aria-hidden="true" />;
    return (
        <Dialog
            open
            onClose={onClose}
            className={created ? `${styles.dialog} ${styles.createdDialog}` : styles.dialog}
            title={created ? TEXT.createdTitle : TEXT.title}
            description={created ? undefined : TEXT.lede}
            // The new guest's name and its line are what the dialog is about: read with its name.
            describedBy={created ? `${id}-name ${id}-meta` : undefined}
            closeLabel={TEXT.close}
            returnFocus={returnFocus}
            focusKey={view}
            data-sign-in-dialog=""
        >
            {created ? (
                <div className={styles.created}>
                    <p id={`${id}-name`} className={styles.guestName}>
                        {guestName}
                    </p>
                    <p id={`${id}-meta`} className={styles.meta}>
                        {TEXT.createdMeta}
                    </p>
                    <button type="submit" value="enter" className={`${cta} ${styles.enter}`}>
                        {fill}
                        {TEXT.enter}
                        <span className={styles.arrow} aria-hidden="true" />
                    </button>
                </div>
            ) : (
                <>
                    <div className={styles.buttons}>
                        <button
                            type="button"
                            className={`${cta} ${styles.discord}`}
                            onClick={act(onDiscord)}
                            aria-disabled={disabled}
                        >
                            {fill}
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
                                className={`${cta} ${styles.guest}`}
                                onClick={(event) => {
                                    if (busy) event.preventDefault();
                                }}
                                aria-disabled={busy}
                            >
                                {fill}
                                <PersonIcon className={styles.icon} />
                                {TEXT.guest}
                            </button>
                        ) : (
                            <button
                                type="button"
                                className={`${cta} ${styles.guest}`}
                                onClick={act(onGuest)}
                                aria-disabled={disabled}
                            >
                                {fill}
                                <PersonIcon className={styles.icon} />
                                {TEXT.guest}
                            </button>
                        )}
                    </div>
                    <p className={styles.message} role="status">
                        {message}
                    </p>
                    <p className={styles.fine}>
                        {guestName ? TEXT.playingAs(guestName) : TEXT.fine}
                    </p>
                </>
            )}
        </Dialog>
    );
}
