/**
 * Shared tournament test helpers.
 *
 * Exports:
 *   - createTournamentArgs: union-superset defaults for create_tournament
 *     (includes maxAccountsPerPlayer required since Phase 10.4)
 *   - setupRegistrationTournament: create tournament → advance to Registration
 *     → register each player → return tournamentId
 *   - advanceToInProgress: Registration → Seeding → seed bracket → generate
 *     bracket → InProgress
 *   - cleanupTournament: swallow-catch wrapper around cancel_tournament
 */

import type { TestHarness } from '../connection';

/**
 * Default args for create_tournament (union superset; reducer requires every
 * field including maxAccountsPerPlayer since Phase 10.4).
 */
export function createTournamentArgs(overrides: Record<string, unknown> = {}) {
    return {
        name: `Test Tournament ${Date.now()}`,
        description: 'Integration test tournament',
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
        ...overrides,
    };
}

/**
 * Create a tournament, advance to Registration, register each player,
 * and return the tournamentId.
 */
export async function setupRegistrationTournament(
    toUser: TestHarness,
    players: TestHarness[],
    overrides: Record<string, unknown> = {},
): Promise<number> {
    await toUser.call.createTournament(createTournamentArgs(overrides));
    await toUser.sync(1500);

    const tournaments = [...toUser.conn.db.Tournament.iter()].filter(
        t => t.organizerId === toUser.userId
    );
    const tournamentId = tournaments[tournaments.length - 1].id;

    await toUser.call.advanceTournamentStage({ tournamentId, nextStage: 'Registration' });
    await toUser.sync(1000);

    for (const p of players) {
        await p.call.registerForTournament({ tournamentId });
        await p.sync(1000);
    }
    await toUser.sync(1000);

    return tournamentId;
}

/**
 * Advance a tournament from Registration → Seeding → seed bracket → generate
 * bracket → InProgress.
 */
export async function advanceToInProgress(
    toUser: TestHarness,
    tournamentId: number,
): Promise<void> {
    await toUser.call.advanceTournamentStage({ tournamentId, nextStage: 'Seeding' });
    await toUser.sync(1500);

    await toUser.call.seedBracket({ tournamentId, mode: 'random' });
    await toUser.sync(1500);

    await toUser.call.generateBracket({ tournamentId });
    await toUser.sync(1500);

    await toUser.call.advanceTournamentStage({ tournamentId, nextStage: 'InProgress' });
    await toUser.sync(1500);
}

/**
 * Cancel a tournament as the TO, swallowing errors if already cancelled or in
 * a terminal stage.
 */
export async function cleanupTournament(
    toUser: TestHarness,
    tournamentId: number,
): Promise<void> {
    try {
        await toUser.call.cancelTournament({ tournamentId });
        await toUser.sync(500);
    } catch (_) { /* already cancelled or terminal */ }
}
