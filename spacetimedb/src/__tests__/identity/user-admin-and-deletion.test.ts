// Identity: admin_update_user, delete_my_account and the user's presets and cost sets on deletion.
// Decisions: A45, A122
// Contracts: docs/auth/contract.md
// From S6, S10r (s6-rules.test.ts, s10r-triage-fixes.test.ts).
import { describe, expect, it } from 'vitest';
import { M, expectReject, guest, linkDiscord, lobbyRow, newHarness, setupLobby, tx } from '../fixtures/harness';
import { host, verified, fireDeletionJob, admin } from '../fixtures/identity';
import { presetArgs, presetNamed } from '../fixtures/lobby';
import { createTournament, openTournament, register } from '../fixtures/tournaments';

describe('A45(3): delete_my_account', () => {
    it('a verified user outside any lobby is deleted through performUserDeletion', () => {
        const test = newHarness();
        const v = guest(test, 'v');
        linkDiscord(test, v, 'discord-v', 'Verified');
        tx(test, v, (ctx) => M.delete_my_account(ctx, {}));
        expect(test.db.User.id.find(v.userId)).toBeNull();
        expect(test.db.UserIdentity.identity.find(v.identity)).toBeNull();
        expect(test.db.DeletedUser.id.find(v.userId)).not.toBeNull();
    });

    it('a guest keeps the old delete_guest_account behaviour (identity and user row removed)', () => {
        const test = newHarness();
        const g = guest(test, 'g');
        tx(test, g, (ctx) => M.delete_my_account(ctx, {}));
        expect(test.db.User.id.find(g.userId)).toBeNull();
        expect(test.db.UserIdentity.identity.find(g.identity)).toBeNull();
    });

    it('a verified user seated in a lobby is rejected', () => {
        const test = newHarness();
        const v = guest(test, 'v');
        linkDiscord(test, v, 'discord-v', 'Verified');
        setupLobby(test, { noStart: true, actors: { b1: v } });
        expectReject(test, v, (ctx) => M.delete_my_account(ctx, {}), /Leave your lobby/);
        expect(test.db.User.id.find(v.userId)).not.toBeNull();
    });
});

const adminUpdate = (userId: number, displayName: string, username: string, roleTag = 'User') =>
    (ctx: any) => M.admin_update_user(ctx, { userId, displayName, username, roleTag });

// ════════════════════════════════════════════════════════════════════════════
// L1: admin_update_user
// ════════════════════════════════════════════════════════════════════════════

describe('A122(1), L1: admin_update_user applies the player rename rules, renames the solo team, refuses a user pending deletion', () => {
    it('A122(1) L1: an empty or blank display name, an empty username and names over 32 characters are rejected with the rename texts', () => {
        const test = newHarness();
        const p = verified(test, 'neo');
        expectReject(test, 'internal', adminUpdate(p.userId, '   ', 'neo'), 'Display name cannot be empty');
        expectReject(test, 'internal', adminUpdate(p.userId, 'Neo', '  '), 'Username cannot be empty');
        expectReject(test, 'internal', adminUpdate(p.userId, 'N'.repeat(33), 'neo'), 'Display name must be 32 characters or fewer');
        expectReject(test, 'internal', adminUpdate(p.userId, 'Neo', 'n'.repeat(33)), 'Username must be 32 characters or fewer');
        expect(test.db.User.id.find(p.userId)!.displayName).toBe('neo');
    });

    it('A122(1) L1: a user pending deletion (deletedAt set) is refused', () => {
        const test = newHarness();
        const p = verified(test, 'neo');
        test.db.User.id.update({ ...test.db.User.id.find(p.userId)!, deletedAt: test.clock.now() });
        expectReject(test, 'internal', adminUpdate(p.userId, 'Neo', 'neo'), `User #${p.userId} is pending deletion.`);
    });

    it('A122(1) L1: a valid edit stores the trimmed names and renames the solo team of an active non-anonymous solo tournament', () => {
        const test = newHarness();
        const org = host(test, 'org');
        const tid = openTournament(test, org, { teamSize: 1 });
        const p = verified(test, 'neo');
        register(test, p, tid);
        const team = [...test.db.TournamentTeam.captain_user_id.filter(p.userId)][0];
        expect(team.name).toBe('neo');
        tx(test, 'internal', adminUpdate(p.userId, '  Trinity  ', '  trinity  ', 'TournamentHost'));
        const user = test.db.User.id.find(p.userId)!;
        expect([user.displayName, user.username, user.role.tag]).toEqual(['Trinity', 'trinity', 'TournamentHost']);
        expect(test.db.TournamentTeam.id.find(team.id)!.name).toBe('Trinity');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// L22 + L89: user deletion removes presets and unpublished cost sets
// ════════════════════════════════════════════════════════════════════════════

describe('A122(6), L22, L89: user deletion removes the user\'s presets and unpublished cost sets, keeping referenced ones', () => {
    it('A122(6) L22 L89: unreferenced preset and draft set deleted (set rows too); a preset and a set an unfinished tournament points at kept; a published set kept', () => {
        const test = newHarness();
        const org = host(test, 'org');
        tx(test, org, (ctx) => M.create_lobby_preset(ctx, presetArgs('P-free')));
        tx(test, org, (ctx) => M.create_lobby_preset(ctx, presetArgs('P-held')));
        const freeId = presetNamed(test, 'P-free')!.id;
        const heldId = presetNamed(test, 'P-held')!.id;
        const mkSet = (name: string) => {
            tx(test, org, (ctx) => M.create_cost_set(ctx, { name, sourceSetId: 0, gameModeTag: 'MemoryOfChaos' }));
            return [...test.db.CostSet.creator_id.filter(org.userId)].find((c) => c.name === name)!.id;
        };
        const draftFree = mkSet('draft-free');
        const draftHeld = mkSet('draft-held');
        const published = mkSet('published');
        test.db.CostSet.id.update({ ...test.db.CostSet.id.find(published)!, isPublished: true, isDraft: false });
        expect([...test.db.CostSetDraftCharacter.cost_set_id.filter(draftFree)].length).toBeGreaterThan(0);

        // An unfinished (Draft stage) tournament points at P-held and at draft-held.
        const tid = createTournament(test, org, { lobbyPresetId: heldId });
        test.db.Tournament.id.update({ ...test.db.Tournament.id.find(tid)!, costSetId: draftHeld });

        // S10s re-alignment (A124): a deletion sent as the SYSTEM user now cancels the organizer's tournaments, which would
        // end the reference this test needs; a staff Admin deletes instead (A121 hands the tournament to that Admin).
        const boss = admin(test, 'adm');
        tx(test, boss, (ctx) => M.admin_delete_row(ctx, { tableName: 'User', primaryKeyJson: String(org.userId) }));
        fireDeletionJob(test, org.userId);
        expect(test.db.User.id.find(org.userId)).toBeFalsy();
        expect(test.db.Tournament.id.find(tid)!.stage.tag).toBe('Draft');

        expect(test.db.LobbyPreset.id.find(freeId)).toBeFalsy();
        expect(test.db.LobbyPreset.id.find(heldId)).toBeTruthy();
        expect(test.db.CostSet.id.find(draftFree)).toBeFalsy();
        expect([...test.db.CostSetDraftCharacter.cost_set_id.filter(draftFree)]).toHaveLength(0);
        expect([...test.db.CostSetDraftLightcone.cost_set_id.filter(draftFree)]).toHaveLength(0);
        expect(test.db.CostSet.id.find(draftHeld)).toBeTruthy();
        expect(test.db.CostSet.id.find(published)).toBeTruthy();
        // The system preset is untouched.
        expect([...test.db.LobbyPreset.iter()].some((p) => p.isSystemPreset)).toBe(true);
    });

    it('A122(6) L89: an unpublished set a lobby still points at is kept', () => {
        const test = newHarness();
        const org = host(test, 'org');
        tx(test, org, (ctx) => M.create_cost_set(ctx, { name: 'draft-in-lobby', sourceSetId: 0, gameModeTag: 'MemoryOfChaos' }));
        const setId = [...test.db.CostSet.creator_id.filter(org.userId)].find((c) => c.name === 'draft-in-lobby')!.id;
        // Another user's lobby on the set (a set unpublished after the lobby selected it; written directly).
        const other = setupLobby(test, { noStart: true });
        test.db.Lobby.id.update({ ...lobbyRow(test, other.lobbyId), costSetId: setId });
        tx(test, 'internal', (ctx) => M.admin_delete_row(ctx, { tableName: 'User', primaryKeyJson: String(org.userId) }));
        fireDeletionJob(test, org.userId);
        expect(test.db.User.id.find(org.userId)).toBeFalsy();
        expect(test.db.CostSet.id.find(setId)).toBeTruthy();
        expect([...test.db.CostSetDraftCharacter.cost_set_id.filter(setId)].length).toBeGreaterThan(0);
    });

    it('A122(6) L22: a preset whose tournament has finished (Cancelled) is no longer held and goes with its creator', () => {
        const test = newHarness();
        const org = host(test, 'org');
        tx(test, org, (ctx) => M.create_lobby_preset(ctx, presetArgs('P-old')));
        const id = presetNamed(test, 'P-old')!.id;
        const tid = createTournament(test, org, { lobbyPresetId: id });
        test.db.Tournament.id.update({ ...test.db.Tournament.id.find(tid)!, stage: { tag: 'Cancelled' } as any });
        tx(test, 'internal', (ctx) => M.admin_delete_row(ctx, { tableName: 'User', primaryKeyJson: String(org.userId) }));
        fireDeletionJob(test, org.userId);
        expect(test.db.LobbyPreset.id.find(id)).toBeFalsy();
    });
});
