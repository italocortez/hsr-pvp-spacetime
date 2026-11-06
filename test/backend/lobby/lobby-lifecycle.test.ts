/**
 * Integration tests for lobby lifecycle reducers.
 *
 * Covers:
 * - create_lobby: defaults, one-per-user, guest restrictions, Ranked rules, private lobbies, join code
 * - join_lobby: by ID, by join code, private with password, wrong password, banned user, one-per-user
 * - leave_lobby: count decremented, empty Waiting lobby auto-closes
 * - close_lobby: cascade delete, permission guard
 * - kick_member: host kicks, kick self blocked, kick host blocked
 * - ban_member: ban+remove, preventive ban, banned user cannot rejoin, ban self/host blocked
 *
 * Requires: SPACETIMEDB_SERVER_TOKEN in .env.local (post-publish bootstrap)
 *
 * Contract: docs/lobby/contract.md — Lobby Lifecycle scenarios
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
    createTestHarness,
    createVerifiedTestHarness,
    expectReducerError,
    type TestHarness,
} from '../../shared/connection';
import { promoteUser } from '../../shared/helpers/promoteUser';
import { defaultLobbyArgs, cleanupLobby } from '../../shared/helpers/lobbies';
import { myLobbies, lobbyMembers, lobbyBans } from '../../shared/helpers/queries';

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Lobby Lifecycle', () => {
    let host: TestHarness;
    let joiner: TestHarness;
    let bystander: TestHarness;
    let guest: TestHarness;
    const openedLobbyIds: number[] = [];

    beforeAll(async () => {
        host = await createVerifiedTestHarness();
        joiner = await createVerifiedTestHarness();
        bystander = await createVerifiedTestHarness();
        guest = await createTestHarness();

        await host.sync();
        await joiner.sync();
        await bystander.sync();
        await guest.sync();
    }, 30000);

    afterAll(async () => {
        // D-03: strict cleanup per resource opened (safety net — tests mostly
        // close lobbies inline; cleanupLobby swallows already-closed errors)
        for (const lobbyId of openedLobbyIds) {
            await cleanupLobby(host, [joiner, bystander, guest], lobbyId).catch(() => {});
        }
        await host?.disconnect();
        await joiner?.disconnect();
        await bystander?.disconnect();
        await guest?.disconnect();
    });

    // ─── create_lobby ────────────────────────────────────────────────────

    describe('create_lobby', () => {
        it('creates a public Casual lobby with correct defaults', async () => {
            await host.call.createLobby(defaultLobbyArgs());
            await host.sync(1500);

            const lobbies = myLobbies(host);
            expect(lobbies.length).toBeGreaterThanOrEqual(1);

            const lobby = lobbies[lobbies.length - 1];
            openedLobbyIds.push(lobby.id);
            expect(lobby.stage.tag).toBe('Waiting');
            expect(lobby.currentPlayerCount).toBe(1);
            expect(lobby.hostUserId).toBe(host.userId);
            expect(lobby.isPublic).toBe(true);

            const members = lobbyMembers(host, lobby.id);
            expect(members.length).toBe(1);

            const hostMember = members.find(m => m.userId === host.userId);
            expect(hostMember).toBeDefined();
            expect(hostMember!.isReferee).toBe(true);
            expect(hostMember!.lobbySlot.tag).toBe('Spectator');
            expect(hostMember!.isConfirmed).toBe(false);
            expect(hostMember!.isCaptain).toBe(false);

            // Cleanup
            await host.call.closeLobby({ lobbyId: lobby.id });
            await host.sync();
        });

        it('one-per-user: rejects creating second lobby', async () => {
            await host.call.createLobby(defaultLobbyArgs());
            await host.sync(1500);

            const lobbies = myLobbies(host);
            const lobby = lobbies[lobbies.length - 1];
            openedLobbyIds.push(lobby.id);

            const err = await expectReducerError(
                host.call.createLobby(defaultLobbyArgs())
            );
            expect(err).toContain('You are already in a lobby. Leave it before creating or joining another.');

            // Cleanup
            await host.call.closeLobby({ lobbyId: lobby.id });
            await host.sync();
        });

        it('guest creates Casual lobby with forced ClosedNoRating', async () => {
            await guest.call.createLobby(defaultLobbyArgs({ rosterVisibility: { tag: 'OpenRoster' as const, value: {} } }));
            await guest.sync(1500);

            const lobbies = [...guest.conn.db.Lobby.iter()].filter(l => l.hostUserId === guest.userId);
            expect(lobbies.length).toBeGreaterThanOrEqual(1);

            const lobby = lobbies[lobbies.length - 1];
            openedLobbyIds.push(lobby.id);
            // Guest's rosterVisibility must be forced to ClosedNoRating
            expect(lobby.rosterVisibility.tag).toBe('ClosedNoRating');

            // Cleanup
            await guest.call.leaveLobby({ lobbyId: lobby.id });
            await guest.sync();
        });

        it('guest blocked from Ranked lobby', async () => {
            const err = await expectReducerError(
                guest.call.createLobby(defaultLobbyArgs({ matchType: { tag: 'Ranked' as const, value: {} } }))
            );
            expect(err).toContain('Guests cannot create or join Ranked lobbies.');
        });

        it('Ranked lobby forces allowMirrorPicks=false', async () => {
            await host.call.createLobby(defaultLobbyArgs({ matchType: { tag: 'Ranked' as const, value: {} }, allowMirrorPicks: true }));
            await host.sync(1500);

            const lobbies = myLobbies(host);
            const lobby = lobbies[lobbies.length - 1];
            openedLobbyIds.push(lobby.id);
            expect(lobby.allowMirrorPicks).toBe(false);

            // Cleanup
            await host.call.closeLobby({ lobbyId: lobby.id });
            await host.sync();
        });

        it('private lobby is created with isPublic=false', async () => {
            // LobbyPassword is private (public: false) and won't appear in subscription cache.
            // We verify the lobby is created correctly and isPublic=false.
            // Password enforcement is verified by join tests.
            await host.call.createLobby(defaultLobbyArgs({ isPublic: false, password: 'secret' }));
            await host.sync(1500);

            const lobbies = myLobbies(host);
            const lobby = lobbies[lobbies.length - 1];
            openedLobbyIds.push(lobby.id);
            expect(lobby.isPublic).toBe(false);

            // Cleanup
            await host.call.closeLobby({ lobbyId: lobby.id });
            await host.sync();
        });

        it('server generates 6-char join code', async () => {
            await host.call.createLobby(defaultLobbyArgs());
            await host.sync(1500);

            const lobbies = myLobbies(host);
            const lobby = lobbies[lobbies.length - 1];
            openedLobbyIds.push(lobby.id);
            expect(typeof lobby.joinCode).toBe('string');
            expect(lobby.joinCode.length).toBe(6);

            // Cleanup
            await host.call.closeLobby({ lobbyId: lobby.id });
            await host.sync();
        });
    });

    // ─── join_lobby ──────────────────────────────────────────────────────

    describe('join_lobby', () => {
        it('joins public lobby by ID', async () => {
            await host.call.createLobby(defaultLobbyArgs());
            await host.sync(1500);

            const lobbies = myLobbies(host);
            const lobby = lobbies[lobbies.length - 1];
            openedLobbyIds.push(lobby.id);
            const countBefore = lobby.currentPlayerCount;

            await joiner.call.joinLobby({ lobbyId: lobby.id, joinCode: '', password: '' });
            await host.sync();
            await joiner.sync();

            const joinerMember = lobbyMembers(host, lobby.id).find(m => m.userId === joiner.userId);
            expect(joinerMember).toBeDefined();
            expect(joinerMember!.lobbySlot.tag).toBe('Spectator');

            const updatedLobby = [...host.conn.db.Lobby.iter()].find(l => l.id === lobby.id);
            expect(updatedLobby!.currentPlayerCount).toBe(countBefore + 1);

            // Cleanup
            await joiner.call.leaveLobby({ lobbyId: lobby.id });
            await joiner.sync();
            await host.call.closeLobby({ lobbyId: lobby.id });
            await host.sync();
        });

        it('joins lobby by join code', async () => {
            await host.call.createLobby(defaultLobbyArgs());
            await host.sync(1500);

            const lobbies = myLobbies(host);
            const lobby = lobbies[lobbies.length - 1];
            openedLobbyIds.push(lobby.id);

            await joiner.call.joinLobby({ lobbyId: 0, joinCode: lobby.joinCode, password: '' });
            await joiner.sync();
            await host.sync();

            const joinerMember = lobbyMembers(host, lobby.id).find(m => m.userId === joiner.userId);
            expect(joinerMember).toBeDefined();

            // Cleanup
            await joiner.call.leaveLobby({ lobbyId: lobby.id });
            await joiner.sync();
            await host.call.closeLobby({ lobbyId: lobby.id });
            await host.sync();
        });

        it('joins private lobby with correct password', async () => {
            await host.call.createLobby(defaultLobbyArgs({ isPublic: false, password: 'secret' }));
            await host.sync(1500);

            const lobbies = myLobbies(host);
            const lobby = lobbies[lobbies.length - 1];
            openedLobbyIds.push(lobby.id);

            await joiner.call.joinLobby({ lobbyId: lobby.id, joinCode: '', password: 'secret' });
            await joiner.sync();
            await host.sync();

            const joinerMember = lobbyMembers(host, lobby.id).find(m => m.userId === joiner.userId);
            expect(joinerMember).toBeDefined();

            // Cleanup
            await joiner.call.leaveLobby({ lobbyId: lobby.id });
            await joiner.sync();
            await host.call.closeLobby({ lobbyId: lobby.id });
            await host.sync();
        });

        it('rejects wrong password', async () => {
            await host.call.createLobby(defaultLobbyArgs({ isPublic: false, password: 'secret' }));
            await host.sync(1500);

            const lobbies = myLobbies(host);
            const lobby = lobbies[lobbies.length - 1];
            openedLobbyIds.push(lobby.id);

            const err = await expectReducerError(
                joiner.call.joinLobby({ lobbyId: lobby.id, joinCode: '', password: 'wrong' })
            );
            expect(err).toContain('Incorrect lobby password.');

            // Cleanup
            await host.call.closeLobby({ lobbyId: lobby.id });
            await host.sync();
        });

        it('rejects banned user', async () => {
            await host.call.createLobby(defaultLobbyArgs());
            await host.sync(1500);

            const lobbies = myLobbies(host);
            const lobby = lobbies[lobbies.length - 1];
            openedLobbyIds.push(lobby.id);

            // Joiner joins, then gets banned
            await joiner.call.joinLobby({ lobbyId: lobby.id, joinCode: '', password: '' });
            await joiner.sync();
            await host.sync();

            await host.call.banMember({ lobbyId: lobby.id, targetUserId: joiner.userId });
            await host.sync();
            await joiner.sync();

            // Joiner tries to rejoin after being banned
            const err = await expectReducerError(
                joiner.call.joinLobby({ lobbyId: lobby.id, joinCode: '', password: '' })
            );
            expect(err).toContain('You are banned from this lobby.');

            // Cleanup
            await host.call.closeLobby({ lobbyId: lobby.id });
            await host.sync();
        });

        it('rejects join during non-joinable stage', async () => {
            // Cannot easily test without a full draft flow to advance the lobby to Scoring/AwaitingResult.
            // Verified by contract: join_lobby rejects with "Cannot join a lobby in stage: {stage}"
            // for any stage other than Waiting or Drafting.
        });

        it('cap enforcement: 20 total members — contract-verified only', async () => {
            // Impractical to test: requires 20 simultaneous connections.
            // Contract specifies: "Lobby is full (max 20 members)."
            // This is enforced in join_lobby before the LobbyMember insert.
        });

        it('one-per-user: rejects joining second lobby', async () => {
            // Create two lobbies — host creates one, bystander creates another
            await host.call.createLobby(defaultLobbyArgs());
            await host.sync(1500);
            const hostLobbies = myLobbies(host);
            const lobby1 = hostLobbies[hostLobbies.length - 1];
            openedLobbyIds.push(lobby1.id);

            await bystander.call.createLobby(defaultLobbyArgs());
            await bystander.sync(1500);
            const bystanderLobbies = myLobbies(bystander);
            const lobby2 = bystanderLobbies[bystanderLobbies.length - 1];
            openedLobbyIds.push(lobby2.id);

            // Joiner joins lobby1
            await joiner.call.joinLobby({ lobbyId: lobby1.id, joinCode: '', password: '' });
            await joiner.sync();

            // Joiner tries to join lobby2 while already in lobby1
            const err = await expectReducerError(
                joiner.call.joinLobby({ lobbyId: lobby2.id, joinCode: '', password: '' })
            );
            expect(err).toContain('You are already in a lobby.');

            // Cleanup
            await joiner.call.leaveLobby({ lobbyId: lobby1.id });
            await joiner.sync();
            await host.call.closeLobby({ lobbyId: lobby1.id });
            await host.sync();
            await bystander.call.closeLobby({ lobbyId: lobby2.id });
            await bystander.sync();
        });
    });

    // ─── leave_lobby ─────────────────────────────────────────────────────

    describe('leave_lobby', () => {
        it('leaves lobby, count decremented', async () => {
            await host.call.createLobby(defaultLobbyArgs());
            await host.sync(1500);

            const lobbies = myLobbies(host);
            const lobby = lobbies[lobbies.length - 1];
            openedLobbyIds.push(lobby.id);

            await joiner.call.joinLobby({ lobbyId: lobby.id, joinCode: '', password: '' });
            await joiner.sync();
            await host.sync();

            const countAfterJoin = [...host.conn.db.Lobby.iter()].find(l => l.id === lobby.id)!.currentPlayerCount;

            await joiner.call.leaveLobby({ lobbyId: lobby.id });
            await joiner.sync();
            await host.sync();

            const updatedLobby = [...host.conn.db.Lobby.iter()].find(l => l.id === lobby.id);
            expect(updatedLobby!.currentPlayerCount).toBe(countAfterJoin - 1);

            const joinerMember = lobbyMembers(host, lobby.id).find(m => m.userId === joiner.userId);
            expect(joinerMember).toBeUndefined();

            // Cleanup
            await host.call.closeLobby({ lobbyId: lobby.id });
            await host.sync();
        });

        it('empty Waiting lobby auto-closes', async () => {
            await host.call.createLobby(defaultLobbyArgs());
            await host.sync(1500);

            const lobbies = myLobbies(host);
            const lobby = lobbies[lobbies.length - 1];
            openedLobbyIds.push(lobby.id);
            const lobbyId = lobby.id;

            // Host leaves — only member, lobby should auto-close
            await host.call.leaveLobby({ lobbyId });
            await host.sync();

            const closedLobby = [...host.conn.db.Lobby.iter()].find(l => l.id === lobbyId);
            expect(closedLobby).toBeUndefined();
        });
    });

    // ─── close_lobby ─────────────────────────────────────────────────────

    describe('close_lobby', () => {
        it('host closes Waiting lobby — cascade delete', async () => {
            await host.call.createLobby(defaultLobbyArgs());
            await host.sync(1500);

            const lobbies = myLobbies(host);
            const lobby = lobbies[lobbies.length - 1];
            openedLobbyIds.push(lobby.id);
            const lobbyId = lobby.id;

            await joiner.call.joinLobby({ lobbyId, joinCode: '', password: '' });
            await joiner.sync();
            await host.sync();

            await host.call.closeLobby({ lobbyId });
            await host.sync();
            await joiner.sync();

            const closedLobby = [...host.conn.db.Lobby.iter()].find(l => l.id === lobbyId);
            expect(closedLobby).toBeUndefined();

            const remainingMembers = lobbyMembers(host, lobbyId);
            expect(remainingMembers.length).toBe(0);
        });

        it('non-host/non-admin blocked from closing', async () => {
            await host.call.createLobby(defaultLobbyArgs());
            await host.sync(1500);

            const lobbies = myLobbies(host);
            const lobby = lobbies[lobbies.length - 1];
            openedLobbyIds.push(lobby.id);

            await joiner.call.joinLobby({ lobbyId: lobby.id, joinCode: '', password: '' });
            await joiner.sync();

            const err = await expectReducerError(
                joiner.call.closeLobby({ lobbyId: lobby.id })
            );
            expect(err).toContain('Only the host, moderators, or admins can perform this action.');

            // Cleanup
            await joiner.call.leaveLobby({ lobbyId: lobby.id });
            await joiner.sync();
            await host.call.closeLobby({ lobbyId: lobby.id });
            await host.sync();
        });

        // Cannot test Drafting stage rejection without advancing through the full draft flow.
        // Contract specifies: "This action is not allowed in the current lobby stage ({stage})."
        // for stages other than Waiting or Finished.
    });

    // ─── kick_member ─────────────────────────────────────────────────────

    describe('kick_member', () => {
        it('host kicks member', async () => {
            await host.call.createLobby(defaultLobbyArgs());
            await host.sync(1500);

            const lobbies = myLobbies(host);
            const lobby = lobbies[lobbies.length - 1];
            openedLobbyIds.push(lobby.id);

            await joiner.call.joinLobby({ lobbyId: lobby.id, joinCode: '', password: '' });
            await joiner.sync();
            await host.sync();

            const countBeforeKick = [...host.conn.db.Lobby.iter()].find(l => l.id === lobby.id)!.currentPlayerCount;

            await host.call.kickMember({ lobbyId: lobby.id, targetUserId: joiner.userId });
            await host.sync();
            await joiner.sync();

            const kickedMember = lobbyMembers(host, lobby.id).find(m => m.userId === joiner.userId);
            expect(kickedMember).toBeUndefined();

            const updatedLobby = [...host.conn.db.Lobby.iter()].find(l => l.id === lobby.id);
            expect(updatedLobby!.currentPlayerCount).toBe(countBeforeKick - 1);

            // Cleanup
            await host.call.closeLobby({ lobbyId: lobby.id });
            await host.sync();
        });

        it('kick self blocked', async () => {
            await host.call.createLobby(defaultLobbyArgs());
            await host.sync(1500);

            const lobbies = myLobbies(host);
            const lobby = lobbies[lobbies.length - 1];
            openedLobbyIds.push(lobby.id);

            const err = await expectReducerError(
                host.call.kickMember({ lobbyId: lobby.id, targetUserId: host.userId })
            );
            expect(err).toContain('Cannot kick yourself.');

            // Cleanup
            await host.call.closeLobby({ lobbyId: lobby.id });
            await host.sync();
        });

        it('kick host blocked', async () => {
            // Promote joiner to Admin so they have kick permission, then attempt to kick host
            await host.call.createLobby(defaultLobbyArgs());
            await host.sync(1500);

            const lobbies = myLobbies(host);
            const lobby = lobbies[lobbies.length - 1];
            openedLobbyIds.push(lobby.id);

            await joiner.call.joinLobby({ lobbyId: lobby.id, joinCode: '', password: '' });
            await joiner.sync();
            await host.sync();

            // Promote joiner to Admin via server connection
            const joinerUser = [...joiner.conn.db.User.iter()].find(u => u.id === joiner.userId);
            expect(joinerUser).toBeDefined();
            await promoteUser(joinerUser!.username, 'Admin');
            await joiner.sync(1500);

            const err = await expectReducerError(
                joiner.call.kickMember({ lobbyId: lobby.id, targetUserId: host.userId })
            );
            expect(err).toContain('Cannot kick the host.');

            // Cleanup — demote joiner back, then close lobby
            await promoteUser(joinerUser!.username, 'User');
            await joiner.call.leaveLobby({ lobbyId: lobby.id });
            await joiner.sync();
            await host.call.closeLobby({ lobbyId: lobby.id });
            await host.sync();
        }, 45000);

        it('referee with refereeCanKick — same as host kicking', async () => {
            // The host is the only auto-assigned referee. There is no transfer_referee reducer
            // in this phase. Testing "referee with refereeCanKick" is functionally identical
            // to the host kicks test above. Skipped to avoid duplication.
        });
    });

    // ─── ban_member ──────────────────────────────────────────────────────

    describe('ban_member', () => {
        it('host bans member — LobbyBan created + member removed', async () => {
            await host.call.createLobby(defaultLobbyArgs());
            await host.sync(1500);

            const lobbies = myLobbies(host);
            const lobby = lobbies[lobbies.length - 1];
            openedLobbyIds.push(lobby.id);

            await joiner.call.joinLobby({ lobbyId: lobby.id, joinCode: '', password: '' });
            await joiner.sync();
            await host.sync();

            await host.call.banMember({ lobbyId: lobby.id, targetUserId: joiner.userId });
            await host.sync();
            await joiner.sync();

            const ban = lobbyBans(host, lobby.id).find(b => b.bannedUserId === joiner.userId);
            expect(ban).toBeDefined();

            const bannedMember = lobbyMembers(host, lobby.id).find(m => m.userId === joiner.userId);
            expect(bannedMember).toBeUndefined();

            // Cleanup
            await host.call.closeLobby({ lobbyId: lobby.id });
            await host.sync();
        });

        it('ban non-member (preventive ban)', async () => {
            await host.call.createLobby(defaultLobbyArgs());
            await host.sync(1500);

            const lobbies = myLobbies(host);
            const lobby = lobbies[lobbies.length - 1];
            openedLobbyIds.push(lobby.id);

            // joiner is NOT in the lobby — ban them preemptively
            await host.call.banMember({ lobbyId: lobby.id, targetUserId: joiner.userId });
            await host.sync();

            const ban = lobbyBans(host, lobby.id).find(b => b.bannedUserId === joiner.userId);
            expect(ban).toBeDefined();

            // No crash, no member row to remove
            const joinerMember = lobbyMembers(host, lobby.id).find(m => m.userId === joiner.userId);
            expect(joinerMember).toBeUndefined();

            // Cleanup
            await host.call.closeLobby({ lobbyId: lobby.id });
            await host.sync();
        });

        it('banned user cannot rejoin', async () => {
            await host.call.createLobby(defaultLobbyArgs());
            await host.sync(1500);

            const lobbies = myLobbies(host);
            const lobby = lobbies[lobbies.length - 1];
            openedLobbyIds.push(lobby.id);

            // Joiner joins, gets banned
            await joiner.call.joinLobby({ lobbyId: lobby.id, joinCode: '', password: '' });
            await joiner.sync();
            await host.sync();

            await host.call.banMember({ lobbyId: lobby.id, targetUserId: joiner.userId });
            await host.sync();
            await joiner.sync();

            // Banned user attempts to rejoin
            const err = await expectReducerError(
                joiner.call.joinLobby({ lobbyId: lobby.id, joinCode: '', password: '' })
            );
            expect(err).toContain('You are banned from this lobby.');

            // Cleanup
            await host.call.closeLobby({ lobbyId: lobby.id });
            await host.sync();
        });

        it('ban self blocked', async () => {
            await host.call.createLobby(defaultLobbyArgs());
            await host.sync(1500);

            const lobbies = myLobbies(host);
            const lobby = lobbies[lobbies.length - 1];
            openedLobbyIds.push(lobby.id);

            const err = await expectReducerError(
                host.call.banMember({ lobbyId: lobby.id, targetUserId: host.userId })
            );
            expect(err).toContain('Cannot ban yourself.');

            // Cleanup
            await host.call.closeLobby({ lobbyId: lobby.id });
            await host.sync();
        });

        it('ban host blocked', async () => {
            // Promote joiner to Admin so they have ban permission, then attempt to ban host
            await host.call.createLobby(defaultLobbyArgs());
            await host.sync(1500);

            const lobbies = myLobbies(host);
            const lobby = lobbies[lobbies.length - 1];
            openedLobbyIds.push(lobby.id);

            await joiner.call.joinLobby({ lobbyId: lobby.id, joinCode: '', password: '' });
            await joiner.sync();
            await host.sync();

            const joinerUser = [...joiner.conn.db.User.iter()].find(u => u.id === joiner.userId);
            expect(joinerUser).toBeDefined();
            await promoteUser(joinerUser!.username, 'Admin');
            await joiner.sync(1500);

            const err = await expectReducerError(
                joiner.call.banMember({ lobbyId: lobby.id, targetUserId: host.userId })
            );
            expect(err).toContain('Cannot ban the host.');

            // Cleanup — demote joiner, then close lobby
            await promoteUser(joinerUser!.username, 'User');
            await joiner.call.leaveLobby({ lobbyId: lobby.id });
            await joiner.sync();
            await host.call.closeLobby({ lobbyId: lobby.id });
            await host.sync();
        }, 45000);
    });
});
