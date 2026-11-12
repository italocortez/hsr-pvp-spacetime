import { createFileRoute } from '@tanstack/react-router';
import { StandbyPage } from '@/pages/standby/StandbyPage';

export const Route = createFileRoute('/_authed/tournaments')({
    component: () => <StandbyPage module="Tournaments" />,
});
