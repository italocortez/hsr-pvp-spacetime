import type { ReactNode } from 'react';
import styles from './IpcButton.module.css';

/**
 * The angled IPC CTA (DESIGN.md §5.1): iris fill, champagne inner ring, trailing arrow that
 * extends on hover. Rendered as a link: it navigates. The fill and ring are clipped
 * pseudo-elements, so the element itself is not clipped and its focus ring stays visible.
 */
export function IpcButton({ href, children }: { href: string; children: ReactNode }) {
    return (
        <a className={styles.cta} href={href}>
            <span className={styles.arrow} aria-hidden="true" />
            <span>{children}</span>
        </a>
    );
}
