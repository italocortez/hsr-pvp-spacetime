import { slotIsCoach, slotTeam } from './lobbyHelpers';

/**
 * Validates that the user owns the specified character on their selected match account(s).
 * Returns { valid: true } if owned or if ownership check is disabled.
 * D-14: Checks characters from LobbyMemberAccount entries only (not all locked TPA entries).
 * Both tournament and non-tournament paths use the same code path (D-09 consistency).
 */
export function validateCharacterOwnership(
    ctx: any,
    userId: number,
    characterName: string,
    lobbyId: number
): { valid: boolean; reason?: string } {
    // Look up the Lobby
    const lobby = ctx.db.Lobby.id.find(lobbyId);
    if (!lobby || !lobby.requireOwnership) {
        // Ownership check disabled or lobby not found
        return { valid: true };
    }

    // D-14: Check characters from LobbyMemberAccount entries only
    const selectedAccounts = [...ctx.db.LobbyMemberAccount.by_lobby_and_user.filter([lobbyId, userId])];

    if (selectedAccounts.length === 0) {
        // No accounts selected — ownership cannot be validated
        return { valid: false, reason: 'No account selected for this match.' };
    }

    // D-12: Union of characters across all selected accounts
    for (const lma of selectedAccounts) {
        const character = [...ctx.db.HsrAccountCharacter.by_account_and_character.filter([lma.hsrAccountId, characterName])][0];
        if (character) {
            return { valid: true };
        }
    }

    return { valid: false, reason: 'You do not own this character on any selected account.' };
}

/**
 * CH-S6 / ACCESS-SECURITY-OPS D.8.7: the eidolon of a pick when the lobby requires ownership. The server
 * takes the highest HsrAccountCharacter.eidolonLevel of the character across the member's selected match accounts
 * (LobbyMemberAccount) and ignores the client's argument, so a player cannot declare E0 to pay less and play E6.
 * 0 when none of the selected accounts has the character (pick_character rejects that case first through
 * validateCharacterOwnership; nominate_character, which has no ownership check, records E0).
 * The value lands in the Pick / AuctionSold payload, which is the scoring input (A21 tie-break 3), so later roster
 * edits change nothing.
 */
export function resolveOwnedEidolon(ctx: any, lobbyId: number, userId: number, characterName: string): number {
    let eidolon = 0;
    for (const lma of ctx.db.LobbyMemberAccount.by_lobby_and_user.filter([lobbyId, userId])) {
        const row = [...ctx.db.HsrAccountCharacter.by_account_and_character.filter([lma.hsrAccountId, characterName])][0];
        if (row && row.eidolonLevel > eidolon) eidolon = row.eidolonLevel;
    }
    return eidolon;
}

/**
 * A60(1) / A61(2)(3): the eidolon levels a team owns for a character: the distinct HsrAccountCharacter.eidolonLevel
 * values across the selected match accounts (LobbyMemberAccount) of the team's player seats (coaches and spectators
 * excluded), ascending. Empty when no selected account of the team has the character. Account selection is allowed
 * only in Waiting (A67(1)), so the set is frozen during the game.
 */
export function teamOwnedEidolons(ctx: any, lobbyId: number, side: string, characterName: string): number[] {
    const levels = new Set<number>();
    for (const member of ctx.db.LobbyMember.lobby_id.filter(lobbyId)) {
        if (slotTeam(member.lobbySlot) !== side || slotIsCoach(member.lobbySlot)) continue;
        for (const lma of ctx.db.LobbyMemberAccount.by_lobby_and_user.filter([lobbyId, member.userId])) {
            const row = [...ctx.db.HsrAccountCharacter.by_account_and_character.filter([lma.hsrAccountId, characterName])][0];
            if (row) levels.add(row.eidolonLevel);
        }
    }
    return [...levels].sort((a, b) => a - b);
}
