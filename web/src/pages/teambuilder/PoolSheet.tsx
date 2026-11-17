import { useEffect, useId, useRef } from 'react';
import { CharacterPool, type PoolProps } from './CharacterPool';
import styles from './PoolSheet.module.css';
import { CloseIcon } from './TeamBuilderIcons';

/*
 * Picking on phones, variant A (A190 item 13): tapping an empty slot at the middle step (768px) and below opens the
 * character pool as a full-screen sheet, a native modal `<dialog>` (web-guidance ui-components/dialog.md and
 * prevent-page-scroll-under-modal-dialog.md): the page behind is inert and does not scroll, focus moves into the
 * sheet's search field, Escape and the Close button close it. A pick fills the slot the sheet was opened from and
 * closes the sheet. The browser returns focus to the slot button that opened it; when that button has been
 * replaced by the filled slot, the page moves focus to the slot's first control (`onClosed`).
 */

export function PoolSheet({
    slot,
    onClose,
    onClosed,
    ...pool
}: Omit<PoolProps, 'searchRef'> & {
    /** The slot it was opened from (0-based); null: closed. */
    slot: number | null;
    onClose: () => void;
    /** After the dialog closed: the slot to put focus back on. */
    onClosed: (slot: number) => void;
}) {
    const ref = useRef<HTMLDialogElement>(null);
    const searchRef = useRef<HTMLInputElement>(null);
    const titleId = useId();
    const openedFor = useRef<number | null>(null);

    useEffect(() => {
        const dialog = ref.current;
        if (!dialog) return;
        if (slot !== null && !dialog.open) {
            openedFor.current = slot;
            dialog.showModal?.();
            if (!dialog.showModal) dialog.setAttribute('open', '');
            searchRef.current?.focus();
        } else if (slot === null && dialog.open) {
            // Closed by the page (a pick): the close event below must not report it again.
            const at = openedFor.current;
            openedFor.current = null;
            if (dialog.close) dialog.close();
            else dialog.removeAttribute('open');
            if (at !== null) onClosed(at);
        }
    }, [slot, onClosed]);

    return (
        <dialog
            ref={ref}
            className={styles.sheet}
            aria-labelledby={titleId}
            onClose={() => {
                // Closed by the browser or the Close button (Escape, back gesture).
                const at = openedFor.current;
                if (at === null) return;
                openedFor.current = null;
                onClose();
                onClosed(at);
            }}
        >
            {slot !== null && (
                <div className={styles.inner}>
                    <header className={styles.head}>
                        <h2 id={titleId} className={styles.title}>
                            Pick a character for slot {slot + 1}
                        </h2>
                        <button
                            type="button"
                            className={styles.close}
                            aria-label="Close"
                            title="Close"
                            onClick={() => {
                                if (ref.current?.close) ref.current.close();
                                else {
                                    ref.current?.removeAttribute('open');
                                    ref.current?.dispatchEvent(new Event('close'));
                                }
                            }}
                        >
                            <CloseIcon className={styles.closeIcon} />
                        </button>
                    </header>
                    <div className={styles.scroller}>
                        <CharacterPool {...pool} searchRef={searchRef} />
                    </div>
                </div>
            )}
        </dialog>
    );
}
