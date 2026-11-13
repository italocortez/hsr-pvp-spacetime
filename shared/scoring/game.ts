import { applyHandicaps, type HandicapSettings } from './handicaps';
import type { GameModeTag } from './units';
import { decideWinner, type Side } from './winner';

// One game, end to end: group sums → itemized modifiers → handicaps → tie-break chain. The module
// (recomputeGame, run by record_group_scores / set_score_adjustment and the game close) and the web live preview
// both call this.

export interface GameTeamInput {
    /** Raw result of each lineup group, hundredths. */
    groupValues: number[];
    /** Signed MatchResultAdjustment values, hundredths, added as entered. */
    modifiers: number[];
    deaths: number;
    rosterCost: number;
    fourStarCount: number;
    fiveStarEidolons: number;
}

export interface GameTeamResult {
    /** Sum of the groups before modifiers and handicaps (A56: stored in the per-team cycles / score column). */
    raw: number;
    adjusted: number;
    handicap: number;
}

export interface GameResult {
    blue: GameTeamResult;
    red: GameTeamResult;
    winner: Side | null;
    tieBreakLevel: number;
}

export function sumGroupResults(values: number[]): number {
    let total = 0;
    for (const v of values) total += v;
    return total;
}

/** Adds every itemized modifier to the result as entered, in the mode's unit (+2 cycles is a penalty, +500 points a bonus). */
export function applyModifiers(result: number, modifiers: number[]): number {
    return result + sumGroupResults(modifiers);
}

export function scoreGame(
    mode: GameModeTag,
    settings: HandicapSettings,
    blue: GameTeamInput,
    red: GameTeamInput,
): GameResult {
    const rawBlue = sumGroupResults(blue.groupValues);
    const rawRed = sumGroupResults(red.groupValues);
    const h = applyHandicaps(
        mode,
        settings,
        {
            result: applyModifiers(rawBlue, blue.modifiers),
            rosterCost: blue.rosterCost,
            deaths: blue.deaths,
        },
        {
            result: applyModifiers(rawRed, red.modifiers),
            rosterCost: red.rosterCost,
            deaths: red.deaths,
        },
    );
    const decision = decideWinner(
        mode,
        {
            adjusted: h.blue.adjusted,
            rosterCost: blue.rosterCost,
            fourStarCount: blue.fourStarCount,
            fiveStarEidolons: blue.fiveStarEidolons,
        },
        {
            adjusted: h.red.adjusted,
            rosterCost: red.rosterCost,
            fourStarCount: red.fourStarCount,
            fiveStarEidolons: red.fiveStarEidolons,
        },
    );
    return {
        blue: { raw: rawBlue, adjusted: h.blue.adjusted, handicap: h.blue.handicap },
        red: { raw: rawRed, adjusted: h.red.adjusted, handicap: h.red.handicap },
        winner: decision.winner,
        tieBreakLevel: decision.tieBreakLevel,
    };
}
