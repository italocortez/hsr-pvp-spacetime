import {
    type FormEvent,
    type ReactNode,
    type RefObject,
    type SyntheticEvent,
    useEffect,
    useId,
    useRef,
} from 'react';
import { createPortal } from 'react-dom';
import styles from './Dialog.module.css';

export type DialogSize = 'small' | 'medium';

/** Where focus goes after a close the person made: an element, or a ref to one. */
export type FocusTarget = HTMLElement | null | RefObject<HTMLElement | null>;

export type DialogProps = {
    /** Shown now. The page owns this: set it false in `onClose`, or to close the dialog itself. */
    open: boolean;
    /**
     * A close the person made: the value of the submit button that closed it, or '' for Escape, the back gesture,
     * the close button and (with `closeOnBackdrop`) a press on the backdrop. Not called when the page closed it
     * (`open` turned false).
     */
    onClose: (value: string) => void;
    /** The heading (an `h2`); it names the dialog. */
    title: ReactNode;
    /** A line under the heading that describes the dialog (`aria-describedby`). */
    description?: ReactNode;
    /** Instead of `description`: the id of an element in the body that describes the dialog. */
    describedBy?: string;
    /** The body. It scrolls inside the dialog when the screen is short. */
    children?: ReactNode;
    /** The footer: the dialog's actions, at the end of the row. */
    actions?: ReactNode;
    /**
     * A form-level error, shown above the actions (it does not scroll away with the body) and announced politely.
     * Pass `null` while there is none: the live region then exists before its first text, so the text is read out.
     * Left undefined, there is no region.
     */
    error?: ReactNode;
    size?: DialogSize;
    /** The element that takes focus on open (default: the first control, the close button last). */
    initialFocus?: RefObject<HTMLElement | null>;
    /** A new value while open means new content: the initial focus is placed again. */
    focusKey?: unknown;
    /**
     * False while a submit is in flight: Escape, the back gesture, the backdrop and the close button do nothing (the
     * close button stays focusable, `aria-disabled`), and without `onSubmit` a submit button or Enter in a field does
     * not close it either.
     */
    dismissible?: boolean;
    /**
     * Asked before a dismissal by the person (Escape, the back gesture, the backdrop, the close button); false keeps
     * the dialog open. For a form with unsaved input: the page decides, for example by opening a confirmation. Not
     * asked for a submit button's value (a deliberate choice) or a close by the page. Chromium lets a page refuse only
     * one Escape per user activation; the next Escape closes (the platform's anti-abuse rule).
     */
    canClose?: () => boolean;
    /** A press on the backdrop closes it (default: does nothing). */
    closeOnBackdrop?: boolean;
    /** Shows the close button in the corner, with this accessible name. */
    closeLabel?: string;
    /** Where focus goes after a close the person made (default: the browser's, the element focused before opening). */
    returnFocus?: FocusTarget;
    /**
     * Where focus goes when the dialog closes or leaves the page and focus would otherwise fall to `body` (the element
     * to return to is gone, as when "Sign in" is replaced by the account chip). Default: the page's `main`.
     */
    fallbackFocus?: FocusTarget;
    /**
     * The page handles its own form (fields in the body, a submit button in the footer): called with the submit event,
     * default already prevented; the dialog stays open until `open` turns false. Without it a submit button closes the
     * dialog with its `value`. Either way the submit stops here: it never reaches an ancestor form's handler.
     */
    onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
    /** A class on the `dialog`, to set the custom properties of `Dialog.module.css`. */
    className?: string;
    /** `data-*` attributes go on the `dialog` element. */
    [data: `data-${string}`]: string | undefined;
};

const FOCUSABLE =
    'button:not(:disabled), [href], input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/**
 * The shared modal dialog (S14.4b) on the native `<dialog>` and `showModal()` (web-guidance dialog rule 1): the page
 * behind is inert, focus stays inside, Escape and the back gesture close it, and the browser returns focus to the
 * element focused before it opened. Rendered into `document.body` (a portal), so a dialog opened from inside another
 * dialog is never a form inside a form; the second one stacks on top, Escape closes the top one first, and focus
 * goes back into the first. The content (title, body, footer) exists only while `open`; the `dialog` element stays
 * mounted, so a page can keep a reference to it.
 *
 * Where `showModal` is missing (jsdom, older engines) the dialog opens by its `open` attribute.
 */
export function Dialog({
    open,
    onClose,
    title,
    description,
    describedBy,
    children,
    actions,
    size = 'small',
    initialFocus,
    focusKey,
    dismissible = true,
    canClose,
    closeOnBackdrop = false,
    closeLabel,
    returnFocus,
    fallbackFocus,
    onSubmit,
    error,
    className,
    ...rest
}: DialogProps) {
    const id = useId();
    const titleId = `${id}-title`;
    const descriptionId = `${id}-description`;
    const ref = useRef<HTMLDialogElement>(null);
    const closeRef = useRef<HTMLButtonElement>(null);
    // Closes by the page whose `close` event has not arrived yet (a browser sends it in a later task).
    const closedHere = useRef(0);
    const latest = useRef({ onClose, returnFocus, initialFocus, fallbackFocus });
    latest.current = { onClose, returnFocus, initialFocus, fallbackFocus };

    // biome-ignore lint/correctness/useExhaustiveDependencies: focusKey means "new content: place the focus again"
    useEffect(() => {
        const d = ref.current;
        if (!d) return;
        if (open) {
            if (!d.open) {
                // Its place in a stack of dialogs (InfoPopover holds back only for dialogs above its own).
                d.dataset.dialogLevel = String(
                    document.querySelectorAll('dialog[open]').length + 1,
                );
                if (typeof d.showModal === 'function') d.showModal();
                else d.setAttribute('open', '');
            }
            firstFocus(d, latest.current.initialFocus, closeRef.current)?.focus();
        } else if (d.open) {
            closedHere.current += 1;
            closeDialog(d, '');
            focusIfLost(latest.current.returnFocus, latest.current.fallbackFocus);
        }
    }, [open, focusKey]);

    // Leaving the page while open (the page stopped rendering it): focus must not fall to `body`.
    useEffect(() => {
        const d = ref.current;
        return () => {
            if (d?.open) focusIfLost(latest.current.returnFocus, latest.current.fallbackFocus);
        };
    }, []);

    const handleClose = (event: SyntheticEvent<HTMLDialogElement>) => {
        // A nested dialog's close reaches this one through the React tree: not ours.
        if (event.target !== event.currentTarget) return;
        const d = event.currentTarget;
        const value = d.returnValue ?? '';
        // Escape sets no value and engines differ on clearing the last one (the dialog guide).
        d.returnValue = '';
        if (closedHere.current > 0) {
            closedHere.current -= 1;
            return;
        }
        latest.current.onClose(value);
        const target = resolve(latest.current.returnFocus);
        if (target?.isConnected) target.focus();
        else focusIfLost(undefined, latest.current.fallbackFocus);
    };

    const vetoed = () => canClose !== undefined && !canClose();

    const handleCancel = (event: SyntheticEvent<HTMLDialogElement>) => {
        if (event.target !== event.currentTarget) return;
        if (!dismissible || vetoed()) event.preventDefault();
    };

    const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
        // A nested dialog's form submits through the React tree too.
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        // The portal keeps the DOM apart, but React events still bubble to an ancestor's `onSubmit`.
        event.stopPropagation();
        if (onSubmit) {
            onSubmit(event);
            return;
        }
        if (!dismissible) return;
        // What `method="dialog"` does, by hand, so the chosen button's value is the return value in every engine.
        const by = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
        if (ref.current) closeDialog(ref.current, by?.value ?? '');
    };

    const requestClose = () => {
        const d = ref.current as (HTMLDialogElement & { requestClose?: () => void }) | null;
        if (!d || !dismissible) return;
        // `requestClose()` sends `cancel`, where the veto is asked; the fallback asks it here.
        if (typeof d.requestClose === 'function') d.requestClose();
        else if (!vetoed()) closeDialog(d, '');
    };

    const closedBy = !dismissible ? 'none' : closeOnBackdrop ? 'any' : 'closerequest';
    const hasBody = children !== undefined && children !== null && children !== false;

    const dialog = (
        <dialog
            ref={ref}
            className={[styles.dialog, size === 'medium' ? styles.medium : '', className ?? '']
                .filter(Boolean)
                .join(' ')}
            aria-labelledby={titleId}
            aria-describedby={description ? descriptionId : describedBy}
            onClose={handleClose}
            onCancel={handleCancel}
            {...{ closedby: closedBy }}
            {...rest}
        >
            {open && (
                <form method="dialog" className={styles.form} onSubmit={handleSubmit}>
                    <h2
                        id={titleId}
                        className={styles.title}
                        data-with-close={closeLabel ? '' : undefined}
                    >
                        {title}
                    </h2>
                    {description && (
                        <p id={descriptionId} className={styles.text}>
                            {description}
                        </p>
                    )}
                    {hasBody && <div className={styles.body}>{children}</div>}
                    {error !== undefined && (
                        <div className={styles.error} role="status" data-dialog-error="">
                            {error}
                        </div>
                    )}
                    {actions && <div className={styles.actions}>{actions}</div>}
                    {closeLabel && (
                        <button
                            ref={closeRef}
                            type="button"
                            className={styles.close}
                            aria-label={closeLabel}
                            onClick={requestClose}
                            // Not `disabled`: a disabled button that has focus drops it to `body` inside the modal.
                            aria-disabled={!dismissible}
                            data-dialog-close=""
                        >
                            <CloseGlyph />
                        </button>
                    )}
                </form>
            )}
        </dialog>
    );
    return typeof document === 'undefined' ? dialog : createPortal(dialog, document.body);
}

/** `dialog.close(value)`, or its effect where the engine has no `close` (jsdom): the attribute and the event. */
function closeDialog(d: HTMLDialogElement, value: string): void {
    if (typeof d.close === 'function') {
        d.close(value);
        return;
    }
    d.returnValue = value;
    d.removeAttribute('open');
    d.dispatchEvent(new Event('close'));
}

function resolve(target: FocusTarget | undefined): HTMLElement | null {
    if (!target) return null;
    return 'current' in target ? target.current : target;
}

/** Focus fell to `body` (or nowhere): the element to return to if it is still on the page, else the fallback. */
function focusIfLost(back: FocusTarget | undefined, fallback: FocusTarget | undefined): void {
    if (typeof document === 'undefined') return;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    const target =
        [resolve(back), resolve(fallback), document.querySelector<HTMLElement>('main')].find(
            (el) => el?.isConnected,
        ) ?? null;
    target?.focus({ preventScroll: true });
}

/** The chosen element, else the first control that is not the close button, else the close button. */
function firstFocus(
    d: HTMLDialogElement,
    chosen: RefObject<HTMLElement | null> | undefined,
    close: HTMLButtonElement | null,
): HTMLElement | null {
    if (chosen?.current) return chosen.current;
    for (const el of d.querySelectorAll<HTMLElement>(FOCUSABLE)) {
        if (el !== close) return el;
    }
    return close;
}

/** The close button's cross: the one inline copy of this SVG. Decorative; the button carries the name. */
function CloseGlyph() {
    return (
        <svg
            className={styles.closeIcon}
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            aria-hidden="true"
        >
            <path d="M18 6 6 18M6 6l12 12" />
        </svg>
    );
}
