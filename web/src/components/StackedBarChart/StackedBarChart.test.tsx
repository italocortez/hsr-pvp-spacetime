import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { type ChartBar, StackedBarChart } from './StackedBarChart';

/*
 * T-S14.3b-fix: the shared chart on its own (review section 6 and M1): Escape hides a tooltip opened by hover alone,
 * wherever focus is; a part of 0 draws nothing; each part takes its series' tone.
 */

const bar = (key: string, segments: ChartBar['segments']): ChartBar => ({
    key,
    name: key,
    segments,
    total: segments.reduce((s, g) => s + g.value, 0),
    totalText: 'Σ',
    description: `${key} column`,
    tip: [],
    tipTotal: 'Σ Total',
});

function draw() {
    render(
        <StackedBarChart
            label="Chart"
            axisTitle="Cost"
            series={[
                { key: 'a', label: 'A', tone: 1 },
                { key: 'b', label: 'B', tone: 3 },
            ]}
            bars={[
                bar('one', [
                    { series: 'a', value: 2 },
                    { series: 'b', value: 0 },
                ]),
                bar('two', [
                    { series: 'a', value: 1 },
                    { series: 'b', value: 1 },
                ]),
            ]}
            empty="Nothing"
        />,
    );
    return (name: string) =>
        screen.getByRole('button', { name: `${name} column` }).closest('li') as HTMLElement;
}

describe('StackedBarChart', () => {
    it('Escape hides the tooltip of the column under the pointer, without focus on it', () => {
        const column = draw();
        fireEvent.pointerEnter(column('two'));
        fireEvent.keyDown(document.body, { key: 'Escape' });
        expect(column('two')).toHaveAttribute('data-dismissed');
        expect(column('one')).not.toHaveAttribute('data-dismissed');
        // Leaving the column lets the next hover show it again.
        fireEvent.pointerLeave(column('two'));
        expect(column('two')).not.toHaveAttribute('data-dismissed');
    });

    it('Escape does nothing once the pointer has left', () => {
        const column = draw();
        fireEvent.pointerEnter(column('one'));
        fireEvent.pointerLeave(column('one'));
        fireEvent.keyDown(document.body, { key: 'Escape' });
        expect(column('one')).not.toHaveAttribute('data-dismissed');
    });

    it('a part of 0 draws nothing; each part takes its tone', () => {
        const column = draw();
        const tones = (name: string) =>
            [...column(name).querySelectorAll('[data-tone]')]
                .filter((el) => el.closest('button'))
                .map((el) => el.getAttribute('data-tone'));
        expect(tones('one')).toEqual(['1']);
        expect(tones('two')).toEqual(['1', '3']);
    });
});
