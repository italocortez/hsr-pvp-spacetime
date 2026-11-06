/**
 * Unit tests: disconnect helper functions — ensureMatchAlive, buildConcedeSummary,
 * handleDisconnectPoolUpdate, isForfeitEligible, isThirdPartyReferee
 *
 * Contract: docs/lobby/architecture.md — Disconnect Handling
 * Phase: 10 (Disconnect Handling and Cost Parity)
 */

import { describe, it, expect } from 'vitest';
import {
    ensureMatchAlive,
    buildConcedeSummary,
    handleDisconnectPoolUpdate,
    isForfeitEligible,
    isThirdPartyReferee,
} from '../../../spacetimedb/src/helpers/disconnectHelpers';

// ── Mock helpers ──────────────────────────────────────────────────────────────

const BluePlayer = { tag: 'BluePlayer' };
const RedPlayer = { tag: 'RedPlayer' };
const Spectator = { tag: 'Spectator' };
const BlueCoach = { tag: 'BlueCoach' };

/** Create a mock ctx with configurable table data */
function mockCtx(opts: {
    matchResults?: any[];
    lobbyMembers?: any[];
    matchSession?: any;
}) {
    return {
        db: {
            MatchResultRecord: {
                lobby_id: {
                    filter: (lobbyId: number) =>
                        (opts.matchResults ?? []).filter((r: any) => r.lobbyId === lobbyId),
                },
            },
            LobbyMember: {
                lobby_id: {
                    filter: (lobbyId: number) =>
                        (opts.lobbyMembers ?? []).filter((m: any) => m.lobbyId === lobbyId),
                },
            },
            MatchSession: {
                lobbyId: {
                    find: (lobbyId: number) =>
                        opts.matchSession?.lobbyId === lobbyId ? opts.matchSession : null,
                },
            },
        },
    };
}

function ts(micros: bigint) {
    return { microsSinceUnixEpoch: micros };
}

// ── ensureMatchAlive ──────────────────────────────────────────────────────────

describe('ensureMatchAlive', () => {
    it('throws when lobby is AwaitingResult', () => {
        const ctx = mockCtx({});
        const lobby = { id: 1, stage: { tag: 'AwaitingResult' } };
        expect(() => ensureMatchAlive(ctx, lobby)).toThrow('Match has ended.');
    });

    it('throws when lobby is Finished', () => {
        const ctx = mockCtx({});
        const lobby = { id: 1, stage: { tag: 'Finished' } };
        expect(() => ensureMatchAlive(ctx, lobby)).toThrow('Match has ended.');
    });

    it('passes when Drafting with no concede record', () => {
        const ctx = mockCtx({ matchResults: [] });
        const lobby = { id: 1, stage: { tag: 'Drafting' } };
        expect(() => ensureMatchAlive(ctx, lobby)).not.toThrow();
    });

    it('throws when Drafting but concede record exists', () => {
        const ctx = mockCtx({
            matchResults: [{ lobbyId: 1, matchEndReason: { tag: 'Concede' } }],
        });
        const lobby = { id: 1, stage: { tag: 'Drafting' } };
        expect(() => ensureMatchAlive(ctx, lobby)).toThrow('Match has been conceded.');
    });

    // Phase 10.1: matchEndReason edge cases (D-31, D-32)
    it('passes when matchEndReason is Completed (not concede)', () => {
        const ctx = mockCtx({
            matchResults: [{ lobbyId: 1, matchEndReason: { tag: 'Completed' } }],
        });
        const lobby = { id: 1, stage: { tag: 'Drafting' } };
        expect(() => ensureMatchAlive(ctx, lobby)).not.toThrow();
    });

    it('passes when matchResult exists but matchEndReason is undefined', () => {
        const ctx = mockCtx({
            matchResults: [{ lobbyId: 1, matchEndReason: undefined }],
        });
        const lobby = { id: 1, stage: { tag: 'Drafting' } };
        expect(() => ensureMatchAlive(ctx, lobby)).not.toThrow();
    });
});

// ── buildConcedeSummary ───────────────────────────────────────────────────────

describe('buildConcedeSummary', () => {
    it('builds summary with anonymous labels', () => {
        const ctx = mockCtx({ matchSession: { lobbyId: 1, turnIndex: 7 } });
        const lobby = { id: 1, isAnonymousPlayers: true, stage: { tag: 'Drafting' } };
        const members = [
            { userId: 42, lobbySlot: BluePlayer, disconnectPoolRemainingMs: 180000 },
        ];
        const result = buildConcedeSummary(ctx, lobby, members, 99, 'VoluntaryLeave');
        expect(result).toContain('Blue-Player (userId: 42)');
        expect(result).toContain('step 7');
        expect(result).toContain('180000ms');
        expect(result).toContain('VoluntaryLeave by userId:99');
    });

    it('builds summary with non-anonymous labels', () => {
        const ctx = mockCtx({ matchSession: { lobbyId: 1, turnIndex: 3 } });
        const lobby = { id: 1, isAnonymousPlayers: false, stage: { tag: 'Equipping' } };
        const members = [
            { userId: 10, lobbySlot: RedPlayer, disconnectPoolRemainingMs: 60000 },
        ];
        const result = buildConcedeSummary(ctx, lobby, members, 10, 'Disconnect');
        expect(result).toContain('User#10');
        expect(result).toContain('stage: Equipping');
    });

    it('handles multiple disconnected members', () => {
        const ctx = mockCtx({ matchSession: { lobbyId: 1, turnIndex: 0 } });
        const lobby = { id: 1, isAnonymousPlayers: false, stage: { tag: 'Scoring' } };
        const members = [
            { userId: 5, lobbySlot: BluePlayer, disconnectPoolRemainingMs: 0 },
            { userId: 8, lobbySlot: BluePlayer, disconnectPoolRemainingMs: 0 },
        ];
        const result = buildConcedeSummary(ctx, lobby, members, 20, 'Disconnect');
        expect(result).toContain('User#5');
        expect(result).toContain('User#8');
        expect(result).toContain(', ');
    });

    it('handles no match session (turnIndex defaults to 0)', () => {
        const ctx = mockCtx({});
        const lobby = { id: 99, isAnonymousPlayers: false, stage: { tag: 'Drafting' } };
        const members = [
            { userId: 1, lobbySlot: RedPlayer, disconnectPoolRemainingMs: 300000 },
        ];
        const result = buildConcedeSummary(ctx, lobby, members, 1, 'DeferMatch');
        expect(result).toContain('step 0');
    });

    it('handles empty disconnected members (pool defaults to 0)', () => {
        const ctx = mockCtx({ matchSession: { lobbyId: 1, turnIndex: 5 } });
        const lobby = { id: 1, isAnonymousPlayers: false, stage: { tag: 'Drafting' } };
        const result = buildConcedeSummary(ctx, lobby, [], 1, 'DeferMatch');
        expect(result).toContain('pool remaining: 0ms');
    });
});

// ── handleDisconnectPoolUpdate ────────────────────────────────────────────────

describe('handleDisconnectPoolUpdate', () => {
    it('returns full pool when not disconnected', () => {
        const ctx = mockCtx({});
        const member = { disconnectedAt: undefined, disconnectPoolRemainingMs: 300000 };
        const lobby = {};
        const now = ts(1000000n);
        expect(handleDisconnectPoolUpdate(ctx, member, lobby, now)).toBe(300000);
    });

    it('returns remaining pool after partial elapsed time', () => {
        const ctx = mockCtx({});
        // Disconnected 100 seconds ago (100,000,000 micros = 100,000 ms)
        const member = {
            disconnectedAt: ts(0n),
            disconnectPoolRemainingMs: 300000,
        };
        const lobby = {};
        const now = ts(100_000_000n); // 100s in micros
        // 300000 - 100000 = 200000
        expect(handleDisconnectPoolUpdate(ctx, member, lobby, now)).toBe(200000);
    });

    it('returns 0 when elapsed exceeds pool', () => {
        const ctx = mockCtx({});
        // Disconnected 600 seconds ago (600,000,000 micros = 600,000 ms), pool is 300000ms
        const member = {
            disconnectedAt: ts(0n),
            disconnectPoolRemainingMs: 300000,
        };
        const lobby = {};
        const now = ts(600_000_000n);
        expect(handleDisconnectPoolUpdate(ctx, member, lobby, now)).toBe(0);
    });

    it('returns 0 when exactly depleted', () => {
        const ctx = mockCtx({});
        const member = {
            disconnectedAt: ts(0n),
            disconnectPoolRemainingMs: 300000,
        };
        const lobby = {};
        const now = ts(300_000_000n); // exactly 300s
        expect(handleDisconnectPoolUpdate(ctx, member, lobby, now)).toBe(0);
    });
});

// ── isForfeitEligible ─────────────────────────────────────────────────────────

describe('isForfeitEligible', () => {
    const baseNow = ts(120_000_000n); // 120s in micros
    const baseLobby = { id: 1, disconnectForfeitSeconds: 60 };

    it('returns true when all team players offline + grace expired', () => {
        const ctx = mockCtx({
            lobbyMembers: [
                { lobbyId: 1, userId: 10, lobbySlot: RedPlayer, isOnline: false, voluntarilyLeft: false, disconnectedAt: ts(0n), disconnectPoolRemainingMs: 300000 },
            ],
        });
        expect(isForfeitEligible(ctx, baseLobby, 'Red', baseNow)).toBe(true);
    });

    it('returns false when one player is still online', () => {
        const ctx = mockCtx({
            lobbyMembers: [
                { lobbyId: 1, userId: 10, lobbySlot: RedPlayer, isOnline: false, voluntarilyLeft: false, disconnectedAt: ts(0n), disconnectPoolRemainingMs: 300000 },
                { lobbyId: 1, userId: 11, lobbySlot: RedPlayer, isOnline: true, voluntarilyLeft: false, disconnectedAt: undefined, disconnectPoolRemainingMs: 300000 },
            ],
        });
        expect(isForfeitEligible(ctx, baseLobby, 'Red', baseNow)).toBe(false);
    });

    it('returns true when pool depleted (regardless of grace)', () => {
        const ctx = mockCtx({
            lobbyMembers: [
                { lobbyId: 1, userId: 10, lobbySlot: RedPlayer, isOnline: false, voluntarilyLeft: false, disconnectedAt: ts(100_000_000n), disconnectPoolRemainingMs: 0 },
            ],
        });
        // Only 20s since disconnect but pool=0 → immediately eligible
        expect(isForfeitEligible(ctx, baseLobby, 'Red', baseNow)).toBe(true);
    });

    it('returns false when no disconnectedAt', () => {
        const ctx = mockCtx({
            lobbyMembers: [
                { lobbyId: 1, userId: 10, lobbySlot: RedPlayer, isOnline: false, voluntarilyLeft: false, disconnectedAt: undefined, disconnectPoolRemainingMs: 300000 },
            ],
        });
        expect(isForfeitEligible(ctx, baseLobby, 'Red', baseNow)).toBe(false);
    });

    it('returns false for empty team', () => {
        const ctx = mockCtx({ lobbyMembers: [] });
        expect(isForfeitEligible(ctx, baseLobby, 'Red', baseNow)).toBe(false);
    });

    it('excludes voluntarilyLeft members', () => {
        const ctx = mockCtx({
            lobbyMembers: [
                { lobbyId: 1, userId: 10, lobbySlot: RedPlayer, isOnline: false, voluntarilyLeft: true, disconnectedAt: ts(0n), disconnectPoolRemainingMs: 0 },
            ],
        });
        // The only Red player voluntarily left — team is "empty" → false
        expect(isForfeitEligible(ctx, baseLobby, 'Red', baseNow)).toBe(false);
    });
});

// ── isThirdPartyReferee ───────────────────────────────────────────────────────

describe('isThirdPartyReferee', () => {
    it('returns spectator referee when present', () => {
        const ctx = mockCtx({
            lobbyMembers: [
                { lobbyId: 1, userId: 5, lobbySlot: Spectator, isReferee: true, voluntarilyLeft: false },
                { lobbyId: 1, userId: 10, lobbySlot: BluePlayer, isReferee: false, voluntarilyLeft: false },
            ],
        });
        const ref = isThirdPartyReferee(ctx, 1);
        expect(ref).not.toBeNull();
        expect(ref.userId).toBe(5);
    });

    it('returns null when no referee exists', () => {
        const ctx = mockCtx({
            lobbyMembers: [
                { lobbyId: 1, userId: 10, lobbySlot: BluePlayer, isReferee: false, voluntarilyLeft: false },
            ],
        });
        expect(isThirdPartyReferee(ctx, 1)).toBeNull();
    });

    it('returns null when referee is on a team (not 3rd party)', () => {
        const ctx = mockCtx({
            lobbyMembers: [
                { lobbyId: 1, userId: 10, lobbySlot: BluePlayer, isReferee: true, voluntarilyLeft: false },
            ],
        });
        expect(isThirdPartyReferee(ctx, 1)).toBeNull();
    });

    it('returns null when spectator referee voluntarilyLeft', () => {
        const ctx = mockCtx({
            lobbyMembers: [
                { lobbyId: 1, userId: 5, lobbySlot: Spectator, isReferee: true, voluntarilyLeft: true },
            ],
        });
        expect(isThirdPartyReferee(ctx, 1)).toBeNull();
    });
});
