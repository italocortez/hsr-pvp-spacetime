import { createFileRoute } from '@tanstack/react-router';
import { StandbyPage } from '@/pages/standby/StandbyPage';
import { parseStandbySearch } from '@/pages/standby/standbySearch';

export const Route = createFileRoute('/standby')({
    validateSearch: parseStandbySearch,
    // The full-screen standby splash, outside the app shell (S14.1).
    staticData: { splash: true },
    component: StandbyRoute,
});

function StandbyRoute() {
    const { module } = Route.useSearch();
    return <StandbyPage module={module} />;
}
