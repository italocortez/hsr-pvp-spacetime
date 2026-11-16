import { useState } from 'react';
import styles from './RemoteImage.module.css';

/*
 * An image from UploadThing, rendered by the rule in docs/frontend/pages.md (M10):
 * `crossorigin="anonymous"` (a CORS request, like the image cache worker's own refetch); explicit
 * `width` and `height`, so the layout does not shift; `loading="lazy"` unless the image is above
 * the fold. UploadThing addresses only: with `crossorigin`, a host that sends no CORS headers
 * fails to load. First used by the costs page (S14.2).
 *
 * A failed load (offline, a removed file, a blocked host) shows a neutral box of the same size
 * and class instead of the browser's broken-image glyph: nothing moves, and an image with `alt`
 * text keeps it as the box's name. A new `src` tries again.
 */

export type RemoteImageProps = {
    src: string;
    /** Empty for a decorative image (a name next to it already says what it is). */
    alt: string;
    width: number;
    height: number;
    /** True for an image visible on first paint: it loads at once instead of lazily. */
    aboveFold?: boolean;
    className?: string;
};

export function RemoteImage({
    src,
    alt,
    width,
    height,
    aboveFold = false,
    className,
}: RemoteImageProps) {
    const [failedSrc, setFailedSrc] = useState<string | null>(null);
    if (failedSrc === src) {
        const label = alt === '' ? { 'aria-hidden': true } : { role: 'img', 'aria-label': alt };
        return (
            <span
                className={className ? `${styles.fallback} ${className}` : styles.fallback}
                style={{ inlineSize: width, blockSize: height }}
                data-image-failed=""
                {...label}
            />
        );
    }
    return (
        // React 18 sets a new element's attributes in prop order: crossorigin and loading come
        // before src, so no browser starts an eager or credentialed load before they are set.
        <img
            crossOrigin="anonymous"
            loading={aboveFold ? undefined : 'lazy'}
            width={width}
            height={height}
            alt={alt}
            className={className}
            src={src}
            onError={() => setFailedSrc(src)}
        />
    );
}
