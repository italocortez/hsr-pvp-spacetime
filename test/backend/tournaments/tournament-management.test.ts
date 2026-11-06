/**
 * Integration tests: Tournament update operations.
 *
 * Covers update_tournament in Draft/Registration stages and stage-gate rejection.
 * Create/advance/cancel are tested in tournament-stages.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createVerifiedTestHarness, hasServerToken, expectReducerError, type TestHarness } from '../../shared/connection';
import { cleanupTournament } from '../../shared/helpers/tournaments';

describe.skipIf(!hasServerToken())('Tournament Management', () => {
  let h: TestHarness;
  let tournamentId: number;
  const openedTournamentIds: number[] = [];

  const myTournaments = () => [...h.conn.db.Tournament.iter()].filter(t => t.organizerId === h.userId);

  beforeAll(async () => {
    h = await createVerifiedTestHarness();

    const user = [...h.conn.db.User.iter()].find(u => u.id === h.userId);
    if (!user) throw new Error(`User ${h.userId} not found in cache`);

    const { DbConnection } = await import('@/src/module_bindings');
    const serverToken = process.env.SPACETIMEDB_SERVER_TOKEN || '';
    const uri = process.env.SPACETIMEDB_URI || 'wss://maincloud.spacetimedb.com';
    const db = process.env.SPACETIMEDB_DB || 'hsrpvp-spacetimedb-nextjs-test1';

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Server promote timeout')), 10000);
      DbConnection.builder()
        .withUri(uri).withDatabaseName(db).withToken(serverToken)
        .withConfirmedReads(false)
        .onConnect(async (serverConn) => {
          try {
            await serverConn.reducers.serverSetRole({ username: user.username, roleTag: 'TournamentHost' });
            clearTimeout(timeout);
            serverConn.disconnect();
            setTimeout(resolve, 500);
          } catch (err) { clearTimeout(timeout); serverConn.disconnect(); reject(err); }
        })
        .onConnectError((_ctx: any, err: any) => { clearTimeout(timeout); reject(new Error(`Server connection failed: ${err}`)); })
        .onDisconnect(() => {}).build();
    });
    await h.sync(1000);

    // Create a tournament for update tests
    await h.call.createTournament({
      name: 'Mgmt Update Test',
      description: 'Testing update_tournament reducer',
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
    await h.sync();

    const mine = myTournaments();
    tournamentId = mine[mine.length - 1].id;
    openedTournamentIds.push(tournamentId);
  }, 30000);

  afterAll(async () => {
    // D-03: strict cleanup per resource opened
    for (const tid of openedTournamentIds) {
      await cleanupTournament(h, tid);
    }
    await h?.disconnect();
  });

  // ── Update in Draft stage ──

  it('updates fields in Draft stage', async () => {
    await h.call.updateTournament({
      tournamentId,
      name: 'Updated Name',
      description: 'Updated description',
      rosterVisibility: 'OpenRoster',
      isAnonymousDefault: false,
      disconnectPolicy: 'Deferred',
      costSetId: 0,
      defaultBestOf: 5,
      groupSize: 4,
      has3RdPlaceMatch: true,
      autoAdvanceBracket: true,
      winnerAdvantage: 1,
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
    await h.sync();

    const updated = myTournaments().find(t => t.id === tournamentId);
    expect(updated).toBeDefined();
    expect(updated!.name).toBe('Updated Name');
    expect(updated!.defaultBestOf).toBe(5);
    expect(updated!.has3RdPlaceMatch).toBe(true);
    expect(updated!.winnerAdvantage).toBe(1);
  });

  // ── Update in Registration stage ──

  it('updates fields in Registration stage', async () => {
    await h.call.advanceTournamentStage({ tournamentId, nextStage: 'Registration' });
    await h.sync();

    await h.call.updateTournament({
      tournamentId,
      name: 'Reg Update',
      description: 'Updated in registration',
      rosterVisibility: 'ClosedWithRating',
      isAnonymousDefault: true,
      disconnectPolicy: 'Standard',
      costSetId: 0,
      defaultBestOf: 3,
      groupSize: 4,
      has3RdPlaceMatch: false,
      autoAdvanceBracket: true,
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
    await h.sync();

    const t = myTournaments().find(t => t.id === tournamentId);
    expect(t!.name).toBe('Reg Update');
    expect(t!.rosterVisibility.tag).toBe('ClosedWithRating');
    expect(t!.isAnonymousDefault).toBe(true);
    expect(t!.disconnectPolicy.tag).toBe('Standard');
  });

  // ── Reject update on Cancelled tournament ──

  it('rejects update on cancelled tournament', async () => {
    // Create a second tournament and cancel it
    await h.call.createTournament({
      name: 'Cancel For Update Test',
      description: 'Will be cancelled',
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
    await h.sync();

    const cancelTarget = myTournaments().find(t => t.name === 'Cancel For Update Test');
    expect(cancelTarget).toBeDefined();
    openedTournamentIds.push(cancelTarget!.id);

    await h.call.cancelTournament({ tournamentId: cancelTarget!.id });
    await h.sync();

    const err = await expectReducerError(
      h.call.updateTournament({
        tournamentId: cancelTarget!.id,
        name: 'Should Fail',
        description: 'Should not work',
        rosterVisibility: 'OpenRoster',
        isAnonymousDefault: false,
        disconnectPolicy: 'Deferred',
        costSetId: 0,
        defaultBestOf: 3,
        groupSize: 4,
        has3RdPlaceMatch: false,
        autoAdvanceBracket: true,
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
      })
    );
    expect(err).toContain('Draft or Registration');
  });
});
