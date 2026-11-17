import type { AutosaveStatus } from '@shared/loadouts';
import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AutosaveRing, CHECK_HOLD_MS, SaveIndicator, type SaveView } from './AutosaveRing';
import { LoadoutsPanel } from './LoadoutsPanel';
import type { LoadoutItem, LoadoutStatus, LoadoutsState } from './useLoadouts';

// T-S14.3c-fix (review S2): the ring's fill is placed on the scheduler's clock, fixed for one wait.
// T-S14.3g: the save indicator: each state's icon, hidden words and tooltip; problems keep their words; the check
// after a save, its coalescing, no replay on a switch or a re-render; reduced motion; the panel's announcements.

afterEach(() => {
    vi.useRealTimers();
    delete (window as { matchMedia?: unknown }).matchMedia;
});

const fill = (c: HTMLElement) => c.querySelector('[data-fill]') as HTMLElement;
const timing = (el: HTMLElement) => [
    el.style.getPropertyValue('--ring-ms'),
    el.style.getPropertyValue('--ring-delay'),
];

describe('AutosaveRing (waiting)', () => {
    it('mounted halfway through the wait: the fill runs over the whole wait, started where it stands', () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(100_000);
        const { container } = render(
            <AutosaveRing status={{ kind: 'waiting', from: 70_000, due: 130_000 }} reasonId="r" />,
        );
        expect(timing(fill(container))).toEqual(['60000ms', '-30000ms']);
    });

    it('a re-render later in the same wait writes the same values (no jump)', () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(100_000);
        const status = { kind: 'waiting', from: 100_000, due: 160_000 } as const;
        const { container, rerender } = render(<AutosaveRing status={status} reasonId="r" />);
        const before = timing(fill(container));
        vi.setSystemTime(140_000);
        rerender(<AutosaveRing status={{ ...status }} reasonId="r" />);
        expect(timing(fill(container))).toEqual(before);
        expect(before).toEqual(['60000ms', '-0ms']);
    });

    it('the ceiling: a wait shorter than 60 s fills over its own length', () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(10_000);
        const { container } = render(
            <AutosaveRing status={{ kind: 'waiting', from: 0, due: 40_000 }} reasonId="r" />,
        );
        expect(timing(fill(container))).toEqual(['40000ms', '-10000ms']);
    });
});

// ── T-S14.3g: the indicator.

const icon = (c: ParentNode) => c.querySelector('[data-save-icon]')?.getAttribute('data-save-icon');
/**
 * Every value an attribute of `el` took while `run` ran, the starting one first, repeats folded (the observer's
 * records are taken at once, so no value is missed and no microtask is needed).
 */
function history(el: HTMLElement, attribute: string, run: () => void): string[] {
    const watch = new MutationObserver(() => {});
    watch.observe(el, { attributes: true, attributeFilter: [attribute], attributeOldValue: true });
    run();
    const records = watch.takeRecords();
    watch.disconnect();
    const values = [...records.map((r) => r.oldValue ?? ''), el.getAttribute(attribute) ?? ''];
    return values.filter((v, n) => v !== values[n - 1]);
}
const mark = (c: ParentNode) => c.querySelector('[data-save-icon]') as HTMLElement;
const saidOf = (c: ParentNode) => c.querySelector('[data-save-said]')?.textContent ?? null;
/** The text a sighted person sees in the indicator: everything but the hidden words. */
const visibleText = (c: ParentNode) => {
    const wrap = c.querySelector('[data-state]') as HTMLElement;
    const copy = wrap.cloneNode(true) as HTMLElement;
    for (const el of copy.querySelectorAll('[data-save-said]')) el.remove();
    return copy.textContent ?? '';
};

const statuses: [string, AutosaveStatus, string, string, string][] = [
    ['waiting', { kind: 'waiting', from: 0, due: 60_000 }, 'ring', 'Saving soon', 'Saving soon'],
    ['saving', { kind: 'saving' }, 'ring-full', 'Saving…', 'Saving…'],
    [
        'saved this visit',
        { kind: 'saved', everSaved: true },
        'floppy',
        'Auto saved',
        'Saved automatically',
    ],
    [
        'saved before',
        { kind: 'saved', everSaved: false },
        'floppy',
        'Saved to your account',
        'Saved automatically',
    ],
];

describe('SaveIndicator: the good states (account)', () => {
    it.each(statuses)(
        '%s: its icon, the words hidden (and as the tooltip), nothing visible',
        (_, status, i, words, tip) => {
            const { container } = render(<AutosaveRing status={status} reasonId="r" />);
            expect(icon(container)).toBe(i);
            expect(saidOf(container)).toBe(words);
            expect(mark(container).getAttribute('title')).toBe(tip);
            expect(mark(container).getAttribute('aria-hidden')).toBe('true');
            expect(mark(container).hasAttribute('tabindex')).toBe(false);
            expect(visibleText(container)).toBe('');
        },
    );

    it('a browser loadout: the floppy, "Saved in this browser" hidden and as the tooltip', () => {
        const view: SaveView = {
            kind: 'saved',
            said: 'Saved in this browser',
            tip: 'Saved in this browser',
        };
        const { container } = render(<SaveIndicator view={view} loadoutId="b" saves={0} />);
        expect(icon(container)).toBe('floppy');
        expect(saidOf(container)).toBe('Saved in this browser');
        expect(mark(container).getAttribute('title')).toBe('Saved in this browser');
        expect(visibleText(container)).toBe('');
    });
});

describe('SaveIndicator: problems keep their words', () => {
    it('blocked: the warning icon beside "Not saved yet" and the reason (with its id), no hidden copy, no tooltip', () => {
        const { container } = render(
            <AutosaveRing
                status={{ kind: 'blocked', reason: 'other-tab', message: null }}
                reasonId="why"
            />,
        );
        expect(icon(container)).toBe('warning');
        expect(visibleText(container)).toBe(
            'Not saved yetBeing changed in another tab of this browser. That tab saves it.',
        );
        expect(container.querySelector('#why')?.textContent).toMatch(/another tab/);
        expect(saidOf(container)).toBeNull();
        expect(mark(container).hasAttribute('title')).toBe(false);
    });

    it('a server text is shown as it is', () => {
        const { container } = render(
            <AutosaveRing
                status={{ kind: 'blocked', reason: 'too-fast', message: 'Slow down.' }}
                reasonId="why"
            />,
        );
        expect(visibleText(container)).toBe('Not saved yetSlow down.');
    });

    it('when the problem clears, the sequence resumes (a new wait shows the ring)', () => {
        const { container, rerender } = render(
            <AutosaveRing
                status={{ kind: 'blocked', reason: 'offline', message: null }}
                reasonId="r"
            />,
        );
        rerender(<AutosaveRing status={{ kind: 'waiting', from: 0, due: 60_000 }} reasonId="r" />);
        expect(icon(container)).toBe('ring');
        expect(visibleText(container)).toBe('');
    });
});

describe('SaveIndicator: the check after a save', () => {
    const saving: AutosaveStatus = { kind: 'saving' };
    const saved: AutosaveStatus = { kind: 'saved', everSaved: true };

    it('a save that lands: the full ring turns straight into the check, which settles to the floppy', () => {
        vi.useFakeTimers();
        const { container, rerender } = render(
            <AutosaveRing status={saving} reasonId="r" saves={0} />,
        );
        const seen = history(mark(container), 'data-save-icon', () => {
            rerender(<AutosaveRing status={saved} reasonId="r" saves={1} />);
            expect(icon(container)).toBe('check');
            act(() => vi.advanceTimersByTime(CHECK_HOLD_MS - 1));
            expect(icon(container)).toBe('check');
            act(() => vi.advanceTimersByTime(1));
            expect(icon(container)).toBe('floppy');
        });
        // Never a floppy between the full ring and the check.
        expect(seen).toEqual(['ring-full', 'check', 'floppy']);
    });

    it('a burst of saves: one check, kept up while they go on, then the floppy CHECK_HOLD_MS after the last', () => {
        vi.useFakeTimers();
        const view: SaveView = { kind: 'saved', said: 'Saved in this browser', tip: 'x' };
        const { container, rerender } = render(
            <SaveIndicator view={view} loadoutId="b" saves={0} />,
        );
        const phases = history(mark(container), 'data-phase', () => {
            for (let n = 1; n <= 6; n++) {
                rerender(<SaveIndicator view={view} loadoutId="b" saves={n} />);
                act(() => vi.advanceTimersByTime(300));
                expect(icon(container)).toBe('check');
            }
            act(() => vi.advanceTimersByTime(CHECK_HOLD_MS - 300));
            expect(icon(container)).toBe('floppy');
        });
        // The check started once (no rest between the saves): six saves, one check.
        expect(phases).toEqual(['rest', 'check', 'rest']);
    });

    it('a re-render (a pool search, a filter) neither restarts nor skips the check', () => {
        vi.useFakeTimers();
        const { container, rerender } = render(
            <AutosaveRing status={saving} reasonId="r" saves={0} />,
        );
        rerender(<AutosaveRing status={saved} reasonId="r" saves={1} />);
        act(() => vi.advanceTimersByTime(CHECK_HOLD_MS / 2));
        rerender(<AutosaveRing status={{ ...saved }} reasonId="r" saves={1} />);
        expect(icon(container)).toBe('check');
        act(() => vi.advanceTimersByTime(CHECK_HOLD_MS / 2));
        expect(icon(container)).toBe('floppy');
    });

    it('an edit right after a save: the check gives way to the ring', () => {
        vi.useFakeTimers();
        const { container, rerender } = render(
            <AutosaveRing status={saving} reasonId="r" saves={0} />,
        );
        rerender(<AutosaveRing status={saved} reasonId="r" saves={1} />);
        rerender(
            <AutosaveRing
                status={{ kind: 'waiting', from: 0, due: 60_000 }}
                reasonId="r"
                saves={1}
            />,
        );
        expect(icon(container)).toBe('ring');
        act(() => vi.advanceTimersByTime(CHECK_HOLD_MS));
        expect(icon(container)).toBe('ring');
    });

    it('a page load with everything saved: the floppy at once, nothing played', () => {
        const { container } = render(<AutosaveRing status={saved} reasonId="r" />);
        expect(icon(container)).toBe('floppy');
        expect(mark(container).hasAttribute('data-instant')).toBe(false);
    });

    it('a switch to another loadout: its state at once (no transition), no check replayed', () => {
        vi.useFakeTimers();
        const { container, rerender } = render(
            <AutosaveRing
                status={{ kind: 'waiting', from: 0, due: 60_000 }}
                reasonId="r"
                loadoutId="a"
            />,
        );
        rerender(<AutosaveRing status={saved} reasonId="r" loadoutId="b" />);
        expect(icon(container)).toBe('floppy');
        expect(mark(container).hasAttribute('data-instant')).toBe(true);
        // A later change of state animates again.
        rerender(
            <AutosaveRing
                status={{ kind: 'waiting', from: 0, due: 60_000 }}
                reasonId="r"
                loadoutId="b"
            />,
        );
        expect(mark(container).hasAttribute('data-instant')).toBe(false);
    });
});

describe('SaveIndicator: reduced motion', () => {
    const reduce = (on: boolean) =>
        Object.defineProperty(window, 'matchMedia', {
            configurable: true,
            writable: true,
            value: (query: string) => ({
                matches: on && query === '(prefers-reduced-motion: reduce)',
                media: query,
                addEventListener: () => {},
                removeEventListener: () => {},
            }),
        });

    it('asked for: no motion attribute in any state; the states still change (check, then floppy)', () => {
        vi.useFakeTimers();
        reduce(true);
        const { container, rerender } = render(
            <AutosaveRing status={{ kind: 'waiting', from: 0, due: 60_000 }} reasonId="r" />,
        );
        expect(mark(container).hasAttribute('data-motion')).toBe(false);
        rerender(<AutosaveRing status={{ kind: 'saving' }} reasonId="r" />);
        expect(mark(container).hasAttribute('data-motion')).toBe(false);
        rerender(
            <AutosaveRing status={{ kind: 'saved', everSaved: true }} reasonId="r" saves={1} />,
        );
        expect(icon(container)).toBe('check');
        expect(mark(container).hasAttribute('data-motion')).toBe(false);
        act(() => vi.advanceTimersByTime(CHECK_HOLD_MS));
        expect(icon(container)).toBe('floppy');
    });

    it('not asked for: the motion attribute is set', () => {
        reduce(false);
        const { container } = render(<AutosaveRing status={{ kind: 'saving' }} reasonId="r" />);
        expect(mark(container).hasAttribute('data-motion')).toBe(true);
    });
});

// ── T-S14.3g: the panel's wiring (a stand-in for `useLoadouts`; no router needed while `known` is false).

const item = (key: string, code = 'c1', name = 'Team'): LoadoutItem =>
    ({ key, name, note: '', code, store: 'browser', filled: 1, held: null }) as LoadoutItem;

function state(
    status: LoadoutStatus,
    active: LoadoutsState['active'],
    browser: LoadoutItem[] = [],
): LoadoutsState {
    const none = () => null;
    return {
        active,
        name: 'Team',
        note: '',
        browser,
        account: null,
        accountReady: false,
        accountError: undefined,
        verified: false,
        known: false,
        storageOk: true,
        status,
        notice: null,
        dismissNotice: () => {},
        held: null,
        otherHeld: [],
        create: none,
        duplicate: none,
        rename: () => {},
        switchTo: () => {},
    } as unknown as LoadoutsState;
}

/** The working loadout (empty by default). */
const working = (o: { loading?: boolean; empty?: boolean } = {}) =>
    state(
        { kind: 'working', full: null, loading: o.loading ?? false, empty: o.empty ?? true },
        { kind: 'working' },
    );

function panel(loadouts: LoadoutsState, announce = vi.fn()) {
    return (
        <LoadoutsPanel loadouts={loadouts} code={null} announce={announce} onLoaded={() => {}} />
    );
}

describe('LoadoutsPanel: the indicator and its announcements', () => {
    const browserA = { kind: 'browser', key: 'a' } as const;
    const saved = { kind: 'browser' } as const;

    it('an empty working loadout: no icon, its line as text', () => {
        const { container } = render(panel(working()));
        expect(icon(container)).toBeUndefined();
        expect(container.textContent).toContain('Pick a character to start a loadout.');
    });

    it('a working loadout still loading: a quiet glyph and its words, visible', () => {
        const { container } = render(panel(working({ loading: true, empty: false })));
        expect(icon(container)).toBe('warning');
        expect(visibleText(container)).toBe('Your account loadouts are loading.');
    });

    it('a team from a link, not stored yet: the glyph and its words', () => {
        const { container } = render(panel(working({ empty: false })));
        expect(icon(container)).toBe('warning');
        expect(visibleText(container)).toBe('Auto saves after edits');
    });

    it('T-S14.3h: a team not stored yet is in the quiet tone; real problems keep the warning tone', () => {
        const tone = (c: HTMLElement) => c.querySelector('[data-tone]')?.getAttribute('data-tone');
        const unsaved = render(panel(working({ empty: false })));
        expect(tone(unsaved.container)).toBe('quiet');
        unsaved.unmount();
        const off = state({ kind: 'browser' }, { kind: 'browser', key: 'a' }, [item('a')]);
        const storageOff = render(panel({ ...off, storageOk: false }));
        expect(tone(storageOff.container)).toBe('warning');
        storageOff.unmount();
        const full = render(
            panel(
                state(
                    { kind: 'working', full: 'browser', loading: false, empty: false },
                    { kind: 'working' },
                ),
            ),
        );
        expect(tone(full.container)).toBe('warning');
        full.unmount();
        const offline = render(
            <AutosaveRing
                status={{ kind: 'blocked', reason: 'offline', message: null }}
                reasonId="r"
            />,
        );
        expect(tone(offline.container)).toBe('warning');
    });

    it('the first pick: the in-between render (a character, not stored yet) flashes no warning', () => {
        const { container, rerender } = render(panel(working()));
        rerender(panel(working({ empty: false })));
        expect(icon(container)).toBeUndefined();
        rerender(panel(state(saved, browserA, [item('a')])));
        expect(icon(container)).toBe('check');
    });

    it('browser storage off: a warning and the words, never the floppy', () => {
        const s = state(saved, browserA, [item('a')]);
        const { container } = render(panel({ ...s, storageOk: false }));
        expect(icon(container)).toBe('warning');
        expect(visibleText(container)).toBe('Browser storage is off: kept for this visit only');
    });

    it('the first pick (a new browser loadout): the check; a reload of it: the floppy', () => {
        vi.useFakeTimers();
        const { container, rerender } = render(panel(working()));
        rerender(panel(state(saved, browserA, [item('a')])));
        expect(icon(container)).toBe('check');
        const again = render(panel(state(saved, browserA, [item('a')])));
        expect(icon(again.container)).toBe('floppy');
    });

    it('browser edits in quick succession: one check, held while they go on', () => {
        vi.useFakeTimers();
        const { container, rerender } = render(panel(state(saved, browserA, [item('a', 'c0')])));
        expect(icon(container)).toBe('floppy');
        for (let n = 1; n <= 5; n++) {
            rerender(panel(state(saved, browserA, [item('a', `c${n}`)])));
            expect(icon(container)).toBe('check');
            act(() => vi.advanceTimersByTime(200));
        }
        act(() => vi.advanceTimersByTime(CHECK_HOLD_MS));
        expect(icon(container)).toBe('floppy');
    });

    it('a switch to another saved browser loadout: no check', () => {
        const list = [item('a', 'c1'), item('b', 'c2')];
        const { container, rerender } = render(panel(state(saved, browserA, list)));
        rerender(panel(state(saved, { kind: 'browser', key: 'b' }, list)));
        expect(icon(container)).toBe('floppy');
    });

    it('a re-render with nothing changed: no check', () => {
        const s = state(saved, browserA, [item('a')]);
        const { container, rerender } = render(panel(s));
        rerender(panel({ ...s }));
        expect(icon(container)).toBe('floppy');
    });

    it('account: announced on a change of state only (saving to saved; a problem), never per tick or on a switch', () => {
        vi.useFakeTimers();
        const announce = vi.fn();
        const acc = (autosave: AutosaveStatus, key = '0') =>
            panel(state({ kind: 'account', autosave }, { kind: 'account', key }), announce);
        const { container, rerender } = render(acc({ kind: 'waiting', from: 0, due: 60_000 }));
        rerender(acc({ kind: 'waiting', from: 0, due: 60_000 }));
        rerender(acc({ kind: 'saving' }));
        expect(announce).not.toHaveBeenCalled();
        rerender(acc({ kind: 'saved', everSaved: true }));
        expect(icon(container)).toBe('check');
        expect(announce.mock.calls).toEqual([['Auto saved.']]);
        rerender(acc({ kind: 'saved', everSaved: true }));
        rerender(acc({ kind: 'blocked', reason: 'offline', message: null }));
        expect(announce).toHaveBeenCalledTimes(2);
        expect(announce.mock.calls[1]?.[0]).toMatch(/^Not saved yet. No connection/);
        // Another loadout: its state, no word, no check.
        rerender(acc({ kind: 'saved', everSaved: false }, '1'));
        expect(announce).toHaveBeenCalledTimes(2);
        expect(icon(container)).toBe('floppy');
    });
});
