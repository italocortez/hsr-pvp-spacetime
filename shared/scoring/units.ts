// A21 units: Memory of Chaos and Anomaly Arbitration score in cycles (lower wins), Apocalyptic Shadow in
// points (higher wins). An "advantage" is fewer cycles or more points; a penalty is the opposite.

export type GameModeTag = 'MemoryOfChaos' | 'ApocalypticShadow' | 'AnomalyArbitration';
export type ScoreUnit = 'cycles' | 'points';

export function unitOf(mode: GameModeTag): ScoreUnit {
    return mode === 'ApocalypticShadow' ? 'points' : 'cycles';
}

export function lowerWins(mode: GameModeTag): boolean {
    return unitOf(mode) === 'cycles';
}

/**
 * Turns an advantage (positive helps the team, negative hurts it) into a change of the result in the mode's
 * unit: an advantage of 2 cycles is −2 on a cycle result, an advantage of 500 points is +500 on a points result.
 */
export function advantageToDelta(mode: GameModeTag, advantage: number): number {
    return lowerWins(mode) ? -advantage : advantage;
}
