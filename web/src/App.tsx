import { NotFoundPage } from '@/pages/not-found/NotFoundPage';
import { StandbyPage } from '@/pages/standby/StandbyPage';

// Temporary path switch: M4 replaces it with the TanStack Router route tree.
export function App() {
    const path = window.location.pathname;
    return path === '/' || path === '/standby' ? <StandbyPage /> : <NotFoundPage />;
}
