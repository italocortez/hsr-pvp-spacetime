import { LOADOUT_NOTE_MAX } from '@shared/loadouts';
import { useId } from 'react';
import hidden from '@/styles/visuallyHidden.module.css';
import styles from './LoadoutNote.module.css';

/*
 * The loadout's note (S14.3c; the mockup's `.rosterNote` under the pairs strip): a textarea capped at 1,000 UTF-16
 * units (A190 item 15, the unit `maxlength` and the module both count) with a visible counter. The counter is the
 * field's description, read when the field is focused, not announced on every key.
 */

const NUMBER = new Intl.NumberFormat('en-US');

export function LoadoutNote({
    value,
    onChange,
}: {
    value: string;
    onChange: (note: string) => void;
}) {
    const id = useId();
    const left = LOADOUT_NOTE_MAX - value.length;
    return (
        <div className={styles.note}>
            <div className={styles.head}>
                <label htmlFor={`${id}-field`} className={styles.label}>
                    Note
                </label>
                <span className={styles.hint}>Saves with the loadout</span>
            </div>
            <textarea
                id={`${id}-field`}
                className={styles.field}
                value={value}
                maxLength={LOADOUT_NOTE_MAX}
                spellCheck
                aria-describedby={`${id}-count`}
                placeholder="Sub-DPS rotation, Genesis Rails opener, what to swap if the enemy brings cleanse… anything you want next-you to read."
                onChange={(e) => onChange(e.currentTarget.value)}
            />
            <p id={`${id}-count`} className={styles.count} data-near={left <= 100 ? '' : undefined}>
                {NUMBER.format(value.length)} / {NUMBER.format(LOADOUT_NOTE_MAX)}{' '}
                <span className={hidden.visuallyHidden}>characters</span>
            </p>
        </div>
    );
}
