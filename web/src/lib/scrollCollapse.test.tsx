import { act, fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    type CollapseMeasure,
    canScrollSideways,
    collapseItem,
    collapsePoint,
    collapseValues,
    EDGE_PX,
    FADE_PX,
    reopenOnFocus,
    supportsScrollTimeline,
    useScrollCollapse,
} from './scrollCollapse';

/*
 * T-COSTS-B: the scroll-linked collapse (S14.2b). jsdom has no layout and no scroll-driven
 * animations (though its `CSS.supports` answers yes to anything, so it is stubbed to say no), so
 * the hook runs its script path here (the tested path): the scroller's numbers come from an
 * injected measure, the media queries from a mocked `matchMedia`.
 */

const NARROW = '(max-width: 560px)';
const REDUCED = '(prefers-reduced-motion: reduce)';
let matching = new Set<string>([NARROW]);
const listeners = new Map<string, Set<() => void>>();

function installMatchMedia() {
    Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        writable: true,
        value: (query: string) => ({
            matches: matching.has(query),
            media: query,
            addEventListener: (_t: string, l: () => void) => {
                const set = listeners.get(query) ?? new Set();
                set.add(l);
                listeners.set(query, set);
            },
            removeEventListener: (_t: string, l: () => void) => listeners.get(query)?.delete(l),
        }),
    });
}
function setMatching(next: string[]) {
    matching = new Set(next);
    act(() => {
        for (const set of listeners.values()) for (const l of [...set]) l();
    });
}

beforeEach(() => {
    matching = new Set([NARROW]);
    listeners.clear();
    installMatchMedia();
    vi.spyOn(CSS, 'supports').mockReturnValue(false);
});
afterEach(() => {
    delete (window as { matchMedia?: unknown }).matchMedia;
    vi.restoreAllMocks();
});

const frame = () => act(() => new Promise<void>((done) => requestAnimationFrame(() => done())));

/** 246px at the start, 74px collapsed (the costs page's Characters on a fine pointer). */
const m = (scrollLeft: number): CollapseMeasure => ({
    scrollLeft,
    scrollWidth: 780,
    clientWidth: 348,
    start: 246,
    closed: 74,
});

describe('the formulas', () => {
    it('the width follows the scroll one to one between its bounds, and back', () => {
        const widths = [0, 10, 60, 120, 171, 172, 173, 300, 999].map(
            (x) => collapseValues(m(x)).width,
        );
        expect(widths).toEqual([246, 236, 186, 126, 75, 74, 74, 74, 74]);
        // Reversal: the same positions give the same widths in the other direction.
        const back = [999, 300, 173, 172, 171, 120, 60, 10, 0].map(
            (x) => collapseValues(m(x)).width,
        );
        expect(back).toEqual([...widths].reverse());
        // RTL scrollers report a negative scrollLeft.
        expect(collapseValues(m(-60)).width).toBe(186);
    });

    it('the collapse point per collapsed width (tab and pointer)', () => {
        expect(collapsePoint(246, 74)).toBe(172); // Characters, fine pointer
        expect(collapsePoint(246, 94)).toBe(152); // Characters, coarse pointer
        expect(collapsePoint(246, 52)).toBe(194); // Light Cones
        expect(collapsePoint(40, 74)).toBe(0);
    });

    it('the fade is a ramp over FADE_PX, finished before the collapse; a step under reduced motion', () => {
        expect(FADE_PX).toBeLessThan(collapsePoint(246, 94));
        expect([0, 30, 60, 90, 120, 200].map((x) => collapseValues(m(x)).fade)).toEqual([
            1, 0.75, 0.5, 0.25, 0, 0,
        ]);
        expect([0, 119, 120, 200].map((x) => collapseValues(m(x), true).fade)).toEqual([
            1, 1, 0, 0,
        ]);
        // Reduced motion keeps the width link.
        expect(collapseValues(m(60), true).width).toBe(186);
    });

    it('the soft edge: none until collapsed, then up to EDGE_PX', () => {
        expect(EDGE_PX).toBe(24);
        expect([0, 172, 176, 196, 400].map((x) => collapseValues(m(x)).edge)).toEqual([
            0,
            0,
            4,
            EDGE_PX,
            EDGE_PX,
        ]);
    });

    it('the reveal: after the fade, over REVEAL_PX; a step under reduced motion', () => {
        expect([0, 120, 135, 150, 300].map((x) => collapseValues(m(x)).reveal)).toEqual([
            0, 0, 0.5, 1, 1,
        ]);
        expect([120, 121].map((x) => collapseValues(m(x), true).reveal)).toEqual([0, 1]);
    });

    it('sideways overflow needs more than a pixel of difference', () => {
        expect(canScrollSideways({ scrollWidth: 780, clientWidth: 348 })).toBe(true);
        expect(canScrollSideways({ scrollWidth: 349, clientWidth: 348 })).toBe(false);
    });

    it('the path is chosen by feature detection of animation-timeline', () => {
        expect(supportsScrollTimeline()).toBe(false);
        const supports = vi.mocked(CSS.supports);
        supports.mockImplementation(
            ((p: string, v?: string) =>
                p === 'animation-timeline' && v === 'scroll()') as typeof CSS.supports,
        );
        expect(supportsScrollTimeline()).toBe(true);
    });
});

function Scroller({ measure }: { measure: (el: HTMLElement) => CollapseMeasure }) {
    const ref = useRef<HTMLDivElement>(null);
    const mode = useScrollCollapse(ref, NARROW, measure);
    return (
        <div ref={ref} data-testid="scroller" data-scroll-collapse={mode} {...reopenOnFocus}>
            <div className={collapseItem} data-testid="item">
                <button type="button">Open</button>
            </div>
            <button type="button">Outside</button>
        </div>
    );
}

describe('the hook, script path', () => {
    const vars = (el: HTMLElement) =>
        ['--collapse-w', '--collapse-fade', '--collapse-reveal', '--collapse-edge'].map((n) =>
            el.style.getPropertyValue(n),
        );

    it('writes the values from the scroll position on each scroll event', async () => {
        const state = m(0);
        render(<Scroller measure={() => state} />);
        const el = screen.getByTestId('scroller');
        expect(el).toHaveAttribute('data-scroll-collapse', 'script');
        expect(vars(el)).toEqual(['246px', '1', '0', '0px']);
        for (const [x, expected] of [
            [60, ['186px', '0.5', '0', '0px']],
            [180, ['74px', '0', '1', '8px']],
            [30, ['216px', '0.75', '0', '0px']],
        ] as const) {
            state.scrollLeft = x;
            fireEvent.scroll(el);
            await frame();
            expect(vars(el)).toEqual(expected);
        }
    });

    it('steps the fade under reduced motion, the width still following', async () => {
        matching = new Set([NARROW, REDUCED]);
        const state = m(60);
        render(<Scroller measure={() => state} />);
        const el = screen.getByTestId('scroller');
        expect(vars(el)).toEqual(['186px', '1', '0', '0px']);
        state.scrollLeft = 130;
        fireEvent.scroll(el);
        await frame();
        expect(vars(el)).toEqual(['116px', '0', '1', '0px']);
    });

    it('is off above the narrow rule, and on again below it (values removed, then written)', () => {
        const state = m(90);
        render(<Scroller measure={() => state} />);
        const el = screen.getByTestId('scroller');
        setMatching([]);
        expect(el).not.toHaveAttribute('data-scroll-collapse');
        expect(vars(el)).toEqual(['', '', '', '']);
        setMatching([NARROW]);
        expect(el).toHaveAttribute('data-scroll-collapse', 'script');
        expect(vars(el)[0]).toBe('156px');
    });

    it('is off when the scroller cannot scroll sideways', () => {
        render(<Scroller measure={() => ({ ...m(0), scrollWidth: 348 })} />);
        expect(screen.getByTestId('scroller')).not.toHaveAttribute('data-scroll-collapse');
    });

    it('keyboard focus inside an item reopens it; leaving the item closes it again', () => {
        render(<Scroller measure={() => m(200)} />);
        const item = screen.getByTestId('item');
        act(() => screen.getByRole('button', { name: 'Open' }).focus());
        expect(item).toHaveAttribute('data-reopen');
        act(() => screen.getByRole('button', { name: 'Outside' }).focus());
        expect(item).not.toHaveAttribute('data-reopen');
    });

    it('pointer focus inside an item does not reopen it (only keyboard focus does)', () => {
        const matches = Element.prototype.matches;
        vi.spyOn(Element.prototype, 'matches').mockImplementation(function (
            this: Element,
            selector: string,
        ) {
            return selector === ':focus-visible' ? false : matches.call(this, selector);
        });
        render(<Scroller measure={() => m(200)} />);
        act(() => screen.getByRole('button', { name: 'Open' }).focus());
        expect(screen.getByTestId('item')).not.toHaveAttribute('data-reopen');
    });

    it('removes its listeners on unmount', async () => {
        const state = m(0);
        const { unmount } = render(<Scroller measure={() => state} />);
        const el = screen.getByTestId('scroller');
        unmount();
        state.scrollLeft = 100;
        fireEvent.scroll(el);
        await frame();
        expect(el.style.getPropertyValue('--collapse-w')).toBe('246px');
        expect([...listeners.values()].every((set) => set.size === 0)).toBe(true);
    });
});

describe('the reveal point (third review)', () => {
    it('the reveal starts at revealAt when the scroller declares one, FADE_PX otherwise', () => {
        const at = (x: number) => collapseValues({ ...m(x), revealAt: 232 }).reveal;
        expect([120, 200, 232, 247, 262, 400].map(at)).toEqual([0, 0, 0, 0.5, 1, 1]);
        expect(collapseValues({ ...m(135), revealAt: undefined }).reveal).toBe(0.5);
        // Reduced motion: a step at the same point.
        expect(
            [232, 233].map((x) => collapseValues({ ...m(x), revealAt: 232 }, true).reveal),
        ).toEqual([0, 1]);
        // The fade is not moved by it.
        expect(collapseValues({ ...m(60), revealAt: 232 }).fade).toBe(0.5);
    });

    it('the script path writes the reveal from the declared point', async () => {
        const state = { ...m(200), revealAt: 232 };
        render(<Scroller measure={() => state} />);
        const el = screen.getByTestId('scroller');
        expect(el.style.getPropertyValue('--collapse-reveal')).toBe('0');
        state.scrollLeft = 247;
        fireEvent.scroll(el);
        await frame();
        expect(el.style.getPropertyValue('--collapse-reveal')).toBe('0.5');
    });
});

describe('the hook: observer, path choice, measure (third review)', () => {
    type Observed = { targets: Element[]; disconnected: boolean; callback: () => void };
    let observers: Observed[] = [];
    beforeEach(() => {
        observers = [];
        vi.stubGlobal(
            'ResizeObserver',
            class {
                record: Observed;
                constructor(callback: () => void) {
                    this.record = { targets: [], disconnected: false, callback };
                    observers.push(this.record);
                }
                observe(target: Element) {
                    this.record.targets.push(target);
                }
                unobserve() {}
                disconnect() {
                    this.record.disconnected = true;
                }
            },
        );
    });
    afterEach(() => vi.unstubAllGlobals());

    it('observes the scroller and its content, re-checks on a resize, and disconnects on unmount', () => {
        const state = m(0);
        const { unmount } = render(<Scroller measure={() => state} />);
        const el = screen.getByTestId('scroller');
        expect(observers).toHaveLength(1);
        expect(observers[0]?.targets).toEqual([el, el.firstElementChild]);
        // The content now fits: a resize turns the collapse off.
        state.scrollWidth = 348;
        act(() => observers[0]?.callback());
        expect(el).not.toHaveAttribute('data-scroll-collapse');
        expect(el.style.getPropertyValue('--collapse-w')).toBe('');
        unmount();
        expect(observers[0]?.disconnected).toBe(true);
    });

    it('an inline measure function does not re-subscribe on re-render; the latest one is read', async () => {
        const { rerender } = render(<Scroller measure={() => m(0)} />);
        const el = screen.getByTestId('scroller');
        rerender(<Scroller measure={() => m(60)} />);
        rerender(<Scroller measure={() => m(90)} />);
        expect(observers).toHaveLength(1);
        expect(observers[0]?.disconnected).toBe(false);
        fireEvent.scroll(el);
        await frame();
        expect(el.style.getPropertyValue('--collapse-w')).toBe('156px');
    });

    it('the timeline path where scroll-driven animations exist: no values written from script', async () => {
        vi.mocked(CSS.supports).mockImplementation(
            ((p: string, v?: string) =>
                p === 'animation-timeline' && v === 'scroll()') as typeof CSS.supports,
        );
        const add = vi.spyOn(HTMLElement.prototype, 'addEventListener');
        const state = m(0);
        render(<Scroller measure={() => state} />);
        const el = screen.getByTestId('scroller');
        expect(el).toHaveAttribute('data-scroll-collapse', 'timeline');
        expect(el.style.getPropertyValue('--collapse-w')).toBe('');
        // No scroll listener on the scroller (React's own root listeners are not the hook's).
        expect(
            add.mock.calls.some(([type], i) => type === 'scroll' && add.mock.contexts[i] === el),
        ).toBe(false);
        state.scrollLeft = 200;
        fireEvent.scroll(el);
        await frame();
        for (const name of [
            '--collapse-w',
            '--collapse-fade',
            '--collapse-reveal',
            '--collapse-edge',
        ]) {
            expect(el.style.getPropertyValue(name)).toBe('');
        }
    });
});
