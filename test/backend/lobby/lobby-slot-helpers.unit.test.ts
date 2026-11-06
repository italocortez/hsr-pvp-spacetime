/**
 * Unit tests: LobbySlot helper functions — pure tag parsing, no DB.
 *
 * Covers: slotTeam, slotIsCoach, slotIsSpectator, slotSameTeam, slotToTeamSide
 *
 * Contract: docs/lobby/architecture.md — LobbySlot enum
 */

import { describe, it, expect } from 'vitest';
import {
    slotTeam,
    slotIsCoach,
    slotIsSpectator,
    slotSameTeam,
    slotToTeamSide,
} from '../../../spacetimedb/src/helpers/lobbyHelpers';

const BluePlayer = { tag: 'BluePlayer' };
const RedPlayer = { tag: 'RedPlayer' };
const BlueCoach = { tag: 'BlueCoach' };
const RedCoach = { tag: 'RedCoach' };
const Spectator = { tag: 'Spectator' };

describe('slotTeam', () => {
    it('BluePlayer → "Blue"', () => {
        expect(slotTeam(BluePlayer)).toBe('Blue');
    });

    it('RedPlayer → "Red"', () => {
        expect(slotTeam(RedPlayer)).toBe('Red');
    });

    it('BlueCoach → "Blue"', () => {
        expect(slotTeam(BlueCoach)).toBe('Blue');
    });

    it('RedCoach → "Red"', () => {
        expect(slotTeam(RedCoach)).toBe('Red');
    });

    it('Spectator → null', () => {
        expect(slotTeam(Spectator)).toBeNull();
    });
});

describe('slotIsCoach', () => {
    it('BlueCoach → true', () => {
        expect(slotIsCoach(BlueCoach)).toBe(true);
    });

    it('RedCoach → true', () => {
        expect(slotIsCoach(RedCoach)).toBe(true);
    });

    it('BluePlayer → false', () => {
        expect(slotIsCoach(BluePlayer)).toBe(false);
    });

    it('Spectator → false', () => {
        expect(slotIsCoach(Spectator)).toBe(false);
    });
});

describe('slotIsSpectator', () => {
    it('Spectator → true', () => {
        expect(slotIsSpectator(Spectator)).toBe(true);
    });

    it('BluePlayer → false', () => {
        expect(slotIsSpectator(BluePlayer)).toBe(false);
    });

    it('RedCoach → false', () => {
        expect(slotIsSpectator(RedCoach)).toBe(false);
    });
});

describe('slotSameTeam', () => {
    it('BluePlayer + BlueCoach → true (same Blue team)', () => {
        expect(slotSameTeam(BluePlayer, BlueCoach)).toBe(true);
    });

    it('RedPlayer + RedCoach → true (same Red team)', () => {
        expect(slotSameTeam(RedPlayer, RedCoach)).toBe(true);
    });

    it('BluePlayer + RedPlayer → false (different teams)', () => {
        expect(slotSameTeam(BluePlayer, RedPlayer)).toBe(false);
    });

    it('BluePlayer + Spectator → false (spectator has no team)', () => {
        expect(slotSameTeam(BluePlayer, Spectator)).toBe(false);
    });

    it('Spectator + Spectator → false (null !== null check)', () => {
        expect(slotSameTeam(Spectator, Spectator)).toBe(false);
    });
});

describe('slotToTeamSide', () => {
    it('BluePlayer → { tag: "Blue" }', () => {
        const result = slotToTeamSide(BluePlayer);
        expect(result.tag).toBe('Blue');
    });

    it('BlueCoach → { tag: "Blue" }', () => {
        const result = slotToTeamSide(BlueCoach);
        expect(result.tag).toBe('Blue');
    });

    it('RedPlayer → { tag: "Red" }', () => {
        const result = slotToTeamSide(RedPlayer);
        expect(result.tag).toBe('Red');
    });

    it('Spectator → { tag: "Spectator" }', () => {
        const result = slotToTeamSide(Spectator);
        expect(result.tag).toBe('Spectator');
    });
});
