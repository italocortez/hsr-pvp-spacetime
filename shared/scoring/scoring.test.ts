// T-S7(a): unit tests for the shared A21 scoring module (fixed-point hundredths, units, lineup groups, synergy
// surcharge, roster cost, handicaps, modifiers, the tie-break chain). Every branch is exercised, including each
// tie-break level and both unit directions.
import { describe, expect, it } from 'vitest';
import {
    GROUP_SIZE,
    TIE_BREAK_ADJUSTED,
    TIE_BREAK_EIDOLONS,
    TIE_BREAK_FOUR_STARS,
    TIE_BREAK_ROSTER_COST,
    TIE_BREAK_UNRESOLVED,
    advantageToDelta,
    applyHandicaps,
    applyModifiers,
    canonicalPair,
    charactersPerTeam,
    decideWinner,
    fromHundredths,
    groupCount,
    lineupError,
    lowerWins,
    mulHundredths,
    rosterCost,
    scoreGame,
    sumGroupResults,
    synergySurcharge,
    thresholdAdvantage,
    toHundredths,
    unitOf,
    type HandicapSettings,
    type WinnerTeam,
} from './index';

const NO_HANDICAPS: HandicapSettings = {
    rosterDiffAdvantage: 0,
    rosterThreshold: 0,
    underThresholdAdvantage: 0,
    aboveThresholdPenalty: 0,
    deathPenalty: 0,
};

describe('fixed point', () => {
    it('converts f32 values to integer hundredths at the boundary, both signs', () => {
        expect(toHundredths(7.5)).toBe(750);
        expect(toHundredths(Math.fround(0.1))).toBe(10);
        expect(toHundredths(-2.345)).toBe(-235); // half away from zero after the f64 representation
        expect(toHundredths(0)).toBe(0);
        expect(fromHundredths(750)).toBe(7.5);
    });
    it('multiplies two hundredths values and truncates toward zero', () => {
        expect(mulHundredths(50, 400)).toBe(200); // 0.5 × 4 = 2
        expect(mulHundredths(33, 100)).toBe(33);
        expect(mulHundredths(-33, 3)).toBe(0); // -0.99 → 0 (toward zero)
    });
});

describe('units', () => {
    it('cycle modes: lower wins, an advantage lowers the result', () => {
        for (const mode of ['MemoryOfChaos', 'AnomalyArbitration'] as const) {
            expect(unitOf(mode)).toBe('cycles');
            expect(lowerWins(mode)).toBe(true);
            expect(advantageToDelta(mode, 200)).toBe(-200);
        }
    });
    it('points mode: higher wins, an advantage raises the result', () => {
        expect(unitOf('ApocalypticShadow')).toBe('points');
        expect(lowerWins('ApocalypticShadow')).toBe(false);
        expect(advantageToDelta('ApocalypticShadow', 200)).toBe(200);
    });
});

describe('lineup groups', () => {
    const eight = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const halves = [['a', 'b', 'c', 'd'], ['e', 'f', 'g', 'h']];
    it('Halves = 2 groups of 4 (8 characters), Thirds = 3 groups of 4 (12)', () => {
        expect(GROUP_SIZE).toBe(4);
        expect(groupCount('Halves')).toBe(2);
        expect(groupCount('Thirds')).toBe(3);
        expect(charactersPerTeam('Halves')).toBe(8);
        expect(charactersPerTeam('Thirds')).toBe(12);
    });
    it('accepts a lineup that places every drafted character once', () => {
        expect(lineupError(halves, eight, 'Halves')).toBeNull();
        const twelve = [...eight, 'i', 'j', 'k', 'l'];
        expect(lineupError([...halves, ['i', 'j', 'k', 'l']], twelve, 'Thirds')).toBeNull();
    });
    it('accepts a repeated placeholder drafted twice', () => {
        const drafted = ['EMPTY', 'EMPTY', 'c', 'd', 'e', 'f', 'g', 'h'];
        expect(lineupError([['EMPTY', 'EMPTY', 'c', 'd'], ['e', 'f', 'g', 'h']], drafted, 'Halves')).toBeNull();
    });
    it('rejects the wrong group count, the wrong group size, strangers, duplicates and missing characters', () => {
        expect(lineupError(halves, eight, 'Thirds')).toBe('A Thirds lineup has 3 groups.');
        expect(lineupError([['a', 'b', 'c'], ['d', 'e', 'f', 'g', 'h']], eight, 'Halves')).toBe('Every group has 4 characters.');
        expect(lineupError([['a', 'b', 'c', 'z'], ['e', 'f', 'g', 'h']], eight, 'Halves')).toMatch(/^z is not a drafted character/);
        expect(lineupError([['a', 'a', 'c', 'd'], ['e', 'f', 'g', 'h']], eight, 'Halves')).toMatch(/^a is not a drafted character/);
        expect(lineupError(halves, [...eight, 'i'], 'Halves')).toBe('Every drafted character must be placed once.');
    });
});

describe('synergy surcharge', () => {
    const pairs = [
        { characterA: 'argenti', characterB: 'the-herta', costModifier: 400 },
        { characterA: 'the-herta', characterB: 'tribbie', costModifier: 400 },
    ];
    it('canonical order is alphabetical whatever the argument order', () => {
        expect(canonicalPair('b', 'a')).toEqual(['a', 'b']);
        expect(canonicalPair('a', 'b')).toEqual(['a', 'b']);
    });
    it('The Herta + Argenti + Tribbie in one group = +8 (two pairs)', () => {
        const groups = [['the-herta', 'argenti', 'tribbie', 'x'], ['a', 'b', 'c', 'd']];
        expect(synergySurcharge(groups, pairs)).toBe(800);
    });
    it('a pair split across groups adds nothing; a pair listed in both orders counts once', () => {
        const groups = [['the-herta', 'argenti', 'x', 'y'], ['tribbie', 'b', 'c', 'd']];
        const reversed = { characterA: 'the-herta', characterB: 'argenti', costModifier: 400 };
        expect(synergySurcharge(groups, [...pairs, reversed])).toBe(400);
        expect(synergySurcharge(groups, [])).toBe(0);
    });
});

describe('roster cost', () => {
    it('sums character costs, light cones and the surcharge', () => {
        expect(rosterCost({ characterCosts: [100, 250], lightconeCosts: [50], surcharge: 800 })).toBe(1200);
        expect(rosterCost({ characterCosts: [], lightconeCosts: [], surcharge: 0 })).toBe(0);
    });
});

describe('handicaps', () => {
    const settings: HandicapSettings = {
        rosterDiffAdvantage: 50,          // 0.5 per cost unit
        rosterThreshold: 3000,            // 30 cost
        underThresholdAdvantage: 100,
        aboveThresholdPenalty: 200,
        deathPenalty: 300,
    };
    it('threshold: below → advantage, above → penalty, exactly at → neutral, 0 disables', () => {
        expect(thresholdAdvantage(settings, 2999)).toBe(100);
        expect(thresholdAdvantage(settings, 3001)).toBe(-200);
        expect(thresholdAdvantage(settings, 3000)).toBe(0);
        expect(thresholdAdvantage({ ...settings, rosterThreshold: 0 }, 1)).toBe(0);
    });
    it('cycles: the cheaper Blue team gets the diff advantage; deaths cost cycles', () => {
        const r = applyHandicaps('MemoryOfChaos', settings,
            { result: 1000, rosterCost: 2600, deaths: 0 },   // 4 cheaper: +2 diff, +1 under
            { result: 1000, rosterCost: 3000, deaths: 1 });  // at threshold, 1 death: −3
        expect(r.blue).toEqual({ handicap: 300, adjusted: 700 });
        expect(r.red).toEqual({ handicap: -300, adjusted: 1300 });
    });
    it('points: the cheaper Red team gets the diff advantage as extra points', () => {
        const r = applyHandicaps('ApocalypticShadow', settings,
            { result: 1000, rosterCost: 3400, deaths: 0 },   // above: −2
            { result: 1000, rosterCost: 3000, deaths: 0 });  // 4 cheaper: +2
        expect(r.blue).toEqual({ handicap: -200, adjusted: 800 });
        expect(r.red).toEqual({ handicap: 200, adjusted: 1200 });
    });
    it('equal costs give nobody the diff advantage', () => {
        const r = applyHandicaps('MemoryOfChaos', NO_HANDICAPS,
            { result: 500, rosterCost: 10, deaths: 2 }, { result: 600, rosterCost: 10, deaths: 0 });
        expect(r.blue).toEqual({ handicap: 0, adjusted: 500 });
        expect(r.red).toEqual({ handicap: 0, adjusted: 600 });
    });
});

describe('modifiers and group sums', () => {
    it('sums the groups and adds the modifiers as entered', () => {
        expect(sumGroupResults([300, 450])).toBe(750);
        expect(sumGroupResults([])).toBe(0);
        expect(applyModifiers(750, [200, -50])).toBe(900);
        expect(applyModifiers(750, [])).toBe(750);
    });
});

describe('decideWinner: the tie-break chain', () => {
    const base: WinnerTeam = { adjusted: 1000, rosterCost: 2000, fourStarCount: 2, fiveStarEidolons: 3 };
    it('level 0: the adjusted result, lower wins in cycles, higher in points', () => {
        expect(decideWinner('MemoryOfChaos', { ...base, adjusted: 900 }, base)).toEqual({ winner: 'Blue', tieBreakLevel: TIE_BREAK_ADJUSTED });
        expect(decideWinner('MemoryOfChaos', base, { ...base, adjusted: 900 })).toEqual({ winner: 'Red', tieBreakLevel: 0 });
        expect(decideWinner('ApocalypticShadow', { ...base, adjusted: 900 }, base)).toEqual({ winner: 'Red', tieBreakLevel: 0 });
        expect(decideWinner('ApocalypticShadow', base, { ...base, adjusted: 900 })).toEqual({ winner: 'Blue', tieBreakLevel: 0 });
    });
    it('level 1: lower roster cost', () => {
        expect(decideWinner('MemoryOfChaos', { ...base, rosterCost: 1999 }, base)).toEqual({ winner: 'Blue', tieBreakLevel: TIE_BREAK_ROSTER_COST });
        expect(decideWinner('ApocalypticShadow', base, { ...base, rosterCost: 1999 })).toEqual({ winner: 'Red', tieBreakLevel: 1 });
    });
    it('level 2: more 4-star characters', () => {
        expect(decideWinner('MemoryOfChaos', { ...base, fourStarCount: 3 }, base)).toEqual({ winner: 'Blue', tieBreakLevel: TIE_BREAK_FOUR_STARS });
        expect(decideWinner('MemoryOfChaos', base, { ...base, fourStarCount: 3 })).toEqual({ winner: 'Red', tieBreakLevel: 2 });
    });
    it('level 3: fewer total eidolons on 5-star characters', () => {
        expect(decideWinner('MemoryOfChaos', { ...base, fiveStarEidolons: 0 }, base)).toEqual({ winner: 'Blue', tieBreakLevel: TIE_BREAK_EIDOLONS });
        expect(decideWinner('MemoryOfChaos', base, { ...base, fiveStarEidolons: 0 })).toEqual({ winner: 'Red', tieBreakLevel: 3 });
    });
    it('level 4: still tied → unresolved, no winner (the referee override decides)', () => {
        expect(decideWinner('MemoryOfChaos', base, { ...base })).toEqual({ winner: null, tieBreakLevel: TIE_BREAK_UNRESOLVED });
    });
});

describe('scoreGame: groups → modifiers → handicaps → chain', () => {
    it('a 4v4 + 4v4 cycle game with a modifier and a death', () => {
        const r = scoreGame('MemoryOfChaos', { ...NO_HANDICAPS, deathPenalty: 100 },
            { groupValues: [300, 400], modifiers: [200], deaths: 1, rosterCost: 2000, fourStarCount: 1, fiveStarEidolons: 0 },
            { groupValues: [500, 500], modifiers: [], deaths: 0, rosterCost: 2000, fourStarCount: 1, fiveStarEidolons: 0 });
        expect(r.blue).toEqual({ raw: 700, adjusted: 1000, handicap: -100 });
        expect(r.red).toEqual({ raw: 1000, adjusted: 1000, handicap: 0 });
        expect(r.winner).toBeNull();
        expect(r.tieBreakLevel).toBe(4);
    });
    it('a points game decided on the adjusted result', () => {
        const r = scoreGame('ApocalypticShadow', NO_HANDICAPS,
            { groupValues: [300000, 250000], modifiers: [50000], deaths: 0, rosterCost: 0, fourStarCount: 0, fiveStarEidolons: 0 },
            { groupValues: [310000, 260000], modifiers: [], deaths: 0, rosterCost: 0, fourStarCount: 0, fiveStarEidolons: 0 });
        expect(r.winner).toBe('Blue');
        expect(r.tieBreakLevel).toBe(0);
        expect(r.blue.adjusted).toBe(600000);
        expect(r.red.raw).toBe(570000);
    });
});
