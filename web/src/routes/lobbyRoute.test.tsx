import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AUTH, renderWithRouter } from '@/test/renderWithRouter';

/* T-M5b: `/lobby/$lobbyId` shows the not-found page for an id that is not a u32 (M6 notes). */

describe('/lobby/$lobbyId', () => {
    it.each(['/lobby/123', '/lobby/1', '/lobby/4294967295'])(
        '%s renders the Lobby Room placeholder',
        async (path) => {
            renderWithRouter(path, AUTH.member);
            expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent(
                'Module offline.',
            );
            expect(screen.getByText('Lobby Room')).toBeInTheDocument();
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
        expect(screen.queryByText('Lobby Room')).toBeNull();
        expect(decodeURIComponent(r.router.state.location.pathname)).toBe(decodeURIComponent(path));
    });
});
