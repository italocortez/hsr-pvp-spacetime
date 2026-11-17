import { type ReactNode, useId, useState } from 'react';
import styles from './PageIntro.module.css';

/*
 * A page's intro band (the mockups' `.workshopHead`) with its hide control: the costs page (S14.2) and the team
 * builder (S14.3a). Moved here from `pages/costs/CostsIntro.tsx` in S14.3a; the costs page renders it through
 * `CostsIntro`. The page has exactly one `h1` in both states: the headline while the intro shows, the slim label
 * (`collapsedTitle`) once it is hidden. The choice is remembered in `localStorage` under the mockups' key
 * `hsr_intro_hidden` ("1" hidden, "0" shown), shared by every page with an intro; storage may be blocked, so every
 * access is guarded and the intro then simply shows.
 */

export const INTRO_KEY = 'hsr_intro_hidden';

function readHidden(): boolean {
    try {
        return localStorage.getItem(INTRO_KEY) === '1';
    } catch {
        return false;
    }
}

function writeHidden(hidden: boolean): void {
    try {
        localStorage.setItem(INTRO_KEY, hidden ? '1' : '0');
    } catch {
        // Blocked storage: the choice lasts for this page only.
    }
}

export function PageIntro({
    title,
    collapsedTitle,
    children,
    onToggle,
}: {
    /** The headline (`h1` while shown). */
    title: ReactNode;
    /** The slim label (`h1` while hidden). */
    collapsedTitle: string;
    /** The deck paragraph's content. */
    children: ReactNode;
    onToggle?: () => void;
}) {
    const [hidden, setHidden] = useState(readHidden);
    const innerId = useId();
    const toggle = () => {
        const next = !hidden;
        setHidden(next);
        writeHidden(next);
        onToggle?.();
    };
    const action = hidden ? 'Show intro' : 'Hide intro';

    return (
        <header className={styles.head} data-collapsed={hidden || undefined}>
            <button
                type="button"
                className={styles.toggle}
                aria-expanded={!hidden}
                aria-controls={hidden ? undefined : innerId}
                aria-label={action}
                title={action}
                onClick={toggle}
            >
                <ChevronUpIcon className={styles.toggleIcon} />
            </button>
            {hidden ? (
                <h1 className={styles.collapsedLabel}>{collapsedTitle}</h1>
            ) : (
                <div className={styles.inner} id={innerId}>
                    <h1 className={styles.title}>{title}</h1>
                    <p className={styles.deck}>{children}</p>
                </div>
            )}
        </header>
    );
}

/**
 * An upward chevron (decorative): the intro toggle, and the costs table's sort direction (rotated for descending).
 * The one copy of this glyph (component-hygiene Rule 6); `pages/costs/CostIcons.tsx` re-exports it.
 */
export function ChevronUpIcon({ className }: { className?: string }) {
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
