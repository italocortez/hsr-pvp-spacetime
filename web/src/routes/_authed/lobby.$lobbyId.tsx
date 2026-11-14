import { createFileRoute } from '@tanstack/react-router';
import { parseLobbyId } from '@/lib/lobbyId';
import { NotFoundPage } from '@/pages/not-found/NotFoundPage';
import { StandbyPage } from '@/pages/standby/StandbyPage';

export const Route = createFileRoute('/_authed/lobby/$lobbyId')({
    component: LobbyRoute,
});

/** A `$lobbyId` that is not a `u32` in decimal digits is a missing lobby (M6 notes). */
function LobbyRoute() {
    const { lobbyId } = Route.useParams();
    return parseLobbyId(lobbyId) === undefined ? (
        <NotFoundPage what="Lobby" />
    ) : (
        <StandbyPage module="Lobby Room" />
    );
}
