import type { ChartConfiguration, ChartType, TooltipModel } from 'chart.js';
import { type CSSProperties, useEffect, useId, useRef, useState } from 'react';
import hidden from '@/styles/visuallyHidden.module.css';
import styles from './Chart.module.css';
import type { ChartInstance } from './chartRuntime';
import { cssReader, resolveConfig } from './chartTheme';
import type { ChartModel } from './types';

/*
 * The one chart system (S14.5c, A202, A203; component-hygiene.md Rule 6e): a thin React wrapper around Chart.js.
 *
 * - Input: a `ChartModel` from a page's pure model function (the Chart.js config with colours and fonts as
 *   `'var(--name)'`, the data table, the tooltips, the legend).
 * - Loading: this file holds no Chart.js code. The canvas's box keeps its height from the first paint (`--chart-h`,
 *   no layout jump); after mount an effect imports `chartRuntime.ts` (Chart.js and the registrations, one lazy
 *   chunk) and draws. Without `ResizeObserver` (jsdom) nothing is imported: the table stays the chart's content.
 * - Lifecycle: one Chart.js instance per mount, destroyed on unmount (strict mode's mount, unmount, mount makes one
 *   live chart: the first load is cancelled before it draws). A new model updates the same instance (`update()`),
 *   it never recreates it. Responsive to its box (Chart.js's own resize observer).
 * - Theme: colours and fonts are read from CSS at each draw (`chartTheme.ts`) and again when the colour scheme,
 *   contrast or forced colours change, when the root element's class, style or data-theme changes, and once the
 *   web fonts are ready.
 * - Motion: no animation under `prefers-reduced-motion: reduce`, followed live.
 * - Text alternative: the canvas is `role="img"` with the model's name and description; a visually hidden table
 *   holds every value. The tooltip and the legend are visual only (`aria-hidden`), as the table says it all.
 * - Tooltip: HTML, drawn by the wrapper from `model.tips` (hover, tap); Escape hides it until the pointer leaves the
 *   canvas, a tap outside hides it.
 */

type TipState = { index: number; x: number; top: number };

const REDUCE = '(prefers-reduced-motion: reduce)';
const THEME_QUERIES = [
    '(prefers-color-scheme: dark)',
    '(prefers-contrast: more)',
    '(forced-colors: active)',
    REDUCE,
];

const loadRuntime = () => import('./chartRuntime');

const reducedMotion = () => globalThis.matchMedia?.(REDUCE).matches === true;

export function Chart({ model, className }: { model: ChartModel; className?: string }) {
    const rootRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const probeRef = useRef<HTMLSpanElement>(null);
    const chartRef = useRef<ChartInstance | null>(null);
    const modelRef = useRef(model);
    modelRef.current = model;
    /** The index whose tooltip Escape hid: it stays hidden until the pointer leaves the canvas. */
    const dismissedRef = useRef<number | null>(null);
    const [tip, setTip] = useState<TipState | null>(null);
    const descId = useId();

    /** The model's config with the theme read now, the wrapper's own options laid over it. */
    const build = useRef((_m?: ChartModel): ChartConfiguration | null => null);
    build.current = (m = modelRef.current) => {
        const root = rootRef.current;
        const probe = probeRef.current;
        if (!root || !probe) return null;
        const config = resolveConfig(m.config as ChartConfiguration, cssReader(root, probe));
        const options = config.options ?? {};
        const external = m.tips
            ? {
                  enabled: false,
                  external: ({ tooltip }: { tooltip: TooltipModel<ChartType> }) =>
                      onTooltip(tooltip),
              }
            : {};
        config.options = {
            ...options,
            responsive: true,
            maintainAspectRatio: false,
            animation: reducedMotion() ? false : options.animation,
            plugins: { ...options.plugins, tooltip: { ...options.plugins?.tooltip, ...external } },
        };
        return config;
    };

    function onTooltip(tooltip: TooltipModel<ChartType>) {
        const points = tooltip.dataPoints ?? [];
        const first = points[0];
        if (tooltip.opacity === 0 || !first) {
            dismissedRef.current = null;
            setTip(null);
            return;
        }
        if (dismissedRef.current === first.dataIndex) return;
        const chart = tooltip.chart;
        const drawn = points.filter((p) => p.raw != null).map((p) => p.element.y);
        const base = chart.scales.y?.getPixelForValue(0) ?? tooltip.caretY;
        const top = drawn.length ? Math.min(...drawn) : base;
        const x = chart.scales.x?.getPixelForValue(first.dataIndex) ?? tooltip.caretX;
        setTip((t) =>
            t && t.index === first.dataIndex && t.x === x && t.top === top
                ? t
                : { index: first.dataIndex, x, top },
        );
    }

    // Create once per mount; destroy on unmount.
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || typeof ResizeObserver === 'undefined') return;
        let cancelled = false;
        let chart: ChartInstance | null = null;
        const refresh = () => {
            const config = build.current();
            if (!chart || !config) return;
            chart.data = config.data;
            chart.options = config.options ?? {};
            chart.update('none');
        };
        const queries = THEME_QUERIES.flatMap((q) => globalThis.matchMedia?.(q) ?? []);
        const observer = new MutationObserver(refresh);
        loadRuntime().then(({ createChart }) => {
            if (cancelled) return;
            const config = build.current();
            if (!config) return;
            chart = createChart(canvas, config);
            chartRef.current = chart;
            if (!chart) return;
            for (const q of queries) q.addEventListener('change', refresh);
            observer.observe(document.documentElement, {
                attributes: true,
                attributeFilter: ['class', 'style', 'data-theme'],
            });
            document.fonts?.ready.then(() => {
                if (!cancelled) refresh();
            });
        });
        return () => {
            cancelled = true;
            for (const q of queries) q.removeEventListener('change', refresh);
            observer.disconnect();
            chart?.destroy();
            chartRef.current = null;
        };
    }, []);

    // A new model updates the live chart (animated unless reduced motion).
    useEffect(() => {
        const chart = chartRef.current;
        const config = build.current(model);
        if (!chart || !config) return;
        chart.data = config.data;
        chart.options = config.options ?? {};
        chart.update();
    }, [model]);

    // Escape hides the open tooltip; a tap or click outside the canvas hides it.
    useEffect(() => {
        if (!tip) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== 'Escape') return;
            dismissedRef.current = tip.index;
            setTip(null);
        };
        const onDown = (e: PointerEvent) => {
            if (e.target !== canvasRef.current) setTip(null);
        };
        document.addEventListener('keydown', onKey);
        document.addEventListener('pointerdown', onDown);
        return () => {
            document.removeEventListener('keydown', onKey);
            document.removeEventListener('pointerdown', onDown);
        };
    }, [tip]);

    const shownTip = tip ? model.tips?.[tip.index] : undefined;
    const { table } = model;

    return (
        <div ref={rootRef} className={`${styles.chart} ${className ?? ''}`}>
            <div className={styles.frame}>
                <canvas
                    ref={canvasRef}
                    className={styles.canvas}
                    role="img"
                    aria-label={model.label}
                    aria-describedby={descId}
                />
                {model.empty && (
                    <p id={descId} className={styles.empty}>
                        {model.empty}
                    </p>
                )}
                {tip && shownTip && (
                    <div
                        className={styles.tip}
                        aria-hidden="true"
                        style={{ '--x': `${tip.x}px`, '--top': `${tip.top}px` } as CSSProperties}
                    >
                        <span className={styles.tipTitle}>{shownTip.title}</span>
                        {shownTip.rows.map((row) => (
                            <span key={row.label} className={styles.tipRow}>
                                <i
                                    className={styles.tipKey}
                                    style={
                                        row.color ? { background: `var(${row.color})` } : undefined
                                    }
                                />
                                <span>{row.label}</span>
                                <b>{row.value}</b>
                            </span>
                        ))}
                        {shownTip.footer && (
                            <span className={styles.tipFooter}>{shownTip.footer}</span>
                        )}
                    </div>
                )}
            </div>
            {model.legend && model.legend.length > 0 && (
                <ul className={styles.legend} aria-hidden="true">
                    {model.legend.map((item) => (
                        <li key={item.key}>
                            <i
                                className={styles.swatch}
                                style={{ background: `var(${item.color})` }}
                            />
                            {item.label}
                        </li>
                    ))}
                </ul>
            )}
            {!model.empty && (
                <p id={descId} className={hidden.visuallyHidden}>
                    {model.description}
                </p>
            )}
            {table.rows.length > 0 && (
                <table className={hidden.visuallyHidden}>
                    <caption>{model.label}</caption>
                    <thead>
                        <tr>
                            {table.columns.map((c) => (
                                <th key={c} scope="col">
                                    {c}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {table.rows.map((row) => (
                            <tr key={row.key}>
                                {table.columns.map((column, i) =>
                                    i === 0 ? (
                                        <th key={column} scope="row">
                                            {row.cells[i]}
                                        </th>
                                    ) : (
                                        <td key={column}>{row.cells[i]}</td>
                                    ),
                                )}
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
            <span ref={probeRef} className={styles.probe} aria-hidden="true" />
        </div>
    );
}
