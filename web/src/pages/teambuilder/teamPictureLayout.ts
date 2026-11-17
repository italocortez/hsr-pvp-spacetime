import {
    type AuctionSpend,
    type DraftMode,
    type Slots,
    slotBid,
    type TeamCost,
} from '@shared/teambuilder';
import { amountFixed } from './costChartModel';

/*
 * The team picture (S14.3d, A190 item 8, A202 item 2): what goes where on the exported image, as a list of plain
 * shapes in logical pixels. Pure: no canvas, no DOM; text is fitted through an injected measurer, so every
 * position, size and string is testable. `teamPicture.ts` (loaded on first use) loads the fonts and images and
 * paints the shapes onto a canvas at twice the size.
 *
 * The picture: 1200 by 675 (16:9, a size Discord shows whole in a chat), the app's colours and fonts. Top: the
 * site mark and name, the modes (cost set, draft mode, game mode), the loadout's name and the team total. Middle:
 * the four slots as the page draws them (portrait, element and path, the slot's cost pill with the link icon on a
 * paired unit, eidolon and
 * superimposition, the light cone's art in its slanted corner), each with a caption (name, light cone, the
 * character and light cone costs; in Auction the character cost as its parts, so they add up to the pill:
 * "Unit 8.0 + bid 2.5 + E1 1.5 · LC 1.5"). Bottom: the active pairings with their sum, and in Auction the two
 * budgets as the page's meters. Empty slots are drawn empty. A missing cost row reads "n/a". The note is never
 * drawn (it can be long and private). Every amount is `amountFixed` (one decimal, two when the hundredths need
 * it), so the parts on the picture always add up to the figures shown.
 *
 * "Hide who is on the team" (the old tool's "Hide Team", which covered the portraits and masked the names in its
 * cost chart, so a team's price could be posted before a draft without showing the team): no portrait (the
 * app's blank character instead), no element or path, no names, no light cone name or art, pairings without
 * names, no link icon on the pills, no loadout name (the title is "Hidden team", the file `team-hidden.png`;
 * people name loadouts after the team); costs, eidolons, superimpositions, bids and budgets stay, and the header
 * says "TEAM HIDDEN".
 */

export const PICTURE_WIDTH = 1200;
export const PICTURE_HEIGHT = 675;
/** The canvas is drawn at this many pixels per logical pixel, so text stays sharp. */
export const PICTURE_SCALE = 2;
/** The app's blank character (A191), served by the app itself: the hidden and the failed portrait. */
export const BLANK_PORTRAIT = '/characters/blank.webp';
/** A hidden picture's title and file name: never the loadout's name (review S4, user ruling). */
export const HIDDEN_TITLE = 'Hidden team';
export const HIDDEN_FILE_NAME = 'team-hidden.png';

const PAD = 40;
export const CARD = { top: 156, width: 262, height: 290, gap: 24 } as const;
/** The light cone art files are 904 by 1260 (RosterSlots `CONE_ART`). */
const CONE_RATIO = 1260 / 904;

export const COLORS = {
    void: '#08090e',
    space: '#11131c',
    charcoal: '#1a1d2a',
    graphite: '#232739',
    iris: '#7e70e0',
    amethyst: '#9d7ee8',
    periwinkle: '#6b7fe8',
    prestige: '#c9a961',
    snow: '#eeeef6',
    mist: '#b9bcd0',
    ash: '#7c7f94',
    pewter: '#4d4f60',
    border: 'rgba(255, 255, 255, 0.08)',
    error: '#d85a5a',
    signature: '#6fb7e8',
    /** The chart's pairing segment (A201 item 9). */
    pairing: '#e3cf55',
} as const;

/** The link icon in a pill and its gap after the figure (the page's `.syn` and `.cost` gap). */
const PILL_ICON = 15;
const PILL_ICON_GAP = 6;

const RARITY: Record<number, { tint: string; glow: string; line: string }> = {
    5: { tint: 'rgba(201, 169, 97, 0.1)', glow: '232, 198, 122', line: 'rgb(244, 213, 135)' },
    4: { tint: 'rgba(126, 112, 224, 0.1)', glow: '163, 144, 252', line: 'rgb(184, 168, 255)' },
};
const NEUTRAL = {
    tint: 'rgba(124, 127, 148, 0.08)',
    glow: '124, 127, 148',
    line: 'rgb(124, 127, 148)',
};

// ── The request: what the page hands over ──────────────────────────────────────────────────────────────────────

export type PictureCharacter = {
    displayName: string;
    rarity: number;
    /** Lower-case tags (`fire`, `hunt`): the app's own icons under /elements and /paths. */
    element: string;
    path: string;
    imageUrl: string;
};
export type PictureLightcone = {
    displayName: string;
    rarity: number;
    imageUrl: string;
    /** The art's placement in percent (`hsr_lightcone`); width 0 or less: the page's defaults. */
    width: number;
    posX: number;
    posY: number;
};

export type PictureRequest = {
    /** The active loadout's name. */
    title: string;
    slots: Slots;
    cost: TeamCost;
    /** Auction only. */
    spend: AuctionSpend | null;
    draft: DraftMode;
    /** "Default" or the cost set's name. */
    setLabel: string;
    /** "Apocalyptic Shadow" … */
    modeLabel: string;
    hideNames: boolean;
    character: (key: string) => PictureCharacter | undefined;
    lightcone: (key: string) => PictureLightcone | undefined;
};

// ── The scene: what the painter draws ─────────────────────────────────────────────────────────────────────────

export type Font = {
    family: 'sans' | 'mono';
    size: number;
    weight: number;
    italic?: boolean;
    /** Letter spacing in px. */
    spacing?: number;
};
export type Gradient = {
    kind: 'linear';
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    stops: readonly (readonly [number, string])[];
};
export type Paint = string | Gradient;
export type Point = readonly [number, number];
export type Box = { x: number; y: number; w: number; h: number };

export type Shape =
    | {
          kind: 'rect';
          x: number;
          y: number;
          w: number;
          h: number;
          r?: number;
          fill?: Paint;
          stroke?: string;
          line?: number;
          dash?: readonly number[];
          tag?: string;
      }
    | { kind: 'poly'; points: readonly Point[]; fill: Paint; tag?: string }
    | {
          kind: 'text';
          x: number;
          y: number;
          text: string;
          font: Font;
          color: string;
          align: 'left' | 'center' | 'right';
          tag?: string;
      }
    | {
          kind: 'image';
          src: string;
          /** The destination. */
          x: number;
          y: number;
          w: number;
          h: number;
          /** `cover` crops to fill (`focusY`: 0 top … 1 bottom); `fill` draws the whole image into the box. */
          fit: 'cover' | 'fill' | 'contain';
          focusY?: number;
          /** Drawn only inside this rounded box or polygon. */
          clip?: (Box & { r?: number }) | readonly Point[];
          /** What stands in when the image does not load. */
          fallback: 'portrait' | 'block' | 'none';
          /** True for an UploadThing image (loaded with CORS, counted in the request budget). */
          remote: boolean;
          tag?: string;
      }
    | { kind: 'logo'; x: number; y: number; size: number }
    /** S14.3e: the page's link glyph (`LINK_ICON_PATHS`), filled, in a square of `size` at x, y. */
    | { kind: 'link'; x: number; y: number; size: number; color: string; tag?: string };

export type Scene = {
    width: number;
    height: number;
    shapes: Shape[];
    /** Every image the shapes use, each once: UploadThing ones and the app's own. */
    remote: string[];
    local: string[];
};

/** The width of `text` drawn in `font`, letter spacing included. */
export type Measure = (text: string, font: Font) => number;

// ── Text fitting ──────────────────────────────────────────────────────────────────────────────────────────────

const ELLIPSIS = '…';

/**
 * The text's characters as a reader sees them (grapheme clusters: a family emoji, a flag, a letter with its
 * marks), so a cut never splits one; code points where `Intl.Segmenter` is missing.
 */
export function graphemes(text: string): string[] {
    if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
        const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
        return Array.from(seg.segment(text), (s) => s.segment);
    }
    return Array.from(text);
}

/**
 * `text` in `font` within `max` px: the size shrinks a pixel at a time down to `min`; still too wide, the text is
 * cut by whole characters (grapheme clusters) and ends with an ellipsis.
 */
export function fitText(
    text: string,
    font: Font,
    max: number,
    measure: Measure,
    min = font.size,
): { text: string; font: Font } {
    let f = font;
    while (measure(text, f) > max && f.size > min) f = { ...f, size: f.size - 1 };
    if (measure(text, f) <= max) return { text, font: f };
    const chars = graphemes(text);
    let n = chars.length;
    while (n > 0 && measure(`${chars.slice(0, n).join('').trimEnd()}${ELLIPSIS}`, f) > max) n -= 1;
    return { text: `${chars.slice(0, n).join('').trimEnd()}${ELLIPSIS}`, font: f };
}

// ── File name ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The PNG's file name from the loadout's name: "team-" and the name in lower case, letters, combining marks and
 * digits of any script kept, every other run of characters one hyphen, at most 60 characters of name; nothing
 * left: "team.png". The prefix keeps a name such as "con" from being a reserved Windows name.
 */
export function pictureFileName(title: string): string {
    const slug = title
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[^\p{L}\p{M}\p{N}]+/gu, '-')
        .replace(/^-+|-+$/g, '');
    const cut = Array.from(slug).slice(0, 60).join('').replace(/-+$/, '');
    return cut === '' ? 'team.png' : `team-${cut}.png`;
}

// ── Layout ────────────────────────────────────────────────────────────────────────────────────────────────────

const sans = (size: number, weight: number, italic = false): Font => ({
    family: 'sans',
    size,
    weight,
    italic,
});
const mono = (size: number, weight: number, spacing = 0): Font => ({
    family: 'mono',
    size,
    weight,
    spacing,
});
/** An amount in hundredths as the page's Auction figures show it ("8.0", "1.25"); a missing row "n/a". */
const cost = (hundredths: number | null | undefined) =>
    hundredths === null || hundredths === undefined ? 'n/a' : amountFixed(hundredths);
/** A pairing amount with its sign: "+4.0", "−1.0". */
const signed = (hundredths: number) =>
    hundredths < 0 ? amountFixed(hundredths) : `+${amountFixed(hundredths)}`;

/** The x of slot `index`'s card. */
export const cardX = (index: number) => PAD + index * (CARD.width + CARD.gap);

/** The light cone art's box inside its corner (the page's `.lcArt` rule: width, then the translate). */
export function coneArtBox(
    corner: Box,
    cone: Pick<PictureLightcone, 'width' | 'posX' | 'posY'>,
): Box {
    const placed = cone.width > 0;
    const w = corner.w * ((placed ? cone.width : 100) / 100);
    const h = w * CONE_RATIO;
    const x = corner.x + corner.w / 2 + w * ((placed ? cone.posX : -48) / 100);
    const y = corner.y + corner.h / 2 + h * ((placed ? cone.posY : -32) / 100);
    return { x, y, w, h };
}

const polygon = (b: Box, pts: readonly Point[]): Point[] =>
    pts.map(([px, py]) => [b.x + b.w * px, b.y + b.h * py] as const);

export function layoutTeamPicture(req: PictureRequest, measure: Measure): Scene {
    const shapes: Shape[] = [];
    const remote: string[] = [];
    const local: string[] = [];
    const use = (src: string, isRemote: boolean) => {
        const list = isRemote ? remote : local;
        if (!list.includes(src)) list.push(src);
    };
    const text = (
        x: number,
        y: number,
        t: string,
        font: Font,
        color: string,
        align: 'left' | 'center' | 'right' = 'left',
        tag?: string,
    ) => shapes.push({ kind: 'text', x, y, text: t, font, color, align, tag });
    const fitted = (
        x: number,
        y: number,
        t: string,
        font: Font,
        max: number,
        min: number,
        color: string,
        align: 'left' | 'center' | 'right' = 'left',
        tag?: string,
    ) => {
        const f = fitText(t, font, max, measure, min);
        text(x, y, f.text, f.font, color, align, tag);
        return f;
    };
    const right = PICTURE_WIDTH - PAD;
    const hide = req.hideNames;
    const auction = req.draft === 'auction';

    // Background: the page's void with a faint iris glow from the top left, and a hairline frame.
    shapes.push({
        kind: 'rect',
        x: 0,
        y: 0,
        w: PICTURE_WIDTH,
        h: PICTURE_HEIGHT,
        fill: {
            kind: 'linear',
            x0: 0,
            y0: 0,
            x1: 0,
            y1: PICTURE_HEIGHT,
            stops: [
                [0, COLORS.void],
                [1, COLORS.space],
            ],
        },
        tag: 'background',
    });
    shapes.push({
        kind: 'rect',
        x: 0,
        y: 0,
        w: PICTURE_WIDTH,
        h: 220,
        fill: {
            kind: 'linear',
            x0: 0,
            y0: 0,
            x1: 0,
            y1: 220,
            stops: [
                [0, 'rgba(126, 112, 224, 0.10)'],
                [1, 'rgba(126, 112, 224, 0)'],
            ],
        },
    });
    shapes.push({
        kind: 'rect',
        x: 12,
        y: 12,
        w: PICTURE_WIDTH - 24,
        h: PICTURE_HEIGHT - 24,
        r: 16,
        stroke: COLORS.border,
        line: 1,
    });

    // Header, first line: the mark and the site's name; the modes on the right.
    shapes.push({ kind: 'logo', x: PAD, y: 34, size: 24 });
    text(PAD + 34, 52, 'IPC BATTLEGROUNDS', mono(13, 700, 2.6), COLORS.mist, 'left', 'brand');
    const brandEnd = PAD + 34 + measure('IPC BATTLEGROUNDS', mono(13, 700, 2.6));
    const modes =
        `${req.setLabel} · ${auction ? 'Auction' : 'Classic'} Draft · ${req.modeLabel}`.toUpperCase();
    let modesRight = right;
    if (hide) {
        const label = 'TEAM HIDDEN';
        const f = mono(11, 700, 1.6);
        const w = measure(label, f) + 20;
        shapes.push({
            kind: 'rect',
            x: right - w,
            y: 35,
            w,
            h: 24,
            r: 12,
            fill: 'rgba(126, 112, 224, 0.16)',
            stroke: 'rgba(126, 112, 224, 0.55)',
            line: 1,
            tag: 'hidden-badge',
        });
        text(right - w / 2, 51, label, f, COLORS.snow, 'center', 'hidden-badge');
        modesRight = right - w - 14;
    }
    fitted(
        modesRight,
        52,
        modes,
        mono(13, 500, 1.3),
        Math.max(120, modesRight - brandEnd - 40),
        10,
        COLORS.ash,
        'right',
        'modes',
    );

    // Header, second line: the loadout's name (left) and the team total (right).
    const totalText = amountFixed(req.cost.total);
    const totalFont = sans(46, 800, true);
    const totalW = measure(totalText, totalFont);
    const sigmaFont = sans(30, 700);
    const sigmaW = measure('Σ', sigmaFont);
    text(right, 84, 'TOTAL COST', mono(12, 600, 2.4), COLORS.ash, 'right', 'total-label');
    text(right, 124, totalText, totalFont, COLORS.snow, 'right', 'total');
    text(right - totalW - 10, 122, 'Σ', sigmaFont, COLORS.iris, 'right', 'sigma');
    const titleMax = right - (totalW + sigmaW + 10) - 40 - PAD;
    const title = hide ? HIDDEN_TITLE : req.title.trim() === '' ? 'Untitled' : req.title.trim();
    fitted(PAD, 120, title, sans(44, 800, true), titleMax, 26, COLORS.snow, 'left', 'title');
    shapes.push({
        kind: 'rect',
        x: PAD,
        y: 134,
        w: 56,
        h: 3,
        r: 1.5,
        fill: COLORS.iris,
        tag: 'accent',
    });

    // The four slots.
    const pairedKeys = new Set(req.cost.pairs.flatMap((p) => [p.characterA, p.characterB]));
    req.slots.forEach((slot, index) => {
        const x = cardX(index);
        const y = CARD.top;
        const { width: w, height: h } = CARD;
        const card: Box = { x, y, w, h };
        if (!slot) {
            shapes.push({
                kind: 'rect',
                ...card,
                r: 10,
                fill: 'rgba(17, 19, 28, 0.6)',
                stroke: 'rgba(124, 127, 148, 0.35)',
                line: 1.5,
                dash: [6, 5],
                tag: `slot-${index}-empty`,
            });
            text(
                x + w / 2,
                y + h / 2 + 5,
                'EMPTY',
                mono(14, 600, 2.8),
                COLORS.ash,
                'center',
                `slot-${index}-empty-label`,
            );
            text(
                x + w / 2,
                y + h + 30,
                `Slot ${index + 1}`,
                sans(16, 600),
                COLORS.pewter,
                'center',
                `slot-${index}-name`,
            );
            return;
        }
        const c = req.character(slot.character);
        const coneKey = slot.lightcone;
        const cone = coneKey ? req.lightcone(coneKey) : undefined;
        const slotCost = req.cost.slots[index] ?? null;
        const rarity = !hide && c ? (RARITY[c.rarity] ?? NEUTRAL) : NEUTRAL;
        const clip = { ...card, r: 10 };

        // Base and rarity tint (the page's `.slot[data-rarity]`).
        shapes.push({ kind: 'rect', ...card, r: 10, fill: COLORS.graphite, tag: `slot-${index}` });
        shapes.push({
            kind: 'rect',
            ...card,
            r: 10,
            fill: {
                kind: 'linear',
                x0: 0,
                y0: y,
                x1: 0,
                y1: y + h * 0.38,
                stops: [
                    [0, rarity.tint],
                    [1, 'rgba(0, 0, 0, 0)'],
                ],
            },
        });
        // Portrait (hidden: the blank character; unknown or failed: the blank character too).
        const portrait = !hide && c ? c.imageUrl : BLANK_PORTRAIT;
        const portraitRemote = portrait !== BLANK_PORTRAIT;
        use(portrait, portraitRemote);
        if (portraitRemote) use(BLANK_PORTRAIT, false);
        shapes.push({
            kind: 'image',
            src: portrait,
            ...card,
            fit: 'cover',
            focusY: portraitRemote ? 0.18 : 0.3,
            clip,
            fallback: 'portrait',
            remote: portraitRemote,
            tag: `slot-${index}-portrait`,
        });
        // The bottom scrim and the rarity glow and bar (the page's ::before and ::after).
        shapes.push({
            kind: 'rect',
            ...card,
            r: 10,
            fill: {
                kind: 'linear',
                x0: 0,
                y0: y,
                x1: 0,
                y1: y + h,
                stops: [
                    [0, 'rgba(8, 9, 14, 0)'],
                    [0.32, 'rgba(8, 9, 14, 0)'],
                    [0.56, 'rgba(8, 9, 14, 0.4)'],
                    [1, 'rgba(8, 9, 14, 0.92)'],
                ],
            },
        });
        shapes.push({
            kind: 'rect',
            x,
            y: y + h / 2,
            w,
            h: h / 2,
            fill: {
                kind: 'linear',
                x0: 0,
                y0: y + h / 2,
                x1: 0,
                y1: y + h,
                stops: [
                    [0, `rgba(${rarity.glow}, 0)`],
                    [0.26, `rgba(${rarity.glow}, 0)`],
                    [0.7, `rgba(${rarity.glow}, 0.22)`],
                    [1, `rgba(${rarity.glow}, 0.5)`],
                ],
            },
        });

        // The light cone's corner: the divider, then the art clipped to the slanted shape.
        const corner: Box = { x, y: y + h - 8 - h * 0.56, w, h: h * 0.56 };
        shapes.push({
            kind: 'poly',
            points: polygon(corner, [
                [1, 0],
                [1, 1],
                [0.435, 1],
                [0.435, 0.485],
                [0.985, 0],
            ]),
            fill: cone && !hide ? 'rgba(20, 21, 30, 0.92)' : 'rgba(20, 21, 30, 0.5)',
            tag: `slot-${index}-cone-divider`,
        });
        if (cone && !hide) {
            const art = coneArtBox(corner, cone);
            use(cone.imageUrl, true);
            shapes.push({
                kind: 'image',
                src: cone.imageUrl,
                ...art,
                fit: 'fill',
                clip: polygon(corner, [
                    [1, 0],
                    [1, 1],
                    [0.45, 1],
                    [0.45, 0.5],
                ]),
                fallback: 'block',
                remote: true,
                tag: `slot-${index}-cone`,
            });
        }
        shapes.push({
            kind: 'rect',
            x,
            y: y + h - 3,
            w,
            h: 3,
            fill: rarity.line,
            tag: `slot-${index}-bar`,
        });
        shapes.push({ kind: 'rect', ...card, r: 10, stroke: COLORS.border, line: 1 });

        // Element (top left) and path (top right): the app's own icons.
        if (!hide && c) {
            const el = `/elements/${c.element}.webp`;
            const pa = `/paths/${c.path}.webp`;
            use(el, false);
            use(pa, false);
            for (const [src, at, what] of [
                [el, x + 10, 'element'],
                [pa, x + w - 40, 'path'],
            ] as const) {
                shapes.push({
                    kind: 'image',
                    src,
                    x: at,
                    y: y + 10,
                    w: 30,
                    h: 30,
                    fit: 'contain',
                    fallback: 'none',
                    remote: false,
                    tag: `slot-${index}-${what}`,
                });
            }
        }

        // The cost pill (top centre): the slot's character plus light cone; "n/a" when a part has no row.
        const missingPart =
            slotCost !== null && (slotCost.character === null || slotCost.lightcone === null);
        const pillText = slotCost === null || missingPart ? 'n/a' : cost(slotCost.total);
        const pillFont = mono(15, 700);
        // A paired unit: the page's link icon after the cost, as on the page (15px at a 15px figure, 6px apart,
        // amethyst; S14.3e, replaces the S14.3d gold edge). Hidden: no mark, which would tell which slots pair
        // (review S3).
        const paired = !hide && pairedKeys.has(slot.character);
        const textW = measure(pillText, pillFont);
        const groupW = textW + (paired ? PILL_ICON_GAP + PILL_ICON : 0);
        const pillW = Math.max(54, groupW + 24);
        shapes.push({
            kind: 'rect',
            x: x + (w - pillW) / 2,
            y: y + 12,
            w: pillW,
            h: 28,
            r: 14,
            fill: 'rgba(8, 9, 14, 0.78)',
            stroke: 'rgba(255, 255, 255, 0.14)',
            line: 1,
            tag: `slot-${index}-pill`,
        });
        if (paired) {
            // The figure and the icon as one group, centred on the card.
            const gx = x + (w - groupW) / 2;
            text(gx, y + 31, pillText, pillFont, COLORS.snow, 'left', `slot-${index}-pill`);
            shapes.push({
                kind: 'link',
                x: gx + textW + PILL_ICON_GAP,
                y: y + 12 + (28 - PILL_ICON) / 2,
                size: PILL_ICON,
                color: COLORS.amethyst,
                tag: `slot-${index}-paired`,
            });
        } else {
            const at = x + w / 2;
            text(at, y + 31, pillText, pillFont, COLORS.snow, 'center', `slot-${index}-pill`);
        }

        // Eidolon and superimposition (bottom left, the page's `.verticals` pill).
        const eText = `E${slot.eidolon}`;
        const sText = cone || coneKey ? `S${slot.superimposition}` : '';
        const vf = mono(14, 700);
        const eW = measure(eText, vf);
        const sW = sText ? measure(sText, vf) : 0;
        const vW = 20 + eW + (sText ? 10 + sW : 0);
        shapes.push({
            kind: 'rect',
            x: x + 10,
            y: y + h - 44,
            w: vW,
            h: 28,
            r: 6,
            fill: 'rgba(8, 9, 14, 0.8)',
            stroke: 'rgba(255, 255, 255, 0.12)',
            line: 1,
            tag: `slot-${index}-levels`,
        });
        text(x + 20, y + h - 25, eText, vf, COLORS.snow, 'left', `slot-${index}-eidolon`);
        if (sText) {
            const sx = x + 20 + eW + 10;
            text(
                sx,
                y + h - 25,
                sText,
                vf,
                COLORS.signature,
                'left',
                `slot-${index}-superimposition`,
            );
        }

        // The caption under the card.
        const name = hide ? `Character ${index + 1}` : (c?.displayName ?? slot.character);
        const nameColor = hide ? COLORS.mist : COLORS.snow;
        const capX = x + 2;
        fitted(
            capX,
            y + h + 30,
            name,
            sans(20, 700),
            w - 4,
            14,
            nameColor,
            'left',
            `slot-${index}-name`,
        );
        const coneLine = !coneKey
            ? 'No light cone'
            : hide
              ? `Light cone · S${slot.superimposition}`
              : `${cone?.displayName ?? coneKey} · S${slot.superimposition}`;
        const coneColor = coneKey ? COLORS.mist : COLORS.pewter;
        const coneTag = `slot-${index}-cone-name`;
        fitted(capX, y + h + 54, coneLine, sans(14, 500), w - 4, 11, coneColor, 'left', coneTag);
        const coneCost = coneKey ? cost(slotCost?.lightcone) : '–';
        const costsTag = `slot-${index}-costs`;
        const character = slotCost?.character ?? null;
        if (!auction || character === null) {
            const costLine = `Unit ${cost(character)} · LC ${coneCost}`;
            text(capX, y + h + 77, costLine, mono(13, 500), COLORS.ash, 'left', costsTag);
        } else {
            // Auction (review S1): the character cost as its parts, which add up to it, so the pill reads as
            // base + bid + eidolon extra + light cone. The bid is what the module adds to the base at the sale
            // (`slotBid`), the eidolon extra what it charges on top (`SlotCost.extra`).
            const bid = slotBid(slot);
            const extra = slotCost?.extra ?? 0;
            const parts: { text: string; color: string; tag: string }[] = [
                { text: `Unit ${cost(character - bid - extra)}`, color: COLORS.ash, tag: costsTag },
            ];
            if (bid > 0)
                parts.push(
                    { text: ' + ', color: COLORS.ash, tag: costsTag },
                    { text: `bid ${cost(bid)}`, color: COLORS.prestige, tag: `slot-${index}-bid` },
                );
            if (extra > 0)
                parts.push({
                    text: ` + E${slot.eidolon} ${cost(extra)}`,
                    color: COLORS.ash,
                    tag: costsTag,
                });
            const lc = { text: ` · LC ${coneCost}`, color: COLORS.ash, tag: costsTag };
            const font = mono(13, 500);
            const width = (list: typeof parts, f: Font) =>
                list.reduce((n, p) => n + measure(p.text, f), 0);
            // One line when it fits at 12 px or more; otherwise the light cone goes to a second line.
            const oneLine = [...parts, lc];
            let f = font;
            while (width(oneLine, f) > w - 4 && f.size > 12) f = { ...f, size: f.size - 1 };
            const lines =
                width(oneLine, f) <= w - 4
                    ? [oneLine]
                    : [parts, [{ ...lc, text: `LC ${coneCost}` }]];
            if (lines.length > 1) {
                f = font;
                while (width(parts, f) > w - 4 && f.size > 10) f = { ...f, size: f.size - 1 };
            }
            lines.forEach((line, n) => {
                let px = capX;
                for (const p of line) {
                    text(px, y + h + 77 + n * 21, p.text, f, p.color, 'left', p.tag);
                    px += measure(p.text, f);
                }
            });
        }
    });

    // Bottom band: the pairings (left), in Auction the budgets (right).
    const bandY = auction ? 574 : 566;
    const pairsRight = auction ? PAD + 520 : right;
    const pairsLabelFont = mono(11, 700, 2.2);
    text(PAD, bandY + 14, 'ACTIVE PAIRINGS', pairsLabelFont, COLORS.ash, 'left', 'pairs-label');
    if (req.cost.pairs.length > 0) {
        // What the pairings add to the total (clamped at 0 like the total), so it can be rebuilt even when
        // chips are cut to "+N more" (review M5).
        const sumX = PAD + measure('ACTIVE PAIRINGS', pairsLabelFont) + 10;
        const sum = signed(req.cost.surcharge);
        text(sumX, bandY + 14, sum, mono(12, 700), COLORS.pairing, 'left', 'pairs-sum');
    }
    const nameOf = (key: string) => req.character(key)?.displayName ?? key;
    const chips = req.cost.pairs.map((p, i) => ({
        label: hide ? `Pairing ${i + 1}` : `${nameOf(p.characterA)} × ${nameOf(p.characterB)}`,
        mod: signed(p.modifier),
    }));
    if (chips.length === 0) {
        text(PAD, bandY + 46, 'none', sans(15, 500, true), COLORS.pewter, 'left', 'pairs-none');
    } else {
        const labelFont = sans(14, 600);
        const modFont = mono(14, 700);
        let cx = PAD;
        let cy = bandY + 26;
        let row = 0;
        // Classic has room for two rows of chips; Auction one, beside the budgets.
        const rows = auction ? 1 : 2;
        for (let i = 0; i < chips.length; i += 1) {
            const chip = chips[i] as { label: string; mod: string };
            const modW = measure(chip.mod, modFont);
            const left = chips.length - i;
            const more = `+${left} more`;
            const room = pairsRight - cx;
            const labelMax = Math.min(300, room - modW - 40);
            const fit = fitText(chip.label, labelFont, labelMax, measure, 12);
            const chipW = measure(fit.text, fit.font) + modW + 34;
            if (chipW > room || (fit.text.endsWith(ELLIPSIS) && room < 160)) {
                if (row + 1 < rows) {
                    row += 1;
                    cx = PAD;
                    cy += 38;
                    i -= 1;
                    continue;
                }
                text(cx + 4, cy + 20, more, mono(13, 600), COLORS.ash, 'left', 'pairs-more');
                break;
            }
            shapes.push({
                kind: 'rect',
                x: cx,
                y: cy,
                w: chipW,
                h: 30,
                r: 15,
                fill: 'rgba(227, 207, 85, 0.1)',
                stroke: 'rgba(227, 207, 85, 0.4)',
                line: 1,
                tag: `pair-${i}`,
            });
            text(cx + 14, cy + 20, fit.text, fit.font, COLORS.snow, 'left', `pair-${i}-label`);
            const modX = cx + chipW - 14;
            text(modX, cy + 20, chip.mod, modFont, COLORS.pairing, 'right', `pair-${i}-modifier`);
            cx += chipW + 10;
        }
    }

    if (auction && req.spend) {
        const s = req.spend;
        const meterW = 250;
        const charOver = s.over.character;
        const lcOver = s.over.lightcone || s.over.pairings;
        const meter = (
            mx: number,
            label: string,
            left: number,
            over: boolean,
            fill: number,
            foot: string,
            extra: string | null,
            tag: string,
        ) => {
            const leftText = `${amountFixed(left)} left`;
            const leftColor = over ? COLORS.error : COLORS.snow;
            const bar = { kind: 'rect', x: mx, y: bandY + 26, h: 8, r: 4 } as const;
            text(mx, bandY + 14, label, mono(11, 700, 2.2), COLORS.ash, 'left', `${tag}-label`);
            const valueFont = mono(13, 700);
            text(mx + meterW, bandY + 14, leftText, valueFont, leftColor, 'right', `${tag}-left`);
            const track = 'rgba(255, 255, 255, 0.06)';
            shapes.push({ ...bar, w: meterW, fill: track, tag: `${tag}-track` });
            const fw = Math.max(0, Math.min(1, fill)) * meterW;
            const fillColor = over ? COLORS.error : COLORS.prestige;
            if (fw > 0) shapes.push({ ...bar, w: fw, fill: fillColor, tag: `${tag}-fill` });
            const footFont = mono(12, over ? 700 : 500);
            const footColor = over ? COLORS.error : COLORS.mist;
            text(mx, bandY + 56, foot, footFont, footColor, 'left', `${tag}-foot`);
            if (extra)
                text(mx, bandY + 76, extra, mono(12, 500), COLORS.ash, 'left', `${tag}-extra`);
        };
        const mx = right - meterW * 2 - 20;
        meter(
            mx,
            'CHARACTER BUDGET',
            s.characterLeft,
            charOver,
            s.budgets.character > 0 ? Math.max(0, s.characterLeft) / s.budgets.character : 0,
            charOver
                ? `Over by ${amountFixed(s.winning - s.budgets.character)}`
                : `${amountFixed(s.characterSpent)} of ${amountFixed(s.budgets.character)}`,
            null,
            'budget-character',
        );
        meter(
            mx + meterW + 20,
            'LIGHT CONE BUDGET',
            s.left,
            lcOver,
            s.lightconeAvailable > 0 ? Math.max(0, s.left) / s.lightconeAvailable : 0,
            lcOver
                ? `Over by ${amountFixed(-s.left)}`
                : `${amountFixed(s.lightconeSpent + s.pairings)} of ${amountFixed(s.lightconeAvailable)}`,
            s.rollover > 0
                ? `${amountFixed(s.budgets.lightcone)} + ${amountFixed(s.rollover)} rolled over`
                : null,
            'budget-lightcone',
        );
    }

    return { width: PICTURE_WIDTH, height: PICTURE_HEIGHT, shapes, remote, local };
}
