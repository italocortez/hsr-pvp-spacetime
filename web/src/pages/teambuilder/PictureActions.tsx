import { useEffect, useId, useRef, useState } from 'react';
import { downloadBlob } from '@/lib/downloadBlob';
import loadoutStyles from './LoadoutsPanel.module.css';
import styles from './PictureActions.module.css';
import { CheckIcon, DownloadIcon, ImageIcon } from './TeamBuilderIcons';
import type { TeamPicture } from './teamPicture';
import type { PictureRequest } from './teamPictureLayout';

/*
 * The team picture's two actions in the Loadouts card (S14.3d, A190 item 8, A202 item 2), under "Copy link":
 * "Copy image" (the Async Clipboard API with a `ClipboardItem` of type image/png) and "Download" (a PNG named from
 * the loadout), and the option "Hide who is on the team". The drawing code (`teamPicture.ts`) is a dynamic import
 * on the first press, so the team builder's chunk does not carry it.
 *
 * The confirmation is a visible line that is also the live region (the copy-button guide's bubble): "Making the
 * image…" while it is made, then the outcome. While an image is being made both buttons ignore presses (they stay
 * focusable: the copy-button guide's rule against disabling) and the pressed one shows a spinner.
 *
 * Copy image: the clipboard write is called in the press itself with the image as a promise, so the browser keeps
 * the press's permission while the image is drawn (a later call can be refused once the press has expired).
 * Without `ClipboardItem`, without image/png in it, or refused: the line says so and offers "Download instead".
 *
 * A hidden picture carries no loadout name: a neutral title and file name (`teamPicture.ts`), so the status line,
 * which names the file, does not repeat it either (review S4, user ruling). A person who leaves the page while
 * the image is made gets no file and no clipboard image (review M1).
 */

export const PICTURE_MAKING = 'Making the image…';
export const PICTURE_COPIED = 'Image copied. Paste it into a chat or a post.';
export const PICTURE_SAVED = (file: string) => `Image downloaded as ${file}.`;
export const PICTURE_BLANKS = 'Some pictures could not be loaded and show as blanks.';
export const PICTURE_NO_COPY = 'This browser cannot copy images. Download it instead.';
export const PICTURE_COPY_REFUSED = 'The image could not be copied. Download it instead.';
export const PICTURE_FAILED = 'The image could not be made. Try again.';
export const PICTURE_HIDE = 'Hide who is on the team';
/**
 * How long the downloaded file's blob address stays valid. No event says the browser has started the download,
 * so it is a timer; long enough for a slow "Download?" answer (iOS Safari asks first; review M3).
 */
export const PICTURE_RELEASE_MS = 60_000;

type Line = {
    tone: 'busy' | 'ok' | 'failed';
    text: string;
    /** The action the line reports on. */
    what?: 'copy' | 'download';
    offer?: boolean;
} | null;
type Busy = 'copy' | 'download' | null;

const loadPainter = () => import('./teamPicture');

/** Whether this browser can put a PNG on the clipboard at all. */
export function canCopyImage(): boolean {
    if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) return false;
    const supports = (ClipboardItem as unknown as { supports?: (type: string) => boolean })
        .supports;
    return typeof supports === 'function' ? supports('image/png') : true;
}

export function PictureActions({
    request,
    disabled = false,
}: {
    /** The picture's content at the moment of the press. */
    request: (hideNames: boolean) => PictureRequest;
    /** The cost rows are not here yet. */
    disabled?: boolean;
}) {
    const id = useId();
    const [hide, setHide] = useState(false);
    const [busy, setBusy] = useState<Busy>(null);
    const [line, setLine] = useState<Line>(null);
    const busyRef = useRef<Busy>(null);
    const downloadRef = useRef<HTMLButtonElement>(null);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const mounted = useRef(true);

    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
            if (timer.current) clearTimeout(timer.current);
        };
    }, []);

    const show = (next: Line) => {
        if (!mounted.current) return;
        if (timer.current) clearTimeout(timer.current);
        // Next frame, so the same words said twice are read again (copy-button guide).
        setLine(null);
        requestAnimationFrame(() => {
            if (mounted.current) setLine(next);
        });
        if (next?.tone === 'ok') timer.current = setTimeout(() => setLine(null), 6000);
    };
    const start = (what: Exclude<Busy, null>) => {
        if (busyRef.current || disabled) return false;
        busyRef.current = what;
        setBusy(what);
        if (timer.current) clearTimeout(timer.current);
        setLine({ tone: 'busy', text: PICTURE_MAKING });
        return true;
    };
    const end = () => {
        busyRef.current = null;
        if (mounted.current) setBusy(null);
    };
    const make = (): Promise<TeamPicture> => {
        const req = request(hide);
        return loadPainter().then((m) => m.makeTeamPicture(req));
    };
    const withBlanks = (text: string, picture: TeamPicture) =>
        picture.missing > 0 ? `${text} ${PICTURE_BLANKS}` : text;

    const onDownload = async () => {
        if (!start('download')) return;
        try {
            const picture = await make();
            // Left the page while it was made: no file (review M1).
            if (!mounted.current) return;
            downloadBlob(picture.blob, picture.fileName, PICTURE_RELEASE_MS);
            show({
                tone: 'ok',
                what: 'download',
                text: withBlanks(PICTURE_SAVED(picture.fileName), picture),
            });
        } catch {
            show({ tone: 'failed', text: PICTURE_FAILED });
        } finally {
            end();
        }
    };

    const onCopy = async () => {
        if (!start('copy')) return;
        if (!canCopyImage()) {
            show({ tone: 'failed', text: PICTURE_NO_COPY, offer: true });
            end();
            return;
        }
        const made = make();
        // Settled here too, so a failure is never an unhandled rejection whichever path reads it.
        made.catch(() => undefined);
        try {
            // The write starts in the press; should the person leave before the image is made, its data is
            // refused, so nothing reaches the clipboard (review M1).
            const item = new ClipboardItem({
                'image/png': made.then((p) => {
                    if (!mounted.current) throw new Error('The page was left.');
                    return p.blob;
                }),
            });
            await navigator.clipboard.write([item]);
            const picture = await made;
            show({ tone: 'ok', what: 'copy', text: withBlanks(PICTURE_COPIED, picture) });
        } catch {
            const drawn = await made.then(
                () => true,
                () => false,
            );
            show(
                drawn
                    ? { tone: 'failed', text: PICTURE_COPY_REFUSED, offer: true }
                    : { tone: 'failed', text: PICTURE_FAILED },
            );
        } finally {
            end();
        }
    };

    const offer = line?.offer === true;
    return (
        <div className={styles.picture}>
            <div className={loadoutStyles.actions}>
                <button
                    type="button"
                    className={`${loadoutStyles.button} ${styles.button}`}
                    onClick={onCopy}
                    disabled={disabled}
                    aria-disabled={busy !== null ? true : undefined}
                    data-busy={busy === 'copy' ? '' : undefined}
                >
                    {busy === 'copy' ? (
                        <span className={styles.spinner} aria-hidden="true" />
                    ) : line?.tone === 'ok' && line.what === 'copy' ? (
                        <CheckIcon className={loadoutStyles.buttonIcon} />
                    ) : (
                        <ImageIcon className={loadoutStyles.buttonIcon} />
                    )}
                    Copy image
                </button>
                <button
                    ref={downloadRef}
                    type="button"
                    className={`${loadoutStyles.button} ${styles.button}`}
                    onClick={onDownload}
                    disabled={disabled}
                    aria-disabled={busy !== null ? true : undefined}
                    data-busy={busy === 'download' ? '' : undefined}
                >
                    {busy === 'download' ? (
                        <span className={styles.spinner} aria-hidden="true" />
                    ) : line?.tone === 'ok' && line.what === 'download' ? (
                        <CheckIcon className={loadoutStyles.buttonIcon} />
                    ) : (
                        <DownloadIcon className={loadoutStyles.buttonIcon} />
                    )}
                    Download
                </button>
            </div>
            <label className={styles.hide} htmlFor={`${id}-hide`}>
                <input
                    id={`${id}-hide`}
                    type="checkbox"
                    checked={hide}
                    onChange={(e) => setHide(e.currentTarget.checked)}
                />
                {PICTURE_HIDE}
            </label>
            {/* A div, not a p: the page's own status region is the last `p[role="status"]`. */}
            <div
                role="status"
                className={styles.status}
                data-tone={line?.tone}
                data-show={line ? '' : undefined}
            >
                {line?.text ?? ''}
            </div>
            {offer && (
                <button
                    type="button"
                    className={`${loadoutStyles.noticeButton} ${styles.offer}`}
                    onClick={() => {
                        // The offer goes while the image is made: focus waits on Download.
                        downloadRef.current?.focus();
                        void onDownload();
                    }}
                >
                    Download instead
                </button>
            )}
        </div>
    );
}
