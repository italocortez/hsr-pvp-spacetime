import { createFileRoute } from '@tanstack/react-router';
import { StandbyPage } from '@/pages/standby/StandbyPage';

export const Route = createFileRoute('/_authed/lobby/$lobbyId')({
    component: () => <StandbyPage module="Lobby Room" />,
});
