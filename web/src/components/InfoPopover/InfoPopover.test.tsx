import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Dialog } from '@/components/Dialog/Dialog';
import { focusQuietly } from '@/lib/quietFocus';
import { CLOSE_DELAY_MS, EXIT_MS, FLASH_MS, InfoPopover, OPEN_DELAY_MS } from './InfoPopover';

/*
 * T-S14.3i: the shared info popover. Every way of opening and closing, the single-open rule, the timed open and its
 * pause, Escape and focus return, the tone attribute, the accessible name, the content per form. jsdom has no Popover
 * API: the fallback (`hidden`) is the path under test, plus one run with the API stubbed in.
 */

beforeEach(() => {
    vi.useFakeTimers();
});
afterEach(() => {
    vi.useRealTimers();
    delete (window as { matchMedia?: unknown }).matchMedia;
});

const trigger = (name = 'About the budget') => screen.getByRole('button', { name });
const panelOf = (button: HTMLElement) => button.nextElementSibling as HTMLElement;
const isOpen = (button: HTMLElement) => button.getAttribute('aria-expanded') === 'true';
const wait = (ms: number) => act(() => vi.advanceTimersByTime(ms));
const mouse = { pointerType: 'mouse' };

function Basic(props: { flash?: number; tone?: 'quiet' | 'warning' }) {
    return (
        <>
            <button type="button">Before</button>
            <InfoPopover
                label="About the budget"
                heading="Character Budget"
                list={['One', 'Two']}
                foot="Ignored in Classic."
                {...props}
            >
                Paid from this budget.
            </InfoPopover>
            <button type="button">After</button>
        </>
    );
}

describe('InfoPopover: the trigger', () => {
    it('a button named by the caller, collapsed, quiet by default, the exclamation mark drawn', () => {
        render(<Basic />);
        const b = trigger();
        expect(b.tagName).toBe('BUTTON');
        expect(b).toHaveAttribute('type', 'button');
        expect(b).toHaveAttribute('aria-expanded', 'false');
        expect(b).toHaveAttribute('data-tone', 'quiet');
        expect(b.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
        expect(b).not.toHaveAttribute('aria-describedby');
    });

    it('the warning tone is a stable attribute on the trigger and the panel', () => {
        render(<Basic tone="warning" />);
        expect(trigger()).toHaveAttribute('data-tone', 'warning');
        expect(panelOf(trigger())).toHaveAttribute('data-tone', 'warning');
    });

    it('a caller-drawn trigger keeps the button and its name', () => {
        render(
            <InfoPopover label="Save status" trigger={<span data-testid="mine" />} form="pill">
                Saved
            </InfoPopover>,
        );
        expect(trigger('Save status').querySelector('[data-testid="mine"]')).not.toBeNull();
        expect(trigger('Save status').querySelector('svg')).toBeNull();
    });
});

describe('InfoPopover: the panel', () => {
    it('a tooltip right after the trigger; its content only while it shows', () => {
        render(<Basic />);
        const p = panelOf(trigger());
        expect(p).toHaveAttribute('role', 'tooltip');
        expect(p).toHaveAttribute('hidden');
        expect(p.textContent).toBe('');
        fireEvent.click(trigger());
        expect(p).not.toHaveAttribute('hidden');
        expect(p.querySelector('p')?.textContent).toBe('Character Budget');
        expect([...p.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['One', 'Two']);
        expect(p.textContent).toContain('Paid from this budget.');
        expect(p.lastElementChild?.textContent).toBe('Ignored in Classic.');
    });

    it('the pill: one line of text straight in the panel, no inner element', () => {
        render(
            <InfoPopover label="Save status" form="pill" tone="warning">
                Not saved: no connection
            </InfoPopover>,
        );
        fireEvent.click(trigger('Save status'));
        const p = panelOf(trigger('Save status'));
        expect(p).toHaveAttribute('data-form', 'pill');
        expect(p.children).toHaveLength(0);
        expect(p.textContent).toBe('Not saved: no connection');
    });

    it('interactive content: a labelled group, not a tooltip', () => {
        render(
            <InfoPopover label="About links" interactive>
                <a href="/x">More</a>
            </InfoPopover>,
        );
        const p = panelOf(trigger('About links'));
        expect(p).toHaveAttribute('role', 'group');
        expect(p).toHaveAttribute('aria-labelledby', trigger('About links').id);
    });
});

describe('InfoPopover: hover', () => {
    it('opens after the intent delay, not before; closes after the close delay once the pointer leaves', () => {
        render(<Basic />);
        fireEvent.pointerOver(trigger(), mouse);
        wait(OPEN_DELAY_MS - 1);
        expect(isOpen(trigger())).toBe(false);
        wait(1);
        expect(isOpen(trigger())).toBe(true);
        fireEvent.pointerOut(trigger(), mouse);
        wait(CLOSE_DELAY_MS - 1);
        expect(isOpen(trigger())).toBe(true);
        wait(1);
        expect(isOpen(trigger())).toBe(false);
    });

    it('a pointer that only passes over (left before the delay) opens nothing', () => {
        render(<Basic />);
        fireEvent.pointerOver(trigger(), mouse);
        wait(OPEN_DELAY_MS / 2);
        fireEvent.pointerOut(trigger(), mouse);
        wait(OPEN_DELAY_MS * 2);
        expect(isOpen(trigger())).toBe(false);
    });

    it('moving from the trigger onto the panel keeps it open; leaving the panel closes it', () => {
        render(<Basic />);
        fireEvent.pointerOver(trigger(), mouse);
        wait(OPEN_DELAY_MS);
        const p = panelOf(trigger());
        fireEvent.pointerOut(trigger(), mouse);
        wait(CLOSE_DELAY_MS / 2);
        fireEvent.pointerOver(p, mouse);
        wait(CLOSE_DELAY_MS * 4);
        expect(isOpen(trigger())).toBe(true);
        fireEvent.pointerOut(p, mouse);
        wait(CLOSE_DELAY_MS);
        expect(isOpen(trigger())).toBe(false);
    });

    it('nothing is announced on hover: no live region, no description on the trigger', () => {
        render(<Basic />);
        fireEvent.pointerOver(trigger(), mouse);
        wait(OPEN_DELAY_MS);
        const p = panelOf(trigger());
        expect(p).not.toHaveAttribute('aria-live');
        expect(p).not.toHaveAttribute('role', 'status');
        expect(trigger()).not.toHaveAttribute('aria-describedby');
    });
});

describe('InfoPopover: keyboard', () => {
    it('focus opens it after the delay; focus moving on closes it', () => {
        render(<Basic />);
        act(() => trigger().focus());
        wait(OPEN_DELAY_MS);
        expect(isOpen(trigger())).toBe(true);
        act(() => screen.getByRole('button', { name: 'After' }).focus());
        expect(isOpen(trigger())).toBe(false);
    });

    it('tabbing past (focus gone before the delay) opens nothing', () => {
        render(<Basic />);
        act(() => trigger().focus());
        act(() => screen.getByRole('button', { name: 'After' }).focus());
        wait(OPEN_DELAY_MS * 2);
        expect(isOpen(trigger())).toBe(false);
    });

    it('Escape closes it and keeps focus on the trigger', () => {
        render(<Basic />);
        act(() => trigger().focus());
        wait(OPEN_DELAY_MS);
        fireEvent.keyDown(document.activeElement as Element, { key: 'Escape' });
        expect(isOpen(trigger())).toBe(false);
        expect(trigger()).toHaveFocus();
    });

    it('Escape with focus inside an interactive panel returns focus to the trigger', () => {
        render(
            <InfoPopover label="About links" interactive>
                <a href="/x">More</a>
            </InfoPopover>,
        );
        fireEvent.click(trigger('About links'));
        const link = screen.getByRole('link', { name: 'More' });
        act(() => link.focus());
        expect(isOpen(trigger('About links'))).toBe(true);
        fireEvent.keyDown(link, { key: 'Escape' });
        expect(isOpen(trigger('About links'))).toBe(false);
        expect(trigger('About links')).toHaveFocus();
    });

    it('Enter (a click) on a focus-opened panel pins it; a second press closes it', () => {
        render(<Basic />);
        act(() => trigger().focus());
        wait(OPEN_DELAY_MS);
        fireEvent.click(trigger());
        expect(isOpen(trigger())).toBe(true);
        fireEvent.click(trigger());
        expect(isOpen(trigger())).toBe(false);
    });

    // T-S14.4d-fix (review D S1): focus moved by code is nobody's keyboard focus.
    it('focus moved by code (focusQuietly) opens nothing; the next keyboard focus opens it as usual', () => {
        render(<Basic />);
        act(() => focusQuietly(trigger()));
        expect(trigger()).toHaveFocus();
        wait(OPEN_DELAY_MS * 3);
        expect(isOpen(trigger())).toBe(false);
        act(() => screen.getByRole('button', { name: 'After' }).focus());
        act(() => trigger().focus());
        wait(OPEN_DELAY_MS);
        expect(isOpen(trigger())).toBe(true);
    });

    it('a quiet focus still opens on a click (Enter or a tap) afterwards', () => {
        render(<Basic />);
        act(() => focusQuietly(trigger()));
        fireEvent.click(trigger());
        expect(isOpen(trigger())).toBe(true);
    });
});

describe('InfoPopover: click and tap', () => {
    it('a click toggles it; a click-opened panel stays when the pointer leaves', () => {
        render(<Basic />);
        fireEvent.pointerDown(trigger(), mouse);
        fireEvent.click(trigger());
        expect(isOpen(trigger())).toBe(true);
        fireEvent.pointerOut(trigger(), mouse);
        wait(CLOSE_DELAY_MS * 4);
        expect(isOpen(trigger())).toBe(true);
        fireEvent.click(trigger());
        expect(isOpen(trigger())).toBe(false);
    });

    it('a press focuses the trigger without the focus opening a second way (the click decides)', () => {
        render(<Basic />);
        fireEvent.pointerDown(trigger(), mouse);
        act(() => trigger().focus());
        fireEvent.click(trigger());
        wait(OPEN_DELAY_MS * 2);
        expect(isOpen(trigger())).toBe(true);
        expect(panelOf(trigger())).toHaveAttribute('data-why', 'click');
    });

    it('a touch never opens it by hover: the tap toggles it, a tap outside closes it', () => {
        render(<Basic />);
        const touch = { pointerType: 'touch' };
        fireEvent.pointerOver(trigger(), touch);
        wait(OPEN_DELAY_MS * 2);
        expect(isOpen(trigger())).toBe(false);
        fireEvent.pointerDown(trigger(), touch);
        act(() => trigger().focus());
        fireEvent.click(trigger());
        fireEvent.pointerOut(trigger(), touch);
        wait(CLOSE_DELAY_MS * 4);
        expect(isOpen(trigger())).toBe(true);
        fireEvent.pointerDown(document.body, touch);
        expect(isOpen(trigger())).toBe(false);
    });

    it('a press outside closes it', () => {
        render(<Basic />);
        fireEvent.click(trigger());
        fireEvent.pointerDown(document.body);
        expect(isOpen(trigger())).toBe(false);
    });

    it('a press on the panel itself does not', () => {
        render(<Basic />);
        fireEvent.click(trigger());
        fireEvent.pointerDown(panelOf(trigger()));
        expect(isOpen(trigger())).toBe(true);
    });
});

describe('InfoPopover: one open at a time', () => {
    it('opening a second closes the first', () => {
        render(
            <>
                <InfoPopover label="First">One</InfoPopover>
                <InfoPopover label="Second">Two</InfoPopover>
            </>,
        );
        fireEvent.click(trigger('First'));
        expect(isOpen(trigger('First'))).toBe(true);
        fireEvent.pointerOver(trigger('Second'), mouse);
        wait(OPEN_DELAY_MS);
        expect(isOpen(trigger('Second'))).toBe(true);
        expect(isOpen(trigger('First'))).toBe(false);
    });
});

function Flashing() {
    const [n, setN] = useState(0);
    const [other, setOther] = useState(0);
    return (
        <>
            <button type="button" onClick={() => setN((x) => x + 1)}>
                Problem
            </button>
            <button type="button" onClick={() => setOther((x) => x + 1)}>
                Re-render
            </button>
            <span data-testid="other">{other}</span>
            <InfoPopover label="Save status" form="pill" tone="warning" flash={n}>
                Not saved: no connection
            </InfoPopover>
        </>
    );
}

describe('InfoPopover: the timed open (flash)', () => {
    it('a new occurrence shows it by itself for FLASH_MS, focus untouched; then it closes', () => {
        render(<Flashing />);
        const source = screen.getByRole('button', { name: 'Problem' });
        act(() => source.focus());
        fireEvent.click(source);
        expect(isOpen(trigger('Save status'))).toBe(true);
        expect(source).toHaveFocus();
        wait(FLASH_MS - 1);
        expect(isOpen(trigger('Save status'))).toBe(true);
        wait(1);
        expect(isOpen(trigger('Save status'))).toBe(false);
    });

    it('a re-render with the same occurrence does not reopen it; a new one does', () => {
        render(<Flashing />);
        fireEvent.click(screen.getByRole('button', { name: 'Problem' }));
        wait(FLASH_MS);
        fireEvent.click(screen.getByRole('button', { name: 'Re-render' }));
        expect(screen.getByTestId('other')).toHaveTextContent('1');
        expect(isOpen(trigger('Save status'))).toBe(false);
        fireEvent.click(screen.getByRole('button', { name: 'Problem' }));
        expect(isOpen(trigger('Save status'))).toBe(true);
    });

    it('a value present at mount shows it once; 0 never does', () => {
        const { unmount } = render(
            <InfoPopover label="A" form="pill" flash={3}>
                x
            </InfoPopover>,
        );
        expect(isOpen(trigger('A'))).toBe(true);
        unmount();
        render(
            <InfoPopover label="B" form="pill" flash={0}>
                y
            </InfoPopover>,
        );
        expect(isOpen(trigger('B'))).toBe(false);
    });

    it('paused while hovered: still open past FLASH_MS; the rest of the time runs once the pointer leaves', () => {
        render(<Flashing />);
        fireEvent.click(screen.getByRole('button', { name: 'Problem' }));
        wait(2000);
        fireEvent.pointerOver(trigger('Save status'), mouse);
        wait(FLASH_MS * 2);
        expect(isOpen(trigger('Save status'))).toBe(true);
        fireEvent.pointerOut(trigger('Save status'), mouse);
        wait(FLASH_MS - 2000 - 1);
        expect(isOpen(trigger('Save status'))).toBe(true);
        wait(1);
        expect(isOpen(trigger('Save status'))).toBe(false);
    });

    it('a change to 0 ends a timed open at once; one the person opened stays', () => {
        const { rerender } = render(
            <InfoPopover label="C" form="pill" flash={1}>
                z
            </InfoPopover>,
        );
        expect(isOpen(trigger('C'))).toBe(true);
        rerender(
            <InfoPopover label="C" form="pill" flash={0}>
                z
            </InfoPopover>,
        );
        expect(isOpen(trigger('C'))).toBe(false);
        fireEvent.click(trigger('C'));
        rerender(
            <InfoPopover label="C" form="pill" flash={2}>
                z
            </InfoPopover>,
        );
        rerender(
            <InfoPopover label="C" form="pill" flash={0}>
                z
            </InfoPopover>,
        );
        expect(isOpen(trigger('C'))).toBe(true);
    });

    it('paused while focused', () => {
        render(<Flashing />);
        fireEvent.click(screen.getByRole('button', { name: 'Problem' }));
        act(() => trigger('Save status').focus());
        wait(FLASH_MS * 2);
        expect(isOpen(trigger('Save status'))).toBe(true);
    });

    it('Escape and a press outside close it too', () => {
        render(<Flashing />);
        fireEvent.click(screen.getByRole('button', { name: 'Problem' }));
        fireEvent.keyDown(document.body, { key: 'Escape' });
        expect(isOpen(trigger('Save status'))).toBe(false);
        fireEvent.click(screen.getByRole('button', { name: 'Problem' }));
        fireEvent.pointerDown(document.body);
        expect(isOpen(trigger('Save status'))).toBe(false);
    });
});

describe('InfoPopover: modal dialogs (S14.3k)', () => {
    // jsdom has no `showModal`: there an open dialog counts as modal (the pages' fallback opens it by the attribute).
    const made: HTMLDialogElement[] = [];
    afterEach(() => {
        for (const d of made.splice(0)) d.remove();
    });
    const modal = () => {
        const d = document.createElement('dialog');
        document.body.append(d);
        made.push(d);
        return d;
    };
    const show = (d: HTMLDialogElement) =>
        act(async () => {
            d.setAttribute('open', '');
        });
    const hide = (d: HTMLDialogElement) =>
        act(async () => {
            d.removeAttribute('open');
        });
    const problem = () => fireEvent.click(screen.getByRole('button', { name: 'Problem' }));

    it('no timed open while a modal dialog is open; it shows by its normal rule once the dialog closes', async () => {
        render(<Flashing />);
        const d = modal();
        await show(d);
        problem();
        expect(isOpen(trigger('Save status'))).toBe(false);
        wait(FLASH_MS * 2);
        expect(isOpen(trigger('Save status'))).toBe(false);
        await hide(d);
        expect(isOpen(trigger('Save status'))).toBe(true);
        expect(panelOf(trigger('Save status'))).toHaveAttribute('data-why', 'flash');
        wait(FLASH_MS);
        expect(isOpen(trigger('Save status'))).toBe(false);
    });

    it('an open panel closes when a modal dialog opens; a timed one comes back once it closes, a clicked one does not', async () => {
        render(<Flashing />);
        const d = modal();
        problem();
        expect(isOpen(trigger('Save status'))).toBe(true);
        await show(d);
        expect(isOpen(trigger('Save status'))).toBe(false);
        await hide(d);
        expect(isOpen(trigger('Save status'))).toBe(true);
        // A click on the timed panel pins it (now opened by the person).
        fireEvent.click(trigger('Save status'));
        expect(panelOf(trigger('Save status'))).toHaveAttribute('data-why', 'click');
        await show(d);
        expect(isOpen(trigger('Save status'))).toBe(false);
        await hide(d);
        expect(isOpen(trigger('Save status'))).toBe(false);
    });

    it('a held timed open whose occurrence ended meanwhile (flash back to 0) stays closed', async () => {
        const d = modal();
        await show(d);
        const { rerender } = render(
            <InfoPopover label="C" form="pill" flash={1}>
                z
            </InfoPopover>,
        );
        expect(isOpen(trigger('C'))).toBe(false);
        rerender(
            <InfoPopover label="C" form="pill" flash={0}>
                z
            </InfoPopover>,
        );
        await hide(d);
        expect(isOpen(trigger('C'))).toBe(false);
    });

    it('a popover inside the open modal works as usual; one outside it stays held', async () => {
        render(
            <>
                <InfoPopover label="Outside" form="pill" flash={1}>
                    out
                </InfoPopover>
                <dialog open>
                    <InfoPopover label="Inside" form="pill" flash={1}>
                        in
                    </InfoPopover>
                    <InfoPopover label="Inside click">click</InfoPopover>
                </dialog>
            </>,
        );
        expect(isOpen(trigger('Inside'))).toBe(true);
        expect(isOpen(trigger('Outside'))).toBe(false);
        fireEvent.click(trigger('Inside click'));
        expect(isOpen(trigger('Inside click'))).toBe(true);
        expect(isOpen(trigger('Inside'))).toBe(false);
        expect(isOpen(trigger('Outside'))).toBe(false);
    });

    // T-S14.4b-fix (review B, S5): the shared Dialog stacked (`Stacked` below).
    it('a timed open in a second dialog over a first shows; one in the first dialog, now under it, is held', () => {
        const { rerender } = render(<Stacked flash={0} />);
        fireEvent.click(screen.getByRole('button', { name: 'Advanced Settings' }));
        expect(document.querySelectorAll('dialog[open]')).toHaveLength(2);
        rerender(<Stacked flash={1} firstFlash={1} />);
        expect(isOpen(trigger('About Best Of'))).toBe(true);
        expect(panelOf(trigger('About Best Of'))).toHaveAttribute('data-why', 'flash');
        expect(isOpen(trigger('About the mode'))).toBe(false);
    });

    it('the Escape that closes an open panel is cancelled (not also the dialog’s close request); with none open it is not', () => {
        render(<Stacked flash={0} />);
        fireEvent.click(trigger('About the mode'));
        expect(isOpen(trigger('About the mode'))).toBe(true);
        expect(fireEvent.keyDown(trigger('About the mode'), { key: 'Escape' })).toBe(false);
        expect(isOpen(trigger('About the mode'))).toBe(false);
        expect(fireEvent.keyDown(trigger('About the mode'), { key: 'Escape' })).toBe(true);
    });
});

/** T-S14.4b-fix: two shared Dialogs stacked (the create form and its Advanced Settings), a popover in each. */
function Stacked({ flash, firstFlash = 0 }: { flash: number; firstFlash?: number }) {
    const [second, setSecond] = useState(false);
    return (
        <Dialog open onClose={() => {}} title="Create Lobby">
            <button type="button" onClick={() => setSecond(true)}>
                Advanced Settings
            </button>
            <InfoPopover label="About the mode" form="pill" flash={firstFlash}>
                mode
            </InfoPopover>
            <Dialog open={second} onClose={() => setSecond(false)} title="Advanced Settings">
                <InfoPopover label="About Best Of" form="pill" flash={flash}>
                    best of
                </InfoPopover>
            </Dialog>
        </Dialog>
    );
}

describe('InfoPopover: exit and reduced motion', () => {
    it('closing fades out: the content stays for EXIT_MS, then goes', () => {
        render(<Basic />);
        fireEvent.click(trigger());
        fireEvent.click(trigger());
        const p = panelOf(trigger());
        expect(p).toHaveAttribute('data-leaving');
        expect(p.textContent).not.toBe('');
        wait(EXIT_MS);
        expect(p).not.toHaveAttribute('data-leaving');
        expect(p).toHaveAttribute('hidden');
        expect(p.textContent).toBe('');
    });

    it('under reduced motion it goes at once', () => {
        Object.defineProperty(window, 'matchMedia', {
            configurable: true,
            writable: true,
            value: (q: string) => ({
                matches: q === '(prefers-reduced-motion: reduce)',
                media: q,
                addEventListener: () => {},
                removeEventListener: () => {},
            }),
        });
        render(<Basic />);
        fireEvent.click(trigger());
        fireEvent.click(trigger());
        expect(panelOf(trigger())).not.toHaveAttribute('data-leaving');
        expect(panelOf(trigger())).toHaveAttribute('hidden');
    });
});

describe('InfoPopover: the top layer', () => {
    it('a manual popover where the API exists: shown on open, hidden after the exit fade', () => {
        const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
        let open = false;
        const show = vi.fn(() => {
            open = true;
        });
        const hide = vi.fn(() => {
            open = false;
        });
        const matches = Element.prototype.matches;
        proto.showPopover = show;
        proto.hidePopover = hide;
        Element.prototype.matches = function (this: Element, s: string) {
            if (s === ':popover-open') return open;
            return matches.call(this, s);
        } as typeof matches;
        try {
            render(<Basic />);
            const p = panelOf(trigger());
            expect(p).toHaveAttribute('popover', 'manual');
            expect(p).not.toHaveAttribute('hidden');
            fireEvent.click(trigger());
            expect(show).toHaveBeenCalledTimes(1);
            fireEvent.click(trigger());
            expect(hide).not.toHaveBeenCalled();
            wait(EXIT_MS);
            expect(hide).toHaveBeenCalledTimes(1);
        } finally {
            delete proto.showPopover;
            delete proto.hidePopover;
            Element.prototype.matches = matches;
        }
    });
});
