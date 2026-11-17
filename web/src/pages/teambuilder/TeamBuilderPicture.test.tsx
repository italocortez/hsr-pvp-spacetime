import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INTRO_KEY } from '@/components/PageIntro/PageIntro';
import { CHARACTERS, characterCost, LIGHTCONES, lightconeCost, synergy } from '@/test/costFixtures';
import { MockConnection } from '@/test/mockConnection';
import { renderWithConnection } from '@/test/renderWithConnection';
import { ACTIVE_KEY, BROWSER_KEY } from './loadoutStorage';
import {
    PICTURE_BLANKS,
    PICTURE_COPIED,
    PICTURE_COPY_REFUSED,
    PICTURE_FAILED,
    PICTURE_MAKING,
    PICTURE_NO_COPY,
    PICTURE_SAVED,
} from './PictureActions';
import { DRAFT_KEY, PREVIOUS_KEY } from './teamStorage';

/*
 * T-S14.3d: the team picture's two actions through the real page with the mock connection.
 *
 * jsdom has no canvas and loads no images, so the test stubs them: `getContext('2d')` returns a recording
 * context (every `fillText` and `drawImage` is kept), `toBlob` hands back a small PNG blob, `Image` loads or fails
 * by address, `URL.createObjectURL` and the link's `click` are recorded, the clipboard and `ClipboardItem` are
 * stand-ins. What this proves: which texts and images reach the canvas (so the layout got the page's team, its
 * costs and the hide option), the fallbacks, the busy state, the clipboard and download paths, the confirmations
 * and their live region. What it cannot prove: how the picture looks, that fonts and real images draw, that a
 * real browser's clipboard accepts the PNG or that its download starts; those are the browser checks.
 */

let conn: MockConnection;
type Recorded = { texts: string[]; images: string[] };
let drawn: Recorded;
let failHosts: RegExp | null;
let blobs: number;
let clicks: { href: string; download: string }[];
let clipboardWrite: ReturnType<typeof vi.fn>;

class FakeClipboardItem {
    constructor(public items: Record<string, Promise<Blob> | Blob>) {}
}

class FakeImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    crossOrigin: string | null = null;
    decoding = 'auto';
    naturalWidth = 0;
    naturalHeight = 0;
    private url = '';
    get src() {
        return this.url;
    }
    set src(value: string) {
        this.url = value;
        setTimeout(() => {
            if (failHosts?.test(value)) this.onerror?.();
            else {
                this.naturalWidth = 200;
                this.naturalHeight = 300;
                this.onload?.();
            }
        }, 0);
    }
}

function fakeContext(): CanvasRenderingContext2D {
    const noop = () => undefined;
    return new Proxy(
        {
            font: '',
            measureText: (t: string) => ({ width: Array.from(t).length * 7 }),
            fillText: (t: string) => {
                drawn.texts.push(t);
            },
            drawImage: (img: FakeImage) => {
                drawn.images.push(img.src);
            },
            createLinearGradient: () => ({ addColorStop: noop }),
        } as Record<string, unknown>,
        {
            get: (target, key) => (key in target ? target[key as string] : noop),
            set: (target, key, value) => {
                target[key as string] = value;
                return true;
            },
        },
    ) as unknown as CanvasRenderingContext2D;
}

beforeEach(() => {
    conn = new MockConnection();
    drawn = { texts: [], images: [] };
    failHosts = null;
    blobs = 0;
    clicks = [];
    try {
        localStorage.removeItem(INTRO_KEY);
        localStorage.removeItem(DRAFT_KEY);
        localStorage.removeItem(PREVIOUS_KEY);
        localStorage.removeItem(BROWSER_KEY);
        localStorage.removeItem(ACTIVE_KEY);
    } catch {}
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
        () => fakeContext() as never,
    );
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((cb) => {
        blobs += 1;
        setTimeout(() => cb(new Blob(['png'], { type: 'image/png' })), 0);
    });
    vi.stubGlobal('Image', FakeImage);
    vi.stubGlobal('ClipboardItem', FakeClipboardItem);
    clipboardWrite = vi.fn(async (items: FakeClipboardItem[]) => {
        await items[0]?.items['image/png'];
    });
    URL.createObjectURL = vi.fn(() => 'blob:picture');
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
        this: HTMLAnchorElement,
    ) {
        clicks.push({ href: this.href, download: this.download });
    });
});
afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

/** user-event puts its own clipboard on `navigator` at setup: the stand-in goes on after it. */
function setupUser() {
    const user = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { write: clipboardWrite, writeText: vi.fn(async () => undefined) },
    });
    return user;
}

function seed() {
    conn.db.hsrCharacter.seed(...CHARACTERS);
    conn.db.hsrLightcone.seed(...LIGHTCONES);
    conn.db.hsrCharacterCost.seed(
        characterCost('acheron', 7),
        characterCost('pela', 1),
        characterCost('clara', 2),
    );
    conn.db.hsrLightconeCost.seed(lightconeCost('pastselfinmirror', 2.5));
    conn.db.hsrSynergyCost.seed(synergy('acheron', 'pela', 1.5));
}

const TEAM = '1.acheron-0-pastselfinmirror-1.pela-6._._.as-c-0-3000-1500';

async function open(path = `/teambuilder?team=${TEAM}`) {
    const r = renderWithConnection(path, conn, { ready: true });
    await screen.findByRole('heading', { level: 1 });
    seed();
    await act(async () => conn.applyAll());
    await waitFor(() => expect(copyButton()).toBeEnabled());
    return r;
}

const copyButton = () => screen.getByRole('button', { name: 'Copy image' });
const downloadButton = () => screen.getByRole('button', { name: 'Download' });
const hideBox = () => screen.getByRole('checkbox', { name: 'Hide who is on the team' });
const line = () =>
    screen
        .getAllByRole('status')
        .find((el) => el.previousElementSibling?.tagName === 'LABEL') as HTMLElement;

describe('the team picture', () => {
    it('Download: draws the team from the page data and saves a PNG named from the loadout', async () => {
        const user = setupUser();
        await open();
        await user.click(downloadButton());
        await waitFor(() =>
            expect(line()).toHaveTextContent(PICTURE_SAVED('team-shared-team.png')),
        );
        expect(clicks).toEqual([{ href: 'blob:picture', download: 'team-shared-team.png' }]);
        expect(blobs).toBe(1);
        // The page's team, costs and pair reached the canvas.
        expect(drawn.texts).toEqual(
            expect.arrayContaining([
                'Shared team',
                'Acheron',
                'Pela',
                'Unit 7.0 · LC 2.5',
                'Acheron × Pela',
                '+1.5',
                '18.0',
                'EMPTY',
            ]),
        );
        // Only the team's UploadThing images: two portraits and one cone.
        const remote = [...new Set(drawn.images.filter((s) => s.includes('ufs.sh')))];
        expect(remote).toHaveLength(3);
        // No clipboard on Download.
        expect(clipboardWrite).not.toHaveBeenCalled();
    });

    it('Copy image: one clipboard write with a PNG item, then the confirmation in the live region', async () => {
        const user = setupUser();
        await open();
        await user.click(copyButton());
        await waitFor(() => expect(line()).toHaveTextContent(PICTURE_COPIED));
        expect(clipboardWrite).toHaveBeenCalledTimes(1);
        const [items] = clipboardWrite.mock.calls[0] as [FakeClipboardItem[]];
        const blob = await items[0]?.items['image/png'];
        expect(blob).toBeInstanceOf(Blob);
        expect((blob as Blob).type).toBe('image/png');
        expect(line()).toHaveAttribute('role', 'status');
        expect(line()).toHaveAttribute('data-tone', 'ok');
        expect(clicks).toEqual([]);
    });

    it('busy: "Making the image…" while it is made, and a second press is ignored', async () => {
        const user = setupUser();
        await open();
        let release: () => void = () => undefined;
        clipboardWrite.mockImplementation(
            (items: FakeClipboardItem[]) =>
                new Promise<void>((resolve) => {
                    release = () => {
                        void Promise.resolve(items[0]?.items['image/png']).then(() => resolve());
                    };
                }),
        );
        await user.click(copyButton());
        expect(line()).toHaveTextContent(PICTURE_MAKING);
        expect(copyButton()).toHaveAttribute('aria-disabled', 'true');
        expect(downloadButton()).toHaveAttribute('aria-disabled', 'true');
        await user.click(copyButton());
        await user.click(downloadButton());
        expect(clipboardWrite).toHaveBeenCalledTimes(1);
        expect(clicks).toEqual([]);
        await act(async () => release());
        await waitFor(() => expect(line()).toHaveTextContent(PICTURE_COPIED));
        expect(copyButton()).not.toHaveAttribute('aria-disabled');
    });

    it('no ClipboardItem: says so and offers the download, which then saves the file', async () => {
        const user = setupUser();
        vi.stubGlobal('ClipboardItem', undefined);
        await open();
        await user.click(copyButton());
        await waitFor(() => expect(line()).toHaveTextContent(PICTURE_NO_COPY));
        expect(line()).toHaveAttribute('data-tone', 'failed');
        expect(clipboardWrite).not.toHaveBeenCalled();
        await user.click(screen.getByRole('button', { name: 'Download instead' }));
        await waitFor(() => expect(clicks).toHaveLength(1));
        expect(downloadButton()).toHaveFocus();
        await waitFor(() => expect(line()).toHaveTextContent('Image downloaded as'));
    });

    it('ClipboardItem without image/png (supports() false): the same offer', async () => {
        const user = setupUser();
        vi.stubGlobal(
            'ClipboardItem',
            Object.assign(class extends FakeClipboardItem {}, { supports: () => false }),
        );
        await open();
        await user.click(copyButton());
        await waitFor(() => expect(line()).toHaveTextContent(PICTURE_NO_COPY));
        expect(screen.getByRole('button', { name: 'Download instead' })).toBeInTheDocument();
    });

    it('the clipboard refuses: says so and offers the download', async () => {
        const user = setupUser();
        clipboardWrite.mockRejectedValue(new DOMException('Denied', 'NotAllowedError'));
        await open();
        await user.click(copyButton());
        await waitFor(() => expect(line()).toHaveTextContent(PICTURE_COPY_REFUSED));
        expect(screen.getByRole('button', { name: 'Download instead' })).toBeInTheDocument();
    });

    it('UploadThing images that fail: the picture is still made, with blanks, and the line says so', async () => {
        const user = setupUser();
        failHosts = /ufs\.sh/;
        await open();
        await user.click(downloadButton());
        await waitFor(() => expect(line()).toHaveTextContent(PICTURE_BLANKS));
        expect(clicks).toHaveLength(1);
        // The blank character stands in for the portraits; no UploadThing image is drawn.
        expect(drawn.images.some((s) => s.includes('ufs.sh'))).toBe(false);
        expect(drawn.images).toContain('/characters/blank.webp');
    });

    it('a canvas that cannot be encoded: a clear failure, nothing saved', async () => {
        const user = setupUser();
        vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((cb) => {
            setTimeout(() => cb(null), 0);
        });
        await open();
        await user.click(downloadButton());
        await waitFor(() => expect(line()).toHaveTextContent(PICTURE_FAILED));
        expect(clicks).toEqual([]);
        expect(downloadButton()).not.toHaveAttribute('aria-disabled');
    });

    it('a tainted canvas: drawn again without the UploadThing images', async () => {
        const user = setupUser();
        let first = true;
        vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((cb) => {
            if (first) {
                first = false;
                throw new DOMException('Tainted canvases may not be exported.', 'SecurityError');
            }
            setTimeout(() => cb(new Blob(['png'], { type: 'image/png' })), 0);
        });
        await open();
        await user.click(downloadButton());
        await waitFor(() => expect(line()).toHaveTextContent(PICTURE_BLANKS));
        expect(clicks).toHaveLength(1);
    });

    it('hide who is on the team reaches the picture: no names, no portraits; costs stay', async () => {
        const user = setupUser();
        await open();
        await user.click(hideBox());
        expect(hideBox()).toBeChecked();
        await user.click(downloadButton());
        await waitFor(() => expect(clicks).toHaveLength(1));
        const words = drawn.texts.join(' ');
        expect(words).not.toContain('Acheron');
        expect(words).not.toContain('Pela');
        expect(words).not.toContain('Past Self in Mirror');
        expect(drawn.texts).toEqual(
            expect.arrayContaining(['Character 1', 'Pairing 1', 'TEAM HIDDEN', '18.0']),
        );
        expect(drawn.images.some((s) => s.includes('ufs.sh'))).toBe(false);
    });

    it('hidden: no loadout name in the title, the file name or the status line (review S4, user ruling)', async () => {
        const user = setupUser();
        await open();
        await user.click(hideBox());
        await user.click(downloadButton());
        await waitFor(() => expect(line()).toHaveTextContent(PICTURE_SAVED('team-hidden.png')));
        expect(clicks).toEqual([{ href: 'blob:picture', download: 'team-hidden.png' }]);
        expect(drawn.texts).toContain('Hidden team');
        expect(drawn.texts.join(' ')).not.toContain('Shared team');
        expect(line().textContent).not.toContain('shared');
        // Unticked again: the loadout's name is back.
        await user.click(hideBox());
        await user.click(downloadButton());
        await waitFor(() => expect(clicks).toHaveLength(2));
        expect(clicks[1]?.download).toBe('team-shared-team.png');
    });

    it('leaving the page while the image is made: no file is saved (review M1)', async () => {
        const user = setupUser();
        let encode: () => void = () => undefined;
        vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((cb) => {
            encode = () => cb(new Blob(['png'], { type: 'image/png' }));
        });
        const r = await open();
        await user.click(downloadButton());
        await waitFor(() => expect(line()).toHaveTextContent(PICTURE_MAKING));
        await waitFor(() => expect(drawn.texts.length).toBeGreaterThan(0));
        r.unmount();
        await act(async () => {
            encode();
            await new Promise((done) => setTimeout(done, 20));
        });
        expect(clicks).toEqual([]);
        expect(URL.createObjectURL).not.toHaveBeenCalled();
    });

    it('leaving the page while the image is made: nothing reaches the clipboard (review M1)', async () => {
        const user = setupUser();
        let encode: () => void = () => undefined;
        vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((cb) => {
            encode = () => cb(new Blob(['png'], { type: 'image/png' }));
        });
        let data: Promise<unknown> | undefined;
        clipboardWrite.mockImplementation(async (items: FakeClipboardItem[]) => {
            data = Promise.resolve(items[0]?.items['image/png']);
            await data;
        });
        const r = await open();
        await user.click(copyButton());
        await waitFor(() => expect(drawn.texts.length).toBeGreaterThan(0));
        r.unmount();
        await act(async () => {
            encode();
            await new Promise((done) => setTimeout(done, 20));
        });
        expect(clipboardWrite).toHaveBeenCalledTimes(1);
        await expect(data).rejects.toThrow();
    });

    it('the note is never drawn', async () => {
        const user = setupUser();
        await open();
        await user.type(screen.getByRole('textbox', { name: /^Note/ }), 'secret plan');
        await user.click(downloadButton());
        await waitFor(() => expect(clicks).toHaveLength(1));
        expect(drawn.texts.join(' ')).not.toContain('secret plan');
    });

    it('works by keyboard: Tab to Download, Enter', async () => {
        const user = setupUser();
        await open();
        copyButton().focus();
        await user.tab();
        expect(downloadButton()).toHaveFocus();
        await user.keyboard('{Enter}');
        await waitFor(() => expect(clicks).toHaveLength(1));
        expect(downloadButton()).toHaveFocus();
    });
});
