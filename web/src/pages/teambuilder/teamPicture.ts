import { LINK_ICON_PATHS } from './TeamBuilderIcons';
import {
    BLANK_PORTRAIT,
    type Box,
    COLORS,
    type Font,
    HIDDEN_FILE_NAME,
    layoutTeamPicture,
    type Measure,
    type Paint,
    PICTURE_SCALE,
    type PictureRequest,
    type Point,
    pictureFileName,
    type Scene,
    type Shape,
} from './teamPictureLayout';

/*
 * The team picture's drawing layer (S14.3d), loaded by a dynamic import on the first Copy image or Download, so
 * the team builder's own chunk does not carry it. It waits for the app's fonts (`document.fonts`, at most
 * FONT_WAIT_MS; the metric-matched fallbacks stand in after that), loads the team's images (at most four portraits
 * and four light cones from UploadThing, with `crossOrigin = 'anonymous'` so the canvas stays exportable; usually
 * from the browser's cache or the image cache worker), lays the picture out (`teamPictureLayout.ts`) and paints it
 * with the Canvas 2D API at PICTURE_SCALE, then encodes a PNG.
 *
 * An image that fails, times out or would taint the canvas never fails the picture: a failed portrait is the
 * app's blank character (same origin), a failed light cone a dark block, an icon is left out; `missing` counts the
 * UploadThing images that did not make it, so the page can say so.
 */

export const FONT_WAIT_MS = 3000;
export const IMAGE_WAIT_MS = 10000;

const FAMILY = {
    sans: '"Inter", "Inter Fallback", Arial, sans-serif',
    mono: '"JetBrains Mono", "JetBrains Mono Fallback", "Courier New", monospace',
} as const;

/** The faces the picture uses, as `document.fonts.load` takes them. */
const FACES = [
    'italic 800 44px "Inter"',
    '700 20px "Inter"',
    '600 14px "Inter"',
    '500 14px "Inter"',
    'italic 500 15px "Inter"',
    '700 13px "JetBrains Mono"',
    '500 13px "JetBrains Mono"',
];

export type TeamPicture = {
    blob: Blob;
    fileName: string;
    /** UploadThing images that could not be drawn (a placeholder stands in). */
    missing: number;
};

const css = (f: Font) => `${f.italic ? 'italic ' : ''}${f.weight} ${f.size}px ${FAMILY[f.family]}`;

function setFont(ctx: CanvasRenderingContext2D, f: Font) {
    ctx.font = css(f);
    // Letter spacing where the canvas has it (Chromium, Firefox); measuring uses the same state.
    if ('letterSpacing' in ctx) {
        (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing =
            `${f.spacing ?? 0}px`;
    }
}

async function fontsReady(): Promise<void> {
    const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
    if (!fonts?.load) return;
    const all = Promise.all(FACES.map((f) => fonts.load(f).catch(() => []))).then(() => undefined);
    await Promise.race([all, new Promise<void>((r) => setTimeout(r, FONT_WAIT_MS))]);
}

/** One image, or null when it fails or takes longer than IMAGE_WAIT_MS. */
function loadImage(src: string, remote: boolean): Promise<HTMLImageElement | null> {
    return new Promise((resolve) => {
        const img = new Image();
        const timer = setTimeout(() => {
            done(null);
            // Stop the load that took too long (review M8).
            img.src = '';
        }, IMAGE_WAIT_MS);
        let settled = false;
        function done(value: HTMLImageElement | null) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(value);
        }
        // Before `src`, so the request is a CORS one from the start.
        if (remote) img.crossOrigin = 'anonymous';
        img.decoding = 'async';
        img.onload = () => done(img.naturalWidth > 0 ? img : null);
        img.onerror = () => done(null);
        img.src = src;
    });
}

function paintOf(ctx: CanvasRenderingContext2D, p: Paint): string | CanvasGradient {
    if (typeof p === 'string') return p;
    const g = ctx.createLinearGradient(p.x0, p.y0, p.x1, p.y1);
    for (const [at, color] of p.stops) g.addColorStop(at, color);
    return g;
}

function roundRect(ctx: CanvasRenderingContext2D, b: Box, r = 0) {
    const rr = Math.max(0, Math.min(r, b.w / 2, b.h / 2));
    ctx.beginPath();
    ctx.moveTo(b.x + rr, b.y);
    ctx.arcTo(b.x + b.w, b.y, b.x + b.w, b.y + b.h, rr);
    ctx.arcTo(b.x + b.w, b.y + b.h, b.x, b.y + b.h, rr);
    ctx.arcTo(b.x, b.y + b.h, b.x, b.y, rr);
    ctx.arcTo(b.x, b.y, b.x + b.w, b.y, rr);
    ctx.closePath();
}

function polyPath(ctx: CanvasRenderingContext2D, points: readonly Point[]) {
    ctx.beginPath();
    points.forEach(([x, y], i) => {
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    });
    ctx.closePath();
}

function clipTo(ctx: CanvasRenderingContext2D, clip: Extract<Shape, { kind: 'image' }>['clip']) {
    if (!clip) return;
    if (Array.isArray(clip)) polyPath(ctx, clip as readonly Point[]);
    else {
        const b = clip as Box & { r?: number };
        roundRect(ctx, b, b.r);
    }
    ctx.clip();
}

function drawImage(
    ctx: CanvasRenderingContext2D,
    img: HTMLImageElement,
    s: Extract<Shape, { kind: 'image' }>,
) {
    const iw = img.naturalWidth;
    const ih = img.naturalHeight;
    if (s.fit === 'fill' || iw === 0 || ih === 0) {
        ctx.drawImage(img, s.x, s.y, s.w, s.h);
        return;
    }
    if (s.fit === 'contain') {
        const k = Math.min(s.w / iw, s.h / ih);
        const w = iw * k;
        const h = ih * k;
        ctx.drawImage(img, s.x + (s.w - w) / 2, s.y + (s.h - h) / 2, w, h);
        return;
    }
    const k = Math.max(s.w / iw, s.h / ih);
    const sw = s.w / k;
    const sh = s.h / k;
    const sx = (iw - sw) / 2;
    const sy = (ih - sh) * (s.focusY ?? 0.5);
    ctx.drawImage(img, sx, sy, sw, sh, s.x, s.y, s.w, s.h);
}

/** The site mark (BrandLogo's path) in its three-colour gradient. */
const LOGO_PATH =
    'M13.5 3.375l27 0 10.125 10.125 0 27-10.125 10.125-27 0-10.125-10.125 0-27z m13.5 5.0625l15.1875 15.1875 0 18.5625-30.375 0 0-18.5625z m0 10.125l7.59375 7.59375-15.1875 0z m-7.59375 9.28125l15.1875 0-7.59375 7.59375z';

function drawLogo(ctx: CanvasRenderingContext2D, x: number, y: number, size: number) {
    if (typeof Path2D === 'undefined') return;
    ctx.save();
    ctx.translate(x, y);
    const k = size / 47.25;
    ctx.scale(k, k);
    ctx.translate(-3.375, -3.375);
    const g = ctx.createLinearGradient(3.375, 3.375, 50.625, 50.625);
    g.addColorStop(0, COLORS.iris);
    g.addColorStop(0.5, COLORS.amethyst);
    g.addColorStop(1, COLORS.periwinkle);
    ctx.fillStyle = g;
    ctx.fill(new Path2D(LOGO_PATH), 'evenodd');
    ctx.restore();
}

/** Paints `scene`; `images` maps a source to its loaded image (missing or null: the shape's fallback). */
export function paintScene(
    ctx: CanvasRenderingContext2D,
    scene: Scene,
    images: ReadonlyMap<string, HTMLImageElement | null>,
): number {
    let missing = 0;
    const blank = images.get(BLANK_PORTRAIT) ?? null;
    for (const s of scene.shapes) {
        ctx.save();
        switch (s.kind) {
            case 'rect': {
                roundRect(ctx, s, s.r);
                if (s.fill) {
                    ctx.fillStyle = paintOf(ctx, s.fill);
                    ctx.fill();
                }
                if (s.stroke) {
                    ctx.strokeStyle = s.stroke;
                    ctx.lineWidth = s.line ?? 1;
                    if (s.dash) ctx.setLineDash([...s.dash]);
                    ctx.stroke();
                }
                break;
            }
            case 'poly': {
                polyPath(ctx, s.points);
                ctx.fillStyle = paintOf(ctx, s.fill);
                ctx.fill();
                break;
            }
            case 'text': {
                setFont(ctx, s.font);
                ctx.fillStyle = s.color;
                ctx.textAlign = s.align;
                ctx.textBaseline = 'alphabetic';
                ctx.fillText(s.text, s.x, s.y);
                break;
            }
            case 'image': {
                const img = images.get(s.src) ?? null;
                if (!img && s.remote) missing += 1;
                clipTo(ctx, s.clip);
                if (img) drawImage(ctx, img, s);
                else if (s.fallback === 'portrait' && blank)
                    drawImage(ctx, blank, { ...s, src: BLANK_PORTRAIT, focusY: 0.3 });
                else if (s.fallback !== 'none') {
                    ctx.fillStyle = COLORS.charcoal;
                    ctx.fillRect(s.x, s.y, s.w, s.h);
                }
                break;
            }
            case 'logo':
                drawLogo(ctx, s.x, s.y, s.size);
                break;
            case 'link': {
                // The page's link glyph from its own path data, with the page's soft shadow (`.syn`). Every
                // supported browser has Path2D; without it (jsdom) the icon is left out and the picture still made.
                if (typeof Path2D !== 'function') break;
                ctx.translate(s.x, s.y);
                ctx.scale(s.size / 24, s.size / 24);
                ctx.fillStyle = s.color;
                ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
                // Shadow sizes ignore the transform: canvas pixels, so 1px of the page is PICTURE_SCALE here.
                ctx.shadowOffsetY = PICTURE_SCALE;
                ctx.shadowBlur = PICTURE_SCALE;
                for (const d of LINK_ICON_PATHS) ctx.fill(new Path2D(d));
                break;
            }
        }
        ctx.restore();
    }
    return missing;
}

function toBlob(canvas: HTMLCanvasElement): Promise<Blob> {
    return new Promise((resolve, reject) => {
        try {
            canvas.toBlob((blob) => {
                if (blob) resolve(blob);
                else reject(new Error('The picture could not be encoded.'));
            }, 'image/png');
        } catch (error) {
            // A tainted canvas throws a SecurityError here.
            reject(error);
        }
    });
}

/** A canvas sized to nothing gives its pixel memory back. */
function release(canvas: HTMLCanvasElement) {
    canvas.width = 0;
    canvas.height = 0;
}

/** Makes the picture of the team as a PNG. Rejects only when no canvas or no PNG can be made at all. */
export async function makeTeamPicture(req: PictureRequest): Promise<TeamPicture> {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('This browser cannot draw the picture.');
    await fontsReady();

    const measure: Measure = (text, font) => {
        setFont(ctx, font);
        return ctx.measureText(text).width;
    };
    const scene = layoutTeamPicture(req, measure);
    // The measuring canvas is done with: release its memory now (review M2).
    release(canvas);

    const sources = [
        ...scene.remote.map((src) => [src, true] as const),
        ...scene.local.map((src) => [src, false] as const),
    ];
    const loaded = await Promise.all(sources.map(([src, remote]) => loadImage(src, remote)));
    const images = new Map(sources.map(([src], i) => [src, loaded[i] ?? null]));

    // Each try on a canvas of its own: a canvas once tainted stays so.
    const render = async (from: ReadonlyMap<string, HTMLImageElement | null>) => {
        const target = document.createElement('canvas');
        target.width = scene.width * PICTURE_SCALE;
        target.height = scene.height * PICTURE_SCALE;
        try {
            const g = target.getContext('2d');
            if (!g) throw new Error('This browser cannot draw the picture.');
            g.setTransform(PICTURE_SCALE, 0, 0, PICTURE_SCALE, 0, 0);
            const missing = paintScene(g, scene, from);
            return { blob: await toBlob(target), missing };
        } finally {
            // About 13 MB at 2400 by 1350; the PNG is made, so the canvas goes at once (review M2: iOS Safari
            // keeps canvas memory until collection and has a total limit).
            release(target);
        }
    };
    let made: { blob: Blob; missing: number };
    try {
        made = await render(images);
    } catch {
        // An image tainted the canvas after all (an answer without CORS headers from some cache): the picture
        // again without any UploadThing image.
        const safe = new Map(images);
        for (const src of scene.remote) safe.set(src, null);
        made = await render(safe);
    }
    const fileName = req.hideNames ? HIDDEN_FILE_NAME : pictureFileName(req.title);
    return { blob: made.blob, fileName, missing: made.missing };
}
