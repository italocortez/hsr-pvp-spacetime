import styles from './HudChip.module.css';

/** Mono HUD label with the pulsing champagne dot (DESIGN.md §5.2). Decorative: hidden from AT. */
export function HudChip({ label }: { label: string }) {
    return (
        <div className={styles.chip} aria-hidden="true">
            <span className={styles.dot} />
            <span>{label}</span>
        </div>
    );
}
