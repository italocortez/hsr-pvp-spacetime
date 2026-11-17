/*
 * The team builder's glyphs, one source each (component-hygiene Rule 6). Decorative: the control that holds one
 * carries the name.
 */

type IconProps = { className?: string };

/** Six dots: a drag handle (the slot's move control). */
export function GripIcon({ className }: IconProps) {
    return (
        <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <circle cx="9" cy="6" r="1.6" />
            <circle cx="15" cy="6" r="1.6" />
            <circle cx="9" cy="12" r="1.6" />
            <circle cx="15" cy="12" r="1.6" />
            <circle cx="9" cy="18" r="1.6" />
            <circle cx="15" cy="18" r="1.6" />
        </svg>
    );
}

/** The empty light cone mark (the mockup's `EMPTY_SVG`): the slot's cone place while none is equipped. */
export function EmptyConeIcon({ className }: IconProps) {
    return (
        <svg className={className} viewBox="0 0 140 160" fill="none" aria-hidden="true">
            <polygon
                points="0,0 140,0 90,80 140,160 0,160 50,80"
                stroke="currentColor"
                strokeWidth="8"
                strokeLinejoin="round"
                opacity="0.55"
            />
        </svg>
    );
}

/** Two chain links (the mockup's `SYN_SVG`): the slot's character is in an active pair. */
export function LinkIcon({ className }: IconProps) {
    return (
        <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M10.962 15.867a2.469 2.469 0 0 1-.69 1.377l-1.029 1.028a2.5 2.5 0 0 1-3.536-3.536l1.029-1.029a2.464 2.464 0 0 1 1.423-.694l1.781-1.781a4.425 4.425 0 0 0-4.619 1.062l-1.028 1.028a4.5 4.5 0 0 0 6.364 6.364l1.029-1.029a4.489 4.489 0 0 0 1.073-4.587zM19.686 4.293a4.511 4.511 0 0 0-6.364 0l-1.029 1.029a4.49 4.49 0 0 0-1.063 4.62l1.779-1.779a2.476 2.476 0 0 1 .7-1.427l1.029-1.029a2.5 2.5 0 0 1 3.536 3.536l-1.029 1.029a2.484 2.484 0 0 1-1.379.693l-1.796 1.794a4.409 4.409 0 0 0 4.587-1.072l1.029-1.029a4.5 4.5 0 0 0 0-6.365z" />
            <path d="M9 16a1 1 0 0 1-.707-1.707l6-6a1 1 0 0 1 1.414 1.414l-6 6A1 1 0 0 1 9 16z" />
        </svg>
    );
}
