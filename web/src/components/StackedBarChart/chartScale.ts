/*
 * The value axis of a CSS bar chart (S14.3b): a top value and a grid step on round numbers, so the faint grid lines
 * sit on clean values and the tallest bar keeps a little air under the top. Steps are 1, 2, 2.5 or 5 times a power of
 * ten; the top is the first multiple of the step at or above the largest value. No value (or only 0): one step of 1
 * per line, so an all-zero chart still draws its grid.
 */
export type ChartScale = { max: number; step: number; lines: number };

export function chartScale(largest: number, lines = 4): ChartScale {
    const n = Math.max(1, Math.floor(lines));
    if (!(largest > 0) || !Number.isFinite(largest)) return { max: n, step: 1, lines: n };
    const raw = largest / n;
    const magnitude = 10 ** Math.floor(Math.log10(raw));
    const norm = raw / magnitude;
    const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
    const step = nice * magnitude;
    // A tiny tolerance: 12.5 / 2.5 must give 5 steps, not 6.
    const count = Math.max(1, Math.ceil(largest / step - 1e-9));
    return { max: count * step, step, lines: count };
}

/** A value's share of the scale, 0..1 (negative values draw nothing). */
export function share(value: number, scale: ChartScale): number {
    if (!(value > 0)) return 0;
    return Math.min(1, value / scale.max);
}
