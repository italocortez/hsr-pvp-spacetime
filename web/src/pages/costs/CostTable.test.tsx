import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collapseItem } from '@/lib/scrollCollapse';
import { buildCostLookup } from '@/stdb/costLookup';
import { CHARACTERS, characterCost, LIGHTCONES, synergy } from '@/test/costFixtures';
import { CostTable, type CostTableProps, NARROW_QUERY, type TableMeasure } from './CostTable';
import { buildCharacterRows, buildLightconeRows } from './costModel';

/*
 * T-COSTS-B: the cost table's scroller through the component, with an injected measure (jsdom
 * has no layout) and the script path of the collapsing name column (jsdom's `CSS.supports` is
 * stubbed to say no to scroll-driven animations; `matchMedia` is mocked for the narrow rule).
 */

let narrow = true;
beforeEach(() => {
    narrow = true;
    Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        writable: true,
        value: (query: string) => ({
            matches: query === NARROW_QUERY ? narrow : false,
            media: query,
            addEventListener: () => {},
            removeEventListener: () => {},
        }),
    });
    vi.spyOn(CSS, 'supports').mockReturnValue(false);
});
afterEach(() => {
    delete (window as { matchMedia?: unknown }).matchMedia;
    vi.restoreAllMocks();
});

const MODES = { gameMode: 'ApocalypticShadow', draftMode: 'Classic' } as const;
const byName = new Map(CHARACTERS.map((c) => [c.name, c] as const));
const lookup = buildCostLookup(
    [characterCost('acheron', 7), characterCost('clara', 2)],
    [],
    [synergy('clara', 'huohuo', -1)],
);
const CHAR_ROWS = buildCharacterRows(CHARACTERS, lookup, MODES, byName);
const LC_ROWS = buildLightconeRows(LIGHTCONES, lookup, MODES);

/** A scroller of 348 by 600px around a 780px-wide table (390px phone), scrolled to `x`. */
function measured(over: Partial<TableMeasure> = {}) {
    const state: TableMeasure = {
        scrollLeft: 0,
        scrollWidth: 780,
        clientWidth: 348,
        scrollHeight: 600,
        clientHeight: 600,
        start: 246,
        closed: 74,
        ...over,
    };
    return { state, measure: () => state };
}

function renderTable(props: Partial<CostTableProps> = {}) {
    const all: CostTableProps = {
        tab: 'characters',
        rows: CHAR_ROWS,
        state: 'ready',
        sort: 'name',
        dir: 'asc',
        onSort: () => {},
        expanded: new Set(['clara']),
        onToggleExpanded: () => {},
        captionId: 'cap',
        caption: 'Costs',
        hasFilters: false,
        onClearFilters: () => {},
        onRetry: () => {},
        idPrefix: 't',
        ...props,
    };
    const r = render(<CostTable {...all} />);
    return { ...r, scroller: () => screen.getByRole('region', { name: 'Costs' }) };
}

const frame = () => act(() => new Promise<void>((done) => requestAnimationFrame(() => done())));

describe('the scroller as a Tab stop (C4)', () => {
    it('a Tab stop while it can scroll either way, otherwise focusable from script only', () => {
        expect(renderTable({ measure: measured().measure }).scroller()).toHaveAttribute(
            'tabindex',
            '0',
        );
    });

    it.each([
        ['sideways only', { scrollWidth: 780, clientWidth: 348 }, '0'],
        ['down only', { scrollWidth: 348, scrollHeight: 2000 }, '0'],
        ['neither (one pixel is rounding)', { scrollWidth: 349, clientWidth: 348 }, '-1'],
    ])('%s', (_l, over, tabindex) => {
        const { scroller } = renderTable({ measure: measured(over).measure });
        expect(scroller()).toHaveAttribute('tabindex', tabindex);
    });
});

describe('the collapsing name column', () => {
    it('applies at the narrow step while the table scrolls sideways; the script path writes the values', async () => {
        const { state, measure } = measured();
        const { scroller } = renderTable({ measure });
        expect(scroller()).toHaveAttribute('data-scroll-collapse', 'script');
        expect(scroller()).toHaveAttribute('data-tab', 'characters');
        const width = () => scroller().style.getPropertyValue('--collapse-w');
        const fade = () => scroller().style.getPropertyValue('--collapse-fade');
        const seen: [number, string, string][] = [];
        for (const x of [0, 60, 120, 172, 300, 172, 60, 0]) {
            state.scrollLeft = x;
            fireEvent.scroll(scroller());
            await frame();
            seen.push([x, width(), fade()]);
        }
        expect(seen).toEqual([
            [0, '246px', '1'],
            [60, '186px', '0.5'],
            [120, '126px', '0'],
            [172, '74px', '0'],
            [300, '74px', '0'],
            [172, '74px', '0'],
            [60, '186px', '0.5'],
            [0, '246px', '1'],
        ]);
    });

    it('Light Cones collapse to their own width (52px)', async () => {
        const { state, measure } = measured({ closed: 52 });
        const { scroller } = renderTable({ tab: 'lightcones', rows: LC_ROWS, measure });
        expect(scroller()).toHaveAttribute('data-tab', 'lightcones');
        state.scrollLeft = 300;
        fireEvent.scroll(scroller());
        await frame();
        expect(scroller().style.getPropertyValue('--collapse-w')).toBe('52px');
    });

    it('not above the narrow step (560px), and not when the table fits', () => {
        narrow = false;
        const wide = renderTable({ measure: measured().measure });
        expect(wide.scroller()).not.toHaveAttribute('data-scroll-collapse');
        wide.unmount();
        narrow = true;
        const fits = renderTable({ measure: measured({ scrollWidth: 348 }).measure });
        expect(fits.scroller()).not.toHaveAttribute('data-scroll-collapse');
    });

    it('every first-column cell collapses: the header, each row, the synergy sub-rows', () => {
        renderTable({ measure: measured().measure });
        const firsts = [...document.querySelectorAll('[data-first]')];
        expect(firsts.length).toBe(1 + CHAR_ROWS.length + 2);
        for (const cell of firsts) expect(cell).toHaveClass(collapseItem);
        // The other cells do not.
        expect(document.querySelectorAll(`.${collapseItem}`)).toHaveLength(firsts.length);
    });

    it('keyboard focus on a row control reopens that one cell; moving on closes it', async () => {
        const user = userEvent.setup();
        renderTable({ measure: measured({ scrollLeft: 300 }).measure });
        const expander = screen.getByRole('button', { name: 'Synergies for Clara' });
        const nameHeader = screen.getByRole('columnheader', { name: 'Character' });
        act(() => within(nameHeader).getByRole('button').focus());
        // The sort header is a first-column cell too: it reopens while focused.
        expect(screen.getByRole('columnheader', { name: 'Character' })).toHaveAttribute(
            'data-reopen',
        );
        while (document.activeElement !== expander) await user.tab();
        const cell = expander.closest('th') as HTMLElement;
        expect(cell).toHaveAttribute('data-reopen');
        expect(screen.getByRole('columnheader', { name: 'Character' })).not.toHaveAttribute(
            'data-reopen',
        );
        await user.tab();
        expect(cell).not.toHaveAttribute('data-reopen');
        // The hidden name stays in the accessibility tree whatever the width.
        expect(within(cell).getByText('Clara')).toBeInTheDocument();
        expect(screen.getByRole('rowheader', { name: 'Clara' })).toBe(cell);
    });
});
