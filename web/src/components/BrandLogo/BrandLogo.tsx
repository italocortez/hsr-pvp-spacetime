import { useId } from 'react';
import styles from './BrandLogo.module.css';

/**
 * The IPC Battlegrounds mark: the one inline copy of the logo SVG (public/favicon.svg mirrors it,
 * with the same three colours written out, since a standalone SVG cannot read the tokens).
 */
export function BrandLogo({ className }: { className?: string }) {
    const gradientId = `logo-${useId().replace(/:/g, '')}`;
    return (
        <svg
            className={className}
            viewBox="3.375 3.375 47.25 47.25"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
        >
            <defs>
                <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0%" className={styles.stopIris} />
                    <stop offset="50%" className={styles.stopAmethyst} />
                    <stop offset="100%" className={styles.stopPeriwinkle} />
                </linearGradient>
            </defs>
            <path
                d="M13.5 3.375l27 0 10.125 10.125 0 27-10.125 10.125-27 0-10.125-10.125 0-27z m13.5 5.0625l15.1875 15.1875 0 18.5625-30.375 0 0-18.5625z m0 10.125l7.59375 7.59375-15.1875 0z m-7.59375 9.28125l15.1875 0-7.59375 7.59375z"
                fill={`url(#${gradientId})`}
                fillRule="evenodd"
            />
        </svg>
    );
}
