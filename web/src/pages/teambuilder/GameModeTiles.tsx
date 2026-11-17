import { useId } from 'react';
import { MODE_LABEL, MODE_SHORT } from '@/lib/rosterModel';
import { GAME_MODES, type ModeParam } from '@/lib/rosterSearch';
import hidden from '@/styles/visuallyHidden.module.css';
import styles from './GameModeTiles.module.css';

/*
 * The game mode control, variant A (A190 item 14): the mockup's image tiles (`.modePicker`, landscape chips with
 * the art thumbnail, the short name and a dot), built on a native radio group: a `fieldset` named "Game Mode" of
 * `<input type="radio">`s, one per tile, each named by the mode's full name. The browser gives the keyboard
 * contract: one Tab stop (the checked tile), the arrow keys move and select, Space selects. The input itself is
 * visually hidden; the tile is its label and shows the focus ring. A custom cost set fixes the mode: the other
 * radios are disabled (the arrows skip them) and the reason is their description and the tiles' tooltip.
 * Images are local (`web/public/game_modes`), decorative.
 */

const IMAGE: Record<ModeParam, string> = {
    as: '/game_modes/apocalypticshadow.webp',
    moc: '/game_modes/memoryofchaos.webp',
    aa: '/game_modes/anomalyarbitration.webp',
};

export function GameModeTiles({
    value,
    onChange,
    lockedReason,
}: {
    value: ModeParam;
    onChange: (mode: ModeParam) => void;
    /** Set while a custom cost set fixes the mode: the other tiles are disabled with this reason. */
    lockedReason?: string;
}) {
    const name = useId();
    const reasonId = `${name}-reason`;

    return (
        <div className={styles.field}>
            <span className={styles.label} aria-hidden="true">
                Game Mode
            </span>
            <fieldset className={styles.tiles}>
                <legend className={hidden.visuallyHidden}>Game Mode</legend>
                {GAME_MODES.map((m) => {
                    const checked = m === value;
                    const disabled = !checked && lockedReason !== undefined;
                    return (
                        <label
                            key={m}
                            className={styles.tile}
                            data-on={checked || undefined}
                            data-disabled={disabled || undefined}
                            title={disabled ? lockedReason : MODE_LABEL[m]}
                        >
                            <input
                                type="radio"
                                className={hidden.visuallyHidden}
                                name={name}
                                value={m}
                                checked={checked}
                                disabled={disabled}
                                aria-label={MODE_LABEL[m]}
                                aria-describedby={disabled ? reasonId : undefined}
                                onChange={() => onChange(m)}
                            />
                            <img src={IMAGE[m]} alt="" width={30} height={30} />
                            <span className={styles.name} aria-hidden="true">
                                {MODE_SHORT[m]}
                            </span>
                            <span className={styles.mark} aria-hidden="true" />
                        </label>
                    );
                })}
            </fieldset>
            {lockedReason !== undefined && (
                <span id={reasonId} className={hidden.visuallyHidden}>
                    {lockedReason}
                </span>
            )}
        </div>
    );
}
