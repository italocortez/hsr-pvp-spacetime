import { auctionSpend, teamCost } from '@shared/teambuilder';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INTRO_KEY } from '@/components/PageIntro/PageIntro';
import { CHARACTERS, characterCost, LIGHTCONES, lightconeCost, synergy } from '@/test/costFixtures';
import { MockConnection } from '@/test/mockConnection';
import { renderWithConnection } from '@/test/renderWithConnection';
import { overReasons } from './AuctionPanel';
import { ACTIVE_KEY, BROWSER_KEY } from './loadoutStorage';
import { KEPT_BIDS, OVER_DELAY_MS } from './TeamBuilderPage';
import { DRAFT_KEY, PREVIOUS_KEY } from './teamStorage';

const pause = (ms: number) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

/** Every text the page's status region shows from now on (fix pass, review S1). */
function recordStatus(): string[] {
    const seen: string[] = [];
    const region = status();
    new MutationObserver(() => seen.push(region.textContent ?? '')).observe(region, {
        childList: true,
        characterData: true,
        subtree: true,
    });
    return seen;
}

/*
 * T-S14.3b: the Cost Breakdown chart and the Auction simulator through the real router with the mock connection: the
 * chart's accessible text (columns, n/a, pairings stacked on the columns (A199), empty), the per-slot extra bid (hidden in Classic, typing, a blank
 * snapping back to 0, invalid text, the arrow step, the cap), the two budgets, the over-budget state and its
 * announcement, and the round trip of bids and budgets through browser storage and the `team=` link.
 */

let conn: MockConnection;
beforeEach(() => {
    conn = new MockConnection();
    try {
        localStorage.removeItem(INTRO_KEY);
        localStorage.removeItem(DRAFT_KEY);
        localStorage.removeItem(PREVIOUS_KEY);
        // S14.3c: the loadout keys (a team edit now also saves a browser loadout).
        localStorage.removeItem(BROWSER_KEY);
        localStorage.removeItem(ACTIVE_KEY);
    } catch {}
});
afterEach(() => {
    vi.restoreAllMocks();
});

// AS rows. Classic: Acheron E0 7, Clara 2, Pela 1 (4-star, starts at E6 = 7). Auction: Acheron E0 8, Pela 1; no Clara
// or Huohuo row in Auction, no Huohuo row in Classic. Rows step +1 per eidolon; cones +0.5 per superimposition.
function seed() {
    conn.db.hsrCharacter.seed(...CHARACTERS);
    conn.db.hsrLightcone.seed(...LIGHTCONES);
    conn.db.hsrCharacterCost.seed(
        characterCost('acheron', 7),
        characterCost('clara', 2),
        characterCost('pela', 1),
        characterCost('acheron', 8, { draft: 'Auction' }),
        characterCost('pela', 1, { draft: 'Auction' }),
    );
    conn.db.hsrLightconeCost.seed(
        lightconeCost('pastselfinmirror', 2.5),
        lightconeCost('pastselfinmirror', 3, { draft: 'Auction' }),
    );
    conn.db.hsrSynergyCost.seed(synergy('acheron', 'pela', 1.5));
}

async function open(path = '/teambuilder') {
    const r = renderWithConnection(path, conn, { ready: true });
    await screen.findByRole('heading', { level: 1 });
    seed();
    await act(async () => conn.applyAll());
    return r;
}

const settled = (r: Awaited<ReturnType<typeof open>>, path: string) =>
    waitFor(() => expect(r.router.state.resolvedLocation?.href).toBe(path));
const card = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name},`) });
const total = () => screen.getByText(/Total Cost/).closest('p') as HTMLElement;
const status = () => document.querySelector('p[role="status"]:last-of-type') as HTMLElement;
const chart = () => screen.getByRole('list', { name: /^Cost per character/ });
const columns = () =>
    within(chart())
        .getAllByRole('button')
        .map((b) => b.getAttribute('aria-label'));
const bid = (name: string) => screen.getByRole('textbox', { name: `Extra bid for ${name}` });
const budget = (name: 'Character Budget' | 'Light Cone Budget') =>
    screen.getByRole('textbox', { name });

describe('the cost chart', () => {
    it('empty team: "No characters selected" and no columns', async () => {
        await open();
        expect(screen.getByText('No characters selected')).toBeInTheDocument();
        expect(screen.queryByRole('list', { name: /^Cost per character/ })).toBeNull();
    });

    it('one column per character with every value as text; a pair split evenly on both columns (A199)', async () => {
        const user = userEvent.setup();
        await open();
        await user.click(card('Acheron'));
        expect(columns()).toEqual(['Acheron: total 7.0. Character 7.0, light cone none.']);
        const legend = () => chart().parentElement?.querySelector('ul[aria-hidden="true"]');
        expect(legend()).toHaveTextContent(/^Character$/);
        await user.click(card('Pela'));
        expect(chart()).toHaveAccessibleName('Cost per character, AS, Classic draft');
        // No column of its own: each column carries half of the pair, and the columns add up to the total.
        expect(columns()).toEqual([
            'Acheron: total 7.75. Character 7.0, light cone none, pairing with Pela 0.75 of 1.5.',
            'Pela: total 7.75. Character 7.0, light cone none, pairing with Acheron 0.75 of 1.5.',
        ]);
        expect(total()).toHaveTextContent('15.5');
        expect(legend()).toHaveTextContent(/^CharacterPairing$/);
    });

    it('a character without a cost row is n/a, counted as 0', async () => {
        const user = userEvent.setup();
        await open();
        await user.click(card('Huohuo'));
        expect(columns()).toEqual([
            'Huohuo: total 0.0. Character n/a, counted as 0, light cone none.',
        ]);
    });

    it('a light cone changes the column', async () => {
        const user = userEvent.setup();
        await open('/teambuilder?team=1.acheron-0-pastselfinmirror-1._._._.as-c-0-3000-1500');
        expect(columns()).toEqual(['Acheron: total 9.5. Character 7.0, light cone 2.5.']);
        await user.selectOptions(
            screen.getByRole('combobox', { name: 'Superimposition for Acheron' }),
            '3',
        );
        expect(columns()).toEqual(['Acheron: total 10.5. Character 7.0, light cone 3.5.']);
    });
});

describe('the Auction extra bid', () => {
    it('is not shown in Classic, and is under each filled card in Auction', async () => {
        const user = userEvent.setup();
        const r = await open();
        await user.click(card('Acheron'));
        expect(screen.queryByRole('textbox', { name: /Extra bid/ })).toBeNull();
        expect(screen.queryByRole('textbox', { name: 'Character Budget' })).toBeNull();
        await user.click(screen.getByRole('button', { name: 'Auction' }));
        await settled(r, '/teambuilder?draft=auction');
        expect(bid('Acheron')).toHaveValue('0');
        expect(bid('Acheron')).toHaveAttribute('inputmode', 'decimal');
        expect(screen.getAllByRole('textbox', { name: /Extra bid/ })).toHaveLength(1);
    });

    it('typing a bid adds it to the column and the total; a blank snaps back to 0', async () => {
        const user = userEvent.setup();
        await open('/teambuilder?team=1.acheron-0._._._.as-a-0-3000-1500');
        expect(total()).toHaveTextContent('8.0');
        await user.clear(bid('Acheron'));
        await user.type(bid('Acheron'), '2.5');
        expect(total()).toHaveTextContent('10.5');
        expect(columns()).toEqual([
            'Acheron: total 10.5. Character 8.0, light cone none, extra bid 2.5.',
        ]);
        await user.clear(bid('Acheron'));
        // While the field is blank the last amount stays; leaving it snaps back to 0.
        expect(total()).toHaveTextContent('10.5');
        await user.tab();
        expect(bid('Acheron')).toHaveValue('0');
        expect(total()).toHaveTextContent('8.0');
    });

    it('text that is not an amount marks the field invalid and changes nothing; Arrow keys step by 0.5', async () => {
        const user = userEvent.setup();
        await open('/teambuilder?team=1.acheron-0._._._.as-a-0-3000-1500');
        await user.clear(bid('Acheron'));
        await user.type(bid('Acheron'), 'abc');
        expect(bid('Acheron')).toHaveAttribute('aria-invalid', 'true');
        expect(total()).toHaveTextContent('8.0');
        await user.tab();
        expect(bid('Acheron')).toHaveValue('0');
        expect(bid('Acheron')).not.toHaveAttribute('aria-invalid');
        await user.click(bid('Acheron'));
        await user.keyboard('{ArrowUp}{ArrowUp}{ArrowUp}{ArrowDown}');
        expect(bid('Acheron')).toHaveValue('1');
        await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}');
        expect(bid('Acheron')).toHaveValue('0');
    });

    it('a bid above 99.99 is capped (the packed text limit)', async () => {
        const user = userEvent.setup();
        await open('/teambuilder?team=1.acheron-0._._._.as-a-0-3000-1500');
        await user.clear(bid('Acheron'));
        await user.type(bid('Acheron'), '500');
        await user.tab();
        expect(bid('Acheron')).toHaveValue('99.99');
    });
});

describe('the Auction budgets', () => {
    it('start at 30 and 15; the meters show what is left', async () => {
        const user = userEvent.setup();
        const r = await open();
        await user.click(card('Acheron'));
        await user.click(screen.getByRole('button', { name: 'Auction' }));
        await settled(r, '/teambuilder?draft=auction');
        expect(budget('Character Budget')).toHaveValue('30');
        expect(budget('Light Cone Budget')).toHaveValue('15');
        // Acheron at E0 in Auction: 8 of 30; 22 rolls over into the light cones (15 + 22).
        expect(screen.getByText('8.0 of 30.0')).toBeInTheDocument();
        expect(screen.getByText('0.0 of 37.0')).toBeInTheDocument();
    });

    it('going over is shown and announced; coming back is announced', async () => {
        const user = userEvent.setup();
        await open('/teambuilder?team=1.acheron-0._._._.as-a-0-3000-1500');
        expect(screen.queryByText('Over budget.')).toBeNull();
        await user.clear(budget('Character Budget'));
        await user.type(budget('Character Budget'), '5');
        const line =
            'The winning bids are 3.0 over the character budget. A lobby refuses a bid above the character budget left.';
        expect(screen.getByText('Over budget.').closest('p')).toHaveTextContent(line);
        expect(screen.getByText('Over by 3.0')).toBeInTheDocument();
        // Said once the over-budget state has held still for OVER_DELAY_MS (fix pass, review S1).
        await waitFor(() => expect(status()).toHaveTextContent(`Over budget. ${line}`), {
            timeout: 2000,
        });
        await user.clear(budget('Character Budget'));
        await user.type(budget('Character Budget'), '30');
        expect(screen.queryByText('Over budget.')).toBeNull();
        await waitFor(() => expect(status()).toHaveTextContent('Back within budget.'), {
            timeout: 2000,
        });
    });

    it('a team that opens over budget shows it without announcing it', async () => {
        await open('/teambuilder?team=1.acheron-0._._._.as-a-0-500-1500');
        expect(screen.getByText('Over budget.')).toBeInTheDocument();
        expect(status()).not.toHaveTextContent('Over budget');
        // Nor after the announcement delay (fix pass).
        await pause(OVER_DELAY_MS + 200);
        expect(status()).not.toHaveTextContent('Over budget');
    });

    it('light cones over the budget after the roll-over', async () => {
        await open('/teambuilder?team=1.acheron-0-pastselfinmirror-5._._._.as-a-0-800-100');
        // Winning 8 of 8, nothing rolls over; the cone at S5 costs 5 of 1.
        expect(screen.getByText('Over budget.').closest('p')).toHaveTextContent(
            'The light cones are 4.0 over the light cone budget.',
        );
    });
});

describe('bids and budgets in browser storage and the link', () => {
    it('are written to storage and come back on a reload', async () => {
        const user = userEvent.setup();
        const first = await open('/teambuilder?team=1.acheron-0._._._.as-a-0-3000-1500');
        await user.clear(bid('Acheron'));
        await user.type(bid('Acheron'), '2.25');
        await user.clear(budget('Character Budget'));
        await user.type(budget('Character Budget'), '42.5');
        await user.clear(budget('Light Cone Budget'));
        await user.type(budget('Light Cone Budget'), '12');
        await user.tab();
        expect(localStorage.getItem(DRAFT_KEY)).toBe('1.acheron-0-225._._._.as-a-0-4250-1200');
        first.unmount();
        await open('/teambuilder?draft=auction');
        expect(bid('Acheron')).toHaveValue('2.25');
        expect(budget('Character Budget')).toHaveValue('42.5');
        expect(budget('Light Cone Budget')).toHaveValue('12');
    });

    it('a team link carries them into the page and into storage unchanged', async () => {
        const CODE = '1.acheron-2-pastselfinmirror-1-150._.pela-6-999._.moc-a-0-4500-2000';
        const r = await open(`/teambuilder?team=${CODE}`);
        await settled(r, '/teambuilder?draft=auction&mode=moc');
        expect(bid('Acheron')).toHaveValue('1.5');
        expect(bid('Pela')).toHaveValue('9.99');
        expect(budget('Character Budget')).toHaveValue('45');
        expect(budget('Light Cone Budget')).toHaveValue('20');
        expect(localStorage.getItem(DRAFT_KEY)).toBe(CODE);
    });

    it('a bid of 0 writes nothing for the slot (one text per team)', async () => {
        const user = userEvent.setup();
        await open('/teambuilder?team=1.acheron-0-300._._._.as-a-0-3000-1500');
        await user.clear(bid('Acheron'));
        await user.type(bid('Acheron'), '0');
        await user.tab();
        expect(localStorage.getItem(DRAFT_KEY)).toBe('1.acheron-0._._._.as-a-0-3000-1500');
    });
});

/*
 * T-S14.3b-fix: the review's findings S1 (one announcement per change between over and within), S3 (an unreadable
 * entry keeps the last good amount; the forms a person types or pastes), S4 (the cap is said and shown), S6 (the line
 * and the meter agree and name their parts), M7 (bids kept in Classic are said).
 */
describe('fix pass: announcements (S1)', () => {
    it('typing a multi-digit bid that goes over announces once, with the final amounts', async () => {
        const user = userEvent.setup();
        await open('/teambuilder?team=1.acheron-0._._._.as-a-0-3000-1500');
        const seen = recordStatus();
        await user.clear(bid('Acheron'));
        await user.type(bid('Acheron'), '45.75');
        await pause(OVER_DELAY_MS + 300);
        const over = seen.filter((t) => t.includes('Over budget'));
        expect(over).toHaveLength(1);
        // Acheron E0 8 + 45.75 = 53.75 against 30.
        expect(over[0]).toContain('The winning bids are 23.75 over the character budget.');
    });

    it('changing the amount while over announces nothing more; coming back announces once', async () => {
        const user = userEvent.setup();
        await open('/teambuilder?team=1.acheron-0._._._.as-a-0-500-1500');
        const seen = recordStatus();
        await user.clear(budget('Character Budget'));
        await user.type(budget('Character Budget'), '6');
        await pause(OVER_DELAY_MS + 300);
        expect(seen.filter((t) => t.includes('Over budget'))).toHaveLength(0);
        await user.clear(budget('Character Budget'));
        await user.type(budget('Character Budget'), '25');
        await pause(OVER_DELAY_MS + 300);
        expect(seen.filter((t) => t.includes('Back within budget.'))).toHaveLength(1);
        expect(seen.filter((t) => t.includes('Over budget'))).toHaveLength(0);
    });
});

describe('fix pass: the amount fields (S3, S4)', () => {
    it('an unreadable entry after a good amount keeps the amount and says so', async () => {
        const user = userEvent.setup();
        await open('/teambuilder?team=1.acheron-0._._._.as-a-0-3000-1500');
        await user.clear(bid('Acheron'));
        await user.type(bid('Acheron'), '2.5');
        await user.tab();
        // A stray letter at the end of the good amount.
        await user.type(bid('Acheron'), 'x');
        expect(bid('Acheron')).toHaveAttribute('aria-invalid', 'true');
        expect(bid('Acheron')).toHaveAccessibleDescription(
            'Not an amount. Type a number such as 2.5.',
        );
        expect(total()).toHaveTextContent('10.5');
        await user.tab();
        expect(bid('Acheron')).toHaveValue('2.5');
        expect(bid('Acheron')).not.toHaveAttribute('aria-invalid');
        expect(bid('Acheron')).toHaveAccessibleDescription('Not read. Kept 2.5.');
        expect(total()).toHaveTextContent('10.5');
        await waitFor(() => expect(status()).toHaveTextContent('Not read. Kept 2.5.'));
    });

    it.each([
        ['$5.00', '5'],
        ['2,5', '2.5'],
        ['2,25', '2.25'],
        ['  3 ', '3'],
        ['4 €', '4'],
        ['1.005', '1.01'],
    ])('%j is read and shows as %j', async (typed, shown) => {
        const user = userEvent.setup();
        await open('/teambuilder?team=1.acheron-0._._._.as-a-0-3000-1500');
        await user.clear(bid('Acheron'));
        await user.type(bid('Acheron'), typed);
        expect(bid('Acheron')).not.toHaveAttribute('aria-invalid');
        await user.tab();
        expect(bid('Acheron')).toHaveValue(shown);
    });

    it.each([
        ['1,000', 'Unclear: type it without the comma, or use a dot for decimals.'],
        ['1e2', 'Not an amount. Type a number such as 2.5.'],
        ['-1', 'Not an amount. Type a number such as 2.5.'],
    ])('%j is refused visibly and keeps the last amount', async (typed, said) => {
        const user = userEvent.setup();
        await open('/teambuilder?team=1.acheron-0-300._._._.as-a-0-3000-1500');
        await user.clear(bid('Acheron'));
        await user.type(bid('Acheron'), typed);
        expect(bid('Acheron')).toHaveAttribute('aria-invalid', 'true');
        expect(bid('Acheron')).toHaveAccessibleDescription(said);
        await user.tab();
        expect(bid('Acheron')).toHaveValue('3');
    });

    it('an amount above the cap is said while typed, stored as the cap, and shown as it after leaving', async () => {
        const user = userEvent.setup();
        await open('/teambuilder?team=1.acheron-0._._._.as-a-0-3000-1500');
        expect(bid('Acheron')).toHaveAttribute('maxlength', '7');
        expect(budget('Character Budget')).toHaveAttribute('maxlength', '11');
        await user.clear(bid('Acheron'));
        await user.type(bid('Acheron'), '150');
        expect(bid('Acheron')).toHaveValue('150');
        expect(bid('Acheron')).toHaveAttribute('aria-invalid', 'true');
        expect(bid('Acheron')).toHaveAccessibleDescription('At most 99.99.');
        // The cap is stored at once: the column carries it.
        expect(columns()[0]).toContain('extra bid 99.99.');
        await user.tab();
        expect(bid('Acheron')).toHaveValue('99.99');
        expect(bid('Acheron')).not.toHaveAttribute('aria-invalid');
        expect(bid('Acheron')).toHaveAccessibleDescription('At most 99.99. Set to 99.99.');
    });
});

describe('fix pass: over-budget figures (S6) and bids kept in Classic (M7)', () => {
    const ROWS: Record<string, number[]> = {
        a: [8, 9, 10, 11, 12, 13, 14],
        b: [1, 2, 3, 4, 5, 6, 7],
    };
    const source = {
        character: (n: string) => ROWS[n],
        lightcone: (n: string) => (n === 'x' ? [3, 3.5, 4, 4.5, 5] : undefined),
        synergies: () => [{ characterA: 'a', characterB: 'b', costModifier: 2 }],
    };
    const slots = [
        { character: 'a', eidolon: 0, lightcone: 'x', superimposition: 1 },
        { character: 'b', eidolon: 0, lightcone: null, superimposition: 1 },
        null,
        null,
    ] as const;

    it('cones over with pairings: the line names both parts and ends on the meter figure', () => {
        // Winning 9 of 9; cones 3 against 1 (2 over); pairings 2: 4 over in all.
        const s = auctionSpend(slots as never, teamCost(slots as never, 'auction', source), {
            character: 900,
            lightcone: 100,
        });
        expect(s.left).toBe(-400);
        expect(overReasons(s).map((r) => r.text)).toEqual([
            'The light cones are 2.0 over the light cone budget; with the pairings (2.0) it is 4.0 over.',
        ]);
    });

    it('pairings alone over: the line gives the same figure as the meter', () => {
        // Cones 3 against 4: 1 left; pairings 2: 1 over.
        const s = auctionSpend(slots as never, teamCost(slots as never, 'auction', source), {
            character: 900,
            lightcone: 400,
        });
        expect(s.left).toBe(-100);
        expect(overReasons(s).map((r) => r.text)).toEqual([
            'The pairings (2.0) are 1.0 over the 1.0 left after the light cones. A lobby asks for another lineup.',
        ]);
    });

    it('in the page, the meter and the line show the same figure', async () => {
        await open('/teambuilder?team=1.acheron-0-pastselfinmirror-1.pela-6._._.as-a-0-1500-100');
        conn.db.hsrSynergyCost.seed(synergy('acheron', 'pela', 2, { draft: 'Auction' }));
        await act(async () => conn.applyAll());
        expect(screen.getByText('Over by 4.0')).toBeInTheDocument();
        expect(screen.getByText('Over budget.').closest('p')).toHaveTextContent(
            'The light cones are 2.0 over the light cone budget; with the pairings (2.0) it is 4.0 over.',
        );
    });

    it('the light cone meter shows pairings only when the cost set prices them in Auction', async () => {
        await open('/teambuilder?team=1.acheron-0.pela-6._._.as-a-0-3000-1500');
        const panel = () => screen.getByRole('region', { name: 'Auction budgets' });
        // The fixture's only pair is priced in Classic: 0 in Auction, so no legend entry and no iris slice.
        expect(panel().querySelector('[data-dot="pair"]')).toBeNull();
        expect(panel()).not.toHaveTextContent(/Pairings\s*0/);
        conn.db.hsrSynergyCost.seed(synergy('acheron', 'pela', 2, { draft: 'Auction' }));
        await act(async () => conn.applyAll());
        expect(panel().querySelector('[data-dot="pair"]')).not.toBeNull();
        expect(panel()).toHaveTextContent('Pairings 2.0');
    });

    it('Classic says the Auction bids are kept while the team holds any', async () => {
        const user = userEvent.setup();
        const r = await open('/teambuilder?team=1.acheron-0-300._._._.as-a-0-3000-1500');
        expect(screen.queryByText(KEPT_BIDS)).toBeNull();
        await user.click(screen.getByRole('button', { name: 'Classic' }));
        await settled(r, '/teambuilder');
        expect(screen.getByText(KEPT_BIDS)).toBeInTheDocument();
    });
});
