/**
 * Integration tests for lobby settings, team slot, ready-up, and captain reducers.
 *
 * Covers:
 * - update_lobby_settings: field changes, isConfirmed reset, permission guard, password upsert/delete
 * - set_team_slot: self-move, host moves other, coach assignment, cap enforcement, isConfirmed reset
 * - confirm_ready / unconfirm_ready: set/clear isConfirmed, non-member rejection
 * - set_captain: assign, demote previous, spectator/coach rejection, permission guard
 *
 * Requires: SPACETIMEDB_SERVER_TOKEN in .env.local (post-publish bootstrap)
 *
 * Contract: docs/lobby/contract.md — Lobby Settings & Slots scenarios
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
    createTestHarness,
    createVerifiedTestHarness,
    expectReducerError,
    type TestHarness,
} from '../../shared/connection';
import { defaultLobbyArgs, defaultSettingsArgs } from '../../shared/helpers/lobbies';
import { myLobbies, lobbyMembers } from '../../shared/helpers/queries';

// ─── Helpers ────────────────────────────────────────────────────────────────

function getMember(h: TestHarness, lobbyId: number, userId: number) {
    return lobbyMembers(h, lobbyId).find(m => m.userId === userId);
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Lobby Settings, Slots & Ready', () => {
    let host: TestHarness;
    let member1: TestHarness;
    let member2: TestHarness;
    let guest: TestHarness;

    beforeAll(async () => {
        host = await createVerifiedTestHarness();
        member1 = await createVerifiedTestHarness();
        member2 = await createVerifiedTestHarness();
        guest = await createTestHarness();

        await host.sync();
        await member1.sync();
        await member2.sync();
        await guest.sync();
    }, 30000);

    afterAll(async () => {
        await host?.disconnect();
        await member1?.disconnect();
        await member2?.disconnect();
        await guest?.disconnect();
    });

    // ─── update_lobby_settings ───────────────────────────────────────────

    describe('update_lobby_settings', () => {
        it('updates settings in Waiting stage', async () => {
            await host.call.createLobby(defaultLobbyArgs({ draftMode: { tag: 'Classic' as const, value: {} } }));
            await host.sync(1500);

            const lobbies = myLobbies(host);
            const lobby = lobbies[lobbies.length - 1];

            await host.call.updateLobbySettings(
                defaultSettingsArgs(lobby.id, { draftMode: { tag: 'Auction' as const, value: {} }, standardTurnSeconds: 90 })
            );
            await host.sync();

            const updated = [...host.conn.db.Lobby.iter()].find(l => l.id === lobby.id);
            expect(updated).toBeDefined();
            expect(updated!.draftMode.tag).toBe('Auction');
            expect(updated!.standardTurnSeconds).toBe(90);

            // Cleanup
            await host.call.closeLobby({ lobbyId: lobby.id });
            await host.sync();
        });

        it('resets all members isConfirmed on settings change', async () => {
            await host.call.createLobby(defaultLobbyArgs());
            await host.sync(1500);

            const lobbies = myLobbies(host);
            const lobby = lobbies[lobbies.length - 1];

            await member1.call.joinLobby({ lobbyId: lobby.id, joinCode: '', password: '' });
            await member1.sync();
            await host.sync();

            // member1 confirms ready
            await member1.call.confirmReady({ lobbyId: lobby.id });
            await member1.sync();
            await host.sync();

            const memberBefore = getMember(host, lobby.id, member1.userId);
            expect(memberBefore).toBeDefined();
            expect(memberBefore!.isConfirmed).toBe(true);

            // Host updates settings
            await host.call.updateLobbySettings(defaultSettingsArgs(lobby.id, { standardTurnSeconds: 90 }));
            await host.sync();
            await member1.sync();

            const memberAfter = getMember(host, lobby.id, member1.userId);
            expect(memberAfter).toBeDefined();
            expect(memberAfter!.isConfirmed).toBe(false);

            // Cleanup
            await member1.call.leaveLobby({ lobbyId: lobby.id });
            await member1.sync();
            await host.call.closeLobby({ lobbyId: lobby.id });
            await host.sync();
        });

        it('non-host/non-admin blocked', async () => {
            await host.call.createLobby(defaultLobbyArgs());
            await host.sync(1500);

            const lobbies = myLobbies(host);
            const lobby = lobbies[lobbies.length - 1];

            await member1.call.joinLobby({ lobbyId: lobby.id, joinCode: '', password: '' });
            await member1.sync();
            await host.sync();

            const err = await expectReducerError(
                member1.call.updateLobbySettings(defaultSettingsArgs(lobby.id))
            );
            expect(err).toContain('Only the host, moderators, or admins can perform this action.');

            // Cleanup
            await member1.call.leaveLobby({ lobbyId: lobby.id });
            await member1.sync();
            await host.call.closeLobby({ lobbyId: lobby.id });
            await host.sync();
        });

        it('password upsert: public→private adds password', async () => {
            await host.call.createLobby(defaultLobbyArgs({ isPublic: true }));
            await host.sync(1500);

            const lobbies = myLobbies(host);
            const lobby = lobbies[lobbies.length - 1];

            // Switch to private with a password
            await host.call.updateLobbySettings(
                defaultSettingsArgs(lobby.id, { isPublic: false, password: 'newsecret' })
            );
            await host.sync();

            const updated = [...host.conn.db.Lobby.iter()].find(l => l.id === lobby.id);
            expect(updated).toBeDefined();
            expect(updated!.isPublic).toBe(false);

            // Joining with wrong password is rejected
            const errWrong = await expectReducerError(
                member1.call.joinLobby({ lobbyId: lobby.id, joinCode: '', password: 'wrong' })
            );
            expect(errWrong).toContain('Incorrect lobby password.');

            // Joining with correct password succeeds
            await member1.call.joinLobby({ lobbyId: lobby.id, joinCode: '', password: 'newsecret' });
            await member1.sync();
            await host.sync();

            const joinerMember = getMember(host, lobby.id, member1.userId);
            expect(joinerMember).toBeDefined();

            // Cleanup
            await member1.call.leaveLobby({ lobbyId: lobby.id });
            await member1.sync();
            await host.call.closeLobby({ lobbyId: lobby.id });
            await host.sync();
        });

        it('password delete: private→public removes password', async () => {
            await host.call.createLobby(defaultLobbyArgs({ isPublic: false, password: 'secret' }));
            await host.sync(1500);

            const lobbies = myLobbies(host);
            const lobby = lobbies[lobbies.length - 1];

            // Switch to public (remove password)
            await host.call.updateLobbySettings(
                defaultSettingsArgs(lobby.id, { isPublic: true, password: '' })
            );
            await host.sync();

            const updated = [...host.conn.db.Lobby.iter()].find(l => l.id === lobby.id);
            expect(updated).toBeDefined();
            expect(updated!.isPublic).toBe(true);

            // New user joins without password — should succeed
            await member1.call.joinLobby({ lobbyId: lobby.id, joinCode: '', password: '' });
            await member1.sync();
            await host.sync();

            const joinerMember = getMember(host, lobby.id, member1.userId);
            expect(joinerMember).toBeDefined();

            // Cleanup
            await member1.call.leaveLobby({ lobbyId: lobby.id });
            await member1.sync();
            await host.call.closeLobby({ lobbyId: lobby.id });
            await host.sync();
        });
    });

    // ─── set_team_slot ───────────────────────────────────────────────────

    describe('set_team_slot', () => {
        it('self-move to BluePlayer', async () => {
            await host.call.createLobby(defaultLobbyArgs({ teamSize: 3 }));
            await host.sync(1500);

            const lobbies = myLobbies(host);
            const lobby = lobbies[lobbies.length - 1];

            await member1.call.joinLobby({ lobbyId: lobby.id, joinCode: '', password: '' });
            await member1.sync();
            await host.sync();

            await member1.call.setTeamSlot({
                lobbyId: lobby.id,
                targetUserId: member1.userId,
                lobbySlot: { tag: 'BluePlayer' as const },
            });
            await member1.sync();
            await host.sync();

            const m = getMember(host, lobby.id, member1.userId);
            expect(m).toBeDefined();
            expect(m!.lobbySlot.tag).toBe('BluePlayer');

            // Cleanup
            await member1.call.leaveLobby({ lobbyId: lobby.id });
            await member1.sync();
            await host.call.closeLobby({ lobbyId: lobby.id });
            await host.sync();
        });

        it('host moves other to RedPlayer', async () => {
            await host.call.createLobby(defaultLobbyArgs({ teamSize: 3 }));
            await host.sync(1500);

            const lobbies = myLobbies(host);
            const lobby = lobbies[lobbies.length - 1];

            await member1.call.joinLobby({ lobbyId: lobby.id, joinCode: '', password: '' });
            await member1.sync();
            await host.sync();

            await host.call.setTeamSlot({
                lobbyId: lobby.id,
                targetUserId: member1.userId,
                lobbySlot: { tag: 'RedPlayer' as const },
            });
            await host.sync();
            await member1.sync();

            const m = getMember(host, lobby.id, member1.userId);
            expect(m).toBeDefined();
            expect(m!.lobbySlot.tag).toBe('RedPlayer');

            // Cleanup
            await member1.call.leaveLobby({ lobbyId: lobby.id });
            await member1.sync();
            await host.call.closeLobby({ lobbyId: lobby.id });
            await host.sync();
        });

        it('coach assignment by host', async () => {
            await host.call.createLobby(defaultLobbyArgs({ teamSize: 3 }));
            await host.sync(1500);

            const lobbies = myLobbies(host);
            const lobby = lobbies[lobbies.length - 1];

            await member1.call.joinLobby({ lobbyId: lobby.id, joinCode: '', password: '' });
            await member1.sync();
            await host.sync();

            await host.call.setTeamSlot({
                lobbyId: lobby.id,
                targetUserId: member1.userId,
                lobbySlot: { tag: 'BlueCoach' as const },
            });
            await host.sync();
            await member1.sync();

            const m = getMember(host, lobby.id, member1.userId);
            expect(m).toBeDefined();
            expect(m!.lobbySlot.tag).toBe('BlueCoach');

            // Cleanup
            await member1.call.leaveLobby({ lobbyId: lobby.id });
            await member1.sync();
            await host.call.closeLobby({ lobbyId: lobby.id });
            await host.sync();
        });

        it('coach self-assignment blocked for non-host/non-referee', async () => {
            await host.call.createLobby(defaultLobbyArgs({ teamSize: 3 }));
            await host.sync(1500);

            const lobbies = myLobbies(host);
            const lobby = lobbies[lobbies.length - 1];

            await member1.call.joinLobby({ lobbyId: lobby.id, joinCode: '', password: '' });
            await member1.sync();
            await host.sync();

            // member1 is not host or referee — self-assigning to coach should fail
            const err = await expectReducerError(
                member1.call.setTeamSlot({
                    lobbyId: lobby.id,
                    targetUserId: member1.userId,
                    lobbySlot: { tag: 'BlueCoach' as const },
                })
            );
            expect(err).toContain('Only the lobby host or referee can assign the coach role.');

            // Cleanup
            await member1.call.leaveLobby({ lobbyId: lobby.id });
            await member1.sync();
            await host.call.closeLobby({ lobbyId: lobby.id });
            await host.sync();
        });

        it('team player cap enforcement', async () => {
            // teamSize=1 means only 1 player allowed per team
            await host.call.createLobby(defaultLobbyArgs({ teamSize: 1 }));
            await host.sync(1500);

            const lobbies = myLobbies(host);
            const lobby = lobbies[lobbies.length - 1];

            await member1.call.joinLobby({ lobbyId: lobby.id, joinCode: '', password: '' });
            await member1.sync();
            await host.sync();

            await member2.call.joinLobby({ lobbyId: lobby.id, joinCode: '', password: '' });
            await member2.sync();
            await host.sync();

            // member1 takes the single BluePlayer slot
            await member1.call.setTeamSlot({
                lobbyId: lobby.id,
                targetUserId: member1.userId,
                lobbySlot: { tag: 'BluePlayer' as const },
            });
            await member1.sync();
            await host.sync();

            // member2 tries to also take BluePlayer — should fail
            const err = await expectReducerError(
                member2.call.setTeamSlot({
                    lobbyId: lobby.id,
                    targetUserId: member2.userId,
                    lobbySlot: { tag: 'BluePlayer' as const },
                })
            );
            expect(err).toContain('Blue team is full (max 1 players).');

            // Cleanup
            await member1.call.leaveLobby({ lobbyId: lobby.id });
            await member1.sync();
            await member2.call.leaveLobby({ lobbyId: lobby.id });
            await member2.sync();
            await host.call.closeLobby({ lobbyId: lobby.id });
            await host.sync();
        });

        it('coach cap: duplicate coach blocked', async () => {
            await host.call.createLobby(defaultLobbyArgs({ teamSize: 3 }));
            await host.sync(1500);

            const lobbies = myLobbies(host);
            const lobby = lobbies[lobbies.length - 1];

            await member1.call.joinLobby({ lobbyId: lobby.id, joinCode: '', password: '' });
            await member1.sync();
            await host.sync();

            await member2.call.joinLobby({ lobbyId: lobby.id, joinCode: '', password: '' });
            await member2.sync();
            await host.sync();

            // Host assigns member1 as BlueCoach
            await host.call.setTeamSlot({
                lobbyId: lobby.id,
                targetUserId: member1.userId,
                lobbySlot: { tag: 'BlueCoach' as const },
            });
            await host.sync();

            // Host tries to assign member2 as BlueCoach — Blue already has a coach
            const err = await expectReducerError(
                host.call.setTeamSlot({
                    lobbyId: lobby.id,
                    targetUserId: member2.userId,
                    lobbySlot: { tag: 'BlueCoach' as const },
                })
            );
            expect(err).toContain('Blue team already has a coach.');

            // Cleanup
            await member1.call.leaveLobby({ lobbyId: lobby.id });
            await member1.sync();
            await member2.call.leaveLobby({ lobbyId: lobby.id });
            await member2.sync();
            await host.call.closeLobby({ lobbyId: lobby.id });
            await host.sync();
        });

        it('spectator cap: 12 spectators — contract-verified only', () => {
            // Impractical to test: requires 12+ simultaneous connections already in spectator slots.
            // Contract specifies: "Spectator slots are full (max 12)."
            // This is enforced in set_team_slot cap enforcement before the slot change.
        });

        it('set_team_slot resets isConfirmed', async () => {
            await host.call.createLobby(defaultLobbyArgs({ teamSize: 3 }));
            await host.sync(1500);

            const lobbies = myLobbies(host);
            const lobby = lobbies[lobbies.length - 1];

            await member1.call.joinLobby({ lobbyId: lobby.id, joinCode: '', password: '' });
            await member1.sync();
            await host.sync();

            // member1 moves to BluePlayer
            await member1.call.setTeamSlot({
                lobbyId: lobby.id,
                targetUserId: member1.userId,
                lobbySlot: { tag: 'BluePlayer' as const },
            });
            await member1.sync();
            await host.sync();

            // member1 confirms ready
            await member1.call.confirmReady({ lobbyId: lobby.id });
            await member1.sync();
            await host.sync();

            const memberConfirmed = getMember(host, lobby.id, member1.userId);
            expect(memberConfirmed).toBeDefined();
            expect(memberConfirmed!.isConfirmed).toBe(true);

            // member1 moves to a different slot
            await member1.call.setTeamSlot({
                lobbyId: lobby.id,
                targetUserId: member1.userId,
                lobbySlot: { tag: 'RedPlayer' as const },
            });
            await member1.sync();
            await host.sync();

            const memberAfterMove = getMember(host, lobby.id, member1.userId);
            expect(memberAfterMove).toBeDefined();
            expect(memberAfterMove!.lobbySlot.tag).toBe('RedPlayer');
            expect(memberAfterMove!.isConfirmed).toBe(false);

            // Cleanup
            await member1.call.leaveLobby({ lobbyId: lobby.id });
            await member1.sync();
            await host.call.closeLobby({ lobbyId: lobby.id });
            await host.sync();
        });
    });

    // ─── confirm_ready / unconfirm_ready ────────────────────────────────

    describe('confirm_ready / unconfirm_ready', () => {
        let sharedLobbyId: number;

        beforeAll(async () => {
            await host.call.createLobby(defaultLobbyArgs());
            await host.sync(1500);

            const lobbies = myLobbies(host);
            const lobby = lobbies[lobbies.length - 1];
            sharedLobbyId = lobby.id;

            await member1.call.joinLobby({ lobbyId: sharedLobbyId, joinCode: '', password: '' });
            await member1.sync();
            await host.sync();
        }, 30000);

        afterAll(async () => {
            await member1.call.leaveLobby({ lobbyId: sharedLobbyId });
            await member1.sync();
            await host.call.closeLobby({ lobbyId: sharedLobbyId });
            await host.sync();
        });

        it('confirm_ready sets isConfirmed=true', async () => {
            await member1.call.confirmReady({ lobbyId: sharedLobbyId });
            await member1.sync();
            await host.sync();

            const m = getMember(host, sharedLobbyId, member1.userId);
            expect(m).toBeDefined();
            expect(m!.isConfirmed).toBe(true);
        });

        it('unconfirm_ready clears isConfirmed', async () => {
            await member1.call.unconfirmReady({ lobbyId: sharedLobbyId });
            await member1.sync();
            await host.sync();

            const m = getMember(host, sharedLobbyId, member1.userId);
            expect(m).toBeDefined();
            expect(m!.isConfirmed).toBe(false);
        });

        it('confirm_ready: non-member rejected', async () => {
            // member2 is not in the shared lobby
            const err = await expectReducerError(
                member2.call.confirmReady({ lobbyId: sharedLobbyId })
            );
            expect(err).toContain('You are not a member of this lobby.');
        });
    });

    // ─── set_captain ─────────────────────────────────────────────────────

    describe('set_captain', () => {
        it('host assigns captain to BluePlayer', async () => {
            await host.call.createLobby(defaultLobbyArgs({ teamSize: 1 }));
            await host.sync(1500);

            const lobbies = myLobbies(host);
            const lobby = lobbies[lobbies.length - 1];

            await member1.call.joinLobby({ lobbyId: lobby.id, joinCode: '', password: '' });
            await member1.sync();
            await host.sync();

            // member1 moves to BluePlayer
            await member1.call.setTeamSlot({
                lobbyId: lobby.id,
                targetUserId: member1.userId,
                lobbySlot: { tag: 'BluePlayer' as const },
            });
            await member1.sync();
            await host.sync();

            // Host assigns captain
            await host.call.setCaptain({ lobbyId: lobby.id, targetUserId: member1.userId });
            await host.sync();
            await member1.sync();

            const m = getMember(host, lobby.id, member1.userId);
            expect(m).toBeDefined();
            expect(m!.isCaptain).toBe(true);

            // Cleanup
            await member1.call.leaveLobby({ lobbyId: lobby.id });
            await member1.sync();
            await host.call.closeLobby({ lobbyId: lobby.id });
            await host.sync();
        });

        it('demotes existing captain when new one assigned', async () => {
            // teamSize=3 so two players can occupy BluePlayer on the same team
            await host.call.createLobby(defaultLobbyArgs({ teamSize: 3 }));
            await host.sync(1500);

            const lobbies = myLobbies(host);
            const lobby = lobbies[lobbies.length - 1];

            await member1.call.joinLobby({ lobbyId: lobby.id, joinCode: '', password: '' });
            await member1.sync();
            await host.sync();

            await member2.call.joinLobby({ lobbyId: lobby.id, joinCode: '', password: '' });
            await member2.sync();
            await host.sync();

            // Both members move to BluePlayer
            await member1.call.setTeamSlot({
                lobbyId: lobby.id,
                targetUserId: member1.userId,
                lobbySlot: { tag: 'BluePlayer' as const },
            });
            await member1.sync();
            await host.sync();

            await member2.call.setTeamSlot({
                lobbyId: lobby.id,
                targetUserId: member2.userId,
                lobbySlot: { tag: 'BluePlayer' as const },
            });
            await member2.sync();
            await host.sync();

            // Host assigns member1 as captain first
            await host.call.setCaptain({ lobbyId: lobby.id, targetUserId: member1.userId });
            await host.sync();

            const m1First = getMember(host, lobby.id, member1.userId);
            expect(m1First!.isCaptain).toBe(true);

            // Host now assigns member2 as captain — member1 should be demoted
            await host.call.setCaptain({ lobbyId: lobby.id, targetUserId: member2.userId });
            await host.sync();
            await member1.sync();
            await member2.sync();

            const m1After = getMember(host, lobby.id, member1.userId);
            const m2After = getMember(host, lobby.id, member2.userId);
            expect(m1After!.isCaptain).toBe(false);
            expect(m2After!.isCaptain).toBe(true);

            // Cleanup
            await member1.call.leaveLobby({ lobbyId: lobby.id });
            await member1.sync();
            await member2.call.leaveLobby({ lobbyId: lobby.id });
            await member2.sync();
            await host.call.closeLobby({ lobbyId: lobby.id });
            await host.sync();
        });

        it('spectator rejected as captain', async () => {
            await host.call.createLobby(defaultLobbyArgs({ teamSize: 1 }));
            await host.sync(1500);

            const lobbies = myLobbies(host);
            const lobby = lobbies[lobbies.length - 1];

            await member1.call.joinLobby({ lobbyId: lobby.id, joinCode: '', password: '' });
            await member1.sync();
            await host.sync();

            // member1 joins as Spectator (default) — host tries to set as captain
            const err = await expectReducerError(
                host.call.setCaptain({ lobbyId: lobby.id, targetUserId: member1.userId })
            );
            expect(err).toContain('Captain must be a team member (Blue or Red), not a spectator.');

            // Cleanup
            await member1.call.leaveLobby({ lobbyId: lobby.id });
            await member1.sync();
            await host.call.closeLobby({ lobbyId: lobby.id });
            await host.sync();
        });

        it('coach rejected as captain', async () => {
            await host.call.createLobby(defaultLobbyArgs({ teamSize: 1 }));
            await host.sync(1500);

            const lobbies = myLobbies(host);
            const lobby = lobbies[lobbies.length - 1];

            await member1.call.joinLobby({ lobbyId: lobby.id, joinCode: '', password: '' });
            await member1.sync();
            await host.sync();

            // Host assigns member1 as BlueCoach
            await host.call.setTeamSlot({
                lobbyId: lobby.id,
                targetUserId: member1.userId,
                lobbySlot: { tag: 'BlueCoach' as const },
            });
            await host.sync();

            // Host tries to set the coach as captain
            const err = await expectReducerError(
                host.call.setCaptain({ lobbyId: lobby.id, targetUserId: member1.userId })
            );
            expect(err).toContain('A coach cannot be assigned as captain.');

            // Cleanup
            await member1.call.leaveLobby({ lobbyId: lobby.id });
            await member1.sync();
            await host.call.closeLobby({ lobbyId: lobby.id });
            await host.sync();
        });

        it('non-host/non-admin/non-referee blocked', async () => {
            await host.call.createLobby(defaultLobbyArgs({ teamSize: 3 }));
            await host.sync(1500);

            const lobbies = myLobbies(host);
            const lobby = lobbies[lobbies.length - 1];

            await member1.call.joinLobby({ lobbyId: lobby.id, joinCode: '', password: '' });
            await member1.sync();
            await host.sync();

            await member2.call.joinLobby({ lobbyId: lobby.id, joinCode: '', password: '' });
            await member2.sync();
            await host.sync();

            // Move member1 to BluePlayer so there is a valid captain target
            await member1.call.setTeamSlot({
                lobbyId: lobby.id,
                targetUserId: member1.userId,
                lobbySlot: { tag: 'BluePlayer' as const },
            });
            await member1.sync();
            await host.sync();

            // member2 is a regular member — calling setCaptain should be blocked
            const err = await expectReducerError(
                member2.call.setCaptain({ lobbyId: lobby.id, targetUserId: member1.userId })
            );
            expect(err).toContain('Only the host, an authorized referee, or an admin can assign captains.');

            // Cleanup
            await member1.call.leaveLobby({ lobbyId: lobby.id });
            await member1.sync();
            await member2.call.leaveLobby({ lobbyId: lobby.id });
            await member2.sync();
            await host.call.closeLobby({ lobbyId: lobby.id });
            await host.sync();
        });
    });
});
