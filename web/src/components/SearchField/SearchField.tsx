import type { Ref } from 'react';
import hidden from '@/styles/visuallyHidden.module.css';
import styles from './SearchField.module.css';

/*
 * A search field (S14.2; the mockup's `.searchWrap` / `.searchInput`): a native
 * `<input type="search">` (Escape clears it in Chromium, and the platform's own clear control)
 * named by its label (visually hidden), with the magnifier as decoration. Text correction is off,
 * as the forms guide asks for search inputs. The caller owns the value; `inputRef` lets it move
 * focus to the field (after a "clear" button that goes away, say).
 */

export type SearchFieldProps = {
    /** The accessible name ("Search"). */
    label: string;
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
    maxLength?: number;
    inputRef?: Ref<HTMLInputElement>;
};

export function SearchField({
    label,
    value,
    onChange,
    placeholder,
    maxLength,
    inputRef,
}: SearchFieldProps) {
    return (
        <label className={styles.wrap}>
            <MagnifierIcon className={styles.icon} />
            <span className={hidden.visuallyHidden}>{label}</span>
            <input
                ref={inputRef}
                type="search"
                className={styles.input}
                value={value}
                placeholder={placeholder}
                maxLength={maxLength}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                autoCorrect="off"
                onChange={(event) => onChange(event.currentTarget.value)}
            />
        </label>
    );
}

/**
 * The magnifier glyph, the one copy (component-hygiene Rule 6): the search field's icon, and with
 * `minus` the "no results" mark. Decorative: the control or text next to it carries the meaning.
 */
export function MagnifierIcon({
    className,
    strokeWidth = 2,
    minus = false,
}: {
    className?: string;
    strokeWidth?: number;
    minus?: boolean;
}) {
    return (
        <svg
            className={className}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.3-4.3" />
            {minus && <path d="m8 11 6 0" />}
        </svg>
    );
}
