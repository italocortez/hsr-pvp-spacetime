/*
 * The team builder's glyphs, one source each (component-hygiene Rule 6). Decorative: the control that holds one
 * carries the name. S14.3i: the circled "!" moved to `@/components/ExclamationIcon` (the site's one information
 * symbol, A210 item 7); the circled "i" of the Auction meters went with the shared info popover.
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

/**
 * The link glyph's path data (24 by 24, filled): one source for the page's `LinkIcon` and the exported picture,
 * which draws it with `Path2D` (S14.3e).
 */
export const LINK_ICON_PATHS = [
    'M10.962 15.867a2.469 2.469 0 0 1-.69 1.377l-1.029 1.028a2.5 2.5 0 0 1-3.536-3.536l1.029-1.029a2.464 2.464 0 0 1 1.423-.694l1.781-1.781a4.425 4.425 0 0 0-4.619 1.062l-1.028 1.028a4.5 4.5 0 0 0 6.364 6.364l1.029-1.029a4.489 4.489 0 0 0 1.073-4.587zM19.686 4.293a4.511 4.511 0 0 0-6.364 0l-1.029 1.029a4.49 4.49 0 0 0-1.063 4.62l1.779-1.779a2.476 2.476 0 0 1 .7-1.427l1.029-1.029a2.5 2.5 0 0 1 3.536 3.536l-1.029 1.029a2.484 2.484 0 0 1-1.379.693l-1.796 1.794a4.409 4.409 0 0 0 4.587-1.072l1.029-1.029a4.5 4.5 0 0 0 0-6.365z',
    'M9 16a1 1 0 0 1-.707-1.707l6-6a1 1 0 0 1 1.414 1.414l-6 6A1 1 0 0 1 9 16z',
] as const;

/** Two chain links (the mockup's `SYN_SVG`): the slot's character is in an active pair. */
export function LinkIcon({ className }: IconProps) {
    return (
        <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            {LINK_ICON_PATHS.map((d) => (
                <path key={d} d={d} />
            ))}
        </svg>
    );
}

/** S14.3c: a pencil (the mockup's loadout name affordance). */
export function PencilIcon({ className }: IconProps) {
    return (
        <svg
            className={className}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
        </svg>
    );
}

/** S14.3c: a down caret (the loadout menu button). */
export function CaretIcon({ className }: IconProps) {
    return (
        <svg
            className={className}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d="M6 9l6 6 6-6" />
        </svg>
    );
}

/** S14.3c: a check mark (the active loadout in the menu; saved states). */
export function CheckIcon({ className }: IconProps) {
    return (
        <svg
            className={className}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d="M20 6 9 17l-5-5" />
        </svg>
    );
}

/**
 * S14.3g: a floppy disk, the save indicator's resting state (saved). save-floppy from SVG Repo, supplied by the user;
 * the source's group translation (-152, -515) is applied to the coordinates, so the path sits in 0 0 32 32 as is.
 */
export function FloppyIcon({ className }: IconProps) {
    return (
        <svg
            className={className}
            viewBox="0 0 32 32"
            fill="currentColor"
            fillRule="evenodd"
            aria-hidden="true"
        >
            <path d="M19 10c.552 0 1-.447 1-1V5c0-.553-.448-1-1-1s-1 .447-1 1v4c0 .553.448 1 1 1Zm11 18c0 1.104-.896 2-2 2H4c-1.104 0-2-.896-2-2V4c0-1.104.896-2 2-2h2v10c0 1.104.896 2 2 2h16c1.104 0 2-.896 2-2V2h2c1.104 0 2 .896 2 2v24ZM8 2h16v9c0 .553-.448 1-1 1H9c-.552 0-1-.447-1-1V2Zm20-2H4C1.791 0 0 1.791 0 4v24c0 2.209 1.791 4 4 4h24c2.209 0 4-1.791 4-4V4c0-2.209-1.791-4-4-4Z" />
        </svg>
    );
}

/** S14.3c: two sheets (the mockup's Duplicate). */
export function DuplicateIcon({ className }: IconProps) {
    return (
        <svg
            className={className}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <rect x="9" y="9" width="11" height="11" rx="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
    );
}

/** S14.3c: a bin (the mockup's Delete). */
export function TrashIcon({ className }: IconProps) {
    return (
        <svg
            className={className}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d="M3 6h18" />
            <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
        </svg>
    );
}

/** S14.3c: an arrow up into a tray (Copy to my account). */
export function UploadIcon({ className }: IconProps) {
    return (
        <svg
            className={className}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d="M12 15V3" />
            <path d="m7 8 5-5 5 5" />
            <path d="M5 15v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4" />
        </svg>
    );
}

/** S14.3d: a framed picture (Copy image). */
export function ImageIcon({ className }: IconProps) {
    return (
        <svg
            className={className}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <circle cx="9" cy="9" r="2" />
            <path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" />
        </svg>
    );
}

/** S14.3d: an arrow down into a tray (Download). */
export function DownloadIcon({ className }: IconProps) {
    return (
        <svg
            className={className}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d="M12 3v12" />
            <path d="m7 10 5 5 5-5" />
            <path d="M5 15v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4" />
        </svg>
    );
}
