// ─── ELO Calculation Helpers ─────────────────────────────────────────────────
// Pure math functions with ZERO database access. All inputs and outputs are
// plain numbers, making these testable and deterministic.

/** Config values extracted from EloConfigTable row. */
export interface EloConfigValues {
    kFactorNew: number;
    kFactorMid: number;
    kFactorVet: number;
    newThreshold: number;
    midThreshold: number;
    initialRating: number;
    sizeBonus: number;
    spreadDivisor: number;
    maxAccountBonus: number;
}

/**
 * Returns the K-factor tier based on matches played (D-14).
 * New players (<= 20 matches) get K=40, mid (21-100) get K=20, vets (100+) get K=10.
 */
export function getKFactor(matchesPlayed: number, config: EloConfigValues): number {
    if (matchesPlayed <= config.newThreshold) return config.kFactorNew;
    if (matchesPlayed <= config.midThreshold) return config.kFactorMid;
    return config.kFactorVet;
}

/**
 * Standard ELO expected score calculation (D-15).
 * Returns probability [0, 1] that player wins against opponent.
 */
export function calculateExpectedScore(playerEffective: number, opponentEffective: number): number {
    return 1 / (1 + Math.pow(10, (opponentEffective - playerEffective) / 400));
}

/**
 * Calculates signed rating change (D-15).
 * Positive for gain, negative for loss. Rounded to integer.
 */
export function calculateRatingChange(kFactor: number, actualResult: number, expectedScore: number): number {
    return Math.round(kFactor * (actualResult - expectedScore));
}

/**
 * Calculates effective team rating from individual ratings (D-18 through D-20).
 * Solo: just the rating. Team: avg + size bonus - spread penalty.
 */
export function calculateTeamEffective(teamRatings: number[], sizeBonus: number, spreadDivisor: number): number {
    const avg = teamRatings.reduce((a, b) => a + b, 0) / teamRatings.length;
    if (teamRatings.length === 1) return avg; // No modifier for solo
    const stdev = Math.sqrt(
        teamRatings.reduce((sum, r) => sum + (r - avg) ** 2, 0) / teamRatings.length
    );
    return Math.round(avg + sizeBonus * (teamRatings.length - 1) - stdev / spreadDivisor);
}

/**
 * Calculates account rating modifier for Fair MMR (D-24).
 * Returns modifier to add to the higher-account-rating side's effective rating.
 */
export function calculateAccountModifier(higherAccountRating: number, lowerAccountRating: number, maxAccountBonus: number): number {
    const gap = Math.abs(higherAccountRating - lowerAccountRating);
    return Math.round((gap / 1000) * maxAccountBonus);
}
