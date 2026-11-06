/**
 * Integration tests: Tournament admin operations.
 *
 * Covers:
 * - DQ participant -> status.tag changes to 'Disqualified'
 * - DQ already-DQ -> rejected
 * - DQ withdrawn -> rejected
 * - Assign assistant -> TournamentAssistant row created
 * - Self-assign -> rejected
 * - Remove assistant -> row deleted
 * - Mod promote User -> TournamentHost -> role.tag changes
 * - Mod demote TournamentHost -> User -> role.tag changes
 * - Promote already-TournamentHost -> rejected
 * - Non-mod promote -> rejected
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createVerifiedTestHarness, hasServerToken, expectReducerError, type TestHarness } from '../../shared/connection';
import { promoteToRole } from '../../shared/helpers/promoteUser';
import { cleanupTournament } from '../../shared/helpers/tournaments';

describe.skipIf(!hasServerToken())('Tournament Admin', () => {
  let admin: TestHarness;
  let target: TestHarness;
  let player1: TestHarness;
  let player2: TestHarness;
  let nonMod: TestHarness;

  let tournamentId: number;
  const openedTournamentIds: number[] = [];

  const adminTournaments = () => [...admin.conn.db.Tournament.iter()].filter(t => t.organizerId === admin.userId);

  /** Helper to promote a harness user to a role via server connection */
  beforeAll(async () => {
    admin = await createVerifiedTestHarness();
    target = await createVerifiedTestHarness();
    player1 = await createVerifiedTestHarness();
    player2 = await createVerifiedTestHarness();
    nonMod = await createVerifiedTestHarness();

    // Promote admin to Admin role (can do everything)
    await promoteToRole(admin, 'Admin');

    // Create a tournament for DQ and assistant tests
    await admin.call.createTournament({
      name: 'Admin Test Tournament',
      description: 'Testing admin operations',
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
    await admin.sync();

    const mine = adminTournaments();
    tournamentId = mine[mine.length - 1].id;
    openedTournamentIds.push(tournamentId);

    // Advance to Registration
    await admin.call.advanceTournamentStage({ tournamentId, nextStage: 'Registration' });
    await admin.sync();

    // Register player1 and player2
    await player1.call.registerForTournament({ tournamentId });
    await player1.sync();
    await player2.call.registerForTournament({ tournamentId });
    await player2.sync();

    await admin.sync();
  }, 30000);

  afterAll(async () => {
    // D-03: strict cleanup per resource opened
    for (const tid of openedTournamentIds) {
      await cleanupTournament(admin, tid);
    }
    await admin?.disconnect();
    await target?.disconnect();
    await player1?.disconnect();
    await player2?.disconnect();
    await nonMod?.disconnect();
  });

  // ── DQ participant ──
  describe('disqualification', () => {
    it('DQ participant -> status.tag changes to Disqualified', async () => {
      await admin.call.dqParticipant({
        tournamentId,
        userId: player1.userId,
        reason: 'Cheating in test',
      });
      await admin.sync();

      const p = [...admin.conn.db.TournamentEnrolled.iter()].find(
        p => p.tournamentId === tournamentId && p.userId === player1.userId
      );
      expect(p).toBeDefined();
      expect(p!.status.tag).toBe('Disqualified');
    });

    it('DQ already-DQ -> rejected', async () => {
      const msg = await expectReducerError(
        admin.call.dqParticipant({
          tournamentId,
          userId: player1.userId,
          reason: 'Double DQ',
        })
      );
      expect(msg.toLowerCase()).toMatch(/already|disqualified/);
    });

    it('DQ withdrawn player -> rejected', async () => {
      // First withdraw player2
      await player2.call.withdrawFromTournament({ tournamentId });
      await player2.sync();
      await admin.sync();

      const msg = await expectReducerError(
        admin.call.dqParticipant({
          tournamentId,
          userId: player2.userId,
          reason: 'DQ withdrawn',
        })
      );
      expect(msg.toLowerCase()).toMatch(/already|withdrawn/);
    });
  });

  // ── Assign assistant ──
  describe('tournament assistants', () => {
    it('assign assistant -> TournamentAssistant row created', async () => {
      await admin.call.assignTournamentAssistant({
        tournamentId,
        userId: target.userId,
        canValidateResults: true,
        canOverrideResults: false,
        canDqParticipants: true,
        canManageBracket: false,
        canAssignSeeds: false,
      });
      await admin.sync();

      const assistants = [...admin.conn.db.TournamentAssistant.iter()].filter(
        a => a.tournamentId === tournamentId
      );
      const assigned = assistants.find(a => a.userId === target.userId);
      expect(assigned).toBeDefined();
      expect(assigned!.canValidateResults).toBe(true);
      expect(assigned!.canDqParticipants).toBe(true);
      expect(assigned!.canOverrideResults).toBe(false);
    });

    it('self-assign as assistant -> rejected', async () => {
      const msg = await expectReducerError(
        admin.call.assignTournamentAssistant({
          tournamentId,
          userId: admin.userId,
          canValidateResults: true,
          canOverrideResults: false,
          canDqParticipants: false,
          canManageBracket: false,
          canAssignSeeds: false,
        })
      );
      expect(msg.toLowerCase()).toMatch(/yourself|self|organizer/);
    });

    it('remove assistant -> row deleted', async () => {
      await admin.call.removeTournamentAssistant({
        tournamentId,
        userId: target.userId,
      });
      await admin.sync();

      const assistants = [...admin.conn.db.TournamentAssistant.iter()].filter(
        a => a.tournamentId === tournamentId
      );
      const removed = assistants.find(a => a.userId === target.userId);
      expect(removed).toBeUndefined();
    });
  });

  // ── Mod promote/demote ──
  describe('moderator role management', () => {
    it('mod promotes User -> TournamentHost', async () => {
      // Promote admin to Moderator (they are Admin, which is higher)
      // The admin harness already has Admin role, which should allow mod_promote_to_host

      // Verify target starts as User
      await admin.sync();
      const userBefore = [...admin.conn.db.User.iter()].find(u => u.id === target.userId);
      expect(userBefore).toBeDefined();
      expect(userBefore!.role.tag).toBe('User');

      await admin.call.modPromoteToHost({ userId: target.userId });
      await admin.sync();

      const userAfter = [...admin.conn.db.User.iter()].find(u => u.id === target.userId);
      expect(userAfter).toBeDefined();
      expect(userAfter!.role.tag).toBe('TournamentHost');
    });

    it('mod demotes TournamentHost -> User', async () => {
      await admin.call.modDemoteFromHost({ userId: target.userId });
      await admin.sync();

      const userAfter = [...admin.conn.db.User.iter()].find(u => u.id === target.userId);
      expect(userAfter).toBeDefined();
      expect(userAfter!.role.tag).toBe('User');
    });

    it('promote already-TournamentHost -> rejected', async () => {
      // Promote target first
      await admin.call.modPromoteToHost({ userId: target.userId });
      await admin.sync();

      const msg = await expectReducerError(
        admin.call.modPromoteToHost({ userId: target.userId })
      );
      expect(msg.toLowerCase()).toMatch(/already|host/);
    });

    it('non-mod promote -> rejected', async () => {
      // nonMod is a regular User — should not be able to promote
      const msg = await expectReducerError(
        nonMod.call.modPromoteToHost({ userId: target.userId })
      );
      expect(msg.toLowerCase()).toMatch(/moderator|admin|permission|role/);
    });
  });
});
