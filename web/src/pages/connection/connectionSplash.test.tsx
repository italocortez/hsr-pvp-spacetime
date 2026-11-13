import {
    createMemoryHistory,
    createRootRoute,
    createRouter,
    RouterProvider,
} from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { MaintenancePage } from './MaintenancePage';
import { OfflinePage } from './OfflinePage';

/*
 * The two connection splashes (M6 brief item 8). Each renders the brand link, so it is mounted as
 * the only route of a throwaway router.
 */
function renderPage(page: ReactNode) {
    const router = createRouter({
        routeTree: createRootRoute({ component: () => page }),
        history: createMemoryHistory({ initialEntries: ['/'] }),
    });
    return render(<RouterProvider router={router} />);
}

async function expectSplash(headline: string, eyebrow: string, chip: string, onRetry: () => void) {
    const heading = await screen.findByRole('heading', { level: 1 });
    expect(heading).toHaveTextContent(headline);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getAllByRole('main')).toHaveLength(1);
    expect(screen.getByText(eyebrow)).toBeInTheDocument();
    expect(screen.getByText(chip)).toBeInTheDocument();
    // One action: Retry (no "Return to Base" link).
    expect(screen.queryByRole('link', { name: 'Return to Base' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
}

describe('connection splashes', () => {
    it('offline: one main, one h1 "Connection lost.", the lede, and Retry', async () => {
        const onRetry = vi.fn();
        renderPage(<OfflinePage onRetry={onRetry} />);
        await expectSplash('Connection lost.', 'Error // Offline', 'SYS://OFFLINE', onRetry);
        expect(
            screen.getByText(
                'The link to the IPC servers is down. Check your connection and try again.',
            ),
        ).toBeInTheDocument();
        expect(document.title).toBe('Connection lost — IPC Battlegrounds');
    });

    it('maintenance: one main, one h1 "Under maintenance.", the module text, and Retry', async () => {
        const onRetry = vi.fn();
        renderPage(<MaintenancePage onRetry={onRetry} />);
        await expectSplash(
            'Under maintenance.',
            'Status // Maintenance',
            'SYS://MAINTENANCE',
            onRetry,
        );
        expect(
            screen.getByText('The site is in maintenance. Please try again later.'),
        ).toBeInTheDocument();
        expect(document.title).toBe('Under maintenance — IPC Battlegrounds');
    });
});
