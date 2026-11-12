import { createFileRoute } from '@tanstack/react-router';
import { parseLoginSearch } from '@/auth/loginSearch';
import { StandbyPage } from '@/pages/standby/StandbyPage';

// `?login=1&next=` is set by the guards; the login prompt that reads it comes with M5.
export const Route = createFileRoute('/')({
    validateSearch: parseLoginSearch,
    component: () => <StandbyPage />,
});
