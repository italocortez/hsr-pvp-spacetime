import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import type { FileRouteTypes } from '@/routeTree.gen';
import styles from './IpcButton.module.css';

/** An in-app path without route params (the CTA's fixed destinations). */
type FixedPath = Exclude<FileRouteTypes['to'], `${string}$${string}`>;

/**
 * The angled IPC CTA (DESIGN.md §5.1): iris fill, champagne inner ring, trailing arrow that
 * extends on hover. Rendered as a router link: it navigates without a page load. The fill and
 * ring are clipped pseudo-elements, so the element itself is not clipped and its focus ring stays
 * visible.
 */
export function IpcButton({ to, children }: { to: FixedPath; children: ReactNode }) {
    return (
        <Link className={styles.cta} to={to}>
            <span className={styles.arrow} aria-hidden="true" />
            <span>{children}</span>
        </Link>
    );
}

/**
 * The same CTA as a button, for an in-place action (Retry on the connection splashes). No arrow:
 * the arrow means "go somewhere"; an action stays on the page.
 */
export function IpcActionButton({
    onClick,
    children,
}: {
    onClick: () => void;
    children: ReactNode;
}) {
    return (
        <button type="button" className={`${styles.cta} ${styles.button}`} onClick={onClick}>
            <span>{children}</span>
        </button>
    );
}
