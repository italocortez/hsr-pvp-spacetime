/*
 * Where the info popover goes (S14.3i): a pure function of the trigger's box, the panel's size and the viewport, so
 * it is tested with a fake viewport. The panel is `position: fixed` in the top layer; the numbers are viewport pixels.
 *
 * - Vertical: the preferred side (below by default) when the panel fits there, else the other side when it fits
 *   there, else the side with more room, its height capped to that room (it scrolls inside). The panel never
 *   crosses the trigger: it starts `gap` px past the trigger's edge on the side chosen.
 * - Horizontal: aligned to the trigger's start (left) or end (right) edge, then shifted to stay `margin` px inside
 *   the viewport. A panel wider than the viewport less both margins starts at the margin (its CSS width cap keeps it
 *   inside).
 */

export type Side = 'below' | 'above';
export type Align = 'start' | 'end';

export type Box = { top: number; left: number; right: number; bottom: number };
export type Size = { width: number; height: number };

export type Placement = { top: number; left: number; side: Side; maxHeight: number };

export const POPOVER_GAP = 6;
export const POPOVER_MARGIN = 8;

export function placeInfoPopover(
    trigger: Box,
    panel: Size,
    viewport: Size,
    options: { side?: Side; align?: Align; gap?: number; margin?: number } = {},
): Placement {
    const gap = options.gap ?? POPOVER_GAP;
    const margin = options.margin ?? POPOVER_MARGIN;
    const prefer = options.side ?? 'below';
    const room: Record<Side, number> = {
        below: Math.max(0, viewport.height - margin - (trigger.bottom + gap)),
        above: Math.max(0, trigger.top - gap - margin),
    };
    const other: Side = prefer === 'below' ? 'above' : 'below';
    const side: Side =
        panel.height <= room[prefer]
            ? prefer
            : panel.height <= room[other]
              ? other
              : room[prefer] >= room[other]
                ? prefer
                : other;
    const height = Math.min(panel.height, room[side]);
    const top = side === 'below' ? trigger.bottom + gap : trigger.top - gap - height;

    const wanted =
        (options.align ?? 'start') === 'start' ? trigger.left : trigger.right - panel.width;
    const maxLeft = viewport.width - margin - panel.width;
    const left = maxLeft < margin ? margin : Math.min(Math.max(wanted, margin), maxLeft);

    return { top, left, side, maxHeight: room[side] };
}
