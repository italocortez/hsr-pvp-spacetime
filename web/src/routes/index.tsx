import { createFileRoute } from '@tanstack/react-router';
import { SignInPage } from '@/pages/sign-in/SignInPage';
import { parseIndexSearch } from '@/pages/sign-in/signInSearch';
import { StandbyPage } from '@/pages/standby/StandbyPage';

// `?login=1&next=` is set by the guards; `status` by the login function's return (M5b).
export const Route = createFileRoute('/')({
    validateSearch: parseIndexSearch,
    component: IndexRoute,
});

function IndexRoute() {
    const { login, next, status } = Route.useSearch();
    return login ? <SignInPage next={next} status={status} /> : <StandbyPage />;
}
