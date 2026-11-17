import { createFileRoute } from '@tanstack/react-router';
import { TeamBuilderPage } from '@/pages/teambuilder/TeamBuilderPage';
import { parseTeamBuilderSearch } from '@/pages/teambuilder/teambuilderSearch';

export const Route = createFileRoute('/teambuilder')({
    validateSearch: parseTeamBuilderSearch,
    search: {
        // As /costs: validate the final search so an unknown key never stays in the address.
        middlewares: [({ search, next }) => parseTeamBuilderSearch(next(search))],
    },
    component: TeamBuilderRoute,
});

function TeamBuilderRoute() {
    const search = Route.useSearch();
    return <TeamBuilderPage search={search} />;
}
