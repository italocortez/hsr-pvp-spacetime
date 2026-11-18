import { advancedErrorKeys } from '@shared/lobby-rules/lobbySettings';
import { useRef, useState } from 'react';
import { Dialog, type FocusTarget } from '@/components/Dialog/Dialog';
import { AdvancedLobbySettings, type AdvancedLobbySettingsProps } from './AdvancedLobbySettings';
import styles from './AdvancedSettingsDialog.module.css';
import { ADVANCED_TEXT as TEXT } from './lobbySettingsText';

/*
 * Advanced Settings as a second dialog over the host's form (S14.4d, the mockup's sub-dialog `#advBackdrop`): the
 * shared Dialog, stacked, with the field groups and one "Done". A thin wrapper: the value, errors and drafts are the
 * host's, so closing it loses nothing and the host's own submit (Create) stays in the first dialog.
 *
 * It opens with focus on its first field (Ban Restriction), placed quietly, so no info panel opens by itself
 * (S14.4d-fix). Opened while a setting here is invalid, it shows every error at once. Done closes it when every advanced setting is
 * valid; otherwise it shows every error here and moves focus to the
 * first invalid field. The close button, Escape and the back gesture always close it (the host's button carries a mark
 * while a setting here needs a fix). On phones it is a full-screen sheet over the host's sheet (`size="sheet"`).
 */

export type AdvancedSettingsDialogProps = Omit<AdvancedLobbySettingsProps, 'focusRequest'> & {
    open: boolean;
    /** It closed (Done with nothing to fix, or a dismissal); the host sets `open` false. */
    onClose: () => void;
    /** Each new value above 0 while open: focus the first invalid field (the host's Create found one here). */
    focusRequest: number;
    /** The host's button style for Done. */
    doneClassName?: string;
    returnFocus?: FocusTarget;
};

export function AdvancedSettingsDialog({
    open,
    onClose,
    focusRequest,
    doneClassName,
    returnFocus,
    submitCount,
    ...fields
}: AdvancedSettingsDialogProps) {
    /** Done pressed with something to fix, this time open. */
    const [doneTries, setDoneTries] = useState(0);
    // Opened while a setting here needs a fix (the host's button shows the count): every error shows at once, so the
    // count is findable inside too. Set as it opens (the props-to-state pattern), not on later edits.
    const [openSeen, setOpenSeen] = useState(false);
    const [openedWithErrors, setOpenedWithErrors] = useState(false);
    if (open !== openSeen) {
        setOpenSeen(open);
        if (open) setOpenedWithErrors(advancedErrorKeys(fields.errors).length > 0);
    }
    const close = () => {
        setDoneTries(0);
        onClose();
    };
    // S14.4d-fix (review D S1): the first field takes the first focus, not the info button beside its label.
    const firstField = useRef<HTMLSelectElement>(null);
    return (
        <Dialog
            open={open}
            onClose={close}
            title={TEXT.title}
            closeLabel={TEXT.close}
            size="sheet"
            className={styles.dialog}
            initialFocus={firstField}
            returnFocus={returnFocus}
            onSubmit={() => {
                if (advancedErrorKeys(fields.errors).length > 0) setDoneTries((n) => n + 1);
                else close();
            }}
            data-advanced-dialog=""
            actions={
                <button type="submit" className={doneClassName}>
                    {TEXT.done}
                </button>
            }
        >
            <AdvancedLobbySettings
                {...fields}
                firstFieldRef={firstField}
                submitCount={submitCount + doneTries + (openedWithErrors ? 1 : 0)}
                focusRequest={focusRequest + doneTries}
            />
        </Dialog>
    );
}
