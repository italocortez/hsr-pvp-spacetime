import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AutosaveRing } from './AutosaveRing';

// T-S14.3c-fix (review S2): the ring's fill is placed on the scheduler's clock, fixed for one wait.

afterEach(() => {
    vi.useRealTimers();
});

const fill = (c: HTMLElement) => c.querySelector('[data-fill]') as HTMLElement;
const timing = (el: HTMLElement) => [
    el.style.getPropertyValue('--ring-ms'),
    el.style.getPropertyValue('--ring-delay'),
];

describe('AutosaveRing (waiting)', () => {
    it('mounted halfway through the wait: the fill runs over the whole wait, started where it stands', () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(100_000);
        const { container } = render(
            <AutosaveRing status={{ kind: 'waiting', from: 70_000, due: 130_000 }} reasonId="r" />,
        );
        expect(timing(fill(container))).toEqual(['60000ms', '-30000ms']);
    });

    it('a re-render later in the same wait writes the same values (no jump)', () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(100_000);
        const status = { kind: 'waiting', from: 100_000, due: 160_000 } as const;
        const { container, rerender } = render(<AutosaveRing status={status} reasonId="r" />);
        const before = timing(fill(container));
        vi.setSystemTime(140_000);
        rerender(<AutosaveRing status={{ ...status }} reasonId="r" />);
        expect(timing(fill(container))).toEqual(before);
        expect(before).toEqual(['60000ms', '-0ms']);
    });

    it('the ceiling: a wait shorter than 60 s fills over its own length', () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(10_000);
        const { container } = render(
            <AutosaveRing status={{ kind: 'waiting', from: 0, due: 40_000 }} reasonId="r" />,
        );
        expect(timing(fill(container))).toEqual(['40000ms', '-10000ms']);
    });
});
