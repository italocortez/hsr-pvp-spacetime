import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { INTRO_KEY } from '@/components/PageIntro/PageIntro';
import { costQueryList } from '@/stdb/costQueries';
import { DEFAULT_COST_QUERIES } from '@/stdb/referenceSet';
import {
    CHARACTERS,
    character,
    characterCost,
    costSet,
    LIGHTCONES,
    lightconeCost,
    synergy,
} from '@/test/costFixtures';
import { MockConnection } from '@/test/mockConnection';
import { renderWithConnection } from '@/test/renderWithConnection';
import { DRAFT_KEY, PREVIOUS_KEY } from './teamStorage';

/*
 * T-S14.3a: the team builder through the real router and app shell with the mock connection: adding and removing,
 * the full-team hint, default eidolons, eidolon / cone / superimposition changes in the total, pairs and the
 * missing-row warning, the modes and cost sets, filters in the address, a team arriving in the address, browser
 * storage (kept and unavailable), the keyboard swap, picking from an empty slot (S14.3a-pick), and the loading and error states.
 */

let conn: MockConnection;
beforeEach(() => {
    conn = new MockConnection();
    try {
        localStorage.removeItem(INTRO_KEY);
        localStorage.removeItem(DRAFT_KEY);
        localStorage.removeItem(PREVIOUS_KEY);
    } catch {}
});
afterEach(() => {
    vi.restoreAllMocks();
    delete (window as { matchMedia?: unknown }).matchMedia;
});

const VISITOR = { ready: true } as const;

// Acheron E0 7, Clara E0 2, Pela (4-star) E0 1, Kafka E0 3; huohuo has no AS Classic row. Rows step +1 per eidolon.
function seed() {
    conn.db.hsrCharacter.seed(
        ...CHARACTERS,
        character('kafka', 'Kafka', { element: 'Lightning', path: 'Nihility', role: 'Dps' }),
    );
    conn.db.hsrLightcone.seed(...LIGHTCONES);
    conn.db.hsrCharacterCost.seed(
        characterCost('acheron', 7),
        characterCost('clara', 2),
        characterCost('pela', 1),
        characterCost('kafka', 3),
        characterCost('acheron', 4, { mode: 'MemoryOfChaos' }),
        characterCost('clara', 5, { mode: 'MemoryOfChaos', draft: 'Auction' }),
        characterCost('acheron', 8, { draft: 'Auction' }),
    );
    conn.db.hsrLightconeCost.seed(
        lightconeCost('pastselfinmirror', 2.5),
        lightconeCost('meshingcogs', 0.5),
        lightconeCost('nowheretorun', 1),
    );
    conn.db.hsrSynergyCost.seed(synergy('acheron', 'pela', 1.5), synergy('clara', 'kafka', -1));
    conn.db.viewPublishedCostSets.seed(
        costSet(3, 'Yuji Tournament', { mode: 'ApocalypticShadow' }),
        costSet(5, 'Chaos League', { mode: 'MemoryOfChaos' }),
    );
}

async function open(path = '/teambuilder', { apply = true } = {}) {
    const r = renderWithConnection(path, conn, VISITOR);
    await screen.findByRole('heading', { level: 1 });
    if (apply) {
        seed();
        await act(async () => conn.applyAll());
    }
    return r;
}

type R = Awaited<ReturnType<typeof open>>;
const href = (r: R) => r.router.state.location.href;
const settled = (r: R, path: string) =>
    waitFor(() => expect(r.router.state.resolvedLocation?.href).toBe(path));
const total = () => screen.getByText(/Total Cost/).closest('p') as HTMLElement;
const card = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name},`) });
const slotNames = () =>
    [...document.querySelectorAll('[data-slot]')].map(
        (li) => li.querySelector('h3')?.textContent ?? null,
    );
const notice = () =>
    screen.queryByText('Loaded a team from a link.', { selector: 'p:not([role]) span' });
const status = () => document.querySelector('p[role="status"]:last-of-type') as HTMLElement;

describe('the page', () => {
    it('one h1, the title, four empty slots, a zero total and no pairs', async () => {
        await open();
        expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
        expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Iterate any team.');
        await waitFor(() => expect(document.title).toBe('Team Builder — IPC Battlegrounds'));
        expect(screen.getAllByRole('button', { name: /^Slot \d, empty/ })).toHaveLength(4);
        expect(total()).toHaveTextContent('0.0');
        expect(screen.getByText('none')).toBeInTheDocument();
        expect(screen.getByRole('heading', { name: 'Character Pool' })).toBeInTheDocument();
    });

    it('loading: the pool is busy and its count reads Loading', async () => {
        await open('/teambuilder', { apply: false });
        expect(screen.getByRole('list', { name: 'Loading characters' })).toHaveAttribute(
            'aria-busy',
            'true',
        );
        expect(screen.getByText('Loading')).toBeInTheDocument();
    });

    it('a failed subscription shows a message with Retry; Retry subscribes again and keeps focus', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const user = userEvent.setup();
        await open('/teambuilder', { apply: false });
        await act(async () =>
            conn
                .live()
                .find((s) => s.query === DEFAULT_COST_QUERIES[0])
                ?.fail('nope'),
        );
        expect(screen.getByText('The characters could not be loaded.')).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Retry' }));
        expect(screen.getByRole('searchbox', { name: 'Search characters' })).toHaveFocus();
        expect(conn.liveQueries()).toContain(DEFAULT_COST_QUERIES[0]);
        seed();
        await act(async () => conn.applyAll());
        expect(card('Acheron')).toBeInTheDocument();
    });
});

describe('building a team', () => {
    it('a card adds to the first empty slot: E0 for a 5-star, E6 for a 4-star; the total and pairs follow', async () => {
        const user = userEvent.setup();
        await open();
        await user.click(card('Acheron'));
        await user.click(card('Pela'));
        expect(slotNames()).toEqual(['Acheron', 'Pela', null, null]);
        expect(screen.getByRole('combobox', { name: 'Eidolon for Acheron' })).toHaveValue('0');
        expect(screen.getByRole('combobox', { name: 'Eidolon for Pela' })).toHaveValue('6');
        // 7 + (1 + 6) + pair 1.5
        expect(total()).toHaveTextContent('15.5');
        expect(card('Acheron')).toHaveAttribute('aria-pressed', 'true');
        const strip = screen.getByRole('heading', { name: 'Active Pairings' })
            .parentElement as HTMLElement;
        expect(within(strip).getByRole('listitem')).toHaveTextContent('Acheron× and Pela+1.5');
        await waitFor(() => expect(status()).toHaveTextContent('Pela added to the team.'));
    });

    it('a picked card removes it; the remove button too, with focus on the emptied slot', async () => {
        const user = userEvent.setup();
        await open();
        await user.click(card('Acheron'));
        await user.click(card('Clara'));
        await user.click(card('Acheron'));
        expect(slotNames()).toEqual([null, 'Clara', null, null]);
        await user.click(screen.getByRole('button', { name: 'Remove Clara' }));
        expect(slotNames()).toEqual([null, null, null, null]);
        await waitFor(() =>
            expect(screen.getByRole('button', { name: /^Slot 2, empty/ })).toHaveFocus(),
        );
        expect(total()).toHaveTextContent('0.0');
    });

    it('a full team: a fifth card shows and announces the hint, and changes nothing', async () => {
        const user = userEvent.setup();
        await open();
        for (const n of ['Acheron', 'Clara', 'Pela', 'Kafka']) await user.click(card(n));
        await user.click(card('Huohuo'));
        expect(slotNames()).toEqual(['Acheron', 'Clara', 'Pela', 'Kafka']);
        expect(
            screen.getByText('The team is full. Remove a character to add another.', {
                selector: 'p:not([role])',
            }),
        ).toBeInTheDocument();
        await waitFor(() =>
            expect(status()).toHaveTextContent(
                'The team is full. Remove a character to add another.',
            ),
        );
    });

    it('eidolon, light cone and superimposition changes update the total', async () => {
        const user = userEvent.setup();
        await open();
        await user.click(card('Acheron'));
        expect(total()).toHaveTextContent('7.0');
        await user.selectOptions(
            screen.getByRole('combobox', { name: 'Eidolon for Acheron' }),
            '2',
        );
        expect(total()).toHaveTextContent('9.0');
        // No cone: no Superimposition select (the mockup hides it).
        expect(screen.queryByRole('combobox', { name: 'Superimposition for Acheron' })).toBeNull();
        const search = screen.getByRole('combobox', { name: 'Light cone for Acheron: none' });
        await user.click(search);
        expect(search).toHaveFocus();
        expect(search).toHaveAttribute('aria-expanded', 'true');
        await user.type(search, 'psim');
        expect(within(screen.getByRole('listbox')).getAllByRole('option')).toHaveLength(1);
        await user.keyboard('{Enter}');
        const trigger = screen.getByRole('combobox', {
            name: 'Light cone for Acheron: Past Self in Mirror',
        });
        expect(trigger).toHaveFocus();
        expect(trigger).toHaveAttribute('aria-expanded', 'false');
        expect(trigger).toHaveAttribute('placeholder', 'S1 Past Self in Mirror');
        const superimposition = screen.getByRole('combobox', {
            name: 'Superimposition for Acheron',
        });
        // A limited 5-star cone starts at S1: 2.5.
        expect(superimposition).toHaveValue('1');
        expect(total()).toHaveTextContent('11.5');
        await user.selectOptions(superimposition, '3');
        expect(total()).toHaveTextContent('12.5');
    });

    it('a 4-star cone starts at S5; Escape closes the picker and returns focus; Unequip removes it', async () => {
        const user = userEvent.setup();
        await open();
        await user.click(card('Clara'));
        await user.click(screen.getByRole('combobox', { name: 'Light cone for Clara: none' }));
        await user.keyboard('nowhere{Enter}');
        expect(screen.getByRole('combobox', { name: 'Superimposition for Clara' })).toHaveValue(
            '5',
        );
        // 2 + (1 + 2)
        expect(total()).toHaveTextContent('5.0');
        await user.click(
            screen.getByRole('combobox', { name: 'Light cone for Clara: Nowhere to Run' }),
        );
        expect(screen.getByRole('listbox')).toBeInTheDocument();
        await user.keyboard('{Escape}');
        expect(screen.queryByRole('listbox')).toBeNull();
        expect(
            screen.getByRole('combobox', { name: 'Light cone for Clara: Nowhere to Run' }),
        ).toHaveFocus();
        await user.click(
            screen.getByRole('combobox', { name: 'Light cone for Clara: Nowhere to Run' }),
        );
        await user.click(screen.getByRole('button', { name: 'Unequip Lightcone' }));
        expect(total()).toHaveTextContent('2.0');
    });

    // T-S14.3a-fix2 (review 2 S2): a pointer or tap pick ends the search; a keyboard pick keeps focus. Both announced.
    it('a pick by pointer blurs the field and closes the bar; by keyboard focus stays; both are announced', async () => {
        const user = userEvent.setup();
        await open();
        await user.click(card('Acheron'));
        const search = screen.getByRole('combobox', { name: 'Light cone for Acheron: none' });
        await user.click(search);
        await user.type(search, 'psim');
        await user.click(within(screen.getByRole('listbox')).getByRole('option'));
        const trigger = screen.getByRole('combobox', {
            name: 'Light cone for Acheron: Past Self in Mirror',
        });
        expect(trigger).not.toHaveFocus();
        expect(trigger).toHaveAttribute('aria-expanded', 'false');
        expect(trigger.parentElement).not.toHaveAttribute('data-open');
        await waitFor(() =>
            expect(status()).toHaveTextContent('Past Self in Mirror equipped on Acheron.'),
        );
        // Unequip by pointer: the same.
        await user.click(trigger);
        await user.click(screen.getByRole('button', { name: 'Unequip Lightcone' }));
        const none = screen.getByRole('combobox', { name: 'Light cone for Acheron: none' });
        expect(none).not.toHaveFocus();
        await waitFor(() => expect(status()).toHaveTextContent('Light cone removed from Acheron.'));
        // By keyboard: focus stays in the field, announced too.
        none.focus();
        await user.keyboard('psim{Enter}');
        expect(
            screen.getByRole('combobox', { name: 'Light cone for Acheron: Past Self in Mirror' }),
        ).toHaveFocus();
        await waitFor(() =>
            expect(status()).toHaveTextContent('Past Self in Mirror equipped on Acheron.'),
        );
    });

    // T-S14.3a-fix2 (review 2 S3): the card's hover look follows keyboard focus only (the CSS keys on the mark).
    it('a card focused after a pointer press is marked; a key inside or keyboard focus unmarks it', async () => {
        const user = userEvent.setup();
        await open();
        await user.click(card('Acheron'));
        const article = screen.getByRole('article', { name: 'Slot 1: Acheron' });
        const eidolon = screen.getByRole('combobox', { name: 'Eidolon for Acheron' });
        await user.click(eidolon);
        expect(eidolon).toHaveFocus();
        expect(article).toHaveAttribute('data-pointer-focus');
        await user.keyboard('{ArrowDown}');
        expect(article).not.toHaveAttribute('data-pointer-focus');
        // Pointer again, then focus arrives by Tab: unmarked.
        await user.click(eidolon);
        expect(article).toHaveAttribute('data-pointer-focus');
        screen.getByRole('button', { name: /Clear Team/ }).focus();
        await user.tab();
        expect(eidolon).toHaveFocus();
        expect(article).not.toHaveAttribute('data-pointer-focus');
    });

    // T-S14.3a-fix2 (review 2 M2): Escape from "Unequip Lightcone"; the bar stays open while the panel is.
    it('Escape with focus on Unequip closes the panel and returns focus to the field', async () => {
        const user = userEvent.setup();
        await open();
        await user.click(card('Clara'));
        await user.click(screen.getByRole('combobox', { name: 'Light cone for Clara: none' }));
        await user.keyboard('nowhere{Enter}');
        const field = screen.getByRole('combobox', {
            name: 'Light cone for Clara: Nowhere to Run',
        });
        await user.keyboard('{ArrowDown}');
        expect(field).toHaveAttribute('aria-expanded', 'true');
        expect(field.parentElement).toHaveAttribute('data-open');
        screen.getByRole('button', { name: 'Unequip Lightcone' }).focus();
        expect(field.parentElement).toHaveAttribute('data-open');
        await user.keyboard('{Escape}');
        expect(screen.queryByRole('listbox')).toBeNull();
        expect(field).toHaveFocus();
        expect(field).toHaveAttribute('aria-expanded', 'false');
        expect(field.parentElement).not.toHaveAttribute('data-open');
        // The cone is still equipped.
        expect(
            screen.getByRole('combobox', { name: 'Superimposition for Clara' }),
        ).toBeInTheDocument();
    });

    it('a negative pair is listed with a real minus sign and floored at 0 in the total', async () => {
        const user = userEvent.setup();
        await open();
        await user.click(card('Clara'));
        await user.click(card('Kafka'));
        expect(screen.getByText('−1')).toBeInTheDocument();
        expect(total()).toHaveTextContent('5.0');
    });

    it('a character without a cost row shows n/a, counts 0 and a warning names it', async () => {
        const user = userEvent.setup();
        await open();
        await user.click(card('Huohuo'));
        await user.click(card('Clara'));
        expect(total()).toHaveTextContent('2.0');
        expect(screen.getByText(/A lobby with this set would refuse it/)).toBeInTheDocument();
        expect(screen.getByText('Huohuo (slot 1, character)')).toBeInTheDocument();
    });

    it('Clear Team empties every slot with no confirmation', async () => {
        const user = userEvent.setup();
        await open();
        await user.click(card('Acheron'));
        await user.click(card('Clara'));
        await user.click(screen.getByRole('button', { name: /Clear Team/ }));
        expect(slotNames()).toEqual([null, null, null, null]);
        await waitFor(() => expect(status()).toHaveTextContent('Team cleared.'));
    });

    it('keyboard swap: Space picks up, arrows move, Space drops; Escape puts it back', async () => {
        const user = userEvent.setup();
        await open();
        for (const n of ['Acheron', 'Clara', 'Pela']) await user.click(card(n));
        screen.getByRole('button', { name: 'Move Acheron, slot 1' }).focus();
        await user.keyboard(' ');
        expect(screen.getByRole('button', { name: 'Move Acheron, slot 1' })).toHaveAttribute(
            'aria-pressed',
            'true',
        );
        await user.keyboard('{ArrowRight}');
        await waitFor(() =>
            expect(screen.getByRole('button', { name: 'Move Acheron, slot 2' })).toHaveFocus(),
        );
        await user.keyboard('{ArrowRight}');
        await waitFor(() => expect(slotNames()).toEqual(['Clara', 'Pela', 'Acheron', null]));
        await user.keyboard('{Escape}');
        await waitFor(() => expect(slotNames()).toEqual(['Acheron', 'Clara', 'Pela', null]));
        await waitFor(() =>
            expect(status()).toHaveTextContent('Move cancelled. Acheron is back in slot 1.'),
        );
        await waitFor(() =>
            expect(screen.getByRole('button', { name: 'Move Acheron, slot 1' })).toHaveFocus(),
        );
        await user.keyboard(' {ArrowDown} ');
        await waitFor(() => expect(slotNames()).toEqual(['Clara', 'Acheron', 'Pela', null]));
        await waitFor(() => expect(status()).toHaveTextContent('Acheron dropped in slot 2.'));
    });

    // T-S14.3a-fix (review B1): the browser reports the lifted card's box under the pointer, because the card
    // follows it. The stub does the same: the dragged cell's box moves with the pointer. The old stub kept every box
    // fixed and passed although a drag onto a later slot never swapped.
    function stubBoxes() {
        const pointer = { x: 0, y: 0 };
        const cells = [...document.querySelectorAll<HTMLElement>('[data-slot]')];
        cells.forEach((cell, i) => {
            cell.getBoundingClientRect = () => {
                if (cell.hasAttribute('data-lifted'))
                    return {
                        left: pointer.x - 40,
                        right: pointer.x + 50,
                        top: pointer.y - 20,
                        bottom: pointer.y + 100,
                    } as DOMRect;
                return { left: i * 100, right: i * 100 + 90, top: 0, bottom: 120 } as DOMRect;
            };
        });
        return pointer;
    }
    function dragHandle(
        name: string,
        from: { x: number; y: number },
        to: { x: number; y: number },
    ) {
        const pointer = stubBoxes();
        const handle = screen.getByRole('button', { name: new RegExp(`^Move ${name},`) });
        pointer.x = from.x;
        pointer.y = from.y;
        fireEvent.pointerDown(handle, {
            button: 0,
            pointerId: 1,
            clientX: from.x,
            clientY: from.y,
        });
        for (const t of [0.5, 1]) {
            pointer.x = from.x + (to.x - from.x) * t;
            pointer.y = from.y + (to.y - from.y) * t;
            fireEvent.pointerMove(handle, { pointerId: 1, clientX: pointer.x, clientY: pointer.y });
        }
        // The lifted card is under the pointer as the browser reports it; the target is still found.
        const lifted = document.querySelector<HTMLElement>('[data-lifted]');
        expect(lifted?.getBoundingClientRect().left).toBeLessThanOrEqual(to.x);
        expect(lifted?.getBoundingClientRect().right).toBeGreaterThanOrEqual(to.x);
        fireEvent.pointerUp(handle, { pointerId: 1, clientX: to.x, clientY: to.y });
        fireEvent.click(handle);
    }

    it('pointer drag onto a later slot swaps the two, also when the lifted card is under the pointer', async () => {
        await open();
        fireEvent.click(card('Acheron'));
        fireEvent.click(card('Clara'));
        dragHandle('Acheron', { x: 40, y: 20 }, { x: 340, y: 40 });
        expect(slotNames()).toEqual([null, 'Clara', null, 'Acheron']);
        // The click that ends a drag does not pick the slot up.
        expect(screen.getByRole('button', { name: 'Move Acheron, slot 4' })).toHaveAttribute(
            'aria-pressed',
            'false',
        );
        await waitFor(() => expect(status()).toHaveTextContent('Acheron moved to slot 4.'));
    });

    it('pointer drag onto an earlier slot swaps the two', async () => {
        await open();
        for (const n of ['Acheron', 'Clara', 'Pela']) fireEvent.click(card(n));
        dragHandle('Pela', { x: 240, y: 20 }, { x: 140, y: 60 });
        expect(slotNames()).toEqual(['Acheron', 'Pela', 'Clara', null]);
        dragHandle('Pela', { x: 140, y: 20 }, { x: 20, y: 60 });
        expect(slotNames()).toEqual(['Pela', 'Acheron', 'Clara', null]);
    });

    it('a drag released over no slot changes nothing', async () => {
        await open();
        fireEvent.click(card('Acheron'));
        fireEvent.click(card('Clara'));
        dragHandle('Acheron', { x: 40, y: 20 }, { x: 40, y: 400 });
        expect(slotNames()).toEqual(['Acheron', 'Clara', null, null]);
    });

    // T-S14.3a-fix2 (review 2 M1): Escape during a pointer drag cancels it fully; the release's click picks nothing up.
    it('Escape during a pointer drag cancels it; after the release no slot is picked up', async () => {
        await open();
        fireEvent.click(card('Acheron'));
        fireEvent.click(card('Clara'));
        const pointer = stubBoxes();
        const handle = screen.getByRole('button', { name: 'Move Acheron, slot 1' });
        handle.focus();
        fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 40, clientY: 20 });
        pointer.x = 140;
        pointer.y = 40;
        fireEvent.pointerMove(handle, { pointerId: 1, clientX: 140, clientY: 40 });
        expect(document.querySelector('[data-lifted]')).not.toBeNull();
        fireEvent.keyDown(handle, { key: 'Escape' });
        expect(document.querySelector('[data-lifted]')).toBeNull();
        fireEvent.pointerUp(handle, { pointerId: 1, clientX: 140, clientY: 40 });
        fireEvent.click(handle);
        expect(slotNames()).toEqual(['Acheron', 'Clara', null, null]);
        expect(screen.getByRole('button', { name: 'Move Acheron, slot 1' })).toHaveAttribute(
            'aria-pressed',
            'false',
        );
        expect(document.querySelector('[data-grabbed]')).toBeNull();
        await waitFor(() => expect(status()).toHaveTextContent('Move cancelled.'));
        // The next real click picks up as usual.
        fireEvent.pointerDown(handle, { button: 0, pointerId: 2, clientX: 40, clientY: 20 });
        fireEvent.pointerUp(handle, { pointerId: 2, clientX: 40, clientY: 20 });
        fireEvent.click(handle);
        expect(screen.getByRole('button', { name: 'Move Acheron, slot 1' })).toHaveAttribute(
            'aria-pressed',
            'true',
        );
    });

    // T-S14.3a-fix (review S4): screen readers on phones and in browse mode send a click, not a key.
    it('a click on the handle picks the slot up; a click on another handle or an empty slot moves it there', async () => {
        const user = userEvent.setup();
        await open();
        for (const n of ['Acheron', 'Clara', 'Pela']) await user.click(card(n));
        const handle = () => screen.getByRole('button', { name: /^Move Acheron,/ });
        await user.click(handle());
        expect(handle()).toHaveAttribute('aria-pressed', 'true');
        await waitFor(() => expect(status()).toHaveTextContent(/Acheron picked up from slot 1/));
        await user.click(screen.getByRole('button', { name: 'Move Pela, slot 3' }));
        expect(slotNames()).toEqual(['Pela', 'Clara', 'Acheron', null]);
        expect(handle()).toHaveAttribute('aria-pressed', 'false');
        await waitFor(() =>
            expect(status()).toHaveTextContent(
                'Acheron swapped with Pela: Acheron in slot 3, Pela in slot 1.',
            ),
        );
        await user.click(handle());
        await user.click(screen.getByRole('button', { name: /^Slot 4, empty: move Acheron here/ }));
        expect(slotNames()).toEqual(['Pela', 'Clara', null, 'Acheron']);
        await waitFor(() => expect(status()).toHaveTextContent('Acheron moved to slot 4.'));
        // A second click on its own handle drops it where it is.
        await user.click(handle());
        await user.click(handle());
        expect(handle()).toHaveAttribute('aria-pressed', 'false');
        expect(slotNames()).toEqual(['Pela', 'Clara', null, 'Acheron']);
    });
});

describe('modes and cost sets', () => {
    it('the game mode tiles are a native radio group: arrows select and write the address', async () => {
        const user = userEvent.setup();
        const r = await open();
        await user.click(card('Acheron'));
        const group = screen.getByRole('group', { name: 'Game Mode' });
        const as = within(group).getByRole('radio', { name: 'Apocalyptic Shadow' });
        expect(as).toBeChecked();
        as.focus();
        await user.keyboard('{ArrowRight}');
        await settled(r, '/teambuilder?mode=moc');
        expect(within(group).getByRole('radio', { name: 'Memory of Chaos' })).toHaveFocus();
        // MoC row: Acheron E0 4.
        expect(total()).toHaveTextContent('4.0');
    });

    it('Auction: the character costs base + eidolon extra', async () => {
        const user = userEvent.setup();
        const r = await open();
        await user.click(card('Acheron'));
        await user.click(screen.getByRole('button', { name: 'Auction' }));
        await settled(r, '/teambuilder?draft=auction');
        await user.selectOptions(
            screen.getByRole('combobox', { name: 'Eidolon for Acheron' }),
            '3',
        );
        // Auction row: E0 8, E3 11 -> 8 + 3.
        expect(total()).toHaveTextContent('11.0');
    });

    it('a custom set subscribes its rows and fixes the game mode, the other tiles disabled with a reason', async () => {
        const user = userEvent.setup();
        const r = await open();
        await user.selectOptions(screen.getByRole('combobox', { name: 'Cost Set' }), '3');
        await settled(r, '/teambuilder?set=3');
        expect(conn.liveQueries()).toEqual(expect.arrayContaining(costQueryList(3)));
        const moc = screen.getByRole('radio', { name: 'Memory of Chaos' });
        expect(moc).toBeDisabled();
        expect(moc).toHaveAccessibleDescription(/Yuji Tournament is for Apocalyptic Shadow only/);
        expect(href(r)).toBe('/teambuilder?set=3');
        // A shared address with a set and another mode follows the set.
        await r.router.navigate({ to: '/teambuilder', search: { set: 5 } });
        await settled(r, '/teambuilder?mode=moc&set=5');
    });

    it('an unknown set id falls back to Default with a notice', async () => {
        await open('/teambuilder?set=99');
        expect(
            screen.getAllByText('Cost set 99 is not available. Showing the Default set.')[0],
        ).toBeInTheDocument();
        expect(screen.getByRole('combobox', { name: 'Cost Set' })).toHaveValue('0');
    });
});

describe('the pool filters live in the address', () => {
    it('a chip and the search write the address and filter the pool; Clear empties both', async () => {
        const user = userEvent.setup();
        const r = await open();
        await user.click(
            within(screen.getByRole('group', { name: 'Filter by element' })).getByRole('button', {
                name: 'Ice',
            }),
        );
        await settled(r, '/teambuilder?el=ice');
        expect(
            screen.getAllByRole('button', { name: /, (DPS|Support|Sustain), \d star$/ }),
        ).toHaveLength(1);
        await user.type(screen.getByRole('searchbox', { name: 'Search characters' }), 'zzz');
        await settled(r, '/teambuilder?el=ice&q=zzz');
        expect(screen.getByText('No characters found matching your filters.')).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Clear 2 filters' }));
        await settled(r, '/teambuilder');
        expect(screen.getByRole('searchbox', { name: 'Search characters' })).toHaveFocus();
    });

    it('a shared address with filters shows them applied; unknown keys leave', async () => {
        const r = await open('/teambuilder?role=support&rarity=4&foo=bar');
        await settled(r, '/teambuilder?rarity=4&role=support');
        expect(card('Pela')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /^Acheron,/ })).toBeNull();
    });
});

describe('the team in the address and in storage', () => {
    it('a packed team in the address loads once; its modes move into the address and it leaves', async () => {
        const r = await open(
            '/teambuilder?team=1.clara-3._.acheron-0-pastselfinmirror-2._.moc-a-0-3000-1500',
        );
        await settled(r, '/teambuilder?draft=auction&mode=moc');
        expect(slotNames()).toEqual(['Clara', null, 'Acheron', null]);
        expect(screen.getByRole('combobox', { name: 'Eidolon for Clara' })).toHaveValue('3');
        expect(screen.getByRole('combobox', { name: 'Superimposition for Acheron' })).toHaveValue(
            '2',
        );
        expect(localStorage.getItem(DRAFT_KEY)).toBe(
            '1.clara-3._.acheron-0-pastselfinmirror-2._.moc-a-0-3000-1500',
        );
    });

    it('an unreadable team link keeps the saved team and says so', async () => {
        localStorage.setItem(DRAFT_KEY, '1.pela-6._._._.as-c-0-3000-1500');
        const r = await open('/teambuilder?team=2.nothing');
        await settled(r, '/teambuilder');
        expect(slotNames()).toEqual(['Pela', null, null, null]);
        expect(
            screen.getAllByText(
                'The team in this link could not be read. Showing your saved team.',
            )[0],
        ).toBeInTheDocument();
    });

    it('an unknown name from a link shows as not available, removable', async () => {
        const user = userEvent.setup();
        await open('/teambuilder?team=1.ghost-2._._._.as-c-0-3000-1500');
        expect(slotNames()).toEqual(['ghost', null, null, null]);
        expect(screen.getByText('Not available')).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Remove ghost' }));
        expect(slotNames()).toEqual([null, null, null, null]);
    });

    it('a reload keeps the team (browser storage)', async () => {
        const user = userEvent.setup();
        const first = await open();
        await user.click(card('Clara'));
        first.unmount();
        await open();
        expect(slotNames()).toEqual(['Clara', null, null, null]);
    });

    // T-S14.3a-fix2 (review 2 M7): a draft from a later text version survives a visit with this build.
    it('a stored draft this build cannot read is kept on load, until the team is changed', async () => {
        const user = userEvent.setup();
        const LATER = '2.firefly-0._._._.as-c-0-3000-1500';
        localStorage.setItem(DRAFT_KEY, LATER);
        const first = await open();
        expect(slotNames()).toEqual([null, null, null, null]);
        await user.click(screen.getByRole('button', { name: 'Auction' }));
        expect(localStorage.getItem(DRAFT_KEY)).toBe(LATER);
        first.unmount();
        await open();
        expect(localStorage.getItem(DRAFT_KEY)).toBe(LATER);
        // The mock connection was seeded twice (two opens): the pool lists each card twice.
        await user.click(screen.getAllByRole('button', { name: /^Clara,/ })[0] as HTMLElement);
        expect(localStorage.getItem(DRAFT_KEY)).toBe('1.clara-0._._._.as-c-0-3000-1500');
    });

    it('works with storage unavailable', async () => {
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
            throw new Error('blocked');
        });
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new Error('blocked');
        });
        const user = userEvent.setup();
        await open();
        await user.click(card('Acheron'));
        expect(slotNames()).toEqual(['Acheron', null, null, null]);
        expect(total()).toHaveTextContent('7.0');
    });

    // T-S14.3a-fix (review S1): while the cost rows load, nothing is "missing".
    it('a saved team loads without the not-priced warning or n/a while the cost rows arrive', async () => {
        localStorage.setItem(DRAFT_KEY, '1.acheron-0._._._.as-c-0-3000-1500');
        await open('/teambuilder', { apply: false });
        seed();
        // The reference set first, the cost rows not yet.
        for (const q of conn.liveQueries())
            if (!DEFAULT_COST_QUERIES.includes(q)) await act(async () => conn.apply(q));
        expect(slotNames()).toEqual(['Acheron', null, null, null]);
        expect(screen.queryByText(/not priced/)).toBeNull();
        expect(screen.queryByText('n/a')).toBeNull();
        expect(total()).toHaveTextContent('Cost loading');
        expect(total()).not.toHaveTextContent('0.0');
        await act(async () => conn.applyAll());
        expect(total()).toHaveTextContent('7.0');
        expect(screen.queryByText(/not priced/)).toBeNull();
    });

    // T-S14.3a-fix (review S2): a team the address validator cannot keep still gets the notice.
    it.each([
        ['upper case', '/teambuilder?team=1.Clara-3._._._.as-c-0-3000-1500'],
        ['a trailing parenthesis', '/teambuilder?team=1.clara-3._._._.as-c-0-3000-1500)'],
        ['given twice', '/teambuilder?team=1.clara-3._._._.as-c-0-3000-1500&team=x'],
        ['over 400 characters', `/teambuilder?team=${'a'.repeat(401)}`],
    ])(
        'a link whose team has %s says it could not be read and keeps the saved team',
        async (_n, path) => {
            localStorage.setItem(DRAFT_KEY, '1.pela-6._._._.as-c-0-3000-1500');
            const r = await open(path);
            await settled(r, '/teambuilder');
            expect(slotNames()).toEqual(['Pela', null, null, null]);
            expect(
                screen.getAllByText(
                    'The team in this link could not be read. Showing your saved team.',
                )[0],
            ).toBeInTheDocument();
        },
    );

    // T-S14.3a-fix (review S3): a link does not lose the saved team.
    describe('a link replacing a different saved team', () => {
        const SAVED = '1.pela-6._._._.aa-c-0-3000-1500';
        const LINK = '1.clara-3._.acheron-0-pastselfinmirror-2._.moc-a-0-3000-1500';

        it('says so, announces it, and Restore brings the saved team and its modes back', async () => {
            const user = userEvent.setup();
            localStorage.setItem(DRAFT_KEY, SAVED);
            const r = await open(`/teambuilder?team=${LINK}`);
            await settled(r, '/teambuilder?draft=auction&mode=moc');
            expect(slotNames()).toEqual(['Clara', null, 'Acheron', null]);
            expect(notice()).toBeInTheDocument();
            await waitFor(() => expect(status()).toHaveTextContent('Loaded a team from a link.'));
            expect(localStorage.getItem(PREVIOUS_KEY)).toBe(SAVED);
            // Edits to the link's team keep the offer.
            await user.click(card('Kafka'));
            expect(notice()).toBeInTheDocument();
            await user.click(screen.getByRole('button', { name: 'Restore my previous team' }));
            expect(slotNames()).toEqual(['Pela', null, null, null]);
            await settled(r, '/teambuilder?mode=aa');
            expect(notice()).toBeNull();
            expect(localStorage.getItem(PREVIOUS_KEY)).toBeNull();
            expect(localStorage.getItem(DRAFT_KEY)).toBe(SAVED);
            await waitFor(() => expect(status()).toHaveTextContent('Your previous team is back.'));
            await waitFor(() =>
                expect(screen.getByRole('combobox', { name: 'Eidolon for Pela' })).toHaveFocus(),
            );
        });

        it('the offer survives a reload until it is dismissed; Dismiss keeps the link team', async () => {
            const user = userEvent.setup();
            localStorage.setItem(DRAFT_KEY, SAVED);
            const first = await open(`/teambuilder?team=${LINK}`);
            await settled(first, '/teambuilder?draft=auction&mode=moc');
            first.unmount();
            await open('/teambuilder?draft=auction&mode=moc');
            expect(slotNames()).toEqual(['Clara', null, 'Acheron', null]);
            await user.click(screen.getByRole('button', { name: 'Dismiss' }));
            expect(notice()).toBeNull();
            expect(localStorage.getItem(PREVIOUS_KEY)).toBeNull();
            expect(slotNames()).toEqual(['Clara', null, 'Acheron', null]);
        });

        // T-S14.3a-fix2 (review 2 S4): browsing shared teams does not lose the person's own.
        it('a second link while the offer is open keeps the first saved team as the previous team', async () => {
            const user = userEvent.setup();
            const SECOND = '1.kafka-0._._._.as-c-0-3000-1500';
            localStorage.setItem(DRAFT_KEY, SAVED);
            const first = await open(`/teambuilder?team=${LINK}`);
            await settled(first, '/teambuilder?draft=auction&mode=moc');
            expect(localStorage.getItem(PREVIOUS_KEY)).toBe(SAVED);
            first.unmount();
            const r = await open(`/teambuilder?team=${SECOND}`);
            await settled(r, '/teambuilder');
            expect(slotNames()).toEqual(['Kafka', null, null, null]);
            expect(localStorage.getItem(PREVIOUS_KEY)).toBe(SAVED);
            expect(notice()).toBeInTheDocument();
            await user.click(screen.getByRole('button', { name: 'Restore my previous team' }));
            expect(slotNames()).toEqual(['Pela', null, null, null]);
            await settled(r, '/teambuilder?mode=aa');
        });

        it.each([
            ['an empty saved team', '1._._._._.as-c-0-3000-1500'],
            [
                'the same team in other modes',
                '1.clara-3._.acheron-0-pastselfinmirror-2._.as-c-0-3000-1500',
            ],
        ])('no offer over %s', async (_n, saved) => {
            localStorage.setItem(DRAFT_KEY, saved);
            const r = await open(`/teambuilder?team=${LINK}`);
            await settled(r, '/teambuilder?draft=auction&mode=moc');
            expect(notice()).toBeNull();
            expect(localStorage.getItem(PREVIOUS_KEY)).toBeNull();
        });
    });
});

// T-S14.3a-pick (the user's ruling of 2026-11-17): no sheet; an empty slot points at the pool below, at every width.
describe('picking from an empty slot', () => {
    let scroll: Mock<(arg?: boolean | ScrollIntoViewOptions) => void>;
    let windowScroll: Mock<(x?: number | ScrollToOptions, y?: number) => void>;
    beforeEach(() => {
        scroll = vi.fn();
        Element.prototype.scrollIntoView = scroll;
        windowScroll = vi.fn();
        vi.spyOn(window, 'scrollTo').mockImplementation(windowScroll as typeof window.scrollTo);
    });
    afterEach(() => {
        delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    });

    const emptySlot = (n: number) =>
        screen.getByRole('button', { name: new RegExp(`^Slot ${n}, empty`) });
    const poolHeading = () => screen.getByRole('heading', { name: 'Character Pool' });
    const line = (text: string) => screen.getByText(text, { selector: 'p:not([role])' });

    it('an empty slot scrolls to the pool and moves focus to its heading, not the search field', async () => {
        const user = userEvent.setup();
        await open();
        scroll.mockClear();
        await user.click(emptySlot(3));
        expect(scroll).toHaveBeenCalledTimes(1);
        expect(scroll.mock.contexts[0]).toBe(poolHeading().closest('section'));
        expect(poolHeading()).toHaveFocus();
        expect(line('Picking for slot 3.')).toBeInTheDocument();
        // Tab goes on to the pool's search.
        await user.tab();
        expect(screen.getByRole('searchbox', { name: 'Search characters' })).toHaveFocus();
    });

    it('the next pick fills the targeted slot; the line names the slot and the count and is announced; no scroll back', async () => {
        const user = userEvent.setup();
        await open();
        await user.click(card('Acheron'));
        await user.click(emptySlot(3));
        scroll.mockClear();
        windowScroll.mockClear();
        await user.click(card('Clara'));
        expect(slotNames()).toEqual(['Acheron', null, 'Clara', null]);
        expect(line('Slot 3 filled. 2 slots left.')).toBeInTheDocument();
        await waitFor(() =>
            expect(status()).toHaveTextContent(
                'Clara added to the team. Slot 3 filled. 2 slots left.',
            ),
        );
        // The page stays at the pool: nothing scrolls and focus stays on the card.
        expect(scroll).not.toHaveBeenCalled();
        expect(windowScroll).not.toHaveBeenCalled();
        expect(card('Clara')).toHaveFocus();
        // The target was used up: the next pick goes to the first empty slot.
        await user.click(card('Pela'));
        expect(slotNames()).toEqual(['Acheron', 'Pela', 'Clara', null]);
        expect(line('Slot 2 filled. 1 slot left.')).toBeInTheDocument();
    });

    it('when the team becomes full the full-team hint takes over the line', async () => {
        const user = userEvent.setup();
        await open();
        for (const n of ['Acheron', 'Clara', 'Pela']) await user.click(card(n));
        await user.click(emptySlot(4));
        await user.click(card('Kafka'));
        expect(slotNames()).toEqual(['Acheron', 'Clara', 'Pela', 'Kafka']);
        expect(line('The team is full. Remove a character to add another.')).toBeInTheDocument();
        await waitFor(() =>
            expect(status()).toHaveTextContent(
                'Kafka added to the team. The team is full. Remove a character to add another.',
            ),
        );
    });

    it('by keyboard: Enter on an empty slot moves focus to the pool; a card picked with Enter fills that slot', async () => {
        const user = userEvent.setup();
        await open();
        emptySlot(2).focus();
        await user.keyboard('{Enter}');
        expect(poolHeading()).toHaveFocus();
        card('Clara').focus();
        await user.keyboard('{Enter}');
        expect(slotNames()).toEqual([null, 'Clara', null, null]);
        expect(card('Clara')).toHaveFocus();
    });

    it('Escape inside the pool lets go of the target; the next pick goes to the first empty slot', async () => {
        const user = userEvent.setup();
        await open();
        await user.click(emptySlot(3));
        await user.keyboard('{Escape}');
        expect(screen.queryByText('Picking for slot 3.')).toBeNull();
        await user.click(card('Clara'));
        expect(slotNames()).toEqual(['Clara', null, null, null]);
    });

    it('another empty slot changes the target', async () => {
        const user = userEvent.setup();
        await open();
        await user.click(emptySlot(2));
        await user.click(emptySlot(4));
        expect(line('Picking for slot 4.')).toBeInTheDocument();
        await user.click(card('Clara'));
        expect(slotNames()).toEqual([null, null, null, 'Clara']);
    });

    it('removing a character lets go of the target and clears the line', async () => {
        const user = userEvent.setup();
        await open();
        await user.click(card('Acheron'));
        await user.click(emptySlot(3));
        await user.click(screen.getByRole('button', { name: 'Remove Acheron' }));
        expect(screen.queryByText('Picking for slot 3.')).toBeNull();
        await user.click(card('Clara'));
        expect(slotNames()).toEqual(['Clara', null, null, null]);
    });

    it('with the pool heading already in view, focus moves without a scroll', async () => {
        vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
            top: 300,
            bottom: 320,
            left: 0,
            right: 100,
            width: 100,
            height: 20,
            x: 0,
            y: 300,
            toJSON() {},
        } as DOMRect);
        const user = userEvent.setup();
        await open();
        scroll.mockClear();
        await user.click(emptySlot(1));
        expect(scroll).not.toHaveBeenCalled();
        expect(poolHeading()).toHaveFocus();
    });

    // T-S14.3a-fix2 (review 2 M6): no animated scroll under reduced motion.
    it.each([
        [true, 'auto'],
        [false, 'smooth'],
    ])('with reduced motion %s the scroll to the pool is %s', async (reduce, behavior) => {
        Object.defineProperty(window, 'matchMedia', {
            configurable: true,
            value: (query: string) => ({
                matches: reduce && query.includes('prefers-reduced-motion'),
                media: query,
                addEventListener() {},
                removeEventListener() {},
                addListener() {},
                removeListener() {},
            }),
        });
        const user = userEvent.setup();
        await open();
        scroll.mockClear();
        await user.click(emptySlot(1));
        expect(scroll).toHaveBeenCalledWith({ block: 'start', behavior });
    });
});
