import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EDGE, GAP, MultiSelectDropdown, placePanel } from './MultiSelectDropdown';

/*
 * T-COSTS-B: the shared dropdown multi-select (a disclosure revealing a group of checkboxes).
 * jsdom has no layout and answers yes to every `CSS.supports` question: anchor positioning is
 * stubbed off by default, so the script placement is the path under test.
 */

const OPTIONS = ['Break', 'DoT', 'Elation', 'FuA'].map((n) => ({ value: n, label: n }));

function Harness({ initial = [] as string[], options = OPTIONS }) {
    const [selected, setSelected] = useState<string[]>(initial);
    return (
        <>
            <button type="button">Before</button>
            <MultiSelectDropdown
                label="Archetype"
                listLabel="Filter by archetype"
                emptyText="Loading archetypes"
                options={options}
                selected={selected}
                onToggle={(v) =>
                    setSelected((s) => (s.includes(v) ? s.filter((x) => x !== v) : [...s, v]))
                }
            />
            <button type="button">After</button>
            <output data-testid="picked">{selected.join(',')}</output>
        </>
    );
}

let anchor = false;
beforeEach(() => {
    anchor = false;
    vi.spyOn(CSS, 'supports').mockImplementation(
        ((p: string) => anchor && p.startsWith('anchor-name')) as typeof CSS.supports,
    );
});
afterEach(() => vi.restoreAllMocks());

const trigger = () => screen.getByRole('button', { name: /^Archetype/ });
const group = () => screen.queryByRole('group', { name: 'Filter by archetype' });

describe('MultiSelectDropdown', () => {
    it('a disclosure: the button controls the panel, which holds a named group of checkboxes', async () => {
        const user = userEvent.setup();
        render(<Harness />);
        expect(trigger()).toHaveAttribute('aria-expanded', 'false');
        expect(group()).toBeNull();
        await user.click(trigger());
        expect(trigger()).toHaveAttribute('aria-expanded', 'true');
        const panel = document.getElementById(trigger().getAttribute('aria-controls') ?? '');
        expect(panel).toContainElement(group());
        expect(screen.getAllByRole('checkbox').map((c) => c.closest('label')?.textContent)).toEqual(
            ['Break', 'DoT', 'Elation', 'FuA'],
        );
        // No menu or listbox roles: native checkboxes in a group.
        expect(screen.queryByRole('menu')).toBeNull();
        expect(trigger()).not.toHaveAttribute('aria-haspopup');
        // A pointer open leaves focus on the button.
        expect(trigger()).toHaveFocus();
        await user.click(trigger());
        expect(group()).toBeNull();
    });

    it('selection applies at once, several at a time; the count shows on the closed button', async () => {
        const user = userEvent.setup();
        render(<Harness />);
        await user.click(trigger());
        await user.click(screen.getByRole('checkbox', { name: 'DoT' }));
        await user.click(screen.getByRole('checkbox', { name: 'Break' }));
        expect(screen.getByTestId('picked')).toHaveTextContent('DoT,Break');
        expect(screen.getByRole('checkbox', { name: 'DoT' })).toBeChecked();
        await user.keyboard('{Escape}');
        expect(trigger()).toHaveAccessibleName('Archetype 2 selected');
        expect(trigger()).toHaveAttribute('data-on');
    });

    it('a selected value that is not an option is not counted', () => {
        render(<Harness initial={['Gone', 'FuA']} />);
        expect(trigger()).toHaveAccessibleName('Archetype 1 selected');
    });

    it('keyboard: Enter opens and enters the first option; arrows, Home and End move; Space toggles', async () => {
        const user = userEvent.setup();
        render(<Harness />);
        act(() => trigger().focus());
        await user.keyboard('{Enter}');
        const boxes = () => screen.getAllByRole('checkbox');
        expect(boxes()[0]).toHaveFocus();
        await user.keyboard('{ArrowDown}{ArrowDown}');
        expect(boxes()[2]).toHaveFocus();
        await user.keyboard('{End}');
        expect(boxes()[3]).toHaveFocus();
        await user.keyboard('{ArrowDown}');
        expect(boxes()[3]).toHaveFocus();
        await user.keyboard('{Home}{ArrowUp}');
        expect(boxes()[0]).toHaveFocus();
        await user.keyboard(' ');
        expect(screen.getByTestId('picked')).toHaveTextContent('Break');
    });

    it('ArrowDown on the closed button opens and enters; on the open button it enters', async () => {
        const user = userEvent.setup();
        render(<Harness />);
        await user.click(trigger());
        await user.keyboard('{ArrowDown}');
        expect(screen.getAllByRole('checkbox')[0]).toHaveFocus();
        await user.keyboard('{Escape}');
        await user.keyboard('{ArrowDown}');
        expect(group()).not.toBeNull();
        expect(screen.getAllByRole('checkbox')[0]).toHaveFocus();
    });

    it('Escape closes and returns focus to the button, from an option or the button', async () => {
        const user = userEvent.setup();
        render(<Harness />);
        act(() => trigger().focus());
        await user.keyboard('{Enter}');
        await user.keyboard('{Escape}');
        expect(group()).toBeNull();
        expect(trigger()).toHaveFocus();
        await user.click(trigger());
        await user.keyboard('{Escape}');
        expect(group()).toBeNull();
        expect(trigger()).toHaveFocus();
    });

    it('no trap: Tab moves through the options and out, which closes the panel', async () => {
        const user = userEvent.setup();
        render(<Harness />);
        await user.click(trigger());
        await user.tab();
        expect(screen.getAllByRole('checkbox')[0]).toHaveFocus();
        await user.tab();
        await user.tab();
        await user.tab();
        await user.tab();
        expect(screen.getByRole('button', { name: 'After' })).toHaveFocus();
        expect(group()).toBeNull();
    });

    it('a press outside closes it without moving focus there', async () => {
        render(<Harness />);
        await userEvent.setup().click(trigger());
        fireEvent.pointerDown(screen.getByTestId('picked'));
        expect(group()).toBeNull();
        expect(trigger()).toHaveAttribute('aria-expanded', 'false');
    });

    it('a press inside (an option) keeps it open', async () => {
        const user = userEvent.setup();
        render(<Harness />);
        await user.click(trigger());
        await user.click(screen.getByText('Elation'));
        expect(group()).not.toBeNull();
        expect(screen.getByTestId('picked')).toHaveTextContent('Elation');
    });

    it('options are labels wrapping their checkbox (the whole row is the target)', async () => {
        render(<Harness />);
        await userEvent.setup().click(trigger());
        for (const box of screen.getAllByRole('checkbox')) {
            expect(box.closest('label')).not.toBeNull();
        }
    });

    it('no options yet: the empty text', async () => {
        render(<Harness options={[]} />);
        await userEvent.setup().click(trigger());
        expect(screen.getByText('Loading archetypes')).toBeInTheDocument();
    });

    it('placement path: script (fixed coordinates) without anchor positioning, CSS with it', async () => {
        const user = userEvent.setup();
        const { unmount } = render(<Harness />);
        await user.click(trigger());
        let panel = group()?.parentElement as HTMLElement;
        expect(panel).not.toHaveAttribute('data-anchored');
        expect(panel.style.top).toBe(`${GAP}px`);
        expect(panel.style.left).toBe(`${EDGE}px`);
        unmount();
        anchor = true;
        render(<Harness />);
        await user.click(trigger());
        panel = group()?.parentElement as HTMLElement;
        expect(panel).toHaveAttribute('data-anchored');
        expect(panel.style.top).toBe('');
    });

    it('a manual popover where the Popover API exists (top layer: not clipped by the card)', async () => {
        const show = vi.fn();
        Object.defineProperty(HTMLElement.prototype, 'showPopover', {
            configurable: true,
            value: show,
        });
        try {
            render(<Harness />);
            await userEvent.setup().click(trigger());
            // (jsdom's own stylesheet hides a `[popover]` it cannot open: found by id here.)
            const panel = document.getElementById(trigger().getAttribute('aria-controls') ?? '');
            expect(panel).toHaveAttribute('popover', 'manual');
            expect(show).toHaveBeenCalledTimes(1);
        } finally {
            delete (HTMLElement.prototype as { showPopover?: unknown }).showPopover;
        }
    });
});

/** The shell's `main` is focusable from script: the nearest focusable ancestor of the page. */
function InMain() {
    return (
        <main tabIndex={-1} data-testid="main">
            <Harness />
        </main>
    );
}

describe('MultiSelectDropdown: presses inside, listeners, keys (third review)', () => {
    it('aria-controls names the panel only while it is open', async () => {
        const user = userEvent.setup();
        render(<Harness />);
        expect(trigger()).not.toHaveAttribute('aria-controls');
        await user.click(trigger());
        const id = trigger().getAttribute('aria-controls');
        expect(id).toBeTruthy();
        expect(document.getElementById(id ?? '')).toContainElement(group());
        await user.click(trigger());
        expect(trigger()).not.toHaveAttribute('aria-controls');
    });

    it('the panel takes focus from a press only (tabIndex -1), so a press inside lands inside', async () => {
        render(<Harness />);
        await userEvent.setup().click(trigger());
        const panel = group()?.parentElement as HTMLElement;
        expect(panel).toHaveAttribute('tabindex', '-1');
    });

    it('a press on an option text whose focus lands on a focusable ancestor toggles it and keeps the panel open', async () => {
        render(<InMain />);
        await userEvent.setup().click(trigger());
        const text = screen.getByText('Elation');
        // The real sequence: pointerdown inside, focus moved to the nearest focusable ancestor
        // (here the shell's main), then the click.
        fireEvent.pointerDown(text);
        act(() => screen.getByTestId('main').focus());
        expect(group()).not.toBeNull();
        fireEvent.click(text);
        expect(screen.getByTestId('picked')).toHaveTextContent('Elation');
        expect(group()).not.toBeNull();
        // The same on the checkbox itself, without the checkbox taking focus (Safari).
        const box = screen.getByRole('checkbox', { name: 'DoT' });
        fireEvent.pointerDown(box);
        act(() => screen.getByTestId('main').focus());
        fireEvent.click(box);
        expect(screen.getByTestId('picked')).toHaveTextContent('Elation,DoT');
        expect(group()).not.toBeNull();
    });

    it('a press on the panel padding keeps it open; the next press outside still closes it', async () => {
        render(<InMain />);
        await userEvent.setup().click(trigger());
        const panel = group()?.parentElement as HTMLElement;
        fireEvent.pointerDown(panel);
        act(() => panel.focus());
        expect(group()).not.toBeNull();
        fireEvent.pointerDown(screen.getByTestId('picked'));
        expect(group()).toBeNull();
    });

    it('after a press inside, keyboard focus reaching an ancestor still counts as outside', async () => {
        render(<InMain />);
        await userEvent.setup().click(trigger());
        fireEvent.pointerDown(screen.getByText('Break'));
        fireEvent.keyDown(document.body, { key: 'Tab' });
        act(() => screen.getByTestId('main').focus());
        expect(group()).toBeNull();
    });

    it('focus moving to an unrelated element outside closes it', async () => {
        render(<Harness />);
        await userEvent.setup().click(trigger());
        fireEvent.pointerDown(screen.getByText('Break'));
        act(() => screen.getByRole('button', { name: 'After' }).focus());
        expect(group()).toBeNull();
    });

    it('ArrowDown stops at the last option; ArrowLeft and ArrowRight do nothing', async () => {
        const user = userEvent.setup();
        render(<Harness />);
        act(() => trigger().focus());
        await user.keyboard('{Enter}');
        const boxes = () => screen.getAllByRole('checkbox');
        await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}');
        expect(boxes()[3]).toHaveFocus();
        await user.keyboard('{ArrowUp}');
        expect(boxes()[2]).toHaveFocus();
        await user.keyboard('{ArrowRight}');
        expect(boxes()[2]).toHaveFocus();
        await user.keyboard('{ArrowLeft}');
        expect(boxes()[2]).toHaveFocus();
        expect(screen.getByTestId('picked')).toHaveTextContent('');
    });

    it('with focus on the panel itself, ArrowDown enters the first option and ArrowUp the last', async () => {
        render(<Harness />);
        await userEvent.setup().click(trigger());
        const panel = group()?.parentElement as HTMLElement;
        act(() => panel.focus());
        fireEvent.keyDown(panel, { key: 'ArrowDown' });
        expect(screen.getAllByRole('checkbox')[0]).toHaveFocus();
        act(() => panel.focus());
        fireEvent.keyDown(panel, { key: 'ArrowUp' });
        expect(screen.getAllByRole('checkbox')[3]).toHaveFocus();
    });

    it('Escape is handled here and goes no further (an enclosing dialog or menu stays open)', async () => {
        const user = userEvent.setup();
        const parent = vi.fn();
        const documentLevel = vi.fn();
        document.addEventListener('keydown', documentLevel);
        try {
            render(
                // biome-ignore lint/a11y/noStaticElementInteractions: a test listener
                <div onKeyDown={(e) => e.key === 'Escape' && parent()}>
                    <Harness />
                </div>,
            );
            act(() => trigger().focus());
            await user.keyboard('{Enter}');
            await user.keyboard('{Escape}');
            expect(group()).toBeNull();
            expect(parent).not.toHaveBeenCalled();
            expect(documentLevel.mock.calls.some(([e]) => e.key === 'Escape')).toBe(false);
            // Closed, Escape is not the dropdown's: it passes on.
            await user.keyboard('{Escape}');
            expect(parent).toHaveBeenCalledTimes(1);
        } finally {
            document.removeEventListener('keydown', documentLevel);
        }
    });

    it('removes its resize, scroll and outside listeners on close and on unmount', async () => {
        const user = userEvent.setup();
        const live = new Map<string, number>();
        const track = (target: EventTarget, label: string) => {
            const add = target.addEventListener.bind(target);
            const remove = target.removeEventListener.bind(target);
            vi.spyOn(target, 'addEventListener').mockImplementation((type, l, o) => {
                live.set(`${label}:${type}`, (live.get(`${label}:${type}`) ?? 0) + 1);
                add(type, l, o);
            });
            vi.spyOn(target, 'removeEventListener').mockImplementation((type, l, o) => {
                live.set(`${label}:${type}`, (live.get(`${label}:${type}`) ?? 0) - 1);
                remove(type, l, o);
            });
        };
        const watched = [
            'window:resize',
            'window:scroll',
            'document:pointerdown',
            'document:focusin',
            'document:keydown',
        ];
        const open = () => watched.filter((k) => (live.get(k) ?? 0) > 0);
        track(window, 'window');
        track(document, 'document');
        const { unmount } = render(<Harness />);
        await user.click(trigger());
        expect(open()).toEqual(watched);
        await user.click(trigger());
        expect(open()).toEqual([]);
        await user.click(trigger());
        expect(open()).toEqual(watched);
        unmount();
        expect(open()).toEqual([]);
    });

    it('script placement: the side, the coordinates, the capped width and the room are written', async () => {
        render(<Harness />);
        await userEvent.setup().click(trigger());
        const panel = group()?.parentElement as HTMLElement;
        expect(panel).toHaveAttribute('data-side', 'below');
        expect(panel.style.getPropertyValue('--ms-room')).toMatch(/^\d+(\.\d+)?px$/);
        expect(panel.style.bottom).toBe('auto');
    });
});

describe('placePanel (one rule for both placement paths)', () => {
    /** A 320 by 640 phone under the shell's 56px bar. */
    const vp = { width: 320, height: 640, top: 56 };
    const panel = { width: 288, height: 300 };

    it('below the button, end edge on the button end, inside the viewport', () => {
        expect(placePanel({ left: 200, right: 300, top: 100, bottom: 142 }, panel, vp)).toEqual({
            side: 'below',
            left: 16,
            width: 288,
            top: 148,
            room: 640 - EDGE - (142 + GAP),
        });
    });

    it('moved inward on a 320px phone, whichever side the button is on', () => {
        for (const right of [60, 160, 304]) {
            const p = placePanel({ left: right - 100, right, top: 100, bottom: 142 }, panel, vp);
            expect(p.left).toBeGreaterThanOrEqual(EDGE);
            expect(p.left + p.width).toBeLessThanOrEqual(vp.width - EDGE);
        }
    });

    it('the width is capped to the viewport less EDGE on both sides', () => {
        const wide = placePanel(
            { left: 0, right: 100, top: 100, bottom: 140 },
            { width: 600, height: 10 },
            vp,
        );
        expect(wide.width).toBe(320 - 2 * EDGE);
        expect(wide.left).toBe(EDGE);
        expect(wide.left + wide.width).toBe(320 - EDGE);
        // Narrower than the cap: its own width.
        expect(placePanel({ left: 0, right: 100, top: 100, bottom: 140 }, panel, vp).width).toBe(
            288,
        );
    });

    it('above the button when it does not fit below and the room above is larger', () => {
        const p = placePanel({ left: 200, right: 300, top: 560, bottom: 602 }, panel, vp);
        expect(p.side).toBe('above');
        // Its bottom edge GAP above the button, measured from the viewport's bottom.
        expect(p.bottom).toBe(640 - 560 + GAP);
        expect(p.top).toBeUndefined();
        // The room stops EDGE under the bar, never under it.
        expect(p.room).toBe(560 - GAP - (56 + EDGE));
    });

    it('below whenever it fits there, even with more room above', () => {
        const p = placePanel(
            { left: 0, right: 100, top: 400, bottom: 440 },
            { width: 288, height: 150 },
            vp,
        );
        expect(p.side).toBe('below');
        expect(p.room).toBe(640 - EDGE - 446);
    });

    it('fitting nowhere: the side with more room, and the panel scrolls inside that room', () => {
        const short = { width: 667, height: 375, top: 56 };
        const tall = { width: 288, height: 352 };
        // Button high: more room below.
        const high = placePanel({ left: 0, right: 100, top: 120, bottom: 162 }, tall, short);
        expect(high).toMatchObject({ side: 'below', room: 375 - EDGE - 168 });
        // Button low: more room above, bounded by the bar.
        const low = placePanel({ left: 0, right: 100, top: 280, bottom: 322 }, tall, short);
        expect(low).toMatchObject({ side: 'above', room: 280 - GAP - 72 });
        // Equal rooms (122px each side): below.
        const mid = placePanel({ left: 0, right: 100, top: 200, bottom: 200 }, tall, {
            width: 320,
            height: 344,
            top: 56,
        });
        expect(mid).toMatchObject({ side: 'below', room: 122 });
    });

    it('no room at all: zero, never negative', () => {
        const p = placePanel({ left: 0, right: 100, top: 60, bottom: 630 }, panel, {
            width: 320,
            height: 640,
            top: 56,
        });
        expect(p.room).toBe(0);
    });
});
