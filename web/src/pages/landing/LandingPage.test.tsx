import { tables } from '@bindings/index';
import type { PartnerServer } from '@bindings/types';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { toSql } from 'spacetimedb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetDiscordInviteCacheForTests } from '@/lib/useDiscordInviteIcon';
import { LAYER0_QUERIES } from '@/stdb/layer0';
import { MockConnection, MockTable } from '@/test/mockConnection';
import { renderWithConnection } from '@/test/renderWithConnection';
import { AUTH, renderWithRouter } from '@/test/renderWithRouter';
import { LANDING_TITLE } from './LandingPage';
import { PARTNER_SERVERS_QUERY } from './usePartnerServers';

/*
 * T-LANDING (S14.4a): the landing page at `/` through the real route tree: its sections and
 * headings, every link target and the copy pill's success and failure paths. T-S14.4p: the
 * partner tiles come from the public `partner_server` table (a route subscription of `/`, beside
 * Layer 0 only), in position order, hidden while there are none; each icon comes from a mocked
 * Discord lookup (`fetch` is mocked; nothing reaches Discord).
 */

const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
afterEach(() => {
    if (original) Object.defineProperty(navigator, 'clipboard', original);
    else delete (navigator as { clipboard?: unknown }).clipboard;
});

function stubClipboard(writeText: (text: string) => Promise<void>) {
    const spy = vi.fn(writeText);
    Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: spy },
        configurable: true,
    });
    return spy;
}

async function renderLanding() {
    const rendered = renderWithRouter('/', AUTH.visitor);
    await screen.findByRole('heading', { level: 1, name: 'IPC Battlegrounds' });
    return rendered;
}

const copyButton = () => screen.getByRole('button', { name: 'Copy Discord username @nathyron' });
const status = () => within(copyButton().parentElement as HTMLElement).getByRole('status');

describe('the landing page at /', () => {
    it('renders the hero, the four feature cards, the contact block and the footer under one h1', async () => {
        await renderLanding();
        expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
        expect(screen.getByText('Draft. Battle. Win.')).toBeInTheDocument();
        expect(
            screen.getByRole('heading', {
                level: 2,
                name: 'The whole competitive stack. In one page.',
            }),
        ).toBeInTheDocument();
        expect(screen.getByRole('heading', { level: 2, name: 'Get in Touch' })).toBeInTheDocument();
        for (const title of [
            'Two ways to draft.',
            'Tournaments',
            'Balance & Cost Tables',
            'Team Builder',
        ]) {
            expect(screen.getByRole('heading', { level: 3, name: title })).toBeInTheDocument();
        }
        // No connection here, so no partner rows: the partner block is hidden.
        expect(screen.queryByRole('heading', { level: 3, name: 'Partner Communities' })).toBeNull();
        expect(screen.getByRole('region', { name: 'IPC Battlegrounds' })).toBeInTheDocument();
        expect(screen.getByRole('contentinfo')).toHaveTextContent('IPC Authorized Build');
        await waitFor(() => expect(document.title).toBe(LANDING_TITLE));
    });

    it('the hero image loads first with its size; every other image is lazy with its size', async () => {
        const { container } = await renderLanding();
        const images = [...container.querySelectorAll('main img')];
        // The hero, card 01's two halves, cards 02 to 04 (no partner rows without a connection).
        expect(images).toHaveLength(6);
        const [hero, ...rest] = images;
        expect(hero).toHaveAttribute('fetchpriority', 'high');
        expect(hero).not.toHaveAttribute('loading');
        for (const img of images) {
            expect(img).toHaveAttribute('width');
            expect(img).toHaveAttribute('height');
        }
        for (const img of rest) expect(img).toHaveAttribute('loading', 'lazy');
    });

    it('links: Play Now and card 01 to /lobbies, 02 /tournaments, 03 /costs, 04 /teambuilder', async () => {
        await renderLanding();
        const main = within(screen.getByRole('main'));
        expect(main.getByRole('link', { name: 'Play Now' })).toHaveAttribute('href', '/lobbies');
        expect(main.getByRole('link', { name: /Two ways to draft\./ })).toHaveAttribute(
            'href',
            '/lobbies',
        );
        expect(main.getByRole('link', { name: /Bracket System/ })).toHaveAttribute(
            'href',
            '/tournaments',
        );
        expect(main.getByRole('link', { name: /Balance & Cost Tables/ })).toHaveAttribute(
            'href',
            '/costs',
        );
        expect(main.getByRole('link', { name: /Stress-test compositions/ })).toHaveAttribute(
            'href',
            '/teambuilder',
        );
    });

    it('the copy pill copies "nathyron", shows Copied! and says so; the state clears after 2s', async () => {
        const writeText = stubClipboard(() => Promise.resolve());
        await renderLanding();
        vi.useFakeTimers({ shouldAdvanceTime: true });
        try {
            fireEvent.click(copyButton());
            await waitFor(() => expect(copyButton()).toHaveAttribute('data-state', 'copied'));
            expect(writeText).toHaveBeenCalledWith('nathyron');
            expect(copyButton()).toHaveTextContent('Copied!');
            expect(status()).toHaveTextContent('Copied @nathyron to clipboard');
            expect(copyButton()).toBeEnabled();

            act(() => vi.advanceTimersByTime(2000));
            expect(copyButton()).toHaveAttribute('data-state', 'idle');
            expect(copyButton()).toHaveTextContent('Click to copy');
            expect(status()).toBeEmptyDOMElement();
        } finally {
            vi.useRealTimers();
        }
    });

    it('a refused clipboard shows and says the failure', async () => {
        stubClipboard(() => Promise.reject(new Error('NotAllowedError')));
        await renderLanding();
        fireEvent.click(copyButton());
        await waitFor(() => expect(copyButton()).toHaveAttribute('data-state', 'failed'));
        expect(copyButton()).toHaveTextContent('Copy failed');
        expect(status()).toHaveTextContent('Could not copy @nathyron');
    });

    it('no clipboard API at all is the failure path too', async () => {
        Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
        await renderLanding();
        fireEvent.click(copyButton());
        await waitFor(() => expect(copyButton()).toHaveAttribute('data-state', 'failed'));
        expect(status()).toHaveTextContent('Could not copy @nathyron');
    });
});

const GUILD = '1234567890123456789';
const HASH = '0123456789abcdef0123456789abcdef';

function partnerRow(over: Partial<PartnerServer>): PartnerServer {
    return {
        id: 1,
        name: 'Genius Society',
        inviteCode: 'HbXErzYVQ5',
        description: '',
        position: 0,
        ...over,
    };
}

/** A mock connection with the partner table (the earlier steps' mock has none). */
function connectionWithPartners(...rows: PartnerServer[]) {
    const conn = new MockConnection();
    const partners = new MockTable<PartnerServer>();
    partners.seed(...rows);
    Object.assign(conn.db, { partnerServer: partners });
    return { conn, partners };
}

const partnerList = () =>
    screen.getByRole('heading', { level: 3, name: 'Partner Communities' })
        .nextElementSibling as HTMLElement;

describe('the landing page and the database', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        resetDiscordInviteCacheForTests();
        sessionStorage.clear();
    });

    it('the partner query is the SQL the SDK writes for the table', () => {
        expect(PARTNER_SERVERS_QUERY).toBe(toSql(tables.partnerServer));
    });

    it('/ subscribes Layer 0 and the partner table only, before and after its results arrive; leaving drops the partner subscription', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(() => new Promise(() => {})),
        );
        const { conn } = connectionWithPartners();
        const { router } = renderWithConnection('/', conn);
        await screen.findByRole('heading', { level: 1, name: 'IPC Battlegrounds' });
        // Distinct queries: StrictMode may mount, drop and remount a subscription. The mock has
        // no suspension table, so Layer 0 subscribes the profile and lobbies views on it.
        const distinct = (queries: string[]) => [...new Set(queries)].sort();
        const expected = [
            LAYER0_QUERIES.lobbies,
            LAYER0_QUERIES.profile,
            PARTNER_SERVERS_QUERY,
        ].sort();
        await waitFor(() => expect(distinct(conn.liveQueries())).toEqual(expected));
        act(() => conn.applyAll());
        await screen.findByRole('link', { name: 'Play Now' });
        expect(distinct(conn.liveQueries())).toEqual(expected);
        // Every subscription ever made on this page, ended ones included.
        expect(distinct(conn.subscriptions.map((s) => s.query))).toEqual(expected);
        // One live partner subscription, not one per mount.
        expect(conn.liveQueries().filter((q) => q === PARTNER_SERVERS_QUERY)).toHaveLength(1);

        act(() => {
            void router.navigate({ to: '/lobbies' });
        });
        await waitFor(() => expect(conn.liveQueries()).not.toContain(PARTNER_SERVERS_QUERY));
    });

    it('zero rows: the partner block is hidden (and so while the rows have not arrived)', async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        const { conn } = connectionWithPartners();
        renderWithConnection('/', conn);
        await screen.findByRole('heading', { level: 1, name: 'IPC Battlegrounds' });
        expect(screen.queryByRole('heading', { name: 'Partner Communities' })).toBeNull();
        act(() => conn.applyAll());
        await screen.findByRole('link', { name: 'Play Now' });
        expect(screen.queryByRole('heading', { name: 'Partner Communities' })).toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rows render in position order (then id); each tile joins its invite and shows its icon from the lookup', async () => {
        const fetchMock = vi.fn((url: string) =>
            Promise.resolve({
                ok: true,
                json: () =>
                    Promise.resolve(
                        url.endsWith('/HbXErzYVQ5')
                            ? { guild: { id: GUILD, icon: HASH } }
                            : { guild: { id: GUILD, icon: null } },
                    ),
            } as Response),
        );
        vi.stubGlobal('fetch', fetchMock);
        const { conn, partners } = connectionWithPartners(
            partnerRow({ id: 9, name: 'Third', inviteCode: 'third-1', position: 2 }),
            partnerRow({
                id: 4,
                name: 'Genius Society',
                description: 'Relic manipulators and build makers',
                position: 0,
            }),
            partnerRow({ id: 2, name: 'Second B', inviteCode: 'second-b', position: 1 }),
            partnerRow({ id: 1, name: 'Second A', inviteCode: 'second-a', position: 1 }),
        );
        renderWithConnection('/', conn);
        await screen.findByRole('heading', { level: 1, name: 'IPC Battlegrounds' });
        act(() => conn.apply(PARTNER_SERVERS_QUERY));

        const tiles = await waitFor(() => within(partnerList()).getAllByRole('listitem'));
        expect(
            tiles.map((t) => within(t).getByRole('link').querySelector('span + span')?.textContent),
        ).toEqual(['Genius Society', 'Second A', 'Second B', 'Third']);
        const join = within(tiles[0] as HTMLElement).getByRole('link', {
            name: /Genius Society.*Join/,
        });
        expect(join).toHaveAttribute('href', 'https://discord.com/invite/HbXErzYVQ5');
        expect(join).toHaveAttribute('target', '_blank');
        expect(join).toHaveAttribute('rel', 'noopener noreferrer');
        expect(join).toHaveTextContent('Relic manipulators and build makers');

        await waitFor(() =>
            expect((tiles[0] as HTMLElement).querySelector('img')).toHaveAttribute(
                'src',
                `https://cdn.discordapp.com/icons/${GUILD}/${HASH}.webp?size=128`,
            ),
        );
        // The others have no icon: their initials.
        expect((tiles[3] as HTMLElement).querySelector('img')).toBeNull();
        expect(within(tiles[3] as HTMLElement).getByText('T')).toBeInTheDocument();
        expect(fetchMock).toHaveBeenCalledTimes(4);

        // A row removed live: its tile goes; the last one removed hides the block.
        act(() => {
            for (const row of [...partners.rows]) partners.delete(row);
        });
        await waitFor(() =>
            expect(screen.queryByRole('heading', { name: 'Partner Communities' })).toBeNull(),
        );
    });
});
