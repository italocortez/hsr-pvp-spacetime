/**
 * Integration tests: leave_lobby during active match — Phase 10 disconnect handling.
 *
 * Covers:
 * - voluntarilyLeft=true preservation + freed to create new lobby
 * - Captain flag transfer on leave
 * - Auto-concede when last player on team leaves
 * - Auto-concede blocked by refereeExclusiveConcede + 3rd party referee
 * - Spectator leave during active match: clean delete (no voluntarilyLeft)
 *
 * Requires: SPACETIMEDB_SERVER_TOKEN in .env.local
 *
 * Contract: docs/lobby/contract.md — Leave Lobby During Active Match (D-29 through D-36)
 * Phase: 10 (Disconnect Handling and Cost Parity)
 */

import { describe, it, expect } from 'vitest';
import {
    createVerifiedTestHarness,
    type TestHarness,
} from '../../shared/connection';
import { defaultLobbyArgs as sharedDefaultLobbyArgs, defaultSettingsArgs as sharedDefaultSettingsArgs } from '../../shared/helpers/lobbies';
import { lobbyMembers } from '../../shared/helpers/queries';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const defaultLobbyArgs = (overrides: Record<string, unknown> = {}) => sharedDefaultLobbyArgs({
    teamSize: 3,
    banMode: { tag: 'Six' as const },
    characterBudget: 500, lightconeBudget: 300, minimumBidRaise: 20,
    disconnectPolicy: { tag: 'Standard' as const },
    disconnectForfeitSeconds: 60,
    allowMirrorPicks: false,
    ...overrides,
});

const defaultSettingsArgs = (lobbyId: number, overrides: Record<string, unknown> = {}) =>
    sharedDefaultSettingsArgs(lobbyId, { disconnectPolicy: { tag: 'Standard' as const }, ...overrides });

/** Setup a lobby in Drafting with 2 Blue + 1 Red + host(spectator) */
async function setup2v1Drafting(
    host: TestHarness,
    blue1: TestHarness,
    blue2: TestHarness,
    red: TestHarness,
    settingsOverrides: Record<string, unknown> = {},
): Promise<number> {
    await host.call.createLobby(defaultLobbyArgs());
    await host.sync(1000);
    const lobby = [...host.conn.db.Lobby.iter()].filter(l => l.hostUserId === host.userId).pop()!;

    await host.call.updateLobbySettings(defaultSettingsArgs(lobby.id, settingsOverrides));
    await host.sync(500);

    await blue1.call.joinLobby({ lobbyId: lobby.id, joinCode: '', password: '' });
    await blue1.sync(500);
    await blue2.call.joinLobby({ lobbyId: lobby.id, joinCode: '', password: '' });
    await blue2.sync(500);
    await red.call.joinLobby({ lobbyId: lobby.id, joinCode: '', password: '' });
    await red.sync(500);

    await blue1.call.setTeamSlot({ lobbyId: lobby.id, targetUserId: blue1.userId, lobbySlot: { tag: 'BluePlayer' as const } });
    await blue1.sync(500);
    await blue2.call.setTeamSlot({ lobbyId: lobby.id, targetUserId: blue2.userId, lobbySlot: { tag: 'BluePlayer' as const } });
    await blue2.sync(500);
    await red.call.setTeamSlot({ lobbyId: lobby.id, targetUserId: red.userId, lobbySlot: { tag: 'RedPlayer' as const } });
    await red.sync(500);

    await blue1.call.confirmReady({ lobbyId: lobby.id });
    await blue2.call.confirmReady({ lobbyId: lobby.id });
    await red.call.confirmReady({ lobbyId: lobby.id });
    await host.sync(500);

    await host.call.startDraft({ lobbyId: lobby.id });
    await host.sync(1000);

    return lobby.id;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('leave_lobby during active match', () => {
    it('voluntarilyLeft=true, captain transfers, freed to create new lobby', async () => {
        const host = await createVerifiedTestHarness();
        const blue1 = await createVerifiedTestHarness();
        const blue2 = await createVerifiedTestHarness();
        const red = await createVerifiedTestHarness();

        try {
            const lobbyId = await setup2v1Drafting(host, blue1, blue2, red);

            // Blue1 should be captain (lowest userId on Blue)
            const membersBefore = lobbyMembers(host, lobbyId);
            const b1Before = membersBefore.find(m => m.userId === blue1.userId);
            expect(b1Before?.isCaptain).toBe(true);

            // Blue1 leaves during Drafting
            await blue1.call.leaveLobby({ lobbyId });
            await host.sync(1500);

            const membersAfter = lobbyMembers(host, lobbyId);
            const b1After = membersAfter.find(m => m.userId === blue1.userId);
            const b2After = membersAfter.find(m => m.userId === blue2.userId);

            // Blue1: voluntarilyLeft=true, isOnline=false, no longer captain
            expect(b1After?.voluntarilyLeft).toBe(true);
            expect(b1After?.isOnline).toBe(false);
            expect(b1After?.isCaptain).toBe(false);

            // Blue2: now captain
            expect(b2After?.isCaptain).toBe(true);

            // Blue1 can create a new lobby (ensureNotInLobby skips voluntarilyLeft)
            await blue1.call.createLobby(defaultLobbyArgs());
            await blue1.sync(1000);
            const newLobbies = [...blue1.conn.db.Lobby.iter()].filter(l => l.hostUserId === blue1.userId);
            expect(newLobbies.length).toBeGreaterThanOrEqual(1);
        } finally {
            await host.disconnect();
            await blue1.disconnect();
            await blue2.disconnect();
            await red.disconnect();
        }
    }, 45000);

    it('last player on team leaves → auto-concede → lobby to AwaitingResult', async () => {
        const host = await createVerifiedTestHarness();
        const blue1 = await createVerifiedTestHarness();
        const blue2 = await createVerifiedTestHarness();
        const red = await createVerifiedTestHarness();

        try {
            const lobbyId = await setup2v1Drafting(host, blue1, blue2, red);

            // Red is the only player on Red team — leaving triggers auto-concede
            await red.call.leaveLobby({ lobbyId });
            await host.sync(2000);

            // Non-tournament → auto-finalize → lobby deleted
            const lobby = [...host.conn.db.Lobby.iter()].find(l => l.id === lobbyId);
            expect(lobby).toBeUndefined();
        } finally {
            await host.disconnect();
            await blue1.disconnect();
            await blue2.disconnect();
            await red.disconnect();
        }
    }, 45000);

    it('auto-concede blocked when refereeExclusiveConcede + 3rd party referee', async () => {
        const host = await createVerifiedTestHarness();
        const blue1 = await createVerifiedTestHarness();
        const blue2 = await createVerifiedTestHarness();
        const red = await createVerifiedTestHarness();

        try {
            const lobbyId = await setup2v1Drafting(host, blue1, blue2, red, {
                refereeExclusiveConcede: true,
            });

            // Red leaves — auto-concede should be BLOCKED (referee decides)
            await red.call.leaveLobby({ lobbyId });
            await host.sync(1500);

            // Lobby should still exist (not auto-finalized)
            const lobby = [...host.conn.db.Lobby.iter()].find(l => l.id === lobbyId);
            expect(lobby).toBeDefined();

            // Red should have voluntarilyLeft=true
            const redMember = lobbyMembers(host, lobbyId).find(m => m.userId === red.userId);
            expect(redMember?.voluntarilyLeft).toBe(true);
        } finally {
            await host.disconnect();
            await blue1.disconnect();
            await blue2.disconnect();
            await red.disconnect();
        }
    }, 45000);

    it('spectator leaves during active match — clean delete, no voluntarilyLeft', async () => {
        const host = await createVerifiedTestHarness();
        const blue = await createVerifiedTestHarness();
        const red = await createVerifiedTestHarness();
        const spectator = await createVerifiedTestHarness();

        try {
            await host.call.createLobby(defaultLobbyArgs());
            await host.sync(1000);
            const lobby = [...host.conn.db.Lobby.iter()].filter(l => l.hostUserId === host.userId).pop()!;
            await host.call.updateLobbySettings(defaultSettingsArgs(lobby.id));
            await host.sync(500);

            await blue.call.joinLobby({ lobbyId: lobby.id, joinCode: '', password: '' });
            await blue.sync(500);
            await red.call.joinLobby({ lobbyId: lobby.id, joinCode: '', password: '' });
            await red.sync(500);
            await spectator.call.joinLobby({ lobbyId: lobby.id, joinCode: '', password: '' });
            await spectator.sync(500);

            await blue.call.setTeamSlot({ lobbyId: lobby.id, targetUserId: blue.userId, lobbySlot: { tag: 'BluePlayer' as const } });
            await blue.sync(500);
            await red.call.setTeamSlot({ lobbyId: lobby.id, targetUserId: red.userId, lobbySlot: { tag: 'RedPlayer' as const } });
            await red.sync(500);
            // spectator stays on Spectator slot (default)

            await blue.call.confirmReady({ lobbyId: lobby.id });
            await red.call.confirmReady({ lobbyId: lobby.id });
            await host.sync(500);
            await host.call.startDraft({ lobbyId: lobby.id });
            await host.sync(1000);

            // Spectator leaves during Drafting — should be clean delete
            await spectator.call.leaveLobby({ lobbyId: lobby.id });
            await host.sync(1000);

            const specMember = lobbyMembers(host, lobby.id).find(m => m.userId === spectator.userId);
            expect(specMember).toBeUndefined(); // deleted, not voluntarilyLeft
        } finally {
            await host.disconnect();
            await blue.disconnect();
            await red.disconnect();
            await spectator.disconnect();
        }
    }, 45000);
});
