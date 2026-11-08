/**
 * Generates the DraftStep[] sequence for Classic and Auction draft modes.
 * The 8-pick (Halves) orders match docs/match-session/draft-order.md (the user's spec); the 12-pick (Thirds)
 * orders are DECISIONS.md A59, written out in the same file.
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
 * A21: the lineup format is the character count. Halves = the sequences above (8 picks per team).
 * Thirds = 12 picks per team in the A59 order of the ban mode (THIRDS_ORDERS): Blue first, Red last, no run
 * longer than two, every ban position as in Halves, no extra bans.
 */
export function buildClassicSequence(banMode: string, lineupFormat: string): any[] {
    if (lineupFormat !== 'Thirds') return buildHalvesClassicSequence(banMode);
    return fromOrder(THIRDS_ORDERS[banMode] ?? THIRDS_ORDERS.None);
}

/**
 * DECISIONS.md A59: the Classic Thirds orders, one token per step (B / R = Blue / Red pick, [B] / [R] = ban).
 *   None: B · RR · B · R · BB · RR · BB · RR · BB · R · B · R · B · R · BB · RR                       (24 steps)
 *   Four: [B] · [R] · B · RR · B · [R] · [B] · R · BB · RR · BB · RR · BB · RR · BB · RR · BB · R     (28 steps)
 *   Six:  [B] · [R] · B · RR · B · [R] · [B] · R · BB · R · [B] · [R] · BB · RR · BB · RR · BB · RR · B · R · B · R  (30 steps)
 */
const THIRDS_ORDERS: Record<string, string> = {
    None: 'B R R B R B B R R B B R R B B R B R B R B B R R',
    Four: '[B] [R] B R R B [R] [B] R B B R R B B R R B B R R B B R R B B R',
    Six: '[B] [R] B R R B [R] [B] R B B R [B] [R] B B R R B B R R B B R R B R B R',
};

function fromOrder(order: string): any[] {
    return order.split(' ').map((token) => {
        const team = token.includes('B') ? 'Blue' : 'Red';
        return step(token.startsWith('[') ? 'Ban' : 'Pick', team);
    });
}

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
