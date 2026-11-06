/**
 * Unit tests: validateStageTransition — pure stage machine logic, no DB.
 *
 * Covers forward-only transitions, skip rejection, backward rejection,
 * cancellation from any non-terminal state, terminal state guards.
 *
 * Contract: docs/tournament/contract.md — Stage Advancement
 */

import { describe, it, expect } from 'vitest';
import { validateStageTransition } from '../../../spacetimedb/src/helpers/tournamentHelpers';

describe('validateStageTransition', () => {
    // ── Forward transitions ──
    it('Draft → Registration: valid', () => {
        expect(() => validateStageTransition('Draft', 'Registration')).not.toThrow();
    });

    it('Registration → Seeding: valid', () => {
        expect(() => validateStageTransition('Registration', 'Seeding')).not.toThrow();
    });

    it('Seeding → InProgress: valid', () => {
        expect(() => validateStageTransition('Seeding', 'InProgress')).not.toThrow();
    });

    it('InProgress → Completed: valid', () => {
        expect(() => validateStageTransition('InProgress', 'Completed')).not.toThrow();
    });

    // ── Skip rejection ──
    it('Draft → InProgress: rejected (skip)', () => {
        expect(() => validateStageTransition('Draft', 'InProgress')).toThrow(/skip/i);
    });

    it('Draft → Completed: rejected (skip)', () => {
        expect(() => validateStageTransition('Draft', 'Completed')).toThrow(/skip/i);
    });

    it('Registration → InProgress: rejected (skip)', () => {
        expect(() => validateStageTransition('Registration', 'InProgress')).toThrow(/skip/i);
    });

    // ── Backward rejection ──
    it('Seeding → Registration: rejected (backward)', () => {
        expect(() => validateStageTransition('Seeding', 'Registration')).toThrow(/forward/i);
    });

    it('InProgress → Draft: rejected (backward)', () => {
        expect(() => validateStageTransition('InProgress', 'Draft')).toThrow(/forward/i);
    });

    it('Completed → InProgress: rejected (backward)', () => {
        expect(() => validateStageTransition('Completed', 'InProgress')).toThrow(/forward/i);
    });

    // ── Same-stage rejection ──
    it('Draft → Draft: rejected (same stage)', () => {
        expect(() => validateStageTransition('Draft', 'Draft')).toThrow(/forward/i);
    });

    // ── Cancellation ──
    it('Draft → Cancelled: valid', () => {
        expect(() => validateStageTransition('Draft', 'Cancelled')).not.toThrow();
    });

    it('Registration → Cancelled: valid', () => {
        expect(() => validateStageTransition('Registration', 'Cancelled')).not.toThrow();
    });

    it('Seeding → Cancelled: valid', () => {
        expect(() => validateStageTransition('Seeding', 'Cancelled')).not.toThrow();
    });

    it('InProgress → Cancelled: valid', () => {
        expect(() => validateStageTransition('InProgress', 'Cancelled')).not.toThrow();
    });

    // ── Terminal state guards ──
    it('Completed → Cancelled: rejected (terminal)', () => {
        expect(() => validateStageTransition('Completed', 'Cancelled')).toThrow(/already.*Completed/i);
    });

    it('Cancelled → Cancelled: rejected (terminal)', () => {
        expect(() => validateStageTransition('Cancelled', 'Cancelled')).toThrow(/already.*Cancelled/i);
    });

    it('Cancelled → Registration: rejected (no transition from Cancelled)', () => {
        // Cancelled is not in STAGE_ORDER, so currentIdx = -1 → "Invalid stage"
        expect(() => validateStageTransition('Cancelled', 'Registration')).toThrow();
    });

    // ── Phase 10.1: CheckIn stage transitions (D-35, D-37) ──
    it('Registration → CheckIn: valid', () => {
        expect(() => validateStageTransition('Registration', 'CheckIn')).not.toThrow();
    });

    it('CheckIn → Seeding: valid', () => {
        expect(() => validateStageTransition('CheckIn', 'Seeding')).not.toThrow();
    });

    it('Registration → Seeding: valid (skip CheckIn allowed per D-37)', () => {
        expect(() => validateStageTransition('Registration', 'Seeding')).not.toThrow();
    });

    it('Draft → CheckIn: rejected (skip not allowed)', () => {
        expect(() => validateStageTransition('Draft', 'CheckIn')).toThrow(/skip/i);
    });

    it('CheckIn → InProgress: rejected (skip Seeding not allowed)', () => {
        expect(() => validateStageTransition('CheckIn', 'InProgress')).toThrow(/skip/i);
    });
});
