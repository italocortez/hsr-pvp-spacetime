import { createFileRoute } from '@tanstack/react-router';
import { parseLobbyId } from '@/lib/lobbyId';
import { LobbyPlaceholder } from '@/pages/lobby-room/LobbyPlaceholder';
import { NotFoundPage } from '@/pages/not-found/NotFoundPage';

export const Route = createFileRoute('/_authed/lobby/$lobbyId')({
    // A bad id renders the not-found splash, outside the app shell (S14.1).
    staticData: { splash: ({ params }) => parseLobbyId(params.lobbyId) === undefined },
    component: LobbyRoute,
});

/**
 * A `$lobbyId` that is not a `u32` in decimal digits is a missing lobby (M6 notes); a valid one shows the lobby
 * placeholder (S14.4c) until the lobby room exists (S14.7).
 */
function LobbyRoute() {
    const { lobbyId } = Route.useParams();
    const id = parseLobbyId(lobbyId);
    return id === undefined ? (
        <NotFoundPage what="Lobby" />
    ) : (
        <LobbyPlaceholder key={id} lobbyId={id} />
    );
}
