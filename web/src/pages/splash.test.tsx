import {
    createMemoryHistory,
    createRootRoute,
    createRouter,
    RouterProvider,
} from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { NoAccessPage } from '@/pages/no-access/NoAccessPage';
import { NotFoundPage } from '@/pages/not-found/NotFoundPage';
import { StandbyPage } from '@/pages/standby/StandbyPage';

/*
 * The three splash screens (docs/frontend/pages.md: Standby, Not found, No access). Each page
 * renders router links, so it is mounted as the only route of a throwaway router.
 */
function renderPage(page: ReactNode) {
    const router = createRouter({
        routeTree: createRootRoute({ component: () => page }),
        history: createMemoryHistory({ initialEntries: ['/'] }),
    });
    return render(<RouterProvider router={router} />);
}

/** One `main`, one `h1` with the headline, and the "Return to Base" link to `/`. */
async function expectSplash(headline: string) {
    const heading = await screen.findByRole('heading', { level: 1 });
    expect(heading).toHaveTextContent(headline);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getAllByRole('main')).toHaveLength(1);
    const back = screen.getByRole('link', { name: 'Return to Base' });
    expect(back).toHaveAttribute('href', '/');
}

describe('splash pages', () => {
    it('standby: one main, one h1 "Module offline.", a link back to base', async () => {
        renderPage(<StandbyPage />);
        await expectSplash('Module offline.');
        expect(document.title).toBe('Standby — IPC Battlegrounds');
    });

    it('standby with a module: the pill names it and the title carries it', async () => {
        renderPage(<StandbyPage module="Tournaments" />);
        await expectSplash('Module offline.');
        expect(screen.getByText('Tournaments')).toBeInTheDocument();
        expect(document.title).toBe('Tournaments — Standby — IPC Battlegrounds');
    });

    it('standby renders a module name with markup in it as text, creating no element', async () => {
        const markup = '<img src=x onerror="alert(1)"><b>bold</b>';
        const { container } = renderPage(<StandbyPage module={markup} />);
        await expectSplash('Module offline.');
        // Only the page's own art image exists; no <img> or <b> came from the name.
        expect(container.querySelectorAll('img')).toHaveLength(1);
        expect(container.querySelector('b')).toBeNull();
        // The name is cut to 40 code points, so compare against the text actually shown.
        const shown = screen.getByText((text) => text.startsWith('<img src=x'));
        expect(shown.children).toHaveLength(0);
        expect(shown.textContent).toBe(`${Array.from(markup).slice(0, 40).join('')}…`);
    });

    it('not found (default): one main, one h1 "Page not found.", a link back to base', async () => {
        renderPage(<NotFoundPage />);
        await expectSplash('Page not found.');
        expect(screen.getByText(/no record of this route/)).toBeInTheDocument();
        expect(document.title).toBe('Page not found — IPC Battlegrounds');
    });

    it('not found with what="Lobby": the wording names the lobby', async () => {
        renderPage(<NotFoundPage what="Lobby" />);
        await expectSplash('Lobby not found.');
        expect(screen.getByText(/no record of this lobby\./)).toBeInTheDocument();
        expect(document.title).toBe('Lobby not found — IPC Battlegrounds');
    });

    it('no access: one main, one h1 "Access denied.", a link back to base', async () => {
        renderPage(<NoAccessPage />);
        await expectSplash('Access denied.');
        expect(document.title).toBe('Access denied — IPC Battlegrounds');
    });
});
