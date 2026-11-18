import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef, useState } from 'react';
import { describe, expect, it } from 'vitest';
import { MagnifierIcon, SearchField } from './SearchField';

/* T-COSTS: the shared search field. */

function Field() {
    const [value, setValue] = useState('');
    return (
        <>
            <SearchField
                label="Search"
                value={value}
                onChange={setValue}
                placeholder="Search by name or alias"
                maxLength={5}
            />
            <output>{value}</output>
        </>
    );
}

describe('SearchField', () => {
    it('a search input named by its label, with text correction off', () => {
        render(<Field />);
        const input = screen.getByRole('searchbox', { name: 'Search' });
        expect(input).toHaveAttribute('type', 'search');
        expect(input).toHaveAttribute('autocomplete', 'off');
        expect(input).toHaveAttribute('spellcheck', 'false');
        expect(input).toHaveAttribute('placeholder', 'Search by name or alias');
        // S14.4c-fix: no password manager takes it.
        expect(input).toHaveAttribute('data-1p-ignore', '');
        expect(input).toHaveAttribute('data-lpignore', 'true');
        expect(input).toHaveAttribute('data-bwignore', '');
        expect(input).toHaveAttribute('data-form-type', 'other');
    });

    it('reports what is typed, up to the maximum length; markup stays text', async () => {
        const user = userEvent.setup();
        render(<Field />);
        await user.type(screen.getByRole('searchbox'), '<b>xyz');
        expect(screen.getByRole('searchbox')).toHaveValue('<b>xy');
        expect(screen.getByRole('status')).toHaveTextContent('<b>xy');
        expect(document.querySelector('output b')).toBeNull();
    });

    it('inputRef reaches the input, so a caller can move focus to it', () => {
        const ref = createRef<HTMLInputElement>();
        render(<SearchField label="Search" value="" onChange={() => {}} inputRef={ref} />);
        expect(ref.current).toBe(screen.getByRole('searchbox', { name: 'Search' }));
    });

    it('the magnifier is decoration; with minus it is the "no results" mark', () => {
        const { container } = render(<MagnifierIcon minus />);
        const svg = container.querySelector('svg') as SVGElement;
        expect(svg).toHaveAttribute('aria-hidden', 'true');
        expect(svg.querySelectorAll('path')).toHaveLength(2);
    });
});
