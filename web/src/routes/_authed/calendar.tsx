import { createFileRoute } from '@tanstack/react-router';
import { StandbyPage } from '@/pages/standby/StandbyPage';

export const Route = createFileRoute('/_authed/calendar')({
    component: () => <StandbyPage module="Calendar" />,
});
