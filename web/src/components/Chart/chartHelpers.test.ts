// T-S14.5c: the shared chart's pure helpers: theme references resolved in a copy of the configuration, and category
// labels wrapped to at most two lines.
import { describe, expect, it } from 'vitest';
import { resolveConfig, type ThemeKind } from './chartTheme';
import { wrapLines } from './wrapLabel';

describe('resolveConfig', () => {
    const calls: [string, ThemeKind][] = [];
    const read = (name: string, kind: ThemeKind) => {
        calls.push([name, kind]);
        return kind === 'font' ? `font(${name})` : `colour(${name})`;
    };

    it('replaces var() references deep in a copy; fonts by their family key; keeps functions and numbers', () => {
        const fn = () => 1;
        const config = {
            data: {
                labels: ['A', 'var(--not-a-colour) text'],
                datasets: [{ data: [1, null], backgroundColor: 'var(--tone)', borderWidth: fn }],
            },
            options: {
                scales: {
                    x: {
                        ticks: {
                            color: 'var(--ink)',
                            font: { family: 'var(--font-primary)', size: 11 },
                        },
                    },
                },
            },
        };
        const out = resolveConfig(config, read);
        expect(out.data.datasets[0]?.backgroundColor).toBe('colour(--tone)');
        expect(out.data.datasets[0]?.borderWidth).toBe(fn);
        expect(out.data.datasets[0]?.data).toEqual([1, null]);
        expect(out.data.labels).toEqual(['A', 'var(--not-a-colour) text']);
        expect(out.options.scales.x.ticks).toEqual({
            color: 'colour(--ink)',
            font: { family: 'font(--font-primary)', size: 11 },
        });
        // The input is untouched.
        expect(config.data.datasets[0]?.backgroundColor).toBe('var(--tone)');
        expect(out.data).not.toBe(config.data);
        expect(calls).toContainEqual(['--font-primary', 'font']);
    });
});

describe('wrapLines', () => {
    // 10px per character.
    const measure = (t: string) => Array.from(t).length * 10;

    it('one line when it fits; two lines on word breaks', () => {
        expect(wrapLines('Anaxa', 80, measure)).toEqual(['Anaxa']);
        expect(wrapLines('March 7th The Hunt', 90, measure)).toEqual(['March 7th', 'The Hunt']);
    });

    it('the rest goes on the last line, cut with an ellipsis', () => {
        expect(wrapLines('Trailblazer Remembrance Long Name', 120, measure)).toEqual([
            'Trailblazer',
            'Remembrance…',
        ]);
        expect(wrapLines('Dan Heng Imbibitor Lunae', 100, measure, 1)).toEqual(['Dan Heng…']);
    });

    it('a single word wider than the column is cut', () => {
        expect(wrapLines('Supercalifragilistic', 60, measure)).toEqual(['Super…']);
    });
});
