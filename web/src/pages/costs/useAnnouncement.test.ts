import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAnnouncement } from './useAnnouncement';

/*
 * T-COSTS-B: the status region's text. The count is announced once it holds still; the notice at
 * once; removing the notice empties the region only while the region still holds that notice.
 */

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

type Props = { text: string; notice: string };

describe('useAnnouncement', () => {
    it('removing the notice does not wipe a count announced after it', () => {
        const { result, rerender } = renderHook(
            ({ text, notice }: Props) => useAnnouncement(text, true, notice, 600),
            { initialProps: { text: '4 units listed.', notice: '' } },
        );
        expect(result.current).toBe('');
        rerender({ text: '4 units listed.', notice: 'Cost set 9 is not available.' });
        expect(result.current).toBe('Cost set 9 is not available.');
        rerender({ text: '2 units listed.', notice: 'Cost set 9 is not available.' });
        act(() => vi.advanceTimersByTime(600));
        expect(result.current).toBe('2 units listed.');
        rerender({ text: '2 units listed.', notice: '' });
        expect(result.current).toBe('2 units listed.');
    });

    it('removing the notice while the region still holds it empties the region', () => {
        const { result, rerender } = renderHook(
            ({ text, notice }: Props) => useAnnouncement(text, true, notice, 600),
            { initialProps: { text: '4 units listed.', notice: 'Cost set 9 is not available.' } },
        );
        expect(result.current).toBe('Cost set 9 is not available.');
        rerender({ text: '4 units listed.', notice: '' });
        expect(result.current).toBe('');
    });
});
