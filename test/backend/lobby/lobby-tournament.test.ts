/**
 * Integration tests for tournament lobby and stand-in reducers.
 *
 * Covers:
 * - create_tournament_lobby: settings inheritance, duplicate bracketMatchId, auth guard, participant creates
 * - approve_stand_in: TournamentStandIn row created, duplicate rejected, auth guard, target not found
 * - tournament settings lock: locked fields retain tournament values, free fields update
 *
 * Requires: SPACETIMEDB_SERVER_TOKEN in .env.local (post-publish bootstrap)
 * Setup: full tournament infrastructure (tournament → registration → seeding → InProgress → bracket)
 *
 * Contract: docs/lobby/contract.md — Tournament Lobby scenarios
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
    createVerifiedTestHarness,
    expectReducerError,
    type TestHarness,
} from '../../shared/connection';
import { promoteUser } from '../../shared/helpers/promoteUser';
import { defaultSettingsArgs } from '../../shared/helpers/lobbies';
import { myLobbies, lobbyMembers } from '../../shared/helpers/queries';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Find a lobby by bracketMatchId in the subscription cache */
function findLobbyByBracketMatch(h: TestHarness, bracketMatchId: number) {
    return [...h.conn.db.Lobby.iter()].find(l => {
        const bm = l.bracketMatchId;
        // bracketMatchId is an Option<u32> — may be a tagged union or raw value
        if (bm === null || bm === undefined) return false;
        if (typeof bm === 'object' && 'tag' in bm) return false; // None
        if (typeof bm === 'object' && 'value' in (bm as any)) return (bm as any).value === bracketMatchId;
        return bm === bracketMatchId;
    });
}

/** Safely read an Option<u32> value */
function optionValue(opt: unknown): number | null {
    if (opt === null || opt === undefined) return null;
    if (typeof opt === 'number') return opt;
    if (typeof opt === 'object') {
        if ('value' in (opt as any)) return (opt as any).value ?? null;
        if ('tag' in (opt as any) && (opt as any).tag === 'None') return null;
    }
    return null;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Tournament Lobby & Stand-In', () => {
    let toUser: TestHarness;
    let player1: TestHarness;
    let player2: TestHarness;
    let bystander: TestHarness;
    let standIn: TestHarness;

    let tournamentId: number;
    let bracketMatchId: number;

    // ─── Full tournament infrastructure setup ────────────────────────────

    beforeAll(async () => {
        toUser = await createVerifiedTestHarness();
        player1 = await createVerifiedTestHarness();
        player2 = await createVerifiedTestHarness();
        bystander = await createVerifiedTestHarness();
        standIn = await createVerifiedTestHarness();

        await toUser.sync();
        await player1.sync();
        await player2.sync();
        await bystander.sync();
        await standIn.sync();

        // Promote toUser to TournamentHost
        const toUserRecord = [...toUser.conn.db.User.iter()].find(u => u.id === toUser.userId);
        expect(toUserRecord).toBeDefined();
        await promoteUser(toUserRecord!.username, 'TournamentHost');
        await toUser.sync(1500);

        // Create tournament (countTowardsMmr=true → Ranked matchType)
        await toUser.call.createTournament({
            name: 'Tournament Lobby Test',
            description: 'Setup for tournament lobby integration tests',
            format: 'SingleElimination',
            teamSize: 1,
            defaultGameMode: 'MemoryOfChaos',
            maxParticipants: 8,
            rosterVisibility: 'OpenRoster',
            isAnonymousDefault: false,
            disconnectPolicy: 'Deferred',
            costSetId: 0,
            defaultBestOf: 1,
            groupSize: 4,
            has3RdPlaceMatch: false,
            autoAdvanceBracket: false,
            countTowardsMmr: true,
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
        await toUser.sync(1500);

        const tournaments = [...toUser.conn.db.Tournament.iter()].filter(
            t => t.organizerId === toUser.userId
        );
        expect(tournaments.length).toBeGreaterThanOrEqual(1);
        const tournament = tournaments[tournaments.length - 1];
        tournamentId = tournament.id;

        // Draft → Registration
        await toUser.call.advanceTournamentStage({ tournamentId, nextStage: 'Registration' });
        await toUser.sync(1500);

        // Register player1 and player2
        await player1.call.registerForTournament({ tournamentId });
        await player1.sync(1500);
        await player2.call.registerForTournament({ tournamentId });
        await player2.sync(1500);
        await toUser.sync(1500);

        // Registration → Seeding
        await toUser.call.advanceTournamentStage({ tournamentId, nextStage: 'Seeding' });
        await toUser.sync(1500);

        // Seed bracket
        await toUser.call.seedBracket({ tournamentId, mode: 'random' });
        await toUser.sync(1500);

        // Generate bracket — creates BracketMatch rows (must be before InProgress)
        await toUser.call.generateBracket({ tournamentId });
        await toUser.sync(1500);

        // Seeding → InProgress
        await toUser.call.advanceTournamentStage({ tournamentId, nextStage: 'InProgress' });
        await toUser.sync(1500);

        // Grab first bracket match
        const bracketMatches = [...toUser.conn.db.BracketMatch.iter()].filter(
            bm => bm.tournamentId === tournamentId
        );
        expect(bracketMatches.length).toBeGreaterThan(0);
        bracketMatchId = bracketMatches[0].id;
    }, 60000);

    afterAll(async () => {
        await toUser?.disconnect();
        await player1?.disconnect();
        await player2?.disconnect();
        await bystander?.disconnect();
        await standIn?.disconnect();
    });

    // ─── create_tournament_lobby ─────────────────────────────────────────

    describe('create_tournament_lobby', () => {
        it('TO creates tournament lobby with settings inheritance', async () => {
            await toUser.call.createTournamentLobby({ bracketMatchId, joinCode: '' });
            await toUser.sync(1500);

            const lobby = findLobbyByBracketMatch(toUser, bracketMatchId);
            expect(lobby).toBeDefined();
            expect(lobby!.isTournamentControlled).toBe(true);
            expect(optionValue(lobby!.tournamentId)).toBe(tournamentId);
            expect(lobby!.stage.tag).toBe('Waiting');
            expect(lobby!.isPublic).toBe(true);
            // countTowardsMmr=true → matchType should be Ranked
            expect(lobby!.matchType.tag).toBe('Ranked');

            // Host's LobbyMember should have isReferee=true
            const hostMember = lobbyMembers(toUser, lobby!.id).find(
                m => m.userId === toUser.userId
            );
            expect(hostMember).toBeDefined();
            expect(hostMember!.isReferee).toBe(true);
        });

        it('duplicate bracketMatchId rejected (non-Finished lobby exists)', async () => {
            // Lobby from previous test is still in Waiting stage
            const err = await expectReducerError(
                toUser.call.createTournamentLobby({ bracketMatchId, joinCode: '' })
            );
            expect(err).toContain('A lobby already exists for this bracket match.');
        });

        it('Finished lobby allows recreation — deferred', () => {
            // Requires full match lifecycle to reach Finished stage.
            // Covered by match finalization tests.
        });

        it('unauthorized user blocked', async () => {
            // Close the existing lobby first so the test is clean
            const existingLobby = findLobbyByBracketMatch(toUser, bracketMatchId);
            if (existingLobby) {
                await toUser.call.closeLobby({ lobbyId: existingLobby.id });
                await toUser.sync(1500);
            }

            const err = await expectReducerError(
                bystander.call.createTournamentLobby({ bracketMatchId, joinCode: '' })
            );
            expect(err).toContain('You are not authorized to create a lobby for this bracket match.');
        });

        it('match participant creates lobby (D-64)', async () => {
            // Lobby was closed in the previous test. player1 is a registered participant.
            await player1.call.createTournamentLobby({ bracketMatchId, joinCode: '' });
            await player1.sync(1500);

            const lobby = findLobbyByBracketMatch(player1, bracketMatchId);
            expect(lobby).toBeDefined();
            expect(lobby!.isTournamentControlled).toBe(true);
            expect(lobby!.stage.tag).toBe('Waiting');

            // Cleanup: player1 closes the lobby they created
            await player1.call.closeLobby({ lobbyId: lobby!.id });
            await player1.sync(1500);
        });
    });

    // ─── approve_stand_in ────────────────────────────────────────────────

    describe('approve_stand_in', () => {
        let standInLobbyId: number;

        beforeAll(async () => {
            // Create a fresh tournament lobby for stand-in tests
            await toUser.call.createTournamentLobby({ bracketMatchId, joinCode: '' });
            await toUser.sync(1500);

            const lobby = findLobbyByBracketMatch(toUser, bracketMatchId);
            expect(lobby).toBeDefined();
            standInLobbyId = lobby!.id;
        }, 30000);

        afterAll(async () => {
            // Close the lobby used for stand-in tests
            const lobby = [...toUser.conn.db.Lobby.iter()].find(l => l.id === standInLobbyId);
            if (lobby) {
                await toUser.call.closeLobby({ lobbyId: standInLobbyId });
                await toUser.sync();
            }
        });

        it('approves stand-in — TournamentStandIn row created', async () => {
            await toUser.call.approveStandIn({
                bracketMatchId,
                userId: standIn.userId,
            });
            await toUser.sync(1500);

            const standInRows = [...toUser.conn.db.TournamentStandIn.iter()].filter(
                s => s.bracketMatchId === bracketMatchId && s.userId === standIn.userId
            );
            expect(standInRows.length).toBe(1);
            expect(standInRows[0].bracketMatchId).toBe(bracketMatchId);
            expect(standInRows[0].userId).toBe(standIn.userId);
        });

        it('duplicate approval rejected', async () => {
            // stand-in row was created in the previous test
            const err = await expectReducerError(
                toUser.call.approveStandIn({
                    bracketMatchId,
                    userId: standIn.userId,
                })
            );
            expect(err).toContain('Stand-in already approved for this bracket match.');
        });

        it('unauthorized caller rejected', async () => {
            const err = await expectReducerError(
                bystander.call.approveStandIn({
                    bracketMatchId,
                    userId: standIn.userId,
                })
            );
            expect(err).toContain(
                'Only a tournament organizer, assistant, moderator, or admin can approve stand-ins.'
            );
        });

        it('target user not found', async () => {
            const err = await expectReducerError(
                toUser.call.approveStandIn({
                    bracketMatchId,
                    userId: 999999,
                })
            );
            expect(err).toContain('Target user not found.');
        });
    });

    // ─── tournament settings lock ────────────────────────────────────────

    describe('tournament settings lock', () => {
        let lockedLobbyId: number;

        beforeAll(async () => {
            // Ensure no existing lobby for this bracketMatch
            const existing = findLobbyByBracketMatch(toUser, bracketMatchId);
            if (existing) {
                await toUser.call.closeLobby({ lobbyId: existing.id });
                await toUser.sync(1500);
            }

            // Create a fresh tournament lobby
            await toUser.call.createTournamentLobby({ bracketMatchId, joinCode: '' });
            await toUser.sync(1500);

            const lobby = findLobbyByBracketMatch(toUser, bracketMatchId);
            expect(lobby).toBeDefined();
            lockedLobbyId = lobby!.id;
        }, 30000);

        afterAll(async () => {
            const lobby = [...toUser.conn.db.Lobby.iter()].find(l => l.id === lockedLobbyId);
            if (lobby) {
                await toUser.call.closeLobby({ lobbyId: lockedLobbyId });
                await toUser.sync();
            }
        });

        it('locked fields retain tournament values, free fields update', async () => {
            // Capture the locked values before the update attempt
            const lobbyBefore = [...toUser.conn.db.Lobby.iter()].find(l => l.id === lockedLobbyId);
            expect(lobbyBefore).toBeDefined();

            const originalTeamSize = lobbyBefore!.teamSize;
            const originalGameMode = lobbyBefore!.gameMode.tag;
            const originalMatchType = lobbyBefore!.matchType.tag;

            // Attempt to change locked fields (teamSize, gameMode, matchType)
            // and free fields (draftMode, standardTurnSeconds, teamBlueAlias)
            await toUser.call.updateLobbySettings(
                defaultSettingsArgs(lockedLobbyId, {
                    // Locked fields — should NOT change
                    teamSize: 3,
                    gameMode: { tag: 'ApocalypticShadow' as const, value: {} },
                    matchType: { tag: 'Casual' as const, value: {} },
                    // Free fields — SHOULD change
                    draftMode: { tag: 'Auction' as const, value: {} },
                    standardTurnSeconds: 90,
                    teamBlueAlias: 'Champions',
                })
            );
            await toUser.sync(1500);

            const lobbyAfter = [...toUser.conn.db.Lobby.iter()].find(l => l.id === lockedLobbyId);
            expect(lobbyAfter).toBeDefined();

            // Locked fields: unchanged (tournament controls these)
            expect(lobbyAfter!.teamSize).toBe(originalTeamSize);
            expect(lobbyAfter!.gameMode.tag).toBe(originalGameMode);
            expect(lobbyAfter!.matchType.tag).toBe(originalMatchType);

            // Free fields: updated
            expect(lobbyAfter!.draftMode.tag).toBe('Auction');
            expect(lobbyAfter!.standardTurnSeconds).toBe(90);
            expect(lobbyAfter!.teamBlueAlias).toBe('Champions');
        });
    });
});
