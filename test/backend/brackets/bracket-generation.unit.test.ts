/**
 * Unit tests for spacetimedb/src/helpers/bracketGeneration.ts
 *
 * Tests pure bracket generation algorithms — no DB context needed.
 * These functions compute BracketMatchDescriptor arrays deterministically.
 */

import { describe, it, expect } from 'vitest';
import {
  foldSeeding,
  generateSingleElimBracket,
  generateDoubleElimBracket,
  circleSchedule,
  snakeSeedIntoGroups,
  generateGroupPhaseBracket,
  generateHybridBracket,
  type BracketMatchDescriptor,
} from '../../../spacetimedb/src/helpers/bracketGeneration';

// ─── foldSeeding ────────────────────────────────────────────────────────────

describe('foldSeeding', () => {
  it('generates correct 4-team matchups: [[1,4],[2,3]]', () => {
    const matchups = foldSeeding(4);
    expect(matchups).toEqual([[1, 4], [2, 3]]);
  });

  it('generates correct 8-team matchups with standard ATP seeding', () => {
    const matchups = foldSeeding(8);
    expect(matchups).toEqual([[1, 8], [4, 5], [2, 7], [3, 6]]);
  });

  it('generates correct 16-team matchups', () => {
    const matchups = foldSeeding(16);
    expect(matchups).toHaveLength(8);
    // Seed 1 vs 16 (top vs bottom)
    expect(matchups[0]).toEqual([1, 16]);
    // Seed 2 vs 15
    expect(matchups).toContainEqual([2, 15]);
    // All seeds 1-16 appear exactly once
    const allSeeds = matchups.flat().sort((a, b) => a - b);
    expect(allSeeds).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
  });

  it('generates 2-team bracket: [[1,2]]', () => {
    const matchups = foldSeeding(2);
    expect(matchups).toEqual([[1, 2]]);
  });
});

// ─── generateSingleElimBracket ──────────────────────────────────────────────

describe('generateSingleElimBracket', () => {
  it('creates 3 matches for 4 teams (2 semis + 1 final)', () => {
    const teams = [10, 20, 30, 40];
    const result = generateSingleElimBracket(teams, 3, false);
    expect(result).toHaveLength(3);

    const r1 = result.filter(m => m.roundNumber === 1);
    const r2 = result.filter(m => m.roundNumber === 2);
    expect(r1).toHaveLength(2);
    expect(r2).toHaveLength(1);
  });

  it('all matches have bracketSide=Winners', () => {
    const result = generateSingleElimBracket([1, 2, 3, 4], 3, false);
    expect(result.every(m => m.bracketSide === 'Winners')).toBe(true);
  });

  it('creates BYE matches for 5 teams (bracket size 8)', () => {
    const teams = [10, 20, 30, 40, 50];
    const result = generateSingleElimBracket(teams, 3, false);
    // 8-slot bracket = 7 matches total (4 R1 + 2 R2 + 1 R3)
    expect(result).toHaveLength(7);

    // BYE matches: R1 slots where one participant is undefined
    const byeMatches = result.filter(
      m => m.roundNumber === 1 && (m.team1Id === undefined || m.team2Id === undefined)
    );
    expect(byeMatches.length).toBe(3); // 8 - 5 = 3 BYEs
    // BYE matches have winnerTeamId pre-set
    for (const bye of byeMatches) {
      expect(bye.winnerTeamId).toBeDefined();
    }
  });

  it('R1 matches have nextWinnerRef pointing to R2', () => {
    const result = generateSingleElimBracket([1, 2, 3, 4], 3, false);
    const r1 = result.filter(m => m.roundNumber === 1);
    for (const match of r1) {
      expect(match.nextWinnerRef).toMatch(/^W-R2-M\d+$/);
    }
  });

  it('creates 3rd place match when has3rdPlaceMatch=true', () => {
    const result = generateSingleElimBracket([1, 2, 3, 4], 3, true);
    const thirdPlace = result.filter(m => m.bracketSide === 'ThirdPlace');
    expect(thirdPlace).toHaveLength(1);
    // Semis should have nextLoserRef pointing to 3rd place
    const semis = result.filter(m => m.roundNumber === 1);
    const semisWithLoserRef = semis.filter(m => m.nextLoserRef);
    expect(semisWithLoserRef).toHaveLength(2);
  });
});

// ─── generateDoubleElimBracket ──────────────────────────────────────────────

describe('generateDoubleElimBracket', () => {
  it('creates WB + LB + GrandFinals for 4 teams', () => {
    const result = generateDoubleElimBracket([1, 2, 3, 4], 3, 1, false);

    const wb = result.filter(m => m.bracketSide === 'Winners');
    const lb = result.filter(m => m.bracketSide === 'Losers');
    const gf = result.filter(m => m.bracketSide === 'GrandFinals');

    expect(wb.length).toBeGreaterThanOrEqual(3); // 2 R1 + 1 R2 minimum
    expect(lb.length).toBeGreaterThanOrEqual(1);
    expect(gf).toHaveLength(1);
  });

  it('GrandFinals has winnerAdvantage from parameter', () => {
    const result = generateDoubleElimBracket([1, 2, 3, 4], 3, 2, false);
    const gf = result.find(m => m.bracketSide === 'GrandFinals');
    expect(gf?.winnerAdvantage).toBe(2);
  });

  it('WB R1 matches have nextLoserRef (route losers to LB)', () => {
    const result = generateDoubleElimBracket([1, 2, 3, 4], 3, 0, false);
    const wbR1 = result.filter(m => m.bracketSide === 'Winners' && m.roundNumber === 1);
    for (const match of wbR1) {
      expect(match.nextLoserRef).toMatch(/^L-R\d+-M\d+$/);
    }
  });

  it('LB final points to GrandFinals', () => {
    const result = generateDoubleElimBracket([1, 2, 3, 4], 3, 0, false);
    const lb = result.filter(m => m.bracketSide === 'Losers');
    const lbFinal = lb[lb.length - 1]; // Last LB match
    expect(lbFinal.nextWinnerRef).toBe('GF-R1-M1');
  });
});

// ─── circleSchedule ─────────────────────────────────────────────────────────

describe('circleSchedule', () => {
  it('4 teams: 3 rounds, every team plays every other exactly once', () => {
    const rounds = circleSchedule([1, 2, 3, 4]);
    expect(rounds).toHaveLength(3); // n-1 rounds for n teams

    // Collect all matchups
    const allMatchups = rounds.flat();
    // 4 teams choose 2 = 6 unique matchups
    expect(allMatchups).toHaveLength(6);

    // Every pair appears exactly once
    const pairSet = new Set(allMatchups.map(([a, b]) => [Math.min(a, b), Math.max(a, b)].join(',')));
    expect(pairSet.size).toBe(6);
  });

  it('odd team count adds BYE (skipped in output)', () => {
    const rounds = circleSchedule([1, 2, 3]);
    // 3 teams + BYE sentinel = 4, so 3 rounds
    expect(rounds).toHaveLength(3);
    // Each round has 1 real match (the other is BYE)
    for (const round of rounds) {
      expect(round.length).toBe(1);
    }
    // 3 unique matchups total
    const allMatchups = rounds.flat();
    expect(allMatchups).toHaveLength(3);
  });

  it('no team appears twice in the same round', () => {
    const rounds = circleSchedule([10, 20, 30, 40, 50, 60]);
    for (const round of rounds) {
      const teamsInRound = round.flat();
      const uniqueTeams = new Set(teamsInRound);
      expect(uniqueTeams.size).toBe(teamsInRound.length);
    }
  });
});

// ─── snakeSeedIntoGroups ────────────────────────────────────────────────────

describe('snakeSeedIntoGroups', () => {
  it('8 teams, 2 groups: serpentine [1,4,5,8] and [2,3,6,7]', () => {
    const groups = snakeSeedIntoGroups([1, 2, 3, 4, 5, 6, 7, 8], 2);
    expect(groups.get(0)).toEqual([1, 4, 5, 8]);
    expect(groups.get(1)).toEqual([2, 3, 6, 7]);
  });

  it('6 teams, 3 groups: [1,6], [2,5], [3,4]', () => {
    const groups = snakeSeedIntoGroups([1, 2, 3, 4, 5, 6], 3);
    expect(groups.get(0)).toEqual([1, 6]);
    expect(groups.get(1)).toEqual([2, 5]);
    expect(groups.get(2)).toEqual([3, 4]);
  });

  it('all teams assigned to exactly one group', () => {
    const teams = [10, 20, 30, 40, 50, 60, 70, 80];
    const groups = snakeSeedIntoGroups(teams, 4);
    const allAssigned = [...groups.values()].flat().sort((a, b) => a - b);
    expect(allAssigned).toEqual(teams);
  });
});

// ─── generateGroupPhaseBracket ──────────────────────────────────────────────

describe('generateGroupPhaseBracket', () => {
  it('creates round-robin matches for each group', () => {
    const { matches, groupAssignments } = generateGroupPhaseBracket(
      [1, 2, 3, 4, 5, 6], 3, 3, 'Auto'
    );
    // 6 teams, groupSize=3 -> 2 groups of 3
    expect(groupAssignments.size).toBe(2);
    // Each group of 3 has 3 matches (3 choose 2)
    expect(matches).toHaveLength(6);
  });

  it('all matches have bracketSide=Group and groupId set', () => {
    const { matches } = generateGroupPhaseBracket([1, 2, 3, 4], 4, 3, 'Auto');
    for (const match of matches) {
      expect(match.bracketSide).toBe('Group');
      expect(match.groupId).toBeDefined();
    }
  });

  it('group matches have no nextWinnerRef (standings determine advancement)', () => {
    const { matches } = generateGroupPhaseBracket([1, 2, 3, 4], 4, 3, 'Auto');
    for (const match of matches) {
      expect(match.nextWinnerRef).toBeUndefined();
      expect(match.nextLoserRef).toBeUndefined();
    }
  });
});

// ─── generateHybridBracket ──────────────────────────────────────────────────

describe('generateHybridBracket', () => {
  it('creates both group matches and elimination matches', () => {
    const { groupMatches, elimMatches, groupAssignments } = generateHybridBracket(
      [1, 2, 3, 4, 5, 6], 3, 3, 'Auto', 'single', 0, false, 1
    );
    expect(groupMatches.length).toBeGreaterThan(0);
    expect(elimMatches.length).toBeGreaterThan(0);
    expect(groupAssignments.size).toBeGreaterThan(0);
  });

  it('elimination matches have cleared participant slots (no placeholders)', () => {
    const { elimMatches } = generateHybridBracket(
      [1, 2, 3, 4, 5, 6], 3, 3, 'Auto', 'single', 0, false, 1
    );
    for (const match of elimMatches) {
      expect(match.team1Id).toBeUndefined();
      expect(match.team2Id).toBeUndefined();
      expect(match.winnerTeamId).toBeUndefined();
    }
  });

  it('elimination positionKeys prefixed with E- to avoid group key collisions', () => {
    const { elimMatches } = generateHybridBracket(
      [1, 2, 3, 4, 5, 6], 3, 3, 'Auto', 'single', 0, false, 1
    );
    for (const match of elimMatches) {
      expect(match.positionKey).toMatch(/^E-/);
    }
  });
});
