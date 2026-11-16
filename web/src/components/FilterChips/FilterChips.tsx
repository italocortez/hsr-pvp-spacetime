import styles from './FilterChips.module.css';

/*
 * A multi-choice filter chip set (S14.2; the mockup's `.chipSet` with `.iconChip` / `.textChip`):
 * a labelled group (`fieldset`, named by `aria-label`) of toggle buttons with `aria-pressed`, any number on at once. Each
 * chip is a Tab stop; Enter, Space or a click toggles it. An icon chip is named by its label
 * (`aria-label`, with the same text as its tooltip), its image is decorative. Built for the team
 * builder too.
 */

export type ChipOption<V extends string> = {
    value: V;
    label: string;
    /** A same-origin icon (`/elements/fire.webp`): the chip shows it instead of the label. */
    icon?: string;
    /** The champagne "on" tone (the mockup's 5-star chip). */
    prestige?: boolean;
};

export type FilterChipsProps<V extends string> = {
    /** The group's accessible name ("Filter by element"). */
    label: string;
    options: readonly ChipOption<V>[];
    selected: readonly V[];
    onToggle: (value: V) => void;
    /** Icon groups claim more room in a wrapping row (the mockup's `flex-grow: 3`). */
    wide?: boolean;
};

export function FilterChips<V extends string>({
    label,
    options,
    selected,
    onToggle,
    wide = false,
}: FilterChipsProps<V>) {
    return (
        <fieldset aria-label={label} className={styles.set} data-wide={wide || undefined}>
            {options.map((option) => {
                const on = selected.includes(option.value);
                return (
                    <button
                        key={option.value}
                        type="button"
                        className={option.icon ? styles.iconChip : styles.textChip}
                        aria-pressed={on}
                        aria-label={option.icon ? option.label : undefined}
                        title={option.icon ? option.label : undefined}
                        data-prestige={option.prestige || undefined}
                        onClick={() => onToggle(option.value)}
                    >
                        {option.icon ? (
                            <img src={option.icon} alt="" width={18} height={18} />
                        ) : (
                            option.label
                        )}
                    </button>
                );
            })}
        </fieldset>
    );
}
