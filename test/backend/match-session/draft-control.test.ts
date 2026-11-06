/**
 * Integration tests for cross-cutting draft control guards.
 *
 * Covers:
 * - coach guard: coaches blocked from pick and ban actions
 * - captain enforcement: only team captain can pick or ban
 * - refereeCanUndo guard: undo allowed/blocked based on lobby setting
 * - pause limits: players limited to 3 pauses per team; referees unlimited
 *
 * Applies to both Classic and Auction modes (guards share the same codepath).
 *
 * Requires: SPACETIMEDB_SERVER_TOKEN in .env.local (post-publish bootstrap)
 *
 * Contract: docs/match-session/contract.md — Match Session (Draft System)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
    createVerifiedTestHarness,
    expectReducerError,
    type TestHarness,
} from '../../shared/connection';
import { defaultLobbyArgs } from '../../shared/helpers/lobbies';
import { startDraftAndSync } from '../../shared/helpers/drafts';
import { latestLobby } from '../../shared/helpers/queries';

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Get MatchSession for a lobby */
function getSession(h: TestHarness, lobbyId: number) {
    return [...h.conn.db.MatchSession.iter()].find(s => s.lobbyId === lobbyId);
}

/** Get MatchSessionSteps for a lobby, sorted by sequence */
function getSteps(h: TestHarness, lobbyId: number) {
    return [...h.conn.db.MatchSessionStep.iter()]
        .filter(s => s.lobbyId === lobbyId)
        .sort((a, b) => a.sequence - b.sequence);
}

/** Set up a minimal lobby: host creates, blue+red join and confirm (teamSize=1 by default) */
async function setupDraftLobby(
    host: TestHarness,
    blue: TestHarness,
    red: TestHarness,
    lobbyOverrides: Record<string, unknown> = {},
) {
    await host.call.createLobby(defaultLobbyArgs(lobbyOverrides));
    await host.sync(1500);
    const lobby = latestLobby(host);

    await blue.call.joinLobby({ lobbyId: lobby.id, joinCode: '', password: '' });
    await blue.sync();
    await blue.call.setTeamSlot({ lobbyId: lobby.id, targetUserId: blue.userId, lobbySlot: { tag: 'BluePlayer' as const } });
    await blue.sync();

    await red.call.joinLobby({ lobbyId: lobby.id, joinCode: '', password: '' });
    await red.sync();
    await red.call.setTeamSlot({ lobbyId: lobby.id, targetUserId: red.userId, lobbySlot: { tag: 'RedPlayer' as const } });
    await red.sync();

    await blue.call.confirmReady({ lobbyId: lobby.id });
    await blue.sync();
    await red.call.confirmReady({ lobbyId: lobby.id });
    await red.sync();
    await host.sync();

    return lobby.id;
}

/** Start draft and sync all harnesses */

/** Cleanup: all members leave a lobby (best-effort, no-throw) */
/**
 * Leave-all cleanup: every harness (including host) calls leaveLobby.
 * Leave-only semantic relies on empty-lobby auto-close; differs from shared
 * cleanupLobby (host closes after members leave).
 */
async function leaveAll(lobbyId: number, ...harnesses: TestHarness[]) {
    for (const h of harnesses) {
        try {
            await h.call.leaveLobby({ lobbyId });
            await h.sync(1000);
        } catch {
            // Ignore — member may not be in the lobby
        }
    }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Draft Controls', () => {

    // ─── coach guard ─────────────────────────────────────────────────────

    describe('coach guard', () => {
        let host: TestHarness;
        let bluePlayer: TestHarness;
        let blueCoach: TestHarness;
        let redPlayer: TestHarness;

        beforeAll(async () => {
            host = await createVerifiedTestHarness();
            bluePlayer = await createVerifiedTestHarness();
            blueCoach = await createVerifiedTestHarness();
            redPlayer = await createVerifiedTestHarness();
            await host.sync();
            await bluePlayer.sync();
            await blueCoach.sync();
            await redPlayer.sync();
        }, 120000);

        afterAll(async () => {
            await host?.disconnect();
            await bluePlayer?.disconnect();
            await blueCoach?.disconnect();
            await redPlayer?.disconnect();
        });

        it('coach cannot pick character', async () => {
            // teamSize=3 allows coach slots alongside players
            await host.call.createLobby(defaultLobbyArgs({ teamSize: 3, banMode: { tag: 'None' as const, value: {} } }));
            await host.sync(1500);
            const lobby = latestLobby(host);
            const lobbyId = lobby.id;

            // Blue player joins and takes BluePlayer slot
            await bluePlayer.call.joinLobby({ lobbyId, joinCode: '', password: '' });
            await bluePlayer.sync();
            await bluePlayer.call.setTeamSlot({ lobbyId, targetUserId: bluePlayer.userId, lobbySlot: { tag: 'BluePlayer' as const } });
            await bluePlayer.sync();

            // Blue coach joins and takes BlueCoach slot (assigned by host)
            await blueCoach.call.joinLobby({ lobbyId, joinCode: '', password: '' });
            await blueCoach.sync();
            await host.call.setTeamSlot({ lobbyId, targetUserId: blueCoach.userId, lobbySlot: { tag: 'BlueCoach' as const } });
            await host.sync();
            await blueCoach.sync();

            // Red player joins
            await redPlayer.call.joinLobby({ lobbyId, joinCode: '', password: '' });
            await redPlayer.sync();
            await redPlayer.call.setTeamSlot({ lobbyId, targetUserId: redPlayer.userId, lobbySlot: { tag: 'RedPlayer' as const } });
            await redPlayer.sync();

            // Coaches don't need to confirm — only non-coach players confirm
            await bluePlayer.call.confirmReady({ lobbyId });
            await bluePlayer.sync();
            await redPlayer.call.confirmReady({ lobbyId });
            await redPlayer.sync();
            await host.sync();

            // Start draft (BanMode=None — first turn is Blue pick)
            await host.call.startDraft({ lobbyId });
            await host.sync(1500);
            await blueCoach.sync(1500);

            // Verify it is Blue's pick turn
            const session = getSession(host, lobbyId);
            expect(session).toBeDefined();
            expect(session!.draftSequence[session!.turnIndex].actionRequired.tag).toBe('Pick');
            expect(session!.draftSequence[session!.turnIndex].teamTurn.tag).toBe('Blue');

            // Blue coach tries to pick — coach guard fires before team turn check
            const err = await expectReducerError(
                blueCoach.call.pickCharacter({ lobbyId, characterName: 'acheron', eidolon: 0 })
            );
            expect(err).toContain('Coaches cannot perform draft actions.');

            await leaveAll(lobbyId, bluePlayer, blueCoach, redPlayer, host);
        }, 60000);

        it('coach cannot ban character', async () => {
            // BanMode=Four — first turn is Blue ban
            await host.call.createLobby(defaultLobbyArgs({ teamSize: 3, banMode: { tag: 'Four' as const, value: {} } }));
            await host.sync(1500);
            const lobby = latestLobby(host);
            const lobbyId = lobby.id;

            // Blue player
            await bluePlayer.call.joinLobby({ lobbyId, joinCode: '', password: '' });
            await bluePlayer.sync();
            await bluePlayer.call.setTeamSlot({ lobbyId, targetUserId: bluePlayer.userId, lobbySlot: { tag: 'BluePlayer' as const } });
            await bluePlayer.sync();

            // Blue coach (assigned by host)
            await blueCoach.call.joinLobby({ lobbyId, joinCode: '', password: '' });
            await blueCoach.sync();
            await host.call.setTeamSlot({ lobbyId, targetUserId: blueCoach.userId, lobbySlot: { tag: 'BlueCoach' as const } });
            await host.sync();
            await blueCoach.sync();

            // Red player
            await redPlayer.call.joinLobby({ lobbyId, joinCode: '', password: '' });
            await redPlayer.sync();
            await redPlayer.call.setTeamSlot({ lobbyId, targetUserId: redPlayer.userId, lobbySlot: { tag: 'RedPlayer' as const } });
            await redPlayer.sync();

            await bluePlayer.call.confirmReady({ lobbyId });
            await bluePlayer.sync();
            await redPlayer.call.confirmReady({ lobbyId });
            await redPlayer.sync();
            await host.sync();

            // Start draft (BanMode=Four — first turn is Blue ban)
            await host.call.startDraft({ lobbyId });
            await host.sync(1500);
            await blueCoach.sync(1500);

            // Verify it is Blue's ban turn
            const session = getSession(host, lobbyId);
            expect(session).toBeDefined();
            expect(session!.draftSequence[session!.turnIndex].actionRequired.tag).toBe('Ban');
            expect(session!.draftSequence[session!.turnIndex].teamTurn.tag).toBe('Blue');

            // Blue coach tries to ban — coach guard fires before team turn check
            const err = await expectReducerError(
                blueCoach.call.banCharacter({ lobbyId, characterName: 'acheron' })
            );
            expect(err).toContain('Coaches cannot perform draft actions.');

            await leaveAll(lobbyId, bluePlayer, blueCoach, redPlayer, host);
        }, 60000);
    });

    // ─── captain enforcement ──────────────────────────────────────────────

    describe('captain enforcement', () => {
        let host: TestHarness;
        let blue1: TestHarness;
        let blue2: TestHarness;
        let red: TestHarness;

        beforeAll(async () => {
            host = await createVerifiedTestHarness();
            blue1 = await createVerifiedTestHarness();
            blue2 = await createVerifiedTestHarness();
            red = await createVerifiedTestHarness();
            await host.sync();
            await blue1.sync();
            await blue2.sync();
            await red.sync();
        }, 60000);

        afterAll(async () => {
            await host?.disconnect();
            await blue1?.disconnect();
            await blue2?.disconnect();
            await red?.disconnect();
        });

        it('only captain can pick — non-captain blue player blocked', async () => {
            // teamSize=3 allows two BluePlayer slots
            await host.call.createLobby(defaultLobbyArgs({ teamSize: 3, banMode: { tag: 'None' as const, value: {} } }));
            await host.sync(1500);
            const lobby = latestLobby(host);
            const lobbyId = lobby.id;

            // blue1 takes BluePlayer slot (will be auto-assigned captain as first player)
            await blue1.call.joinLobby({ lobbyId, joinCode: '', password: '' });
            await blue1.sync();
            await blue1.call.setTeamSlot({ lobbyId, targetUserId: blue1.userId, lobbySlot: { tag: 'BluePlayer' as const } });
            await blue1.sync();

            // blue2 also takes BluePlayer slot (second player, no captain)
            await blue2.call.joinLobby({ lobbyId, joinCode: '', password: '' });
            await blue2.sync();
            await blue2.call.setTeamSlot({ lobbyId, targetUserId: blue2.userId, lobbySlot: { tag: 'BluePlayer' as const } });
            await blue2.sync();

            // red player
            await red.call.joinLobby({ lobbyId, joinCode: '', password: '' });
            await red.sync();
            await red.call.setTeamSlot({ lobbyId, targetUserId: red.userId, lobbySlot: { tag: 'RedPlayer' as const } });
            await red.sync();

            // All players confirm
            await blue1.call.confirmReady({ lobbyId });
            await blue1.sync();
            await blue2.call.confirmReady({ lobbyId });
            await blue2.sync();
            await red.call.confirmReady({ lobbyId });
            await red.sync();
            await host.sync();

            // Start draft — auto-assigns blue1 as captain (first Blue player)
            await host.call.startDraft({ lobbyId });
            await host.sync(1500);
            await blue1.sync(1500);
            await blue2.sync(1500);
            await red.sync(1500);

            // Find which blue player is captain and which is not
            const members = [...host.conn.db.LobbyMember.iter()].filter(m => m.lobbyId === lobbyId);
            const blue1Member = members.find(m => m.userId === blue1.userId);
            const blue2Member = members.find(m => m.userId === blue2.userId);
            expect(blue1Member).toBeDefined();
            expect(blue2Member).toBeDefined();

            // One of them should be captain
            const nonCaptain = blue1Member!.isCaptain ? blue2 : blue1;
            expect(blue1Member!.isCaptain || blue2Member!.isCaptain).toBe(true);

            // Verify it is Blue's pick turn
            const session = getSession(host, lobbyId);
            expect(session).toBeDefined();
            expect(session!.draftSequence[session!.turnIndex].actionRequired.tag).toBe('Pick');
            expect(session!.draftSequence[session!.turnIndex].teamTurn.tag).toBe('Blue');

            // Non-captain tries to pick
            const err = await expectReducerError(
                nonCaptain.call.pickCharacter({ lobbyId, characterName: 'acheron', eidolon: 0 })
            );
            expect(err).toContain('Only the team captain can pick characters.');

            await leaveAll(lobbyId, blue1, blue2, red, host);
        }, 60000);

        it('only captain can ban — non-captain blue player blocked', async () => {
            // BanMode=Four — first turn is Blue ban
            await host.call.createLobby(defaultLobbyArgs({ teamSize: 3, banMode: { tag: 'Four' as const, value: {} } }));
            await host.sync(1500);
            const lobby = latestLobby(host);
            const lobbyId = lobby.id;

            // blue1 joins first (auto-captain)
            await blue1.call.joinLobby({ lobbyId, joinCode: '', password: '' });
            await blue1.sync();
            await blue1.call.setTeamSlot({ lobbyId, targetUserId: blue1.userId, lobbySlot: { tag: 'BluePlayer' as const } });
            await blue1.sync();

            // blue2 joins second (non-captain)
            await blue2.call.joinLobby({ lobbyId, joinCode: '', password: '' });
            await blue2.sync();
            await blue2.call.setTeamSlot({ lobbyId, targetUserId: blue2.userId, lobbySlot: { tag: 'BluePlayer' as const } });
            await blue2.sync();

            // red player
            await red.call.joinLobby({ lobbyId, joinCode: '', password: '' });
            await red.sync();
            await red.call.setTeamSlot({ lobbyId, targetUserId: red.userId, lobbySlot: { tag: 'RedPlayer' as const } });
            await red.sync();

            await blue1.call.confirmReady({ lobbyId });
            await blue1.sync();
            await blue2.call.confirmReady({ lobbyId });
            await blue2.sync();
            await red.call.confirmReady({ lobbyId });
            await red.sync();
            await host.sync();

            await host.call.startDraft({ lobbyId });
            await host.sync(1500);
            await blue1.sync(1500);
            await blue2.sync(1500);
            await red.sync(1500);

            // Verify it is Blue's ban turn
            const session = getSession(host, lobbyId);
            expect(session).toBeDefined();
            expect(session!.draftSequence[session!.turnIndex].actionRequired.tag).toBe('Ban');
            expect(session!.draftSequence[session!.turnIndex].teamTurn.tag).toBe('Blue');

            // Find which blue player is NOT the captain
            const members = [...host.conn.db.LobbyMember.iter()].filter(m => m.lobbyId === lobbyId);
            const b1 = members.find(m => m.userId === blue1.userId);
            const b2 = members.find(m => m.userId === blue2.userId);
            const nonCaptain = b1!.isCaptain ? blue2 : blue1;

            // Non-captain tries to ban
            const err = await expectReducerError(
                nonCaptain.call.banCharacter({ lobbyId, characterName: 'acheron' })
            );
            expect(err).toContain('Only the team captain can ban characters.');

            await leaveAll(lobbyId, blue1, blue2, red, host);
        }, 60000);
    });

    // ─── refereeCanUndo guard ─────────────────────────────────────────────

    describe('refereeCanUndo guard', () => {
        let host: TestHarness;
        let blue: TestHarness;
        let red: TestHarness;

        beforeAll(async () => {
            host = await createVerifiedTestHarness();
            blue = await createVerifiedTestHarness();
            red = await createVerifiedTestHarness();
            await host.sync();
            await blue.sync();
            await red.sync();
        }, 60000);

        afterAll(async () => {
            await host?.disconnect();
            await blue?.disconnect();
            await red?.disconnect();
        });

        it('undo allowed when refereeCanUndo=true', async () => {
            const lobbyId = await setupDraftLobby(host, blue, red, { refereeCanUndo: true });
            await startDraftAndSync(host, blue, red, lobbyId);

            // Blue picks on turn 0
            await blue.call.pickCharacter({ lobbyId, characterName: 'acheron', eidolon: 0 });
            await blue.sync(1500);
            await host.sync(1500);

            const sessionAfterPick = getSession(host, lobbyId);
            expect(sessionAfterPick!.turnIndex).toBe(1);

            // Host (referee) undoes the pick — should succeed
            await host.call.undoLastStep({ lobbyId });
            await host.sync(1500);
            await blue.sync(1500);

            const sessionAfterUndo = getSession(host, lobbyId);
            expect(sessionAfterUndo!.turnIndex).toBe(0);

            // Undo audit step should be recorded
            const steps = getSteps(host, lobbyId);
            const undoStep = steps.find(s => s.action.tag === 'Undo');
            expect(undoStep).toBeDefined();

            await leaveAll(lobbyId, blue, red, host);
        }, 60000);

        it('undo blocked when refereeCanUndo=false', async () => {
            const lobbyId = await setupDraftLobby(host, blue, red, { refereeCanUndo: false });
            await startDraftAndSync(host, blue, red, lobbyId);

            // Blue picks on turn 0
            await blue.call.pickCharacter({ lobbyId, characterName: 'acheron', eidolon: 0 });
            await blue.sync(1500);
            await host.sync(1500);

            const sessionAfterPick = getSession(host, lobbyId);
            expect(sessionAfterPick!.turnIndex).toBe(1);

            // Host (referee) tries to undo — should be blocked
            const err = await expectReducerError(
                host.call.undoLastStep({ lobbyId })
            );
            expect(err).toContain('Only referees with undo permission can undo.');

            // State unchanged: turnIndex still 1
            const sessionAfter = getSession(host, lobbyId);
            expect(sessionAfter!.turnIndex).toBe(1);

            await leaveAll(lobbyId, blue, red, host);
        }, 60000);
    });

    // ─── pause limits ─────────────────────────────────────────────────────

    describe('pause limits', () => {
        let host: TestHarness;
        let blue: TestHarness;
        let red: TestHarness;

        beforeAll(async () => {
            host = await createVerifiedTestHarness();
            blue = await createVerifiedTestHarness();
            red = await createVerifiedTestHarness();
            await host.sync();
            await blue.sync();
            await red.sync();
        }, 60000);

        afterAll(async () => {
            await host?.disconnect();
            await blue?.disconnect();
            await red?.disconnect();
        });

        it('player limited to 3 pauses per team', async () => {
            const lobbyId = await setupDraftLobby(host, blue, red, { allowPlayerPause: true });
            await startDraftAndSync(host, blue, red, lobbyId);

            // Pause 1
            await blue.call.pauseDraft({ lobbyId });
            await blue.sync(1500);
            await host.sync(1500);

            let session = getSession(host, lobbyId);
            expect(session!.timerState.isPaused).toBe(true);
            expect(session!.pausesUsedBlue).toBe(1);

            await blue.call.resumeDraft({ lobbyId });
            await blue.sync(1500);
            await host.sync(1500);

            // Pause 2
            await blue.call.pauseDraft({ lobbyId });
            await blue.sync(1500);
            await host.sync(1500);

            session = getSession(host, lobbyId);
            expect(session!.pausesUsedBlue).toBe(2);

            await blue.call.resumeDraft({ lobbyId });
            await blue.sync(1500);
            await host.sync(1500);

            // Pause 3 (last allowed)
            await blue.call.pauseDraft({ lobbyId });
            await blue.sync(1500);
            await host.sync(1500);

            session = getSession(host, lobbyId);
            expect(session!.pausesUsedBlue).toBe(3);

            await blue.call.resumeDraft({ lobbyId });
            await blue.sync(1500);
            await host.sync(1500);

            // Pause 4 — should be rejected
            const err = await expectReducerError(
                blue.call.pauseDraft({ lobbyId })
            );
            expect(err).toContain('Blue team has used all 3 pauses.');

            // State unchanged: still unpaused, pausesUsedBlue still 3
            session = getSession(host, lobbyId);
            expect(session!.timerState.isPaused).toBe(false);
            expect(session!.pausesUsedBlue).toBe(3);

            await leaveAll(lobbyId, blue, red, host);
        }, 60000);

        it('referee has unlimited pauses', async () => {
            const lobbyId = await setupDraftLobby(host, blue, red, {
                allowPlayerPause: true,
                refereeCanPause: true,
            });
            await startDraftAndSync(host, blue, red, lobbyId);

            // Host is the referee — pause 4 times to confirm no limit
            for (let i = 1; i <= 4; i++) {
                await host.call.pauseDraft({ lobbyId });
                await host.sync(1500);

                const session = getSession(host, lobbyId);
                expect(session!.timerState.isPaused).toBe(true);

                await host.call.resumeDraft({ lobbyId });
                await host.sync(1500);

                const sessionAfter = getSession(host, lobbyId);
                expect(sessionAfter!.timerState.isPaused).toBe(false);
            }

            // Referee pauses should not increment player pause counters
            const sessionFinal = getSession(host, lobbyId);
            expect(sessionFinal!.pausesUsedBlue).toBe(0);
            expect(sessionFinal!.pausesUsedRed).toBe(0);

            await leaveAll(lobbyId, blue, red, host);
        }, 60000);
    });
});
