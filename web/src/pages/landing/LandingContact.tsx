import hidden from '@/styles/visuallyHidden.module.css';
import styles from './LandingContact.module.css';
import { PartnerTile } from './PartnerTile';
import { CREATOR_DISCORD } from './partners';
import { useCopyText } from './useCopyText';
import { usePartnerServers } from './usePartnerServers';

const HANDLE = `@${CREATOR_DISCORD}`;
const HINT = { idle: 'Click to copy', copied: 'Copied!', failed: 'Copy failed' } as const;

/**
 * The contact block (design/mockups/index.html `.contact`, DESIGN.md §4.3 and §4.4): the creator
 * card with the Discord copy pill, then the partner communities (S14.4p: the rows of the public
 * `partner_server` table, one tile each, centred however many there are).
 */
export function LandingContact() {
    const { partners } = usePartnerServers();
    return (
        <section className={styles.contact} aria-labelledby="landing-contact">
            <div className={styles.inner}>
                <p className={styles.label}>Contact</p>
                <h2 id="landing-contact" className={styles.heading}>
                    Get in <span className={styles.accent}>Touch</span>
                </h2>
                <p className={styles.body}>Built for the competitive Honkai Star Rail community</p>

                <div className={styles.creator}>
                    <p className={styles.creatorEyebrow}>Creator</p>
                    <p className={styles.creatorLine}>
                        Built by <strong>Nathyron</strong> — hit me on discord if you wanna chat
                    </p>
                    <CopyHandle />
                </div>

                {/*
                 * Hidden until the rows arrive and while there are none: nothing is reserved, so an
                 * empty list leaves no gap. The block sits at the bottom of the page, below the fold
                 * at first paint, so its arrival does not move what the visitor is reading.
                 */}
                {partners.length > 0 && (
                    <div className={styles.rail}>
                        <h3 className={styles.railLabel}>Partner Communities</h3>
                        <ul className={styles.grid}>
                            {partners.map((p) => (
                                <li key={p.id} className={styles.slot}>
                                    <PartnerTile partner={p} />
                                </li>
                            ))}
                        </ul>
                    </div>
                )}
            </div>
        </section>
    );
}

/**
 * The inline copy pill (DESIGN.md §5.4; web-guidance `copy-button.md`). Its visible text is its
 * name; the result is shown on the pill (green, check icon, the hint's text) and said by the
 * status region next to it. On phones the hint is hidden at rest and shows only with a result.
 */
function CopyHandle() {
    const { state, message, copy } = useCopyText(CREATOR_DISCORD, {
        copied: `Copied ${HANDLE} to clipboard`,
        failed: `Could not copy ${HANDLE}`,
    });
    return (
        <>
            <button
                type="button"
                className={styles.copy}
                data-state={state}
                onClick={() => void copy()}
            >
                {state === 'copied' ? <CheckIcon /> : <CopyIcon />}
                <span className={hidden.visuallyHidden}>Copy Discord username</span>{' '}
                <span className={styles.username}>{HANDLE}</span>
                <span className={styles.copyDivider} aria-hidden="true" />
                <span className={styles.hint} aria-hidden="true">
                    {HINT[state]}
                </span>
            </button>
            <p className={hidden.visuallyHidden} role="status">
                {message}
            </p>
        </>
    );
}

function CopyIcon() {
    return (
        <svg
            className={styles.icon}
            viewBox="0 0 24 24"
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
            <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
        </svg>
    );
}

function CheckIcon() {
    return (
        <svg
            className={styles.icon}
            viewBox="0 0 24 24"
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d="M20 6 9 17l-5-5" />
        </svg>
    );
}
