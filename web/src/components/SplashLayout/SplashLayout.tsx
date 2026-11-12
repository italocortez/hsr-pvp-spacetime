import type { ReactNode } from 'react';
import { BrandLogo } from '@/components/BrandLogo/BrandLogo';
import { HudChip } from '@/components/HudChip/HudChip';
import { IpcButton } from '@/components/IpcButton/IpcButton';
import styles from './SplashLayout.module.css';

type Props = {
    /** Full-bleed background art (public path); decorative. */
    image: { src: string; width: number; height: number };
    hudLabel: string;
    hudCoord: string;
    eyebrow: string;
    title: ReactNode;
    lede: ReactNode;
    /** Optional block between the title and the lede (the standby module pill). */
    children?: ReactNode;
};

/**
 * Full-bleed editorial screen from design/mockups/standby.html (DESIGN.md §4.5): art + scrims,
 * brand mark, HUD chip, text column with one IPC CTA back to base, bottom HUD line.
 * Used by the standby and 404 pages.
 */
export function SplashLayout({ image, hudLabel, hudCoord, eyebrow, title, lede, children }: Props) {
    return (
        <main className={styles.splash}>
            <img
                className={styles.image}
                src={image.src}
                width={image.width}
                height={image.height}
                alt=""
                // LCP image. React 18 does not know the camelCase prop yet: pass the attribute.
                {...{ fetchpriority: 'high' }}
            />
            <div className={styles.scrimLeft} aria-hidden="true" />
            <div className={styles.scrimEdges} aria-hidden="true" />

            {/* The word is hidden on narrow screens; the label keeps the link's name (= the visible text). */}
            <a className={styles.brand} href="/" aria-label="IPC Battlegrounds">
                <BrandLogo className={styles.brandLogo} />
                <span className={styles.brandWord}>IPC Battlegrounds</span>
            </a>

            <div className={styles.hud}>
                <HudChip label={hudLabel} />
            </div>

            <div className={styles.overlay}>
                <p className={styles.eyebrow}>{eyebrow}</p>
                <h1 className={styles.title}>{title}</h1>
                {children}
                <p className={styles.lede}>{lede}</p>
                <div className={styles.cta}>
                    <IpcButton href="/">Return to Base</IpcButton>
                </div>
            </div>

            <div className={styles.bottomHud} aria-hidden="true">
                <span>{'IPC // Battlegrounds'}</span>
                <span className={`${styles.sep} ${styles.hudCoord}`} />
                <span className={styles.hudCoord}>{hudCoord}</span>
                <span className={styles.sep} />
                <span>v0.9</span>
            </div>
        </main>
    );
}
