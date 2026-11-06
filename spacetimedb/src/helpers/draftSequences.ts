/**
 * Generates the DraftStep[] sequence for Classic and Auction draft modes.
 * All sequences match exactly the notes/draft_order.md specification.
 */

/**
 * Creates a single DraftStep with the given action and team.
 */
function step(action: string, team: string): any {
    return {
        actionRequired: { tag: action, value: {} },
        teamTurn: { tag: team, value: {} },
    };
}

/**
 * Builds the Classic draft sequence from a BanMode tag string.
 * Returns the full ordered array of DraftStep (picks + bans interleaved).
 *
 * BanMode 'None' → 16 steps (all picks, snake order)
 * BanMode 'Four' → 20 steps (2 bans, 4 picks, 2 bans, 12 picks)
 * BanMode 'Six'  → 22 steps (2 bans, 4 picks, 2 bans, 4 picks, 2 bans, 8 picks)
 */
export function buildClassicSequence(banMode: string): any[] {
    switch (banMode) {
        case 'None':
            return [
                step('Pick', 'Blue'), step('Pick', 'Red'), step('Pick', 'Red'), step('Pick', 'Blue'),
                step('Pick', 'Red'),  step('Pick', 'Blue'), step('Pick', 'Blue'), step('Pick', 'Red'),
                step('Pick', 'Red'),  step('Pick', 'Blue'), step('Pick', 'Blue'), step('Pick', 'Red'),
                step('Pick', 'Red'),  step('Pick', 'Blue'), step('Pick', 'Blue'), step('Pick', 'Red'),
            ];

        case 'Four':
            return [
                step('Ban', 'Blue'), step('Ban', 'Red'),
                step('Pick', 'Blue'), step('Pick', 'Red'), step('Pick', 'Red'), step('Pick', 'Blue'),
                step('Ban', 'Red'), step('Ban', 'Blue'),
                step('Pick', 'Red'),  step('Pick', 'Blue'), step('Pick', 'Blue'), step('Pick', 'Red'),
                step('Pick', 'Red'),  step('Pick', 'Blue'), step('Pick', 'Blue'), step('Pick', 'Red'),
                step('Pick', 'Red'),  step('Pick', 'Blue'), step('Pick', 'Blue'), step('Pick', 'Red'),
            ];

        case 'Six':
            return [
                step('Ban', 'Blue'), step('Ban', 'Red'),
                step('Pick', 'Blue'), step('Pick', 'Red'), step('Pick', 'Red'), step('Pick', 'Blue'),
                step('Ban', 'Red'), step('Ban', 'Blue'),
                step('Pick', 'Red'),  step('Pick', 'Blue'), step('Pick', 'Blue'), step('Pick', 'Red'),
                step('Ban', 'Blue'), step('Ban', 'Red'),
                step('Pick', 'Blue'), step('Pick', 'Blue'), step('Pick', 'Red'), step('Pick', 'Red'),
                step('Pick', 'Blue'), step('Pick', 'Red'), step('Pick', 'Blue'), step('Pick', 'Red'),
            ];

        default:
            // Fallback to 0-ban sequence
            return buildClassicSequence('None');
    }
}

/**
 * Builds the ban-only portion of an Auction draft sequence.
 * Per D-48: draftSequence contains ban steps only; dynamic auction phase follows.
 *
 * BanMode 'None' → [] (no bans before auction)
 * BanMode 'Four' → 4 ban steps (Blue, Red, Red, Blue)
 * BanMode 'Six'  → 6 ban steps (Blue, Red, Red, Blue, Blue, Red)
 */
export function buildAuctionBanSequence(banMode: string): any[] {
    switch (banMode) {
        case 'None':
            return [];

        case 'Four':
            return [
                step('Ban', 'Blue'),
                step('Ban', 'Red'),
                step('Ban', 'Red'),
                step('Ban', 'Blue'),
            ];

        case 'Six':
            return [
                step('Ban', 'Blue'),
                step('Ban', 'Red'),
                step('Ban', 'Red'),
                step('Ban', 'Blue'),
                step('Ban', 'Blue'),
                step('Ban', 'Red'),
            ];

        default:
            return [];
    }
}
