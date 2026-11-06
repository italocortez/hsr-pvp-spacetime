/**
 * Integration tests: Anonymous play — label format, cursor behavior, write-time enforcement.
 *
 * Covers:
 * - Anonymous label format: Blue player → /^Blue-\d+$/, Red → /^Red-\d+$/, Spectator → /^Spectator-\d+$/
 * - System messages: no anonymousLabel even in anonymous lobby
 * - Label computed for all members when either anonymous toggle is on (OR gate at write time)
 * - No label when both toggles off
 * - broadcast_cursor: succeeds for players in anonymous lobby
 * - broadcast_cursor: spectator silenced (D-34), no error
 * - broadcast_cursor: non-member silently ignored
 *
 * NOTE: Independent spectator toggle (isAnonymousPlayers vs isAnonymousSpectators) is enforced
 * at the VIEW level (view_my_lobby_chat), not at write time. The raw ChatMessage row stores
 * anonymousLabel whenever EITHER toggle is true. View bindings are not generated, so
 * view-level anonymization is not tested here.
 *
 * Contract: docs/anonymous-play/contract.md + docs/views/contract.md
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
    createVerifiedTestHarness,
    hasServerToken,
    type TestHarness,
} from '../../shared/connection';
import { defaultLobbyArgs, cleanupLobby } from '../../shared/helpers/lobbies';
import { myLobbies, latestLobby } from '../../shared/helpers/queries';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Wait for a new lobby to appear after creation (robust against subscription backlog). */
async function waitForNewLobby(h: TestHarness, countBefore: number, timeoutMs = 5000): Promise<number> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        await h.sync(200);
        const lobbies = myLobbies(h);
        if (lobbies.length > countBefore) return lobbies[lobbies.length - 1].id;
    }
    throw new Error(`Timed out waiting for new lobby (had ${countBefore}, still ${myLobbies(h).length})`);
}

function playerMessages(h: TestHarness, lobbyId: number) {
    return [...h.conn.db.ChatMessage.iter()].filter(
        m => m.lobbyId === lobbyId && m.senderType.tag === 'Player'
    );
}

function systemMessages(h: TestHarness, lobbyId: number) {
    return [...h.conn.db.ChatMessage.iter()].filter(
        m => m.lobbyId === lobbyId && m.senderType.tag === 'System'
    );
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe.skipIf(!hasServerToken())('Anonymous Play', () => {
    let host: TestHarness;
    let blue: TestHarness;
    let red: TestHarness;
    let spectator: TestHarness;
    let outsider: TestHarness;

    beforeAll(async () => {
        host = await createVerifiedTestHarness();
        blue = await createVerifiedTestHarness();
        red = await createVerifiedTestHarness();
        spectator = await createVerifiedTestHarness();
        outsider = await createVerifiedTestHarness();
    }, 60000);

    afterAll(async () => {
        await host?.disconnect();
        await blue?.disconnect();
        await red?.disconnect();
        await spectator?.disconnect();
        await outsider?.disconnect();
    });

    // ═══ Label Format (isAnonymousPlayers=true, isAnonymousSpectators=true) ══

    describe('anonymous label format', () => {
        let lobbyId: number;

        beforeAll(async () => {
            await host.call.createLobby(defaultLobbyArgs({
                isAnonymousPlayers: true,
                isAnonymousSpectators: true,
            }));
            await host.sync(1500);
            lobbyId = latestLobby(host).id;

            // Blue player
            await blue.call.joinLobby({ lobbyId, joinCode: '', password: '' });
            await blue.sync();
            await blue.call.setTeamSlot({
                lobbyId, targetUserId: blue.userId,
                lobbySlot: { tag: 'BluePlayer' as const },
            });
            await blue.sync();

            // Red player
            await red.call.joinLobby({ lobbyId, joinCode: '', password: '' });
            await red.sync();
            await red.call.setTeamSlot({
                lobbyId, targetUserId: red.userId,
                lobbySlot: { tag: 'RedPlayer' as const },
            });
            await red.sync();

            // Spectator (default slot)
            await spectator.call.joinLobby({ lobbyId, joinCode: '', password: '' });
            await spectator.sync();

            // Coach — outsider joins, host assigns BlueCoach slot
            await outsider.call.joinLobby({ lobbyId, joinCode: '', password: '' });
            await outsider.sync();
            await host.call.setTeamSlot({
                lobbyId, targetUserId: outsider.userId,
                lobbySlot: { tag: 'BlueCoach' as const },
            });
            await outsider.sync();
            await host.sync(1000);

            // Each sends a message
            await blue.call.sendChatMessage({ lobbyId, content: 'blue-fmt', metadata: '' });
            await blue.sync();
            await red.call.sendChatMessage({ lobbyId, content: 'red-fmt', metadata: '' });
            await red.sync();
            await spectator.call.sendChatMessage({ lobbyId, content: 'spec-fmt', metadata: '' });
            await spectator.sync();
            await outsider.call.sendChatMessage({ lobbyId, content: 'coach-fmt', metadata: '' });
            await outsider.sync();
            await host.sync(1000);
        }, 30000);

        afterAll(async () => {
            await cleanupLobby(host, [blue, red, spectator, outsider], lobbyId);
        });

        it('Blue player label matches Blue-N format', () => {
            const msg = playerMessages(host, lobbyId).find(m => m.content === 'blue-fmt');
            expect(msg).toBeDefined();
            expect(msg!.anonymousLabel).toMatch(/^Blue-\d+$/);
        });

        it('Red player label matches Red-N format', () => {
            const msg = playerMessages(host, lobbyId).find(m => m.content === 'red-fmt');
            expect(msg).toBeDefined();
            expect(msg!.anonymousLabel).toMatch(/^Red-\d+$/);
        });

        it('Spectator label matches Spectator-N format', () => {
            const msg = playerMessages(host, lobbyId).find(m => m.content === 'spec-fmt');
            expect(msg).toBeDefined();
            expect(msg!.anonymousLabel).toMatch(/^Spectator-\d+$/);
        });

        it('Coach label matches Coach-{Team} format', () => {
            const msg = playerMessages(host, lobbyId).find(m => m.content === 'coach-fmt');
            expect(msg).toBeDefined();
            expect(msg!.anonymousLabel).toMatch(/^Coach-Blue$/);
        });

        it('system messages have no anonymousLabel in anonymous lobby', () => {
            const sysMsgs = systemMessages(host, lobbyId);
            expect(sysMsgs.length).toBeGreaterThan(0);
            for (const msg of sysMsgs) {
                expect(msg.anonymousLabel).toBeUndefined();
            }
        });
    });

    // ═══ Write-time OR gate ══════════════════════════════════════════════════

    describe('write-time anonymous label gate', () => {
        it('isAnonymousSpectators=true only → label still computed for all members', async () => {
            // Only spectators toggle on, players off — but labels computed for everyone at write time
            const countBefore = myLobbies(host).length;
            await host.call.createLobby(defaultLobbyArgs({
                isAnonymousPlayers: false,
                isAnonymousSpectators: true,
            }));
            const lobbyId = await waitForNewLobby(host, countBefore);

            await blue.call.joinLobby({ lobbyId, joinCode: '', password: '' });
            await blue.sync();
            await blue.call.setTeamSlot({
                lobbyId, targetUserId: blue.userId,
                lobbySlot: { tag: 'BluePlayer' as const },
            });
            await blue.sync();

            await blue.call.sendChatMessage({ lobbyId, content: 'spec-only-toggle', metadata: '' });
            await blue.sync();
            await host.sync(1000);

            const msg = playerMessages(host, lobbyId).find(m => m.content === 'spec-only-toggle');
            expect(msg).toBeDefined();
            // Label IS set at write time (OR gate: false || true = true)
            expect(msg!.anonymousLabel).toBeDefined();
            expect(msg!.anonymousLabel!.length).toBeGreaterThan(0);

            await cleanupLobby(host, [blue], lobbyId);
        });

        it('both toggles off → no label on any messages', async () => {
            const countBefore = myLobbies(host).length;
            await host.call.createLobby(defaultLobbyArgs({
                isAnonymousPlayers: false,
                isAnonymousSpectators: false,
            }));
            const lobbyId = await waitForNewLobby(host, countBefore);

            await blue.call.joinLobby({ lobbyId, joinCode: '', password: '' });
            await blue.sync();

            await blue.call.sendChatMessage({ lobbyId, content: 'nonanon-both-off', metadata: '' });
            await blue.sync();
            await host.sync(1000);

            const msg = playerMessages(host, lobbyId).find(m => m.content === 'nonanon-both-off');
            expect(msg).toBeDefined();
            expect(msg!.anonymousLabel).toBeUndefined();
            expect(msg!.senderUserId).toBe(blue.userId);

            await cleanupLobby(host, [blue], lobbyId);
        });
    });

    // ═══ broadcast_cursor ════════════════════════════════════════════════════

    describe('broadcast_cursor', () => {
        let lobbyId: number;

        beforeAll(async () => {
            await host.call.createLobby(defaultLobbyArgs({
                isAnonymousPlayers: true,
            }));
            await host.sync(1500);
            lobbyId = latestLobby(host).id;

            await blue.call.joinLobby({ lobbyId, joinCode: '', password: '' });
            await blue.sync();
            await blue.call.setTeamSlot({
                lobbyId, targetUserId: blue.userId,
                lobbySlot: { tag: 'BluePlayer' as const },
            });
            await blue.sync();

            await spectator.call.joinLobby({ lobbyId, joinCode: '', password: '' });
            await spectator.sync();
            await host.sync(1000);
        }, 30000);

        afterAll(async () => {
            await cleanupLobby(host, [blue, spectator], lobbyId);
        });

        it('player broadcasts cursor without error in anonymous lobby', async () => {
            await blue.call.broadcastCursor({ lobbyId, x: 100.5, y: 200.5 });
            // No error = success (LobbyCursorEvent is ephemeral event table)
        });

        it('spectator cursor silenced (D-34) — no error', async () => {
            await spectator.call.broadcastCursor({ lobbyId, x: 50, y: 50 });
            // No error = silently ignored per D-34
        });

        it('non-member cursor silently ignored', async () => {
            await outsider.call.broadcastCursor({ lobbyId, x: 10, y: 10 });
            // No error = silently ignored (not a member)
        });
    });
});
