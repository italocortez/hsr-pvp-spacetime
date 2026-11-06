/**
 * Integration tests: TournamentPlayerAccount locking and cleanup.
 *
 * Covers:
 * - Registration creates TPA rows for ALL user HSR accounts (not just active)
 * - Withdrawal deletes all TPA rows for user+tournament
 * - TPA rows are tournament-scoped (tournament B doesn't affect tournament A)
 * - User without HSR accounts can still register (0 TPA rows, no error)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  createVerifiedTestHarness,
  hasServerToken,
  expectReducerError,
  queryPrivateTable,
  type TestHarness,
} from '../../shared/connection';
import { promoteToRole } from '../../shared/helpers/promoteUser';

describe.skipIf(!hasServerToken())('TournamentPlayerAccount', () => {
  let host: TestHarness;
  let playerWithAccounts: TestHarness;
  let playerWithoutAccounts: TestHarness;
  let tournamentId: number;

  const tpaForUser = (h: TestHarness, tId: number, userId: number) =>
    [...h.conn.db.TournamentPlayerAccount.iter()]
      .filter(t => t.tournamentId === tId && t.userId === userId);

  const userAccounts = async (_h: TestHarness, userId: number) => {
    const rows = await queryPrivateTable(`SELECT * FROM hsr_account WHERE user_id = ${userId}`);
    return rows.map(r => ({
      id: Number(r.id),
      userId: Number(r.user_id),
      uid: r.uid.replace(/"/g, ''),
      hsrAccountId: Number(r.id),
    }));
  };

  beforeAll(async () => {
    host = await createVerifiedTestHarness();
    playerWithAccounts = await createVerifiedTestHarness();
    playerWithoutAccounts = await createVerifiedTestHarness();

    await promoteToRole(host, 'TournamentHost');

    // Player creates 2 HSR accounts
    await playerWithAccounts.call.createHsrAccount({ uid: '700100100', displayLabel: 'Main' });
    await playerWithAccounts.sync(1000);
    await playerWithAccounts.call.createHsrAccount({ uid: '700100101', displayLabel: 'Alt' });
    await playerWithAccounts.sync(1000);

    // Host creates tournament and opens registration
    await host.call.createTournament({
      name: 'TPA Integration Test',
      description: 'Test TournamentPlayerAccount wiring',
      format: 'SingleElimination',
      teamSize: 1,
      defaultGameMode: 'MemoryOfChaos',
      maxParticipants: 16,
      rosterVisibility: 'OpenRoster',
      isAnonymousDefault: false,
      disconnectPolicy: 'NoAction',
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
    await host.sync(1000);

    const tournaments = [...host.conn.db.Tournament.iter()].filter(t => t.organizerId === host.userId);
    tournamentId = tournaments[tournaments.length - 1].id;

    // Advance to Registration
    await host.call.advanceTournamentStage({ tournamentId, nextStage: 'Registration' });
    await host.sync(1000);
  }, 60000);

  afterAll(async () => {
    await host?.disconnect();
    await playerWithAccounts?.disconnect();
    await playerWithoutAccounts?.disconnect();
  });

  // ─── Test 1: Registration locks ALL HSR accounts ──────────────────────────

  it('registration creates TPA rows for ALL user HSR accounts', async () => {
    const accounts = await userAccounts(playerWithAccounts, playerWithAccounts.userId);
    expect(accounts.length).toBe(2);

    await playerWithAccounts.call.registerForTournament({ tournamentId });
    await playerWithAccounts.sync(2000);

    const tpaRows = tpaForUser(playerWithAccounts, tournamentId, playerWithAccounts.userId);
    expect(tpaRows.length).toBe(accounts.length);

    // Verify each account has a TPA row
    const tpaAccountIds = new Set(tpaRows.map(t => t.hsrAccountId));
    for (const acct of accounts) {
      expect(tpaAccountIds.has(acct.id)).toBe(true);
    }
  });

  // ─── Test 2: Withdrawal cleans up TPA rows ────────────────────────────────

  it('withdrawal deletes all TPA rows for user+tournament', async () => {
    // Verify TPA rows exist from test 1
    expect(tpaForUser(playerWithAccounts, tournamentId, playerWithAccounts.userId).length).toBeGreaterThan(0);

    await playerWithAccounts.call.withdrawFromTournament({ tournamentId });
    await playerWithAccounts.sync(2000);

    const tpaAfter = tpaForUser(playerWithAccounts, tournamentId, playerWithAccounts.userId);
    expect(tpaAfter.length).toBe(0);
  });

  // ─── Test 3: TPA rows are tournament-scoped ───────────────────────────────

  it('TPA rows are scoped to tournament — second tournament does not affect first', async () => {
    // Player is already withdrawn from test 2 (status=Withdrawn, TPA cleaned up).
    // Use a fresh player for this test to avoid "already registered" conflict.
    const scopePlayer = await createVerifiedTestHarness();
    await scopePlayer.call.createHsrAccount({ uid: '700200200', displayLabel: 'ScopeMain' });
    await scopePlayer.sync(1000);
    await scopePlayer.call.createHsrAccount({ uid: '700200201', displayLabel: 'ScopeAlt' });
    await scopePlayer.sync(1000);

    // Register in first tournament
    await scopePlayer.call.registerForTournament({ tournamentId });
    await scopePlayer.sync(2000);

    const tpaInFirst = tpaForUser(scopePlayer, tournamentId, scopePlayer.userId);
    expect(tpaInFirst.length).toBe(2);

    // Create a second tournament
    await host.call.createTournament({
      name: 'TPA Scope Test',
      description: 'Second tournament for scope test',
      format: 'SingleElimination',
      teamSize: 1,
      defaultGameMode: 'MemoryOfChaos',
      maxParticipants: 16,
      rosterVisibility: 'OpenRoster',
      isAnonymousDefault: false,
      disconnectPolicy: 'NoAction',
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
    await host.sync(1000);

    const tournaments = [...host.conn.db.Tournament.iter()].filter(t => t.organizerId === host.userId);
    const secondTournamentId = tournaments[tournaments.length - 1].id;

    await host.call.advanceTournamentStage({ tournamentId: secondTournamentId, nextStage: 'Registration' });
    await host.sync(1000);

    // Register in second tournament
    await scopePlayer.call.registerForTournament({ tournamentId: secondTournamentId });
    await scopePlayer.sync(2000);

    // Verify first tournament TPA unchanged
    const tpaInFirstAfter = tpaForUser(scopePlayer, tournamentId, scopePlayer.userId);
    expect(tpaInFirstAfter.length).toBe(2);

    // Verify second tournament has its own TPA rows
    const tpaInSecond = tpaForUser(scopePlayer, secondTournamentId, scopePlayer.userId);
    expect(tpaInSecond.length).toBe(2);

    // Withdraw from second — first unaffected
    await scopePlayer.call.withdrawFromTournament({ tournamentId: secondTournamentId });
    await scopePlayer.sync(2000);

    expect(tpaForUser(scopePlayer, tournamentId, scopePlayer.userId).length).toBe(2);
    expect(tpaForUser(scopePlayer, secondTournamentId, scopePlayer.userId).length).toBe(0);

    await scopePlayer.disconnect();
  });

  // ─── Test 4: User without HSR accounts can still register ─────────────────

  it('user without HSR accounts registers with 0 TPA rows', async () => {
    const accounts = await userAccounts(playerWithoutAccounts, playerWithoutAccounts.userId);
    expect(accounts.length).toBe(0);

    await playerWithoutAccounts.call.registerForTournament({ tournamentId });
    await playerWithoutAccounts.sync(2000);

    // Should have registered (TournamentEnrolled exists) but no TPA rows
    const tpa = tpaForUser(playerWithoutAccounts, tournamentId, playerWithoutAccounts.userId);
    expect(tpa.length).toBe(0);

    // Verify the enrollment was actually created
    const enrolled = [...playerWithoutAccounts.conn.db.TournamentEnrolled.iter()]
      .filter(p => p.tournamentId === tournamentId && p.userId === playerWithoutAccounts.userId);
    expect(enrolled.length).toBe(1);
  });
});
