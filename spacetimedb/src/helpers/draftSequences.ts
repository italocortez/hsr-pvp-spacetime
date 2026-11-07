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
 *
 * A21: the lineup format is the character count. Halves = the sequences above (8 picks per team);
 * Thirds appends THIRDS_EXTRA_PICKS (8 more picks, 4 per team, continuing the Red-Blue-Blue-Red snake) for
 * 12 picks per team. notes/draft_order.md defines only the 8-pick orders; the extension is this implementation's choice (A21 only fixes the count).
 */
export function buildClassicSequence(banMode: string, lineupFormat: string): any[] {
    const base = buildHalvesClassicSequence(banMode);
    return lineupFormat === 'Thirds' ? [...base, ...THIRDS_EXTRA_PICKS()] : base;
}

const THIRDS_EXTRA_PICKS = () => [
    step('Pick', 'Red'), step('Pick', 'Blue'), step('Pick', 'Blue'), step('Pick', 'Red'),
    step('Pick', 'Red'), step('Pick', 'Blue'), step('Pick', 'Blue'), step('Pick', 'Red'),
];

function buildHalvesClassicSequence(banMode: string): any[] {
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
            return buildHalvesClassicSequence('None');
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
