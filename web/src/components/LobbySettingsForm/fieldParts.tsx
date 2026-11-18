import type { KeyboardEvent, ReactNode, Ref } from 'react';
import { InfoPopover } from '@/components/InfoPopover/InfoPopover';
import hidden from '@/styles/visuallyHidden.module.css';
import styles from './LobbySettingsForm.module.css';
import type { InfoText } from './lobbySettingsText';

/*
 * The pieces every section of the lobby settings form draws its fields with (S14.4c, shared with S14.4d's Advanced
 * Settings): a label row with its info mark, and a select that can be locked with a reason.
 */

/** The props `useFieldErrors().errorProps` gives a control. */
export type ErrorProps = {
    'aria-invalid': boolean;
    'aria-describedby': string | undefined;
    'data-field': string;
};

/** A field's label (a `label` when it names one control, else a span) and its info mark. */
export function LabelRow({
    label,
    info,
    htmlFor,
    hiddenSuffix,
}: {
    label: string;
    info: InfoText;
    htmlFor?: string;
    /** Read with the label but not shown (a unit the box shows beside the value: " (seconds)"). */
    hiddenSuffix?: string;
}) {
    // The space stays outside the hidden span: some name computations (jsdom's) drop a span's leading space.
    const spoken = hiddenSuffix?.trim();
    const suffix = spoken ? (
        <>
            {' '}
            <span className={hidden.visuallyHidden}>{spoken}</span>
        </>
    ) : null;
    return (
        <div className={styles.labelRow}>
            {htmlFor ? (
                <label htmlFor={htmlFor}>
                    {label}
                    {suffix}
                </label>
            ) : (
                <span className={styles.label}>{label}</span>
            )}
            <InfoPopover
                label={info.label}
                heading={info.heading}
                list={info.list}
                foot={info.foot}
            >
                {info.body.map((p, n) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: fixed text, never reordered
                    <p key={n}>{p}</p>
                ))}
            </InfoPopover>
        </div>
    );
}

export function SelectField({
    id,
    label,
    info,
    value,
    onChange,
    options,
    locked,
    extra,
    error,
    selectRef,
}: {
    id: string;
    label: string;
    info: InfoText;
    value: string;
    onChange: (value: string) => void;
    /** [value, text], or [value, text, true] for an option shown but not offered (`disabled`). */
    options: readonly (readonly [string, string] | readonly [string, string, boolean])[];
    /**
     * Set: the select cannot change, and the element `reasonId` says why (its description). With `reason` that line is
     * shown under the select; without it the reason is an element elsewhere (a whole read-only form's one line).
     */
    locked?: { reasonId: string; reason?: string };
    extra: ErrorProps;
    error: ReactNode;
    /** The select element (a dialog's first focus). */
    selectRef?: Ref<HTMLSelectElement>;
}) {
    const describedBy =
        [locked?.reasonId, extra['aria-describedby']].filter(Boolean).join(' ') || undefined;
    const isLocked = locked !== undefined;
    return (
        <div className={styles.field}>
            <LabelRow label={label} info={info} htmlFor={id} />
            <select
                ref={selectRef}
                id={id}
                className={styles.select}
                value={value}
                // Locked: a controlled select whose change is ignored snaps back to `value`.
                onChange={(e) => {
                    if (!isLocked) onChange(e.target.value);
                }}
                // Locked: the picker does not open and no key changes the value; Tab still moves on.
                onMouseDown={isLocked ? (e) => e.preventDefault() : undefined}
                onKeyDown={isLocked ? ignoreChangeKeys : undefined}
                aria-disabled={isLocked || undefined}
                {...extra}
                aria-describedby={describedBy}
            >
                {options.map(([v, text, off]) => (
                    <option key={v} value={v} disabled={off === true}>
                        {text}
                    </option>
                ))}
            </select>
            {locked?.reason && (
                <p id={locked.reasonId} className={styles.hint}>
                    {locked.reason}
                </p>
            )}
            {error}
        </div>
    );
}

/** A locked select's keys: everything but Tab and Escape would open it or change its value. */
function ignoreChangeKeys(event: KeyboardEvent<HTMLSelectElement>) {
    if (event.key !== 'Tab' && event.key !== 'Escape') event.preventDefault();
}
