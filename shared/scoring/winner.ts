import { type GameModeTag, lowerWins } from './units';

// A21 tie-break chain (A31: no draws; A39 authority for level 4):
// 0 adjusted result → 1 lower roster cost → 2 more 4★ characters → 3 fewer total eidolons on the team's 5★
// characters (from the Pick / AuctionSold step payloads) → 4 unresolved: the referee's winnerOverride decides.

export type Side = 'Blue' | 'Red';

export const TIE_BREAK_ADJUSTED = 0;
export const TIE_BREAK_ROSTER_COST = 1;
export const TIE_BREAK_FOUR_STARS = 2;
export const TIE_BREAK_EIDOLONS = 3;
export const TIE_BREAK_UNRESOLVED = 4;

export interface WinnerTeam {
    adjusted: number;
    rosterCost: number;
    fourStarCount: number;
    fiveStarEidolons: number;
}

export interface WinnerDecision {
    /** null only at tieBreakLevel 4 (unresolved tie). */
    winner: Side | null;
    tieBreakLevel: number;
}

/** The side with the smaller (preferLower) or larger value, or null on equality. */
function compare(blue: number, red: number, preferLower: boolean): Side | null {
    if (blue === red) return null;
    return blue < red === preferLower ? 'Blue' : 'Red';
}

export function decideWinner(mode: GameModeTag, blue: WinnerTeam, red: WinnerTeam): WinnerDecision {
    const chain: Array<[number, Side | null]> = [
        [TIE_BREAK_ADJUSTED, compare(blue.adjusted, red.adjusted, lowerWins(mode))],
        [TIE_BREAK_ROSTER_COST, compare(blue.rosterCost, red.rosterCost, true)],
        [TIE_BREAK_FOUR_STARS, compare(blue.fourStarCount, red.fourStarCount, false)],
        [TIE_BREAK_EIDOLONS, compare(blue.fiveStarEidolons, red.fiveStarEidolons, true)],
    ];
    for (const [level, winner] of chain) {
        if (winner) return { winner, tieBreakLevel: level };
    }
    return { winner: null, tieBreakLevel: TIE_BREAK_UNRESOLVED };
}
