import { createFileRoute } from '@tanstack/react-router';
import { StandbyPage } from '@/pages/standby/StandbyPage';
import { parseStandbySearch } from '@/pages/standby/standbySearch';

export const Route = createFileRoute('/standby')({
    validateSearch: parseStandbySearch,
    component: StandbyRoute,
});

function StandbyRoute() {
    const { module } = Route.useSearch();
    return <StandbyPage module={module} />;
}
