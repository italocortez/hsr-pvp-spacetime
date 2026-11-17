import type { HsrCharacter, HsrLightcone } from '@bindings/types';
import {
    type KeyboardEvent,
    useEffect,
    useId,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import { EDGE, GAP, placePanel } from '@/components/MultiSelectDropdown/MultiSelectDropdown';
import { formatCostFixed as formatCost } from '@/lib/rosterModel';
import styles from './LightconePicker.module.css';
import { lightconeCandidates } from './lightconeCandidates';

/*
 * A slot's light cone search (S14.3a; the mockup's `.lcPick` bar, `.lcSearch` field and `.lcResults` panel). The
 * field is the bar at the slot's bottom edge: collapsed until the slot is hovered or something in it has focus
 * (the slot's stylesheet does the expanding, through the class names passed in), its placeholder names the
 * equipped cone ("S1 Name") or says "Select lightcone…". Focus or a click opens the results; the slot's cone area
 * (`tapClassName`, over the cone art) focuses the field on a tap, so touch needs no hover.
 *
 * The field is a combobox (`aria-controls` the list, `aria-activedescendant`, `aria-autocomplete="list"`) over a
 * `listbox`; ArrowDown and ArrowUp move the active option, Enter equips it, Escape closes (focus stays in the
 * field; also from "Unequip Lightcone"), Tab or a press outside closes. A pick or Unequip is announced; made with a
 * pointer or a tap it blurs the field (the bar closes, the cone shows), by keyboard focus stays in the field.
 * "Unequip Lightcone" is a button of its own while one is equipped. With
 * an empty search the panel says "Start typing to search…" and offers the signature cone (the mockup).
 *
 * The list is text only: no light cone image is loaded by the picker. The panel escapes the slot's clipping in the
 * top layer (a manual popover) or as a fixed box where the Popover API is missing, placed by the shared rule
 * (`placePanel`, component-hygiene Rule 6c). The result count is announced once typing settles.
 */

/** The panel's width and its height cap (`max-block-size` in LightconePicker.module.css). */
const PANEL_WIDTH = 260;
const PANEL_CAP = 260;

const canPopover = () =>
    typeof HTMLElement !== 'undefined' &&
    typeof (HTMLElement.prototype as { showPopover?: unknown }).showPopover === 'function';

export function LightconePicker({
    character,
    characterName,
    equipped,
    equippedKey,
    superimposition,
    lightcones,
    costOf,
    onEquip,
    announce,
    pickClassName,
    searchClassName,
    tapClassName,
}: {
    character: HsrCharacter | undefined;
    /** The name used in the labels (the display name, or the key of an unavailable character). */
    characterName: string;
    equipped: HsrLightcone | undefined;
    /** The equipped key, also when the reference set does not know it (shown as unavailable). */
    equippedKey: string | null;
    superimposition: number;
    /** Sorted by display name. */
    lightcones: readonly HsrLightcone[];
    /** The cone's S1 cost in the chosen set and modes, undefined for a missing row. */
    costOf: (name: string) => number | undefined;
    onEquip: (name: string | null) => void;
    announce?: (text: string) => void;
    /** The slot's layout for the bar, the field and the tap area (the slot's stylesheet owns its hover rules). */
    pickClassName: string;
    searchClassName: string;
    tapClassName: string;
}) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [active, setActive] = useState(0);
    const inputRef = useRef<HTMLInputElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    // A focus the picker gives back itself (after a pick or Unequip) does not open the panel again.
    const quiet = useRef(false);
    const baseId = useId();
    const listId = `${baseId}-list`;
    const optionId = (i: number) => `${baseId}-opt-${i}`;

    const candidates = useMemo(
        () => (open ? lightconeCandidates(query, character, lightcones, equippedKey) : []),
        [open, query, character, lightcones, equippedKey],
    );

    const close = (returnFocus: boolean) => {
        setOpen(false);
        setQuery('');
        setActive(0);
        if (returnFocus && document.activeElement !== inputRef.current) {
            quiet.current = true;
            inputRef.current?.focus();
            quiet.current = false;
        }
    };

    // Show in the top layer and place; keep placed while open (the bar grows as it opens: placed again then).
    useLayoutEffect(() => {
        const panel = panelRef.current;
        const input = inputRef.current;
        if (!open || !panel || !input) return;
        if (canPopover()) (panel as HTMLElement & { showPopover(): void }).showPopover();
        const place = () => {
            const b = input.getBoundingClientRect();
            const top =
                Number.parseFloat(
                    getComputedStyle(document.documentElement).getPropertyValue('--shell-offset'),
                ) || 56;
            // The side is decided by the panel's capped height, not by what it holds when it opens ("Start typing…"
            // is short): the results then grow inside a room that can hold them (review 2 M4).
            const size = { width: PANEL_WIDTH, height: PANEL_CAP };
            const viewport = { width: window.innerWidth, height: window.innerHeight, top };
            let p = placePanel(b, size, viewport);
            // The mockup opens the results above the bar (the bar is the card's bottom edge): above whenever the
            // capped panel fits there; otherwise the shared rule's choice.
            const above = b.top - GAP - (top + EDGE);
            if (p.side === 'below' && size.height <= above)
                p = {
                    side: 'above',
                    left: p.left,
                    width: p.width,
                    bottom: window.innerHeight - b.top + GAP,
                    room: above,
                };
            // The panel's left edge on the bar's left edge, as the mockup, moved inward to stay inside the viewport
            // (review 2, slot-card difference 6; `placePanel` aligns end edges).
            p.left = Math.max(EDGE, Math.min(b.left, window.innerWidth - EDGE - p.width));
            panel.style.left = `${p.left}px`;
            panel.style.width = `${p.width}px`;
            panel.style.top = p.side === 'below' ? `${p.top}px` : 'auto';
            panel.style.bottom = p.side === 'above' ? `${p.bottom}px` : 'auto';
            panel.style.setProperty('--lc-room', `${p.room}px`);
        };
        place();
        window.addEventListener('resize', place);
        window.addEventListener('scroll', place, true);
        input.addEventListener('transitionend', place);
        return () => {
            window.removeEventListener('resize', place);
            window.removeEventListener('scroll', place, true);
            input.removeEventListener('transitionend', place);
            if (canPopover() && panel.matches(':popover-open'))
                (panel as HTMLElement & { hidePopover(): void }).hidePopover();
        };
    }, [open]);

    // A press outside the field and the panel closes it (focus stays where the press put it).
    useEffect(() => {
        if (!open) return;
        const onDown = (event: PointerEvent) => {
            const t = event.target as Node;
            if (panelRef.current?.contains(t) || inputRef.current?.contains(t)) return;
            close(false);
        };
        document.addEventListener('pointerdown', onDown);
        return () => document.removeEventListener('pointerdown', onDown);
    });

    // The result count, once typing has held still (review M6).
    const count = candidates.length;
    useEffect(() => {
        if (!open || !announce || query.trim() === '') return;
        const timer = setTimeout(
            () =>
                announce(
                    count === 0
                        ? 'No lightcones found.'
                        : `${count} ${count === 1 ? 'lightcone' : 'lightcones'} found.`,
                ),
            600,
        );
        return () => clearTimeout(timer);
    }, [open, query, count, announce]);

    // Focus leaving the field and the panel (Tab, or a click elsewhere that takes focus) closes it.
    const onBlur = (event: { relatedTarget: EventTarget | null }) => {
        const next = event.relatedTarget as Node | null;
        if (next && (panelRef.current?.contains(next) || next === inputRef.current)) return;
        close(false);
    };

    /**
     * Equips `name` (null: unequips) and announces it. A pick made with a pointer or a tap (`pointer`) ends the
     * search: the field is blurred, so the bar closes and the cone shows again where there is no hover (review 2
     * S2). A pick by keyboard (Enter, or a click with no pointer behind it, `detail` 0) keeps focus in the field.
     */
    const equip = (name: string | null, pointer: boolean) => {
        onEquip(name);
        const cone = name === null ? undefined : lightcones.find((l) => l.name === name);
        announce?.(
            name === null
                ? `Light cone removed from ${characterName}.`
                : `${cone?.displayName ?? name} equipped on ${characterName}.`,
        );
        if (pointer) {
            close(false);
            inputRef.current?.blur();
        } else close(true);
    };

    // Escape anywhere in the panel ("Unequip Lightcone" has focus after a Tab) closes it, focus to the field.
    const onPanelKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        close(true);
    };

    const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (!open) {
                setOpen(true);
                return;
            }
            if (candidates.length === 0) return;
            const step = event.key === 'ArrowDown' ? 1 : -1;
            setActive((a) => (a + step + candidates.length) % candidates.length);
        } else if (event.key === 'Enter') {
            if (!open) return;
            event.preventDefault();
            // Enter that confirms an input method's composition is not a pick (forms/ime-safe-enter-submit.md).
            if (event.nativeEvent.isComposing) return;
            const pick = candidates[active];
            if (pick) equip(pick.cone.name, false);
        } else if (event.key === 'Escape' && open) {
            event.preventDefault();
            event.stopPropagation();
            close(true);
        }
    };

    // Keep the active option in view.
    useEffect(() => {
        if (!open) return;
        document.getElementById(optionId(active))?.scrollIntoView?.({ block: 'nearest' });
    });

    const popover = (canPopover() ? { popover: 'manual' } : {}) as Record<string, string>;
    const name =
        equipped?.displayName ?? (equippedKey ? `${equippedKey} (unavailable)` : undefined);
    const empty = query.trim() === '';

    return (
        <>
            {/* A pointer and touch shortcut to the field below (keyboard users reach the field with Tab). */}
            <div
                className={tapClassName}
                aria-hidden="true"
                onClick={() => {
                    inputRef.current?.focus();
                    setOpen(true);
                }}
            />
            {/* `data-open`: the bar stays open while the panel is, also when focus is in the top-layer panel
                (Chromium does not carry `:focus-within` out of it; review 2 M2). */}
            <div className={pickClassName} data-open={open ? '' : undefined}>
                <input
                    ref={inputRef}
                    type="text"
                    className={searchClassName}
                    role="combobox"
                    aria-label={`Light cone for ${characterName}: ${name ?? 'none'}`}
                    aria-expanded={open}
                    aria-controls={open ? listId : undefined}
                    aria-autocomplete="list"
                    aria-activedescendant={
                        open && candidates.length > 0 ? optionId(active) : undefined
                    }
                    placeholder={name ? `S${superimposition} ${name}` : 'Select lightcone…'}
                    autoComplete="off"
                    spellCheck={false}
                    value={query}
                    data-lc-search=""
                    onFocus={() => {
                        if (!quiet.current) setOpen(true);
                    }}
                    onClick={() => setOpen(true)}
                    onChange={(e) => {
                        setQuery(e.currentTarget.value);
                        setActive(0);
                        setOpen(true);
                    }}
                    onKeyDown={onKeyDown}
                    onBlur={onBlur}
                />
                {open && (
                    // biome-ignore lint/a11y/noStaticElementInteractions: Escape from "Unequip Lightcone" bubbles here
                    <div
                        ref={panelRef}
                        className={styles.panel}
                        onKeyDown={onPanelKeyDown}
                        {...popover}
                    >
                        {equippedKey && (
                            <button
                                type="button"
                                className={styles.unequip}
                                onPointerDown={(e) => e.preventDefault()}
                                onClick={(e) => equip(null, e.detail > 0)}
                                onBlur={onBlur}
                            >
                                Unequip Lightcone
                            </button>
                        )}
                        {(empty || candidates.length === 0) && (
                            <p className={styles.info}>
                                {empty ? 'Start typing to search…' : 'No lightcones found.'}
                            </p>
                        )}
                        <div
                            id={listId}
                            role="listbox"
                            aria-label="Light cones"
                            tabIndex={-1}
                            className={styles.list}
                        >
                            {candidates.map(({ cone, signature }, i) => {
                                const cost = costOf(cone.name);
                                return (
                                    // biome-ignore lint/a11y/useKeyWithClickEvents: the combobox's keys pick the active option (aria-activedescendant)
                                    <div
                                        key={cone.name}
                                        id={optionId(i)}
                                        role="option"
                                        tabIndex={-1}
                                        aria-selected={i === active}
                                        className={styles.option}
                                        data-signature={signature || undefined}
                                        data-tier={Math.min(cone.rarity, 5)}
                                        onPointerDown={(e) => e.preventDefault()}
                                        onClick={(e) => equip(cone.name, e.detail > 0)}
                                    >
                                        <span className={styles.optionName}>
                                            {cone.displayName}
                                            {signature && (
                                                <span className={styles.hint}>
                                                    {characterName}’s Signature
                                                </span>
                                            )}
                                        </span>
                                        <span className={styles.optionCost}>
                                            {cost === undefined ? 'n/a' : formatCost(cost)}
                                        </span>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                )}
            </div>
        </>
    );
}
