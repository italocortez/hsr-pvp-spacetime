import {
    type FocusEvent,
    type PointerEvent,
    type ReactNode,
    useCallback,
    useEffect,
    useId,
    useLayoutEffect,
    useRef,
    useState,
} from 'react';
import { ExclamationIcon } from '@/components/ExclamationIcon/ExclamationIcon';
import styles from './InfoPopover.module.css';
import { type Align, placeInfoPopover, type Side } from './placeInfoPopover';

/*
 * The shared information popover (S14.3i, A210 items 6 to 8; the mockups' `.infoDot` and `.infoPopover`, lobbies.html,
 * index.html, lobbyroom.html). A trigger button (by default the circled exclamation mark, the site's one information
 * symbol) and a panel that floats beside it, in the top layer, so no card's overflow clips it and it takes no room.
 *
 * Built after web-guidance interest-triggered-tooltips.md ("Toggletips"), without `interestfor` (Chromium only; the
 * guide's fallback is a polyfill, which this project does not add): the hover and focus intent is a few lines here.
 * The panel is a `popover="manual"` (Chromium and Firefox) shown and hidden from script, so the script owns every way
 * of closing it (`auto` would also close an open menu, and light dismiss could not be animated in Firefox). Where the
 * Popover API is missing it is a fixed box toggled by `hidden` (jsdom; older engines).
 *
 * Opening: hover with a short intent delay (OPEN_DELAY_MS) and a close delay (CLOSE_DELAY_MS) that lets the pointer
 * cross the gap onto the panel; keyboard focus (the same delay, so tabbing past does not flash it); a click or tap
 * (a toggle: it pins the panel open, or closes a pinned one). Closing: Escape (focus inside the panel goes back to the
 * trigger), a press outside, focus moving on, the pointer leaving a hover-opened panel. One open at a time.
 * `flash`: a counter the caller bumps for a new occurrence (a problem appearing); each new value shows the panel by
 * itself for FLASH_MS, paused while hovered or focused, without taking focus. A re-render with the same value does
 * nothing; a change to 0 ends a timed open at once.
 *
 * Semantics: the guide's toggletip (a button whose only job is the hint): `aria-expanded` on the trigger, `role="tooltip"`
 * on the panel, which follows the trigger in the DOM, no `aria-describedby` and no live region (so nothing is
 * announced on hover, and a caller that announces a state change is never doubled). The panel's content is rendered
 * only while it shows, so its words are not in the page twice. `interactive` (a link or button inside): a labelled
 * group instead of a tooltip, reached by Tab right after the trigger; focus inside keeps it open.
 *
 * Placement: placeInfoPopover.ts (below and start-aligned unless the caller says otherwise; flips and shifts to stay
 * 8px inside the viewport; never over its own trigger), worked out on open, on every render while open, on resize and
 * on scroll. Motion: a 160ms fade and 4px slide in and out, none under reduced motion (InfoPopover.module.css).
 *
 * Modal dialogs (S14.3k): a modal `<dialog>` and this panel both live in the top layer, where the later one is drawn
 * on top, so a panel shown while a modal is open would cover it. While a modal dialog that does not hold the trigger is
 * open, the panel stays closed: an open one closes when the modal opens, and a timed open (`flash`) is held back and
 * shown by its normal rule once no such modal is open (if the occurrence still stands). A popover inside the modal
 * works as usual. The signal is the platform's: `dialog:modal`, re-read whenever a dialog's `open` attribute changes
 * or dialogs come and go (one shared MutationObserver while any popover is mounted).
 */

export const OPEN_DELAY_MS = 200;
export const CLOSE_DELAY_MS = 250;
export const FLASH_MS = 5000;
/** The exit fade; the panel leaves the top layer after it. */
export const EXIT_MS = 160;

export type InfoTone = 'quiet' | 'warning';
export type InfoForm = 'panel' | 'pill';
type Why = 'hover' | 'focus' | 'click' | 'flash';

type Props = {
    /** The trigger's accessible name, saying what it reveals ("About the character budget"). */
    label: string;
    tone?: InfoTone;
    /** `panel`: the mockup's info box (heading, text, list, foot). `pill`: one short line. */
    form?: InfoForm;
    heading?: ReactNode;
    /** The text: a string becomes one paragraph (the pill's line); other nodes are used as they are. */
    children?: ReactNode;
    list?: readonly ReactNode[];
    foot?: ReactNode;
    /** What the trigger draws instead of the exclamation mark (decorative; the button keeps `label`). */
    trigger?: ReactNode;
    /** Extra classes for the trigger (a caller's size or colours). */
    className?: string;
    side?: Side;
    align?: Align;
    /** The space between the trigger and the panel (px; default POPOVER_GAP), to clear a control around it. */
    gap?: number;
    /**
     * Bump for a new occurrence to show the panel by itself for FLASH_MS. 0: none (a change to 0 ends a timed open
     * still showing, as when the problem it reported has cleared).
     */
    flash?: number;
    /** The content holds a link or button. */
    interactive?: boolean;
};

/** The one open popover (single-open rule). */
let current: { id: string; close: () => void } | null = null;

const canPopover = () =>
    typeof HTMLElement !== 'undefined' &&
    typeof (HTMLElement.prototype as { showPopover?: unknown }).showPopover === 'function';
const reducedMotion = () =>
    globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

// ── Open modal dialogs (S14.3k).
/**
 * Read once, before any test stand-in: without a native `showModal` (jsdom, older engines) a page opens its modal by
 * the `open` attribute (LoadoutsPanel's fallback), and `:modal` never matches, so there an open dialog counts as modal.
 */
const nativeModal =
    typeof HTMLDialogElement !== 'undefined' &&
    typeof HTMLDialogElement.prototype.showModal === 'function';
const openModals = (): Element[] => {
    if (typeof document === 'undefined') return [];
    if (nativeModal) {
        try {
            return [...document.querySelectorAll('dialog:modal')];
        } catch {
            // An engine without `:modal`: the attribute below.
        }
    }
    return [...document.querySelectorAll('dialog[open]')];
};
/** A modal dialog is open that does not hold `el` (so `el`'s panel would be drawn over it). */
const blockedByModal = (el: Element | null) =>
    openModals().some((d) => !el?.isConnected || !d.contains(el));

const modalListeners = new Set<() => void>();
let modalObserver: MutationObserver | null = null;
let lastModals: Element[] = [];
const recheckModals = () => {
    const now = openModals();
    if (now.length === lastModals.length && now.every((d, n) => d === lastModals[n])) return;
    lastModals = now;
    for (const l of [...modalListeners]) l();
};
function watchModals(listener: () => void) {
    modalListeners.add(listener);
    if (!modalObserver && typeof MutationObserver !== 'undefined') {
        lastModals = openModals();
        modalObserver = new MutationObserver(recheckModals);
        modalObserver.observe(document.documentElement, {
            subtree: true,
            childList: true,
            attributes: true,
            attributeFilter: ['open'],
        });
    }
    return () => {
        modalListeners.delete(listener);
        if (modalListeners.size > 0) return;
        modalObserver?.disconnect();
        modalObserver = null;
    };
}

type Timer = { current: ReturnType<typeof setTimeout> | null };
const clear = (t: Timer) => {
    if (t.current !== null) clearTimeout(t.current);
    t.current = null;
};

export function InfoPopover({
    label,
    tone = 'quiet',
    form = 'panel',
    heading,
    children,
    list,
    foot,
    trigger,
    className,
    side = 'below',
    align = 'start',
    gap,
    flash = 0,
    interactive = false,
}: Props) {
    const id = useId();
    const triggerRef = useRef<HTMLButtonElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const [why, setWhyState] = useState<Why | null>(null);
    const [leaving, setLeaving] = useState(false);
    const whyRef = useRef<Why | null>(null);
    const setWhy = useCallback((w: Why | null) => {
        whyRef.current = w;
        setWhyState(w);
    }, []);

    const openTimer: Timer = useRef(null);
    const closeTimer: Timer = useRef(null);
    const flashTimer: Timer = useRef(null);
    const exitTimer: Timer = useRef(null);
    const hovering = useRef(false);
    const focused = useRef(false);
    const pointerPress = useRef(false);
    const flashLeft = useRef(0);
    const flashStart = useRef(0);

    /** `instant`: no exit fade (a panel that must not stay drawn over a modal dialog). */
    const close = useCallback(
        (instant = false) => {
            clear(openTimer);
            clear(closeTimer);
            clear(flashTimer);
            if (current?.id === id) current = null;
            if (whyRef.current === null) return;
            setWhy(null);
            clear(exitTimer);
            if (instant || reducedMotion()) {
                setLeaving(false);
                return;
            }
            setLeaving(true);
            exitTimer.current = setTimeout(() => {
                exitTimer.current = null;
                setLeaving(false);
            }, EXIT_MS);
        },
        [id, setWhy],
    );

    const open = useCallback(
        (reason: Why) => {
            clear(openTimer);
            clear(closeTimer);
            if (current && current.id !== id) current.close();
            current = { id, close };
            clear(exitTimer);
            setLeaving(false);
            setWhy(reason);
        },
        [id, close, setWhy],
    );

    // ── The timed open (`flash`).
    const runFlash = useCallback(
        (ms: number) => {
            clear(flashTimer);
            flashStart.current = Date.now();
            flashLeft.current = ms;
            flashTimer.current = setTimeout(() => {
                flashTimer.current = null;
                if (whyRef.current === 'flash') close();
            }, ms);
        },
        [close],
    );
    const pauseFlash = () => {
        if (whyRef.current !== 'flash' || flashTimer.current === null) return;
        clear(flashTimer);
        flashLeft.current -= Date.now() - flashStart.current;
    };
    const resumeFlash = () => {
        if (whyRef.current !== 'flash' || hovering.current || focused.current) return;
        if (flashTimer.current !== null) return;
        runFlash(Math.max(flashLeft.current, CLOSE_DELAY_MS));
    };

    const showFlash = useCallback(() => {
        open('flash');
        if (hovering.current || focused.current) {
            flashLeft.current = FLASH_MS;
            return;
        }
        runFlash(FLASH_MS);
    }, [open, runFlash]);

    const lastFlash = useRef(0);
    /** A timed open held back by a modal dialog (S14.3k); shown once no modal covers the trigger's page. */
    const held = useRef(false);
    useEffect(() => {
        if (flash === lastFlash.current) return;
        lastFlash.current = flash;
        // 0: the occurrence is over (a problem cleared): a timed open ends at once; one the person opened stays.
        if (!flash) {
            held.current = false;
            if (whyRef.current === 'flash') close();
            return;
        }
        if (whyRef.current !== null) return;
        if (blockedByModal(triggerRef.current)) {
            held.current = true;
            return;
        }
        showFlash();
    }, [flash, close, showFlash]);

    // A modal dialog opening closes the panel (a timed open is held back); one closing lets a held timed open show.
    useEffect(
        () =>
            watchModals(() => {
                if (blockedByModal(triggerRef.current)) {
                    if (whyRef.current === 'flash') held.current = true;
                    close();
                    return;
                }
                if (!held.current) return;
                held.current = false;
                if (lastFlash.current && whyRef.current === null) showFlash();
            }),
        [close, showFlash],
    );

    useEffect(
        () => () => {
            for (const t of [openTimer, closeTimer, flashTimer, exitTimer]) clear(t);
            if (current?.id === id) current = null;
        },
        [id],
    );

    // ── Pointer (hover intent; a touch opens by its tap, never by hover).
    const onEnter = (e: PointerEvent) => {
        if (e.pointerType === 'touch') return;
        hovering.current = true;
        clear(closeTimer);
        pauseFlash();
        if (whyRef.current === null && openTimer.current === null)
            openTimer.current = setTimeout(() => {
                openTimer.current = null;
                open('hover');
            }, OPEN_DELAY_MS);
    };
    const onLeave = (e: PointerEvent) => {
        if (e.pointerType === 'touch') return;
        hovering.current = false;
        if (whyRef.current === null) clear(openTimer);
        if (whyRef.current === 'hover') {
            clear(closeTimer);
            closeTimer.current = setTimeout(() => {
                closeTimer.current = null;
                if (!hovering.current && whyRef.current === 'hover') close();
            }, CLOSE_DELAY_MS);
        }
        resumeFlash();
    };

    // ── Focus (keyboard only: a focus that comes with a press is the click's).
    const onFocus = () => {
        const byPointer = pointerPress.current;
        pointerPress.current = false;
        focused.current = true;
        pauseFlash();
        if (byPointer) return;
        if (whyRef.current === 'hover') setWhy('focus');
        else if (whyRef.current === null && openTimer.current === null)
            openTimer.current = setTimeout(() => {
                openTimer.current = null;
                open('focus');
            }, OPEN_DELAY_MS);
    };
    const onBlur = (e: FocusEvent) => {
        const next = e.relatedTarget as Node | null;
        if (next && (triggerRef.current?.contains(next) || panelRef.current?.contains(next)))
            return;
        focused.current = false;
        if (whyRef.current === null) clear(openTimer);
        // Focus moving to another element closes a panel opened by focus or a click; focus leaving the window
        // (no next element) or a press on the panel's own text does not (a press outside closes it below).
        if (next && (whyRef.current === 'focus' || whyRef.current === 'click')) close();
        else resumeFlash();
    };

    const onClick = () => {
        clear(openTimer);
        if (whyRef.current === 'click') close();
        else open('click');
    };

    // ── Escape and a press outside, while open.
    const isOpen = why !== null;
    useEffect(() => {
        if (!isOpen) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return;
            const inside = panelRef.current?.contains(document.activeElement) === true;
            close();
            if (inside) triggerRef.current?.focus();
        };
        const onDown = (e: Event) => {
            const t = e.target as Node;
            if (triggerRef.current?.contains(t) || panelRef.current?.contains(t)) return;
            close();
        };
        document.addEventListener('keydown', onKey);
        document.addEventListener('pointerdown', onDown);
        return () => {
            document.removeEventListener('keydown', onKey);
            document.removeEventListener('pointerdown', onDown);
        };
    }, [isOpen, close]);

    // ── The top layer and the placement.
    const supported = canPopover();
    const visible = isOpen || leaving;
    useLayoutEffect(() => {
        // A timed open decided in the same commit as a modal dialog's opening: held back before it is ever drawn.
        if (why === 'flash' && blockedByModal(triggerRef.current)) {
            held.current = true;
            close(true);
            return;
        }
        const el = panelRef.current as
            | (HTMLDivElement & { showPopover(): void; hidePopover(): void })
            | null;
        if (!el || !supported) return;
        const shown = el.matches(':popover-open');
        if (visible && !shown) el.showPopover();
        else if (!visible && shown) el.hidePopover();
    }, [visible, supported, why, close]);

    const place = useCallback(() => {
        const t = triggerRef.current;
        const p = panelRef.current;
        if (!t || !p) return;
        p.style.maxBlockSize = '';
        const at = placeInfoPopover(
            t.getBoundingClientRect(),
            { width: p.offsetWidth, height: p.offsetHeight },
            {
                width: document.documentElement.clientWidth || window.innerWidth,
                height: window.innerHeight,
            },
            { side, align, gap },
        );
        p.style.top = `${at.top}px`;
        p.style.left = `${at.left}px`;
        p.style.maxBlockSize = `${at.maxHeight}px`;
        p.dataset.side = at.side;
    }, [side, align, gap]);
    // Every render while it shows: new words can change its size.
    useLayoutEffect(() => {
        if (visible) place();
    });
    useEffect(() => {
        if (!visible) return;
        window.addEventListener('resize', place);
        window.addEventListener('scroll', place, { capture: true, passive: true });
        return () => {
            window.removeEventListener('resize', place);
            window.removeEventListener('scroll', place, { capture: true });
        };
    }, [visible, place]);

    const body =
        form === 'pill' ? (
            children
        ) : (
            <>
                {heading && <p className={styles.heading}>{heading}</p>}
                {typeof children === 'string' ? <p>{children}</p> : children}
                {list && list.length > 0 && (
                    <ul className={styles.list}>
                        {list.map((item, n) => (
                            // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list from the caller, never reordered
                            <li key={n}>{item}</li>
                        ))}
                    </ul>
                )}
                {foot && <p className={styles.foot}>{foot}</p>}
            </>
        );

    // `popover` is newer than React's types; spread as an attribute (web-guidance "Adapting to React").
    const popoverAttrs: Record<string, unknown> = supported
        ? { popover: 'manual' }
        : { hidden: !visible };
    // A tooltip by default; a labelled group when it holds a link or button (named by its trigger).
    const roleAttrs: Record<string, string> = interactive
        ? { role: 'group', 'aria-labelledby': `${id}-trigger` }
        : { role: 'tooltip' };

    return (
        <>
            <button
                ref={triggerRef}
                id={`${id}-trigger`}
                type="button"
                className={className ? `${styles.trigger} ${className}` : styles.trigger}
                data-tone={tone}
                data-custom={trigger ? '' : undefined}
                aria-label={label}
                aria-expanded={isOpen}
                onClick={onClick}
                onPointerDown={() => {
                    pointerPress.current = true;
                }}
                onPointerEnter={onEnter}
                onPointerLeave={onLeave}
                onFocus={onFocus}
                onBlur={onBlur}
            >
                {trigger ?? <ExclamationIcon className={styles.icon} />}
            </button>
            {/* biome-ignore lint/a11y/noStaticElementInteractions: hover and focus tracking only (the pointer may rest on the panel, WCAG 1.4.13); no action */}
            <div
                ref={panelRef}
                id={`${id}-info`}
                {...roleAttrs}
                className={styles.panel}
                data-info-popover=""
                data-form={form}
                data-tone={tone}
                data-open={isOpen ? '' : undefined}
                data-leaving={!isOpen && leaving ? '' : undefined}
                data-why={why ?? undefined}
                onPointerEnter={onEnter}
                onPointerLeave={onLeave}
                onFocus={() => {
                    focused.current = true;
                    pauseFlash();
                }}
                onBlur={onBlur}
                {...popoverAttrs}
            >
                {visible && body}
            </div>
        </>
    );
}
