import type { Archetype, HsrCharacterArchetype } from '@bindings/types';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { costQueryList } from '@/stdb/costQueries';
import { DEFAULT_COST_QUERIES, REFERENCE_QUERIES } from '@/stdb/referenceSet';
import {
    CHARACTERS,
    characterCost,
    costSet,
    LIGHTCONES,
    lightconeCost,
    synergy,
} from '@/test/costFixtures';
import { MockConnection } from '@/test/mockConnection';
import { renderWithConnection } from '@/test/renderWithConnection';
import { INTRO_KEY } from './CostsIntro';

/*
 * T-COSTS: the costs page through the real router and app shell with the mock connection: the
 * one h1, the tabs, every control writing the address, a shared address, history, the table's
 * semantics, the states, the cost sets, and user text staying text.
 */

let conn: MockConnection;
beforeEach(() => {
    conn = new MockConnection();
    try {
        localStorage.removeItem(INTRO_KEY);
    } catch {}
});
afterEach(() => {
    vi.restoreAllMocks();
});

const VISITOR = { ready: true } as const;

function seed() {
    conn.db.hsrCharacter.seed(...CHARACTERS);
    conn.db.hsrLightcone.seed(...LIGHTCONES);
    conn.db.hsrCharacterCost.seed(
        characterCost('acheron', 7),
        characterCost('clara', 2),
        characterCost('pela', 1),
        // huohuo has no row in AS Classic: n/a
        characterCost('acheron', 4, { mode: 'MemoryOfChaos' }),
        characterCost('acheron', 8, { draft: 'Auction' }),
    );
    conn.db.hsrLightconeCost.seed(
        lightconeCost('pastselfinmirror', 2.5),
        lightconeCost('meshingcogs', 0.5),
        lightconeCost('nowheretorun', 1),
    );
    conn.db.hsrSynergyCost.seed(synergy('acheron', 'pela', 1.5), synergy('clara', 'huohuo', -1));
    conn.db.viewPublishedCostSets.seed(
        costSet(3, 'Yuji Tournament', { mode: 'ApocalypticShadow' }),
        costSet(4, 'Old Cup', { mode: 'ApocalypticShadow', locked: true }),
        costSet(5, 'Chaos League', { mode: 'MemoryOfChaos' }),
    );
}

async function open(path = '/costs', { apply = true } = {}) {
    const r = renderWithConnection(path, conn, VISITOR);
    await screen.findByRole('heading', { level: 1 });
    if (apply) {
        seed();
        await act(async () => conn.applyAll());
    }
    return r;
}

const table = () => screen.getByRole('table');
const bodyRows = () => within(table()).getAllByRole('row').slice(1);
const rowNames = () =>
    within(table())
        .queryAllByRole('rowheader')
        .map((h) => h.textContent?.replace(/\u25C6.*$/, '').trim());
const href = (r: Awaited<ReturnType<typeof open>>) => r.router.state.location.href;
const settled = (r: Awaited<ReturnType<typeof open>>, path: string, timeout?: number) =>
    waitFor(() => expect(r.router.state.resolvedLocation?.href).toBe(path), { timeout });
/** For the long multi-step test: a wait that does not lean on the 1 s default under load. */
const SLOW = 3000;

describe('the page and its heading', () => {
    it('renders in the shell with one h1, the intro headline, and the page title', async () => {
        await open();
        expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
        expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
            'The cost of every pick.',
        );
        expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument();
        await waitFor(() => expect(document.title).toBe('Cost Tables \u2014 IPC Battlegrounds'));
    });

    it('hiding the intro keeps one h1 (the slim label), remembered under hsr_intro_hidden', async () => {
        const user = userEvent.setup();
        await open();
        await user.click(screen.getByRole('button', { name: 'Hide intro' }));
        expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
        expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Cost Tables');
        expect(screen.getByRole('button', { name: 'Show intro' })).toHaveAttribute(
            'aria-expanded',
            'false',
        );
        expect(localStorage.getItem(INTRO_KEY)).toBe('1');
    });

    it('starts collapsed when storage says so; a storage that throws shows the intro', async () => {
        localStorage.setItem(INTRO_KEY, '1');
        const { unmount } = await open();
        expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Cost Tables');
        unmount();
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
            throw new Error('blocked');
        });
        await open();
        expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
            'The cost of every pick.',
        );
    });
});

describe('subscriptions', () => {
    it('/costs subscribes the base reference set and the default cost set only', async () => {
        await open();
        const live = conn.liveQueries();
        for (const q of [...REFERENCE_QUERIES, ...DEFAULT_COST_QUERIES]) expect(live).toContain(q);
        expect(live).toHaveLength(2 + REFERENCE_QUERIES.length + DEFAULT_COST_QUERIES.length);
    });
});

describe('the table', () => {
    it('loading: a busy table with placeholder rows and no count until the data applies', async () => {
        await open('/costs', { apply: false });
        expect(table()).toHaveAttribute('aria-busy', 'true');
        expect(screen.getByText('Loading')).toBeInTheDocument();
        expect(within(table()).queryAllByRole('rowheader')).toHaveLength(0);
        seed();
        await act(async () => conn.applyAll());
        expect(table()).not.toHaveAttribute('aria-busy');
        expect(screen.getByText('units listed', { exact: false })).toHaveTextContent(
            '4 units listed',
        );
    });

    it('rows by name, costs from the rows, n/a for a missing row (sorted last on a cost)', async () => {
        const user = userEvent.setup();
        const r = await open();
        expect(rowNames()).toEqual(['Acheron', 'Clara', 'Huohuo', 'Pela']);
        const huohuo = bodyRows().find((row) => row.textContent?.includes('Huohuo')) as HTMLElement;
        expect(within(huohuo).getAllByText('n/a')).toHaveLength(7);
        await user.click(screen.getByRole('button', { name: 'E3' }));
        await settled(r, '/costs?dir=desc&sort=e3');
        expect(rowNames()).toEqual(['Acheron', 'Clara', 'Pela', 'Huohuo']);
    });

    it('sortable headers: buttons in th, aria-sort on the sorted column only, the caption', async () => {
        const user = userEvent.setup();
        const r = await open();
        const nameHeader = screen.getByRole('columnheader', { name: 'Character' });
        expect(nameHeader).toHaveAttribute('aria-sort', 'ascending');
        expect(screen.getByRole('columnheader', { name: 'E0' })).not.toHaveAttribute('aria-sort');
        await user.click(within(nameHeader).getByRole('button'));
        await settled(r, '/costs?dir=desc');
        expect(nameHeader).toHaveAttribute('aria-sort', 'descending');
        expect(rowNames()[0]).toBe('Pela');
        expect(table()).toHaveAccessibleName(
            'Character draft costs \u2014 Default cost set, Apocalyptic Shadow, Classic draft. 4 rows. Use the column headers to sort.',
        );
        const headers = screen.getAllByRole('columnheader');
        expect(headers.filter((h) => h.hasAttribute('aria-sort'))).toHaveLength(1);
    });

    it('the count has a singular', async () => {
        await open('/costs?q=pela');
        expect(screen.getByText('unit listed', { exact: false })).toHaveTextContent(
            '1 unit listed',
        );
    });

    it('the synergy expander: aria-expanded, aria-controls, a pair under both, the minus sign', async () => {
        const user = userEvent.setup();
        await open();
        const button = screen.getByRole('button', { name: 'Synergies for Clara' });
        expect(button).toHaveAttribute('aria-expanded', 'false');
        await user.click(button);
        expect(button).toHaveAttribute('aria-expanded', 'true');
        const ids = (button.getAttribute('aria-controls') ?? '').split(' ');
        expect(ids).toHaveLength(2);
        for (const id of ids) expect(document.getElementById(id)).not.toBeNull();
        expect(screen.getByText('\u22121')).toBeInTheDocument();
        // The pair also shows under Huohuo.
        expect(screen.getByRole('button', { name: 'Synergies for Huohuo' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Synergies for Pela' })).toBeInTheDocument();
    });
});

describe('controls write the address and the table follows', () => {
    it('the tabs by keyboard: arrows move focus, Enter selects, the panel is labelled by the tab', async () => {
        const user = userEvent.setup();
        const r = await open();
        const chars = screen.getByRole('tab', { name: 'Characters' });
        const lcs = screen.getByRole('tab', { name: 'Light Cones' });
        expect(chars).toHaveAttribute('aria-selected', 'true');
        expect(lcs).toHaveAttribute('tabindex', '-1');
        expect(screen.getByRole('tabpanel')).toHaveAccessibleName('Characters');
        act(() => chars.focus());
        await user.keyboard('{ArrowRight}');
        expect(lcs).toHaveFocus();
        expect(chars).toHaveAttribute('aria-selected', 'true');
        await user.keyboard('{Enter}');
        await settled(r, '/costs?tab=lightcones');
        expect(lcs).toHaveAttribute('aria-selected', 'true');
        expect(screen.getByRole('tabpanel')).toHaveAccessibleName('Light Cones');
        expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Light Cone Costs');
        expect(screen.getByText('light cones listed', { exact: false })).toHaveTextContent(
            '3 light cones listed',
        );
        await user.keyboard('{Home}');
        expect(chars).toHaveFocus();
    });

    it('draft mode, game mode, chips and search each update the address and the table', async () => {
        const user = userEvent.setup();
        const r = await open();
        await user.click(screen.getByRole('button', { name: 'Auction' }));
        await settled(r, '/costs?draft=auction', SLOW);
        expect(screen.getByRole('button', { name: 'Auction' })).toHaveAttribute(
            'aria-pressed',
            'true',
        );
        const acheron = () =>
            bodyRows().find((row) => row.textContent?.includes('Acheron')) as HTMLElement;
        expect(within(acheron()).getAllByRole('cell')[1]).toHaveTextContent('8');

        await user.click(screen.getByRole('button', { name: 'Memory of Chaos' }));
        await settled(r, '/costs?draft=auction&mode=moc', SLOW);
        await user.click(screen.getByRole('button', { name: 'Classic' }));
        await settled(r, '/costs?mode=moc', SLOW);
        expect(within(acheron()).getAllByRole('cell')[1]).toHaveTextContent('4');

        await user.click(screen.getByRole('button', { name: 'Ice' }));
        await settled(r, '/costs?el=ice&mode=moc', SLOW);
        expect(screen.getByRole('button', { name: 'Ice' })).toHaveAttribute('aria-pressed', 'true');
        expect(rowNames()).toEqual(['Pela']);

        await user.type(screen.getByRole('searchbox', { name: 'Search' }), 'zz');
        await settled(r, '/costs?el=ice&mode=moc&q=zz', SLOW);
        expect(
            await screen.findByText('No characters match these filters.', {}, { timeout: SLOW }),
        ).toBeInTheDocument();
    });

    it('a shared address reproduces the view', async () => {
        await open('/costs?tab=lightcones&rarity=3&sort=s1&dir=desc');
        expect(screen.getByRole('tab', { name: 'Light Cones' })).toHaveAttribute(
            'aria-selected',
            'true',
        );
        expect(screen.getByRole('button', { name: '3\u2605' })).toHaveAttribute(
            'aria-pressed',
            'true',
        );
        expect(rowNames()).toEqual(['Meshing Cogs']);
        expect(screen.getByRole('columnheader', { name: 'S1' })).toHaveAttribute(
            'aria-sort',
            'descending',
        );
    });

    it('back and forward restore the view', async () => {
        const user = userEvent.setup();
        const r = await open();
        await user.click(screen.getByRole('button', { name: 'Fire' }));
        await settled(r, '/costs?el=fire');
        await user.click(screen.getByRole('button', { name: 'Auction' }));
        await settled(r, '/costs?draft=auction&el=fire');
        act(() => r.router.history.back());
        await settled(r, '/costs?el=fire');
        expect(screen.getByRole('button', { name: 'Auction' })).toHaveAttribute(
            'aria-pressed',
            'false',
        );
        act(() => r.router.history.back());
        await settled(r, '/costs');
        expect(screen.getByRole('button', { name: 'Fire' })).toHaveAttribute(
            'aria-pressed',
            'false',
        );
        act(() => r.router.history.forward());
        await settled(r, '/costs?el=fire');
        expect(screen.getByRole('button', { name: 'Fire' })).toHaveAttribute(
            'aria-pressed',
            'true',
        );
    });

    it('switching to Light Cones clears the element and role filters; each tab keeps its sort', async () => {
        const user = userEvent.setup();
        const r = await open('/costs?el=fire&role=dps&path=destruction&sort=e2&dir=desc');
        await user.click(screen.getByRole('tab', { name: 'Light Cones' }));
        await settled(r, '/costs?path=destruction&tab=lightcones');
        expect(screen.queryByRole('group', { name: 'Filter by element' })).toBeNull();
        expect(screen.queryByRole('group', { name: 'Filter by role' })).toBeNull();
        await user.click(screen.getByRole('tab', { name: 'Characters' }));
        await settled(r, '/costs?dir=desc&path=destruction&sort=e2');
    });

    it('"Clear N" counts the search; it and the empty state\'s "Clear filters" clear everything', async () => {
        const user = userEvent.setup();
        const r = await open('/costs?el=fire&q=zz');
        expect(screen.getByRole('button', { name: 'Clear 2 filters' })).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Clear filters' }));
        await settled(r, '/costs');
        expect(screen.queryByRole('button', { name: /^Clear \d/ })).toBeNull();
        expect(rowNames()).toHaveLength(4);
        expect(screen.getByRole('searchbox', { name: 'Search' })).toHaveValue('');
    });

    it('aliases are searchable, the joke ones too', async () => {
        await open('/costs?q=feet');
        expect(rowNames()).toEqual(['Clara']);
    });

    it('the count is announced once, after typing settles', async () => {
        const user = userEvent.setup();
        await open();
        const status = screen.getByRole('status');
        expect(status).toHaveTextContent('');
        await user.type(screen.getByRole('searchbox', { name: 'Search' }), 'pel');
        await waitFor(() => expect(status).toHaveTextContent('1 unit listed.'), { timeout: 2000 });
    });
});

describe('cost sets', () => {
    it('lists Default first, then the published sets of the game mode, locked ones marked', async () => {
        await open();
        const select = screen.getByRole('combobox', { name: 'Cost Set' });
        const options = within(select).getAllByRole('option');
        expect(options.map((o) => o.textContent)).toEqual([
            'Default',
            'Old Cup (locked)',
            'Yuji Tournament',
        ]);
        expect(select).toHaveValue('0');
    });

    it('picking a custom set subscribes it, fixes the game mode, and disables the others with a reason', async () => {
        const user = userEvent.setup();
        const r = await open('/costs?mode=moc');
        await user.selectOptions(screen.getByRole('combobox', { name: 'Cost Set' }), '5');
        await settled(r, '/costs?mode=moc&set=5');
        expect(conn.liveQueries()).toEqual(expect.arrayContaining(costQueryList(5)));
        expect(table()).toHaveAttribute('aria-busy', 'true');
        conn.db.hsrCharacterCost.seed(
            characterCost('clara', 11, { set: 5, mode: 'MemoryOfChaos' }),
        );
        await act(async () => conn.applyAll());
        expect(within(bodyRows()[1] as HTMLElement).getAllByRole('cell')[1]).toHaveTextContent(
            '11',
        );
        const as = screen.getByRole('button', { name: 'Apocalyptic Shadow' });
        expect(as).toHaveAttribute('aria-disabled', 'true');
        expect(as).toHaveAccessibleDescription(/Chaos League is for Memory of Chaos only/);
        await user.click(as);
        expect(href(r)).toBe('/costs?mode=moc&set=5');
        // Back to Default: the set's subscription goes, the modes come back.
        await user.selectOptions(screen.getByRole('combobox', { name: 'Cost Set' }), '0');
        await settled(r, '/costs?mode=moc');
        expect(conn.liveQueries()).not.toEqual(expect.arrayContaining([costQueryList(5)[0]]));
        expect(screen.getByRole('button', { name: 'Apocalyptic Shadow' })).not.toHaveAttribute(
            'aria-disabled',
        );
    });

    it('a shared address with a set and another mode follows the set', async () => {
        const r = await open('/costs?set=5');
        await settled(r, '/costs?mode=moc&set=5');
    });

    it('an unknown set id falls back to Default with a polite notice', async () => {
        await open('/costs?set=99');
        expect(
            screen.getAllByText('Cost set 99 is not available. Showing the Default set.')[0],
        ).toBeInTheDocument();
        expect(screen.getByRole('combobox', { name: 'Cost Set' })).toHaveValue('0');
        expect(conn.liveQueries()).not.toEqual(expect.arrayContaining([costQueryList(99)[0]]));
        expect(rowNames()).toHaveLength(4);
    });

    it('a set name is rendered as text, never as markup', async () => {
        await open();
        act(() => conn.db.viewPublishedCostSets.insert(costSet(8, '<img src=x onerror=alert(1)>')));
        await waitFor(() =>
            expect(
                within(screen.getByRole('combobox', { name: 'Cost Set' })).getByRole('option', {
                    name: '<img src=x onerror=alert(1)>',
                }),
            ).toBeInTheDocument(),
        );
        expect(document.querySelector('img[src="x"]')).toBeNull();
    });

    it('a search with markup stays text in the field', async () => {
        await open('/costs?q=%3Cb%3Ex%3C%2Fb%3E');
        expect(screen.getByRole('searchbox', { name: 'Search' })).toHaveValue('<b>x</b>');
        expect(document.querySelector('main b')?.textContent).not.toBe('x');
    });
});

describe('the address: same-page updates, unknown keys, history', () => {
    it('controls navigate without resetting the scroll, from the latest search (functional form)', async () => {
        const r = await open();
        const navigate = vi.spyOn(r.router, 'navigate');
        await userEvent.setup().click(screen.getByRole('button', { name: 'Fire' }));
        await settled(r, '/costs?el=fire');
        expect(navigate).toHaveBeenCalledWith(
            expect.objectContaining({ resetScroll: false, search: expect.any(Function) }),
        );
    });

    it('two activations before a render both land', async () => {
        const r = await open();
        act(() => {
            fireEvent.click(screen.getByRole('button', { name: 'Fire' }));
            fireEvent.click(screen.getByRole('button', { name: 'Ice' }));
        });
        await settled(r, '/costs?el=fire&el=ice');
    });

    it('an unknown key leaves the address, and the "Sign in" link carries only the page\'s own', async () => {
        const r = await open('/costs?foo=bar&el=fire&zzz=1');
        await settled(r, '/costs?el=fire');
        const signIn = screen.getByRole('link', { name: 'Sign in' }).getAttribute('href') ?? '';
        expect(new URLSearchParams(signIn.split('?')[1]).get('next')).toBe('/costs?el=fire');
        const user = userEvent.setup();
        await user.click(screen.getByRole('button', { name: 'Auction' }));
        await settled(r, '/costs?draft=auction&el=fire');
    });

    it('typing replaces the history entry instead of adding one (Back skips the search)', async () => {
        const user = userEvent.setup();
        const r = await open();
        await user.click(screen.getByRole('button', { name: 'Fire' }));
        await settled(r, '/costs?el=fire');
        const length = r.router.history.length;
        await user.type(screen.getByRole('searchbox', { name: 'Search' }), 'pe');
        await settled(r, '/costs?el=fire&q=pe');
        expect(r.router.history.length).toBe(length);
        act(() => r.router.history.back());
        await settled(r, '/costs');
    });

    it('the search is stored trimmed; the field keeps what was typed', async () => {
        const user = userEvent.setup();
        const r = await open();
        await user.type(screen.getByRole('searchbox', { name: 'Search' }), ' pel ');
        await settled(r, '/costs?q=pel');
        expect(screen.getByRole('searchbox', { name: 'Search' })).toHaveValue(' pel ');
    });
});

describe('focus after a control goes away', () => {
    it('"Clear N" moves focus to the search field', async () => {
        const user = userEvent.setup();
        const r = await open('/costs?el=fire');
        await user.click(screen.getByRole('button', { name: 'Clear 1 filter' }));
        await settled(r, '/costs');
        expect(screen.getByRole('searchbox', { name: 'Search' })).toHaveFocus();
    });

    it('"Clear filters" in the empty state moves focus to the search field', async () => {
        const user = userEvent.setup();
        const r = await open('/costs?q=zz');
        await user.click(screen.getByRole('button', { name: 'Clear filters' }));
        await settled(r, '/costs');
        expect(screen.getByRole('searchbox', { name: 'Search' })).toHaveFocus();
    });
});

describe('expanded rows', () => {
    const claraOpen = () =>
        screen.getByRole('button', { name: 'Synergies for Clara' }).getAttribute('aria-expanded');

    it.each([
        ['the tab', 'Light Cones', 'Characters'],
        ['the draft mode', 'Auction', 'Classic'],
        ['the game mode', 'Memory of Chaos', 'Apocalyptic Shadow'],
    ])('are cleared by a change of %s, and stay closed on the way back', async (_l, away, back) => {
        const user = userEvent.setup();
        const r = await open();
        await user.click(screen.getByRole('button', { name: 'Synergies for Clara' }));
        expect(claraOpen()).toBe('true');
        const control = (name: string) =>
            screen.queryByRole('tab', { name }) ?? screen.getByRole('button', { name });
        await user.click(control(away));
        await waitFor(() => expect(href(r)).not.toBe('/costs'));
        await user.click(control(back));
        await settled(r, '/costs');
        expect(claraOpen()).toBe('false');
    });

    it('are cleared by a change of cost set', async () => {
        const user = userEvent.setup();
        const r = await open();
        await user.click(screen.getByRole('button', { name: 'Synergies for Clara' }));
        await user.selectOptions(screen.getByRole('combobox', { name: 'Cost Set' }), '3');
        await settled(r, '/costs?set=3');
        await user.selectOptions(screen.getByRole('combobox', { name: 'Cost Set' }), '0');
        await settled(r, '/costs');
        expect(claraOpen()).toBe('false');
    });

    it("a synergy value names the character, the partner and Extra Cost, not the column's header", async () => {
        const user = userEvent.setup();
        await open();
        await user.click(screen.getByRole('button', { name: 'Synergies for Clara' }));
        const value = screen.getByText('\u22121').closest('td') as HTMLElement;
        const headerOf = (cell: HTMLElement) =>
            (cell.getAttribute('headers') ?? '')
                .split(' ')
                .map((id) => document.getElementById(id) as HTMLElement);
        const [owner, partner, extra] = headerOf(value);
        expect(headerOf(value)).toHaveLength(3);
        expect(owner).toHaveAccessibleName('Clara');
        // The partner is the sub-row's header (S14.2b): the value no longer reads without it.
        expect(partner?.tagName).toBe('TH');
        expect(partner).toHaveAccessibleName('Huohuo');
        expect(partner?.closest('tr')).toBe(value.closest('tr'));
        expect(extra).toHaveTextContent('Extra Cost');
        expect(headerOf(partner as HTMLElement).map((h) => h.textContent?.trim())).toEqual([
            expect.stringMatching(/^Clara/),
            'Paired Unit',
        ]);
        // The value's copy in the collapsed column is drawn by CSS: one "\u22121" in the DOM.
        expect(screen.getAllByText('\u22121')).toHaveLength(1);
        expect(partner?.querySelector('[data-value]')).toHaveAttribute('data-value', '\u22121');
    });

    it('a row header is named by the name alone (not the expander or the badge)', async () => {
        await open();
        const headers = within(table()).getAllByRole('rowheader');
        expect(headers.map((h) => h.getAttribute('aria-labelledby') !== null)).toEqual([
            true,
            true,
            true,
            true,
        ]);
        expect(screen.getByRole('rowheader', { name: 'Clara' })).toBeInTheDocument();
        expect(screen.getByRole('rowheader', { name: 'Pela' })).toBeInTheDocument();
        expect(screen.queryByRole('rowheader', { name: /Synergies|synerg/ })).toBeNull();
        // The badge's words stay in the cell, for reading it in browse mode.
        expect(screen.getByRole('rowheader', { name: 'Clara' })).toHaveTextContent('1 synergy');
    });

    it('a light cone row header is named by the name alone (not the path icon)', async () => {
        await open('/costs?tab=lightcones');
        expect(screen.getByRole('rowheader', { name: 'Nowhere to Run' })).toBeInTheDocument();
        expect(screen.getByRole('img', { name: 'Destruction' })).toBeInTheDocument();
    });
});

describe('cost sets: client filtering and the fallback notice', () => {
    it('a custom set shows its own rows only, with set 0 and another set in the same cache', async () => {
        const r = await open('/costs?set=3');
        conn.db.hsrCharacterCost.seed(
            characterCost('clara', 11, { set: 3 }),
            characterCost('clara', 99, { set: 5 }),
            characterCost('acheron', 98, { set: 6 }),
        );
        await act(async () => conn.applyAll());
        await settled(r, '/costs?set=3');
        const row = (name: string) =>
            bodyRows().find((tr) => tr.textContent?.includes(name)) as HTMLElement;
        expect(within(row('Clara')).getAllByRole('cell')[1]).toHaveTextContent('11');
        // Acheron and Pela have rows in set 0 (and Acheron in set 6) but none in set 3.
        expect(within(row('Acheron')).getAllByText('n/a')).toHaveLength(7);
        expect(within(row('Pela')).getAllByText('n/a')).toHaveLength(7);
    });

    it('an unknown set: the notice is announced on a hard load, and the id leaves the address', async () => {
        const r = await open('/costs?set=99&el=fire');
        await waitFor(() =>
            expect(screen.getByRole('status')).toHaveTextContent(
                'Cost set 99 is not available. Showing the Default set.',
            ),
        );
        await settled(r, '/costs?el=fire');
        // Replaced, not pushed: no entry with the bad id is left behind.
        expect(r.router.history.length).toBe(1);
        // The notice stays until the next control is used.
        expect(
            screen.getByText('Cost set 99 is not available. Showing the Default set.', {
                selector: 'p:not([role])',
            }),
        ).toBeInTheDocument();
        await userEvent.setup().click(screen.getByRole('button', { name: 'Ice' }));
        await settled(r, '/costs?el=fire&el=ice');
        expect(
            screen.queryByText('Cost set 99 is not available. Showing the Default set.', {
                selector: 'p:not([role])',
            }),
        ).toBeNull();
    });

    it('no notice, and the id stays, before the reference set is ready', async () => {
        const r = await open('/costs?set=99', { apply: false });
        await act(() => new Promise((done) => setTimeout(done, 50)));
        expect(screen.queryByText(/is not available/)).toBeNull();
        expect(href(r)).toBe('/costs?set=99');
    });
});

describe('announcements', () => {
    it('nothing is announced on the first render, also after the debounce', async () => {
        await open();
        await act(() => new Promise((done) => setTimeout(done, 800)));
        expect(screen.getByRole('status')).toHaveTextContent('');
    });
});

describe('inside the shell', () => {
    it('/costs as a visitor: one main, the banner, a single brand link', async () => {
        await open();
        expect(screen.getAllByRole('main')).toHaveLength(1);
        // The intro's own <header> sits inside main, where it is no banner landmark (HTML-AAM);
        // the test library does not scope that rule, so the page-level banner is counted here.
        const banners = screen.getAllByRole('banner').filter((b) => !b.closest('main'));
        expect(banners).toHaveLength(1);
        expect(screen.queryAllByRole('link', { name: 'IPC Battlegrounds' })).toHaveLength(1);
        expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    });
});

describe('errors', () => {
    it('a failed subscription shows a quiet message with Retry (not the splash); Retry subscribes again', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const user = userEvent.setup();
        await open('/costs', { apply: false });
        await act(async () =>
            conn
                .live()
                .find((s) => s.query === DEFAULT_COST_QUERIES[0])
                ?.fail('nope'),
        );
        expect(screen.getByText('The cost table could not be loaded.')).toBeInTheDocument();
        expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Retry' }));
        // Retry went away with the message: focus is on the table's region, not the body.
        expect(table().closest('section')).toHaveFocus();
        expect(conn.liveQueries()).toContain(DEFAULT_COST_QUERIES[0]);
        seed();
        await act(async () => conn.applyAll());
        expect(rowNames()).toHaveLength(4);
    });
});

/* T-COSTS-B (S14.2b): the archetype filter, the notice's other dismissals. */

const AUDIT_ROW = {
    createdById: 0,
    createdDate: { microsSinceUnixEpoch: 0n },
    lastModifiedById: 0,
    lastModifiedDate: { microsSinceUnixEpoch: 0n },
};
const archetype = (id: number, name: string) =>
    ({ id, name, description: '', ...AUDIT_ROW }) as unknown as Archetype;
const link = (characterName: string, archetypeId: number) =>
    ({ characterName, archetypeId, ...AUDIT_ROW }) as unknown as HsrCharacterArchetype;

/** Acheron: Debuff. Clara: FuA. Pela: Debuff and Break (several). Huohuo: none. */
function seedArchetypes() {
    conn.db.archetype.seed(
        archetype(1, 'Break'),
        archetype(2, 'DoT'),
        archetype(3, 'FuA'),
        archetype(4, 'Debuff'),
    );
    conn.db.hsrCharacterArchetype.seed(
        link('acheron', 4),
        link('clara', 3),
        link('pela', 4),
        link('pela', 1),
    );
}

async function openArch(path = '/costs', options?: { apply?: boolean }) {
    seedArchetypes();
    return open(path, options);
}

const archButton = () => screen.getByRole('button', { name: /^Archetype/ });

describe('the archetype filter (S14.2b)', () => {
    it('a dropdown of the archetypes, by name; picking two writes repeated arch params (OR within)', async () => {
        const user = userEvent.setup();
        const r = await openArch();
        await user.click(archButton());
        const group = screen.getByRole('group', { name: 'Filter by archetype' });
        expect(
            within(group)
                .getAllByRole('checkbox')
                .map((c) => c.closest('label')?.textContent),
        ).toEqual(['Break', 'Debuff', 'DoT', 'FuA']);
        await user.click(within(group).getByRole('checkbox', { name: 'FuA' }));
        await settled(r, '/costs?arch=FuA');
        expect(rowNames()).toEqual(['Clara']);
        await user.click(within(group).getByRole('checkbox', { name: 'Debuff' }));
        await settled(r, '/costs?arch=Debuff&arch=FuA');
        expect(rowNames()).toEqual(['Acheron', 'Clara', 'Pela']);
        // The panel stays open while picking; the closed button shows the count.
        await user.keyboard('{Escape}');
        expect(archButton()).toHaveAccessibleName('Archetype 2 selected');
        expect(archButton()).toHaveFocus();
    });

    it('the element row takes the fit layout; the path, role and rarity rows keep the scroll layout', async () => {
        await openArch();
        const layout = (name: string) =>
            screen.getByRole('group', { name }).getAttribute('data-layout');
        expect(layout('Filter by element')).toBe('fit');
        expect(layout('Filter by path')).toBe('scroll');
        expect(layout('Filter by role')).toBe('scroll');
        expect(layout('Filter by rarity')).toBe('scroll');
    });

    it('AND with the other groups; a character with several archetypes; one with none never matches', async () => {
        await openArch('/costs?arch=Debuff&el=ice');
        expect(rowNames()).toEqual(['Pela']);
    });

    it('a character with several archetypes matches each of them', async () => {
        await openArch('/costs?arch=Break');
        expect(rowNames()).toEqual(['Pela']);
    });

    it('a character with no archetype is listed only while no archetype is picked', async () => {
        await openArch('/costs?arch=Break&arch=Debuff&arch=DoT&arch=FuA');
        expect(rowNames()).toEqual(['Acheron', 'Clara', 'Pela']);
    });

    it('"Clear N" counts the archetypes and clears them', async () => {
        const user = userEvent.setup();
        const r = await openArch('/costs?arch=Debuff&arch=FuA&el=fire');
        await user.click(screen.getByRole('button', { name: 'Clear 3 filters' }));
        await settled(r, '/costs');
        expect(archButton()).toHaveAccessibleName('Archetype');
    });

    it('switching to Light Cones clears it (and hides it); back on Characters it stays cleared', async () => {
        const user = userEvent.setup();
        const r = await openArch('/costs?arch=FuA');
        await user.click(screen.getByRole('tab', { name: 'Light Cones' }));
        await settled(r, '/costs?tab=lightcones');
        expect(screen.queryByRole('button', { name: /^Archetype/ })).toBeNull();
        await user.click(screen.getByRole('tab', { name: 'Characters' }));
        await settled(r, '/costs');
        expect(rowNames()).toHaveLength(4);
    });

    it('a Light Cones address drops arch', async () => {
        const r = await openArch('/costs?tab=lightcones&arch=FuA');
        await settled(r, '/costs?tab=lightcones');
    });

    it('back and forward restore the picks', async () => {
        const user = userEvent.setup();
        const r = await openArch();
        await user.click(archButton());
        await user.click(screen.getByRole('checkbox', { name: 'Break' }));
        await settled(r, '/costs?arch=Break');
        act(() => r.router.history.back());
        await settled(r, '/costs');
        expect(rowNames()).toHaveLength(4);
        act(() => r.router.history.forward());
        await settled(r, '/costs?arch=Break');
        expect(rowNames()).toEqual(['Pela']);
    });

    it('unknown names leave the address once the list is ready (replaced), not before', async () => {
        const r = await openArch('/costs?arch=Nope&arch=FuA', { apply: false });
        await act(() => new Promise((done) => setTimeout(done, 50)));
        expect(href(r)).toBe('/costs?arch=FuA&arch=Nope');
        seed();
        await act(async () => conn.applyAll());
        await settled(r, '/costs?arch=FuA');
        expect(r.router.history.length).toBe(1);
        expect(rowNames()).toEqual(['Clara']);
    });

    it('needs no subscription of its own (the archetype tables are in the reference set)', async () => {
        const user = userEvent.setup();
        const r = await openArch();
        const before = [...conn.liveQueries()].sort();
        expect(before).toEqual(expect.arrayContaining(['SELECT * FROM "archetype"']));
        await user.click(archButton());
        await user.click(screen.getByRole('checkbox', { name: 'DoT' }));
        await settled(r, '/costs?arch=DoT');
        expect([...conn.liveQueries()].sort()).toEqual(before);
        // DoT has no character: the empty state.
        expect(screen.getByText('No characters match these filters.')).toBeInTheDocument();
    });

    it('archetype names are rendered as text', async () => {
        const user = userEvent.setup();
        await openArch();
        act(() => conn.db.archetype.insert(archetype(9, '<b>x</b>')));
        await user.click(archButton());
        expect(await screen.findByRole('checkbox', { name: '<b>x</b>' })).toBeInTheDocument();
        expect(document.querySelector('label b')).toBeNull();
    });
});

describe('the filter row (S14.2c)', () => {
    // jsdom gives `<search>` no role yet, so the landmark is found by its element and label.
    const filters = () => document.querySelector('search[aria-label="Filters"]');

    it('Archetype and rarity share one wrapper on Characters; Light Cones keeps rarity and Clear', async () => {
        const user = userEvent.setup();
        const r = await openArch('/costs?rarity=5');
        const rarity = screen.getByRole('group', { name: 'Filter by rarity' });
        const pair = archButton().closest('search > *');
        expect(pair).not.toBeNull();
        expect(pair).not.toBe(archButton());
        expect(pair).toContainElement(rarity);
        expect(pair?.parentElement).toBe(filters());
        await user.click(screen.getByRole('tab', { name: 'Light Cones' }));
        await settled(r, '/costs?rarity=5&tab=lightcones');
        const lcRarity = screen.getByRole('group', { name: 'Filter by rarity' });
        expect(lcRarity.parentElement).toBe(filters());
        expect(within(lcRarity).getByRole('button', { name: '5★' })).toHaveAttribute(
            'aria-pressed',
            'true',
        );
        expect(screen.getByRole('button', { name: 'Clear 1 filter' })).toBeInTheDocument();
    });

    it('the Archetype button keeps its name with and without a pick', async () => {
        const user = userEvent.setup();
        await openArch();
        expect(archButton()).toHaveAccessibleName('Archetype');
        await user.click(archButton());
        await user.click(screen.getByRole('checkbox', { name: 'FuA' }));
        await user.keyboard('{Escape}');
        expect(archButton()).toHaveAccessibleName('Archetype 1 selected');
    });

    it('Clear is named "Clear N filter(s)"; the word is in the button for screen readers', async () => {
        await openArch('/costs?arch=FuA&role=dps');
        const clear = screen.getByRole('button', { name: 'Clear 2 filters' });
        const word = within(clear).getByText('Clear');
        expect(word.closest('[aria-hidden="true"]')).toBeNull();
        expect(clear).toHaveTextContent(/^Clear\s*2\s*filters\s*✕$/);
        // S14.2d: right after the search, in one box that leads the filter row, so the keyboard
        // reaches it where it shows, before the filters.
        const search = screen.getByRole('searchbox', { name: 'Search' });
        expect(clear.previousElementSibling).toContainElement(search);
        expect(clear.parentElement?.parentElement).toBe(filters());
        expect(filters()?.firstElementChild).toBe(clear.parentElement);
    });
});

describe('the unknown-set notice (S14.2b)', () => {
    const NOTICE = 'Cost set 99 is not available. Showing the Default set.';
    const visible = () => screen.queryByText(NOTICE, { selector: 'p:not([role])' });

    it('goes with a use of the expander, and the status region is emptied', async () => {
        const user = userEvent.setup();
        await open('/costs?set=99');
        await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(NOTICE));
        await user.click(screen.getByRole('button', { name: 'Synergies for Clara' }));
        expect(visible()).toBeNull();
        expect(screen.getByRole('status')).toHaveTextContent('');
    });

    it('goes with the intro toggle', async () => {
        const user = userEvent.setup();
        await open('/costs?set=99');
        expect(visible()).not.toBeNull();
        await user.click(screen.getByRole('button', { name: 'Hide intro' }));
        expect(visible()).toBeNull();
        expect(screen.getByRole('status')).toHaveTextContent('');
    });
});
