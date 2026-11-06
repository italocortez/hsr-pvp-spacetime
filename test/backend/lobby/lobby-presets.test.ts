/**
 * Integration tests for lobby preset reducers.
 *
 * Covers:
 * - create_lobby_preset: role guard, name validation
 * - update_lobby_preset: owner update, cross-user permission hierarchy, name validation
 * - delete_lobby_preset: owner delete, not-found, cross-user permission guard
 *
 * Requires: SPACETIMEDB_SERVER_TOKEN in .env.local (post-publish bootstrap)
 *
 * Contract: docs/lobby/contract.md — Lobby Preset scenarios
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
    createVerifiedTestHarness,
    expectReducerError,
    type TestHarness,
} from '../../shared/connection';
import { promoteUser } from '../../shared/helpers/promoteUser';

// ─── Helpers ────────────────────────────────────────────────────────────────

function presetArgs(name: string, overrides: Record<string, unknown> = {}) {
    return {
        name,
        teamSize: 1,
        draftMode: { tag: 'Classic' as const, value: {} },
        banMode: { tag: 'None' as const, value: {} },
        gameMode: { tag: 'MemoryOfChaos' as const, value: {} },
        matchType: { tag: 'Casual' as const, value: {} },
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
        isPublic: true,
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
        refereeExclusiveConcede: false,
        ...overrides,
    };
}

/** update_lobby_preset needs presetId + name + all config fields */
function updatePresetArgs(presetId: number, name: string, overrides: Record<string, unknown> = {}) {
    return {
        presetId,
        ...presetArgs(name, overrides),
    };
}

function myPresets(h: TestHarness) {
    return [...h.conn.db.LobbyPreset.iter()].filter(p => p.creatorUserId === h.userId);
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Lobby Presets', () => {
    let toUser: TestHarness;
    let modUser: TestHarness;
    let adminUser: TestHarness;
    let regularUser: TestHarness;

    beforeAll(async () => {
        toUser = await createVerifiedTestHarness();
        modUser = await createVerifiedTestHarness();
        adminUser = await createVerifiedTestHarness();
        regularUser = await createVerifiedTestHarness();

        // Look up usernames before promoting
        const toUsername = [...toUser.conn.db.User.iter()].find(u => u.id === toUser.userId)?.username;
        const modUsername = [...modUser.conn.db.User.iter()].find(u => u.id === modUser.userId)?.username;
        const adminUsername = [...adminUser.conn.db.User.iter()].find(u => u.id === adminUser.userId)?.username;

        if (!toUsername || !modUsername || !adminUsername) {
            throw new Error('Could not resolve usernames for promotion');
        }

        await promoteUser(toUsername, 'TournamentHost');
        await promoteUser(modUsername, 'Moderator');
        await promoteUser(adminUsername, 'Admin');

        await toUser.sync(1500);
        await modUser.sync(1500);
        await adminUser.sync(1500);
        await regularUser.sync(1500);
    }, 45000);

    afterAll(async () => {
        // Clean up any remaining presets created during tests
        const toPresets = myPresets(toUser);
        for (const p of toPresets) {
            await toUser.call.deleteLobbyPreset({ presetId: p.id }).catch(() => {});
        }
        const modPresets = myPresets(modUser);
        for (const p of modPresets) {
            await modUser.call.deleteLobbyPreset({ presetId: p.id }).catch(() => {});
        }
        await toUser.sync();
        await modUser.sync();

        await toUser?.disconnect();
        await modUser?.disconnect();
        await adminUser?.disconnect();
        await regularUser?.disconnect();
    });

    // ─── create_lobby_preset ─────────────────────────────────────────────

    describe('create_lobby_preset', () => {
        it('TO creates a preset', async () => {
            await toUser.call.createLobbyPreset(presetArgs('TO Preset'));
            await toUser.sync(1500);

            const presets = myPresets(toUser);
            const created = presets.find(p => p.name === 'TO Preset');
            expect(created).toBeDefined();
            expect(created!.name).toBe('TO Preset');
            expect(created!.creatorUserId).toBe(toUser.userId);
            expect(created!.isSystemPreset).toBe(false);
        });

        it('User role blocked', async () => {
            const err = await expectReducerError(
                regularUser.call.createLobbyPreset(presetArgs('Regular Preset'))
            );
            expect(err).toContain('Only Tournament Hosts, Moderators, and Admins can create lobby presets.');
        });

        it('name validation: empty name rejected', async () => {
            const err = await expectReducerError(
                toUser.call.createLobbyPreset(presetArgs(''))
            );
            expect(err).toContain('Preset name must be between 1 and 50 characters.');
        });

        it('name validation: 51-char name rejected', async () => {
            const err = await expectReducerError(
                toUser.call.createLobbyPreset(presetArgs('A'.repeat(51)))
            );
            expect(err).toContain('Preset name must be between 1 and 50 characters.');
        });

        it('name validation: 50-char name accepted', async () => {
            await toUser.call.createLobbyPreset(presetArgs('A'.repeat(50)));
            await toUser.sync(1500);

            const presets = myPresets(toUser);
            const created = presets.find(p => p.name === 'A'.repeat(50));
            expect(created).toBeDefined();
        });
    });

    // ─── update_lobby_preset ─────────────────────────────────────────────

    describe('update_lobby_preset', () => {
        it('owner updates own preset', async () => {
            // Find a preset created by toUser in the create suite (the 'TO Preset')
            await toUser.sync();
            const presets = myPresets(toUser);
            const target = presets.find(p => p.name === 'TO Preset');
            expect(target).toBeDefined();
            const presetId = target!.id;

            await toUser.call.updateLobbyPreset(updatePresetArgs(presetId, 'Updated Preset'));
            await toUser.sync(1500);

            const updated = [...toUser.conn.db.LobbyPreset.iter()].find(p => p.id === presetId);
            expect(updated).toBeDefined();
            expect(updated!.name).toBe('Updated Preset');
        });

        it('TO blocked from updating another user\'s preset', async () => {
            // modUser creates a preset
            await modUser.call.createLobbyPreset(presetArgs('Mod Preset'));
            await modUser.sync(1500);

            const modPresets = myPresets(modUser);
            const modPreset = modPresets.find(p => p.name === 'Mod Preset');
            expect(modPreset).toBeDefined();
            const modPresetId = modPreset!.id;

            // toUser tries to update modUser's preset
            const err = await expectReducerError(
                toUser.call.updateLobbyPreset(updatePresetArgs(modPresetId, 'Hijacked Name'))
            );
            expect(err).toContain('You do not have permission to modify this preset.');
        });

        it('Moderator can update another mod/TO preset', async () => {
            // Find toUser's 'Updated Preset' (was 'TO Preset')
            await toUser.sync();
            const toPresets = myPresets(toUser);
            const toPreset = toPresets.find(p => p.name === 'Updated Preset');
            expect(toPreset).toBeDefined();
            const toPresetId = toPreset!.id;

            // modUser (Moderator) updates toUser's (TournamentHost) preset — should succeed
            await modUser.call.updateLobbyPreset(updatePresetArgs(toPresetId, 'Mod Updated TO Preset'));
            await modUser.sync(1500);
            await toUser.sync();

            const updated = [...toUser.conn.db.LobbyPreset.iter()].find(p => p.id === toPresetId);
            expect(updated).toBeDefined();
            expect(updated!.name).toBe('Mod Updated TO Preset');
        });

        it('Admin updates system preset — requires seed data (skipped)', () => {
            // System presets are created via bootstrap/seed data with isSystemPreset=true.
            // There is no public reducer to create a system preset, so this test
            // requires pre-seeded data to run. Skipped — covered by contract D-31b.
        });

        it('Moderator blocked from updating system preset — requires seed data (skipped)', () => {
            // Same as above — system presets require seed data.
            // Contract specifies: "Only admins can modify or delete system presets."
            // Skipped — covered by contract D-31b.
        });

        it('name validation on update: empty rejected', async () => {
            // Use toUser's preset (whatever remains)
            await toUser.sync();
            const toPresets = myPresets(toUser);
            expect(toPresets.length).toBeGreaterThan(0);
            const target = toPresets[0];

            const err = await expectReducerError(
                toUser.call.updateLobbyPreset(updatePresetArgs(target.id, ''))
            );
            expect(err).toContain('Preset name must be between 1 and 50 characters.');
        });
    });

    // ─── delete_lobby_preset ─────────────────────────────────────────────

    describe('delete_lobby_preset', () => {
        it('owner deletes own preset', async () => {
            // Create a new preset specifically for this test
            await toUser.call.createLobbyPreset(presetArgs('To Be Deleted'));
            await toUser.sync(1500);

            const presets = myPresets(toUser);
            const target = presets.find(p => p.name === 'To Be Deleted');
            expect(target).toBeDefined();
            const presetId = target!.id;

            await toUser.call.deleteLobbyPreset({ presetId });
            await toUser.sync();

            const deleted = [...toUser.conn.db.LobbyPreset.iter()].find(p => p.id === presetId);
            expect(deleted).toBeUndefined();
        });

        it('not found error', async () => {
            const err = await expectReducerError(
                toUser.call.deleteLobbyPreset({ presetId: 999999 })
            );
            expect(err).toContain('Lobby preset not found.');
        });

        it('TO blocked from deleting another\'s preset', async () => {
            // modUser creates a preset
            await modUser.call.createLobbyPreset(presetArgs('Mod Delete Target'));
            await modUser.sync(1500);

            const modPresets = myPresets(modUser);
            const modPreset = modPresets.find(p => p.name === 'Mod Delete Target');
            expect(modPreset).toBeDefined();
            const modPresetId = modPreset!.id;

            // toUser (TournamentHost) tries to delete modUser's preset
            const err = await expectReducerError(
                toUser.call.deleteLobbyPreset({ presetId: modPresetId })
            );
            expect(err).toContain('You do not have permission to modify this preset.');
        });
    });
});
