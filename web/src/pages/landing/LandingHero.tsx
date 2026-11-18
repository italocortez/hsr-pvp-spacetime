import { Link } from '@tanstack/react-router';
import heroImage from '@/assets/landing/landingpage2.webp';
import slanted from '@/styles/slantedFocus.module.css';
import styles from './LandingHero.module.css';

/** `landingpage2.webp`, 3168 by 1344: the page's largest paint. */
const HERO = { src: heroImage, width: 3168, height: 1344 };

/**
 * The landing hero (design/mockups/index.html `.hero`, DESIGN.md §4.1): full-bleed art with the
 * warm bloom, three scrims, the title column and the hero "Play Now" CTA (DESIGN.md §5.1, 64px,
 * continuous pulse and shimmer). Every auto-running animation is opted in under
 * `prefers-reduced-motion: no-preference` (the module).
 */
export function LandingHero() {
    return (
        <section className={styles.hero} aria-labelledby="landing-title">
            <img
                className={styles.image}
                src={HERO.src}
                width={HERO.width}
                height={HERO.height}
                alt=""
                // LCP image. React 18 does not know the camelCase prop yet: pass the attribute.
                {...{ fetchpriority: 'high' }}
            />
            <div className={styles.bloom} aria-hidden="true" />
            <div className={styles.bloomCore} aria-hidden="true" />
            <div className={styles.vignette} aria-hidden="true" />
            <div className={styles.scrimLeft} aria-hidden="true" />
            <div className={styles.scrimBottom} aria-hidden="true" />

            <div className={styles.overlay}>
                <p className={styles.label}>{'HONKAI · STAR RAIL // PVP'}</p>
                <h1 id="landing-title" className={styles.title}>
                    IPC Battlegrounds
                </h1>
                <p className={styles.subtitle}>Draft. Battle. Win.</p>
                {/* Interim target until the create-lobby dialog exists (S14.4c). */}
                <Link className={`${styles.cta} ${slanted.slanted}`} to="/lobbies">
                    <span className={styles.ctaFill} aria-hidden="true" />
                    <span className={styles.ctaLabel}>Play Now</span>
                    <span className={styles.ctaArrow} aria-hidden="true" />
                </Link>
                <div className={styles.divider} aria-hidden="true" />
                <div className={styles.scrollCue} aria-hidden="true">
                    <span>Scroll to Explore</span>
                    <div className={styles.scrollLine} />
                </div>
            </div>
        </section>
    );
}
