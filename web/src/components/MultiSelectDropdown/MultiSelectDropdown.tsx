import {
    type CSSProperties,
    type KeyboardEvent,
    useEffect,
    useId,
    useLayoutEffect,
    useRef,
    useState,
} from 'react';
import hidden from '@/styles/visuallyHidden.module.css';
import styles from './MultiSelectDropdown.module.css';

/*
 * A dropdown multi-select for filters with many values (S14.2b; design/UI-DECISIONS.md: "Filters
 * with many values (for example the 12 archetypes) use a custom dropdown multi-select, not a row
 * of toggle chips"). Built for the costs page's archetype filter and the team builder.
 *
 * Pattern: a disclosure (a button with `aria-expanded`, and `aria-controls` while open) revealing
 * a named group of native checkboxes, not an ARIA menu or listbox: choices apply at once and
 * several stay on, which native checkboxes say and do by themselves (Space toggles, the state is
 * announced), and web-guidance menu.md reserves `menu` for commands. The panel is in the Tab
 * order right after the button; ArrowDown on the button opens it and enters the first option;
 * ArrowUp, ArrowDown, Home and End move between options in reading order (the options flow down
 * the first column, then the second, so ArrowDown goes down the visible column and on to the
 * next); ArrowLeft and ArrowRight do nothing, as on any native checkbox; Escape closes and
 * returns focus to the button; a press or focus outside closes; Tab past the last option leaves
 * (and closes): no trap.
 *
 * Presses inside: the whole option row is a `label` wrapping its checkbox, so a press anywhere on
 * it toggles. A press on content that cannot take focus moves focus to the nearest focusable
 * ancestor: the panel itself is that ancestor (`tabIndex={-1}`), and a focus that still lands on
 * an ancestor of the component during a press inside (the shell's `main`, or Safari, where a
 * click does not focus a checkbox) is not counted as outside.
 *
 * Placement: the panel must escape a clipping ancestor (a card with `overflow: hidden`). Where
 * the Popover API exists it is a manual popover in the top layer; otherwise a fixed box (not
 * clipped by an `overflow` ancestor either). One rule for both paths (`placePanel`): the usable
 * area is the viewport less `EDGE` on every side and less the fixed bar (`--shell-offset`) at
 * the top; the panel opens below the button when its height (at most the CSS cap) fits there,
 * otherwise on the side with more room; its height is at most the room on that side and it
 * scrolls inside itself. On both paths the script picks the side and writes the room
 * (`--ms-room`) on open, resize and scroll. Where CSS anchor positioning exists the CSS tethers
 * the panel to the button on that side (it follows the button while the page scrolls with no
 * lag); otherwise the script also writes the coordinates (the menu guide's fallback).
 */

export type MultiSelectOption = { value: string; label: string };

export type MultiSelectDropdownProps = {
    /** The group's name, shown on the button ("Archetype"). */
    label: string;
    /** The options' group name for assistive technology ("Filter by archetype"). */
    listLabel: string;
    options: readonly MultiSelectOption[];
    selected: readonly string[];
    onToggle: (value: string) => void;
    /** Shown in the panel while there are no options (still loading, say). */
    emptyText: string;
};

/** Room kept between the panel and the viewport's edges, and between it and the button. */
export const EDGE = 16;
export const GAP = 6;

type Box = { left: number; right: number; top: number; bottom: number };

export type Placement = {
    side: 'below' | 'above';
    left: number;
    /** The panel's width, capped to the viewport less `EDGE` on both sides. */
    width: number;
    /** Below: the panel's top edge. */
    top?: number;
    /** Above: the distance from the viewport's bottom to the panel's bottom edge. */
    bottom?: number;
    /** The room on the chosen side: the most the panel may be high (it scrolls inside). */
    room: number;
};

/**
 * The placement: below the button when the panel's `height` (its content, at most the CSS cap)
 * fits there, otherwise on the side with more room; its end edge on the button's end edge, moved
 * inward to stay `EDGE` inside the viewport. The usable area is the viewport less `EDGE` on every
 * side and less `viewport.top` (the fixed bar's height) at the top.
 */
export function placePanel(
    anchor: Box,
    panel: { width: number; height: number },
    viewport: { width: number; height: number; top: number },
): Placement {
    const width = Math.max(0, Math.min(panel.width, viewport.width - 2 * EDGE));
    const left = Math.max(EDGE, Math.min(anchor.right - width, viewport.width - EDGE - width));
    const below = viewport.height - EDGE - (anchor.bottom + GAP);
    const above = anchor.top - GAP - (viewport.top + EDGE);
    if (panel.height <= below || below >= above) {
        return { side: 'below', left, width, top: anchor.bottom + GAP, room: Math.max(0, below) };
    }
    return {
        side: 'above',
        left,
        width,
        bottom: viewport.height - anchor.top + GAP,
        room: Math.max(0, above),
    };
}

/** The panel's checkboxes, in order. */
const optionInputs = (panel: HTMLElement | null) =>
    Array.from(panel?.querySelectorAll<HTMLInputElement>('input') ?? []);

const canPopover = () =>
    typeof HTMLElement !== 'undefined' &&
    typeof (HTMLElement.prototype as { showPopover?: unknown }).showPopover === 'function';

const canAnchor = () => typeof CSS !== 'undefined' && CSS.supports?.('anchor-name: --a') === true;

/** A length custom property as px (0 when unset or unknown). */
function px(style: CSSStyleDeclaration, name: string): number {
    const value = Number.parseFloat(style.getPropertyValue(name));
    return Number.isFinite(value) ? value : 0;
}

export function MultiSelectDropdown({
    label,
    listLabel,
    options,
    selected,
    onToggle,
    emptyText,
}: MultiSelectDropdownProps) {
    const [open, setOpen] = useState(false);
    const enterOnOpen = useRef(false);
    const wrapRef = useRef<HTMLDivElement>(null);
    const buttonRef = useRef<HTMLButtonElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const baseId = useId();
    const panelId = `${baseId}-panel`;
    // An anchor name per instance (useId's colons are not allowed in a dashed ident).
    const anchorName = `--ms${baseId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
    const count = selected.filter((v) => options.some((o) => o.value === v)).length;

    // Show the panel in the top layer and place it; keep it placed while open.
    useLayoutEffect(() => {
        const panel = panelRef.current;
        const button = buttonRef.current;
        if (!open || !panel || !button) return;
        if (canPopover()) (panel as HTMLElement & { showPopover(): void }).showPopover();
        const anchored = canAnchor();
        const place = () => {
            if (!anchored) panel.style.maxInlineSize = '';
            const style = getComputedStyle(panel);
            const cap = px(style, '--ms-cap') || Number.POSITIVE_INFINITY;
            const frame = panel.offsetHeight - panel.clientHeight;
            const p = placePanel(
                button.getBoundingClientRect(),
                {
                    width: panel.offsetWidth,
                    height: Math.min(panel.scrollHeight + frame, cap),
                },
                {
                    width: document.documentElement.clientWidth,
                    height: window.innerHeight,
                    top: px(style, '--shell-offset'),
                },
            );
            panel.dataset.side = p.side;
            panel.style.setProperty('--ms-room', `${p.room}px`);
            if (anchored) return;
            panel.style.left = `${p.left}px`;
            panel.style.maxInlineSize = `${p.width}px`;
            panel.style.top = p.top === undefined ? 'auto' : `${p.top}px`;
            panel.style.bottom = p.bottom === undefined ? 'auto' : `${p.bottom}px`;
        };
        // The panel's own scrolling moves nothing.
        const onScroll = (event: Event) => {
            if (event.target !== panel) place();
        };
        place();
        window.addEventListener('resize', place);
        window.addEventListener('scroll', onScroll, { capture: true, passive: true });
        return () => {
            window.removeEventListener('resize', place);
            window.removeEventListener('scroll', onScroll, { capture: true });
        };
    }, [open]);

    // A keyboard open enters the panel once it is shown.
    useEffect(() => {
        if (!open || !enterOnOpen.current) return;
        enterOnOpen.current = false;
        optionInputs(panelRef.current)[0]?.focus();
    }, [open]);

    // A press or focus outside closes (focus stays where it went: no trap, no jump back). A press
    // inside on content that cannot take focus sends focus to the nearest focusable ancestor: the
    // panel, or, past it, an ancestor of the component (the shell's `main`); that is not outside.
    useEffect(() => {
        if (!open) return;
        const isInside = (target: EventTarget | null) =>
            target instanceof Node && wrapRef.current?.contains(target) === true;
        let pressInside = false;
        const onPointerDown = (event: Event) => {
            pressInside = isInside(event.target);
            if (!pressInside) setOpen(false);
        };
        const onKeyDown = () => {
            pressInside = false;
        };
        const onFocusIn = (event: Event) => {
            const target = event.target;
            if (isInside(target)) return;
            const wrap = wrapRef.current;
            if (pressInside && target instanceof Node && wrap && target.contains(wrap)) return;
            setOpen(false);
        };
        document.addEventListener('pointerdown', onPointerDown);
        document.addEventListener('keydown', onKeyDown, { capture: true });
        document.addEventListener('focusin', onFocusIn);
        return () => {
            document.removeEventListener('pointerdown', onPointerDown);
            document.removeEventListener('keydown', onKeyDown, { capture: true });
            document.removeEventListener('focusin', onFocusIn);
        };
    }, [open]);

    const onWrapKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key !== 'Escape' || !open) return;
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        buttonRef.current?.focus();
    };

    const onButtonKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
        if (event.key !== 'ArrowDown') return;
        event.preventDefault();
        if (open) optionInputs(panelRef.current)[0]?.focus();
        else {
            enterOnOpen.current = true;
            setOpen(true);
        }
    };

    const onPanelKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        const list = optionInputs(panelRef.current);
        if (list.length === 0) return;
        const last = list.length - 1;
        const current = list.indexOf(document.activeElement as HTMLInputElement);
        // Focus on the panel itself (after a press on its padding): the arrows enter the list.
        const onPanel = current < 0 && document.activeElement === panelRef.current;
        if (current < 0 && !onPanel) return;
        let next: number | undefined;
        if (event.key === 'ArrowDown') next = onPanel ? 0 : Math.min(current + 1, last);
        else if (event.key === 'ArrowUp') next = onPanel ? last : Math.max(current - 1, 0);
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = last;
        if (next === undefined) return;
        event.preventDefault();
        list[next]?.focus();
    };

    // Unknown to React 18's types: passed as a plain attribute (web-guidance SKILL.md). Only
    // where the API exists: elsewhere a closed-looking `[popover]` could be hidden by the UA.
    const popover = (canPopover() ? { popover: 'manual' } : {}) as Record<string, string>;

    return (
        // biome-ignore lint/a11y/noStaticElementInteractions: Escape for the button and its panel
        <div
            ref={wrapRef}
            className={styles.wrap}
            onKeyDown={onWrapKeyDown}
            style={{ '--ms-anchor': anchorName } as CSSProperties}
        >
            <button
                ref={buttonRef}
                type="button"
                className={styles.button}
                aria-expanded={open}
                aria-controls={open ? panelId : undefined}
                data-on={count > 0 || undefined}
                onClick={(event) => {
                    // `detail` is 0 for a click made with Enter or Space: enter the panel then.
                    enterOnOpen.current = !open && event.detail === 0;
                    setOpen(!open);
                }}
                onKeyDown={onButtonKeyDown}
            >
                <span className={styles.label}>{label}</span>
                {/* A space in the name ("Archetype 2 selected"); a flex container drops it on screen. */}{' '}
                {count > 0 && (
                    <span className={styles.count}>
                        {count} <span className={hidden.visuallyHidden}>selected</span>
                    </span>
                )}
                <span className={styles.caret} aria-hidden="true" />
            </button>
            {open && (
                // biome-ignore lint/a11y/noStaticElementInteractions: arrow keys between the options
                <div
                    ref={panelRef}
                    id={panelId}
                    className={styles.panel}
                    // Focusable from script and by a press only: a press on an option's text or
                    // on the padding lands focus here, inside the component.
                    tabIndex={-1}
                    data-anchored={canAnchor() || undefined}
                    onKeyDown={onPanelKeyDown}
                    {...popover}
                >
                    <fieldset className={styles.group}>
                        <legend className={hidden.visuallyHidden}>{listLabel}</legend>
                        {options.length === 0 && <p className={styles.empty}>{emptyText}</p>}
                        {options.length > 0 && (
                            <div className={styles.columns}>
                                {options.map((option) => (
                                    <label key={option.value} className={styles.option}>
                                        <input
                                            type="checkbox"
                                            className={styles.check}
                                            checked={selected.includes(option.value)}
                                            onChange={() => onToggle(option.value)}
                                        />
                                        <span>{option.label}</span>
                                    </label>
                                ))}
                            </div>
                        )}
                    </fieldset>
                </div>
            )}
        </div>
    );
}
