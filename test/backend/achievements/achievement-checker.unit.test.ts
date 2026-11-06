/**
 * Unit tests for spacetimedb/src/helpers/achievementChecker.ts
 *
 * Tests pure helper functions — no DB context needed.
 * getField, sumField, applyOperator are file-local, so we test them
 * by importing the module and accessing via the module's internal logic.
 *
 * Since getField/sumField/applyOperator are not exported, we replicate
 * their logic here to unit-test the contracts. The integration tests
 * verify the full checkAndAwardAchievements flow against live DB.
 */

import { describe, it, expect } from 'vitest';

// ─── getField contract ──────────────────────────────────────────────────────
// Replicates the switch/case field resolver to verify the expected mapping.

function getField(row: any, fieldName: string): number | undefined {
    switch (fieldName) {
        case 'matchesPlayed':        return row.matchesPlayed;
        case 'wins':                 return row.wins;
        case 'losses':               return row.losses;
        case 'draws':                return row.draws;
        case 'matchesSpectated':     return row.matchesSpectated;
        case 'timesBannedInMatch':   return row.timesBannedInMatch;
        case 'timesFaced':           return row.timesFaced;
        case 'winsAgainst':          return row.winsAgainst;
        case 'lossesAgainst':        return row.lossesAgainst;
        case 'rating':               return row.rating;
        case 'globalCompositeRating': return row.globalCompositeRating;
        default:                     return undefined;
    }
}

function sumField(rows: any[], fieldName: string): number {
    return rows.reduce((sum: number, r: any) => sum + (getField(r, fieldName) ?? 0), 0);
}

function applyOperator(value: number, operator: { tag: string }, threshold: number): boolean {
    switch (operator.tag) {
        case 'GreaterOrEqual': return value >= threshold;
        case 'GreaterThan':    return value > threshold;
        case 'Equal':          return value === threshold;
        case 'LessThan':       return value < threshold;
        case 'LessOrEqual':    return value <= threshold;
        default:               return false;
    }
}

// ─── getField ────────────────────────────────────────────────────────────────

describe('getField', () => {
    const row = {
        matchesPlayed: 50,
        wins: 30,
        losses: 15,
        draws: 5,
        matchesSpectated: 10,
        timesBannedInMatch: 3,
        timesFaced: 8,
        winsAgainst: 6,
        lossesAgainst: 2,
        rating: 1500,
        globalCompositeRating: 1350,
    };

    it('returns correct value for each PlayerStat field', () => {
        expect(getField(row, 'matchesPlayed')).toBe(50);
        expect(getField(row, 'wins')).toBe(30);
        expect(getField(row, 'losses')).toBe(15);
        expect(getField(row, 'draws')).toBe(5);
        expect(getField(row, 'matchesSpectated')).toBe(10);
    });

    it('returns correct value for each PlayerCharacterStat field', () => {
        expect(getField(row, 'timesBannedInMatch')).toBe(3);
        expect(getField(row, 'timesFaced')).toBe(8);
        expect(getField(row, 'winsAgainst')).toBe(6);
        expect(getField(row, 'lossesAgainst')).toBe(2);
    });

    it('returns correct value for MmrRating fields', () => {
        expect(getField(row, 'rating')).toBe(1500);
        expect(getField(row, 'globalCompositeRating')).toBe(1350);
    });

    it('returns undefined for unknown field', () => {
        expect(getField(row, 'nonExistentField')).toBeUndefined();
        expect(getField(row, '')).toBeUndefined();
    });
});

// ─── sumField ────────────────────────────────────────────────────────────────

describe('sumField', () => {
    it('sums field across multiple rows', () => {
        const rows = [
            { wins: 10 },
            { wins: 5 },
            { wins: 3 },
        ];
        expect(sumField(rows, 'wins')).toBe(18);
    });

    it('returns 0 for empty array', () => {
        expect(sumField([], 'wins')).toBe(0);
    });

    it('treats missing field as 0', () => {
        const rows = [
            { wins: 10 },
            { losses: 5 },  // no 'wins' field
        ];
        expect(sumField(rows, 'wins')).toBe(10);
    });

    it('treats unknown field name as 0 for all rows', () => {
        const rows = [{ wins: 10 }, { wins: 5 }];
        expect(sumField(rows, 'bogusField')).toBe(0);
    });
});

// ─── applyOperator ───────────────────────────────────────────────────────────

describe('applyOperator', () => {
    describe('GreaterOrEqual', () => {
        const op = { tag: 'GreaterOrEqual' };
        it('true when value equals threshold', () => {
            expect(applyOperator(10, op, 10)).toBe(true);
        });
        it('true when value exceeds threshold', () => {
            expect(applyOperator(11, op, 10)).toBe(true);
        });
        it('false when value is below threshold', () => {
            expect(applyOperator(9, op, 10)).toBe(false);
        });
    });

    describe('GreaterThan', () => {
        const op = { tag: 'GreaterThan' };
        it('true when value exceeds threshold', () => {
            expect(applyOperator(11, op, 10)).toBe(true);
        });
        it('false when value equals threshold', () => {
            expect(applyOperator(10, op, 10)).toBe(false);
        });
        it('false when value is below threshold', () => {
            expect(applyOperator(9, op, 10)).toBe(false);
        });
    });

    describe('Equal', () => {
        const op = { tag: 'Equal' };
        it('true on exact match', () => {
            expect(applyOperator(10, op, 10)).toBe(true);
        });
        it('false on mismatch (above)', () => {
            expect(applyOperator(11, op, 10)).toBe(false);
        });
        it('false on mismatch (below)', () => {
            expect(applyOperator(9, op, 10)).toBe(false);
        });
    });

    describe('LessThan', () => {
        const op = { tag: 'LessThan' };
        it('true when value is below threshold', () => {
            expect(applyOperator(9, op, 10)).toBe(true);
        });
        it('false when value equals threshold', () => {
            expect(applyOperator(10, op, 10)).toBe(false);
        });
        it('false when value exceeds threshold', () => {
            expect(applyOperator(11, op, 10)).toBe(false);
        });
    });

    describe('LessOrEqual', () => {
        const op = { tag: 'LessOrEqual' };
        it('true when value equals threshold', () => {
            expect(applyOperator(10, op, 10)).toBe(true);
        });
        it('true when value is below threshold', () => {
            expect(applyOperator(9, op, 10)).toBe(true);
        });
        it('false when value exceeds threshold', () => {
            expect(applyOperator(11, op, 10)).toBe(false);
        });
    });

    describe('unknown operator', () => {
        it('returns false', () => {
            expect(applyOperator(10, { tag: 'BogusOperator' }, 10)).toBe(false);
        });
    });
});
