import { useRef, useState } from 'react';
import heroImage from '@/assets/landing/landingpage2.webp';
import {
    CREATE_LOBBY_LOAD_FAILED,
    type CreateLobbyFlowType,
    loadCreateLobbyFlow,
    loadedCreateLobbyFlow,
    preloadCreateLobbyFlow,
} from '@/pages/create-lobby/createLobbyLoader';
import slanted from '@/styles/slantedFocus.module.css';
import styles from './LandingHero.module.css';

/** `landingpage2.webp`, 3168 by 1344: the page's largest paint. */
const HERO = { src: heroImage, width: 3168, height: 1344 };

/**
 * The landing hero (design/mockups/index.html `.hero`, DESIGN.md §4.1): full-bleed art with the
 * warm bloom, three scrims, the title column and the hero "Play Now" CTA (DESIGN.md §5.1, 64px,
 * continuous pulse and shimmer). Every auto-running animation is opted in under
 * `prefers-reduced-motion: no-preference` (the module).
 *
 * "Play Now" (S14.4c, A221 R2 and R3) is a button: it loads the create-lobby chunk (started early on a hover or
 * focus), which makes a visitor a guest, sends a person who already holds a lobby there, and otherwise opens the
 * create dialog. While that runs the button is `aria-busy`; a failure is read out in the line under it.
 */
export function LandingHero() {
    const button = useRef<HTMLButtonElement>(null);
    const [Flow, setFlow] = useState<CreateLobbyFlowType | undefined>(loadedCreateLobbyFlow);
    const [request, setRequest] = useState(0);
    const [busy, setBusy] = useState(false);
    const [status, setStatus] = useState('');

    const playNow = () => {
        if (busy) return;
        setStatus('');
        if (Flow) {
            setRequest((n) => n + 1);
            return;
        }
        setBusy(true);
        loadCreateLobbyFlow().then(
            (component) => {
                setFlow(() => component);
                setBusy(false);
                setRequest((n) => n + 1);
            },
            () => {
                setBusy(false);
                setStatus(CREATE_LOBBY_LOAD_FAILED);
            },
        );
    };

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
                <button
                    ref={button}
                    type="button"
                    className={`${styles.cta} ${slanted.slanted}`}
                    aria-busy={busy}
                    onClick={playNow}
                    onPointerEnter={preloadCreateLobbyFlow}
                    onFocus={preloadCreateLobbyFlow}
                >
                    <span className={styles.ctaFill} aria-hidden="true" />
                    <span className={styles.ctaLabel}>Play Now</span>
                    <span className={styles.ctaArrow} aria-hidden="true" />
                </button>
                <p className={styles.status} role="status">
                    {status}
                </p>
                <div className={styles.divider} aria-hidden="true" />
                <div className={styles.scrollCue} aria-hidden="true">
                    <span>Scroll to Explore</span>
                    <div className={styles.scrollLine} />
                </div>
            </div>
            {Flow && (
                <Flow
                    request={request}
                    trigger={button.current}
                    onBusy={setBusy}
                    onStatus={setStatus}
                />
            )}
        </section>
    );
}
