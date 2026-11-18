import { act, render, screen, waitFor } from '@testing-library/react';
import type { ChartConfiguration } from 'chart.js';
import { type CSSProperties, StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Chart } from './Chart';
import type { ChartModel } from './types';

/*
 * T-S14.5c: the shared chart wrapper with Chart.js mocked at the module boundary (jsdom has no canvas; no canvas
 * package). What this proves: one chart per mount (also under strict mode), updates without a new chart, destroy on
 * unmount, the registered pieces, the wrapper's options (responsive, reduced motion followed live, the HTML tooltip),
 * colours read from CSS custom properties and read again on a theme change, the text alternative (name, description,
 * table) and the legend. What it cannot prove: how Chart.js draws; that is the browser check.
 */

type Fake = {
    canvas: HTMLCanvasElement;
    data: ChartConfiguration['data'];
    // biome-ignore lint/suspicious/noExplicitAny: the options tree is read as plain data
    options: any;
    updates: (string | undefined)[];
    destroyed: boolean;
};

const h = vi.hoisted(() => ({ charts: [] as Fake[], registered: [] as { id?: string }[] }));

vi.mock('chart.js', () => {
    class Chart {
        static register(...items: { id?: string }[]) {
            h.registered.push(...items);
        }
        ctx = {};
        data: unknown;
        options: unknown;
        updates: (string | undefined)[] = [];
        destroyed = false;
        constructor(
            public canvas: HTMLCanvasElement,
            config: { data: unknown; options: unknown },
        ) {
            this.data = config.data;
            this.options = config.options;
            h.charts.push(this as unknown as Fake);
        }
        update(mode?: string) {
            this.updates.push(mode);
        }
        destroy() {
            this.destroyed = true;
        }
    }
    const piece = (id: string) => ({ id });
    return {
        Chart,
        BarController: piece('bar'),
        BarElement: piece('barElement'),
        CategoryScale: piece('category'),
        LinearScale: piece('linear'),
        Tooltip: piece('tooltip'),
    };
});

let reduce = false;
let mediaListeners: (() => void)[] = [];

beforeEach(() => {
    h.charts.length = 0;
    reduce = false;
    mediaListeners = [];
    vi.stubGlobal(
        'ResizeObserver',
        class {
            observe() {}
            unobserve() {}
            disconnect() {}
        },
    );
    vi.stubGlobal('matchMedia', (query: string) => ({
        get matches() {
            return query.includes('reduced-motion') && reduce;
        },
        addEventListener: (_: string, fn: () => void) => mediaListeners.push(fn),
        removeEventListener: (_: string, fn: () => void) => {
            mediaListeners = mediaListeners.filter((f) => f !== fn);
        },
    }));
});
afterEach(() => {
    vi.unstubAllGlobals();
    document.documentElement.className = '';
});

function model(values: number[], extra: Partial<ChartModel> = {}): ChartModel {
    return {
        label: 'Cost per thing',
        description: 'Bars per thing. Every value is in the table that follows.',
        config: {
            type: 'bar',
            data: {
                labels: values.map((_, i) => `T${i}`),
                datasets: [{ label: 'A', data: values, backgroundColor: 'var(--chart-tone-1)' }],
            },
            options: { animation: { duration: 500 } },
        } as ChartConfiguration,
        table: {
            columns: ['Thing', 'Value'],
            rows: values.map((v, i) => ({ key: `t${i}`, cells: [`T${i}`, String(v)] })),
        },
        tips: values.map((v, i) => ({
            title: `T${i}`,
            rows: [{ color: '--chart-tone-1', label: 'A', value: String(v) }],
            footer: `Total ${v}`,
        })),
        legend: [{ key: 'a', label: 'A', color: '--chart-tone-1' }],
        ...extra,
    };
}

const live = () => h.charts.filter((c) => !c.destroyed);
const created = () => waitFor(() => expect(h.charts.length).toBeGreaterThan(0));

describe('Chart (the shared Chart.js wrapper)', () => {
    it('creates one chart on its canvas with the wrapper options; registers only the pieces it uses', async () => {
        render(<Chart model={model([1, 2])} />);
        await created();
        const [chart] = h.charts;
        expect(chart?.canvas).toBe(screen.getByRole('img', { name: 'Cost per thing' }));
        expect(chart?.data.labels).toEqual(['T0', 'T1']);
        expect(chart?.options.responsive).toBe(true);
        expect(chart?.options.maintainAspectRatio).toBe(false);
        expect(chart?.options.animation).toEqual({ duration: 500 });
        // The HTML tooltip replaces Chart.js's own.
        expect(chart?.options.plugins.tooltip.enabled).toBe(false);
        expect(typeof chart?.options.plugins.tooltip.external).toBe('function');
        expect(h.registered.map((r) => r.id).sort()).toEqual(
            ['bar', 'barElement', 'category', 'linear', 'stackLabels', 'tooltip'].sort(),
        );
    });

    it('a new model updates the same chart; it is never recreated', async () => {
        const { rerender } = render(<Chart model={model([1, 2])} />);
        await created();
        rerender(<Chart model={model([3, 4, 5])} />);
        expect(h.charts).toHaveLength(1);
        const [chart] = h.charts;
        expect(chart?.data.labels).toEqual(['T0', 'T1', 'T2']);
        expect(chart?.data.datasets[0]?.data).toEqual([3, 4, 5]);
        // Animated (no mode), as a data change should be.
        expect(chart?.updates.at(-1)).toBeUndefined();
        expect(screen.getAllByRole('row')).toHaveLength(4);
    });

    it('destroys its chart on unmount', async () => {
        const { unmount } = render(<Chart model={model([1])} />);
        await created();
        unmount();
        expect(h.charts[0]?.destroyed).toBe(true);
        expect(live()).toHaveLength(0);
    });

    it('strict mode (mount, unmount, mount): one live chart, destroyed on unmount', async () => {
        const { unmount } = render(
            <StrictMode>
                <Chart model={model([1, 2])} />
            </StrictMode>,
        );
        await created();
        // Let any cancelled first load settle: it must not draw.
        await act(async () => new Promise((r) => setTimeout(r, 20)));
        expect(live()).toHaveLength(1);
        expect(h.charts).toHaveLength(1);
        unmount();
        expect(live()).toHaveLength(0);
    });

    it('reduced motion: no animation, followed live', async () => {
        reduce = true;
        render(<Chart model={model([1])} />);
        await created();
        const [chart] = h.charts;
        expect(chart?.options.animation).toBe(false);
        reduce = false;
        act(() => {
            for (const fn of mediaListeners) fn();
        });
        expect(chart?.options.animation).toEqual({ duration: 500 });
        // A theme refresh redraws without animating.
        expect(chart?.updates.at(-1)).toBe('none');
    });

    it('reads colours from CSS custom properties, again when the theme changes; the model is not changed', async () => {
        const m = model([1]);
        render(
            <div style={{ '--chart-tone-1': '#123456' } as CSSProperties} data-testid="host">
                <Chart model={m} />
            </div>,
        );
        await created();
        const colour = () => h.charts[0]?.data.datasets[0]?.backgroundColor;
        expect(colour()).toMatch(/^(#123456|rgb\(18, 52, 86\))$/);
        expect(m.config.data.datasets[0]?.backgroundColor).toBe('var(--chart-tone-1)');
        screen.getByTestId('host').style.setProperty('--chart-tone-1', '#654321');
        document.documentElement.className = 'theme-changed';
        await waitFor(() => expect(colour()).toMatch(/^(#654321|rgb\(101, 67, 33\))$/));
        expect(h.charts[0]?.updates.at(-1)).toBe('none');
    });

    it('text alternative: a named, described canvas and a hidden table with every value', () => {
        render(<Chart model={model([1.5, 2])} />);
        const canvas = screen.getByRole('img', { name: 'Cost per thing' });
        expect(canvas).toHaveAccessibleDescription(
            'Bars per thing. Every value is in the table that follows.',
        );
        const table = screen.getByRole('table', { name: 'Cost per thing' });
        const rows = [...table.querySelectorAll('tr')].map((r) =>
            [...r.querySelectorAll('th, td')].map((c) => c.textContent),
        );
        expect(rows).toEqual([
            ['Thing', 'Value'],
            ['T0', '1.5'],
            ['T1', '2'],
        ]);
        expect(screen.getAllByRole('rowheader').map((c) => c.textContent)).toEqual(['T0', 'T1']);
        // The legend is visual only.
        expect(table.parentElement?.querySelector('ul')).toHaveAttribute('aria-hidden', 'true');
    });

    it('no data: the empty text and no table', () => {
        render(<Chart model={model([], { empty: 'Nothing yet' })} />);
        expect(screen.getByText('Nothing yet')).toBeInTheDocument();
        expect(screen.queryByRole('table')).toBeNull();
        // The empty text describes the canvas in place of the description (said once).
        expect(screen.getByRole('img')).toHaveAccessibleDescription('Nothing yet');
    });

    it('the tooltip: shown from Chart.js, hidden by Escape until the pointer leaves', async () => {
        const { container } = render(<Chart model={model([1, 2])} />);
        await created();
        const external = h.charts[0]?.options.plugins.tooltip.external as (a: unknown) => void;
        const point = (index: number) => ({
            dataIndex: index,
            raw: 1,
            element: { y: 40 },
        });
        const scales = {
            x: { getPixelForValue: (i: number) => 50 + i * 100 },
            y: { getPixelForValue: () => 200 },
        };
        const show = (index: number) =>
            act(() =>
                external({
                    tooltip: {
                        opacity: 1,
                        dataPoints: [point(index)],
                        chart: { scales },
                        caretX: 0,
                        caretY: 0,
                    },
                }),
            );
        const tip = () => container.querySelector('[aria-hidden="true"] b')?.closest('div');
        show(1);
        expect(tip()).toHaveTextContent('T1A2Total 2');
        expect(tip()?.style.getPropertyValue('--x')).toBe('150px');
        act(() => {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        });
        expect(tip()).toBeFalsy();
        show(1);
        expect(tip()).toBeFalsy();
        // The pointer leaves (Chart.js hides its tooltip): the next hover shows it again.
        act(() => external({ tooltip: { opacity: 0, dataPoints: [], chart: { scales } } }));
        show(1);
        expect(tip()).toHaveTextContent('T1');
    });

    it('without ResizeObserver (no layout engine) nothing is loaded; the table stays', async () => {
        vi.stubGlobal('ResizeObserver', undefined);
        render(<Chart model={model([1])} />);
        await act(async () => new Promise((r) => setTimeout(r, 20)));
        expect(h.charts).toHaveLength(0);
        expect(screen.getByRole('table')).toBeInTheDocument();
    });
});
