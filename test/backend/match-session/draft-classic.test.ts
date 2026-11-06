/**
 * Integration tests for the Classic draft system.
 *
 * Covers:
 * - start_draft: MatchSession creation, stage transition, auto-captain, guards
 * - pick_character: turn order, captain enforcement, mirror picks, banned chars
 * - ban_character: ban turns (BanMode=Four), duplicate ban rejection
 * - timer_expiry_classic: timer guard (server-side validation)
 * - undo_last_step: referee undo, permission guard, empty guard
 * - pause_draft / resume_draft: player pause, allowPlayerPause guard, resume
 *
 * Requires: SPACETIMEDB_SERVER_TOKEN in .env.local (post-publish bootstrap)
 *
 * Contract: docs/match-session/contract.md — Match Session (Draft System)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
    createVerifiedTestHarness,
    expectReducerError,
    sleep,
    type TestHarness,
} from '../../shared/connection';
import { defaultLobbyArgs } from '../../shared/helpers/lobbies';
import { startDraftAndSync } from '../../shared/helpers/drafts';
import { myLobbies, lobbyMembers } from '../../shared/helpers/queries';

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

/** Get MatchResultRecord for a lobby */
function getResultRecord(h: TestHarness, lobbyId: number) {
    return [...h.conn.db.MatchResultRecord.iter()].find(r => r.lobbyId === lobbyId);
}

/** Get MatchResultParticipants for a result record */
function getResultParticipants(h: TestHarness, matchResultId: number) {
    return [...h.conn.db.MatchResultParticipant.iter()].filter(p => p.matchResultId === matchResultId);
}

/** Set up a lobby ready for draft: host + blue + red, all confirmed */
async function setupDraftLobby(
    host: TestHarness,
    blue: TestHarness,
    red: TestHarness,
    lobbyOverrides: Record<string, unknown> = {},
) {
    await host.call.createLobby(defaultLobbyArgs(lobbyOverrides));
    await host.sync(1500);
    const lobbies = myLobbies(host);
    const lobby = lobbies[lobbies.length - 1];

    // Blue joins and moves to BluePlayer
    await blue.call.joinLobby({ lobbyId: lobby.id, joinCode: '', password: '' });
    await blue.sync();
    await blue.call.setTeamSlot({ lobbyId: lobby.id, targetUserId: blue.userId, lobbySlot: { tag: 'BluePlayer' as const } });
    await blue.sync();

    // Red joins and moves to RedPlayer
    await red.call.joinLobby({ lobbyId: lobby.id, joinCode: '', password: '' });
    await red.sync();
    await red.call.setTeamSlot({ lobbyId: lobby.id, targetUserId: red.userId, lobbySlot: { tag: 'RedPlayer' as const } });
    await red.sync();

    // Both confirm ready
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
            await h.sync();
        } catch {
            // Ignore — member may not be in the lobby
        }
    }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Classic Draft', () => {

    // ─── start_draft ────────────────────────────────────────────────────

    describe('start_draft', () => {
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
        }, 30000);

        afterAll(async () => {
            await host?.disconnect();
            await blue?.disconnect();
            await red?.disconnect();
        });

        it('starts draft — creates MatchSession, changes stage to Drafting', async () => {
            const lobbyId = await setupDraftLobby(host, blue, red);
            await startDraftAndSync(host, blue, red, lobbyId);

            // Lobby stage should be Drafting
            const lobby = [...host.conn.db.Lobby.iter()].find(l => l.id === lobbyId);
            expect(lobby).toBeDefined();
            expect(lobby!.stage.tag).toBe('Drafting');

            // MatchSession exists for this lobby
            const session = getSession(host, lobbyId);
            expect(session).toBeDefined();
            expect(session!.turnIndex).toBe(0);

            // MatchResultRecord exists
            const result = getResultRecord(host, lobbyId);
            expect(result).toBeDefined();
            expect(result!.status.tag).toBe('Pending');

            // MatchResultParticipant rows exist for blue and red
            const participants = getResultParticipants(host, result!.id);
            expect(participants.length).toBe(2);

            const blueParticipant = participants.find(p => p.userId === blue.userId);
            const redParticipant = participants.find(p => p.userId === red.userId);
            expect(blueParticipant).toBeDefined();
            expect(redParticipant).toBeDefined();
            expect(blueParticipant!.teamSide.tag).toBe('Blue');
            expect(redParticipant!.teamSide.tag).toBe('Red');

            // Cleanup: members leave (lobby in Drafting, closeLobby blocked)
            await leaveAll(lobbyId, blue, red, host);
        }, 30000);

        it('auto-assigns captains when none set', async () => {
            const lobbyId = await setupDraftLobby(host, blue, red);
            await startDraftAndSync(host, blue, red, lobbyId);

            // After start_draft, both blue and red should have isCaptain=true (auto-assigned)
            const members = lobbyMembers(host, lobbyId);
            const blueMember = members.find(m => m.userId === blue.userId);
            const redMember = members.find(m => m.userId === red.userId);
            expect(blueMember).toBeDefined();
            expect(blueMember!.isCaptain).toBe(true);
            expect(redMember).toBeDefined();
            expect(redMember!.isCaptain).toBe(true);

            await leaveAll(lobbyId, blue, red, host);
        }, 30000);

        it('rejects if players not confirmed', async () => {
            // Create lobby, join blue+red, move to slots, but only confirm blue
            await host.call.createLobby(defaultLobbyArgs());
            await host.sync(1500);
            const lobbies = myLobbies(host);
            const lobby = lobbies[lobbies.length - 1];
            const lobbyId = lobby.id;

            await blue.call.joinLobby({ lobbyId, joinCode: '', password: '' });
            await blue.sync();
            await blue.call.setTeamSlot({ lobbyId, targetUserId: blue.userId, lobbySlot: { tag: 'BluePlayer' as const } });
            await blue.sync();

            await red.call.joinLobby({ lobbyId, joinCode: '', password: '' });
            await red.sync();
            await red.call.setTeamSlot({ lobbyId, targetUserId: red.userId, lobbySlot: { tag: 'RedPlayer' as const } });
            await red.sync();

            // Only blue confirms
            await blue.call.confirmReady({ lobbyId });
            await blue.sync();
            await host.sync();

            const err = await expectReducerError(
                host.call.startDraft({ lobbyId })
            );
            expect(err).toContain('All Blue and Red players must be confirmed before starting.');

            // Cleanup
            await leaveAll(lobbyId, blue, red, host);
        }, 30000);

        it('rejects if no Blue team player', async () => {
            // Create lobby with only host + red player (no blue)
            await host.call.createLobby(defaultLobbyArgs());
            await host.sync(1500);
            const lobbies = myLobbies(host);
            const lobby = lobbies[lobbies.length - 1];
            const lobbyId = lobby.id;

            await red.call.joinLobby({ lobbyId, joinCode: '', password: '' });
            await red.sync();
            await red.call.setTeamSlot({ lobbyId, targetUserId: red.userId, lobbySlot: { tag: 'RedPlayer' as const } });
            await red.sync();
            await red.call.confirmReady({ lobbyId });
            await red.sync();
            await host.sync();

            const err = await expectReducerError(
                host.call.startDraft({ lobbyId })
            );
            expect(err).toContain('Blue team must have at least one non-coach player.');

            await leaveAll(lobbyId, red, host);
        }, 30000);
    });

    // ─── pick_character ─────────────────────────────────────────────────

    describe('pick_character', () => {
        let host: TestHarness;
        let blue: TestHarness;
        let red: TestHarness;
        let lobbyId: number;

        beforeAll(async () => {
            host = await createVerifiedTestHarness();
            blue = await createVerifiedTestHarness();
            red = await createVerifiedTestHarness();
            await host.sync();
            await blue.sync();
            await red.sync();

            // Create a shared draft lobby for pick tests (banMode=None)
            lobbyId = await setupDraftLobby(host, blue, red);
            await startDraftAndSync(host, blue, red, lobbyId);
        }, 45000);

        afterAll(async () => {
            await leaveAll(lobbyId, blue, red, host);
            await host?.disconnect();
            await blue?.disconnect();
            await red?.disconnect();
        });

        it('Blue captain picks on Blue turn', async () => {
            // Turn 0 in Classic BanMode=None is Blue Pick
            const sessionBefore = getSession(host, lobbyId);
            expect(sessionBefore).toBeDefined();
            expect(sessionBefore!.turnIndex).toBe(0);

            await blue.call.pickCharacter({ lobbyId, characterName: 'acheron', eidolon: 0 });
            await blue.sync(1500);
            await host.sync(1500);

            // Verify step was created
            const steps = getSteps(host, lobbyId);
            const pickStep = steps.find(s => s.action.tag === 'Pick' && s.payload.tag === 'Pick' && s.payload.value.characterName === 'acheron');
            expect(pickStep).toBeDefined();
            expect(pickStep!.actorUserId).toBe(blue.userId);
            expect(pickStep!.actorSlot.tag).toBe('Blue');

            // turnIndex advanced
            const sessionAfter = getSession(host, lobbyId);
            expect(sessionAfter!.turnIndex).toBe(1);
        }, 15000);

        it("wrong team's turn rejected", async () => {
            // After Blue pick at turn 0, turn 1 is Red pick. Blue tries to pick again.
            const session = getSession(host, lobbyId);
            expect(session).toBeDefined();
            // Turn 1 should be Red's turn
            expect(session!.draftSequence[session!.turnIndex].teamTurn.tag).toBe('Red');

            const err = await expectReducerError(
                blue.call.pickCharacter({ lobbyId, characterName: 'aglaea', eidolon: 0 })
            );
            expect(err).toContain('It is not your team\'s turn to pick.');
        }, 15000);

        it('character exclusivity (allowMirrorPicks=false)', async () => {
            // This test needs a separate lobby with allowMirrorPicks=false.
            // We'll create fresh harnesses for isolation.
            const h2 = await createVerifiedTestHarness();
            const b2 = await createVerifiedTestHarness();
            const r2 = await createVerifiedTestHarness();
            await h2.sync(); await b2.sync(); await r2.sync();

            const lid = await setupDraftLobby(h2, b2, r2, { allowMirrorPicks: false });
            await startDraftAndSync(h2, b2, r2, lid);

            // Blue picks 'argenti' on turn 0
            await b2.call.pickCharacter({ lobbyId: lid, characterName: 'argenti', eidolon: 0 });
            await b2.sync(1500);
            await r2.sync(1500);

            // Turn 1 is Red pick; Red tries to pick 'argenti' (same character)
            const err = await expectReducerError(
                r2.call.pickCharacter({ lobbyId: lid, characterName: 'argenti', eidolon: 0 })
            );
            expect(err).toContain('Character already picked.');

            await leaveAll(lid, b2, r2, h2);
            await h2.disconnect(); await b2.disconnect(); await r2.disconnect();
        }, 45000);

        it('banned character cannot be picked', async () => {
            // Needs BanMode=Four lobby so there are ban turns before picks
            const h3 = await createVerifiedTestHarness();
            const b3 = await createVerifiedTestHarness();
            const r3 = await createVerifiedTestHarness();
            await h3.sync(); await b3.sync(); await r3.sync();

            const lid = await setupDraftLobby(h3, b3, r3, { banMode: { tag: 'Four' as const, value: {} } });
            await startDraftAndSync(h3, b3, r3, lid);

            // BanMode=Four Classic sequence: Ban Blue, Ban Red, Pick Blue, Pick Red, ...
            // First 2 turns are bans, then picks start at turn 2.
            await b3.call.banCharacter({ lobbyId: lid, characterName: 'acheron' });
            await b3.sync(1500);
            await r3.sync(1500);

            await r3.call.banCharacter({ lobbyId: lid, characterName: 'aglaea' });
            await r3.sync(1500);
            await b3.sync(1500);
            await h3.sync(1500);

            // Now turn 2 is Pick Blue — try to pick banned 'acheron'
            const sessionAfterBans = getSession(h3, lid);
            expect(sessionAfterBans!.turnIndex).toBe(2);

            const err = await expectReducerError(
                b3.call.pickCharacter({ lobbyId: lid, characterName: 'acheron', eidolon: 0 })
            );
            expect(err).toContain('Character is banned and cannot be picked.');

            await leaveAll(lid, b3, r3, h3);
            await h3.disconnect(); await b3.disconnect(); await r3.disconnect();
        }, 60000);
    });

    // ─── ban_character ──────────────────────────────────────────────────

    describe('ban_character', () => {
        let host: TestHarness;
        let blue: TestHarness;
        let red: TestHarness;
        let lobbyId: number;

        beforeAll(async () => {
            host = await createVerifiedTestHarness();
            blue = await createVerifiedTestHarness();
            red = await createVerifiedTestHarness();
            await host.sync();
            await blue.sync();
            await red.sync();

            // BanMode=Four gives 4 ban turns (B, R, B, R) before picks
            lobbyId = await setupDraftLobby(host, blue, red, { banMode: { tag: 'Four' as const, value: {} } });
            await startDraftAndSync(host, blue, red, lobbyId);
        }, 45000);

        afterAll(async () => {
            await leaveAll(lobbyId, blue, red, host);
            await host?.disconnect();
            await blue?.disconnect();
            await red?.disconnect();
        });

        it('bans a character on ban turn', async () => {
            const session = getSession(host, lobbyId);
            expect(session).toBeDefined();
            expect(session!.draftSequence[0].actionRequired.tag).toBe('Ban');
            expect(session!.draftSequence[0].teamTurn.tag).toBe('Blue');

            await blue.call.banCharacter({ lobbyId, characterName: 'acheron' });
            await blue.sync(1500);
            await host.sync(1500);

            const steps = getSteps(host, lobbyId);
            const banStep = steps.find(s => s.action.tag === 'Ban');
            expect(banStep).toBeDefined();
            expect(banStep!.payload.tag).toBe('Ban');
            expect((banStep!.payload.value as any).characterName).toBe('acheron');
            expect(banStep!.actorSlot.tag).toBe('Blue');

            const sessionAfter = getSession(host, lobbyId);
            expect(sessionAfter!.turnIndex).toBe(1);
        }, 15000);

        it('duplicate ban rejected', async () => {
            // 'acheron' was already banned in the previous test.
            // Turn 1 is Red ban. Try to ban acheron again.
            const session = getSession(host, lobbyId);
            expect(session!.draftSequence[session!.turnIndex].teamTurn.tag).toBe('Red');

            const err = await expectReducerError(
                red.call.banCharacter({ lobbyId, characterName: 'acheron' })
            );
            expect(err).toContain('Character already banned.');
        }, 15000);
    });

    // ─── timer_expiry_classic ───────────────────────────────────────────

    describe('timer_expiry_classic', () => {
        let host: TestHarness;
        let blue: TestHarness;
        let red: TestHarness;
        let lobbyId: number;

        beforeAll(async () => {
            host = await createVerifiedTestHarness();
            blue = await createVerifiedTestHarness();
            red = await createVerifiedTestHarness();
            await host.sync();
            await blue.sync();
            await red.sync();

            // Use very short timer to allow natural expiry
            lobbyId = await setupDraftLobby(host, blue, red, { standardTurnSeconds: 1 });
            await startDraftAndSync(host, blue, red, lobbyId);
        }, 45000);

        afterAll(async () => {
            await leaveAll(lobbyId, blue, red, host);
            await host?.disconnect();
            await blue?.disconnect();
            await red?.disconnect();
        });

        it('auto-picks EMPTY on expired pick turn', async () => {
            const sessionBefore = getSession(host, lobbyId);
            expect(sessionBefore).toBeDefined();
            const turnBefore = sessionBefore!.turnIndex;

            // Wait for 1-second timer to expire (add margin)
            await sleep(2500);

            await host.call.timerExpiryClassic({ lobbyId });
            await host.sync(1500);
            await blue.sync(1500);

            const sessionAfter = getSession(host, lobbyId);
            expect(sessionAfter!.turnIndex).toBe(turnBefore + 1);

            // Verify an EMPTY pick step was created with actorUserId=0 (system)
            const steps = getSteps(host, lobbyId);
            const emptyStep = steps.find(s =>
                s.action.tag === 'Pick' &&
                s.payload.tag === 'Pick' &&
                s.payload.value.characterName === 'EMPTY'
            );
            expect(emptyStep).toBeDefined();
            expect(emptyStep!.actorUserId).toBe(0);
        }, 15000);

        it('successive timer expiry advances draft', async () => {
            // timer_expiry_classic doesn't enforce a timer check server-side —
            // it always processes the current turn (auto-pick EMPTY or auto-ban SKIP).
            // Calling it again should succeed and advance to the next turn.
            const sessionBefore = getSession(host, lobbyId);
            const turnBefore = sessionBefore!.turnIndex;

            await host.call.timerExpiryClassic({ lobbyId });
            await host.sync();

            const sessionAfter = getSession(host, lobbyId);
            expect(sessionAfter!.turnIndex).toBe(turnBefore + 1);
        }, 15000);
    });

    // ─── undo_last_step ─────────────────────────────────────────────────

    describe('undo_last_step', () => {
        let host: TestHarness;
        let blue: TestHarness;
        let red: TestHarness;
        let lobbyId: number;

        beforeAll(async () => {
            host = await createVerifiedTestHarness();
            blue = await createVerifiedTestHarness();
            red = await createVerifiedTestHarness();
            await host.sync();
            await blue.sync();
            await red.sync();

            lobbyId = await setupDraftLobby(host, blue, red);
            await startDraftAndSync(host, blue, red, lobbyId);
        }, 45000);

        afterAll(async () => {
            await leaveAll(lobbyId, blue, red, host);
            await host?.disconnect();
            await blue?.disconnect();
            await red?.disconnect();
        });

        it('no steps to undo at turnIndex=0', async () => {
            const session = getSession(host, lobbyId);
            expect(session!.turnIndex).toBe(0);

            const err = await expectReducerError(
                host.call.undoLastStep({ lobbyId })
            );
            expect(err).toContain('No steps to undo.');
        }, 15000);

        it('referee undoes last step', async () => {
            // Blue picks on turn 0
            await blue.call.pickCharacter({ lobbyId, characterName: 'acheron', eidolon: 0 });
            await blue.sync(1500);
            await host.sync(1500);

            const sessionAfterPick = getSession(host, lobbyId);
            expect(sessionAfterPick!.turnIndex).toBe(1);

            // Host (auto-referee) undoes the pick
            await host.call.undoLastStep({ lobbyId });
            await host.sync(1500);
            await blue.sync(1500);

            const sessionAfterUndo = getSession(host, lobbyId);
            expect(sessionAfterUndo!.turnIndex).toBe(0);

            // The pick step should be deleted, but an Undo audit step exists
            const steps = getSteps(host, lobbyId);
            const undoStep = steps.find(s => s.action.tag === 'Undo');
            expect(undoStep).toBeDefined();

            // The original pick step ('acheron') should be deleted
            const pickSteps = steps.filter(s =>
                s.action.tag === 'Pick' &&
                s.payload.tag === 'Pick' &&
                s.payload.value.characterName === 'acheron'
            );
            expect(pickSteps.length).toBe(0);
        }, 15000);

        it('non-referee blocked', async () => {
            // Blue picks so there is a step to undo
            await blue.call.pickCharacter({ lobbyId, characterName: 'aglaea', eidolon: 0 });
            await blue.sync(1500);
            await host.sync(1500);

            // Blue (non-referee) tries to undo
            const err = await expectReducerError(
                blue.call.undoLastStep({ lobbyId })
            );
            expect(err).toContain('Only referees with undo permission can undo.');

            // Undo that pick via host so state is clean for subsequent tests
            await host.call.undoLastStep({ lobbyId });
            await host.sync(1500);
        }, 15000);
    });

    // ─── pause_draft / resume_draft ─────────────────────────────────────

    describe('pause_draft / resume_draft', () => {
        let host: TestHarness;
        let blue: TestHarness;
        let red: TestHarness;
        let lobbyId: number;

        beforeAll(async () => {
            host = await createVerifiedTestHarness();
            blue = await createVerifiedTestHarness();
            red = await createVerifiedTestHarness();
            await host.sync();
            await blue.sync();
            await red.sync();

            lobbyId = await setupDraftLobby(host, blue, red);
            await startDraftAndSync(host, blue, red, lobbyId);
        }, 45000);

        afterAll(async () => {
            await leaveAll(lobbyId, blue, red, host);
            await host?.disconnect();
            await blue?.disconnect();
            await red?.disconnect();
        });

        it('player pauses when allowPlayerPause=true', async () => {
            await blue.call.pauseDraft({ lobbyId });
            await blue.sync(1500);
            await host.sync(1500);

            const session = getSession(host, lobbyId);
            expect(session).toBeDefined();
            expect(session!.timerState.isPaused).toBe(true);

            // A Pause step should exist
            const steps = getSteps(host, lobbyId);
            const pauseStep = steps.find(s => s.action.tag === 'Pause');
            expect(pauseStep).toBeDefined();
        }, 15000);

        it('resume by pauser', async () => {
            // Draft should be paused from the previous test
            const sessionBefore = getSession(host, lobbyId);
            expect(sessionBefore!.timerState.isPaused).toBe(true);

            await blue.call.resumeDraft({ lobbyId });
            await blue.sync(1500);
            await host.sync(1500);

            const sessionAfter = getSession(host, lobbyId);
            expect(sessionAfter!.timerState.isPaused).toBe(false);
        }, 15000);

        it('player pause blocked when allowPlayerPause=false', async () => {
            // Needs a fresh lobby with allowPlayerPause=false
            const h4 = await createVerifiedTestHarness();
            const b4 = await createVerifiedTestHarness();
            const r4 = await createVerifiedTestHarness();
            await h4.sync(); await b4.sync(); await r4.sync();

            const lid = await setupDraftLobby(h4, b4, r4, { allowPlayerPause: false });
            await startDraftAndSync(h4, b4, r4, lid);

            const err = await expectReducerError(
                b4.call.pauseDraft({ lobbyId: lid })
            );
            expect(err).toContain('Player pausing is not allowed in this lobby.');

            await leaveAll(lid, b4, r4, h4);
            await h4.disconnect(); await b4.disconnect(); await r4.disconnect();
        }, 45000);
    });

    // ─── coach guard (cross-cutting) ────────────────────────────────────

    describe('coach cannot pick', () => {
        it('coach is blocked from picking', async () => {
            // teamSize=3 allows coach slots. We need host + blue player + blue coach + red player.
            const host = await createVerifiedTestHarness();
            const bluePlayer = await createVerifiedTestHarness();
            const blueCoach = await createVerifiedTestHarness();
            const redPlayer = await createVerifiedTestHarness();
            await host.sync(); await bluePlayer.sync(); await blueCoach.sync(); await redPlayer.sync();

            await host.call.createLobby(defaultLobbyArgs({ teamSize: 3 }));
            await host.sync(1500);
            const lobbies = myLobbies(host);
            const lobby = lobbies[lobbies.length - 1];
            const lobbyId = lobby.id;

            // Blue player
            await bluePlayer.call.joinLobby({ lobbyId, joinCode: '', password: '' });
            await bluePlayer.sync();
            await bluePlayer.call.setTeamSlot({ lobbyId, targetUserId: bluePlayer.userId, lobbySlot: { tag: 'BluePlayer' as const } });
            await bluePlayer.sync();

            // Blue coach — host must assign coach slot (self-assignment blocked)
            await blueCoach.call.joinLobby({ lobbyId, joinCode: '', password: '' });
            await blueCoach.sync();
            await host.call.setTeamSlot({ lobbyId, targetUserId: blueCoach.userId, lobbySlot: { tag: 'BlueCoach' as const } });
            await host.sync();

            // Red player
            await redPlayer.call.joinLobby({ lobbyId, joinCode: '', password: '' });
            await redPlayer.sync();
            await redPlayer.call.setTeamSlot({ lobbyId, targetUserId: redPlayer.userId, lobbySlot: { tag: 'RedPlayer' as const } });
            await redPlayer.sync();

            // Confirm ready (non-coach players only — coaches don't need to confirm)
            await bluePlayer.call.confirmReady({ lobbyId });
            await bluePlayer.sync();
            await redPlayer.call.confirmReady({ lobbyId });
            await redPlayer.sync();
            await host.sync();

            // Start draft
            await host.call.startDraft({ lobbyId });
            await host.sync(1500);
            await blueCoach.sync(1500);

            // Coach tries to pick
            const err = await expectReducerError(
                blueCoach.call.pickCharacter({ lobbyId, characterName: 'acheron', eidolon: 0 })
            );
            expect(err).toContain('Coaches cannot perform draft actions.');

            await leaveAll(lobbyId, bluePlayer, blueCoach, redPlayer, host);
            await host.disconnect();
            await bluePlayer.disconnect();
            await blueCoach.disconnect();
            await redPlayer.disconnect();
        }, 60000);
    });
});
