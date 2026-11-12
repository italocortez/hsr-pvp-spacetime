import { createFileRoute } from '@tanstack/react-router';
import { StandbyPage } from '@/pages/standby/StandbyPage';

export const Route = createFileRoute('/teambuilder')({
    component: () => <StandbyPage module="Team Builder" />,
});
