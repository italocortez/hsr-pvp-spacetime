// Lobby: a private lobby needs a password; the server join code; joining by code or by lobby id.
// Decisions: A99, A114, A116
// Contracts: docs/lobby/contract.md
// From S10h, S10n (s10h-lobby-rulings.test.ts, s10n-history-pages.test.ts).
import { describe, expect, expectTypeOf, it } from 'vitest';
import {
    DEFAULT_LOBBY_ARGS,
    M,
    expectReject,
    guest,
    lobbyRow,
    member,
    newHarness,
    tx,
    type Actor,
    type Harness,
} from '../fixtures/harness';
import { rejection } from '../fixtures/calendar-roster-rating-builders';
import { settingsFrom } from '../fixtures/ranked-game-builders';
import { join, lobbyOfHost, snap } from '../fixtures/lobby-action-helpers';
import { byKey, sidesOf } from '../fixtures/tournament-match-builders';
import { liveField } from '../fixtures/tournament-builders';

const PRIVATE_NEEDS_PASSWORD = 'A private lobby needs a password.'; // A99
const BAD_PASSWORD = 'Incorrect lobby password.';

// ════════════════════════════════════════════════════════════════════════════
// 6. A99: a private lobby needs a password
// ════════════════════════════════════════════════════════════════════════════

describe('A99: a private lobby needs a password', () => {
    const create = (test: Harness, who: Actor, over: Record<string, unknown>) =>
        tx(test, who, (ctx) => M.create_lobby(ctx, { ...DEFAULT_LOBBY_ARGS, ...over } as any));
    const passwordOf = (test: Harness, lobbyId: number) => test.db.LobbyPassword.lobbyId.find(lobbyId)?.passwordHash;

    it('A99 create_lobby: private with an empty password is rejected and creates nothing; with a password it is created and joinable only with it', () => {
        const test = newHarness();
        const h = guest(test, 'host');
        const lobbies = [...test.db.Lobby.iter()].length;
        const msg = rejection(test, h, (ctx) => M.create_lobby(ctx, { ...DEFAULT_LOBBY_ARGS, isPublic: false, password: '' } as any));
        expect([...test.db.Lobby.iter()]).toHaveLength(lobbies);
        expect([...test.db.LobbyMember.user_id.filter(h.userId)]).toHaveLength(0);
        expect(msg).toBe(PRIVATE_NEEDS_PASSWORD);

        create(test, h, { isPublic: false, password: 'pw' });
        const L = lobbyOfHost(test, h)!;
        expect(lobbyRow(test, L).isPublic).toBe(false);
        const j = guest(test, 'joiner');
        expect(rejection(test, j, (ctx) => M.join_lobby(ctx, { lobbyId: L, joinCode: '', password: '' }))).toBe(BAD_PASSWORD);
        expect(rejection(test, j, (ctx) => M.join_lobby(ctx, { lobbyId: L, joinCode: '', password: 'nope' }))).toBe(BAD_PASSWORD);
        join(test, j, L, 'pw');
        expect(member(test, L, j.userId)).toBeDefined();
    });

    it('A99 update_lobby_settings: a public lobby switched to private with an empty password is rejected and stays public', () => {
        const test = newHarness();
        const h = guest(test, 'host');
        create(test, h, {});
        const L = lobbyOfHost(test, h)!;
        const args = settingsFrom(test, L, { isPublic: false, password: '' });
        const before = snap([lobbyRow(test, L), passwordOf(test, L)]);
        const msg = rejection(test, h, (ctx) => M.update_lobby_settings(ctx, args));
        expect(snap([lobbyRow(test, L), passwordOf(test, L)])).toBe(before);
        expect(lobbyRow(test, L).isPublic).toBe(true);
        expect(msg).toBe(PRIVATE_NEEDS_PASSWORD);
    });

    it('A99 a private lobby that already has a password, updated with an empty password argument, keeps its password and stays joinable with it', () => {
        const test = newHarness();
        const h = guest(test, 'host');
        create(test, h, { isPublic: false, password: 'pw' });
        const L = lobbyOfHost(test, h)!;
        const args = settingsFrom(test, L, { isPublic: false, password: '', standardTurnSeconds: 90 });
        tx(test, h, (ctx) => M.update_lobby_settings(ctx, args));
        expect(lobbyRow(test, L).standardTurnSeconds).toBe(90);
        expect(lobbyRow(test, L).isPublic).toBe(false);
        expect(passwordOf(test, L)).toBe('pw');
        const j = guest(test, 'joiner');
        expect(rejection(test, j, (ctx) => M.join_lobby(ctx, { lobbyId: L, joinCode: '', password: '' }))).toBe(BAD_PASSWORD);
        join(test, j, L, 'pw');
        expect(member(test, L, j.userId)).toBeDefined();
    });

    // The brief's "switched public and back to private with an empty argument keeps its password" cannot hold together
    // with the private -> public flow step 9 (the switch to public deletes the LobbyPassword row; s10-lobby.test.ts),
    // so the lobby has no password when it goes back: A99 rejects that switch. Reported in the T-S10h report.
    it('A99 a lobby switched from private to public (its password row deleted, flow step 9) cannot go back to private with an empty password; with a new one it can', () => {
        const test = newHarness();
        const h = guest(test, 'host');
        create(test, h, { isPublic: false, password: 'pw' });
        const L = lobbyOfHost(test, h)!;
        const toPublic = settingsFrom(test, L, { isPublic: true, password: '' });
        tx(test, h, (ctx) => M.update_lobby_settings(ctx, toPublic));
        expect(passwordOf(test, L)).toBeUndefined();
        const back = settingsFrom(test, L, { isPublic: false, password: '' });
        const msg = rejection(test, h, (ctx) => M.update_lobby_settings(ctx, back));
        expect(lobbyRow(test, L).isPublic).toBe(true);
        expect(msg).toBe(PRIVATE_NEEDS_PASSWORD);
        const withNew = settingsFrom(test, L, { isPublic: false, password: 'pw2' });
        tx(test, h, (ctx) => M.update_lobby_settings(ctx, withNew));
        expect(passwordOf(test, L)).toBe('pw2');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// A114 / A116: create_lobby and create_tournament_lobby send no join code (and create_lobby no preset)
// ════════════════════════════════════════════════════════════════════════════

const hostedBy = (test: Harness, who: Actor) => [...test.db.Lobby.host_user_id.filter(who.userId)][0];

describe('A114 / A116: the server generates the join code; joining by code or by lobby id', () => {
    it('create_lobby takes no joinCode and no presetId (A114(2), A116)', () => {
        type CreateArgs = Parameters<typeof M.create_lobby>[1];
        expectTypeOf<CreateArgs>().not.toHaveProperty('joinCode');
        expectTypeOf<CreateArgs>().not.toHaveProperty('presetId');
        type TournamentArgs = Parameters<typeof M.create_tournament_lobby>[1];
        expectTypeOf<TournamentArgs>().not.toHaveProperty('joinCode');
        expect('joinCode' in DEFAULT_LOBBY_ARGS).toBe(false);
    });

    it('create_lobby without the removed arguments: a server code; one player joins by that code, another by the lobby id (A114(1)(2), A116)', () => {
        const test = newHarness();
        const host = guest(test, 'h');
        tx(test, host, (ctx) => M.create_lobby(ctx, { ...DEFAULT_LOBBY_ARGS } as any));
        const lobby = hostedBy(test, host);
        expect(lobby.joinCode).toMatch(/^[A-Z0-9]{6}$/);
        expect(test.db.Lobby.joinCode.find(lobby.joinCode)!.id).toBe(lobby.id);
        const byCode = guest(test, 'byCode');
        const byId = guest(test, 'byId');
        tx(test, byCode, (ctx) => M.join_lobby(ctx, { lobbyId: 0, joinCode: lobby.joinCode, password: '' }));
        tx(test, byId, (ctx) => M.join_lobby(ctx, { lobbyId: lobby.id, joinCode: '', password: '' }));
        expect(member(test, lobby.id, byCode.userId)).toBeTruthy();
        expect(member(test, lobby.id, byId.userId)).toBeTruthy();
    });

    it('a private lobby still needs its password on both paths (A114(1), D-02)', () => {
        const test = newHarness();
        const host = guest(test, 'ph');
        tx(test, host, (ctx) => M.create_lobby(ctx, { ...DEFAULT_LOBBY_ARGS, isPublic: false, password: 'pw' } as any));
        const lobby = hostedBy(test, host);
        const byCode = guest(test, 'pCode');
        const byId = guest(test, 'pId');
        for (const password of ['', 'wrong']) {
            expectReject(test, byCode, (ctx) => M.join_lobby(ctx, { lobbyId: 0, joinCode: lobby.joinCode, password }), 'Incorrect lobby password.');
            expectReject(test, byId, (ctx) => M.join_lobby(ctx, { lobbyId: lobby.id, joinCode: '', password }), 'Incorrect lobby password.');
        }
        expect(member(test, lobby.id, byCode.userId)).toBeFalsy();
        tx(test, byCode, (ctx) => M.join_lobby(ctx, { lobbyId: 0, joinCode: lobby.joinCode, password: 'pw' }));
        tx(test, byId, (ctx) => M.join_lobby(ctx, { lobbyId: lobby.id, joinCode: '', password: 'pw' }));
        expect(member(test, lobby.id, byCode.userId)).toBeTruthy();
        expect(member(test, lobby.id, byId.userId)).toBeTruthy();
    });

    it('create_tournament_lobby without a joinCode: a server code; a player of the match joins by it and is seated on their side (A114(1)(2))', () => {
        const f = liveField(2);
        const m = byKey(f.test, f.id, 'W-R1-M1');
        const { blue, red } = sidesOf(f, m.id);
        tx(f.test, f.org, (ctx) => M.create_tournament_lobby(ctx, { bracketMatchId: m.id }));
        const lobby = hostedBy(f.test, f.org);
        expect(lobby.joinCode).toMatch(/^[A-Z0-9]{6}$/);
        tx(f.test, red.captain, (ctx) => M.join_lobby(ctx, { lobbyId: 0, joinCode: lobby.joinCode, password: '' }));
        tx(f.test, blue.captain, (ctx) => M.join_lobby(ctx, { lobbyId: lobby.id, joinCode: '', password: '' }));
        expect(member(f.test, lobby.id, red.captain.userId).lobbySlot.tag).toBe('RedPlayer');
        expect(member(f.test, lobby.id, blue.captain.userId).lobbySlot.tag).toBe('BluePlayer');
        expect(lobbyRow(f.test, lobby.id).tournamentId).toBe(f.id);
    });
});
