import hidden from '@/styles/visuallyHidden.module.css';
import styles from './RarityBadge.module.css';

/*
 * The rarity badge of the cost tables (S14.2; the mockup's `.rarityBadge`): the number and a star
 * on the rarity colour (`--lc-5star`, `--lc-4star`, and `--lc-3star` for 3-star light cones, user
 * ruling 2026-11-16 item 4). Read as "5 star". The star is the one copy of that glyph.
 */

export function RarityBadge({ rarity }: { rarity: number }) {
    const tier = rarity >= 5 ? '5' : rarity === 4 ? '4' : '3';
    return (
        <span className={styles.badge} data-tier={tier}>
            {rarity}
            <StarIcon />
            <span className={hidden.visuallyHidden}> star</span>
        </span>
    );
}

function StarIcon() {
    return (
        <svg className={styles.star} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M12 2l2.9 6.3 6.9.6-5.2 4.5 1.6 6.7L12 17l-6.2 3.6 1.6-6.7L2.2 8.9l6.9-.6z" />
        </svg>
    );
}
