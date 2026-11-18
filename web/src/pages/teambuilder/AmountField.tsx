import { type AmountRead, amountText, readAmount } from '@shared/teambuilder';
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { NO_AUTOFILL } from '@/lib/noAutofill';
import styles from './AmountField.module.css';

/*
 * A typed Auction amount (S14.3b): a slot's extra bid or a budget, kept by the team in integer hundredths. The
 * mockup's `<input type="number" min="0" step="0.5">`, built as a text field with `inputmode="decimal"`
 * (web-guidance forms.md): a number field reports an empty value while a partial entry such as "2." is typed, which
 * a controlled React field would then wipe. What the number field gave is kept by hand: Arrow Up and Arrow Down step
 * by 0.5 (`step`), never below 0 (`min`) or above `max`; no spinner buttons (the mockup hides them).
 *
 * What a text reads as is `readAmount` (shared/teambuilder/amount.ts): a dot or a comma as the decimal mark, a
 * currency sign and spaces dropped, "1,000" refused as unclear.
 *
 * Typing: every keystroke that reads as an amount updates the team at once (the cost and the chart follow). A blank
 * keeps the last amount until the field is left (then 0), so a cleared budget does not flash an over-budget state.
 * Text that is refused, or an amount above `max`, marks the field invalid (`aria-invalid`, a red edge) and shows a
 * short message under it, linked with `aria-describedby` while it shows (web-guidance
 * accessible-error-announcement.md); a refused text changes nothing, an amount above `max` stores `max`.
 *
 * Leaving the field, or Enter: the field shows the stored value again. A refused text goes back to the amount the
 * field held before this edit began (review S3: it never wipes a good amount, and "1,000" does not become the "1" read
 * on the way), and an amount above `max` shows `max`; either way a message says so for a few seconds. Messages go to the page's one polite status region through `announce`, once when they appear, not per key.
 */

/** How long the message after leaving the field stays. */
export const NOTE_MS = 5000;

export type AmountFieldProps = {
    /** Hundredths. */
    value: number;
    /** Hundredths. */
    max: number;
    /** Hundredths per Arrow key (50 = 0.5). */
    step?: number;
    onChange: (hundredths: number) => void;
    /** The page's polite status region. */
    announce?: (text: string) => void;
    className?: string;
    /** The message under the field (placed by the caller's layout). */
    messageClassName?: string;
    id?: string;
    'aria-label'?: string;
    'aria-describedby'?: string;
};

/** The message for a text while it is typed, or null when it reads as an amount within `max`. */
export function typingMessage(read: AmountRead, max: number): string | null {
    if (read.kind === 'refused')
        return read.reason === 'ambiguous'
            ? 'Unclear: type it without the comma, or use a dot for decimals.'
            : 'Not an amount. Type a number such as 2.5.';
    if (read.kind === 'amount' && read.capped) return `At most ${amountText(max)}.`;
    return null;
}

export function AmountField({
    value,
    max,
    step = 50,
    onChange,
    announce,
    className,
    messageClassName,
    'aria-describedby': describedBy,
    ...aria
}: AmountFieldProps) {
    const messageId = `${useId()}-message`;
    /** The text while the person types; null shows the stored value. */
    const [draft, setDraft] = useState<string | null>(null);
    /** The stored amount when this edit began (the first key since the field last showed the stored value). */
    const start = useRef(value);
    /** What leaving the field did, shown for a few seconds. */
    const [note, setNote] = useState<string | null>(null);
    const text = draft ?? amountText(value);
    const read = draft === null ? null : readAmount(draft, max);
    const typing = read ? typingMessage(read, max) : null;
    const message = typing ?? note;

    // A typing message is announced once when it appears (or changes kind), not on every key.
    const lastTyping = useRef<string | null>(null);
    useEffect(() => {
        if (typing && typing !== lastTyping.current) announce?.(typing);
        lastTyping.current = typing;
    }, [typing, announce]);

    useEffect(() => {
        if (!note) return;
        const timer = setTimeout(() => setNote(null), NOTE_MS);
        return () => clearTimeout(timer);
    }, [note]);

    const settle = () => {
        if (draft === null) return;
        const r = readAmount(draft, max);
        setDraft(null);
        if (r.kind === 'blank') {
            if (value !== 0) onChange(0);
            return;
        }
        if (r.kind === 'refused') {
            // Back to the amount the field held before this edit: what was read on the way ("1" of "1,000") was
            // never confirmed.
            const kept = start.current;
            if (kept !== value) onChange(kept);
            const said = `Not read. Kept ${amountText(kept)}.`;
            setNote(said);
            announce?.(said);
            return;
        }
        if (r.value !== value) onChange(r.value);
        if (r.capped) {
            const said = `At most ${amountText(max)}. Set to ${amountText(max)}.`;
            setNote(said);
            announce?.(said);
        }
    };

    const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') {
            settle();
            return;
        }
        if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
        e.preventDefault();
        const current = draft !== null ? readAmount(draft, max) : null;
        const base = current?.kind === 'amount' ? current.value : value;
        const dir = e.key === 'ArrowUp' ? 1 : -1;
        // To the next multiple of the step in that direction, as a number field's stepping does.
        const stepped =
            dir > 0 ? Math.floor(base / step) * step + step : Math.ceil(base / step) * step - step;
        const next = Math.min(max, Math.max(0, stepped));
        setDraft(null);
        setNote(null);
        if (next !== value) onChange(next);
    };

    const described = [describedBy, message ? messageId : null].filter(Boolean).join(' ');

    return (
        <>
            <input
                {...aria}
                type="text"
                inputMode="decimal"
                enterKeyHint="done"
                {...NO_AUTOFILL}
                spellCheck={false}
                // The longest amount the cap allows, with room for a currency sign and a space.
                maxLength={amountText(max).length + 2}
                className={className}
                value={text}
                aria-invalid={typing ? true : undefined}
                aria-describedby={described || undefined}
                onChange={(e) => {
                    const t = e.currentTarget.value;
                    if (draft === null) start.current = value;
                    setDraft(t);
                    setNote(null);
                    const r = readAmount(t, max);
                    if (r.kind === 'amount' && r.value !== value) onChange(r.value);
                }}
                onBlur={settle}
                onKeyDown={onKeyDown}
            />
            {message && (
                <span
                    id={messageId}
                    className={`${styles.message} ${messageClassName ?? ''}`}
                    data-tone={typing ? 'error' : 'note'}
                >
                    {message}
                </span>
            )}
        </>
    );
}
