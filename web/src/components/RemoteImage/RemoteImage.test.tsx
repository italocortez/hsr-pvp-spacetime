import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RemoteImage } from './RemoteImage';

/* T-M10: the UploadThing image rule (docs/frontend/pages.md) is built into the component. */

const SRC = 'https://zmvtaeh9bl.ufs.sh/f/key';

describe('T-M10 RemoteImage', () => {
    it('renders a CORS image with its size, lazily by default', () => {
        render(<RemoteImage src={SRC} alt="Acheron" width={96} height={96} />);
        const img = screen.getByRole('img', { name: 'Acheron' });
        expect(img).toHaveAttribute('src', SRC);
        expect(img).toHaveAttribute('crossorigin', 'anonymous');
        expect(img).toHaveAttribute('width', '96');
        expect(img).toHaveAttribute('height', '96');
        expect(img).toHaveAttribute('loading', 'lazy');
    });

    it('crossorigin and loading are set before src (attribute order as React set them)', () => {
        render(<RemoteImage src={SRC} alt="Acheron" width={96} height={96} />);
        const names = screen.getByRole('img', { name: 'Acheron' }).getAttributeNames();
        expect(names.indexOf('crossorigin')).toBeGreaterThanOrEqual(0);
        expect(names.indexOf('crossorigin')).toBeLessThan(names.indexOf('src'));
        expect(names.indexOf('loading')).toBeGreaterThanOrEqual(0);
        expect(names.indexOf('loading')).toBeLessThan(names.indexOf('src'));
        expect(names.at(-1)).toBe('src');
    });

    it('a failed load (error event) becomes a neutral box of the same size and class', () => {
        const { container, rerender } = render(
            <RemoteImage src={SRC} alt="" width={34} height={34} className="portrait" />,
        );
        fireEvent.error(container.querySelector('img') as HTMLImageElement);
        expect(container.querySelector('img')).toBeNull();
        const box = container.querySelector('[data-image-failed]') as HTMLElement;
        expect(box.tagName).toBe('SPAN');
        expect(box).toHaveClass('portrait');
        expect(box).toHaveAttribute('aria-hidden', 'true');
        expect(box.style.inlineSize).toBe('34px');
        expect(box.style.blockSize).toBe('34px');
        // A new address tries again.
        rerender(
            <RemoteImage src={`${SRC}2`} alt="" width={34} height={34} className="portrait" />,
        );
        expect(container.querySelector('img')).toHaveAttribute('src', `${SRC}2`);
    });

    it("a failed image with alt text keeps it as the box's name", () => {
        render(<RemoteImage src={SRC} alt="Acheron" width={96} height={96} />);
        fireEvent.error(screen.getByRole('img', { name: 'Acheron' }));
        const box = screen.getByRole('img', { name: 'Acheron' });
        expect(box.tagName).toBe('SPAN');
    });

    it('an image above the fold loads at once (no loading attribute)', () => {
        render(<RemoteImage src={SRC} alt="Acheron" width={96} height={96} aboveFold />);
        const img = screen.getByRole('img', { name: 'Acheron' });
        expect(img).not.toHaveAttribute('loading');
        expect(img).toHaveAttribute('crossorigin', 'anonymous');
    });
});
