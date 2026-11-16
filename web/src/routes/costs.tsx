import { createFileRoute } from '@tanstack/react-router';
import { CostsPage } from '@/pages/costs/CostsPage';
import { parseCostsSearch } from '@/pages/costs/costsSearch';

export const Route = createFileRoute('/costs')({
    validateSearch: parseCostsSearch,
    search: {
        // The router merges the raw search under the validated one, so an unknown key
        // (`?foo=bar`) would stay in the address and ride along into every later change and the
        // "Sign in" link's `next`. Validating the final search keeps the page's own keys only, and
        // the router rewrites the address bar on load.
        middlewares: [({ search, next }) => parseCostsSearch(next(search))],
    },
    component: CostsRoute,
});

function CostsRoute() {
    const search = Route.useSearch();
    return <CostsPage search={search} />;
}
