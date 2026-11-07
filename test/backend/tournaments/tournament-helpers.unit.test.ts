/**
 * Unit tests: Phase 10.1 tournament helper functions.
 *
 * - transferTournamentCaptain: deterministic captain handoff (D-21, D-22)
 *
 * Contract: docs/tournament/contract.md
 */

import { describe, it, expect, vi } from 'vitest';
import {
    transferTournamentCaptain,
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

// T-S8b: the validateRegistrationToSeeding and removeUncheckedInParticipants blocks were deleted with the helpers
// (S8b: closeRegistration + canCloseRegistration replace them, team-level check-in replaces the per-member prune).
// The behaviour is covered in-memory by spacetimedb/src/__tests__/s8b-tournament-lifecycle.test.ts.
