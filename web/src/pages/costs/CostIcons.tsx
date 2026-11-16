/*
 * The costs page's glyphs, one source each (component-hygiene Rule 6). All decorative: the
 * control that holds one carries the name.
 */

import { MagnifierIcon } from '@/components/SearchField/SearchField';

type IconProps = { className?: string };

/** An upward chevron: the sort direction (rotated for descending) and the intro toggle. */
export function ChevronUpIcon({ className }: IconProps) {
    return (
        <svg
            className={className}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d="m18 15-6-6-6 6" />
        </svg>
    );
}

/** A right chevron: the synergy expander (rotated when open). */
export function ChevronRightIcon({ className }: IconProps) {
    return (
        <svg
            className={className}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d="m9 18 6-6-6-6" />
        </svg>
    );
}

/** A magnifier with a minus: the empty state (the search field's magnifier, one source). */
export function NoResultsIcon({ className }: IconProps) {
    return <MagnifierIcon className={className} strokeWidth={1.6} minus />;
}
