/**
 * Integration tests: Tournament stage advancement and cancellation.
 *
 * Covers:
 * - Advance Draft -> Registration (happy path)
 * - Advance Registration -> Seeding with 2+ participants
 * - Reject stage skip (Draft -> InProgress)
 * - Reject backward transition (Registration -> Draft)
 * - Cancel from Draft
 * - Cancel from Registration
 * - Cancel already-cancelled tournament
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createVerifiedTestHarness, hasServerToken, expectReducerError, type TestHarness } from '../../shared/connection';
import { promoteToRole } from '../../shared/helpers/promoteUser';
import { cleanupTournament } from '../../shared/helpers/tournaments';

describe.skipIf(!hasServerToken())('Tournament Stages', () => {
  let host: TestHarness;
  let player1: TestHarness;
  let player2: TestHarness;
  const openedTournamentIds: number[] = [];

  const hostTournaments = () => [...host.conn.db.Tournament.iter()].filter(t => t.organizerId === host.userId);

  /** Helper to create a standard tournament and return its id */
  async function createStandardTournament(name: string): Promise<number> {
    const countBefore = hostTournaments().length;
    await host.call.createTournament({
      name,
      description: 'Stage advancement test',
      format: 'SingleElimination',
      teamSize: 1,
      defaultGameMode: 'MemoryOfChaos',
      maxParticipants: 8,
      rosterVisibility: 'OpenRoster',
      isAnonymousDefault: false,
      disconnectPolicy: 'Deferred',
      costSetId: 0,
      defaultBestOf: 3,
      groupSize: 4,
      has3RdPlaceMatch: false,
      autoAdvanceBracket: true,
      countTowardsMmr: false,
      winnerAdvantage: 0,
      requireOwnership: false,
      requireVerified: false,
      requireRoster: false,
      minimumMmr: 0,
      requireApproval: false,
      waitlistEnabled: false,
      scheduledStartAt: '',
      registrationDeadline: '',
      maxAccountsPerPlayer: 1,
    });
    await host.sync();

    const mine = hostTournaments();
    expect(mine.length).toBe(countBefore + 1);
    const tid = mine[mine.length - 1].id;
    openedTournamentIds.push(tid);
    return tid;
  }

  beforeAll(async () => {
    host = await createVerifiedTestHarness();
    player1 = await createVerifiedTestHarness();
    player2 = await createVerifiedTestHarness();

    await promoteToRole(host, 'TournamentHost');
  }, 30000);

  afterAll(async () => {
    // D-03: strict cleanup per resource opened
    for (const tid of openedTournamentIds) {
      await cleanupTournament(host, tid);
    }
    await host?.disconnect();
    await player1?.disconnect();
    await player2?.disconnect();
  });

  // ── Happy path: Draft -> Registration ──
  it('advances Draft -> Registration', async () => {
    const tid = await createStandardTournament('Stage Test: Draft->Reg');

    await host.call.advanceTournamentStage({ tournamentId: tid, nextStage: 'Registration' });
    await host.sync();

    const t = hostTournaments().find(t => t.id === tid);
    expect(t).toBeDefined();
    expect(t!.stage.tag).toBe('Registration');
  });

  // ── Happy path: Registration -> Seeding with 2 participants ──
  it('advances Registration -> Seeding with 2+ participants', async () => {
    const tid = await createStandardTournament('Stage Test: Reg->Seed');

    // Advance to Registration first
    await host.call.advanceTournamentStage({ tournamentId: tid, nextStage: 'Registration' });
    await host.sync();

    // Register 2 players
    await player1.call.registerForTournament({ tournamentId: tid });
    await player1.sync();
    await player2.call.registerForTournament({ tournamentId: tid });
    await player2.sync();

    // Verify participants exist
    await host.sync();
    const participants = [...host.conn.db.TournamentEnrolled.iter()].filter(
      p => p.tournamentId === tid && !p.isWaitlisted && p.status.tag !== 'Withdrawn'
    );
    expect(participants.length).toBeGreaterThanOrEqual(2);

    // Advance to Seeding
    await host.call.advanceTournamentStage({ tournamentId: tid, nextStage: 'Seeding' });
    await host.sync();

    const t = hostTournaments().find(t => t.id === tid);
    expect(t).toBeDefined();
    expect(t!.stage.tag).toBe('Seeding');
  });

  // ── Reject stage skip: Draft -> InProgress ──
  it('rejects stage skip (Draft -> InProgress)', async () => {
    const tid = await createStandardTournament('Stage Test: Skip');

    const msg = await expectReducerError(
      host.call.advanceTournamentStage({ tournamentId: tid, nextStage: 'InProgress' })
    );
    expect(msg.toLowerCase()).toMatch(/invalid|transition|stage/);
  });

  // ── Reject backward transition: Registration -> Draft ──
  it('rejects backward transition (Registration -> Draft)', async () => {
    const tid = await createStandardTournament('Stage Test: Backward');

    await host.call.advanceTournamentStage({ tournamentId: tid, nextStage: 'Registration' });
    await host.sync();

    const msg = await expectReducerError(
      host.call.advanceTournamentStage({ tournamentId: tid, nextStage: 'Draft' })
    );
    expect(msg.toLowerCase()).toMatch(/invalid|transition|stage/);
  });

  // ── Cancel from Draft ──
  it('cancels tournament from Draft', async () => {
    const tid = await createStandardTournament('Stage Test: Cancel Draft');

    await host.call.cancelTournament({ tournamentId: tid });
    await host.sync();

    const t = hostTournaments().find(t => t.id === tid);
    expect(t).toBeDefined();
    expect(t!.stage.tag).toBe('Cancelled');
  });

  // ── Cancel from Registration ──
  it('cancels tournament from Registration', async () => {
    const tid = await createStandardTournament('Stage Test: Cancel Reg');

    await host.call.advanceTournamentStage({ tournamentId: tid, nextStage: 'Registration' });
    await host.sync();

    await host.call.cancelTournament({ tournamentId: tid });
    await host.sync();

    const t = hostTournaments().find(t => t.id === tid);
    expect(t).toBeDefined();
    expect(t!.stage.tag).toBe('Cancelled');
  });

  // ── Cancel already-cancelled ──
  it('rejects cancelling an already-cancelled tournament', async () => {
    const tid = await createStandardTournament('Stage Test: Double Cancel');

    await host.call.cancelTournament({ tournamentId: tid });
    await host.sync();

    const msg = await expectReducerError(
      host.call.cancelTournament({ tournamentId: tid })
    );
    expect(msg.toLowerCase()).toMatch(/cancel|already/);
  });

  // ── Cancel cascade deletes infrastructure rows ──
  it('cancel cascade deletes teams, assistants, TPA; preserves participants', async () => {
    // Create a team tournament with infrastructure
    await host.call.createTournament({
      name: 'Stage Test: Cancel Cascade',
      description: 'Cascade cleanup test',
      format: 'SingleElimination',
      teamSize: 3,
      defaultGameMode: 'MemoryOfChaos',
      maxParticipants: 16,
      rosterVisibility: 'OpenRoster',
      isAnonymousDefault: false,
      disconnectPolicy: 'Deferred',
      costSetId: 0,
      defaultBestOf: 3,
      groupSize: 4,
      has3RdPlaceMatch: false,
      autoAdvanceBracket: true,
      countTowardsMmr: false,
      winnerAdvantage: 0,
      requireOwnership: false,
      requireVerified: false,
      requireRoster: false,
      minimumMmr: 0,
      requireApproval: false,
      waitlistEnabled: false,
      scheduledStartAt: '',
      registrationDeadline: '',
      maxAccountsPerPlayer: 1,
    });
    await host.sync();

    const mine = hostTournaments();
    const tid = mine[mine.length - 1].id;
    openedTournamentIds.push(tid);

    // Advance to Registration
    await host.call.advanceTournamentStage({ tournamentId: tid, nextStage: 'Registration' });
    await host.sync();

    // Register all 3 users
    await host.call.registerForTournament({ tournamentId: tid });
    await host.sync();
    await player1.call.registerForTournament({ tournamentId: tid });
    await player1.sync();
    await player2.call.registerForTournament({ tournamentId: tid });
    await player2.sync();

    // Host creates a team
    await host.call.createTournamentTeam({ tournamentId: tid, teamName: 'Cascade Team' });
    await host.sync();

    // Player1 requests to join
    const team = [...host.conn.db.TournamentTeam.iter()].find(
      t => t.tournamentId === tid && t.captainUserId === host.userId
    );
    expect(team).toBeDefined();
    await player1.call.requestJoinTeam({ teamId: team!.id });
    await player1.sync();

    // Assign player2 as assistant
    await host.call.assignTournamentAssistant({
      tournamentId: tid,
      userId: player2.userId,
      canValidateResults: true,
      canOverrideResults: false,
      canDqParticipants: false,
      canManageBracket: false,
      canAssignSeeds: false,
    });
    await host.sync();

    // Verify infrastructure exists before cancel
    const teamsBefore = [...host.conn.db.TournamentTeam.iter()].filter(t => t.tournamentId === tid);
    const requestsBefore = [...host.conn.db.TournamentTeamRequest.iter()].filter(r => r.teamId === team!.id);
    const assistantsBefore = [...host.conn.db.TournamentAssistant.iter()].filter(a => a.tournamentId === tid);
    expect(teamsBefore.length).toBeGreaterThan(0);
    expect(requestsBefore.length).toBeGreaterThan(0);
    expect(assistantsBefore.length).toBeGreaterThan(0);

    // Cancel tournament
    await host.call.cancelTournament({ tournamentId: tid });
    await host.sync();
    await player1.sync();
    await player2.sync();

    // Verify stage is Cancelled
    const t = hostTournaments().find(t => t.id === tid);
    expect(t!.stage.tag).toBe('Cancelled');

    // Verify cascade: teams, requests, assistants deleted
    const teamsAfter = [...host.conn.db.TournamentTeam.iter()].filter(t => t.tournamentId === tid);
    const requestsAfter = [...host.conn.db.TournamentTeamRequest.iter()].filter(
      r => teamsBefore.some(t => t.id === r.teamId)
    );
    const assistantsAfter = [...host.conn.db.TournamentAssistant.iter()].filter(a => a.tournamentId === tid);
    expect(teamsAfter.length).toBe(0);
    expect(requestsAfter.length).toBe(0);
    expect(assistantsAfter.length).toBe(0);

    // Verify TPA rows deleted
    const tpaAfter = [...host.conn.db.TournamentPlayerAccount.iter()].filter(
      tpa => tpa.tournamentId === tid
    );
    expect(tpaAfter.length).toBe(0);

    // Verify participants PRESERVED
    const participants = [...host.conn.db.TournamentEnrolled.iter()].filter(
      p => p.tournamentId === tid
    );
    expect(participants.length).toBeGreaterThanOrEqual(3);
  });
});
