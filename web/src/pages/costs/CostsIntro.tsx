import { useId, useState } from 'react';
import { ChevronUpIcon } from './CostIcons';
import styles from './CostsIntro.module.css';

/*
 * The intro band (the mockup's `.workshopHead`) with its hide control. The page has exactly one
 * `h1` in both states: the headline while the intro shows, the slim "Cost Tables" label once it
 * is hidden. The choice is remembered in `localStorage` under the mockup's key `hsr_intro_hidden`
 * ("1" hidden, "0" shown), shared by every page with an intro; storage may be blocked, so every
 * access is guarded and the intro then simply shows.
 */

export const INTRO_KEY = 'hsr_intro_hidden';

function readHidden(): boolean {
    try {
        return localStorage.getItem(INTRO_KEY) === '1';
    } catch {
        return false;
    }
}

function writeHidden(hidden: boolean): void {
    try {
        localStorage.setItem(INTRO_KEY, hidden ? '1' : '0');
    } catch {
        // Blocked storage: the choice lasts for this page only.
    }
}

export function CostsIntro({ onToggle }: { onToggle?: () => void }) {
    const [hidden, setHidden] = useState(readHidden);
    const innerId = useId();
    const toggle = () => {
        const next = !hidden;
        setHidden(next);
        writeHidden(next);
        onToggle?.();
    };
    const action = hidden ? 'Show intro' : 'Hide intro';

    return (
        <header className={styles.head} data-collapsed={hidden || undefined}>
            <button
                type="button"
                className={styles.toggle}
                aria-expanded={!hidden}
                aria-controls={hidden ? undefined : innerId}
                aria-label={action}
                title={action}
                onClick={toggle}
            >
                <ChevronUpIcon className={styles.toggleIcon} />
            </button>
            {hidden ? (
                <h1 className={styles.collapsedLabel}>Cost Tables</h1>
            ) : (
                <div className={styles.inner} id={innerId}>
                    <h1 className={styles.title}>
                        The <em>cost</em> of every pick.
                    </h1>
                    <p className={styles.deck}>
                        Each unit and light cone carries a cost that scales with eidolon and
                        superimposition. Flip the <strong>draft mode</strong> and{' '}
                        <strong>game mode</strong> to see how the ledger shifts. Classic budgets are
                        fixed; Auction values seed the opening bid.
                    </p>
                </div>
            )}
        </header>
    );
}
