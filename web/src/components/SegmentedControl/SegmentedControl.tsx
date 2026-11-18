import {
    type KeyboardEvent,
    type ReactNode,
    type SelectHTMLAttributes,
    useId,
    useRef,
} from 'react';
import hidden from '@/styles/visuallyHidden.module.css';
import styles from './SegmentedControl.module.css';

/*
 * A single-choice segmented control (S14.2, the cost tables' control bar; built for the team
 * builder too). One look, two meanings, chosen by `semantics`:
 *
 * - `buttons` (the default): a labelled group (`fieldset`) of toggle buttons with `aria-pressed`, one
 *   pressed at a time (web-guidance accessibility "Manage toggle states", dynamic-sort "label the
 *   current state"). Every button is a Tab stop; Enter, Space or a click picks it. For a setting
 *   that filters what is shown (draft mode, game mode).
 * - `tabs`: the ARIA tabs pattern (web-guidance ui-components/tabs.md) for a switch between
 *   views of one panel: `role="tablist"` with `role="tab"` buttons and `aria-selected`; a roving
 *   tabindex (only the selected tab is a Tab stop, so focus entering the list lands on it);
 *   ArrowLeft / ArrowRight (wrapping), Home and End move focus; Enter, Space or a click selects.
 *   Selection by activation, not on focus, because selecting writes the address (the guide's
 *   rule for tabs with side effects). `focusgroup` is not used: Chromium only, no polyfill
 *   without approval. The caller labels its panel with `tabId(value)`; no `aria-controls` (the
 *   guide: no screen reader uses it).
 *
 * An option can be disabled with a reason: it keeps its place in the Tab order
 * (`aria-disabled`), ignores activation, and its reason is its description (`aria-describedby`)
 * and its tooltip, so assistive technology hears why.
 *
 * The visible label ("Draft Mode") is decorative next to the group's accessible name; the frame
 * hides it on narrow screens as the mockup does (the name stays).
 */

export type SegmentOption<V extends string> = {
    value: V;
    label: ReactNode;
    /** Accessible name when the visible label is an abbreviation ("AS"). */
    ariaLabel?: string;
    /** Tooltip; defaults to `ariaLabel`. */
    title?: string;
    /** Set: the option is disabled and this text says why. */
    disabledReason?: string;
};

export type SegmentedControlProps<V extends string> = {
    /** Visible label and accessible name of the group ("Draft Mode"). */
    label: string;
    options: readonly SegmentOption<V>[];
    value: V;
    onChange: (value: V) => void;
    semantics?: 'buttons' | 'tabs';
    /** Tabs only: the prefix of the tab ids (`${idPrefix}-${value}`), for the panel's label. */
    idPrefix?: string;
    /** The champagne tone of the mockup's table switch. */
    tone?: 'brand' | 'prestige';
    /**
     * False: the pill shows no label of its own (S14.4c: a form field whose label sits above it); `label` still names
     * the group.
     */
    showLabel?: boolean;
};

/** The id `SegmentedControl` gives the tab of `value` (tabs semantics). */
export function tabId(idPrefix: string, value: string): string {
    return `${idPrefix}-${value}`;
}

export function SegmentedControl<V extends string>({
    label,
    options,
    value,
    onChange,
    semantics = 'buttons',
    idPrefix,
    tone = 'brand',
    showLabel = true,
}: SegmentedControlProps<V>) {
    const reasonBase = useId();
    const generated = useId();
    const prefix = idPrefix ?? generated;
    const refs = useRef(new Map<V, HTMLButtonElement>());
    const isTabs = semantics === 'tabs';

    const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
        if (!isTabs) return;
        let next = -1;
        if (event.key === 'ArrowRight') next = (index + 1) % options.length;
        else if (event.key === 'ArrowLeft') next = (index - 1 + options.length) % options.length;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = options.length - 1;
        if (next < 0) return;
        event.preventDefault();
        const target = options[next];
        if (target) refs.current.get(target.value)?.focus();
    };

    const buttons = options.map((option, index) => {
        const selected = option.value === value;
        const disabled = option.disabledReason !== undefined;
        const reasonId = `${reasonBase}-${index}`;
        // A tab carries its selection, a toggle button its pressed state.
        const state = isTabs
            ? {
                  id: tabId(prefix, option.value),
                  role: 'tab' as const,
                  'aria-selected': selected,
                  tabIndex: selected ? undefined : -1,
              }
            : { 'aria-pressed': selected };
        return (
            <button
                key={option.value}
                ref={(el) => {
                    if (el) refs.current.set(option.value, el);
                    else refs.current.delete(option.value);
                }}
                type="button"
                className={styles.segment}
                {...state}
                aria-label={option.ariaLabel}
                title={option.disabledReason ?? option.title ?? option.ariaLabel}
                aria-disabled={disabled || undefined}
                aria-describedby={disabled ? reasonId : undefined}
                data-on={selected || undefined}
                onClick={() => {
                    if (disabled || selected) return;
                    onChange(option.value);
                }}
                onKeyDown={(e) => onKeyDown(e, index)}
            >
                {option.label}
            </button>
        );
    });
    // Outside the buttons, so a reason never becomes part of a button's name.
    const reasons = options.map((option, index) =>
        option.disabledReason === undefined ? null : (
            <span
                key={option.value}
                id={`${reasonBase}-${index}`}
                className={hidden.visuallyHidden}
            >
                {option.disabledReason}
            </span>
        ),
    );

    return (
        <ControlFrame label={showLabel ? label : undefined} tone={tone}>
            {isTabs ? (
                <div role="tablist" aria-label={label} className={styles.items}>
                    {buttons}
                </div>
            ) : (
                <fieldset aria-label={label} className={styles.items}>
                    {buttons}
                </fieldset>
            )}
            {reasons}
        </ControlFrame>
    );
}

/**
 * The control bar's pill (the mockup's `.segGroup`): a decorative label and one control. Used by
 * `SegmentedControl` and `ControlSelect` (a native `<select>` beside it: the cost set picker).
 */
export function ControlFrame({
    label,
    tone = 'brand',
    children,
}: {
    /** The decorative label; none when undefined. */
    label: string | undefined;
    tone?: 'brand' | 'prestige';
    children: ReactNode;
}) {
    return (
        <div className={styles.frame} data-tone={tone}>
            {label !== undefined && (
                <span className={styles.label} aria-hidden="true">
                    {label}
                </span>
            )}
            {children}
        </div>
    );
}

/** A native `<select>` in the pill's look (single choice from a list that may be long). */
export function ControlSelect({
    label,
    tone,
    ...props
}: { label: string; tone?: 'brand' | 'prestige' } & Omit<
    SelectHTMLAttributes<HTMLSelectElement>,
    'className'
>) {
    return (
        <ControlFrame label={label} tone={tone}>
            <select aria-label={label} {...props} className={styles.select} />
        </ControlFrame>
    );
}
