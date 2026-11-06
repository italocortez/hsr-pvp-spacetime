/**
 * Integration tests: Tournament cancel cascade, cleanup, and assistant upsert.
 *
 * Covers:
 * - cancel_tournament from Registration → cascade deletes teams, assistants, player accounts
 * - cancel_tournament preserves TournamentEnrolled rows (audit trail)
 * - cancel already-Cancelled → rejected (terminal state)
 * - cancel_tournament from InProgress → cascade deletes bracket matches, teams
 * - cancel Completed tournament → rejected (terminal state)
 * - assign_tournament_assistant upsert → permissions updated on reassign
 * - cancel_tournament cascade deletes CalendarEvent + CalendarEventInvite linked
 *   to bracket matches (D-21)
 *
 * Coverage gap: cleanupTeamRequests on Registration→Seeding not directly tested
 * (requires team tournament with pending requests — 6+ harnesses). Tested indirectly
 * via cancel cascade which calls cleanupTeamRequests internally.
 *
 * Contract: docs/tournament/contract.md
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
    createVerifiedTestHarness,
    hasServerToken,
    expectReducerError,
    type TestHarness,
} from '../../shared/connection';
import { promoteUser } from '../../shared/helpers/promoteUser';
import { getUsername } from '../../shared/helpers/users';
import {
    createTournamentArgs as sharedCreateTournamentArgs,
    setupRegistrationTournament as sharedSetupRegistrationTournament,
    advanceToInProgress,
    cleanupTournament,
} from '../../shared/helpers/tournaments';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** BigInt micros timestamp string offset from now */
function tsStr(offsetMs: number): string {
    return (BigInt(Date.now() + offsetMs) * 1000n).toString();
}

const createTournamentArgs = (overrides: Record<string, unknown> = {}) =>
    sharedCreateTournamentArgs({ name: `Cancel Test ${Date.now()}`, ...overrides });

const setupRegistrationTournament = (
    toUser: TestHarness,
    players: TestHarness[],
    overrides: Record<string, unknown> = {},
): Promise<number> =>
    sharedSetupRegistrationTournament(toUser, players, { name: `Cancel Test ${Date.now()}`, ...overrides });

// ─── Tests ──────────────────────────────────────────────────────────────────

describe.skipIf(!hasServerToken())('Tournament Cancel & Cleanup', () => {
    let toUser: TestHarness;
    let p1: TestHarness;
    let p2: TestHarness;
    let assistant: TestHarness;
    const openedTournamentIds: number[] = [];

    beforeAll(async () => {
        toUser = await createVerifiedTestHarness();
        p1 = await createVerifiedTestHarness();
        p2 = await createVerifiedTestHarness();
        assistant = await createVerifiedTestHarness();

        await toUser.sync();

        // Promote TO
        await promoteUser(getUsername(toUser), 'TournamentHost');
        await toUser.sync(1500);
    }, 60000);

    afterAll(async () => {
        // D-03: strict cleanup per resource opened (safety net — tests already
        // cancel most tournaments as part of scenarios; swallow terminal errors)
        for (const tid of openedTournamentIds) {
            await cleanupTournament(toUser, tid);
        }
        await toUser?.disconnect();
        await p1?.disconnect();
        await p2?.disconnect();
        await assistant?.disconnect();
    });

    // ═══ Cancel from Registration ═══════════════════════════════════════════

    describe('cancel from Registration', () => {
        let tournamentId: number;

        beforeAll(async () => {
            tournamentId = await setupRegistrationTournament(toUser, [p1, p2]);
            openedTournamentIds.push(tournamentId);

            // Assign an assistant so cascade has something to delete
            await toUser.call.assignTournamentAssistant({
                tournamentId,
                userId: assistant.userId,
                canValidateResults: true,
                canOverrideResults: false,
                canDqParticipants: false,
                canManageBracket: false,
                canAssignSeeds: false,
            });
            await toUser.sync(1500);
        }, 30000);

        it('cascade deletes teams, assistants; preserves participants', async () => {
            // Pre-state: teams and assistant exist
            const teamsBefore = [...toUser.conn.db.TournamentTeam.iter()].filter(
                t => t.tournamentId === tournamentId
            );
            expect(teamsBefore.length).toBeGreaterThan(0);

            const assistantsBefore = [...toUser.conn.db.TournamentAssistant.iter()].filter(
                a => a.tournamentId === tournamentId
            );
            expect(assistantsBefore.length).toBe(1);

            // Cancel
            await toUser.call.cancelTournament({ tournamentId });
            await toUser.sync(1500);

            // Teams deleted
            const teamsAfter = [...toUser.conn.db.TournamentTeam.iter()].filter(
                t => t.tournamentId === tournamentId
            );
            expect(teamsAfter.length).toBe(0);

            // Assistants deleted
            const assistantsAfter = [...toUser.conn.db.TournamentAssistant.iter()].filter(
                a => a.tournamentId === tournamentId
            );
            expect(assistantsAfter.length).toBe(0);

            // Participants preserved (audit trail)
            const participants = [...toUser.conn.db.TournamentEnrolled.iter()].filter(
                p => p.tournamentId === tournamentId
            );
            expect(participants.length).toBe(2);

            // Stage is Cancelled
            const tournament = [...toUser.conn.db.Tournament.iter()].find(
                t => t.id === tournamentId
            );
            expect(tournament?.stage.tag).toBe('Cancelled');
        });

        it('cancel already-Cancelled → rejected (terminal state)', async () => {
            const msg = await expectReducerError(
                toUser.call.cancelTournament({ tournamentId })
            );
            expect(msg.toLowerCase()).toMatch(/cancel|terminal|transition/);
        });
    });

    // ═══ Cancel from InProgress ═════════════════════════════════════════════

    describe('cancel from InProgress', () => {
        let tournamentId: number;

        beforeAll(async () => {
            tournamentId = await setupRegistrationTournament(toUser, [p1, p2], {
                name: `Cancel InProg ${Date.now()}`,
            });
            openedTournamentIds.push(tournamentId);
            await advanceToInProgress(toUser, tournamentId);
        }, 45000);

        it('cascade deletes bracket matches and teams; preserves participants', async () => {
            // Pre-state: brackets exist
            const bracketsBefore = [...toUser.conn.db.BracketMatch.iter()].filter(
                bm => bm.tournamentId === tournamentId
            );
            expect(bracketsBefore.length).toBeGreaterThan(0);

            // Cancel
            await toUser.call.cancelTournament({ tournamentId });
            await toUser.sync(1500);

            // Bracket matches deleted
            const bracketsAfter = [...toUser.conn.db.BracketMatch.iter()].filter(
                bm => bm.tournamentId === tournamentId
            );
            expect(bracketsAfter.length).toBe(0);

            // Teams deleted
            const teamsAfter = [...toUser.conn.db.TournamentTeam.iter()].filter(
                t => t.tournamentId === tournamentId
            );
            expect(teamsAfter.length).toBe(0);

            // Participants preserved
            const participants = [...toUser.conn.db.TournamentEnrolled.iter()].filter(
                p => p.tournamentId === tournamentId
            );
            expect(participants.length).toBe(2);

            // Stage is Cancelled
            const tournament = [...toUser.conn.db.Tournament.iter()].find(
                t => t.id === tournamentId
            );
            expect(tournament?.stage.tag).toBe('Cancelled');
        });
    });

    // ═══ Cancel Completed → rejected ════════════════════════════════════════

    describe('cancel Completed → rejected', () => {
        let tournamentId: number;

        beforeAll(async () => {
            tournamentId = await setupRegistrationTournament(toUser, [p1, p2], {
                name: `Cancel Comp ${Date.now()}`,
            });
            openedTournamentIds.push(tournamentId);
            await advanceToInProgress(toUser, tournamentId);

            // Fast-track to Completed (no match validation required)
            await toUser.call.advanceTournamentStage({ tournamentId, nextStage: 'Completed' });
            await toUser.sync(1500);
        }, 45000);

        it('cancel Completed tournament → terminal state error', async () => {
            const msg = await expectReducerError(
                toUser.call.cancelTournament({ tournamentId })
            );
            expect(msg.toLowerCase()).toMatch(/cancel|completed|terminal|transition/);
        });
    });

    // ═══ Cancel cascade deletes CalendarEvent linked to bracket (D-21) ═════

    describe('cancel cascade deletes CalendarEvent for bracket matches', () => {
        let tournamentId: number;
        let bracketMatchId: number;
        let calendarEventId: number;

        beforeAll(async () => {
            // Create tournament → advance to InProgress with bracket
            tournamentId = await setupRegistrationTournament(toUser, [p1, p2], {
                name: `Cancel Calendar ${Date.now()}`,
            });
            openedTournamentIds.push(tournamentId);
            await advanceToInProgress(toUser, tournamentId);

            // Find a bracket match
            const matches = [...toUser.conn.db.BracketMatch.iter()].filter(
                bm => bm.tournamentId === tournamentId
            );
            expect(matches.length).toBeGreaterThan(0);
            bracketMatchId = matches[0].id;

            // Create a CalendarEvent linked to that bracket match
            await toUser.call.createCalendarEvent({
                title: `Match #${bracketMatchId} Schedule`,
                description: 'Tournament match',
                startAt: tsStr(3600_000),
                endAt: tsStr(7200_000),
                bracketMatchId,
                inviteeUserIds: `${p1.userId},${p2.userId}`,
            });
            await toUser.sync(1500);

            // Find the created event
            const events = [...toUser.conn.db.CalendarEvent.iter()].filter(
                e => e.bracketMatchId === bracketMatchId
            );
            expect(events.length).toBeGreaterThanOrEqual(1);
            calendarEventId = events[events.length - 1].id;

            // Verify invites exist
            const invites = [...toUser.conn.db.CalendarEventInvite.iter()].filter(
                i => i.eventId === calendarEventId
            );
            expect(invites.length).toBe(2);
        }, 60000);

        it('cancel deletes CalendarEvent and invites linked to bracket matches', async () => {
            // Cancel tournament
            await toUser.call.cancelTournament({ tournamentId });
            await toUser.sync(1500);

            // CalendarEvent deleted
            const eventsAfter = [...toUser.conn.db.CalendarEvent.iter()].filter(
                e => e.id === calendarEventId
            );
            expect(eventsAfter.length).toBe(0);

            // CalendarEventInvite rows also deleted
            const invitesAfter = [...toUser.conn.db.CalendarEventInvite.iter()].filter(
                i => i.eventId === calendarEventId
            );
            expect(invitesAfter.length).toBe(0);
        });
    });

    // ═══ Assistant upsert ════════════════════════════════════════════════════

    describe('assistant upsert', () => {
        let tournamentId: number;

        beforeAll(async () => {
            await toUser.call.createTournament(createTournamentArgs({
                name: `Upsert Test ${Date.now()}`,
            }));
            await toUser.sync(1500);

            const tournaments = [...toUser.conn.db.Tournament.iter()].filter(
                t => t.organizerId === toUser.userId
            );
            tournamentId = tournaments[tournaments.length - 1].id;
            openedTournamentIds.push(tournamentId);
        }, 15000);

        it('reassigning assistant updates permissions (upsert)', async () => {
            // First assign: validate=true, override=false
            await toUser.call.assignTournamentAssistant({
                tournamentId,
                userId: assistant.userId,
                canValidateResults: true,
                canOverrideResults: false,
                canDqParticipants: false,
                canManageBracket: false,
                canAssignSeeds: false,
            });
            await toUser.sync(1500);

            const before = [...toUser.conn.db.TournamentAssistant.iter()].find(
                a => a.tournamentId === tournamentId && a.userId === assistant.userId
            );
            expect(before?.canValidateResults).toBe(true);
            expect(before?.canOverrideResults).toBe(false);

            // Reassign with different permissions
            await toUser.call.assignTournamentAssistant({
                tournamentId,
                userId: assistant.userId,
                canValidateResults: false,
                canOverrideResults: true,
                canDqParticipants: true,
                canManageBracket: true,
                canAssignSeeds: true,
            });
            await toUser.sync(1500);

            const after = [...toUser.conn.db.TournamentAssistant.iter()].find(
                a => a.tournamentId === tournamentId && a.userId === assistant.userId
            );
            expect(after?.canValidateResults).toBe(false);
            expect(after?.canOverrideResults).toBe(true);
            expect(after?.canDqParticipants).toBe(true);
            expect(after?.canManageBracket).toBe(true);
            expect(after?.canAssignSeeds).toBe(true);
        });
    });
});
