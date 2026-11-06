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
