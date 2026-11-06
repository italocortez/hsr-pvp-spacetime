/**
 * Integration tests: admin_force_finalize, admin_void_match, admin_set_bracket_winner.
 *
 * Covers:
 * - admin_force_finalize: AwaitingResult only, finalization + cleanup, non-admin rejected
 * - admin_void_match: AwaitingResult only, erases all data, non-admin rejected
 * - admin_set_bracket_winner: tested only for permission guard (tournament setup too heavyweight)
 *
 * Requires: SPACETIMEDB_SERVER_TOKEN in .env.local
 *
 * Contract: docs/match-results/contract.md — Admin Toolbox (D-52, D-53, D-54)
 * Phase: 10 (Disconnect Handling and Cost Parity)
 */

import { describe, it, expect } from 'vitest';
import {
    createVerifiedTestHarness,
    expectReducerError,
    type TestHarness,
} from '../../shared/connection';
import { promoteToAdmin } from '../../shared/helpers/promoteUser';
import { defaultLobbyArgs as sharedDefaultLobbyArgs, defaultSettingsArgs } from '../../shared/helpers/lobbies';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const defaultLobbyArgs = (overrides: Record<string, unknown> = {}) => sharedDefaultLobbyArgs({
    teamSize: 3,
    banMode: { tag: 'Six' as const, value: {} },
    characterBudget: 500, lightconeBudget: 300, minimumBidRaise: 20,
    disconnectForfeitSeconds: 60,
    allowMirrorPicks: false,
    ...overrides,
});

/** Create deferred match in AwaitingResult state */
async function setupAwaitingResult(
    host: TestHarness,
    blue: TestHarness,
    red: TestHarness,
): Promise<number> {
    await host.call.createLobby(defaultLobbyArgs());
    await host.sync(1000);
    const lobby = [...host.conn.db.Lobby.iter()].filter(l => l.hostUserId === host.userId).pop()!;

    await host.call.updateLobbySettings(defaultSettingsArgs(lobby.id));
    await host.sync(500);

    await blue.call.joinLobby({ lobbyId: lobby.id, joinCode: '', password: '' });
    await blue.sync(500);
    await red.call.joinLobby({ lobbyId: lobby.id, joinCode: '', password: '' });
    await red.sync(500);

    await blue.call.setTeamSlot({ lobbyId: lobby.id, targetUserId: blue.userId, lobbySlot: { tag: 'BluePlayer' as const } });
    await blue.sync(500);
    await red.call.setTeamSlot({ lobbyId: lobby.id, targetUserId: red.userId, lobbySlot: { tag: 'RedPlayer' as const } });
    await red.sync(500);

    await blue.call.confirmReady({ lobbyId: lobby.id });
    await red.call.confirmReady({ lobbyId: lobby.id });
    await host.sync(500);

    await host.call.startDraft({ lobbyId: lobby.id });
    await host.sync(1000);

    // Defer to AwaitingResult
    await blue.call.deferMatch({ lobbyId: lobby.id });
    await host.sync(1500);

    return lobby.id;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Admin Match Tools', () => {
    describe('admin_force_finalize', () => {
        it('finalizes deferred match and deletes lobby', async () => {
            const admin = await createVerifiedTestHarness();
            const host = await createVerifiedTestHarness();
            const blue = await createVerifiedTestHarness();
            const red = await createVerifiedTestHarness();

            try {
                const adminUser = [...admin.conn.db.User.iter()].find(u => u.id === admin.userId);
                await promoteToAdmin(adminUser!.username);
                await admin.sync(2000);

                const lobbyId = await setupAwaitingResult(host, blue, red);

                await admin.call.adminForceFinalize({ lobbyId, winnerTeamId: 1 });
                await admin.sync(2000);

                // Lobby should be deleted after finalization + cleanup
                const lobby = [...admin.conn.db.Lobby.iter()].find(l => l.id === lobbyId);
                expect(lobby).toBeUndefined();
            } finally {
                await admin.disconnect();
                await host.disconnect();
                await blue.disconnect();
                await red.disconnect();
            }
        }, 90000);

        it('non-admin rejected', async () => {
            const regular = await createVerifiedTestHarness();
            const host = await createVerifiedTestHarness();
            const blue = await createVerifiedTestHarness();
            const red = await createVerifiedTestHarness();

            try {
                const lobbyId = await setupAwaitingResult(host, blue, red);

                const err = await expectReducerError(
                    regular.call.adminForceFinalize({ lobbyId, winnerTeamId: 1 })
                );
                expect(err).toBeTruthy(); // Permission error
            } finally {
                await regular.disconnect();
                await host.disconnect();
                await blue.disconnect();
                await red.disconnect();
            }
        }, 90000);
    });

    describe('admin_void_match', () => {
        it('erases deferred match — all data deleted, no stats', async () => {
            const admin = await createVerifiedTestHarness();
            const host = await createVerifiedTestHarness();
            const blue = await createVerifiedTestHarness();
            const red = await createVerifiedTestHarness();

            try {
                const adminUser = [...admin.conn.db.User.iter()].find(u => u.id === admin.userId);
                await promoteToAdmin(adminUser!.username);
                await admin.sync(2000);

                const lobbyId = await setupAwaitingResult(host, blue, red);

                await admin.call.adminVoidMatch({ lobbyId });
                await admin.sync(2000);

                // Everything deleted
                const lobby = [...admin.conn.db.Lobby.iter()].find(l => l.id === lobbyId);
                expect(lobby).toBeUndefined();

                const members = [...admin.conn.db.LobbyMember.iter()].filter(m => m.lobbyId === lobbyId);
                expect(members).toHaveLength(0);

                const results = [...admin.conn.db.MatchResultRecord.iter()].filter(r => r.lobbyId === lobbyId);
                expect(results).toHaveLength(0);
            } finally {
                await admin.disconnect();
                await host.disconnect();
                await blue.disconnect();
                await red.disconnect();
            }
        }, 90000);

        it('non-admin rejected', async () => {
            const regular = await createVerifiedTestHarness();
            const host = await createVerifiedTestHarness();
            const blue = await createVerifiedTestHarness();
            const red = await createVerifiedTestHarness();

            try {
                const lobbyId = await setupAwaitingResult(host, blue, red);

                const err = await expectReducerError(
                    regular.call.adminVoidMatch({ lobbyId })
                );
                expect(err).toBeTruthy();
            } finally {
                await regular.disconnect();
                await host.disconnect();
                await blue.disconnect();
                await red.disconnect();
            }
        }, 90000);
    });

    describe('admin_set_bracket_winner', () => {
        it('non-admin rejected', async () => {
            const regular = await createVerifiedTestHarness();

            try {
                const err = await expectReducerError(
                    regular.call.adminSetBracketWinner({ bracketMatchId: 999, winnerTeamId: 1 })
                );
                expect(err).toBeTruthy();
            } finally {
                await regular.disconnect();
            }
        }, 15000);
    });
});
