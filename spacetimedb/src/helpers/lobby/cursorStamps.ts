/**
 * S11a (triage L19): removes the `LobbyCursorStamp` row of one member, or of every member of the lobby when `userId`
 * is omitted (lobby_id index).
 */
export function deleteCursorStamps(ctx: any, lobbyId: number, userId?: number): void {
    if (userId !== undefined) {
        ctx.db.LobbyCursorStamp.by_lobby_and_user.delete([lobbyId, userId]);
        return;
    }
    for (const s of [...ctx.db.LobbyCursorStamp.lobby_id.filter(lobbyId)]) {
        ctx.db.LobbyCursorStamp.by_lobby_and_user.delete([lobbyId, s.userId]);
    }
}
