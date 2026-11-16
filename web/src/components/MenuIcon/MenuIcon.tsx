/**
 * The phone bar's menu glyph (S14.1b): three short strokes stacked at the IPC angle (19.7deg: each
 * stroke sits tan(19.7deg) * 5 = 1.79 units right of the one below), in the gear's line weight.
 * The one inline copy of this SVG. Decorative: the button carries the name. Draws in
 * `currentColor`.
 */
export function MenuIcon({ className }: { className?: string }) {
    return (
        <svg
            className={className}
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            aria-hidden="true"
        >
            <path d="M7.8 7h12M6 12h10.2M4.2 17h12" />
        </svg>
    );
}
