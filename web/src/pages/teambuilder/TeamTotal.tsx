import type { ActivePair, Missing } from '@shared/teambuilder';
import { formatModifier } from '@/lib/rosterModel';
import hidden from '@/styles/visuallyHidden.module.css';
import styles from './TeamTotal.module.css';

/*
 * The team's total (the mockup's `.costTotal`, "Total Cost" and the Σ value with one decimal) and the missing-row
 * warning (A190 item 6), and the synergy strip under the slots (the mockup's `.synergyStrip`: "Active Pairings"
 * and one chip per pair, or "none"). Pairs follow the chosen draft mode: a zero modifier is not listed, a negative
 * one shows a real minus sign (A185 item 3).
 */

export function TeamTotal({
    total,
    missing,
    nameOf,
    setLabel,
    ready = true,
}: {
    /** Hundredths. */
    total: number;
    /** False while the cost rows load: a placeholder instead of the figure (review S1). */
    ready?: boolean;
    missing: readonly Missing[];
    nameOf: (kind: Missing['kind'], key: string) => string;
    setLabel: string;
}) {
    return (
        <>
            <p className={styles.total}>
                <span className={styles.label}>Total Cost</span>
                <span className={styles.sigma}>
                    <span className={styles.sigmaMark} aria-hidden="true">
                        {'Σ '}
                    </span>
                    {ready ? (
                        (total / 100).toFixed(1)
                    ) : (
                        <>
                            <span aria-hidden="true">{'–.–'}</span>
                            <span className={hidden.visuallyHidden}>Cost loading</span>
                        </>
                    )}
                </span>
            </p>
            {missing.length > 0 && (
                <div className={styles.warning}>
                    <p>
                        <strong>n/a</strong> {missing.length === 1 ? 'is' : 'are'} not priced in the{' '}
                        {setLabel} cost set for these modes and count as 0 here. A lobby with this
                        set would refuse {missing.length === 1 ? 'it' : 'them'}:
                    </p>
                    <ul>
                        {missing.map((m) => (
                            <li key={`${m.slot}-${m.kind}`}>
                                {nameOf(m.kind, m.name)} (slot {m.slot + 1},{' '}
                                {m.kind === 'character' ? 'character' : 'light cone'})
                            </li>
                        ))}
                    </ul>
                </div>
            )}
        </>
    );
}

export function PairStrip({
    pairs,
    nameOf,
}: {
    pairs: readonly ActivePair[];
    nameOf: (key: string) => string;
}) {
    return (
        <div className={styles.strip}>
            <h3 className={styles.stripLabel}>Active Pairings</h3>
            {pairs.length === 0 ? (
                <p className={styles.none}>none</p>
            ) : (
                <ul className={styles.chips}>
                    {pairs.map((p) => (
                        <li key={`${p.characterA}|${p.characterB}`} className={styles.chip}>
                            <b>{nameOf(p.characterA)}</b>
                            <span className={styles.x} aria-hidden="true">
                                {'×'}
                            </span>
                            <span className={hidden.visuallyHidden}> and </span>
                            <b>{nameOf(p.characterB)}</b>
                            <span className={styles.modifier}>
                                {formatModifier(p.modifier / 100)}
                            </span>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
