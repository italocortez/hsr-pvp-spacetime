import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AUTH, renderWithRouter } from '@/test/renderWithRouter';

/*
 * T-M5b: `/lobby/$lobbyId` shows the not-found page for an id that is not a u32 (M6 notes). T-S14.4c: a valid id
 * shows the lobby placeholder (here, with no connection, its "opening" state) instead of the standby block.
 */

describe('/lobby/$lobbyId', () => {
    it.each(['/lobby/123', '/lobby/1', '/lobby/4294967295'])(
        '%s renders the lobby placeholder',
        async (path) => {
            renderWithRouter(path, AUTH.member);
            expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent(
                'Opening the lobby.',
            );
            expect(screen.getByText('Connecting to the server…')).toBeInTheDocument();
        },
    );

    it.each([
        '/lobby/abc',
        '/lobby/0',
        '/lobby/007',
        '/lobby/4294967296',
        '/lobby/-1',
        '/lobby/1.5',
        '/lobby/1e3',
        '/lobby/%201',
    ])('%s shows "Lobby not found" and keeps the path', async (path) => {
        const r = renderWithRouter(path, AUTH.member);
        expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent(
            'Lobby not found.',
        );
        expect(screen.queryByText('Connecting to the server…')).toBeNull();
        expect(decodeURIComponent(r.router.state.location.pathname)).toBe(decodeURIComponent(path));
    });
});
