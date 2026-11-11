// Lobby: disconnect policies (defer, forfeit grace, NoAction, concede), auto-pauses and the disconnect deadline.
// Decisions: A85, A91, A92
// Contracts: docs/lobby/contract.md
// From S10c, S10d (s10c-high-fixes.test.ts, s10d-rulings.test.ts).
import { describe, expect, it } from 'vitest';
import {
    DEFAULT_LOBBY_ARGS,
    M,
    advance,
    checksFor,
    connect,
    disconnect,
    fireCheck,
    guest,
    joinAsSpectator,
    linkDiscord,
    lobbyRow,
    member,
    newHarness,
    pendingCheck,
    refereeIds,
    seatOf,
    session,
    setupLobby,
    steps,
    tx,
    type Actor,
    type Harness,
    type Lobby,
    type SetupOpts,
} from '../fixtures/harness';
import { rejection } from '../fixtures/calendar-roster-rating-builders';
import { snap, stepsOf } from '../fixtures/draft-snapshot-helpers';
import {
    TOURNAMENT_ARGS,
    createTournament,
    host as tournamentHost,
    tRow,
    updateArgs,
    verified,
} from '../fixtures/tournament-builders';
import {
    byKey,
    deferredDuel,
    duel,
    offlinePastGrace,
    openMatchLobby,
    recordsOfLobby,
    sidesOf,
} from '../fixtures/tournament-match-builders';
import {
    presetArgs,
    presetNamed,
    settingsArgs,
    updatePresetArgs,
} from '../fixtures/preset-and-account-builders';
import { settingsFrom } from '../fixtures/ranked-game-builders';
import { ONE_V_ONE } from '../fixtures/seat-and-snapshot-helpers';

// ════════════════════════════════════════════════════════════════════════════
// A85: lifting a disconnect auto-pause
// ════════════════════════════════════════════════════════════════════════════

describe('A85: lifting a disconnect auto-pause', () => {
    const SEATS: SetupOpts['seats'] = [['b1', 'BluePlayer'], ['b2', 'BluePlayer'], ['bc', 'BlueCoach'], ['r1', 'RedPlayer'], ['r2', 'RedPlayer']];
    const isPaused = (s: Lobby) => session(s.test, s.lobbyId).timerState.isPaused;
    const rejoin = (s: Lobby, who: Actor) => {
        connect(s.test, who);
        tx(s.test, who, (ctx) => M.join_lobby(ctx, { lobbyId: s.lobbyId, joinCode: '', password: '' }));
    };
    /** `who` drops; the 15 s check fires. */
    const drop = (s: Lobby, who: Actor) => {
        disconnect(s.test, who);
        const row = pendingCheck(s.test, s.lobbyId, who.userId);
        advance(s.test, 15_000);
        fireCheck(s.test, row);
    };
    /** A 2v2 Classic draft (Blue coach bc, spectator spec, host = spectator referee) auto-paused by b2 dropping. */
    function autoPaused(): Lobby {
        const test = newHarness();
        const s = setupLobby(test, { seats: SEATS });
        joinAsSpectator(s, 'spec');
        drop(s, s.a.b2);
        expect(isPaused(s)).toBe(true);
        const pauses = stepsOf(test, s.lobbyId, 'Pause');
        expect(pauses).toHaveLength(1);
        expect(pauses[0].payload).toMatchObject({ tag: 'Pause', value: { isAutoPause: true } });
        return s;
    }

    it('join_lobby by a spectator, the coach and a Red player does not resume; the away Blue player\'s return does (A85(1))', () => {
        const s = autoPaused();
        for (const who of [s.a.spec, s.a.bc, s.a.r1]) {
            tx(s.test, who, (ctx) => M.join_lobby(ctx, { lobbyId: s.lobbyId, joinCode: '', password: '' }));
            expect(isPaused(s)).toBe(true);
        }
        rejoin(s, s.a.b2);
        expect(isPaused(s)).toBe(false);
    });

    it('two seated players away: the first return does not resume, the second does (A85(1))', () => {
        const test = newHarness();
        const s = setupLobby(test, { seats: SEATS });
        drop(s, s.a.b2);
        drop(s, s.a.r2);
        expect(isPaused(s)).toBe(true);
        expect(stepsOf(test, s.lobbyId, 'Pause')).toHaveLength(1);
        rejoin(s, s.a.b2);
        expect(isPaused(s)).toBe(true);
        rejoin(s, s.a.r2);
        expect(isPaused(s)).toBe(false);
    });

    it.each(['host', 'r1', 'b1'])('resume_draft on the auto-pause by %s (referee / seated Red / seated Blue) is accepted (A85(2))', (name) => {
        const s = autoPaused();
        tx(s.test, s.a[name], (ctx) => M.resume_draft(ctx, { lobbyId: s.lobbyId }));
        expect(isPaused(s)).toBe(false);
    });

    it.each(['bc', 'spec'])('resume_draft on the auto-pause by %s (coach / non-referee spectator) is rejected, the draft stays paused (A85(2))', (name) => {
        const s = autoPaused();
        const before = snap(session(s.test, s.lobbyId).timerState);
        const msg = rejection(s.test, s.a[name], (ctx) => M.resume_draft(ctx, { lobbyId: s.lobbyId }));
        expect(snap(session(s.test, s.lobbyId).timerState)).toBe(before);
        expect(isPaused(s)).toBe(true);
        expect(msg).toBe('Only the referee or a seated player can resume an auto-paused draft.');
    });

    /** A 2v2 Classic draft auto-paused by b2's Leave (away, A68(1)(2)); the 15 s check fires. */
    function autoPausedByLeave(): Lobby {
        const test = newHarness();
        const s = setupLobby(test, { seats: SEATS });
        tx(test, s.a.b2, (ctx) => M.leave_lobby(ctx, { lobbyId: s.lobbyId }));
        const row = pendingCheck(test, s.lobbyId, s.a.b2.userId);
        advance(test, 15_000);
        fireCheck(test, row);
        expect(isPaused(s)).toBe(true);
        expect(stepsOf(test, s.lobbyId, 'Pause')[0].payload).toMatchObject({ tag: 'Pause', value: { isAutoPause: true } });
        return s;
    }

    // T-S10h (A98): the rejection text is now the A98 one (away / abandoned member), checked before the A85(2) rule.
    it.each(['away', 'abandoned'])('resume_draft on the auto-pause by a seated player whose row is %s is rejected, the draft stays paused; a present seated player resumes (A85(2), A98)', (state) => {
        const s = autoPausedByLeave();
        if (state === 'abandoned') {
            tx(s.test, s.a.b2, (ctx) => M.create_lobby(ctx, { ...DEFAULT_LOBBY_ARGS, abandonCurrentMatch: true } as any));
        }
        const row = [...s.test.db.LobbyMember.by_lobby_and_user.filter([s.lobbyId, s.a.b2.userId])][0];
        expect(row.leftAt).toBeDefined();
        if (state === 'abandoned') expect(row.abandonedAt).toBeDefined();
        else expect(row.abandonedAt).toBeUndefined();
        const before = snap(session(s.test, s.lobbyId).timerState);
        const msg = rejection(s.test, s.a.b2, (ctx) => M.resume_draft(ctx, { lobbyId: s.lobbyId }));
        expect(snap(session(s.test, s.lobbyId).timerState)).toBe(before);
        expect(isPaused(s)).toBe(true);
        expect(msg).toBe(state === 'abandoned'
            ? 'You left this match for another lobby and can no longer act in it.'
            : 'You are away from this lobby. Return to it before acting.');
        tx(s.test, s.a.r1, (ctx) => M.resume_draft(ctx, { lobbyId: s.lobbyId }));
        expect(isPaused(s)).toBe(false);
    });

    it('a manual pause keeps D-62: another seated player (teammate or opponent) is rejected with the old text; the pauser resumes (A85(2))', () => {
        const test = newHarness();
        const s = setupLobby(test, { seats: SEATS });
        tx(test, s.a.b1, (ctx) => M.pause_draft(ctx, { lobbyId: s.lobbyId }));
        expect(isPaused(s)).toBe(true);
        for (const who of [s.a.r1, s.a.b2]) {
            const msg = rejection(test, who, (ctx) => M.resume_draft(ctx, { lobbyId: s.lobbyId }));
            expect(isPaused(s)).toBe(true);
            expect(msg).toBe('Only the referee or the player who paused can resume the draft.');
        }
        tx(test, s.a.b1, (ctx) => M.resume_draft(ctx, { lobbyId: s.lobbyId }));
        expect(isPaused(s)).toBe(false);
    });
});

const DEFER_NEEDS = 'Defer needs a seated player who has been disconnected past the forfeit grace or whose disconnect pool is spent.';
const DEFERRED_ONLY = 'The Deferred disconnect policy is only available for tournaments and their lobbies.';
const NOACTION_ONLY = 'The NoAction disconnect policy is only available for casual lobbies.';
const FORFEIT_RANGE = 'disconnectForfeitSeconds must be between 30 and 600 (0 keeps the default of 60).';
const START_ONLINE = 'All Blue and Red players must be online before starting.';
const AWAY = 'You are away from this match. Return to it first.';
const ABANDONED = 'You left this match for another lobby and cannot act on it.';
const NOT_ELIGIBLE = 'Opposing team is not eligible for forfeit. At least one player is still connected or grace period has not expired.';

// ════════════════════════════════════════════════════════════════════════════
// A91(1): defer_match needs a seated player past the grace or the live pool
// ════════════════════════════════════════════════════════════════════════════

/**
 * The lobby of a Deferred tournament's Bo1 final created by the Red captain (host + referee on the Red player seat):
 * no exclusive Spectator referee, so the players may defer (D-81). b1 / b2 Blue, r1 (= host) / r2 Red.
 */
function deferredByPlayers(over: Partial<typeof TOURNAMENT_ARGS> = {}, noStart = false) {
    const f = duel({ defaultBestOf: 1, grandFinalBestOf: 1, disconnectPolicy: 'Deferred', ...over });
    const m = byKey(f.test, f.id, 'W-R1-M1');
    const s = openMatchLobby(f, m.id, { creator: sidesOf(f, m.id).red.captain, noStart });
    expect(s.host.userId).toBe(s.a.r1.userId);
    return { f, test: f.test, s };
}
const deferBody = (s: Lobby) => (ctx: any) => M.defer_match(ctx, { lobbyId: s.lobbyId });
const parkedState = (test: Harness, s: Lobby) => snap(lobbyRow(test, s.lobbyId).stage, recordsOfLobby(test, s.lobbyId));

describe('A91(1): defer_match precondition', () => {
    it('everyone online: rejected, nothing changes (A91(1))', () => {
        const { test, s } = deferredByPlayers();
        const before = parkedState(test, s);
        const msg = rejection(test, s.a.r2, deferBody(s));
        expect(parkedState(test, s)).toBe(before);
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('Drafting');
        expect(msg).toBe(DEFER_NEEDS);
    });

    it('a seated player offline inside the grace: rejected; past the grace: accepted, the lobby parks with a Pending record (A91(1))', () => {
        const { test, s } = deferredByPlayers();
        disconnect(test, s.a.b1);
        advance(test, 59_000);
        const before = parkedState(test, s);
        const msg = rejection(test, s.a.r2, deferBody(s));
        expect(parkedState(test, s)).toBe(before);
        expect(msg).toBe(DEFER_NEEDS);
        advance(test, 1_000); // exactly the 60 s grace
        tx(test, s.a.r2, deferBody(s));
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('AwaitingResult');
        expect(recordsOfLobby(test, s.lobbyId)[0].status.tag).toBe('Pending');
    });

    it('an away row (live Leave) past the grace satisfies it (A91(1), A68(2))', () => {
        const { test, s } = deferredByPlayers();
        tx(test, s.a.b1, (ctx) => M.leave_lobby(ctx, { lobbyId: s.lobbyId }));
        expect(member(test, s.lobbyId, s.a.b1.userId).leftAt).toBeDefined();
        advance(test, 61_000);
        tx(test, s.a.r2, deferBody(s));
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('AwaitingResult');
    });

    it('a coach or a spectator offline long past the grace does not satisfy it (A91(1): seated players only)', () => {
        const { test, s } = deferredByPlayers({}, true);
        tx(test, s.host, (ctx) => M.set_team_slot(ctx, {
            lobbyId: s.lobbyId, targetJoinSeq: seatOf(ctx, s.lobbyId, s.a.b2.userId), lobbySlot: { tag: 'BlueCoach' } as any,
        }));
        for (const n of ['b1', 'r1', 'r2']) tx(test, s.a[n], (ctx) => M.confirm_ready(ctx, { lobbyId: s.lobbyId }));
        tx(test, s.host, (ctx) => M.start_draft(ctx, { lobbyId: s.lobbyId }));
        const spec = joinAsSpectator(s, 'spec');
        expect(member(test, s.lobbyId, s.a.b2.userId).lobbySlot.tag).toBe('BlueCoach');
        disconnect(test, s.a.b2);
        disconnect(test, spec);
        advance(test, 10 * 60_000);
        const before = parkedState(test, s);
        const msg = rejection(test, s.a.r2, deferBody(s));
        expect(parkedState(test, s)).toBe(before);
        expect(msg).toBe(DEFER_NEEDS);
    });

    it('a pool spent before the grace satisfies it (grace 600 s, pool 300 s: rejected at 200 s, accepted at 301 s) (A91(1), A92(6))', () => {
        const { test, s } = deferredByPlayers({ disconnectForfeitSeconds: 600 });
        expect(lobbyRow(test, s.lobbyId).disconnectForfeitSeconds).toBe(600);
        disconnect(test, s.a.b1);
        advance(test, 200_000);
        expect(rejection(test, s.a.r2, deferBody(s))).toBe(DEFER_NEEDS);
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('Drafting');
        advance(test, 101_000);
        tx(test, s.a.r2, deferBody(s));
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('AwaitingResult');
    });

    it('the exclusive Spectator referee (D-81) defers with every player online (A91(1))', () => {
        const { f, s } = deferredDuel();
        const ref = member(f.test, s.lobbyId, f.org.userId);
        expect(ref.lobbySlot.tag).toBe('Spectator');
        expect(ref.isReferee).toBe(true);
        tx(f.test, f.org, deferBody(s));
        expect(lobbyRow(f.test, s.lobbyId).stage.tag).toBe('AwaitingResult');
    });

    it('a player offline past the grace (offlinePastGrace, the fixture the re-aligned suites use) leaves the organizer\'s defer accepted too (A91(1))', () => {
        const { f, s } = deferredDuel();
        offlinePastGrace(f.test, s.a.b2);
        tx(f.test, f.org, deferBody(s));
        expect(lobbyRow(f.test, s.lobbyId).stage.tag).toBe('AwaitingResult');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// A91(2): Deferred only for tournaments and their lobbies
// ════════════════════════════════════════════════════════════════════════════

describe('A91(2): the Deferred policy outside tournaments', () => {
    const DEFERRED = { disconnectPolicy: { tag: 'Deferred' } };

    it('create_lobby rejects Deferred: no lobby is created (A91(2))', () => {
        const test = newHarness();
        const h = guest(test, 'h');
        const msg = rejection(test, h, (ctx) => M.create_lobby(ctx, { ...DEFAULT_LOBBY_ARGS, ...DEFERRED } as any));
        expect([...test.db.Lobby.iter()].filter((l) => l.hostUserId === h.userId)).toHaveLength(0);
        expect(msg).toBe(DEFERRED_ONLY);
    });

    it('update_lobby_settings on a casual lobby rejects Deferred: the lobby keeps Standard (A91(2))', () => {
        const test = newHarness();
        const s = setupLobby(test, { noStart: true });
        const before = snap(lobbyRow(test, s.lobbyId));
        const msg = rejection(test, s.host, (ctx) => M.update_lobby_settings(ctx, settingsArgs(s.lobbyId, DEFERRED)));
        expect(snap(lobbyRow(test, s.lobbyId))).toBe(before);
        expect(lobbyRow(test, s.lobbyId).disconnectPolicy.tag).toBe('Standard');
        expect(msg).toBe(DEFERRED_ONLY);
    });

    it('create_lobby_preset and update_lobby_preset reject Deferred (A91(2))', () => {
        const test = newHarness();
        const to = tournamentHost(test, 'to');
        const created = rejection(test, to, (ctx) => M.create_lobby_preset(ctx, presetArgs('Deferred preset', DEFERRED)));
        expect(presetNamed(test, 'Deferred preset')).toBeUndefined();
        expect(created).toBe(DEFERRED_ONLY);

        tx(test, to, (ctx) => M.create_lobby_preset(ctx, presetArgs('Plain preset')));
        const preset = presetNamed(test, 'Plain preset')!;
        const before = snap(preset);
        const updated = rejection(test, to, (ctx) => M.update_lobby_preset(ctx, updatePresetArgs(preset.id, 'Plain preset', DEFERRED)));
        expect(snap(presetNamed(test, 'Plain preset'))).toBe(before);
        expect(updated).toBe(DEFERRED_ONLY);
    });

    it('a Deferred tournament and its lobby still work (A91(2))', () => {
        const { f, s } = deferredDuel();
        expect(tRow(f.test, f.id).disconnectPolicy.tag).toBe('Deferred');
        expect(lobbyRow(f.test, s.lobbyId).disconnectPolicy.tag).toBe('Deferred');
        expect(lobbyRow(f.test, s.lobbyId).stage.tag).toBe('Drafting');
    });

    it('a tournament lobby\'s locked settings ignore the policy and grace arguments (A91(2), A92(2): the locked branch)', () => {
        const { f, s } = deferredDuel({ noStart: true });
        const { test } = f;
        const seconds = lobbyRow(test, s.lobbyId).disconnectForfeitSeconds;
        const args = settingsFrom(test, s.lobbyId, { disconnectPolicy: { tag: 'Standard' }, disconnectForfeitSeconds: 5 });
        tx(test, f.org, (ctx) => M.update_lobby_settings(ctx, args));
        expect(lobbyRow(test, s.lobbyId).disconnectPolicy.tag).toBe('Deferred');
        expect(lobbyRow(test, s.lobbyId).disconnectForfeitSeconds).toBe(seconds);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// A92(1): start_draft needs every seated player online
// ════════════════════════════════════════════════════════════════════════════

describe('A92(1): start_draft is rejected while a seated player is offline', () => {
    it('an offline Blue player blocks the start; offline coach and spectator do not; the start passes once the player returns (A92(1))', () => {
        const test = newHarness();
        const s = setupLobby(test, {
            noStart: true,
            seats: [['b1', 'BluePlayer'], ['bc', 'BlueCoach'], ['r1', 'RedPlayer'], ['spec', 'Spectator']],
        });
        const start = (ctx: any) => M.start_draft(ctx, { lobbyId: s.lobbyId });
        disconnect(test, s.a.bc);
        disconnect(test, s.a.spec);
        disconnect(test, s.a.b1);
        const msg = rejection(test, s.host, start);
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('Waiting');
        expect(test.db.MatchSession.lobbyId.find(s.lobbyId)).toBeFalsy();
        expect(msg).toBe(START_ONLINE);

        connect(test, s.a.b1); // the coach and the spectator stay offline
        expect(member(test, s.lobbyId, s.a.bc.userId).isOnline).toBe(false);
        tx(test, s.host, start);
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('Drafting');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// A92(2): disconnectForfeitSeconds is 30 to 600; 0 / unset keeps 60
// ════════════════════════════════════════════════════════════════════════════

describe('A92(2): the forfeit grace bounds', () => {
    const graceOf = (v: number | undefined) => v ?? 60;

    it('create_lobby: 29 and 601 rejected; 30, 600 accepted; 0 means 60 (A92(2))', () => {
        const test = newHarness();
        const hosted = (h: Actor) => [...test.db.Lobby.iter()].filter((l) => l.hostUserId === h.userId);
        for (const bad of [29, 601]) {
            const h = guest(test, `bad${bad}`);
            const msg = rejection(test, h, (ctx) => M.create_lobby(ctx, { ...DEFAULT_LOBBY_ARGS, disconnectForfeitSeconds: bad } as any));
            expect(hosted(h)).toHaveLength(0);
            expect(msg).toBe(FORFEIT_RANGE);
        }
        for (const [value, expected] of [[30, 30], [600, 600], [0, 60]] as const) {
            const h = guest(test, `ok${value}`);
            tx(test, h, (ctx) => M.create_lobby(ctx, { ...DEFAULT_LOBBY_ARGS, disconnectForfeitSeconds: value } as any));
            expect(graceOf(hosted(h)[0].disconnectForfeitSeconds)).toBe(expected);
        }
    });

    it('update_lobby_settings: 29 and 601 rejected (row unchanged); 30, 600 accepted; 0 means 60 (A92(2))', () => {
        const test = newHarness();
        const s = setupLobby(test, { noStart: true });
        for (const bad of [29, 601]) {
            const before = snap(lobbyRow(test, s.lobbyId));
            const msg = rejection(test, s.host, (ctx) => M.update_lobby_settings(ctx, settingsArgs(s.lobbyId, { disconnectForfeitSeconds: bad })));
            expect(snap(lobbyRow(test, s.lobbyId))).toBe(before);
            expect(msg).toBe(FORFEIT_RANGE);
        }
        for (const [value, expected] of [[30, 30], [600, 600], [0, 60]] as const) {
            tx(test, s.host, (ctx) => M.update_lobby_settings(ctx, settingsArgs(s.lobbyId, { disconnectForfeitSeconds: value })));
            expect(graceOf(lobbyRow(test, s.lobbyId).disconnectForfeitSeconds)).toBe(expected);
        }
    });

    it('create_lobby_preset: 29 and 601 rejected; 30, 600 accepted; 0 means 60 (A92(2))', () => {
        const test = newHarness();
        const to = tournamentHost(test, 'to');
        for (const bad of [29, 601]) {
            const msg = rejection(test, to, (ctx) => M.create_lobby_preset(ctx, presetArgs(`P${bad}`, { disconnectForfeitSeconds: bad })));
            expect(presetNamed(test, `P${bad}`)).toBeUndefined();
            expect(msg).toBe(FORFEIT_RANGE);
        }
        for (const [value, expected] of [[30, 30], [600, 600], [0, 60]] as const) {
            tx(test, to, (ctx) => M.create_lobby_preset(ctx, presetArgs(`P${value}`, { disconnectForfeitSeconds: value })));
            expect(graceOf(presetNamed(test, `P${value}`)!.disconnectForfeitSeconds)).toBe(expected);
        }
    });

    it('create_tournament: 29 and 601 rejected; 30, 600 accepted; 0 / omitted means 60 (A92(2))', () => {
        const test = newHarness();
        const org = tournamentHost(test, 'org');
        const count = () => [...test.db.Tournament.organizer_id.filter(org.userId)].length;
        for (const bad of [29, 601]) {
            const before = count();
            const msg = rejection(test, org, (ctx) => M.create_tournament(ctx, { ...TOURNAMENT_ARGS, disconnectForfeitSeconds: bad } as any));
            expect(count()).toBe(before);
            expect(msg).toBe(FORFEIT_RANGE);
        }
        for (const [value, expected] of [[30, 30], [600, 600], [0, 60], [undefined, 60]] as const) {
            const id = createTournament(test, org, { name: `cup ${value}`, disconnectForfeitSeconds: value });
            expect(graceOf(tRow(test, id).disconnectForfeitSeconds)).toBe(expected);
        }
    });
});

// ════════════════════════════════════════════════════════════════════════════
// A92(3): NoAction is for casual lobbies only
// ════════════════════════════════════════════════════════════════════════════

describe('A92(3): the NoAction policy', () => {
    const NOACTION = { disconnectPolicy: { tag: 'NoAction' } };
    const RANKED = { matchType: { tag: 'Ranked' } };
    const hosted = (test: Harness, h: Actor) => [...test.db.Lobby.iter()].filter((l) => l.hostUserId === h.userId);

    it('create_lobby: Ranked + NoAction rejected; Casual + NoAction accepted (A92(3))', () => {
        const test = newHarness();
        const h = verified(test, 'rh');
        const msg = rejection(test, h, (ctx) => M.create_lobby(ctx, { ...DEFAULT_LOBBY_ARGS, ...RANKED, ...NOACTION } as any));
        expect(hosted(test, h)).toHaveLength(0);
        expect(msg).toBe(NOACTION_ONLY);
        tx(test, h, (ctx) => M.create_lobby(ctx, { ...DEFAULT_LOBBY_ARGS, ...NOACTION } as any));
        expect(hosted(test, h)[0].disconnectPolicy.tag).toBe('NoAction');
    });

    it('update_lobby_settings: a NoAction casual lobby switched to Ranked, and a Ranked lobby switched to NoAction, are rejected (A92(3))', () => {
        const test = newHarness();
        const h1 = verified(test, 'h1');
        tx(test, h1, (ctx) => M.create_lobby(ctx, { ...DEFAULT_LOBBY_ARGS, ...NOACTION } as any));
        const casual = hosted(test, h1)[0].id;
        const before1 = snap(lobbyRow(test, casual));
        const msg1 = rejection(test, h1, (ctx) => M.update_lobby_settings(ctx, settingsArgs(casual, { ...NOACTION, ...RANKED })));
        expect(snap(lobbyRow(test, casual))).toBe(before1);
        expect(msg1).toBe(NOACTION_ONLY);

        const h2 = verified(test, 'h2');
        tx(test, h2, (ctx) => M.create_lobby(ctx, { ...DEFAULT_LOBBY_ARGS, ...RANKED } as any));
        const ranked = hosted(test, h2)[0].id;
        const before2 = snap(lobbyRow(test, ranked));
        const msg2 = rejection(test, h2, (ctx) => M.update_lobby_settings(ctx, settingsArgs(ranked, { ...RANKED, ...NOACTION })));
        expect(snap(lobbyRow(test, ranked))).toBe(before2);
        expect(msg2).toBe(NOACTION_ONLY);
    });

    it('create_tournament and update_tournament reject NoAction (A92(3))', () => {
        const test = newHarness();
        const org = tournamentHost(test, 'org');
        const msg = rejection(test, org, (ctx) => M.create_tournament(ctx, { ...TOURNAMENT_ARGS, disconnectPolicy: 'NoAction' } as any));
        expect([...test.db.Tournament.organizer_id.filter(org.userId)]).toHaveLength(0);
        expect(msg).toBe(NOACTION_ONLY);

        const id = createTournament(test, org);
        const before = snap(tRow(test, id));
        const args = updateArgs(test, id, { disconnectPolicy: 'NoAction' }) as any; // read outside the transaction
        const upd = rejection(test, org, (ctx) => M.update_tournament(ctx, args));
        expect(snap(tRow(test, id))).toBe(before);
        expect(upd).toBe(NOACTION_ONLY);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// A92(4): away and abandoned seats cannot concede, claim or defer
// ════════════════════════════════════════════════════════════════════════════

describe('A92(4): an away or abandoned seat cannot concede, claim a forfeit or defer', () => {
    const concede = (s: Lobby) => (ctx: any) => M.concede_match(ctx, { lobbyId: s.lobbyId, losingTeamSide: 0 });
    const claim = (s: Lobby) => (ctx: any) => M.claim_forfeit(ctx, { lobbyId: s.lobbyId, forfeitingTeamSide: 0 });
    const leave = (test: Harness, who: Actor, s: Lobby) => tx(test, who, (ctx) => M.leave_lobby(ctx, { lobbyId: s.lobbyId }));
    const abandon = (test: Harness, who: Actor) =>
        tx(test, who, (ctx) => M.create_lobby(ctx, { ...DEFAULT_LOBBY_ARGS, abandonCurrentMatch: true } as any));

    it('Standard casual lobby (no Spectator referee): concede and claim_forfeit rejected for an away and an abandoned seat; the away player concedes after join_lobby (A92(4))', () => {
        const test = newHarness();
        const s = setupLobby(test, { hostSlot: 'RedPlayer', seats: [['b1', 'BluePlayer'], ['b2', 'BluePlayer'], ['r1', 'RedPlayer']] });
        leave(test, s.a.b1, s);
        leave(test, s.a.b2, s);
        abandon(test, s.a.b2);
        expect(member(test, s.lobbyId, s.a.b2.userId).abandonedAt).toBeDefined();
        advance(test, 61_000);

        for (const [who, text] of [[s.a.b1, AWAY], [s.a.b2, ABANDONED]] as const) {
            for (const body of [concede(s), claim(s)]) {
                const before = parkedState(test, s);
                const msg = rejection(test, who, body);
                expect(parkedState(test, s)).toBe(before);
                expect(msg).toBe(text);
            }
        }

        tx(test, s.a.b1, (ctx) => M.join_lobby(ctx, { lobbyId: s.lobbyId, joinCode: '', password: '' }));
        expect(member(test, s.lobbyId, s.a.b1.userId).leftAt).toBeUndefined();
        tx(test, s.a.b1, concede(s));
        expect(test.db.Lobby.id.find(s.lobbyId)).toBeFalsy(); // a casual concede finalizes inline
    });

    it('Deferred tournament lobby: defer_match rejected for an away and an abandoned seat, with a Blue player past the grace (A92(4))', () => {
        const { test, s } = deferredByPlayers();
        leave(test, s.a.b1, s);
        leave(test, s.a.b2, s);
        abandon(test, s.a.b2);
        advance(test, 61_000); // A91(1) holds: the away rows are past the grace
        for (const [who, text] of [[s.a.b1, AWAY], [s.a.b2, ABANDONED]] as const) {
            const before = parkedState(test, s);
            const msg = rejection(test, who, deferBody(s));
            expect(parkedState(test, s)).toBe(before);
            expect(msg).toBe(text);
        }
        tx(test, s.a.r2, deferBody(s)); // a present seat may
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('AwaitingResult');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// A92(5): the 15 s flag check in Waiting
// ════════════════════════════════════════════════════════════════════════════

describe('A92(5): a host or referee who disconnects in Waiting', () => {
    const fire = (test: Harness, s: Lobby, who: Actor) => {
        const row = pendingCheck(test, s.lobbyId, who.userId);
        advance(test, 15_000);
        fireCheck(test, row);
    };

    it('the host-referee closes the tab: after 15 s the referee flag moves to the first online member in the A22(5) order (b1 offline → b2); the host role stays; no stamp, no pause (A93)', () => {
        const test = newHarness();
        const s = setupLobby(test, { noStart: true });
        disconnect(test, s.a.b1); // a plain member: nothing scheduled
        expect(checksFor(test, s.lobbyId, s.a.b1.userId)).toHaveLength(0);
        disconnect(test, s.host);
        expect(member(test, s.lobbyId, s.host.userId).disconnectedAt).toBeUndefined();
        fire(test, s, s.host);
        expect(refereeIds(test, s.lobbyId)).toEqual([s.a.b2.userId]); // Blue players by joinSeq, online first
        expect(lobbyRow(test, s.lobbyId).hostUserId).toBe(s.host.userId); // A93(1): the host role does not move in Waiting
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('Waiting');
        expect(test.db.MatchSession.lobbyId.find(s.lobbyId)).toBeFalsy();
        expect(steps(test, s.lobbyId)).toHaveLength(0);
    });

    it('host and referee on different members: the host\'s disconnect schedules nothing; the referee\'s moves the referee flag (A93)', () => {
        const test = newHarness();
        const s = setupLobby(test, { noStart: true });
        tx(test, s.host, (ctx) => M.transfer_referee(ctx, { lobbyId: s.lobbyId, targetJoinSeq: seatOf(ctx, s.lobbyId, s.a.r1.userId) }));
        expect(refereeIds(test, s.lobbyId)).toEqual([s.a.r1.userId]);

        disconnect(test, s.host); // the host only, not the referee: A93(1) schedules nothing
        expect(checksFor(test, s.lobbyId, s.host.userId)).toHaveLength(0);
        advance(test, 15_000);
        expect(lobbyRow(test, s.lobbyId).hostUserId).toBe(s.host.userId);
        expect(refereeIds(test, s.lobbyId)).toEqual([s.a.r1.userId]);

        disconnect(test, s.a.r1); // the referee, not the host
        fire(test, s, s.a.r1);
        expect(refereeIds(test, s.lobbyId)).toEqual([s.a.b1.userId]); // the host is offline: Blue players by joinSeq
        expect(lobbyRow(test, s.lobbyId).hostUserId).toBe(s.host.userId);
    });

    it('a refresh inside the 15 s keeps both flags (A22a in Waiting)', () => {
        const test = newHarness();
        const s = setupLobby(test, { noStart: true });
        disconnect(test, s.host);
        advance(test, 5_000);
        connect(test, s.host);
        expect(checksFor(test, s.lobbyId, s.host.userId)).toHaveLength(0);
        expect(refereeIds(test, s.lobbyId)).toEqual([s.host.userId]);
        expect(lobbyRow(test, s.lobbyId).hostUserId).toBe(s.host.userId);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// A92(6): forfeit eligibility uses the live pool
// ════════════════════════════════════════════════════════════════════════════

describe('A92(6): the live pool', () => {
    /** b1 alone on Blue; the host plays Red (no exclusive referee), so the host claims. */
    const soloBlue = (seconds: number) => {
        const test = newHarness();
        const s = setupLobby(test, { hostSlot: 'RedPlayer', seats: [['b1', 'BluePlayer']], lobby: { disconnectForfeitSeconds: seconds } });
        return { test, s };
    };
    const claim = (s: Lobby) => (ctx: any) => M.claim_forfeit(ctx, { lobbyId: s.lobbyId, forfeitingTeamSide: 0 });

    it('grace 600, 10 s of pool left: not eligible at 5 s, eligible at 11 s with no reconnect in between (A92(6))', () => {
        const { test, s } = soloBlue(600);
        disconnect(test, s.a.b1);
        advance(test, 290_000);
        connect(test, s.a.b1);
        expect(member(test, s.lobbyId, s.a.b1.userId).disconnectPoolRemainingMs).toBe(10_000);
        disconnect(test, s.a.b1);
        advance(test, 5_000);
        const before = parkedState(test, s);
        const msg = rejection(test, s.host, claim(s));
        expect(parkedState(test, s)).toBe(before);
        expect(msg).toBe(NOT_ELIGIBLE);
        advance(test, 6_000);
        tx(test, s.host, claim(s));
        expect(test.db.Lobby.id.find(s.lobbyId)).toBeFalsy(); // a casual forfeit finalizes inline
    });

    it('a full pool and grace 60: not eligible at 59 s, eligible at 60 s (A92(6), D-12)', () => {
        const { test, s } = soloBlue(60);
        disconnect(test, s.a.b1);
        advance(test, 59_000);
        expect(rejection(test, s.host, claim(s))).toBe(NOT_ELIGIBLE);
        advance(test, 1_000);
        tx(test, s.host, claim(s));
        expect(test.db.Lobby.id.find(s.lobbyId)).toBeFalsy();
    });
});

// ════════════════════════════════════════════════════════════════════════════
// A92(7) / A92(8): auto-pause and manual pause around a disconnect
// ════════════════════════════════════════════════════════════════════════════

const SEATS: SetupOpts['seats'] = [['b1', 'BluePlayer'], ['b2', 'BluePlayer'], ['bc', 'BlueCoach'], ['r1', 'RedPlayer'], ['r2', 'RedPlayer']];
const isPaused = (s: Lobby) => session(s.test, s.lobbyId).timerState.isPaused;
const pauses = (s: Lobby) => steps(s.test, s.lobbyId).filter((st) => st.action.tag === 'Pause');
/** `who` drops (client_disconnected); the 15 s check fires. */
function drop(s: Lobby, who: Actor) {
    disconnect(s.test, who);
    const row = pendingCheck(s.test, s.lobbyId, who.userId);
    advance(s.test, 15_000);
    fireCheck(s.test, row);
}

describe('A92(7): client_connected lifts an auto-pause under the A85(1) test', () => {
    it('the away player\'s client_connected (no join_lobby) lifts it; a spectator\'s and an opponent\'s do not while the player is away (A92(7))', () => {
        const test = newHarness();
        const s = setupLobby(test, { seats: SEATS });
        const spec = joinAsSpectator(s, 'spec');
        drop(s, s.a.b2);
        expect(isPaused(s)).toBe(true);
        expect(pauses(s)[0].payload).toMatchObject({ tag: 'Pause', value: { isAutoPause: true } });

        disconnect(test, spec);
        connect(test, spec);
        expect(isPaused(s)).toBe(true);
        disconnect(test, s.a.r1);
        connect(test, s.a.r1); // an opponent's refresh inside the 15 s
        expect(isPaused(s)).toBe(true);

        connect(test, s.a.b2);
        expect(member(test, s.lobbyId, s.a.b2.userId).isOnline).toBe(true);
        expect(isPaused(s)).toBe(false);
    });

    it('two seated players away: the first client_connected does not lift it, the second does (A92(7))', () => {
        const test = newHarness();
        const s = setupLobby(test, { seats: SEATS });
        drop(s, s.a.b2);
        drop(s, s.a.r2);
        expect(isPaused(s)).toBe(true);
        connect(test, s.a.b2);
        expect(isPaused(s)).toBe(true);
        connect(test, s.a.r2);
        expect(isPaused(s)).toBe(false);
    });
});

describe('A92(8): a disconnect during a manual pause', () => {
    it('no auto-pause step is added; the pauser resumes (D-62) and the draft runs; the away player\'s forfeit clock still runs (A92(8))', () => {
        const test = newHarness();
        const s = setupLobby(test, { seats: ONE_V_ONE }); // host = exclusive Spectator referee
        tx(test, s.a.b1, (ctx) => M.pause_draft(ctx, { lobbyId: s.lobbyId }));
        expect(pauses(s)).toHaveLength(1);
        drop(s, s.a.r1);
        expect(pauses(s)).toHaveLength(1);
        expect(pauses(s)[0].payload).toMatchObject({ tag: 'Pause', value: { isAutoPause: false } });
        expect(isPaused(s)).toBe(true);

        tx(test, s.a.b1, (ctx) => M.resume_draft(ctx, { lobbyId: s.lobbyId }));
        expect(isPaused(s)).toBe(false);
        expect(member(test, s.lobbyId, s.a.r1.userId).isOnline).toBe(false);

        const claimRed = (ctx: any) => M.claim_forfeit(ctx, { lobbyId: s.lobbyId, forfeitingTeamSide: 2 });
        advance(test, 30_000); // 45 s since the drop
        expect(rejection(test, s.host, claimRed)).toBe(NOT_ELIGIBLE);
        advance(test, 15_000); // 60 s
        tx(test, s.host, claimRed);
        expect(test.db.Lobby.id.find(s.lobbyId)).toBeFalsy();
    });
});

// ════════════════════════════════════════════════════════════════════════════
// A92(9): view_my_lobby_members.disconnectActionAt
// ════════════════════════════════════════════════════════════════════════════

describe('A92(9): view_my_lobby_members.disconnectActionAt', () => {
    const rows = (test: Harness, reader: Actor, lobbyId: number) =>
        ((M as any).view_my_lobby_members(test.viewContext(reader.auth), {}) as any[]).filter((r) => r.lobbyId === lobbyId);
    const rowOf = (test: Harness, reader: Actor, s: Lobby, who: Actor) =>
        rows(test, reader, s.lobbyId).find((r) => r.joinSeq === seatOf(test, s.lobbyId, who.userId))!;
    const actionAt = (test: Harness, reader: Actor, s: Lobby, who: Actor): bigint | undefined =>
        rowOf(test, reader, s, who).disconnectActionAt?.microsSinceUnixEpoch;
    const stamp = (test: Harness, s: Lobby, who: Actor): bigint => member(test, s.lobbyId, who.userId).disconnectedAt!.microsSinceUnixEpoch;
    const SEC = 1_000_000n;

    it('Drafting, grace 60: the offline and the away player read stamp + 60 s; online members, the coach and a spectator read none (A92(9))', () => {
        const test = newHarness();
        const s = setupLobby(test, { seats: SEATS });
        const spec = joinAsSpectator(s, 'spec');
        disconnect(test, s.a.b2);
        disconnect(test, s.a.bc);
        disconnect(test, spec);
        advance(test, 3_000);
        tx(test, s.a.r2, (ctx) => M.leave_lobby(ctx, { lobbyId: s.lobbyId })); // away
        expect(actionAt(test, s.host, s, s.a.b2)).toBe(stamp(test, s, s.a.b2) + 60n * SEC);
        expect(actionAt(test, s.host, s, s.a.r2)).toBe(stamp(test, s, s.a.r2) + 60n * SEC);
        for (const who of [s.a.b1, s.a.r1, s.host, s.a.bc, spec]) expect(actionAt(test, s.host, s, who)).toBeUndefined();
    });

    it('grace 600 with 10 s of pool left: stamp + 10 s (the smaller of grace and pool) (A92(9), A92(6))', () => {
        const test = newHarness();
        const s = setupLobby(test, { lobby: { disconnectForfeitSeconds: 600 } });
        disconnect(test, s.a.b1);
        advance(test, 290_000);
        connect(test, s.a.b1);
        disconnect(test, s.a.b1);
        expect(actionAt(test, s.host, s, s.a.b1)).toBe(stamp(test, s, s.a.b1) + 10n * SEC);
    });

    it('Waiting and NoAction: an offline seated player reads none (A92(9))', () => {
        const t1 = newHarness();
        const waiting = setupLobby(t1, { noStart: true });
        disconnect(t1, waiting.a.b1);
        expect(actionAt(t1, waiting.host, waiting, waiting.a.b1)).toBeUndefined();

        const t2 = newHarness();
        const noAction = setupLobby(t2, { lobby: { disconnectPolicy: { tag: 'NoAction' } } });
        disconnect(t2, noAction.a.b1);
        expect(member(t2, noAction.lobbyId, noAction.a.b1.userId).isOnline).toBe(false);
        expect(actionAt(t2, noAction.host, noAction, noAction.a.b1)).toBeUndefined();
    });

    it('anonymous lobby: the same instant, the seat still anonymized (userId 0), no column added (A92(9), A37)', () => {
        const plain = newHarness();
        const p = setupLobby(plain);
        const test = newHarness();
        const s = setupLobby(test, { lobby: { isAnonymousPlayers: true } });
        disconnect(test, s.a.b1);
        // The reader is an opposing player (the Spectator referee sees real identities, D-71).
        const row = rowOf(test, s.a.r1, s, s.a.b1);
        expect(row.userId).toBe(0);
        expect(row.disconnectActionAt.microsSinceUnixEpoch).toBe(stamp(test, s, s.a.b1) + 60n * SEC);
        expect(Object.keys(row).sort()).toEqual(Object.keys(rowOf(plain, p.a.r1, p, p.a.b1)).sort());
    });

    it('a stamped offline seat whose user is live on another identity (new browser, linked after client_connected, no join_lobby) reads Online and still carries the instant; claim_forfeit accepts at it (A92(9), S10d review F2)', () => {
        const test = newHarness();
        const dev1 = guest(test, 'b1');
        linkDiscord(test, dev1, 'discord-b1', 'B1');
        const s = setupLobby(test, { seats: ONE_V_ONE, actors: { b1: dev1 } }); // host = exclusive Spectator referee
        disconnect(test, dev1);
        const dev2 = guest(test, 'b1-browser');
        linkDiscord(test, dev2, 'discord-b1', 'B1'); // re-points dev2's identity and its live UserPresence row to b1
        expect(dev2.userId).toBe(dev1.userId);
        expect(member(test, s.lobbyId, dev1.userId).isOnline).toBe(false);
        expect([...test.db.UserPresence.user_id.filter(dev1.userId)].some((p) => p.isOnline)).toBe(true);

        const row = rowOf(test, s.host, s, dev1);
        expect(row.presence.tag).toBe('Online');
        expect(actionAt(test, s.host, s, dev1)).toBe(stamp(test, s, dev1) + 60n * SEC);

        advance(test, 60_000);
        tx(test, s.host, (ctx) => M.claim_forfeit(ctx, { lobbyId: s.lobbyId, forfeitingTeamSide: 1 }));
        expect(test.db.Lobby.id.find(s.lobbyId)).toBeFalsy();
    });
});
