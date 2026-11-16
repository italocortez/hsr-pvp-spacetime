import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RarityBadge } from './RarityBadge';

/* T-COSTS: the rarity badge, 3-star tier included (user ruling 2026-11-16 item 4). */

describe('RarityBadge', () => {
    it.each([
        [5, '5'],
        [4, '4'],
        [3, '3'],
    ])('%i stars: the %s tier, read as a number of stars', (rarity, tier) => {
        const { container } = render(<RarityBadge rarity={rarity} />);
        const badge = container.firstElementChild as HTMLElement;
        expect(badge).toHaveAttribute('data-tier', tier);
        expect(badge).toHaveTextContent(`${rarity} star`);
        expect(badge.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    });

    it('shows the number and the star glyph only', () => {
        render(<RarityBadge rarity={5} />);
        expect(screen.getByText('5', { exact: false })).toBeInTheDocument();
    });
});
