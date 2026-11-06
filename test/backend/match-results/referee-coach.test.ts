/**
 * Integration tests for referee transfer/reclaim and coach assignment.
 *
 * Covers:
 * - transfer_referee: host transfers to member, self-transfer rejected,
 *   non-referee rejected, target not in lobby rejected
 * - reclaim_referee: host reclaims, non-host rejected, no-op when already referee
 * - Coach assignment via set_team_slot (BlueCoach/RedCoach): host assigns,
 *   self-assign rejected
 *
 * Contract: docs/match-results/contract.md
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
    createVerifiedTestHarness,
    hasServerToken,
    expectReducerError,
    type TestHarness,
} from '../../shared/connection';
import { defaultLobbyArgs } from '../../shared/helpers/lobbies';
import { lobbyMembers } from '../../shared/helpers/queries';

// ─── Tests ──────────────────────────────────────────────────────────────────

describe.skipIf(!hasServerToken())('Referee & Coach Management', () => {
    let host: TestHarness;
    let blue: TestHarness;
    let red: TestHarness;
    let outsider: TestHarness;
    let lobbyId: number;

    beforeAll(async () => {
        host = await createVerifiedTestHarness();
        blue = await createVerifiedTestHarness();
        red = await createVerifiedTestHarness();
        outsider = await createVerifiedTestHarness();
        await host.sync();
        await blue.sync();
        await red.sync();
        await outsider.sync();

        // Create lobby — host auto-joins as Spectator with isReferee=true
        await host.call.createLobby(defaultLobbyArgs());
        await host.sync(1500);
        const lobbies = [...host.conn.db.Lobby.iter()].filter(l => l.hostUserId === host.userId);
        lobbyId = lobbies[lobbies.length - 1].id;

        await blue.call.joinLobby({ lobbyId, joinCode: '', password: '' });
        await blue.sync();
        await blue.call.setTeamSlot({ lobbyId, targetUserId: blue.userId, lobbySlot: { tag: 'BluePlayer' as const } });
        await blue.sync();

        await red.call.joinLobby({ lobbyId, joinCode: '', password: '' });
        await red.sync();
        await red.call.setTeamSlot({ lobbyId, targetUserId: red.userId, lobbySlot: { tag: 'RedPlayer' as const } });
        await red.sync();
        await host.sync();
    }, 60000);

    afterAll(async () => {
        for (const h of [blue, red, host]) {
            try { await h?.call.leaveLobby({ lobbyId }); await h?.sync(); } catch {}
        }
        await host?.disconnect();
        await blue?.disconnect();
        await red?.disconnect();
        await outsider?.disconnect();
    });

    // ─── transfer_referee ────────────────────────────────────────────

    describe('transfer_referee', () => {
        it('host is initially the referee', () => {
            const members = lobbyMembers(host, lobbyId);
            const hostMember = members.find(m => m.userId === host.userId);
            expect(hostMember).toBeDefined();
            expect(hostMember!.isReferee).toBe(true);
        });

        it('self-transfer rejected', async () => {
            const err = await expectReducerError(
                host.call.transferReferee({ lobbyId, targetUserId: host.userId })
            );
            expect(err).toContain('You are already the referee.');
        });

        it('non-referee cannot transfer', async () => {
            const err = await expectReducerError(
                blue.call.transferReferee({ lobbyId, targetUserId: red.userId })
            );
            expect(err).toContain('You are not the referee of this lobby.');
        });

        it('target not in lobby rejected', async () => {
            const err = await expectReducerError(
                host.call.transferReferee({ lobbyId, targetUserId: outsider.userId })
            );
            expect(err).toContain('Target user is not a member of this lobby.');
        });

        it('host transfers referee to blue', async () => {
            await host.call.transferReferee({ lobbyId, targetUserId: blue.userId });
            await host.sync(1000);
            await blue.sync(1000);

            const members = lobbyMembers(host, lobbyId);
            const hostMember = members.find(m => m.userId === host.userId);
            const blueMember = members.find(m => m.userId === blue.userId);
            expect(hostMember!.isReferee).toBe(false);
            expect(blueMember!.isReferee).toBe(true);
        }, 15000);
    });

    // ─── reclaim_referee ─────────────────────────────────────────────

    describe('reclaim_referee', () => {
        it('non-host cannot reclaim', async () => {
            const err = await expectReducerError(
                red.call.reclaimReferee({ lobbyId })
            );
            expect(err).toContain('Only the lobby host can reclaim the referee flag.');
        });

        it('host reclaims referee from blue', async () => {
            await host.call.reclaimReferee({ lobbyId });
            await host.sync(1000);
            await blue.sync(1000);

            const members = lobbyMembers(host, lobbyId);
            const hostMember = members.find(m => m.userId === host.userId);
            const blueMember = members.find(m => m.userId === blue.userId);
            expect(hostMember!.isReferee).toBe(true);
            expect(blueMember!.isReferee).toBe(false);
        }, 15000);

        it('reclaim when already referee is no-op', async () => {
            await host.call.reclaimReferee({ lobbyId });
            await host.sync(1000);

            const members = lobbyMembers(host, lobbyId);
            const hostMember = members.find(m => m.userId === host.userId);
            expect(hostMember!.isReferee).toBe(true);
        }, 15000);
    });

    // ─── Coach Assignment via set_team_slot ───────────────────────────

    describe('coach assignment via set_team_slot', () => {
        let coachLobbyId: number;

        beforeAll(async () => {
            // Close existing lobby so users are free for a new one
            for (const h of [blue, red]) {
                try { await h.call.leaveLobby({ lobbyId }); await h.sync(); } catch {}
            }
            try { await host.call.closeLobby({ lobbyId }); await host.sync(1000); } catch {}

            // Create teamSize=3 lobby (required for coach slots)
            await host.call.createLobby(defaultLobbyArgs({ teamSize: 3 }));
            await host.sync(1500);
            const lobbies = [...host.conn.db.Lobby.iter()].filter(l => l.hostUserId === host.userId);
            coachLobbyId = lobbies[lobbies.length - 1].id;

            await blue.call.joinLobby({ lobbyId: coachLobbyId, joinCode: '', password: '' });
            await blue.sync();
            await blue.call.setTeamSlot({
                lobbyId: coachLobbyId,
                targetUserId: blue.userId,
                lobbySlot: { tag: 'BluePlayer' as const },
            });
            await blue.sync();
            await host.sync();
        }, 30000);

        afterAll(async () => {
            try { await blue?.call.leaveLobby({ lobbyId: coachLobbyId }); await blue?.sync(); } catch {}
            try { await host?.call.closeLobby({ lobbyId: coachLobbyId }); await host?.sync(); } catch {}
        });

        it('host assigns member to BlueCoach', async () => {
            await host.call.setTeamSlot({
                lobbyId: coachLobbyId,
                targetUserId: blue.userId,
                lobbySlot: { tag: 'BlueCoach' as const },
            });
            await host.sync(1000);
            await blue.sync(1000);

            const members = lobbyMembers(host, coachLobbyId);
            const blueMember = members.find(m => m.userId === blue.userId);
            expect(blueMember).toBeDefined();
            expect(blueMember!.lobbySlot.tag).toBe('BlueCoach');
        }, 15000);

        it('member cannot self-assign coach role', async () => {
            // Host resets back to BluePlayer first
            await host.call.setTeamSlot({
                lobbyId: coachLobbyId,
                targetUserId: blue.userId,
                lobbySlot: { tag: 'BluePlayer' as const },
            });
            await host.sync(1000);
            await blue.sync(1000);

            const err = await expectReducerError(
                blue.call.setTeamSlot({
                    lobbyId: coachLobbyId,
                    targetUserId: blue.userId,
                    lobbySlot: { tag: 'BlueCoach' as const },
                })
            );
            expect(err).toContain('Only the lobby host or referee can assign the coach role.');
        }, 15000);
    });
});
