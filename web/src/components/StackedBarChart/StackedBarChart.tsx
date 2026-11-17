import { type CSSProperties, useEffect, useState } from 'react';
import { type ChartScale, chartScale, share } from './chartScale';
import styles from './StackedBarChart.module.css';

/*
 * A stacked column chart in plain markup and CSS (S14.3b, A190 item 11: no chart library, no canvas). Built for the
 * team builder's Cost Breakdown and meant for the profile and stats pages too (component-hygiene.md).
 *
 * Markup: an ordered list, one item per column. Each column's plot part is a button (focusable, so keyboard and touch
 * reach the tooltip) whose accessible name is the column's full text: its name, its total and every part. The visual
 * parts (the stacked segments, the total label above, the name under the column, the tooltip, the legend and the axis
 * title) are hidden from assistive technology, so every value is read once, as text. The tooltip shows on hover, on
 * keyboard focus and on a tap (a tap focuses the button); Escape hides it until the pointer or focus leaves (also a
 * tooltip opened by hover alone: a document listener while the pointer is over a column); it holds
 * no focusable content, so it never traps focus.
 *
 * Colours: each series names a tone 1..4; the caller sets `--chart-tone-1` to `--chart-tone-4` on an ancestor (the
 * team builder maps the mockup's per-mode ramps). In forced colours the tones become system colours with a hatch for
 * tone 4, so the parts stay apart without hue.
 *
 * Motion: a column's height and its parts' shares move with the slow duration token and ease-out, and grow in from 0
 * on first render; nothing moves under reduced motion.
 */

export type ChartTone = 1 | 2 | 3 | 4;

export type ChartSeries = { key: string; label: string; tone: ChartTone };

export type ChartSegment = { series: string; value: number };

export type ChartTipRow = { series?: string; label: string; value: string };

export type ChartBar = {
    key: string;
    /** Under the column (clamped to two lines; the full name is in the tooltip and the accessible name). */
    name: string;
    /** Bottom to top; values are non-negative (a value of 0 draws nothing). */
    segments: readonly ChartSegment[];
    /** The column's height (usually the sum of the segments). */
    total: number;
    /** The label above the column ("Σ 12.5"). */
    totalText: string;
    /** The accessible name of the column: its name, total and parts as one sentence. */
    description: string;
    tip: readonly ChartTipRow[];
    /** The tooltip's last line ("Σ Total: 12.5"). */
    tipTotal: string;
    /** A column set apart from the others (a sum, not an entity): drawn after a gap. */
    apart?: boolean;
};

export type StackedBarChartProps = {
    /** The list's accessible name ("Cost per character"). */
    label: string;
    /** The value axis title, shown rotated at the left ("Cost — AS"). */
    axisTitle: string;
    series: readonly ChartSeries[];
    bars: readonly ChartBar[];
    /** Shown in place of the plot when there is no column. */
    empty: string;
    /** Grid lines (the scale picks round steps, at most this many). */
    lines?: number;
    className?: string;
};

export function StackedBarChart({
    label,
    axisTitle,
    series,
    bars,
    empty,
    lines = 4,
    className,
}: StackedBarChartProps) {
    const [dismissed, setDismissed] = useState<string | null>(null);
    /** The column under the pointer: Escape hides its tooltip too, wherever focus is (WCAG 1.4.13; review M1). */
    const [hovered, setHovered] = useState<string | null>(null);
    useEffect(() => {
        if (hovered === null) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setDismissed(hovered);
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [hovered]);
    const scale: ChartScale = chartScale(Math.max(0, ...bars.map((b) => b.total)), lines);
    const toneOf = new Map(series.map((s) => [s.key, s.tone]));
    const shown = series.filter((s) =>
        bars.some((b) => b.segments.some((g) => g.series === s.key && g.value > 0)),
    );

    return (
        <div className={`${styles.chart} ${className ?? ''}`}>
            <p className={styles.axisTitle} aria-hidden="true">
                {axisTitle}
            </p>
            {bars.length === 0 ? (
                <p className={styles.empty}>{empty}</p>
            ) : (
                <ol
                    className={styles.columns}
                    aria-label={label}
                    style={
                        {
                            '--columns': bars.length,
                            '--grid-tile': `${(100 * scale.step) / scale.max}%`,
                        } as CSSProperties
                    }
                >
                    {bars.map((bar, index) => {
                        const height = share(bar.total, scale);
                        return (
                            <li
                                key={bar.key}
                                className={styles.column}
                                data-apart={bar.apart ? '' : undefined}
                                data-dismissed={dismissed === bar.key ? '' : undefined}
                                onPointerEnter={() => setHovered(bar.key)}
                                onPointerLeave={() => {
                                    setHovered((h) => (h === bar.key ? null : h));
                                    setDismissed((d) => (d === bar.key ? null : d));
                                }}
                                style={
                                    {
                                        '--share': height,
                                        '--center': `${((index + 0.5) * 100) / bars.length}%`,
                                    } as CSSProperties
                                }
                            >
                                <button
                                    type="button"
                                    className={styles.plot}
                                    aria-label={bar.description}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Escape') setDismissed(bar.key);
                                    }}
                                    onBlur={() => setDismissed((d) => (d === bar.key ? null : d))}
                                >
                                    <span className={styles.stack} aria-hidden="true">
                                        <span className={styles.totalText}>{bar.totalText}</span>
                                        {bar.segments.map((g) =>
                                            g.value > 0 ? (
                                                <span
                                                    key={g.series}
                                                    className={styles.segment}
                                                    data-tone={toneOf.get(g.series) ?? 1}
                                                    style={{ flexGrow: g.value }}
                                                />
                                            ) : null,
                                        )}
                                    </span>
                                </button>
                                <span className={styles.name} aria-hidden="true" title={bar.name}>
                                    {bar.name}
                                </span>
                                <span className={styles.tip} aria-hidden="true">
                                    <span className={styles.tipTitle}>{bar.name}</span>
                                    {bar.tip.map((row) => (
                                        <span key={row.label} className={styles.tipRow}>
                                            <i
                                                className={styles.tipKey}
                                                data-tone={
                                                    row.series ? toneOf.get(row.series) : undefined
                                                }
                                            />
                                            <span>{row.label}</span>
                                            <b>{row.value}</b>
                                        </span>
                                    ))}
                                    <span className={styles.tipTotal}>{bar.tipTotal}</span>
                                </span>
                            </li>
                        );
                    })}
                </ol>
            )}
            {shown.length > 0 && (
                <ul className={styles.legend} aria-hidden="true">
                    {shown.map((s) => (
                        <li key={s.key}>
                            <i className={styles.swatch} data-tone={s.tone} />
                            {s.label}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}
