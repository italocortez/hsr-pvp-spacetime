// ─── D-13 rolling chat window ─────────────────────────────────────────────────────────────────────────────
// A lobby keeps at most CHAT_WINDOW_SIZE ChatMessage rows. Every ChatMessage writer calls trimChatForInsert right
// before its insert: send_chat_message (reducers/lobby/chat.ts), postMemberEventChat (helpers/lobby/memberEventChat.ts,
// the member-event System lines), start_draft ("Draft has started!", reducers/draft/draftClassic.ts) (lobby audit #6 /
// #14), and, since S10r (A122(3), L16), postSystemChat (helpers/results/scoringHelpers.ts), which carries the
// stage-change lines of advance_stage (reducers/draft/postDraft.ts), the concede and defer lines
// (reducers/results/concede.ts) and the game-close line (helpers/results/gameClose.ts). The oldest rows go first, ordered by `createdDate`, never by the
// auto-increment id (CLAUDE.md §3 rule 4). Rows written in the same transaction share a createdDate; their relative
// order is then the index order, which only matters when one transaction writes more than the window.

export const CHAT_WINDOW_SIZE = 50;

/** The lobby's ChatMessage rows, oldest first (by createdDate). */
export function lobbyChatOldestFirst(ctx: any, lobbyId: number): any[] {
    return [...ctx.db.ChatMessage.lobby_id.filter(lobbyId)].sort((a: any, b: any) => {
        const da: bigint = a.createdDate.microsSinceUnixEpoch;
        const db: bigint = b.createdDate.microsSinceUnixEpoch;
        return da < db ? -1 : da > db ? 1 : 0;
    });
}

/**
 * Deletes the oldest rows so that one more insert leaves the lobby at CHAT_WINDOW_SIZE rows at most. `sorted` is the
 * lobby's rows oldest first when the caller already read them (lobbyChatOldestFirst); otherwise they are read here.
 */
export function trimChatForInsert(ctx: any, lobbyId: number, sorted?: any[]): void {
    const rows = sorted ?? lobbyChatOldestFirst(ctx, lobbyId);
    const excess = rows.length - (CHAT_WINDOW_SIZE - 1);
    for (let i = 0; i < excess; i++) {
        ctx.db.ChatMessage.id.delete(rows[i].id);
    }
}
