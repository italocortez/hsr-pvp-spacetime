import type { ChartConfiguration, ChartType } from 'chart.js';

/*
 * The shared chart's input (S14.5c, A202, A203; component-hygiene.md Rule 6e). A page builds one `ChartModel` with a
 * pure function and passes it to `components/Chart`. Type imports only: this file never loads Chart.js.
 *
 * Colours and font families in `config` are written as CSS references, `'var(--name)'`, never as literal values:
 * the wrapper reads them from the chart's element at draw time (`chartTheme.ts`), so the tokens and the caller's
 * custom properties stay the source and a change to them reaches the canvas.
 */

/** One row of the tooltip: an optional colour key (a custom property name, `--chart-tone-1`), a label, a value. */
export type ChartTipRow = { color?: string; label: string; value: string };

/** The tooltip of one data index (one column of a bar chart, one point of a line chart). */
export type ChartTip = { title: string; rows: readonly ChartTipRow[]; footer?: string };

/** A legend entry: `color` is a custom property name (`--chart-tone-1`). */
export type ChartLegendItem = { key: string; label: string; color: string };

/**
 * The text alternative: every value of the chart as a table (visually hidden, read by screen readers and the
 * tests). `columns[0]` heads the row header column; each row's `cells[0]` is its row header.
 */
export type ChartTable = {
    columns: readonly string[];
    rows: readonly { key: string; cells: readonly string[] }[];
};

export type ChartModel<TType extends ChartType = ChartType> = {
    /** The chart's accessible name (on the canvas) and the table's caption. */
    label: string;
    /**
     * The canvas's accessible description: what the chart shows and where its values are. While `empty` is set, the
     * empty text describes the canvas instead.
     */
    description: string;
    /** The Chart.js configuration, pure: colours and fonts as `'var(--name)'`. */
    config: ChartConfiguration<TType>;
    table: ChartTable;
    /** Per data index: the wrapper draws these as its own HTML tooltip (Chart.js's tooltip is then off). */
    tips?: readonly ChartTip[];
    /** Drawn as HTML under the chart (hidden from assistive technology: the table names the series). */
    legend?: readonly ChartLegendItem[];
    /** Shown over the plot instead of data ("No characters selected"). */
    empty?: string;
};

/** Options of the wrapper's `stackLabels` plugin: one text above each data index's stack (the "Σ 12.5" totals). */
export type StackLabelsOptions = {
    labels?: readonly string[];
    color?: string;
    font?: { family?: string; size?: number; weight?: number | string };
    /** Pixels between the top of the stack and the text. */
    offset?: number;
};

declare module 'chart.js' {
    interface PluginOptionsByType<TType extends ChartType> {
        stackLabels?: StackLabelsOptions;
    }
}
