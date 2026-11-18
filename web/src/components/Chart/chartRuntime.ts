import {
    BarController,
    BarElement,
    CategoryScale,
    Chart,
    type ChartConfiguration,
    LinearScale,
    type Plugin,
    Tooltip,
} from 'chart.js';
import type { StackLabelsOptions } from './types';

/*
 * The shared chart's Chart.js side (S14.5c): the only module that imports Chart.js at runtime. `Chart.tsx` loads it
 * with a dynamic `import()`, so Chart.js and this file are one lazy chunk that no entry or page chunk carries.
 *
 * Registered: only what a chart in the app uses (tree-shaken named imports; never `chart.js/auto`). A new chart
 * type adds its controller, elements, scales and plugins here (component-hygiene.md Rule 6e). Today: the bar
 * controller and element, the category and linear scales, the tooltip plugin (it drives the wrapper's HTML tooltip
 * through `external`), and `stackLabels` below. Not registered: Legend (the legend is HTML), Title (titles are HTML),
 * Filler, the line controller and elements, time scales.
 */

/** One text above each data index's stack, at the top of its highest drawn bar (follows the bars as they animate). */
const stackLabels: Plugin<'bar', StackLabelsOptions> = {
    id: 'stackLabels',
    afterDatasetsDraw(chart, _args, options) {
        const labels = options.labels;
        const x = chart.scales.x;
        const y = chart.scales.y;
        if (!labels?.length || !x || !y) return;
        const font = options.font ?? {};
        const { ctx } = chart;
        ctx.save();
        ctx.fillStyle = options.color ?? '#fff';
        ctx.font = `${font.weight ?? 'bold'} ${font.size ?? 12}px ${font.family ?? 'sans-serif'}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        labels.forEach((text, index) => {
            let top = y.getPixelForValue(0);
            chart.data.datasets.forEach((dataset, di) => {
                if (!chart.isDatasetVisible(di) || dataset.data[index] == null) return;
                const bar = chart.getDatasetMeta(di).data[index];
                if (bar) top = Math.min(top, bar.y);
            });
            ctx.fillText(text, x.getPixelForValue(index), top - (options.offset ?? 4));
        });
        ctx.restore();
    },
};

Chart.register(BarController, BarElement, CategoryScale, LinearScale, Tooltip, stackLabels);

export type ChartInstance = Chart;

/** A chart on `canvas`; `null` when the browser gives no 2D context (Chart.js then logs and draws nothing). */
export function createChart(canvas: HTMLCanvasElement, config: ChartConfiguration): Chart | null {
    const chart = new Chart(canvas, config);
    return chart.ctx ? chart : null;
}
