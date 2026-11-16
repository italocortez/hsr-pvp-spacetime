import {
    type FocusEvent,
    type RefObject,
    useEffect,
    useLayoutEffect,
    useRef,
    useState,
} from 'react';
import collapse from '@/styles/scrollCollapse.module.css';

/*
 * Scroll-linked collapse (S14.2b; docs/frontend/component-hygiene.md, "Patterns"): a sticky
 * surface at the start edge of a sideways scroller whose visible width follows the scroll one to
 * one, `clamp(closed, start - scrollLeft, start)`, while the content on it is clipped by the
 * moving edge and fades out. The layout width never changes, so nothing in the scroller moves.
 * First user: the costs page's phone name column (`pages/costs/CostTable.tsx`).
 *
 * This hook drives it; `styles/scrollCollapse.module.css` holds the formulas. The scroller
 * declares `--collapse-start` and `--collapse-closed` (lengths); every collapsing element carries
 * the module's `item` class and reads:
 * - `--collapse-w`: the visible width (paint the surface and clip the content with it);
 * - `--collapse-fade`: 1 to 0 over the first `FADE_PX` of scroll (the content's opacity);
 * - `--collapse-reveal`: 0 to 1 over `REVEAL_PX` of scroll from `--collapse-reveal-at` (a length
 *   the scroller may declare; `FADE_PX` when it does not): content that belongs to the collapsed
 *   state, such as a short value that stands in for a column scrolled away; declare the scroll
 *   position at which the real value has gone under the surface, so the two never show at once;
 * - `--collapse-edge`: 0 until the surface has collapsed, then up to `EDGE_PX` (a soft edge).
 *
 * Two paths, picked by feature detection, never by browser:
 * - `timeline` where `animation-timeline: scroll()` is supported: each item runs a scroll-driven
 *   animation that writes the scroll position as `--sl`, and the module's CSS computes the three
 *   values from it. No script per frame.
 * - `script` otherwise: a passive scroll listener (scroll events fire once per rendered frame)
 *   computes them with `collapseValues` and writes them on the scroller, where the items inherit
 *   them.
 */

/** Pixels of scroll over which the content fades out (the CSS uses the same number). */
export const FADE_PX = 120;
/** Pixels of scroll over which collapsed-state content appears (the CSS uses the same number). */
export const REVEAL_PX = 30;
/** The widest the soft edge past the collapsed surface gets (the CSS uses the same number). */
export const EDGE_PX = 24;

export type ScrollCollapseMode = 'timeline' | 'script';

/** What the hook reads from the scroller; replaceable in tests (jsdom has no layout). */
export type CollapseMeasure = {
    scrollLeft: number;
    scrollWidth: number;
    clientWidth: number;
    /** The surface's width at the scroll start, px (`--collapse-start`). */
    start: number;
    /** Its collapsed width, px (`--collapse-closed`). */
    closed: number;
    /** Where the reveal starts, px of scroll (`--collapse-reveal-at`); `FADE_PX` when absent. */
    revealAt?: number;
};

const clamp = (min: number, value: number, max: number) => Math.min(max, Math.max(min, value));

/** True when the scroller has content to scroll to sideways. */
export function canScrollSideways(
    m: Pick<CollapseMeasure, 'scrollWidth' | 'clientWidth'>,
): boolean {
    return m.scrollWidth > m.clientWidth + 1;
}

/** The scroll position at which the surface reaches its collapsed width. */
export function collapsePoint(start: number, closed: number): number {
    return Math.max(0, start - closed);
}

/**
 * The values for one scroll position. The width is tied one to one to the scroll; the fade and
 * the reveal are ramps (steps at `FADE_PX` under reduced motion); the edge grows only past the
 * collapse.
 */
export function collapseValues(m: CollapseMeasure, reduced = false) {
    const x = Math.abs(m.scrollLeft);
    const at = m.revealAt ?? FADE_PX;
    return {
        width: clamp(m.closed, m.start - x, m.start),
        fade: reduced ? (x < FADE_PX ? 1 : 0) : clamp(0, 1 - x / FADE_PX, 1),
        reveal: reduced ? (x > at ? 1 : 0) : clamp(0, (x - at) / REVEAL_PX, 1),
        edge: clamp(0, x - collapsePoint(m.start, m.closed), EDGE_PX),
    };
}

const media = (query: string): boolean => globalThis.matchMedia?.(query).matches === true;

function lengthOf(style: CSSStyleDeclaration, name: string): number | undefined {
    const value = Number.parseFloat(style.getPropertyValue(name));
    return Number.isFinite(value) ? value : undefined;
}

/** Reads the scroller and its declared geometry. */
export function measureScroller(el: HTMLElement): CollapseMeasure {
    const style = getComputedStyle(el);
    return {
        scrollLeft: el.scrollLeft,
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        start: lengthOf(style, '--collapse-start') ?? 0,
        closed: lengthOf(style, '--collapse-closed') ?? 0,
        revealAt: lengthOf(style, '--collapse-reveal-at'),
    };
}

export const supportsScrollTimeline = (): boolean =>
    typeof CSS !== 'undefined' && CSS.supports?.('animation-timeline', 'scroll()') === true;

const VARS = ['--collapse-w', '--collapse-fade', '--collapse-reveal', '--collapse-edge'] as const;

/**
 * Drives the collapse for the scroller in `ref` while `query` matches and the scroller can scroll
 * sideways; returns the path in use then (put it on the scroller as `data-scroll-collapse`), else
 * undefined. `measure` replaces the DOM reads (tests); the latest one is used, so an inline
 * function does not re-subscribe on every render. Media queries are read in effects and
 * listeners only, never during render (component-hygiene Rule 2).
 *
 * The scroller element must stay the same for the hook's lifetime: the listeners and the
 * observer are attached to the element `ref` holds when the effect runs, and are not moved if
 * the ref later points at another element (remount the owner with a `key` instead, as the costs
 * table does per tab).
 */
export function useScrollCollapse(
    ref: RefObject<HTMLElement | null>,
    query: string,
    measure: (el: HTMLElement) => CollapseMeasure = measureScroller,
): ScrollCollapseMode | undefined {
    const [mode, setMode] = useState<ScrollCollapseMode | undefined>(undefined);
    const measureRef = useRef(measure);
    useLayoutEffect(() => {
        measureRef.current = measure;
    });

    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        const measureNow = (target: HTMLElement) => measureRef.current(target);
        const timeline = supportsScrollTimeline();
        let active = false;

        // Called from the scroll listener: browsers fire `scroll` once per rendered frame, as
        // part of that frame's update (before its animation frame callbacks and its paint), so
        // the values never trail the scroll position by a frame.
        const write = () => {
            if (!active || timeline) return;
            const v = collapseValues(measureNow(el), media('(prefers-reduced-motion: reduce)'));
            el.style.setProperty('--collapse-w', `${v.width}px`);
            el.style.setProperty('--collapse-fade', String(v.fade));
            el.style.setProperty('--collapse-reveal', String(v.reveal));
            el.style.setProperty('--collapse-edge', `${v.edge}px`);
        };
        const update = () => {
            active = media(query) && canScrollSideways(measureNow(el));
            setMode(active ? (timeline ? 'timeline' : 'script') : undefined);
            if (active) write();
            else for (const name of VARS) el.style.removeProperty(name);
        };

        if (!timeline) el.addEventListener('scroll', write, { passive: true });
        const observer =
            typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(update);
        observer?.observe(el);
        if (el.firstElementChild) observer?.observe(el.firstElementChild);
        const lists = [query, '(pointer: coarse)', '(prefers-reduced-motion: reduce)'].map((q) =>
            globalThis.matchMedia?.(q),
        );
        for (const list of lists) list?.addEventListener?.('change', update);
        update();
        return () => {
            el.removeEventListener('scroll', write);
            observer?.disconnect();
            for (const list of lists) list?.removeEventListener?.('change', update);
        };
    }, [ref, query]);

    return mode;
}

/** The collapsing element holding `target`, if any. */
function itemOf(target: EventTarget | null): HTMLElement | null {
    return target instanceof Element ? target.closest<HTMLElement>(`.${collapse.item}`) : null;
}

/** Keyboard focus as the browser decides it (`:focus-visible`); true where it cannot say. */
function isKeyboardFocus(el: Element): boolean {
    try {
        return el.matches(':focus-visible');
    } catch {
        return true;
    }
}

/**
 * Focus handlers for the scroller: keyboard focus inside a collapsed item reopens that one item
 * to its full width (`data-reopen`), so the focused control is in sight; pointer focus does not
 * (a tapped control would otherwise hold its item open). Set on the element: it changes no
 * rendered output, only that item's look.
 */
export const reopenOnFocus = {
    onFocus(event: FocusEvent<HTMLElement>) {
        const item = itemOf(event.target);
        if (item && isKeyboardFocus(event.target)) item.setAttribute('data-reopen', '');
    },
    onBlur(event: FocusEvent<HTMLElement>) {
        const item = itemOf(event.target);
        if (item && !item.contains(event.relatedTarget as Node | null)) {
            item.removeAttribute('data-reopen');
        }
    },
};

/** The class every collapsing element carries. */
export const collapseItem: string = collapse.item ?? '';
