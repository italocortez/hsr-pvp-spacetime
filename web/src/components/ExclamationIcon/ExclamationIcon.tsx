/**
 * The circled exclamation mark: the site's one information symbol (A210 item 7; first drawn for the team builder's
 * save states in S14.3g). The shared info popover's default trigger, the save spot's warning mark and the Auction
 * meters' info buttons all draw this one copy. Decorative: the control that holds it carries the name. Draws in
 * `currentColor`.
 */
export function ExclamationIcon({ className }: { className?: string }) {
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
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7.5v5.5" />
            <path d="M12 16.5h.01" />
        </svg>
    );
}
