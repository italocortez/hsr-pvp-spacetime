import { describe, expect, it } from 'vitest';
import {
    type Box,
    POPOVER_GAP as GAP,
    POPOVER_MARGIN as M,
    placeInfoPopover,
} from './placeInfoPopover';

// T-S14.3i: the info popover's placement, a pure function against a fake viewport.

const box = (left: number, top: number, size = 20): Box => ({
    left,
    top,
    right: left + size,
    bottom: top + size,
});
const desktop = { width: 1440, height: 900 };
const phone = { width: 360, height: 740 };
const panel = { width: 340, height: 160 };
const pill = { width: 220, height: 28 };

/** True when the placed panel overlaps the trigger. */
const covers = (
    t: Box,
    at: { top: number; left: number },
    size: { width: number; height: number },
) =>
    at.left < t.right &&
    at.left + size.width > t.left &&
    at.top < t.bottom &&
    at.top + size.height > t.top;

describe('placeInfoPopover', () => {
    it('room everywhere: below, start-aligned, the gap under the trigger', () => {
        const t = box(400, 300);
        expect(placeInfoPopover(t, panel, desktop)).toEqual({
            top: 320 + GAP,
            left: 400,
            side: 'below',
            maxHeight: 900 - M - (320 + GAP),
        });
    });

    it('end alignment: the panel ends at the trigger’s right edge', () => {
        const at = placeInfoPopover(box(400, 300), pill, desktop, { align: 'end' });
        expect(at.left).toBe(420 - pill.width);
    });

    it('a preferred side above is kept when it fits', () => {
        const at = placeInfoPopover(box(400, 300), pill, desktop, { side: 'above' });
        expect(at).toMatchObject({ side: 'above', top: 300 - GAP - pill.height });
    });

    it('no room below: flips above', () => {
        const t = box(400, 820);
        const at = placeInfoPopover(t, panel, desktop);
        expect(at.side).toBe('above');
        expect(at.top).toBe(820 - GAP - panel.height);
        expect(covers(t, at, panel)).toBe(false);
    });

    it('no room above for a preferred above: flips below', () => {
        const at = placeInfoPopover(box(400, 10), pill, desktop, { side: 'above' });
        expect(at.side).toBe('below');
    });

    it('near the right edge: shifted left to stay 8px inside', () => {
        const at = placeInfoPopover(box(1420, 300), panel, desktop);
        expect(at.left).toBe(1440 - M - panel.width);
    });

    it('near the left edge with end alignment: shifted right to stay 8px inside', () => {
        const at = placeInfoPopover(box(4, 300), panel, desktop, { align: 'end' });
        expect(at.left).toBe(M);
    });

    it('a 360px phone: the 340px panel (capped by CSS to 344) stays inside on both sides', () => {
        for (const x of [0, 100, 170, 340]) {
            const at = placeInfoPopover(box(x, 200), { width: 344, height: 160 }, phone);
            expect(at.left).toBeGreaterThanOrEqual(M);
            expect(at.left + 344).toBeLessThanOrEqual(phone.width - M);
        }
    });

    it('a panel wider than the viewport less the margins starts at the margin', () => {
        const at = placeInfoPopover(box(200, 200), { width: 400, height: 100 }, phone);
        expect(at.left).toBe(M);
    });

    it('fits on neither side: the larger room, its height capped there, never over the trigger', () => {
        const short = { width: 390, height: 300 };
        const tall = { width: 300, height: 400 };
        const t = box(100, 120);
        const at = placeInfoPopover(t, tall, short);
        expect(at.side).toBe('below');
        expect(at.top).toBe(140 + GAP);
        expect(at.maxHeight).toBe(300 - M - (140 + GAP));
        const high = box(100, 200);
        const up = placeInfoPopover(high, tall, short);
        expect(up.side).toBe('above');
        expect(up.top).toBe(M);
        expect(up.top + up.maxHeight).toBe(200 - GAP);
    });
});
