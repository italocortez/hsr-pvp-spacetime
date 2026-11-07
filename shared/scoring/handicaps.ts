import { mulHundredths } from './fixedPoint';
import { advantageToDelta, type GameModeTag } from './units';

// A21 handicaps, all in hundredths of the mode's unit (Lobby columns, S3). Magnitudes are entered as
// advantages or penalties; the mode decides the direction (fewer cycles / more points is an advantage).

export interface HandicapSettings {
    /** Advantage per unit of roster-cost difference, given to the cheaper team. */
    rosterDiffAdvantage: number;
    /** Roster cost (hundredths); 0 disables the threshold pair. */
    rosterThreshold: number;
    underThresholdAdvantage: number;
    aboveThresholdPenalty: number;
    deathPenalty: number;
}

export interface HandicapTeam {
    /** Result after the group sum and the modifiers, hundredths of the unit. */
    result: number;
    rosterCost: number;
    deaths: number;
}

export interface HandicapOutcome {
    adjusted: number;
    /** Net advantage applied to the team (positive helped it), hundredths of the unit. */
    handicap: number;
}

/** Threshold rule: below → advantage, above → penalty, exactly at → neutral (settled S7); 0 disables. */
export function thresholdAdvantage(settings: HandicapSettings, cost: number): number {
    if (settings.rosterThreshold === 0 || cost === settings.rosterThreshold) return 0;
    return cost < settings.rosterThreshold ? settings.underThresholdAdvantage : -settings.aboveThresholdPenalty;
}

/**
 * Roster diff: the cheaper team gets rosterDiffAdvantage × |costBlue − costRed| (hundredths × hundredths / 100,
 * truncated toward zero); equal costs give nobody the diff advantage. Threshold per team, then
 * deathPenalty × deaths. The net advantage moves the result in the mode's direction.
 */
export function applyHandicaps(
    mode: GameModeTag,
    settings: HandicapSettings,
    blue: HandicapTeam,
    red: HandicapTeam,
): { blue: HandicapOutcome; red: HandicapOutcome } {
    const diffAdvantage = mulHundredths(settings.rosterDiffAdvantage, Math.abs(blue.rosterCost - red.rosterCost));
    const side = (team: HandicapTeam, cheaper: boolean): HandicapOutcome => {
        const handicap = (cheaper ? diffAdvantage : 0)
            + thresholdAdvantage(settings, team.rosterCost)
            - settings.deathPenalty * team.deaths;
        return { adjusted: team.result + advantageToDelta(mode, handicap), handicap };
    };
    return {
        blue: side(blue, blue.rosterCost < red.rosterCost),
        red: side(red, red.rosterCost < blue.rosterCost),
    };
}
