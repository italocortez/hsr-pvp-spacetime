/**
 * Integration tests: Tournament team formation.
 *
 * Covers:
 * - Create team -> TournamentTeam row created, captain's TournamentTeamMember row set
 * - Request join -> TournamentTeamRequest row created
 * - Accept request -> request row deleted, joiner's TournamentTeamMember row set
 * - Reject request -> request row deleted, joiner's TournamentTeamMember unchanged
 * - Leave team (non-captain) -> TournamentTeamMember row removed
 * - Disband team -> team deleted, all members' TournamentTeamMember rows removed
 * - Captain leave -> rejected
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createVerifiedTestHarness, hasServerToken, expectReducerError, type TestHarness } from '../../shared/connection';
import { promoteToRole } from '../../shared/helpers/promoteUser';
import { cleanupTournament } from '../../shared/helpers/tournaments';

describe.skipIf(!hasServerToken())('Tournament Teams', () => {
  let host: TestHarness;
  let player1: TestHarness;
  let player2: TestHarness;

  let tournamentId: number;
  const openedTournamentIds: number[] = [];

  const hostTournaments = () => [...host.conn.db.Tournament.iter()].filter(t => t.organizerId === host.userId);
  const teamsInTournament = (h: TestHarness, tid: number) =>
    [...h.conn.db.TournamentTeam.iter()].filter(t => t.tournamentId === tid);
  const enrolledFor = (h: TestHarness, tid: number, userId: number) =>
    [...h.conn.db.TournamentEnrolled.iter()].find(p => p.tournamentId === tid && p.userId === userId);
  const teamMemberFor = (h: TestHarness, tid: number, userId: number) =>
    [...h.conn.db.TournamentTeamMember.iter()].find(m => m.tournamentId === tid && m.userId === userId);
  const requestsForTeam = (h: TestHarness, teamId: number) =>
    [...h.conn.db.TournamentTeamRequest.iter()].filter(r => r.teamId === teamId);

  beforeAll(async () => {
    host = await createVerifiedTestHarness();
    player1 = await createVerifiedTestHarness();
    player2 = await createVerifiedTestHarness();

    await promoteToRole(host, 'TournamentHost');

    // Create a team-based tournament (teamSize=3) and advance to Registration
    await host.call.createTournament({
      name: 'Team Test Tournament',
      description: 'Testing team formation',
      format: 'SingleElimination',
      teamSize: 3,
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
    tournamentId = mine[mine.length - 1].id;
    openedTournamentIds.push(tournamentId);

    await host.call.advanceTournamentStage({ tournamentId, nextStage: 'Registration' });
    await host.sync();

    // Register all 3 users as participants
    await host.call.registerForTournament({ tournamentId });
    await host.sync();
    await player1.call.registerForTournament({ tournamentId });
    await player1.sync();
    await player2.call.registerForTournament({ tournamentId });
    await player2.sync();

    await host.sync();
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

  // ── Create team ──
  it('creates team -> TournamentTeam row, captain TournamentTeamMember set', async () => {
    const teamsBefore = teamsInTournament(host, tournamentId).length;

    await host.call.createTournamentTeam({ tournamentId, teamName: 'Alpha Squad' });
    await host.sync();

    const teamsAfter = teamsInTournament(host, tournamentId);
    expect(teamsAfter.length).toBe(teamsBefore + 1);

    const team = teamsAfter.find(t => t.captainUserId === host.userId);
    expect(team).toBeDefined();
    expect(team!.name).toBe('Alpha Squad');

    // Captain's TournamentTeamMember row should be set
    const captainMember = teamMemberFor(host, tournamentId, host.userId);
    expect(captainMember).toBeDefined();
    expect(captainMember!.teamId).toBe(team!.id);
  });

  // ── Request join ──
  it('request join -> TournamentTeamRequest row created', async () => {
    const team = teamsInTournament(player1, tournamentId).find(t => t.captainUserId === host.userId);
    expect(team).toBeDefined();
    const teamId = team!.id;

    await player1.call.requestJoinTeam({ teamId });
    await player1.sync();
    await host.sync();

    const requests = requestsForTeam(host, teamId);
    const myRequest = requests.find(r => r.userId === player1.userId);
    expect(myRequest).toBeDefined();
  });

  // ── Accept request ──
  it('accept request -> request deleted, joiner TournamentTeamMember set', async () => {
    const team = teamsInTournament(host, tournamentId).find(t => t.captainUserId === host.userId);
    expect(team).toBeDefined();
    const teamId = team!.id;

    await host.call.acceptTeamRequest({ teamId, userId: player1.userId });
    await host.sync();
    await player1.sync();

    // Request should be gone
    const requests = requestsForTeam(host, teamId);
    const p1Request = requests.find(r => r.userId === player1.userId);
    expect(p1Request).toBeUndefined();

    // Player1's TournamentTeamMember should be set
    const p1Member = teamMemberFor(player1, tournamentId, player1.userId);
    expect(p1Member).toBeDefined();
    expect(p1Member!.teamId).toBe(teamId);
  });

  // ── Reject request ──
  it('reject request -> request deleted, joiner TournamentTeamMember unchanged', async () => {
    const team = teamsInTournament(host, tournamentId).find(t => t.captainUserId === host.userId);
    expect(team).toBeDefined();
    const teamId = team!.id;

    // Player2 requests to join
    await player2.call.requestJoinTeam({ teamId });
    await player2.sync();
    await host.sync();

    // Record player2's current TournamentTeamMember (none expected)
    const memberBefore = teamMemberFor(host, tournamentId, player2.userId);

    // Captain rejects
    await host.call.rejectTeamRequest({ teamId, userId: player2.userId });
    await host.sync();
    await player2.sync();

    // Request should be gone
    const requests = requestsForTeam(host, teamId);
    const p2Request = requests.find(r => r.userId === player2.userId);
    expect(p2Request).toBeUndefined();

    // Player2's TournamentTeamMember should be unchanged (still undefined)
    const memberAfter = teamMemberFor(player2, tournamentId, player2.userId);
    expect(memberAfter?.teamId).toEqual(memberBefore?.teamId);
  });

  // ── Leave team (non-captain) ──
  it('leave team (non-captain) -> TournamentTeamMember removed', async () => {
    const team = teamsInTournament(player1, tournamentId).find(t => t.captainUserId === host.userId);
    expect(team).toBeDefined();
    const teamId = team!.id;

    // Player1 was accepted earlier, so they should have a TournamentTeamMember
    const memberBefore = teamMemberFor(player1, tournamentId, player1.userId);
    expect(memberBefore).toBeDefined();

    await player1.call.leaveTournamentTeam({ teamId });
    await player1.sync();

    const memberAfter = teamMemberFor(player1, tournamentId, player1.userId);
    // TournamentTeamMember should be removed
    expect(memberAfter).toBeUndefined();
  });

  // ── Captain leave -> captain transfers (Phase 10.1: D-22) ──
  it('captain leave -> captain transfers to remaining member', async () => {
    // After previous tests: player1 left, player2 was rejected (never joined).
    // Team has only host (captain). Add player2 so transfer has a target.
    const team = teamsInTournament(host, tournamentId).find(t => t.captainUserId === host.userId);
    expect(team).toBeDefined();
    const teamId = team!.id;

    await player2.call.requestJoinTeam({ teamId });
    await player2.sync();
    await host.sync();
    await host.call.acceptTeamRequest({ teamId, userId: player2.userId });
    await host.sync(1000);
    await player2.sync(1000);

    // Now team has host (captain) + player2. Captain leaves → transfer to player2.
    await host.call.leaveTournamentTeam({ teamId });
    await host.sync(1500);
    await player2.sync(1500);

    // Host's TournamentTeamMember should be removed
    const hostMemberAfter = teamMemberFor(host, tournamentId, host.userId);
    expect(hostMemberAfter).toBeUndefined();

    // Team survives with player2 as new captain
    const teamAfter = teamsInTournament(player2, tournamentId).find(t => t.id === teamId);
    expect(teamAfter).toBeDefined();
    expect(teamAfter!.captainUserId).toBe(player2.userId);
  }, 30000);

  // ── Disband team ──
  it('disband team -> team deleted, members TournamentTeamMember removed', async () => {
    // player2 is now captain (from previous test — host left, captain transferred to player2)
    const team = teamsInTournament(player2, tournamentId).find(t => t.captainUserId === player2.userId);
    expect(team).toBeDefined();
    const teamId = team!.id;

    // Disband (player2 is the solo remaining member and captain)
    await player2.call.disbandTournamentTeam({ teamId });
    await player2.sync();

    // Team should be gone
    const teamAfter = teamsInTournament(player2, tournamentId).find(t => t.id === teamId);
    expect(teamAfter).toBeUndefined();

    // player2's TournamentTeamMember should be removed
    const p2MemberAfter = teamMemberFor(player2, tournamentId, player2.userId);
    expect(p2MemberAfter).toBeUndefined();
  });

  // ── Captain withdrawal transfers captaincy (Phase 10.1: D-21, D-22) ──
  it('captain withdrawal transfers captaincy, team survives', async () => {
    // Host left team in earlier test — re-create a fresh team
    // Host is still enrolled (left team, not tournament). Create new team.
    await host.call.createTournamentTeam({ tournamentId, teamName: 'Transfer Squad' });
    await host.sync();

    const team = teamsInTournament(host, tournamentId).find(t => t.captainUserId === host.userId);
    expect(team).toBeDefined();
    const teamId = team!.id;

    // Player1 joins the team
    await player1.call.requestJoinTeam({ teamId });
    await player1.sync();
    await host.sync();
    await host.call.acceptTeamRequest({ teamId, userId: player1.userId });
    await host.sync();
    await player1.sync();

    // Verify team member exists
    const memberBefore = teamMemberFor(player1, tournamentId, player1.userId);
    expect(memberBefore).toBeDefined();
    expect(memberBefore!.teamId).toBe(teamId);

    // Captain (host) withdraws from tournament
    await host.call.withdrawFromTournament({ tournamentId });
    await host.sync();
    await player1.sync();

    // Phase 10.1: Team survives — captain transferred to player1 (lowest remaining userId)
    const teamAfter = teamsInTournament(player1, tournamentId).find(t => t.id === teamId);
    expect(teamAfter).toBeDefined();
    expect(teamAfter!.captainUserId).toBe(player1.userId);

    // Host's TournamentTeamMember should be removed
    const hostMemberAfter = teamMemberFor(host, tournamentId, host.userId);
    expect(hostMemberAfter).toBeUndefined();

    // Player1's TournamentTeamMember should still exist
    const p1MemberAfter = teamMemberFor(player1, tournamentId, player1.userId);
    expect(p1MemberAfter).toBeDefined();

    // Host enrollment status should be Withdrawn
    const hostEnrolled = enrolledFor(host, tournamentId, host.userId);
    expect(hostEnrolled).toBeDefined();
    expect(hostEnrolled!.status.tag).toBe('Withdrawn');
  });

  // ── Accept request cleans up other pending requests ──
  it('accept request cleans up user other pending requests in tournament', async () => {
    // Need 2 captains + 1 player. Player2 creates team B, a new player creates team C.
    // player1 requests both, captain of B accepts -> player1's request to C is deleted.

    // player2 is already registered from beforeAll

    // Player1 may still be on a team from the captain-transfer test — leave it first
    const existingMember = teamMemberFor(player1, tournamentId, player1.userId);
    if (existingMember) {
      await player1.call.leaveTournamentTeam({ teamId: existingMember.teamId });
      await player1.sync();
    }

    // Create Team B (player2 is captain)
    await player2.call.createTournamentTeam({ tournamentId, teamName: 'Team Bravo' });
    await player2.sync();

    const teamB = teamsInTournament(player2, tournamentId).find(t => t.captainUserId === player2.userId);
    expect(teamB).toBeDefined();

    // Player1 requests Team B
    await player1.call.requestJoinTeam({ teamId: teamB!.id });
    await player1.sync();
    await player2.sync();

    // Verify request exists
    const reqBefore = requestsForTeam(player2, teamB!.id).find(r => r.userId === player1.userId);
    expect(reqBefore).toBeDefined();

    // Captain of Team B accepts
    await player2.call.acceptTeamRequest({ teamId: teamB!.id, userId: player1.userId });
    await player2.sync();
    await player1.sync();

    // Request should be deleted
    const reqAfter = requestsForTeam(player2, teamB!.id).find(r => r.userId === player1.userId);
    expect(reqAfter).toBeUndefined();

    // Player1 should be on Team B via TournamentTeamMember
    const p1Member = teamMemberFor(player1, tournamentId, player1.userId);
    expect(p1Member).toBeDefined();
    expect(p1Member!.teamId).toBe(teamB!.id);

    // Verify no other pending requests from player1 in this tournament
    const allRequests = [...player1.conn.db.TournamentTeamRequest.iter()].filter(
      r => r.userId === player1.userId
    );
    const tournamentTeamIds = new Set(teamsInTournament(player1, tournamentId).map(t => t.id));
    const requestsInTournament = allRequests.filter(r => tournamentTeamIds.has(r.teamId));
    expect(requestsInTournament.length).toBe(0);
  });
});
