/**
 * Shared lobby test helpers.
 *
 * Exports:
 *   - defaultLobbyArgs: union-superset defaults for create_lobby (includes
 *     bestOf + refereeControlsShelving required by the reducer since Phase 10.4)
 *   - defaultSettingsArgs: union-superset defaults for update_lobby_settings
 *     (includes refereeExclusiveConcede required since Phase 10)
 *   - cleanupLobby: teardown helper — leaves all members then closes the lobby
 */

import type { TestHarness } from '../connection';

/**
 * Default args for the create_lobby reducer (union of every field found
 * across the 20 pre-extraction copies; the reducer bindings currently
 * require ALL of these fields including bestOf + refereeControlsShelving).
 */
export function defaultLobbyArgs(overrides: Record<string, unknown> = {}) {
    return {
        joinCode: '',
        presetId: 0,
        teamSize: 1,
        draftMode: { tag: 'Classic' as const, value: {} },
        banMode: { tag: 'None' as const, value: {} },
        gameMode: { tag: 'MemoryOfChaos' as const, value: {} },
        matchType: { tag: 'Casual' as const, value: {} },
        isPublic: true,
        password: '',
        standardTurnSeconds: 60,
        reserveBankSeconds: 120,
        characterBudget: 100,
        lightconeBudget: 50,
        minimumBidRaise: 0.5,
        rosterDiffAdvantage: 0,
        rosterThreshold: 0,
        underThresholdAdvantage: 0,
        aboveThresholdPenalty: 0,
        deathPenalty: 0,
        isAnonymousPlayers: false,
        isAnonymousSpectators: false,
        rosterVisibility: { tag: 'OpenRoster' as const, value: {} },
        requireOwnership: false,
        costSetId: 0,
        disconnectPolicy: { tag: 'Deferred' as const, value: {} },
        disconnectForfeitSeconds: 0,
        allowMirrorPicks: true,
        autoRandomPick: false,
        refereeCanUndo: true,
        refereeCanPause: true,
        refereeCanSetCaptain: true,
        refereeCanKick: true,
        allowPlayerPause: true,
        teamBlueAlias: 'Blue',
        teamRedAlias: 'Red',
        bestOf: 1,
        refereeControlsShelving: false,
        ...overrides,
    };
}

/**
 * Default args for the update_lobby_settings reducer (requires lobbyId as first
 * argument plus every setting field including refereeExclusiveConcede).
 */
export function defaultSettingsArgs(lobbyId: number, overrides: Record<string, unknown> = {}) {
    return {
        lobbyId,
        teamSize: 3,
        draftMode: { tag: 'Classic' as const, value: {} },
        banMode: { tag: 'Six' as const, value: {} },
        gameMode: { tag: 'MemoryOfChaos' as const, value: {} },
        matchType: { tag: 'Casual' as const, value: {} },
        standardTurnSeconds: 60,
        reserveBankSeconds: 120,
        characterBudget: 500,
        lightconeBudget: 300,
        minimumBidRaise: 20,
        rosterDiffAdvantage: 0,
        rosterThreshold: 0,
        underThresholdAdvantage: 0,
        aboveThresholdPenalty: 0,
        deathPenalty: 0,
        isAnonymousPlayers: false,
        isAnonymousSpectators: false,
        rosterVisibility: { tag: 'OpenRoster' as const, value: {} },
        requireOwnership: false,
        costSetId: 0,
        disconnectPolicy: { tag: 'Deferred' as const, value: {} },
        disconnectForfeitSeconds: 60,
        allowMirrorPicks: false,
        autoRandomPick: false,
        refereeCanUndo: true,
        refereeCanPause: true,
        refereeCanSetCaptain: true,
        refereeCanKick: true,
        allowPlayerPause: true,
        refereeExclusiveConcede: false,
        teamBlueAlias: 'Blue',
        teamRedAlias: 'Red',
        isPublic: true,
        password: '',
        ...overrides,
    };
}

/**
 * Teardown helper: leaves every member from the lobby then closes it as host.
 * Swallows errors (member may have already left, lobby may already be closed).
 */
export async function cleanupLobby(
    host: TestHarness,
    members: TestHarness[],
    lobbyId: number,
): Promise<void> {
    for (const m of members) {
        try {
            await m.call.leaveLobby({ lobbyId });
            await m.sync(500);
        } catch (_) { /* already left or not a member */ }
    }
    try {
        await host.call.closeLobby({ lobbyId });
        await host.sync(500);
    } catch (_) { /* already closed */ }
}
