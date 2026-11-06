/**
 * Unit tests for spacetimedb/src/helpers/eloCalculation.ts
 *
 * Tests pure ELO math functions — no DB context needed.
 * All functions take plain numbers and return plain numbers.
 */

import { describe, it, expect } from 'vitest';
import {
  getKFactor,
  calculateExpectedScore,
  calculateRatingChange,
  calculateTeamEffective,
  calculateAccountModifier,
  type EloConfigValues,
} from '../../../spacetimedb/src/helpers/eloCalculation';

const DEFAULT_CONFIG: EloConfigValues = {
  kFactorNew: 40,
  kFactorMid: 20,
  kFactorVet: 10,
  newThreshold: 20,
  midThreshold: 100,
  initialRating: 1000,
  sizeBonus: 150,
  spreadDivisor: 2,
  maxAccountBonus: 200,
};

// ─── getKFactor ──────────────────────────────────────────────────────────────

describe('getKFactor', () => {
  it('returns kFactorNew (40) for 0 matches played', () => {
    expect(getKFactor(0, DEFAULT_CONFIG)).toBe(40);
  });

  it('returns kFactorNew (40) at threshold boundary (20 matches)', () => {
    expect(getKFactor(20, DEFAULT_CONFIG)).toBe(40);
  });

  it('returns kFactorMid (20) for 21 matches', () => {
    expect(getKFactor(21, DEFAULT_CONFIG)).toBe(20);
  });

  it('returns kFactorMid (20) at mid boundary (100 matches)', () => {
    expect(getKFactor(100, DEFAULT_CONFIG)).toBe(20);
  });

  it('returns kFactorVet (10) for 101+ matches', () => {
    expect(getKFactor(101, DEFAULT_CONFIG)).toBe(10);
    expect(getKFactor(500, DEFAULT_CONFIG)).toBe(10);
  });
});

// ─── calculateExpectedScore ──────────────────────────────────────────────────

describe('calculateExpectedScore', () => {
  it('returns 0.5 for equal ratings', () => {
    expect(calculateExpectedScore(1000, 1000)).toBeCloseTo(0.5, 5);
  });

  it('returns ~0.91 for 400-point advantage', () => {
    const result = calculateExpectedScore(1400, 1000);
    expect(result).toBeCloseTo(0.9091, 3);
  });

  it('returns ~0.09 for 400-point disadvantage', () => {
    const result = calculateExpectedScore(1000, 1400);
    expect(result).toBeCloseTo(0.0909, 3);
  });

  it('returns near 0 for large gap (1000 vs 2000)', () => {
    const result = calculateExpectedScore(1000, 2000);
    expect(result).toBeLessThan(0.01);
  });
});

// ─── calculateRatingChange ───────────────────────────────────────────────────

describe('calculateRatingChange', () => {
  it('win as underdog (K=40, actual=1, expected=0.3) → +28', () => {
    expect(calculateRatingChange(40, 1, 0.3)).toBe(28);
  });

  it('loss as favorite (K=40, actual=0, expected=0.7) → -28', () => {
    expect(calculateRatingChange(40, 0, 0.7)).toBe(-28);
  });

  it('draw with equal expected (K=40, actual=0.5, expected=0.5) → 0', () => {
    expect(calculateRatingChange(40, 0.5, 0.5)).toBe(0);
  });
});

// ─── calculateTeamEffective ──────────────────────────────────────────────────

describe('calculateTeamEffective', () => {
  it('solo player returns raw rating', () => {
    expect(calculateTeamEffective([1000], 150, 2)).toBe(1000);
  });

  it('1v2 even team (1000+1000) → 1150', () => {
    // avg=1000, sizeBonus × (2-1) = 150, stdev=0 → 1000 + 150 - 0 = 1150
    expect(calculateTeamEffective([1000, 1000], 150, 2)).toBe(1150);
  });

  it('wide spread duo (1200+1800) → 1500 (spread cancels size bonus)', () => {
    // avg=1500, sizeBonus × 1 = 150, stdev=300, penalty=300/2=150
    // 1500 + 150 - 150 = 1500
    expect(calculateTeamEffective([1200, 1800], 150, 2)).toBe(1500);
  });
});

// ─── calculateAccountModifier ────────────────────────────────────────────────

describe('calculateAccountModifier', () => {
  it('whale (800) vs F2P (200) with maxBonus 200 → 120', () => {
    // gap=600, (600/1000)*200 = 120
    expect(calculateAccountModifier(800, 200, 200)).toBe(120);
  });

  it('equal accounts → 0', () => {
    expect(calculateAccountModifier(500, 500, 200)).toBe(0);
  });

  it('zero accounts → 0', () => {
    expect(calculateAccountModifier(0, 0, 200)).toBe(0);
  });
});
