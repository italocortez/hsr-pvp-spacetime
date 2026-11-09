// T-S10 batch A1: in-memory port of the live lobby suites (test/backend/lobby/lobby-lifecycle, lobby-settings,
// lobby-presets) plus two folds (match-results/referee-coach: the reclaim no-op; lobby/lobby-tournament: approve_stand_in
// with an unknown user). Only the gaps of the S10 inventory are ported; what the S4–S9c suites already cover is not
// repeated. Every `it` cites its docs/lobby/contract.md scenario or decision. Members are targeted by seat (A74).
// In-memory datastore on the TestClock; nothing reaches maincloud.
import { describe, expect, it } from 'vitest';
import {
    DEFAULT_LOBBY_ARGS,
    M,
    expectReject,
    guest,
    lobbyRow,
    member,
    newHarness,
    seatOf,
    setupLobby,
    tx,
    type Actor,
    type Harness,
} from './s4-fixtures';
import { host as tournamentHost, moderator, setUserRole, verified, liveField } from './s8-fixtures';
import { byKey, createTournamentLobby } from './s8d-fixtures';
import {
    createLobby,
    joinLobby,
    lobbyMembers,
    presetArgs,
    presetNamed,
    presetsOf,
    settingsArgs,
    systemPreset,
    updatePresetArgs,
} from './s10-a1-fixtures';

// ─── Messages (docs/lobby/contract.md error tables) ──────────────────────────

const ALREADY_IN = 'You are already in a lobby. Leave it before creating or joining another.';
const GUEST_RANKED = 'Guests cannot create or join Ranked lobbies.';
const BAD_PASSWORD = 'Incorrect lobby password.';
const BANNED = 'You are banned from this lobby.';
const NOT_FOUND = 'Lobby not found.';
const HOST_OR_ABOVE = 'Only the host, moderators, or admins can perform this action.';
const NOT_MEMBER = 'You are not a member of this lobby.';
const COACH_PERM = 'Only the lobby host or referee can assign the coach role.';
const COACH_CAPTAIN = 'A coach cannot be assigned as captain.';
const stageMsg = (stage: string) => `This action is not allowed in the current lobby stage (${stage}).`;
const PRESET_ROLE = 'Only Tournament Hosts, Moderators, and Admins can create lobby presets.';
const PRESET_NAME = 'Preset name must be between 1 and 50 characters.';
const PRESET_PERM = 'You do not have permission to modify this preset.';
const PRESET_NOT_FOUND = 'Lobby preset not found.';
const SYSTEM_ONLY_ADMIN = 'Only admins can modify or delete system presets.';
const SYSTEM_NO_DELETE = 'The system lobby preset cannot be deleted.';
const PRESET_LIMIT = 'Preset limit reached: you can own at most 10 lobby presets. Delete one first.';

const admin = (test: Harness, name = 'adm'): Actor => {
    const a = verified(test, name);
    setUserRole(test, a.userId, 'Admin');
    return a;
};

/** A Waiting lobby hosted by `host` (a guest unless given) with `names` joined as Spectators, in order. */
function waitingLobby(test: Harness, names: string[], over: Record<string, unknown> = {}, hostActor?: Actor) {
    const host = hostActor ?? guest(test, 'host');
    const lobbyId = createLobby(test, host, over);
    const a: Record<string, Actor> = {};
    for (const n of names) {
        a[n] = guest(test, n);
        joinLobby(test, a[n], lobbyId);
    }
    return { lobbyId, host, a };
}

const slotOf = (test: Harness, lobbyId: number, who: Actor) => member(test, lobbyId, who.userId).lobbySlot.tag;
const hostMoves = (test: Harness, host: Actor, lobbyId: number, who: Actor, slot: string) =>
    tx(test, host, (ctx) => M.set_team_slot(ctx, { lobbyId, targetJoinSeq: seatOf(ctx, lobbyId, who.userId), lobbySlot: { tag: slot } as any }));
const selfMove = (test: Harness, who: Actor, lobbyId: number, slot: string) =>
    tx(test, who, (ctx) => M.set_team_slot(ctx, { lobbyId, lobbySlot: { tag: slot } as any }));

// ─── create_lobby ─────────────────────────────────────────────────────────────

describe('create_lobby', () => {
    it('Lobby Creation (Happy Path): Waiting, count 1, a 6-char join code; the host is a Spectator referee, not confirmed, not captain (D-24, D-27)', () => {
        const test = newHarness();
        const host = guest(test, 'host');
        const lobbyId = createLobby(test, host);
        const l = lobbyRow(test, lobbyId);
        expect(l.stage.tag).toBe('Waiting');
        expect(l.currentPlayerCount).toBe(1);
        expect(l.hostUserId).toBe(host.userId);
        expect(l.isPublic).toBe(true);
        expect(l.joinCode).toHaveLength(6); // create_lobby flow step 4: a 6-char code
        const rows = lobbyMembers(test, lobbyId);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ userId: host.userId, isReferee: true, isConfirmed: false, isCaptain: false });
        expect(rows[0].lobbySlot.tag).toBe('Spectator');
    });

    it('Lobby Creation (One Per User): a second create_lobby is rejected (D-22)', () => {
        const test = newHarness();
        const host = guest(test, 'host');
        createLobby(test, host);
        expectReject(test, host, (ctx) => M.create_lobby(ctx, DEFAULT_LOBBY_ARGS as any), ALREADY_IN);
        expect([...test.db.Lobby.iter()].filter((l) => l.hostUserId === host.userId)).toHaveLength(1);
    });

    it('Guest Creates Casual Lobby: rosterVisibility is forced to ClosedNoRating (D-23)', () => {
        const test = newHarness();
        const g = guest(test, 'g');
        const lobbyId = createLobby(test, g, { rosterVisibility: { tag: 'OpenRoster' } });
        expect(lobbyRow(test, lobbyId).rosterVisibility.tag).toBe('ClosedNoRating');
    });

    it('Guest Blocked from Ranked Lobby: create and join are both rejected (D-23)', () => {
        const test = newHarness();
        const g = guest(test, 'g');
        expectReject(test, g, (ctx) => M.create_lobby(ctx, { ...DEFAULT_LOBBY_ARGS, matchType: { tag: 'Ranked' } } as any), GUEST_RANKED);
        expect([...test.db.Lobby.iter()].filter((l) => l.hostUserId === g.userId)).toHaveLength(0);
        const v = verified(test, 'v');
        const lobbyId = createLobby(test, v, { matchType: { tag: 'Ranked' } });
        expectReject(test, g, (ctx) => M.join_lobby(ctx, { lobbyId, joinCode: '', password: '' }), GUEST_RANKED);
    });

    it('Ranked Lobby Forces No Mirror Picks: allowMirrorPicks=true is stored false (D-42)', () => {
        const test = newHarness();
        const v = verified(test, 'v');
        const lobbyId = createLobby(test, v, { matchType: { tag: 'Ranked' }, allowMirrorPicks: true });
        expect(lobbyRow(test, lobbyId).allowMirrorPicks).toBe(false);
    });

    it('Private Lobby with Password: LobbyPassword row holds the password; an empty password inserts no row (D-02, edge case)', () => {
        const test = newHarness();
        const host = guest(test, 'host');
        const lobbyId = createLobby(test, host, { isPublic: false, password: 'secret' });
        expect(lobbyRow(test, lobbyId).isPublic).toBe(false);
        expect(test.db.LobbyPassword.lobbyId.find(lobbyId)!.passwordHash).toBe('secret');

        const other = guest(test, 'other');
        const openId = createLobby(test, other, { isPublic: false, password: '' });
        expect(test.db.LobbyPassword.lobbyId.find(openId)).toBeNull();
    });
});

// ─── join_lobby ──────────────────────────────────────────────────────────────

describe('join_lobby', () => {
    it('Join by Lobby ID: the joiner sits on Spectator (not referee, not confirmed); currentPlayerCount + 1 (D-27)', () => {
        const test = newHarness();
        const { lobbyId, a } = waitingLobby(test, ['j']);
        const row = member(test, lobbyId, a.j.userId);
        expect(row.lobbySlot.tag).toBe('Spectator');
        expect(row).toMatchObject({ isReferee: false, isConfirmed: false, isCaptain: false });
        expect(lobbyRow(test, lobbyId).currentPlayerCount).toBe(2);
    });

    it('Join by Join Code: lobbyId 0 with the code joins the lobby (D-03)', () => {
        const test = newHarness();
        const host = guest(test, 'host');
        const lobbyId = createLobby(test, host);
        const j = guest(test, 'j');
        joinLobby(test, j, 0, '', lobbyRow(test, lobbyId).joinCode);
        expect(member(test, lobbyId, j.userId)).toBeDefined();
    });

    it('join_lobby with an unknown id or code is rejected "Lobby not found." (error table)', () => {
        const test = newHarness();
        const j = guest(test, 'j');
        expectReject(test, j, (ctx) => M.join_lobby(ctx, { lobbyId: 9999, joinCode: '', password: '' }), NOT_FOUND);
        expectReject(test, j, (ctx) => M.join_lobby(ctx, { lobbyId: 0, joinCode: 'ZZZZZZ', password: '' }), NOT_FOUND);
    });

    it('Join Private Lobby: the wrong password is rejected, the right one joins (D-02)', () => {
        const test = newHarness();
        const host = guest(test, 'host');
        const lobbyId = createLobby(test, host, { isPublic: false, password: 'secret' });
        const j = guest(test, 'j');
        expectReject(test, j, (ctx) => M.join_lobby(ctx, { lobbyId, joinCode: '', password: 'wrong' }), BAD_PASSWORD);
        expectReject(test, j, (ctx) => M.join_lobby(ctx, { lobbyId, joinCode: '', password: '' }), BAD_PASSWORD);
        expect(member(test, lobbyId, j.userId)).toBeUndefined();
        joinLobby(test, j, lobbyId, 'secret');
        expect(member(test, lobbyId, j.userId)).toBeDefined();
    });

    it('Join Banned User: a member banned by seat cannot join again (D-21, A74(2))', () => {
        const test = newHarness();
        const { lobbyId, host, a } = waitingLobby(test, ['j']);
        tx(test, host, (ctx) => M.ban_member(ctx, { lobbyId, targetJoinSeq: seatOf(ctx, lobbyId, a.j.userId) }));
        expect(member(test, lobbyId, a.j.userId)).toBeUndefined();
        expectReject(test, a.j, (ctx) => M.join_lobby(ctx, { lobbyId, joinCode: '', password: '' }), BANNED);
    });

    it('One lobby at a time: joining a second lobby is rejected (D-22)', () => {
        const test = newHarness();
        const { a } = waitingLobby(test, ['j']);
        const other = guest(test, 'other');
        const secondId = createLobby(test, other);
        expectReject(test, a.j, (ctx) => M.join_lobby(ctx, { lobbyId: secondId, joinCode: '', password: '' }), ALREADY_IN);
        expect(member(test, secondId, a.j.userId)).toBeUndefined();
    });
});

// ─── leave_lobby / close_lobby ────────────────────────────────────────────────

describe('leave_lobby / close_lobby', () => {
    it('Leave Lobby: the row is deleted and currentPlayerCount drops (Waiting)', () => {
        const test = newHarness();
        const { lobbyId, a } = waitingLobby(test, ['j', 'k']);
        expect(lobbyRow(test, lobbyId).currentPlayerCount).toBe(3);
        tx(test, a.j, (ctx) => M.leave_lobby(ctx, { lobbyId }));
        expect(member(test, lobbyId, a.j.userId)).toBeUndefined();
        expect(lobbyRow(test, lobbyId).currentPlayerCount).toBe(2);
    });

    it('Leave Lobby (Auto-Close Empty): the only member leaving a Waiting lobby deletes it', () => {
        const test = newHarness();
        const host = guest(test, 'host');
        const lobbyId = createLobby(test, host, { isPublic: false, password: 'pw' });
        tx(test, host, (ctx) => M.leave_lobby(ctx, { lobbyId }));
        expect(test.db.Lobby.id.find(lobbyId)).toBeNull();
        expect(lobbyMembers(test, lobbyId)).toHaveLength(0);
        expect(test.db.LobbyPassword.lobbyId.find(lobbyId)).toBeNull();
    });

    it('Close Lobby (Host): Lobby, LobbyMember, LobbyBan and LobbyPassword rows are all deleted (D-19)', () => {
        const test = newHarness();
        const host = guest(test, 'host');
        const lobbyId = createLobby(test, host, { isPublic: false, password: 'pw' });
        const j = guest(test, 'j');
        const b = guest(test, 'b');
        joinLobby(test, j, lobbyId, 'pw');
        joinLobby(test, b, lobbyId, 'pw');
        tx(test, host, (ctx) => M.ban_member(ctx, { lobbyId, targetJoinSeq: seatOf(ctx, lobbyId, b.userId) }));
        expect([...test.db.LobbyBan.lobby_id.filter(lobbyId)]).toHaveLength(1);

        tx(test, host, (ctx) => M.close_lobby(ctx, { lobbyId }));
        expect(test.db.Lobby.id.find(lobbyId)).toBeNull();
        expect(lobbyMembers(test, lobbyId)).toHaveLength(0);
        expect([...test.db.LobbyBan.lobby_id.filter(lobbyId)]).toHaveLength(0);
        expect(test.db.LobbyPassword.lobbyId.find(lobbyId)).toBeNull();
    });

    it('close_lobby permission: a plain member is rejected; a Moderator who is not a member closes it (D-21)', () => {
        const test = newHarness();
        const { lobbyId, a } = waitingLobby(test, ['j']);
        expectReject(test, a.j, (ctx) => M.close_lobby(ctx, { lobbyId }), HOST_OR_ABOVE);
        expect(lobbyRow(test, lobbyId)).toBeDefined();
        const mod = moderator(test);
        tx(test, mod, (ctx) => M.close_lobby(ctx, { lobbyId }));
        expect(test.db.Lobby.id.find(lobbyId)).toBeNull();
    });

    it('Close Lobby (Drafting Stage — Blocked): rejected with the stage text (D-20)', () => {
        const test = newHarness();
        const s = setupLobby(test);
        expectReject(test, s.host, (ctx) => M.close_lobby(ctx, { lobbyId: s.lobbyId }), stageMsg('Drafting'));
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('Drafting');
    });
});

// ─── update_lobby_settings ────────────────────────────────────────────────────

describe('update_lobby_settings', () => {
    it('the host changes draftMode and standardTurnSeconds in Waiting; the values persist', () => {
        const test = newHarness();
        const host = guest(test, 'host');
        const lobbyId = createLobby(test, host);
        tx(test, host, (ctx) => M.update_lobby_settings(ctx, settingsArgs(lobbyId, { draftMode: { tag: 'Auction' }, standardTurnSeconds: 90 })));
        const l = lobbyRow(test, lobbyId);
        expect(l.draftMode.tag).toBe('Auction');
        expect(l.standardTurnSeconds).toBe(90);
    });

    it('a member who is not host / Moderator / Admin is rejected; the settings are unchanged (D-21)', () => {
        const test = newHarness();
        const { lobbyId, a } = waitingLobby(test, ['j']);
        expectReject(test, a.j, (ctx) => M.update_lobby_settings(ctx, settingsArgs(lobbyId, { standardTurnSeconds: 90 })), HOST_OR_ABOVE);
        expect(lobbyRow(test, lobbyId).standardTurnSeconds).toBe(30);
    });

    it('public → private with a password: the wrong password is rejected, the new one joins (D-02, flow step 9)', () => {
        const test = newHarness();
        const host = guest(test, 'host');
        const lobbyId = createLobby(test, host);
        tx(test, host, (ctx) => M.update_lobby_settings(ctx, settingsArgs(lobbyId, { isPublic: false, password: 'newsecret' })));
        expect(lobbyRow(test, lobbyId).isPublic).toBe(false);
        const j = guest(test, 'j');
        expectReject(test, j, (ctx) => M.join_lobby(ctx, { lobbyId, joinCode: '', password: 'wrong' }), BAD_PASSWORD);
        joinLobby(test, j, lobbyId, 'newsecret');
        expect(member(test, lobbyId, j.userId)).toBeDefined();
    });

    it('private → public: the LobbyPassword row is deleted and a join without a password succeeds (flow step 9)', () => {
        const test = newHarness();
        const host = guest(test, 'host');
        const lobbyId = createLobby(test, host, { isPublic: false, password: 'secret' });
        tx(test, host, (ctx) => M.update_lobby_settings(ctx, settingsArgs(lobbyId, { isPublic: true, password: '' })));
        expect(lobbyRow(test, lobbyId).isPublic).toBe(true);
        expect(test.db.LobbyPassword.lobbyId.find(lobbyId)).toBeNull();
        const j = guest(test, 'j');
        joinLobby(test, j, lobbyId);
        expect(member(test, lobbyId, j.userId)).toBeDefined();
    });

    it('Update Settings (Blocked During Drafting): rejected with the stage text (D-28)', () => {
        const test = newHarness();
        const s = setupLobby(test);
        expectReject(test, s.host, (ctx) => M.update_lobby_settings(ctx, settingsArgs(s.lobbyId, { standardTurnSeconds: 90 })), stageMsg('Drafting'));
    });
});

// ─── set_team_slot ────────────────────────────────────────────────────────────

describe('set_team_slot (A74: the host names a seat, a self-move omits it)', () => {
    it('Set Team Slot (Coach Assignment by Host): the host seats a Spectator on BlueCoach', () => {
        const test = newHarness();
        const { lobbyId, host, a } = waitingLobby(test, ['m'], { teamSize: 3 });
        hostMoves(test, host, lobbyId, a.m, 'BlueCoach');
        expect(slotOf(test, lobbyId, a.m)).toBe('BlueCoach');
    });

    it('Set Team Slot (Coach Self-Assignment Blocked): a plain member cannot take a coach slot', () => {
        const test = newHarness();
        const { lobbyId, a } = waitingLobby(test, ['m'], { teamSize: 3 });
        expectReject(test, a.m, (ctx) => M.set_team_slot(ctx, { lobbyId, lobbySlot: { tag: 'BlueCoach' } as any }), COACH_PERM);
        expect(slotOf(test, lobbyId, a.m)).toBe('Spectator');
    });

    it('Set Team Slot (Team Full): teamSize 1, a second BluePlayer is rejected', () => {
        const test = newHarness();
        const { lobbyId, a } = waitingLobby(test, ['m1', 'm2'], { teamSize: 1 });
        selfMove(test, a.m1, lobbyId, 'BluePlayer');
        expectReject(test, a.m2, (ctx) => M.set_team_slot(ctx, { lobbyId, lobbySlot: { tag: 'BluePlayer' } as any }), 'Blue team is full (max 1 players).');
        expect(slotOf(test, lobbyId, a.m2)).toBe('Spectator');
    });

    it('Set Team Slot (Duplicate Coach): a second Blue coach is rejected', () => {
        const test = newHarness();
        const { lobbyId, host, a } = waitingLobby(test, ['m1', 'm2'], { teamSize: 3 });
        hostMoves(test, host, lobbyId, a.m1, 'BlueCoach');
        expectReject(test, host, (ctx) =>
            M.set_team_slot(ctx, { lobbyId, targetJoinSeq: seatOf(ctx, lobbyId, a.m2.userId), lobbySlot: { tag: 'BlueCoach' } as any }),
            'Blue team already has a coach.');
        expect(slotOf(test, lobbyId, a.m2)).toBe('Spectator');
    });

    it('a slot move resets isConfirmed (Set Team Slot scenarios: "isConfirmed reset to false")', () => {
        const test = newHarness();
        const { lobbyId, a } = waitingLobby(test, ['m'], { teamSize: 3 });
        selfMove(test, a.m, lobbyId, 'BluePlayer');
        tx(test, a.m, (ctx) => M.confirm_ready(ctx, { lobbyId }));
        expect(member(test, lobbyId, a.m.userId).isConfirmed).toBe(true);
        selfMove(test, a.m, lobbyId, 'RedPlayer');
        expect(member(test, lobbyId, a.m.userId).lobbySlot.tag).toBe('RedPlayer');
        expect(member(test, lobbyId, a.m.userId).isConfirmed).toBe(false);
    });

    it('set_team_slot during Drafting is rejected by the stage guard (edge case, D-28)', () => {
        const test = newHarness();
        const s = setupLobby(test);
        expectReject(test, s.a.b1, (ctx) => M.set_team_slot(ctx, { lobbyId: s.lobbyId, lobbySlot: { tag: 'Spectator' } as any }), stageMsg('Drafting'));
    });
});

// ─── confirm_ready / unconfirm_ready / set_captain ───────────────────────────

describe('confirm_ready / unconfirm_ready / set_captain', () => {
    it('Confirm Ready / Unconfirm Ready: the flag is set, then cleared', () => {
        const test = newHarness();
        const { lobbyId, a } = waitingLobby(test, ['m']);
        tx(test, a.m, (ctx) => M.confirm_ready(ctx, { lobbyId }));
        expect(member(test, lobbyId, a.m.userId).isConfirmed).toBe(true);
        tx(test, a.m, (ctx) => M.unconfirm_ready(ctx, { lobbyId }));
        expect(member(test, lobbyId, a.m.userId).isConfirmed).toBe(false);
    });

    it('confirm_ready by a non-member is rejected (error table)', () => {
        const test = newHarness();
        const { lobbyId } = waitingLobby(test, []);
        const outsider = guest(test, 'outsider');
        expectReject(test, outsider, (ctx) => M.confirm_ready(ctx, { lobbyId }), NOT_MEMBER);
    });

    it('unconfirm_ready during Drafting is rejected by the stage guard (edge case, D-28)', () => {
        const test = newHarness();
        const s = setupLobby(test);
        expectReject(test, s.a.b1, (ctx) => M.unconfirm_ready(ctx, { lobbyId: s.lobbyId }), stageMsg('Drafting'));
        expect(member(test, s.lobbyId, s.a.b1.userId).isConfirmed).toBe(true);
    });

    it('Set Captain (Coach Blocked): the host naming a coach\'s seat is rejected', () => {
        const test = newHarness();
        const { lobbyId, host, a } = waitingLobby(test, ['m'], { teamSize: 1 });
        hostMoves(test, host, lobbyId, a.m, 'BlueCoach');
        expectReject(test, host, (ctx) => M.set_captain(ctx, { lobbyId, targetJoinSeq: seatOf(ctx, lobbyId, a.m.userId) }), COACH_CAPTAIN);
        expect(member(test, lobbyId, a.m.userId).isCaptain).toBe(false);
    });
});

// ─── Referee and tournament folds ─────────────────────────────────────────────

describe('folds: reclaim_referee no-op, approve_stand_in unknown user', () => {
    it('reclaim_referee by the host who already holds the flag changes nothing (referee-coach fold; D.8.4)', () => {
        const test = newHarness();
        const { lobbyId, host, a } = waitingLobby(test, ['m']);
        tx(test, host, (ctx) => M.reclaim_referee(ctx, { lobbyId }));
        expect(member(test, lobbyId, host.userId).isReferee).toBe(true);
        expect(member(test, lobbyId, a.m.userId).isReferee).toBe(false);
        expect(lobbyMembers(test, lobbyId).filter((m) => m.isReferee)).toHaveLength(1);
    });

    it('Approve Stand-In (Target User Not Found): an unknown user id is rejected; no TournamentStandIn row', () => {
        const f = liveField(2);
        const m = byKey(f.test, f.id, 'W-R1-M1');
        createTournamentLobby(f.test, f.org, m.id);
        expectReject(f.test, f.org, (ctx) => M.approve_stand_in(ctx, { bracketMatchId: m.id, teamId: m.team1Id!, userId: 999_999 }), 'Target user not found.');
        expect([...f.test.db.TournamentStandIn.iter()]).toHaveLength(0);
    });
});

// ─── Presets (D-31b, B-7, A33a) ──────────────────────────────────────────────

describe('lobby presets', () => {
    it('Create Lobby Preset (TO): creatorUserId is the caller, isSystemPreset false', () => {
        const test = newHarness();
        const to = tournamentHost(test, 'to');
        tx(test, to, (ctx) => M.create_lobby_preset(ctx, presetArgs('TO Preset')));
        const p = presetNamed(test, 'TO Preset')!;
        expect(p.creatorUserId).toBe(to.userId);
        expect(p.isSystemPreset).toBe(false);
    });

    it('Create Lobby Preset (User Role Blocked): a verified User is rejected', () => {
        const test = newHarness();
        const user = verified(test, 'u');
        expectReject(test, user, (ctx) => M.create_lobby_preset(ctx, presetArgs('Regular Preset')), PRESET_ROLE);
        expect(presetsOf(test, user.userId)).toHaveLength(0);
    });

    it('name 1-50: "" and 51 characters are rejected on create; exactly 50 is accepted (edge cases)', () => {
        const test = newHarness();
        const to = tournamentHost(test, 'to');
        expectReject(test, to, (ctx) => M.create_lobby_preset(ctx, presetArgs('')), PRESET_NAME);
        expectReject(test, to, (ctx) => M.create_lobby_preset(ctx, presetArgs('A'.repeat(51))), PRESET_NAME);
        tx(test, to, (ctx) => M.create_lobby_preset(ctx, presetArgs('A'.repeat(50))));
        expect(presetsOf(test, to.userId).map((p) => p.name)).toEqual(['A'.repeat(50)]);
    });

    it('Update Lobby Preset (Owner): the owner renames it; an empty name on update is rejected', () => {
        const test = newHarness();
        const to = tournamentHost(test, 'to');
        tx(test, to, (ctx) => M.create_lobby_preset(ctx, presetArgs('TO Preset')));
        const presetId = presetNamed(test, 'TO Preset')!.id;
        tx(test, to, (ctx) => M.update_lobby_preset(ctx, updatePresetArgs(presetId, 'Updated Preset')));
        expect(test.db.LobbyPreset.id.find(presetId)!.name).toBe('Updated Preset');
        expectReject(test, to, (ctx) => M.update_lobby_preset(ctx, updatePresetArgs(presetId, '')), PRESET_NAME);
        expect(test.db.LobbyPreset.id.find(presetId)!.name).toBe('Updated Preset');
    });

    it('Update Lobby Preset (TO on Another\'s Preset — Blocked); a Moderator may update a TO\'s preset (edge case)', () => {
        const test = newHarness();
        const to = tournamentHost(test, 'to');
        const mod = moderator(test);
        tx(test, mod, (ctx) => M.create_lobby_preset(ctx, presetArgs('Mod Preset')));
        const modPresetId = presetNamed(test, 'Mod Preset')!.id;
        expectReject(test, to, (ctx) => M.update_lobby_preset(ctx, updatePresetArgs(modPresetId, 'Hijacked')), PRESET_PERM);
        expect(test.db.LobbyPreset.id.find(modPresetId)!.name).toBe('Mod Preset');

        tx(test, to, (ctx) => M.create_lobby_preset(ctx, presetArgs('TO Preset')));
        const toPresetId = presetNamed(test, 'TO Preset')!.id;
        tx(test, mod, (ctx) => M.update_lobby_preset(ctx, updatePresetArgs(toPresetId, 'Mod Updated TO Preset')));
        expect(test.db.LobbyPreset.id.find(toPresetId)!.name).toBe('Mod Updated TO Preset');
    });

    it('Delete Lobby Preset: the owner deletes it; a missing id is "Lobby preset not found."; a TO cannot delete another\'s', () => {
        const test = newHarness();
        const to = tournamentHost(test, 'to');
        const mod = moderator(test);
        tx(test, to, (ctx) => M.create_lobby_preset(ctx, presetArgs('To Be Deleted')));
        const presetId = presetNamed(test, 'To Be Deleted')!.id;
        tx(test, to, (ctx) => M.delete_lobby_preset(ctx, { presetId }));
        expect(test.db.LobbyPreset.id.find(presetId)).toBeNull();
        expectReject(test, to, (ctx) => M.delete_lobby_preset(ctx, { presetId: 999_999 }), PRESET_NOT_FOUND);

        tx(test, mod, (ctx) => M.create_lobby_preset(ctx, presetArgs('Mod Delete Target')));
        const modPresetId = presetNamed(test, 'Mod Delete Target')!.id;
        expectReject(test, to, (ctx) => M.delete_lobby_preset(ctx, { presetId: modPresetId }), PRESET_PERM);
        expect(test.db.LobbyPreset.id.find(modPresetId)).toBeDefined();
    });

    it('Preset Cap (B-7): a TO with 10 presets is rejected on the 11th', () => {
        const test = newHarness();
        const to = tournamentHost(test, 'to');
        for (let i = 0; i < 10; i++) tx(test, to, (ctx) => M.create_lobby_preset(ctx, presetArgs(`p${i}`)));
        expectReject(test, to, (ctx) => M.create_lobby_preset(ctx, presetArgs('p10')), PRESET_LIMIT);
        expect(presetsOf(test, to.userId)).toHaveLength(10);
    });

    it('System Preset (A33a): an Admin edits it; a Moderator and a TO are rejected; delete is rejected for everyone, Admin included', () => {
        const test = newHarness();
        const presetId = systemPreset(test).id;
        const adm = admin(test);
        const mod = moderator(test);
        const to = tournamentHost(test, 'to');

        tx(test, adm, (ctx) => M.update_lobby_preset(ctx, updatePresetArgs(presetId, 'Tournament default (edited)')));
        expect(test.db.LobbyPreset.id.find(presetId)!.name).toBe('Tournament default (edited)');
        expect(test.db.LobbyPreset.id.find(presetId)!.isSystemPreset).toBe(true);

        expectReject(test, mod, (ctx) => M.update_lobby_preset(ctx, updatePresetArgs(presetId, 'mod')), SYSTEM_ONLY_ADMIN);
        expectReject(test, to, (ctx) => M.update_lobby_preset(ctx, updatePresetArgs(presetId, 'to')), SYSTEM_ONLY_ADMIN);
        expect(test.db.LobbyPreset.id.find(presetId)!.name).toBe('Tournament default (edited)');

        expectReject(test, adm, (ctx) => M.delete_lobby_preset(ctx, { presetId }), SYSTEM_NO_DELETE);
        expectReject(test, mod, (ctx) => M.delete_lobby_preset(ctx, { presetId }), /system/);
        expect(test.db.LobbyPreset.id.find(presetId)).toBeDefined();
    });
});
