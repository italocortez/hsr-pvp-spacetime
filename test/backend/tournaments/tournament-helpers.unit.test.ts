/**
 * Unit tests: Phase 10.1 tournament helper functions.
 *
 * - transferTournamentCaptain: deterministic captain handoff (D-21, D-22)
 * - validateRegistrationToSeeding: enrollment + team completeness checks
 * - removeUncheckedInParticipants: CheckIn→Seeding prune logic (D-37)
 *
 * Contract: docs/tournament/contract.md
 */

import { describe, it, expect, vi } from 'vitest';
import {
    transferTournamentCaptain,
    validateRegistrationToSeeding,
    removeUncheckedInParticipants,
} from '../../../spacetimedb/src/helpers/tournamentHelpers';

// ── Mock helpers ─────────────────────────────────────────────────────────────

/** Build a mock ctx.db with configurable table data and mutation tracking */
function mockCtx(opts: {
    teams?: any[];
    teamMembers?: any[];
    enrolled?: any[];
    tournament?: any;
    tpa?: any[];
}) {
    const teams = [...(opts.teams ?? [])];
    const teamMembers = [...(opts.teamMembers ?? [])];
    const enrolled = [...(opts.enrolled ?? [])];
    const tpa = [...(opts.tpa ?? [])];

    // Track mutations for assertions
    const deleted: { table: string; item: any }[] = [];
    const updated: { table: string; item: any }[] = [];

    return {
        db: {
            TournamentTeam: {
                id: {
                    find: (id: number) => teams.find(t => t.id === id),
                    update: (item: any) => {
                        const idx = teams.findIndex(t => t.id === item.id);
                        if (idx >= 0) teams[idx] = item;
                        updated.push({ table: 'TournamentTeam', item });
                    },
                    delete: (id: number) => {
                        const idx = teams.findIndex(t => t.id === id);
                        if (idx >= 0) {
                            deleted.push({ table: 'TournamentTeam', item: teams[idx] });
                            teams.splice(idx, 1);
                        }
                    },
                },
                tournament_id: {
                    filter: (tid: number) => teams.filter(t => t.tournamentId === tid),
                },
            },
            TournamentTeamMember: {
                team_id: {
                    filter: (tid: number) => teamMembers.filter(m => m.teamId === tid),
                },
                by_tournament_and_user: {
                    filter: (args: [number, number]) =>
                        teamMembers.filter(m => m.tournamentId === args[0] && m.userId === args[1]),
                },
                delete: (item: any) => {
                    const idx = teamMembers.findIndex(
                        m => m.teamId === item.teamId && m.userId === item.userId
                    );
                    if (idx >= 0) {
                        deleted.push({ table: 'TournamentTeamMember', item: teamMembers[idx] });
                        teamMembers.splice(idx, 1);
                    }
                },
            },
            TournamentEnrolled: {
                tournament_id: {
                    filter: (tid: number) => enrolled.filter(e => e.tournamentId === tid),
                },
                by_tournament_and_user: {
                    delete: (args: [number, number]) => {
                        const idx = enrolled.findIndex(e => e.tournamentId === args[0] && e.userId === args[1]);
                        if (idx >= 0) {
                            deleted.push({ table: 'TournamentEnrolled', item: enrolled[idx] });
                            enrolled.splice(idx, 1);
                        }
                    },
                },
            },
            Tournament: {
                id: {
                    find: (id: number) => opts.tournament?.id === id ? opts.tournament : null,
                },
            },
            TournamentPlayerAccount: {
                by_tournament_and_user: {
                    filter: (args: [number, number]) =>
                        tpa.filter(t => t.tournamentId === args[0] && t.userId === args[1]),
                },
                delete: (item: any) => {
                    const idx = tpa.findIndex(
                        t => t.tournamentId === item.tournamentId && t.userId === item.userId
                    );
                    if (idx >= 0) {
                        deleted.push({ table: 'TournamentPlayerAccount', item: tpa[idx] });
                        tpa.splice(idx, 1);
                    }
                },
            },
        },
        // Expose internal state for assertions
        _teams: teams,
        _teamMembers: teamMembers,
        _enrolled: enrolled,
        _deleted: deleted,
        _updated: updated,
        sender: BigInt(0),
    };
}

// ── transferTournamentCaptain ────────────────────────────────────────────────

describe('transferTournamentCaptain', () => {
    it('transfers to lowest userId when captain leaves (D-21)', () => {
        const ctx = mockCtx({
            teams: [{ id: 1, captainUserId: 10, tournamentId: 1 }],
            teamMembers: [
                { teamId: 1, userId: 10, tournamentId: 1 },
                { teamId: 1, userId: 25, tournamentId: 1 },
                { teamId: 1, userId: 15, tournamentId: 1 },
            ],
        });

        const result = transferTournamentCaptain(ctx, 1, 10, 99);

        expect(result).toBe(true);
        expect(ctx._teams[0].captainUserId).toBe(15); // lowest non-leaving userId
    });

    it('returns false when last member leaves (no one to transfer to)', () => {
        const ctx = mockCtx({
            teams: [{ id: 1, captainUserId: 10, tournamentId: 1 }],
            teamMembers: [
                { teamId: 1, userId: 10, tournamentId: 1 },
            ],
        });

        const result = transferTournamentCaptain(ctx, 1, 10, 99);

        expect(result).toBe(false);
    });

    it('returns false when leaving user is not the captain (no-op)', () => {
        const ctx = mockCtx({
            teams: [{ id: 1, captainUserId: 10, tournamentId: 1 }],
            teamMembers: [
                { teamId: 1, userId: 10, tournamentId: 1 },
                { teamId: 1, userId: 20, tournamentId: 1 },
            ],
        });

        const result = transferTournamentCaptain(ctx, 1, 20, 99);

        expect(result).toBe(false);
        expect(ctx._teams[0].captainUserId).toBe(10); // unchanged
    });
});

// ── validateRegistrationToSeeding ────────────────────────────────────────────

describe('validateRegistrationToSeeding', () => {
    it('throws when fewer than 2 active enrolled participants', () => {
        const ctx = mockCtx({
            tournament: { id: 1, teamSize: 1 },
            enrolled: [
                { tournamentId: 1, userId: 1, status: { tag: 'Registered' }, isWaitlisted: false },
            ],
        });

        expect(() => validateRegistrationToSeeding(ctx, 1)).toThrow(/at least 2 active/i);
    });

    it('throws for team tournament with fewer than 2 complete teams', () => {
        const ctx = mockCtx({
            tournament: { id: 1, teamSize: 2 },
            enrolled: [
                { tournamentId: 1, userId: 1, status: { tag: 'Registered' }, isWaitlisted: false },
                { tournamentId: 1, userId: 2, status: { tag: 'Registered' }, isWaitlisted: false },
                { tournamentId: 1, userId: 3, status: { tag: 'Registered' }, isWaitlisted: false },
            ],
            teams: [
                { id: 1, tournamentId: 1, captainUserId: 1 },
                { id: 2, tournamentId: 1, captainUserId: 3 },
            ],
            teamMembers: [
                { teamId: 1, userId: 1, tournamentId: 1 },
                { teamId: 1, userId: 2, tournamentId: 1 }, // team 1: 2 members (complete)
                { teamId: 2, userId: 3, tournamentId: 1 },  // team 2: 1 member (incomplete)
            ],
        });

        expect(() => validateRegistrationToSeeding(ctx, 1)).toThrow(/at least 2 complete teams/i);
    });

    it('passes for solo tournament with 2+ active enrolled', () => {
        const ctx = mockCtx({
            tournament: { id: 1, teamSize: 1 },
            enrolled: [
                { tournamentId: 1, userId: 1, status: { tag: 'Registered' }, isWaitlisted: false },
                { tournamentId: 1, userId: 2, status: { tag: 'Registered' }, isWaitlisted: false },
            ],
        });

        expect(() => validateRegistrationToSeeding(ctx, 1)).not.toThrow();
    });
});

// ── removeUncheckedInParticipants ────────────────────────────────────────────

describe('removeUncheckedInParticipants', () => {
    it('keeps CheckedIn, removes Registered (D-37)', () => {
        const ctx = mockCtx({
            enrolled: [
                { tournamentId: 1, userId: 10, status: { tag: 'CheckedIn' }, isWaitlisted: false },
                { tournamentId: 1, userId: 20, status: { tag: 'Registered' }, isWaitlisted: false },
                { tournamentId: 1, userId: 30, status: { tag: 'CheckedIn' }, isWaitlisted: false },
            ],
            teamMembers: [
                { teamId: 1, userId: 20, tournamentId: 1 },
            ],
            teams: [
                { id: 1, captainUserId: 20, tournamentId: 1 },
            ],
        });

        removeUncheckedInParticipants(ctx, 1, 99);

        // User 20 (Registered) should be removed
        expect(ctx._enrolled.length).toBe(2);
        expect(ctx._enrolled.find((e: any) => e.userId === 20)).toBeUndefined();
        // Users 10 and 30 (CheckedIn) should remain
        expect(ctx._enrolled.find((e: any) => e.userId === 10)).toBeDefined();
        expect(ctx._enrolled.find((e: any) => e.userId === 30)).toBeDefined();
    });

    it('handles captain removal with transfer and team cleanup', () => {
        const ctx = mockCtx({
            enrolled: [
                { tournamentId: 1, userId: 10, status: { tag: 'Registered' }, isWaitlisted: false },
            ],
            teamMembers: [
                { teamId: 1, userId: 10, tournamentId: 1 },
            ],
            teams: [
                { id: 1, captainUserId: 10, tournamentId: 1 },
            ],
        });

        removeUncheckedInParticipants(ctx, 1, 99);

        // Enrolled row removed
        expect(ctx._enrolled.length).toBe(0);
        // Team member removed
        expect(ctx._teamMembers.length).toBe(0);
        // Team destroyed (last member removed, transferTournamentCaptain returns false)
        expect(ctx._deleted.some((d: any) => d.table === 'TournamentTeam' && d.item.id === 1)).toBe(true);
    });
});
