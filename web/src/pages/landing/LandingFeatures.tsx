import { Link } from '@tanstack/react-router';
import auctionImage from '@/assets/landing/auction.webp';
import balanceImage from '@/assets/landing/balance.webp';
import classicImage from '@/assets/landing/classic.webp';
import teamImage from '@/assets/landing/team.webp';
import tournamentImage from '@/assets/landing/tournament.webp';
import styles from './LandingFeatures.module.css';

/** Every card image is 1920 by 1080, below the fold, decorative (the card's text names it). */
const CARD_W = 1920;
const CARD_H = 1080;

function CardImage({ src }: { src: string }) {
    return (
        <img
            className={styles.image}
            src={src}
            width={CARD_W}
            height={CARD_H}
            alt=""
            loading="lazy"
            decoding="async"
        />
    );
}

function Index({ n, name }: { n: string; name: string }) {
    return (
        <span className={styles.index}>
            {n} <span>· {name}</span>
        </span>
    );
}

/**
 * The features bento (design/mockups/index.html `.features`, DESIGN.md §4.2): four link cards on
 * a 12-column grid, card 01 with its Classic and Auction halves. Interim targets until the
 * dialogs and pages exist (S14.4a): 01 the lobbies page, 02 the tournaments page.
 */
export function LandingFeatures() {
    return (
        <section className={styles.features} aria-labelledby="landing-features">
            {/* A div, not a header: the page has one banner, the shell's bar. */}
            <div className={styles.head}>
                <div>
                    <p className={styles.eyebrow}>{'// IPC Capabilities'}</p>
                    <h2 id="landing-features" className={styles.heading}>
                        The whole competitive stack. <em>In one page.</em>
                    </h2>
                </div>
            </div>

            <div className={styles.bento}>
                <Link to="/lobbies" className={`${styles.card} ${styles.wide} ${styles.combo}`}>
                    <div className={styles.comboHalves}>
                        <div className={styles.half}>
                            <CardImage src={classicImage} />
                            <span className={styles.halfLabel}>Classic</span>
                        </div>
                        <div className={styles.half}>
                            <CardImage src={auctionImage} />
                            <span className={styles.halfLabel}>Auction</span>
                        </div>
                    </div>
                    <Index n="01" name="Draft Modes" />
                    <div className={styles.body}>
                        <h3 className={styles.title}>Two ways to draft.</h3>
                        <p className={styles.desc}>
                            Two flagship draft modes — Classic and Auction. Pick your discipline;
                            both lead to the bracket.
                        </p>
                        <span className={styles.cta}>
                            Choose your draft <span className={styles.ctaArrow} />
                        </span>
                    </div>
                </Link>

                <Link to="/tournaments" className={`${styles.card} ${styles.tall}`}>
                    <CardImage src={tournamentImage} />
                    <Index n="02" name="Bracket System" />
                    <div className={styles.body}>
                        <h3 className={styles.title}>Tournaments</h3>
                        <p className={styles.desc}>
                            Built-in bracket system. Self-host single &amp; double-elimination
                            championships end-to-end.
                        </p>
                    </div>
                </Link>

                <Link to="/costs" className={`${styles.card} ${styles.half6}`}>
                    <CardImage src={balanceImage} />
                    <Index n="03" name="Balance" />
                    <div className={styles.body}>
                        <h3 className={styles.title}>Balance &amp; Cost Tables</h3>
                        <p className={styles.desc}>
                            Curated cost tables and balance tuning behind every match — fair,
                            competitive, transparent.
                        </p>
                    </div>
                </Link>

                <Link to="/teambuilder" className={`${styles.card} ${styles.half6}`}>
                    <CardImage src={teamImage} />
                    <Index n="04" name="Squad" />
                    <div className={styles.body}>
                        <h3 className={styles.title}>Team Builder</h3>
                        <p className={styles.desc}>
                            Stress-test compositions across balance, draft mode, and game type
                            before you queue.
                        </p>
                    </div>
                </Link>
            </div>
        </section>
    );
}
