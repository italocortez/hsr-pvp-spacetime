import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { FilterChips } from './FilterChips';

/* T-COSTS: the shared multi-choice filter chip set. */

function Chips() {
    const [selected, setSelected] = useState<string[]>([]);
    return (
        <FilterChips
            label="Filter by element"
            options={[
                { value: 'fire', label: 'Fire', icon: '/elements/fire.webp' },
                { value: 'ice', label: 'Ice', icon: '/elements/ice.webp' },
                { value: 'dps', label: 'DPS' },
            ]}
            selected={selected}
            onToggle={(v) =>
                setSelected((s) => (s.includes(v) ? s.filter((x) => x !== v) : [...s, v]))
            }
        />
    );
}

describe('FilterChips', () => {
    it('a named group of toggle buttons; any number on', async () => {
        const user = userEvent.setup();
        render(<Chips />);
        expect(screen.getByRole('group', { name: 'Filter by element' })).toBeInTheDocument();
        const fire = screen.getByRole('button', { name: 'Fire' });
        const ice = screen.getByRole('button', { name: 'Ice' });
        await user.click(fire);
        await user.click(ice);
        expect(fire).toHaveAttribute('aria-pressed', 'true');
        expect(ice).toHaveAttribute('aria-pressed', 'true');
        await user.click(fire);
        expect(fire).toHaveAttribute('aria-pressed', 'false');
    });

    it('an icon chip is named by its label (and its tooltip); the image is decorative', () => {
        render(<Chips />);
        const fire = screen.getByRole('button', { name: 'Fire' });
        expect(fire).toHaveAttribute('title', 'Fire');
        const img = fire.querySelector('img');
        expect(img).toHaveAttribute('alt', '');
        expect(img).toHaveAttribute('width', '18');
    });

    it('a text chip shows its label and toggles from the keyboard', async () => {
        const user = userEvent.setup();
        render(<Chips />);
        const dps = screen.getByRole('button', { name: 'DPS' });
        dps.focus();
        await user.keyboard('{Enter}');
        expect(dps).toHaveAttribute('aria-pressed', 'true');
    });
});
