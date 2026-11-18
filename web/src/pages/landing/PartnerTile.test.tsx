import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDiscordInviteCacheForTests } from '@/lib/useDiscordInviteIcon';
import { PartnerTile } from './PartnerTile';
import { partnerInitials } from './partners';

/*
 * T-LANDING (S14.4a), reworked by T-S14.4p: a partner tile shows the name and the line from the
 * `partner_server` row, links to its invite in a new tab, and shows the server's current Discord
 * icon from the (mocked) invite lookup; until it is known, on any failure and when the server has
 * no icon, the name's initials. `fetch` is mocked; nothing reaches Discord.
 */

const GUILD = '1234567890123456789';
const HASH = '0123456789abcdef0123456789abcdef';
const ICON = `https://cdn.discordapp.com/icons/${GUILD}/${HASH}.webp?size=128`;
const GENIUS = {
    name: 'Genius Society',
    inviteCode: 'HbXErzYVQ5',
    description: 'Relic manipulators and build makers',
};

const answer = (guild: unknown) =>
    ({ ok: true, json: () => Promise.resolve({ guild }) }) as Response;

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
    resetDiscordInviteCacheForTests();
    sessionStorage.clear();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

/** Waits for the lookup to settle (one request made, its answer applied). */
async function settled() {
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 0));
}

describe('PartnerTile', () => {
    it('the icon from the lookup: a plain decorative img (lazy, 112 by 112, no referrer), no initials', async () => {
        fetchMock.mockResolvedValue(answer({ id: GUILD, icon: HASH }));
        const { container } = render(<PartnerTile partner={GENIUS} />);
        // The initials while the lookup runs.
        expect(screen.getByText('GS')).toHaveAttribute('aria-hidden', 'true');
        await waitFor(() => expect(container.querySelector('img')).not.toBeNull());
        const img = container.querySelector('img') as HTMLImageElement;
        expect(img).toHaveAttribute('src', ICON);
        expect(img).toHaveAttribute('alt', '');
        expect(img).toHaveAttribute('loading', 'lazy');
        expect(img).toHaveAttribute('width', '112');
        expect(img).toHaveAttribute('height', '112');
        expect(img).toHaveAttribute('referrerpolicy', 'no-referrer');
        // Not RemoteImage: no CORS mode.
        expect(img).not.toHaveAttribute('crossorigin');
        expect(screen.queryByText('GS')).toBeNull();
    });

    it.each([
        ['a failed lookup', () => Promise.reject(new TypeError('Failed to fetch'))],
        ['a malformed answer', () => Promise.resolve(answer({ id: 'x', icon: HASH }))],
        ['a server without an icon', () => Promise.resolve(answer({ id: GUILD, icon: null }))],
    ])('%s: the initials, no image', async (_label, reply) => {
        fetchMock.mockImplementation(reply);
        const { container } = render(<PartnerTile partner={GENIUS} />);
        await settled();
        expect(container.querySelector('img')).toBeNull();
        expect(screen.getByText('GS')).toHaveAttribute('aria-hidden', 'true');
    });

    it('an icon that fails to load falls back to the initials', async () => {
        fetchMock.mockResolvedValue(answer({ id: GUILD, icon: HASH }));
        const { container } = render(<PartnerTile partner={GENIUS} />);
        await waitFor(() => expect(container.querySelector('img')).not.toBeNull());
        fireEvent.error(container.querySelector('img') as HTMLImageElement);
        expect(container.querySelector('img')).toBeNull();
        expect(screen.getByText('GS')).toBeInTheDocument();
    });

    it('the name and the line from the row (never from Discord); Join opens the invite in a new tab', async () => {
        fetchMock.mockResolvedValue(
            answer({ id: GUILD, icon: HASH, name: 'Some Other Name From Discord' }),
        );
        render(<PartnerTile partner={GENIUS} />);
        await settled();
        expect(screen.queryByText('Some Other Name From Discord')).toBeNull();
        const link = screen.getByRole('link', { name: /Genius Society.*Join/ });
        expect(link).toHaveAttribute('href', 'https://discord.com/invite/HbXErzYVQ5');
        expect(link).toHaveAttribute('target', '_blank');
        expect(link).toHaveAttribute('rel', 'noopener noreferrer');
        expect(link).toHaveTextContent('Relic manipulators and build makers');
        expect(link).toHaveTextContent('opens in a new tab');
    });

    it('an empty description renders no line', async () => {
        fetchMock.mockRejectedValue(new TypeError('offline'));
        const { container } = render(<PartnerTile partner={{ ...GENIUS, description: '' }} />);
        await settled();
        const link = screen.getByRole('link');
        // Initials, name and Join only.
        expect(link.children).toHaveLength(3);
        expect(container).toHaveTextContent('Genius Society');
    });

    it('initials: first letters of up to two words', () => {
        expect(partnerInitials('Genius Society')).toBe('GS');
        expect(partnerInitials('Yujicord')).toBe('Y');
        expect(partnerInitials('  solar  system  open ')).toBe('SS');
    });
});
