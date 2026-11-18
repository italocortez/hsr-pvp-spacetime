import type { FontSpec, Scale } from 'chart.js';

/*
 * Category labels on at most N lines (S14.5c): Chart.js draws one line per array entry, but does not wrap. Words go
 * on a line while they fit the column's width; the last line ends in "…" when the rest does not fit. A single word
 * wider than the column is cut with "…" (the full name is in the tooltip and the table). Type imports only.
 */

export function wrapLines(
    text: string,
    width: number,
    measure: (t: string) => number,
    maxLines = 2,
): string[] {
    const words = text.split(/\s+/).filter(Boolean);
    const lines: string[] = [];
    let line = '';
    for (let i = 0; i < words.length; i++) {
        const word = words[i] as string;
        const next = line ? `${line} ${word}` : word;
        if (!line || measure(next) <= width) {
            line = next;
            continue;
        }
        if (lines.length === maxLines - 1) {
            // The last line takes the rest (cut below).
            line = [line, ...words.slice(i)].join(' ');
            break;
        }
        lines.push(line);
        line = word;
    }
    if (line) lines.push(line);
    return lines.map((l) => ellipsis(l, width, measure));
}

function ellipsis(line: string, width: number, measure: (t: string) => number): string {
    if (measure(line) <= width) return line;
    const chars = Array.from(line);
    while (chars.length > 1 && measure(`${chars.join('').trimEnd()}…`) > width) chars.pop();
    return `${chars.join('').trimEnd()}…`;
}

/**
 * A category scale's tick label as lines that fit its column: use it as `ticks.callback` (`function (value) {
 * return categoryTickLines(this, value); }`). Measures with the scale's own canvas and tick font.
 */
export function categoryTickLines(scale: Scale, value: number | string, maxLines = 2): string[] {
    const label = scale.getLabelForValue(Number(value));
    const count = Math.max(1, scale.getLabels().length);
    // On the first layout pass the scale has no width yet: its largest possible width stands in.
    const width = Math.max(24, (scale.width || scale.maxWidth) / count - 6);
    const options = scale.options as { ticks?: { font?: Partial<FontSpec> } };
    const font = options.ticks?.font ?? {};
    const ctx = scale.ctx;
    ctx.save();
    ctx.font = `${font.weight ?? 'normal'} ${font.size ?? 12}px ${font.family ?? 'sans-serif'}`;
    const lines = wrapLines(label, width, (t) => ctx.measureText(t).width, maxLines);
    ctx.restore();
    return lines;
}
