import { createFileRoute } from '@tanstack/react-router';
import { StandbyPage } from '@/pages/standby/StandbyPage';

export const Route = createFileRoute('/lobbies')({
    component: () => <StandbyPage module="Lobbies" />,
});
