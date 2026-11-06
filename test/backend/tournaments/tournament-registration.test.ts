/**
 * Integration tests: Tournament registration, waitlist, approval, and withdrawal.
 *
 * Covers:
 * - Register verified user -> TournamentEnrolled row appears with isWaitlisted=false
 * - Reject duplicate registration
 * - Reject registration on Draft stage tournament
 * - Waitlist flow: maxParticipants=2, waitlistEnabled=true, requireApproval=true
 * - Approve participant -> approvedByToAt gets set
 * - Waitlist promote -> isWaitlisted=false, approvedByToAt set
 * - Withdraw -> participant status.tag changes to 'Withdrawn'
 * - Double-withdraw -> rejected
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createVerifiedTestHarness, hasServerToken, expectReducerError, type TestHarness } from '../../shared/connection';
import { promoteToRole } from '../../shared/helpers/promoteUser';
import { cleanupTournament } from '../../shared/helpers/tournaments';

describe.skipIf(!hasServerToken())('Tournament Registration', () => {
  let host: TestHarness;
  let player1: TestHarness;
  let player2: TestHarness;
  let player3: TestHarness;
  const openedTournamentIds: number[] = [];

  const hostTournaments = () => [...host.conn.db.Tournament.iter()].filter(t => t.organizerId === host.userId);

  /** Helper to promote a harness user to a role via server connection */
  beforeAll(async () => {
    host = await createVerifiedTestHarness();
    player1 = await createVerifiedTestHarness();
    player2 = await createVerifiedTestHarness();
    player3 = await createVerifiedTestHarness();

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
    await player3?.disconnect();
  });

  // ── Basic registration ──
  describe('basic registration', () => {
    let tid: number;

    it('creates a tournament and advances to Registration', async () => {
      await host.call.createTournament({
        name: 'Reg Test: Basic',
        description: 'Registration test',
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
      tid = mine[mine.length - 1].id;
      openedTournamentIds.push(tid);

      await host.call.advanceTournamentStage({ tournamentId: tid, nextStage: 'Registration' });
      await host.sync();

      const t = hostTournaments().find(t => t.id === tid);
      expect(t!.stage.tag).toBe('Registration');
    });

    it('registers verified user -> participant row with isWaitlisted=false', async () => {
      await player1.call.registerForTournament({ tournamentId: tid });
      await player1.sync();

      const participants = [...player1.conn.db.TournamentEnrolled.iter()].filter(
        p => p.tournamentId === tid && p.userId === player1.userId
      );
      expect(participants.length).toBe(1);
      expect(participants[0].isWaitlisted).toBe(false);
      expect(participants[0].status.tag).toBe('Registered');
    });

    it('rejects duplicate registration', async () => {
      const msg = await expectReducerError(
        player1.call.registerForTournament({ tournamentId: tid })
      );
      expect(msg.toLowerCase()).toMatch(/already|registered|duplicate/);
    });
  });

  // ── Reject registration on Draft stage ──
  it('rejects registration on Draft stage tournament', async () => {
    await host.call.createTournament({
      name: 'Reg Test: Draft Block',
      description: 'Should not allow registration in Draft',
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
    const draftTid = mine[mine.length - 1].id;
    openedTournamentIds.push(draftTid);
    expect(mine[mine.length - 1].stage.tag).toBe('Draft');

    const msg = await expectReducerError(
      player1.call.registerForTournament({ tournamentId: draftTid })
    );
    expect(msg.toLowerCase()).toMatch(/registration|draft|stage/);
  });

  // ── Waitlist + Approval flow ──
  describe('waitlist and approval', () => {
    let tid: number;

    it('creates tournament with maxParticipants=2, waitlist+approval enabled', async () => {
      await host.call.createTournament({
        name: 'Reg Test: Waitlist',
        description: 'Waitlist and approval test',
        format: 'SingleElimination',
        teamSize: 1,
        defaultGameMode: 'MemoryOfChaos',
        maxParticipants: 2,
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
        requireApproval: true,
        waitlistEnabled: true,
        scheduledStartAt: '',
        registrationDeadline: '',
        maxAccountsPerPlayer: 1,
      });
      await host.sync();

      const mine = hostTournaments();
      tid = mine[mine.length - 1].id;
      openedTournamentIds.push(tid);

      await host.call.advanceTournamentStage({ tournamentId: tid, nextStage: 'Registration' });
      await host.sync();
    });

    it('first 2 registrants get isWaitlisted=false, 3rd gets isWaitlisted=true', async () => {
      // Register player1
      await player1.call.registerForTournament({ tournamentId: tid });
      await player1.sync();

      // Register player2
      await player2.call.registerForTournament({ tournamentId: tid });
      await player2.sync();

      // Register player3 — should be waitlisted
      await player3.call.registerForTournament({ tournamentId: tid });
      await player3.sync();

      await host.sync();
      const allParticipants = [...host.conn.db.TournamentEnrolled.iter()].filter(
        p => p.tournamentId === tid
      );

      const p1 = allParticipants.find(p => p.userId === player1.userId);
      const p2 = allParticipants.find(p => p.userId === player2.userId);
      const p3 = allParticipants.find(p => p.userId === player3.userId);

      expect(p1).toBeDefined();
      expect(p2).toBeDefined();
      expect(p3).toBeDefined();
      expect(p1!.isWaitlisted).toBe(false);
      expect(p2!.isWaitlisted).toBe(false);
      expect(p3!.isWaitlisted).toBe(true);
    });

    it('approve participant -> approvedByToAt gets set', async () => {
      await host.call.approveParticipant({ tournamentId: tid, userId: player1.userId });
      await host.sync();

      const p = [...host.conn.db.TournamentEnrolled.iter()].find(
        p => p.tournamentId === tid && p.userId === player1.userId
      );
      expect(p).toBeDefined();
      expect(p!.approvedByToAt).toBeDefined();
      expect(p!.approvedByToAt).not.toBeNull();
    });

    it('waitlist promote -> isWaitlisted=false, approvedByToAt set', async () => {
      // First withdraw player2 to open a slot
      await player2.call.withdrawFromTournament({ tournamentId: tid });
      await player2.sync();
      await host.sync();

      // Now promote player3 from waitlist
      await host.call.waitlistPromote({ tournamentId: tid, userId: player3.userId });
      await host.sync();

      const p3 = [...host.conn.db.TournamentEnrolled.iter()].find(
        p => p.tournamentId === tid && p.userId === player3.userId
      );
      expect(p3).toBeDefined();
      expect(p3!.isWaitlisted).toBe(false);
      expect(p3!.approvedByToAt).toBeDefined();
      expect(p3!.approvedByToAt).not.toBeNull();
    });
  });

  // ── Withdraw flow ──
  describe('withdrawal', () => {
    let tid: number;

    it('creates tournament and registers a player', async () => {
      await host.call.createTournament({
        name: 'Reg Test: Withdraw',
        description: 'Withdrawal test',
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
      tid = mine[mine.length - 1].id;
      openedTournamentIds.push(tid);

      await host.call.advanceTournamentStage({ tournamentId: tid, nextStage: 'Registration' });
      await host.sync();

      await player1.call.registerForTournament({ tournamentId: tid });
      await player1.sync();
    });

    it('withdraw -> status.tag changes to Withdrawn', async () => {
      await player1.call.withdrawFromTournament({ tournamentId: tid });
      await player1.sync();

      const p = [...player1.conn.db.TournamentEnrolled.iter()].find(
        p => p.tournamentId === tid && p.userId === player1.userId
      );
      expect(p).toBeDefined();
      expect(p!.status.tag).toBe('Withdrawn');
    });

    it('double-withdraw -> rejected', async () => {
      const msg = await expectReducerError(
        player1.call.withdrawFromTournament({ tournamentId: tid })
      );
      expect(msg.toLowerCase()).toMatch(/already|withdrawn/);
    });
  });

  // ── Withdrawal cleanup: team requests and TournamentTeamMember ──
  describe('withdrawal cleanup', () => {
    let tid: number;

    it('creates team tournament, registers players, forms team', async () => {
      await host.call.createTournament({
        name: 'Reg Test: Withdrawal Cleanup',
        description: 'Tests request and TournamentTeamMember cleanup on withdrawal',
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
      tid = mine[mine.length - 1].id;
      openedTournamentIds.push(tid);

      await host.call.advanceTournamentStage({ tournamentId: tid, nextStage: 'Registration' });
      await host.sync();

      // Register host, player1, player2
      await host.call.registerForTournament({ tournamentId: tid });
      await host.sync();
      await player1.call.registerForTournament({ tournamentId: tid });
      await player1.sync();
      await player2.call.registerForTournament({ tournamentId: tid });
      await player2.sync();

      // Host creates a team
      await host.call.createTournamentTeam({ tournamentId: tid, teamName: 'Cleanup Team' });
      await host.sync();
    });

    it('withdrawal cleans up pending team requests', async () => {
      const team = [...host.conn.db.TournamentTeam.iter()].find(
        t => t.tournamentId === tid && t.captainUserId === host.userId
      );
      expect(team).toBeDefined();

      // Player2 requests to join
      await player2.call.requestJoinTeam({ teamId: team!.id });
      await player2.sync();
      await host.sync();

      // Verify request exists
      const reqBefore = [...host.conn.db.TournamentTeamRequest.iter()].find(
        r => r.teamId === team!.id && r.userId === player2.userId
      );
      expect(reqBefore).toBeDefined();

      // Player2 withdraws
      await player2.call.withdrawFromTournament({ tournamentId: tid });
      await player2.sync();
      await host.sync();

      // Request should be gone
      const reqAfter = [...host.conn.db.TournamentTeamRequest.iter()].find(
        r => r.teamId === team!.id && r.userId === player2.userId
      );
      expect(reqAfter).toBeUndefined();

      // Player2 status should be Withdrawn
      const p2 = [...host.conn.db.TournamentEnrolled.iter()].find(
        p => p.tournamentId === tid && p.userId === player2.userId
      );
      expect(p2!.status.tag).toBe('Withdrawn');
    });

    it('withdrawal removes TournamentTeamMember for team member', async () => {
      const team = [...host.conn.db.TournamentTeam.iter()].find(
        t => t.tournamentId === tid && t.captainUserId === host.userId
      );
      expect(team).toBeDefined();

      // Player1 joins the team
      await player1.call.requestJoinTeam({ teamId: team!.id });
      await player1.sync();
      await host.sync();
      await host.call.acceptTeamRequest({ teamId: team!.id, userId: player1.userId });
      await host.sync();
      await player1.sync();

      // Verify player1 is on the team via TournamentTeamMember
      const memberBefore = [...player1.conn.db.TournamentTeamMember.iter()].find(
        m => m.tournamentId === tid && m.userId === player1.userId
      );
      expect(memberBefore).toBeDefined();
      expect(memberBefore!.teamId).toBe(team!.id);

      // Player1 withdraws (non-captain)
      await player1.call.withdrawFromTournament({ tournamentId: tid });
      await player1.sync();

      // TournamentTeamMember row should be removed
      const memberAfter = [...player1.conn.db.TournamentTeamMember.iter()].find(
        m => m.tournamentId === tid && m.userId === player1.userId
      );
      expect(memberAfter).toBeUndefined();

      // Enrollment status should be Withdrawn
      const p1After = [...player1.conn.db.TournamentEnrolled.iter()].find(
        p => p.tournamentId === tid && p.userId === player1.userId
      );
      expect(p1After!.status.tag).toBe('Withdrawn');
    });
  });
});
