import { insertWithAudit, updateWithAudit } from './auditHelpers';
import { buildAuctionBanSequence, buildClassicSequence } from './draftSequences';

// ─── BACKEND-BUGS F2: one initializer for a game's draft state ─────────────────────────────────────────────
// start_draft (game 1, no session yet) and advance_to_next_game (game N + 1, existing session) both call this, so
// the per-game draft state cannot drift between them again: the draft sequence (Classic picks + bans, or the
// Auction ban-only prefix, D-48), turnIndex, the auction phase flag, the nominator / bid team, the auction
// nomination, characters won, both budgets, the timer and the pause counters.
//
// Game 1 (no session): inserts the MatchSession with currentGameNumber 1, seriesBestOf from the lobby and the
// A27 head start: gamesWonBlue = 1 when lobby.bestOfNAdvantage is Blue, gamesWonRed = 1 when Red (the magnitude is
// 0 or 1 under the {1, 3} cap, A28).
// Later games (session given): keeps gamesWonBlue / gamesWonRed and seriesBestOf, increments currentGameNumber.
// Returns the draft sequence that was written.

export function initSessionForGame(ctx: any, lobby: any, session: any | undefined, actorId: number): any[] {
    const sequence = lobby.draftMode.tag === 'Classic'
        ? buildClassicSequence(lobby.banMode.tag, lobby.lineupFormat.tag) // A21: Thirds = 12 picks per team
        : buildAuctionBanSequence(lobby.banMode.tag); // bans only; the Auction count is isAuctionComplete's (draftAuction.ts)

    const gameState = {
        turnIndex: 0,
        draftSequence: sequence,
        timerState: {
            turnStartAt: ctx.timestamp,
            teamBlueReserveMs: lobby.reserveBankSeconds * 1000,
            teamRedReserveMs: lobby.reserveBankSeconds * 1000,
            isPaused: false,
            accumulatedPauseMs: 0,
        },
        // Auction with no bans opens the auction phase immediately (D-48).
        isAuctionPhase: lobby.draftMode.tag === 'Auction' && sequence.length === 0,
        nextNominatorTeam: { tag: 'Blue' },
        blueCharactersWon: 0,
        redCharactersWon: 0,
        currentNomination: undefined,
        currentBidAmount: undefined,
        currentBidTeam: { tag: 'Spectator' },
        teamBlueCharBudget: lobby.characterBudget,
        teamRedCharBudget: lobby.characterBudget,
        teamBlueLcBudget: lobby.lightconeBudget,
        teamRedLcBudget: lobby.lightconeBudget,
        pausesUsedBlue: 0,
        pausesUsedRed: 0,
    };

    if (session) {
        ctx.db.MatchSession.lobbyId.update(updateWithAudit(ctx, session, {
            ...gameState,
            currentGameNumber: session.currentGameNumber + 1,
        }, actorId));
    } else {
        const advantage = lobby.bestOfNAdvantage?.tag ?? 'None';
        ctx.db.MatchSession.insert(insertWithAudit(ctx, {
            lobbyId: lobby.id,
            ...gameState,
            currentGameNumber: 1,
            gamesWonBlue: advantage === 'Blue' ? 1 : 0,
            gamesWonRed: advantage === 'Red' ? 1 : 0,
            seriesBestOf: lobby.bestOf || 1,
        }, actorId));
    }
    return sequence;
}
