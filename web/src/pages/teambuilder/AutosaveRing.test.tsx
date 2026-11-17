import type { AutosaveStatus } from '@shared/loadouts';
import { act, fireEvent, render, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FLASH_MS } from '@/components/InfoPopover/InfoPopover';
import {
    AutosaveRing,
    CHECK_HOLD_MS,
    PILL_TEXT,
    SAVE_STATUS_LABEL,
    SaveIndicator,
    type SaveView,
} from './AutosaveRing';
import { EMPTY_WORKING, LoadoutsPanel, STORAGE_OFF, STORAGE_OFF_PILL } from './LoadoutsPanel';
import type { LoadoutItem, LoadoutStatus, LoadoutsState } from './useLoadouts';

// T-S14.3c-fix (review S2): the ring's fill is placed on the scheduler's clock, fixed for one wait.
// T-S14.3g: the save indicator: each state's icon, hidden words and tooltip; problems keep their words; the check
// after a save, its coalescing, no replay on a switch or a re-render; reduced motion; the panel's announcements.
// T-S14.3i: icon-only in every state (no visible words beside the name); the words in the shared info popover (the
// `title` tooltip is gone); problems: the warning mark, their words hidden, the pill shown by itself once per
// occurrence; the notices that need a choice keep their rows; the name row's structure the same in every state.

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
/** S14.3i: a problem's hidden words (the label, then the reason), or null. */
const problemWords = (c: ParentNode) => {
    const parts = [...c.querySelectorAll('[data-save-problem]')].map((el) => el.textContent);
    return parts.length > 0 ? parts.join(' | ') : null;
};
/**
 * The text a sighted person sees beside the name: everything in the indicator but the hidden words and the
 * popover (which floats in the top layer, away from the row).
 */
const visibleText = (c: ParentNode) => {
    const wrap = c.querySelector('[data-state]') as HTMLElement;
    const copy = wrap.cloneNode(true) as HTMLElement;
    for (const el of copy.querySelectorAll(
        '[data-save-said], [data-save-problem], [data-info-popover]',
    ))
        el.remove();
    return copy.textContent ?? '';
};
/** S14.3i: the save spot's button (the popover's trigger) and its popover. */
const saveButton = (c: HTMLElement) =>
    within(c).getByRole('button', { name: SAVE_STATUS_LABEL }) as HTMLElement;
const pillOf = (c: HTMLElement) => saveButton(c).nextElementSibling as HTMLElement;
const pillOpen = (c: HTMLElement) => saveButton(c).getAttribute('aria-expanded') === 'true';
/** The popover's words after a press on the save spot (closed again after). */
function popoverWords(c: HTMLElement): string {
    const wasOpen = pillOpen(c);
    if (!wasOpen) fireEvent.click(saveButton(c));
    const words = pillOf(c).textContent ?? '';
    if (!wasOpen) fireEvent.click(saveButton(c));
    return words;
}

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
        '%s: its icon, the words hidden and in the quiet popover (no title), nothing visible',
        (_, status, i, words, tip) => {
            const { container } = render(<AutosaveRing status={status} reasonId="r" />);
            expect(icon(container)).toBe(i);
            expect(saidOf(container)).toBe(words);
            expect(mark(container).hasAttribute('title')).toBe(false);
            expect(mark(container).getAttribute('aria-hidden')).toBe('true');
            expect(visibleText(container)).toBe('');
            // The box is the popover's trigger: a button with its own name, quiet, closed until asked.
            expect(saveButton(container)).toHaveAttribute('data-tone', 'quiet');
            expect(pillOpen(container)).toBe(false);
            expect(popoverWords(container)).toBe(tip);
        },
    );

    it('a browser loadout: the floppy, "Saved in this browser" hidden and in the popover', () => {
        const view: SaveView = {
            kind: 'saved',
            said: 'Saved in this browser',
            tip: 'Saved in this browser',
        };
        const { container } = render(<SaveIndicator view={view} loadoutId="b" saves={0} />);
        expect(icon(container)).toBe('floppy');
        expect(saidOf(container)).toBe('Saved in this browser');
        expect(mark(container).hasAttribute('title')).toBe(false);
        expect(visibleText(container)).toBe('');
        expect(popoverWords(container)).toBe('Saved in this browser');
    });

    it('the hidden words carry the id the name field points at', () => {
        const { container } = render(
            <SaveIndicator
                view={{ kind: 'saving', said: 'Saving…' }}
                loadoutId="a"
                saves={0}
                wordsId="words"
            />,
        );
        expect(container.querySelector('#words')?.textContent).toBe('Saving…');
    });
});

describe('SaveIndicator: problems (S14.3i: the mark, the words hidden, the pill)', () => {
    it('blocked: the warning mark, "Not saved yet" and the reason hidden (with its id), the pill shown by itself', () => {
        const { container } = render(
            <AutosaveRing
                status={{ kind: 'blocked', reason: 'other-tab', message: null }}
                reasonId="why"
            />,
        );
        expect(icon(container)).toBe('warning');
        expect(visibleText(container)).toBe('');
        expect(problemWords(container)).toBe(
            'Not saved yet | Being changed in another tab of this browser. That tab saves it.',
        );
        expect(container.querySelector('#why')?.textContent).toMatch(/another tab/);
        expect(saidOf(container)).toBeNull();
        expect(mark(container).hasAttribute('title')).toBe(false);
        expect(saveButton(container)).toHaveAttribute('data-tone', 'warning');
        expect(pillOpen(container)).toBe(true);
        expect(pillOf(container)).toHaveAttribute('data-form', 'pill');
        expect(pillOf(container)).toHaveAttribute('data-tone', 'warning');
        expect(pillOf(container).textContent).toBe(PILL_TEXT['other-tab']);
    });

    it('a server text is kept as it is in the hidden words; the pill keeps its short line', () => {
        const { container } = render(
            <AutosaveRing
                status={{ kind: 'blocked', reason: 'too-fast', message: 'Slow down.' }}
                reasonId="why"
            />,
        );
        expect(problemWords(container)).toBe('Not saved yet | Slow down.');
        expect(visibleText(container)).toBe('');
        expect(pillOf(container).textContent).toBe(PILL_TEXT['too-fast']);
    });

    it('the pill: once per occurrence, gone after FLASH_MS while the mark stays; never again on a re-render', () => {
        vi.useFakeTimers();
        const offline: AutosaveStatus = { kind: 'blocked', reason: 'offline', message: null };
        const { container, rerender } = render(<AutosaveRing status={offline} reasonId="r" />);
        expect(pillOpen(container)).toBe(true);
        act(() => vi.advanceTimersByTime(FLASH_MS));
        expect(pillOpen(container)).toBe(false);
        expect(icon(container)).toBe('warning');
        rerender(<AutosaveRing status={{ ...offline }} reasonId="r" />);
        act(() => vi.advanceTimersByTime(10));
        expect(pillOpen(container)).toBe(false);
        // Its reason changes: a new occurrence.
        rerender(
            <AutosaveRing
                status={{ kind: 'blocked', reason: 'server-error', message: null }}
                reasonId="r"
            />,
        );
        expect(pillOpen(container)).toBe(true);
        expect(pillOf(container).textContent).toBe(PILL_TEXT['server-error']);
    });

    it('hover, focus or a tap brings the pill back', () => {
        vi.useFakeTimers();
        const { container } = render(
            <AutosaveRing
                status={{ kind: 'blocked', reason: 'offline', message: null }}
                reasonId="r"
            />,
        );
        act(() => vi.advanceTimersByTime(FLASH_MS));
        expect(pillOpen(container)).toBe(false);
        fireEvent.click(saveButton(container));
        expect(pillOpen(container)).toBe(true);
        expect(pillOf(container).textContent).toBe(PILL_TEXT.offline);
    });

    it('when the problem clears, the sequence resumes (a new wait shows the ring) with no pill', () => {
        const { container, rerender } = render(
            <AutosaveRing
                status={{ kind: 'blocked', reason: 'offline', message: null }}
                reasonId="r"
            />,
        );
        expect(pillOpen(container)).toBe(true);
        rerender(<AutosaveRing status={{ kind: 'waiting', from: 0, due: 60_000 }} reasonId="r" />);
        expect(icon(container)).toBe('ring');
        expect(visibleText(container)).toBe('');
        expect(pillOpen(container)).toBe(false);
        expect(saveButton(container)).toHaveAttribute('data-tone', 'quiet');
    });

    it('a quiet state (not a fault) never shows its pill by itself', () => {
        const { container } = render(
            <SaveIndicator
                view={{ kind: 'problem', label: 'Auto saves after edits', quiet: true }}
                loadoutId="w"
                saves={0}
            />,
        );
        expect(pillOpen(container)).toBe(false);
        expect(saveButton(container)).toHaveAttribute('data-tone', 'quiet');
        expect(popoverWords(container)).toBe('Auto saves after edits');
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

    it('S14.3i: an empty working loadout: the quiet "!", its line hidden and in the popover, none by itself', () => {
        const { container } = render(panel(working()));
        expect(icon(container)).toBe('warning');
        expect(container.querySelector('[data-state]')).toHaveAttribute('data-state', 'empty');
        expect(container.querySelector('[data-state]')).toHaveAttribute('data-tone', 'quiet');
        expect(problemWords(container)).toBe(EMPTY_WORKING);
        expect(visibleText(container)).toBe('');
        expect(pillOpen(container)).toBe(false);
        expect(popoverWords(container)).toBe(EMPTY_WORKING);
    });

    it('a working loadout still loading: a quiet glyph, its words hidden and in the popover', () => {
        const { container } = render(panel(working({ loading: true, empty: false })));
        expect(icon(container)).toBe('warning');
        expect(visibleText(container)).toBe('');
        expect(problemWords(container)).toBe('Your account loadouts are loading.');
        expect(pillOpen(container)).toBe(false);
        expect(popoverWords(container)).toBe('Your account loadouts are loading.');
    });

    it('a team from a link, not stored yet: the glyph, its words hidden and in the popover', () => {
        const { container } = render(panel(working({ empty: false })));
        expect(icon(container)).toBe('warning');
        expect(visibleText(container)).toBe('');
        expect(problemWords(container)).toBe('Auto saves after edits');
        expect(popoverWords(container)).toBe('Auto saves after edits');
    });

    it('S14.3i: no words beside the name in any state, one button in the same fixed spot, the row unchanged', () => {
        const views: [string, LoadoutsState][] = [
            ['empty', working()],
            ['loading', working({ loading: true, empty: false })],
            ['not stored', working({ empty: false })],
            [
                'browser full',
                state(
                    { kind: 'working', full: 'browser', loading: false, empty: false },
                    { kind: 'working' },
                ),
            ],
            ['saved', state(saved, browserA, [item('a')])],
            ['storage off', { ...state(saved, browserA, [item('a')]), storageOk: false }],
            ...(
                [
                    { kind: 'waiting', from: 0, due: 60_000 },
                    { kind: 'saving' },
                    { kind: 'saved', everSaved: true },
                    { kind: 'blocked', reason: 'offline', message: null },
                    { kind: 'blocked', reason: 'full', message: null },
                    { kind: 'blocked', reason: 'conflict', message: null },
                ] as AutosaveStatus[]
            ).map(
                (autosave) =>
                    [
                        `account ${autosave.kind}`,
                        state({ kind: 'account', autosave }, { kind: 'account', key: '0' }),
                    ] as [string, LoadoutsState],
            ),
        ];
        const shapes = new Set<string>();
        for (const [name, s] of views) {
            const { container, unmount } = render(panel(s));
            const row = container.querySelector('input[aria-label="Rename active loadout"]')
                ?.parentElement?.parentElement as HTMLElement;
            const status = row.lastElementChild as HTMLElement;
            expect(visibleText(container), name).toBe('');
            expect(within(status).getAllByRole('button', { hidden: true }), name).toHaveLength(1);
            // The row's own markup (classes, attributes, children) is the same in every state.
            shapes.add(
                `${row.className}|${[...row.attributes].map((a) => a.name).join(',')}|${row.children.length}|${status.className}`,
            );
            unmount();
        }
        expect(shapes.size).toBe(1);
    });

    it('S14.3i: the notices that need a choice keep their visible rows; the name field’s description includes them', () => {
        const full = render(
            panel(
                state(
                    {
                        kind: 'account',
                        autosave: { kind: 'blocked', reason: 'full', message: null },
                    },
                    { kind: 'account', key: '0' },
                ),
            ),
        );
        const text = 'Your account already holds 10 loadouts. Delete one to save this one.';
        const row = full.container.querySelector('[data-full-notice]') as HTMLElement;
        expect(row.textContent).toBe(text);
        expect(problemWords(full.container)).toBe('Not saved yet');
        expect(pillOf(full.container).textContent).toBe(PILL_TEXT.full);
        const name = within(full.container).getByRole('textbox', { name: 'Rename active loadout' });
        expect(name).toHaveAccessibleDescription(`Not saved yet ${text}`);
        full.unmount();
        const working = render(
            panel(
                state(
                    { kind: 'working', full: 'account', loading: false, empty: false },
                    { kind: 'working' },
                ),
            ),
        );
        expect(working.container.querySelector('[data-full-notice]')?.textContent).toMatch(
            /^Not saved: your account holds 10 loadouts/,
        );
        expect(problemWords(working.container)).toBeNull();
        expect(pillOpen(working.container)).toBe(true);
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

    it('the first pick: the in-between render (a character, not stored yet) keeps the empty state, then the check', () => {
        const { container, rerender } = render(panel(working()));
        rerender(panel(working({ empty: false })));
        expect(container.querySelector('[data-state]')).toHaveAttribute('data-state', 'empty');
        expect(problemWords(container)).toBe(EMPTY_WORKING);
        expect(pillOpen(container)).toBe(false);
        rerender(panel(state(saved, browserA, [item('a')])));
        expect(icon(container)).toBe('check');
    });

    it('browser storage off: the warning mark, its words hidden, its pill by itself, never the floppy', () => {
        const s = state(saved, browserA, [item('a')]);
        const { container } = render(panel({ ...s, storageOk: false }));
        expect(icon(container)).toBe('warning');
        expect(visibleText(container)).toBe('');
        expect(problemWords(container)).toBe(STORAGE_OFF);
        expect(pillOpen(container)).toBe(true);
        expect(pillOf(container).textContent).toBe(STORAGE_OFF_PILL);
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
