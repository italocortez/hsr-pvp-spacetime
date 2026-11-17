import {
    auctionSpend,
    DEFAULT_BUDGETS,
    type DraftMode,
    type Slot,
    type Slots,
    type TeamCostSource,
    teamCost,
} from '@shared/teambuilder';
import { describe, expect, it } from 'vitest';
import {
    BLANK_PORTRAIT,
    CARD,
    cardX,
    coneArtBox,
    type Font,
    fitText,
    graphemes,
    HIDDEN_TITLE,
    layoutTeamPicture,
    type Measure,
    PICTURE_HEIGHT,
    PICTURE_WIDTH,
    type PictureCharacter,
    type PictureLightcone,
    type PictureRequest,
    pictureFileName,
    type Scene,
    type Shape,
} from './teamPictureLayout';

/*
 * T-S14.3d: the team picture's pure layout. A fake measurer (every character 0.6 of the font size, plus the
 * letter spacing) stands in for the canvas, so positions, sizes and fitted strings are exact. Costs come from the
 * shared model (`teamCost`, `auctionSpend`) over a small source.
 */

function must<T>(value: T | undefined): T {
    if (value === undefined) throw new Error('missing');
    return value;
}

const measure: Measure = (text, font) =>
    Array.from(text).length * (font.size * 0.6 + (font.spacing ?? 0));

const CHARACTERS: Record<string, PictureCharacter> = {
    acheron: c('Acheron', 5, 'lightning', 'nihility'),
    pela: c('Pela', 4, 'ice', 'nihility'),
    clara: c('Clara', 5, 'physical', 'destruction'),
    huohuo: c('Huohuo', 5, 'wind', 'abundance'),
    longone: c('Dan Heng • Permansor Terrae of the Very Long Name', 5, 'physical', 'preservation'),
};
function c(displayName: string, rarity: number, element: string, path: string): PictureCharacter {
    return {
        displayName,
        rarity,
        element,
        path,
        imageUrl: `https://x.ufs.sh/f/${displayName.slice(0, 4)}`,
    };
}
const CONES: Record<string, PictureLightcone> = {
    mirror: {
        displayName: 'Past Self in Mirror',
        rarity: 5,
        imageUrl: 'https://x.ufs.sh/f/mirror',
        width: 0,
        posX: 0,
        posY: 0,
    },
    placed: {
        displayName: 'Along the Passing Shore',
        rarity: 5,
        imageUrl: 'https://x.ufs.sh/f/shore',
        width: 120,
        posX: -40,
        posY: -20,
    },
};

// Classic: Acheron 7 (+1 per eidolon), Pela 1, Clara 2, the long one 3; no Huohuo row. Cones 2.5 + 0.5 per
// superimposition. Auction: Acheron 8, Pela 1. One pair, Acheron with Pela, +1.5 in Classic.
function source(draft: DraftMode): TeamCostSource {
    const rows: Record<string, number> =
        draft === 'classic'
            ? { acheron: 7, pela: 1, clara: 2, longone: 3 }
            : { acheron: 8, pela: 1 };
    return {
        character: (name) => {
            const base = rows[name];
            return base === undefined ? undefined : [0, 1, 2, 3, 4, 5, 6].map((e) => base + e);
        },
        lightcone: (name) => (name === 'mirror' ? [2.5, 3, 3.5, 4, 4.5] : undefined),
        synergies: () => [
            {
                characterA: 'acheron',
                characterB: 'pela',
                costModifier: draft === 'classic' ? 1.5 : 0,
            },
        ],
    };
}

const slot = (character: string, extra: Partial<Exclude<Slot, null>> = {}): Slot => ({
    character,
    eidolon: 0,
    lightcone: null,
    superimposition: 1,
    ...extra,
});

function request(slots: Slots, opts: Partial<PictureRequest> = {}): PictureRequest {
    const draft = opts.draft ?? 'classic';
    const cost = teamCost(slots, draft, source(draft));
    return {
        title: 'My team',
        slots,
        cost,
        spend: draft === 'auction' ? auctionSpend(slots, cost, DEFAULT_BUDGETS) : null,
        draft,
        setLabel: 'Default',
        modeLabel: 'Apocalyptic Shadow',
        hideNames: false,
        character: (key) => CHARACTERS[key],
        lightcone: (key) => CONES[key],
        ...opts,
    };
}

/** The shapes with a tag. */
const tagged = (scene: Scene, tag: string): Shape[] =>
    scene.shapes.filter((s) => 'tag' in s && s.tag === tag);
type TextShape = Extract<Shape, { kind: 'text' }>;
/** A slot's cost caption in Auction, line by line: its parts joined in drawing order. */
const captionLines = (scene: Scene, i: number) => {
    const parts = scene.shapes.filter(
        (s): s is TextShape =>
            s.kind === 'text' && (s.tag === `slot-${i}-costs` || s.tag === `slot-${i}-bid`),
    );
    const lines = new Map<number, string>();
    for (const p of parts) lines.set(p.y, (lines.get(p.y) ?? '') + p.text);
    return [...lines.values()];
};
/** The figures in a text, in hundredths ("E1" is a level, not a figure). */
const figures = (t: string) =>
    [...t.matchAll(/(\d+)\.(\d{1,2})/g)].map(
        (m) => Number(m[1]) * 100 + Number(m[2]?.padEnd(2, '0')),
    );
const texts = (scene: Scene, tag: string) =>
    tagged(scene, tag).filter((s): s is TextShape => s.kind === 'text');
const textOf = (scene: Scene, tag: string) => texts(scene, tag)[0]?.text;
const allText = (scene: Scene) =>
    scene.shapes.filter((s): s is TextShape => s.kind === 'text').map((s) => s.text);
const fits = (s: TextShape, max: number) => measure(s.text, s.font) <= max + 0.001;

const FULL: Slots = [
    slot('acheron', { eidolon: 2, lightcone: 'mirror', superimposition: 3 }),
    slot('pela', { eidolon: 6 }),
    slot('clara', { lightcone: 'placed' }),
    slot('huohuo'),
];

describe('the picture', () => {
    it('is 1200 by 675 with a background, the site mark and name, and the modes', () => {
        const scene = layoutTeamPicture(request(FULL), measure);
        expect([scene.width, scene.height]).toEqual([PICTURE_WIDTH, PICTURE_HEIGHT]);
        expect([PICTURE_WIDTH, PICTURE_HEIGHT]).toEqual([1200, 675]);
        expect(tagged(scene, 'background')[0]).toMatchObject({ x: 0, y: 0, w: 1200, h: 675 });
        expect(scene.shapes.some((s) => s.kind === 'logo')).toBe(true);
        expect(textOf(scene, 'brand')).toBe('IPC BATTLEGROUNDS');
        expect(textOf(scene, 'modes')).toBe('DEFAULT · CLASSIC DRAFT · APOCALYPTIC SHADOW');
        expect(textOf(scene, 'title')).toBe('My team');
    });

    it('every shape stays inside the picture', () => {
        for (const draft of ['classic', 'auction'] as const) {
            const scene = layoutTeamPicture(request(FULL, { draft }), measure);
            for (const s of scene.shapes) {
                if (s.kind === 'text') {
                    expect(s.y).toBeLessThan(PICTURE_HEIGHT - 12);
                    expect(s.y).toBeGreaterThan(0);
                } else if (s.kind === 'rect' && s.tag !== undefined) {
                    expect(s.y + s.h).toBeLessThanOrEqual(PICTURE_HEIGHT);
                    expect(s.x + s.w).toBeLessThanOrEqual(PICTURE_WIDTH);
                }
            }
        }
    });

    it('a full team: four cards side by side with portrait, icons, pill, levels and caption', () => {
        const scene = layoutTeamPicture(request(FULL), measure);
        for (let i = 0; i < 4; i += 1) {
            expect(tagged(scene, `slot-${i}`)[0]).toMatchObject({
                x: cardX(i),
                y: CARD.top,
                w: CARD.width,
                h: CARD.height,
            });
        }
        expect(cardX(3) + CARD.width).toBe(PICTURE_WIDTH - 40);
        expect(tagged(scene, 'slot-0-portrait')[0]).toMatchObject({
            kind: 'image',
            src: CHARACTERS.acheron?.imageUrl,
            fit: 'cover',
            remote: true,
            fallback: 'portrait',
        });
        expect(tagged(scene, 'slot-0-element')[0]).toMatchObject({
            src: '/elements/lightning.webp',
        });
        expect(tagged(scene, 'slot-0-path')[0]).toMatchObject({ src: '/paths/nihility.webp' });
        expect(textOf(scene, 'slot-0-name')).toBe('Acheron');
        expect(textOf(scene, 'slot-0-cone-name')).toBe('Past Self in Mirror · S3');
        expect(textOf(scene, 'slot-0-eidolon')).toBe('E2');
        expect(textOf(scene, 'slot-0-superimposition')).toBe('S3');
        expect(textOf(scene, 'slot-1-cone-name')).toBe('No light cone');
        expect(textOf(scene, 'slot-1-superimposition')).toBeUndefined();
    });

    it('costs, the pill, the total and the pairings match the shared cost model', () => {
        const req = request(FULL);
        const scene = layoutTeamPicture(req, measure);
        // Acheron E2 9 + S3 3.5; Pela E6 7; Clara 2 + an unpriced cone (0); Huohuo no row (0); pair +1.5.
        expect(req.cost.total).toBe(900 + 350 + 700 + 200 + 150);
        expect(textOf(scene, 'total')).toBe('23.0');
        expect(textOf(scene, 'slot-0-pill')).toBe('12.5');
        expect(textOf(scene, 'slot-0-costs')).toBe('Unit 9.0 · LC 3.5');
        expect(textOf(scene, 'slot-1-pill')).toBe('7.0');
        expect(textOf(scene, 'slot-1-costs')).toBe('Unit 7.0 · LC –');
        expect(textOf(scene, 'pair-0-label')).toBe('Acheron × Pela');
        expect(textOf(scene, 'pair-0-modifier')).toBe('+1.5');
        // Acheron and Pela are paired: their pills carry the pairing's gold edge.
        expect(tagged(scene, 'slot-0-pill')[0]).toMatchObject({
            stroke: 'rgba(227, 207, 85, 0.75)',
        });
        expect(tagged(scene, 'slot-2-pill')[0]).toMatchObject({
            stroke: 'rgba(255, 255, 255, 0.14)',
        });
    });

    it('a missing cost row reads n/a (the light cone, the character)', () => {
        const scene = layoutTeamPicture(request(FULL), measure);
        expect(textOf(scene, 'slot-2-costs')).toBe('Unit 2.0 · LC n/a');
        expect(textOf(scene, 'slot-2-pill')).toBe('n/a');
        expect(textOf(scene, 'slot-3-costs')).toBe('Unit n/a · LC –');
        expect(textOf(scene, 'slot-3-pill')).toBe('n/a');
    });

    it('a placed light cone: its art box follows the cone values, clipped to the slanted corner', () => {
        const scene = layoutTeamPicture(request(FULL), measure);
        const corner = { x: cardX(2), y: CARD.top + CARD.height - 8 - CARD.height * 0.56 };
        const art = tagged(scene, 'slot-2-cone')[0] as Extract<Shape, { kind: 'image' }>;
        const box = coneArtBox(
            { ...corner, w: CARD.width, h: CARD.height * 0.56 },
            must(CONES.placed),
        );
        expect(art).toMatchObject({ ...box, fit: 'fill', remote: true, fallback: 'block' });
        expect(box.w).toBeCloseTo(CARD.width * 1.2);
        expect(Array.isArray(art.clip)).toBe(true);
        // The page's defaults when the cone has no placement.
        const plain = coneArtBox({ x: 0, y: 0, w: 100, h: 100 }, must(CONES.mirror));
        expect(plain).toMatchObject({ x: 2, w: 100 });
    });

    it('loads only the team images: at most four portraits and four cones from UploadThing', () => {
        const scene = layoutTeamPicture(request(FULL), measure);
        expect(scene.remote).toHaveLength(4 + 2);
        expect(scene.remote.every((u) => u.startsWith('https://x.ufs.sh/'))).toBe(true);
        expect(scene.local).toContain(BLANK_PORTRAIT);
        expect(scene.local.every((u) => u.startsWith('/'))).toBe(true);
    });
});

describe('partial and empty teams', () => {
    it('two empty slots are drawn empty, the total counts the two others', () => {
        const slots: Slots = [slot('acheron'), null, slot('pela'), null];
        const req = request(slots);
        const scene = layoutTeamPicture(req, measure);
        expect(tagged(scene, 'slot-1-empty')[0]).toMatchObject({
            x: cardX(1),
            w: CARD.width,
            dash: [6, 5],
        });
        expect(textOf(scene, 'slot-1-empty-label')).toBe('EMPTY');
        expect(textOf(scene, 'slot-1-name')).toBe('Slot 2');
        expect(textOf(scene, 'slot-3-name')).toBe('Slot 4');
        expect(tagged(scene, 'slot-1-portrait')).toHaveLength(0);
        // Acheron E0 7, Pela E0 1, the pair 1.5.
        expect(req.cost.total).toBe(950);
        expect(textOf(scene, 'total')).toBe('9.5');
        expect(scene.remote).toHaveLength(2);
    });

    it('an empty team: four empty slots, total 0.0, pairings "none", no images to load', () => {
        const scene = layoutTeamPicture(request([null, null, null, null]), measure);
        expect([0, 1, 2, 3].map((i) => textOf(scene, `slot-${i}-empty-label`))).toEqual([
            'EMPTY',
            'EMPTY',
            'EMPTY',
            'EMPTY',
        ]);
        expect(textOf(scene, 'total')).toBe('0.0');
        expect(textOf(scene, 'pairs-none')).toBe('none');
        expect(scene.remote).toEqual([]);
        expect(scene.local).toEqual([]);
    });

    it('a blank name is "Untitled"', () => {
        const scene = layoutTeamPicture(request(FULL, { title: '   ' }), measure);
        expect(textOf(scene, 'title')).toBe('Untitled');
    });
});

describe('Auction', () => {
    const AUCTION: Slots = [
        slot('acheron', { eidolon: 1, lightcone: 'mirror', bid: 250 }),
        slot('pela', { bid: 50 }),
        null,
        null,
    ];

    it('the bids under the cards and the two budgets as in the simulator', () => {
        const req = request(AUCTION, { draft: 'auction' });
        const scene = layoutTeamPicture(req, measure);
        const s = must(req.spend ?? undefined);
        expect(textOf(scene, 'modes')).toBe('DEFAULT · AUCTION DRAFT · APOCALYPTIC SHADOW');
        // The caption shows the character cost as its parts (review S1). Acheron: base 8 + bid 2.5 + eidolon
        // extra 1 (too long for one line: the light cone goes to a second); Pela: base 1 + bid 0.5, one line.
        expect(textOf(scene, 'slot-0-bid')).toBe('bid 2.5');
        expect(textOf(scene, 'slot-1-bid')).toBe('bid 0.5');
        expect(captionLines(scene, 0)).toEqual(['Unit 8.0 + bid 2.5 + E1 1.0', 'LC 2.5']);
        expect(captionLines(scene, 1)).toEqual(['Unit 1.0 + bid 0.5 · LC –']);
        expect(texts(scene, 'slot-0-bid')[0]?.color).toBe('#c9a961');
        expect(allText(scene).some((t) => t.startsWith('Extra bid'))).toBe(false);
        expect(textOf(scene, 'total')).toBe((req.cost.total / 100).toFixed(1));
        expect(textOf(scene, 'budget-character-label')).toBe('CHARACTER BUDGET');
        expect(textOf(scene, 'budget-character-left')).toBe(
            `${(s.characterLeft / 100).toFixed(1)} left`,
        );
        // Winning 8 + 2.5 and 1 + 0.5, the eidolon extra 1: 13 of 30; 17 rolls over; the cone 2.5.
        expect(textOf(scene, 'budget-character-foot')).toBe('13.0 of 30.0');
        expect(textOf(scene, 'budget-lightcone-foot')).toBe('2.5 of 32.0');
        expect(textOf(scene, 'budget-lightcone-extra')).toBe('15.0 + 17.0 rolled over');
        const track = tagged(scene, 'budget-character-track')[0] as { w: number };
        const fill = tagged(scene, 'budget-character-fill')[0] as { w: number };
        expect(fill.w / track.w).toBeCloseTo(s.characterLeft / s.budgets.character);
    });

    it('over the character budget: "Over by", the error colour, an empty meter', () => {
        const slots: Slots = [slot('acheron', { bid: 2500 }), null, null, null];
        const scene = layoutTeamPicture(request(slots, { draft: 'auction' }), measure);
        expect(textOf(scene, 'budget-character-foot')).toBe('Over by 3.0');
        expect(texts(scene, 'budget-character-foot')[0]?.color).toBe('#d85a5a');
        expect(textOf(scene, 'budget-character-left')).toBe('−3.0 left');
        expect(tagged(scene, 'budget-character-fill')).toHaveLength(0);
    });

    it('bids in hundredths: the caption parts add up to the pill, the pills to the total, all as amountFixed', () => {
        const slots: Slots = [
            slot('acheron', { eidolon: 1, lightcone: 'mirror', bid: 125 }),
            slot('pela', { bid: 25 }),
            slot('acheron', { bid: 25 }),
            null,
        ];
        const req = request(slots, { draft: 'auction' });
        const scene = layoutTeamPicture(req, measure);
        // Acheron: 8 + 1.25 + 1 = 10.25, the cone 2.5: 12.75; Pela 1 + 0.25 = 1.25; Acheron again 8.25.
        expect(textOf(scene, 'slot-0-pill')).toBe('12.75');
        expect(captionLines(scene, 0)).toEqual(['Unit 8.0 + bid 1.25 + E1 1.0', 'LC 2.5']);
        expect(textOf(scene, 'slot-1-pill')).toBe('1.25');
        expect(captionLines(scene, 1)).toEqual(['Unit 1.0 + bid 0.25 · LC –']);
        expect(textOf(scene, 'slot-2-pill')).toBe('8.25');
        expect(req.cost.total).toBe(1275 + 125 + 825);
        expect(textOf(scene, 'total')).toBe('22.25');
        let pills = 0;
        for (let i = 0; i < 3; i += 1) {
            const pill = figures(must(textOf(scene, `slot-${i}-pill`)));
            const parts = figures(captionLines(scene, i).join(' '));
            expect(parts.reduce((a, b) => a + b, 0)).toBe(pill[0]);
            // Each figure as the shared model has it, not rounded to one decimal.
            expect(pill[0]).toBe(req.cost.slots[i]?.total);
            pills += pill[0] ?? 0;
        }
        expect(pills).toBe(figures(must(textOf(scene, 'total')))[0]);
    });

    it('Classic has no bids and no budgets', () => {
        const scene = layoutTeamPicture(request(AUCTION), measure);
        expect(allText(scene).some((t) => t.startsWith('Extra bid'))).toBe(false);
        expect(tagged(scene, 'budget-character-track')).toHaveLength(0);
    });
});

describe('hide who is on the team', () => {
    it('no names, portraits, icons or cone art; costs, levels and the pair amounts stay', () => {
        const req = request(FULL, { hideNames: true });
        const scene = layoutTeamPicture(req, measure);
        const words = allText(scene).join(' ');
        for (const name of ['Acheron', 'Pela', 'Clara', 'Huohuo', 'Past Self', 'Passing Shore'])
            expect(words).not.toContain(name);
        expect(textOf(scene, 'slot-0-name')).toBe('Character 1');
        expect(textOf(scene, 'slot-0-cone-name')).toBe('Light cone · S3');
        expect(textOf(scene, 'slot-1-cone-name')).toBe('No light cone');
        expect(tagged(scene, 'slot-0-portrait')[0]).toMatchObject({
            src: BLANK_PORTRAIT,
            remote: false,
        });
        expect(tagged(scene, 'slot-0-element')).toHaveLength(0);
        expect(tagged(scene, 'slot-0-cone')).toHaveLength(0);
        expect(scene.remote).toEqual([]);
        expect(textOf(scene, 'pair-0-label')).toBe('Pairing 1');
        expect(textOf(scene, 'pair-0-modifier')).toBe('+1.5');
        expect(textOf(scene, 'slot-0-costs')).toBe('Unit 9.0 · LC 3.5');
        expect(textOf(scene, 'slot-0-eidolon')).toBe('E2');
        expect(textOf(scene, 'total')).toBe('23.0');
        expect(textOf(scene, 'hidden-badge')).toBe('TEAM HIDDEN');
    });

    it('no loadout name anywhere: a neutral title (review S4, user ruling)', () => {
        const req = request(FULL, { hideNames: true, title: 'Acheron Pela core' });
        const scene = layoutTeamPicture(req, measure);
        expect(textOf(scene, 'title')).toBe(HIDDEN_TITLE);
        expect(HIDDEN_TITLE).toBe('Hidden team');
        expect(allText(scene).join(' ')).not.toContain('core');
    });

    it('no pairing edge on the pills, which would tell which slots pair (review S3)', () => {
        const scene = layoutTeamPicture(request(FULL, { hideNames: true }), measure);
        for (let i = 0; i < 4; i += 1) {
            expect(tagged(scene, `slot-${i}-pill`)[0]).toMatchObject({
                stroke: 'rgba(255, 255, 255, 0.14)',
            });
        }
    });

    it('without the option there is no badge and the loadout name is the title', () => {
        const scene = layoutTeamPicture(request(FULL), measure);
        expect(tagged(scene, 'hidden-badge')).toHaveLength(0);
        expect(textOf(scene, 'title')).toBe('My team');
    });
});

describe('long names', () => {
    const LONG: Slots = [
        slot('longone', { lightcone: 'mirror' }),
        slot('acheron'),
        slot('pela'),
        slot('clara'),
    ];

    it('a long character name shrinks, then ends with an ellipsis, inside its card', () => {
        const scene = layoutTeamPicture(request(LONG), measure);
        const name = must(texts(scene, 'slot-0-name')[0]);
        expect(name.font.size).toBe(14);
        expect(name.text.endsWith('…')).toBe(true);
        expect(fits(name, CARD.width - 4)).toBe(true);
    });

    it('a long title shrinks and never reaches the total', () => {
        const title = 'W'.repeat(40);
        const scene = layoutTeamPicture(request(LONG, { title }), measure);
        const t = must(texts(scene, 'title')[0]);
        const sigma = must(texts(scene, 'sigma')[0]);
        const sigmaLeft = sigma.x - measure(sigma.text, sigma.font);
        expect(t.x + measure(t.text, t.font)).toBeLessThan(sigmaLeft);
        expect(t.font.size).toBeGreaterThanOrEqual(26);
    });

    it('many long pairs: chips stay in their band and the rest is "+N more"', () => {
        const pairs = Array.from({ length: 10 }, () => ({
            characterA: 'longone',
            characterB: 'longone',
            modifier: 100,
        }));
        const req = request(LONG);
        const scene = layoutTeamPicture(
            { ...req, cost: { ...req.cost, pairs, surcharge: 1000 } },
            measure,
        );
        const chips = scene.shapes.filter(
            (s): s is Extract<Shape, { kind: 'rect' }> =>
                s.kind === 'rect' && /^pair-\d+$/.test(s.tag ?? ''),
        );
        expect(chips.length).toBeGreaterThan(0);
        expect(chips.length).toBeLessThan(10);
        for (const c of chips) expect(c.x + c.w).toBeLessThanOrEqual(PICTURE_WIDTH - 40);
        expect(textOf(scene, 'pairs-more')).toMatch(/^\+\d more$/);
        // The pairings' sum stays, so the total can be rebuilt without the cut chips (review M5).
        expect(textOf(scene, 'pairs-sum')).toBe('+10.0');
    });

    it('the pairings sum is the surcharge the total adds; no pairings, no sum', () => {
        const scene = layoutTeamPicture(request(FULL), measure);
        expect(textOf(scene, 'pairs-sum')).toBe('+1.5');
        const none = layoutTeamPicture(request([slot('clara'), null, null, null]), measure);
        expect(tagged(none, 'pairs-sum')).toHaveLength(0);
    });
});

describe('fitText', () => {
    const f: Font = { family: 'sans', size: 20, weight: 700 };
    it('keeps a text that fits', () => {
        expect(fitText('abc', f, 100, measure)).toEqual({ text: 'abc', font: f });
    });
    it('shrinks down to the minimum size before cutting', () => {
        const r = fitText('abcdefghij', f, 100, measure, 10);
        expect(r.text).toBe('abcdefghij');
        expect(r.font.size).toBe(16);
    });
    it('cuts by whole characters with an ellipsis at the minimum size', () => {
        const r = fitText('abcdefghijklmnopqrstuvwxyz', f, 60, measure, 10);
        expect(r.font.size).toBe(10);
        expect(r.text).toBe('abcdefghi…');
        expect(measure(r.text, r.font)).toBeLessThanOrEqual(60);
        expect(fitText('😀😀😀😀', f, 30, measure, 20).text).toBe('😀…');
    });
    it('never cuts an emoji sequence or a flag in half (review M6)', () => {
        const family = '👨‍👩‍👧‍👦';
        expect(graphemes(`a${family}🇯🇵b`)).toEqual(['a', family, '🇯🇵', 'b']);
        // 12 px per code point: a cut by code points would keep "ab" and four of the family's seven.
        const r = fitText(`ab${family}`, f, 90, measure, 20);
        expect(r.text).toBe('ab…');
        const flags = fitText('🇯🇵🇯🇵🇯🇵', f, 40, measure, 20);
        expect(flags.text).toBe('🇯🇵…');
    });
});

describe('the file name', () => {
    it.each([
        ['Herta Erudition core', 'team-herta-erudition-core.png'],
        ['  Firefly / Break!! ', 'team-firefly-break.png'],
        ['con', 'team-con.png'],
        ['Ｆｕｌｌ　Ｗｉｄｔｈ', 'team-full-width.png'],
        ['日本語のチーム', 'team-日本語のチーム.png'],
        ['Café: Ruan Mei', 'team-café-ruan-mei.png'],
        ['???', 'team.png'],
        ['', 'team.png'],
        ['a'.repeat(80), `team-${'a'.repeat(60)}.png`],
        [`${'a'.repeat(59)} b`, `team-${'a'.repeat(59)}.png`],
        ['..\\..\\evil', 'team-evil.png'],
        // Combining marks stay inside the word (review M7).
        ['हिन्दी टीम', 'team-हिन्दी-टीम.png'],
    ])('%j saves as %j', (title, file) => {
        expect(pictureFileName(title)).toBe(file);
    });
});
