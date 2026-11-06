/**
 * Integration tests: concede_match, claim_forfeit, defer_match reducers.
 *
 * Covers:
 * - concede_match: voluntary surrender during Drafting, auto-finalize for non-tournament
 * - concede_match: referee exclusive control — player rejected, referee succeeds
 * - concede_match: blocked in Waiting, player must pass losingTeamSide=0
 * - claim_forfeit: Standard policy only (Deferred rejects)
 * - defer_match: Deferred policy only (Standard rejects), no winner, concedeSummary populated
 *
 * NOT COVERED (gaps):
 * - claim_forfeit success path: requires clientDisconnected to fire (sets LobbyMember.disconnectedAt),
 *   which does not trigger from harness disconnect() on maincloud. Needs real browser tab close.
 * - Ranked Scoring concede finalization matrix (D-79): requires full draft + equip completion to reach
 *   Scoring stage. Verify MMR + stats written, achievement check skipped, character stats at Equipping+.
 *   Heavyweight setup — deferred to dedicated test or manual UAT.
 *
 * Requires: SPACETIMEDB_SERVER_TOKEN in .env.local
 *
 * Contract: docs/lobby/contract.md — Concede / Forfeit / Defer scenarios
 * Phase: 10 (Disconnect Handling and Cost Parity)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
    createVerifiedTestHarness,
    expectReducerError,
    type TestHarness,
} from '../../shared/connection';
import { defaultLobbyArgs as sharedDefaultLobbyArgs, defaultSettingsArgs as sharedDefaultSettingsArgs } from '../../shared/helpers/lobbies';
import { ensureHsrAccount } from '../../shared/helpers/hsrAccounts';

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

/** Create a lobby in Drafting state with host(spectator) + blue + red */
async function setupDraftingLobby(
    host: TestHarness,
    blue: TestHarness,
    red: TestHarness,
    lobbyOverrides: Record<string, unknown> = {},
    settingsOverrides: Record<string, unknown> = {},
): Promise<number> {
    await host.call.createLobby(defaultLobbyArgs(lobbyOverrides));
    await host.sync(1000);
    const lobby = [...host.conn.db.Lobby.iter()].filter(l => l.hostUserId === host.userId).pop()!;

    await host.call.updateLobbySettings(defaultSettingsArgs(lobby.id, settingsOverrides));
    await host.sync(500);

    // Ensure HSR accounts for D-08 LMA gate
    await ensureHsrAccount(host);
    await ensureHsrAccount(blue);
    await ensureHsrAccount(red);

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

    return lobby.id;
}

function matchResults(h: TestHarness, lobbyId: number) {
    return [...h.conn.db.MatchResultRecord.iter()].filter(r => r.lobbyId === lobbyId);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Concede / Forfeit / Defer', () => {
    // Each test creates fresh users to avoid one-lobby-per-user conflicts
    // Tests run sequentially (fileParallelism: false in integration config)

    describe('concede_match', () => {
        it('player concedes during Drafting — non-tournament auto-finalizes (lobby deleted)', async () => {
            const host = await createVerifiedTestHarness();
            const blue = await createVerifiedTestHarness();
            const red = await createVerifiedTestHarness();

            try {
                const lobbyId = await setupDraftingLobby(host, blue, red);

                await blue.call.concedeMatch({ lobbyId, losingTeamSide: 0 });
                await host.sync(2000);

                // Non-tournament casual concede → auto-finalize → lobby deleted
                const lobby = [...host.conn.db.Lobby.iter()].find(l => l.id === lobbyId);
                expect(lobby).toBeUndefined();
            } finally {
                await host.disconnect();
                await blue.disconnect();
                await red.disconnect();
            }
        }, 30000);

        it('blocked in Waiting stage', async () => {
            const host = await createVerifiedTestHarness();
            const blue = await createVerifiedTestHarness();

            try {
                await host.call.createLobby(defaultLobbyArgs());
                await host.sync(1000);
                const lobby = [...host.conn.db.Lobby.iter()].filter(l => l.hostUserId === host.userId).pop()!;

                await host.call.updateLobbySettings(defaultSettingsArgs(lobby.id));
                await host.sync(500);

                await blue.call.joinLobby({ lobbyId: lobby.id, joinCode: '', password: '' });
                await blue.sync(500);
                await blue.call.setTeamSlot({ lobbyId: lobby.id, targetUserId: blue.userId, lobbySlot: { tag: 'BluePlayer' as const } });
                await blue.sync(500);

                // Lobby is still in Waiting — concede should be rejected
                const err = await expectReducerError(
                    blue.call.concedeMatch({ lobbyId: lobby.id, losingTeamSide: 0 })
                );
                expect(err).toContain('only available during Drafting, Equipping, Scoring, or BetweenGames');
            } finally {
                await host.disconnect();
                await blue.disconnect();
            }
        }, 30000);

        it('player must pass losingTeamSide=0 (non-zero rejected)', async () => {
            const host = await createVerifiedTestHarness();
            const blue = await createVerifiedTestHarness();
            const red = await createVerifiedTestHarness();

            try {
                const lobbyId = await setupDraftingLobby(host, blue, red);

                const err = await expectReducerError(
                    blue.call.concedeMatch({ lobbyId, losingTeamSide: 2 })
                );
                expect(err).toContain('Players must pass losingTeamSide=0');
            } finally {
                await host.disconnect();
                await blue.disconnect();
                await red.disconnect();
            }
        }, 30000);

        it('referee exclusive — player rejected, referee succeeds with RefereeDecision', async () => {
            const host = await createVerifiedTestHarness();
            const blue = await createVerifiedTestHarness();
            const red = await createVerifiedTestHarness();

            try {
                // refereeExclusiveConcede defaults to true (don't override)
                const lobbyId = await setupDraftingLobby(host, blue, red, {}, {
                    refereeExclusiveConcede: true,
                });

                // Player rejected
                const err = await expectReducerError(
                    blue.call.concedeMatch({ lobbyId, losingTeamSide: 0 })
                );
                expect(err).toContain('Only the referee can concede');

                // Referee (host on Spectator) succeeds with losingTeamSide=1 (Blue)
                await host.call.concedeMatch({ lobbyId, losingTeamSide: 1 });
                await host.sync(2000);

                // Auto-finalized (non-tournament) → lobby deleted
                const lobby = [...host.conn.db.Lobby.iter()].find(l => l.id === lobbyId);
                expect(lobby).toBeUndefined();
            } finally {
                await host.disconnect();
                await blue.disconnect();
                await red.disconnect();
            }
        }, 30000);
    });

    describe('claim_forfeit', () => {
        it('rejects under Deferred policy', async () => {
            const host = await createVerifiedTestHarness();
            const blue = await createVerifiedTestHarness();
            const red = await createVerifiedTestHarness();

            try {
                const lobbyId = await setupDraftingLobby(host, blue, red,
                    { disconnectPolicy: { tag: 'Deferred' as const } },
                    { disconnectPolicy: { tag: 'Deferred' as const } },
                );

                const err = await expectReducerError(
                    blue.call.claimForfeit({ lobbyId })
                );
                expect(err).toContain('only available under Standard disconnect policy');
            } finally {
                await host.disconnect();
                await blue.disconnect();
                await red.disconnect();
            }
        }, 30000);
    });

    describe('defer_match', () => {
        it('Deferred policy — lobby to AwaitingResult, no winner, summary populated', async () => {
            const host = await createVerifiedTestHarness();
            const blue = await createVerifiedTestHarness();
            const red = await createVerifiedTestHarness();

            try {
                const lobbyId = await setupDraftingLobby(host, blue, red,
                    { disconnectPolicy: { tag: 'Deferred' as const } },
                    { disconnectPolicy: { tag: 'Deferred' as const } },
                );

                await blue.call.deferMatch({ lobbyId });
                await host.sync(1500);

                const lobby = [...host.conn.db.Lobby.iter()].find(l => l.id === lobbyId);
                expect(lobby?.stage.tag).toBe('AwaitingResult');

                // Check MatchResultRecord — should have no winner
                const results = matchResults(host, lobbyId);
                const deferResult = results.find(r => r.concedeSummary !== undefined && r.concedeSummary !== null);
                expect(deferResult).toBeDefined();
                expect(deferResult!.winnerTeamSide).toBeUndefined();
            } finally {
                await host.disconnect();
                await blue.disconnect();
                await red.disconnect();
            }
        }, 30000);

        it('rejects under Standard policy', async () => {
            const host = await createVerifiedTestHarness();
            const blue = await createVerifiedTestHarness();
            const red = await createVerifiedTestHarness();

            try {
                const lobbyId = await setupDraftingLobby(host, blue, red);

                const err = await expectReducerError(
                    blue.call.deferMatch({ lobbyId })
                );
                expect(err).toContain('only available under Deferred disconnect policy');
            } finally {
                await host.disconnect();
                await blue.disconnect();
                await red.disconnect();
            }
        }, 30000);
    });
});
