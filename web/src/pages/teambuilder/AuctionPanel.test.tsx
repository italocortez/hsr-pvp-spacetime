import type { AuctionSpend } from '@shared/teambuilder';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OPEN_DELAY_MS } from '@/components/InfoPopover/InfoPopover';
import { AuctionPanel } from './AuctionPanel';

/*
 * T-S14.3i: the Auction meters' two info buttons are the shared info popover (quiet tone, the circled "!", the
 * mockup's heading, text and foot line), with the old toggletip's keyboard behaviour: focus opens, Escape closes and
 * keeps focus, Tab moving on closes, a press elsewhere closes; one open at a time.
 */

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const spend: AuctionSpend = {
    budgets: { character: 3000, lightcone: 1500 },
    winning: 0,
    bids: 0,
    eidolons: 0,
    eidolonsFromCharacter: 0,
    eidolonsFromLightcone: 0,
    characterSpent: 0,
    characterLeft: 3000,
    rollover: 0,
    cones: 0,
    lightconeAvailable: 1500,
    lightconeSpent: 0,
    pairings: 0,
    left: 1500,
    over: { character: false, lightcone: false, pairings: false },
    overBudget: false,
};

const renderPanel = () =>
    render(<AuctionPanel spend={spend} budgets={spend.budgets} onBudget={() => {}} />);
const char = () => screen.getByRole('button', { name: 'How the character budget works' });
const cone = () => screen.getByRole('button', { name: 'How the light cone budget works' });
const panelOf = (b: HTMLElement) => b.nextElementSibling as HTMLElement;

describe('Auction panel: the info popovers (S14.3i)', () => {
    it('two quiet toggletips with the circled "!", closed, their tooltip right after them', () => {
        renderPanel();
        for (const b of [char(), cone()]) {
            expect(b).toHaveAttribute('data-tone', 'quiet');
            expect(b).toHaveAttribute('aria-expanded', 'false');
            expect(b.querySelector('svg circle')).not.toBeNull();
            expect(panelOf(b)).toHaveAttribute('role', 'tooltip');
            expect(panelOf(b)).toHaveAttribute('data-form', 'panel');
        }
    });

    it('a click shows the heading, the text and the foot line; a press elsewhere closes it', () => {
        renderPanel();
        fireEvent.click(char());
        const p = panelOf(char());
        expect(p.firstElementChild?.textContent).toBe('Character Budget');
        expect(p.textContent).toContain('winning bid');
        expect(p.lastElementChild?.textContent).toBe(
            'What is left when the draft ends rolls into the Light Cone budget.',
        );
        fireEvent.pointerDown(document.body);
        expect(char()).toHaveAttribute('aria-expanded', 'false');
    });

    it('keyboard: focus opens, Escape closes and keeps focus, Tab moving on closes', () => {
        renderPanel();
        act(() => char().focus());
        act(() => vi.advanceTimersByTime(OPEN_DELAY_MS));
        expect(char()).toHaveAttribute('aria-expanded', 'true');
        fireEvent.keyDown(char(), { key: 'Escape' });
        expect(char()).toHaveAttribute('aria-expanded', 'false');
        expect(char()).toHaveFocus();
        fireEvent.click(char());
        expect(char()).toHaveAttribute('aria-expanded', 'true');
        act(() => cone().focus());
        expect(char()).toHaveAttribute('aria-expanded', 'false');
    });

    it('one open at a time', () => {
        renderPanel();
        fireEvent.click(char());
        fireEvent.click(cone());
        expect(char()).toHaveAttribute('aria-expanded', 'false');
        expect(cone()).toHaveAttribute('aria-expanded', 'true');
        expect(panelOf(cone()).firstElementChild?.textContent).toBe('Light Cone Budget');
    });
});
