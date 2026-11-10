// T-S10d: in-memory tests for the S10d rulings of the 2026-11-09 audit, DECISIONS.md A86 to A92: the timer auto-pick
// priced like a manual pick (A86), mirror picks once per team (A87), a team-seated tournament referee's adjustments and
// staff close (A88, documentation), tournament staff on tournament-linked calendar events (A89), the active cap on
// update_calendar_event (A90), deferring a match (A91) and the second pass of the disconnect rules (A92). The tests
// assert the decision rows; the code is not the reference. A rejection checks the state first and the text last
// (`rejection()`). Builders in s4 / s7 / s8 / s8d / s10-a1 / s10-a2 / s10-c2 fixtures; the clock is the TestClock; the
// A22a scheduler is fired by hand (fireCheck); lifecycle hooks are called as reducers (connect / disconnect), as in the
// s4 / s8f / s10c suites. Nothing reaches maincloud.
import { describe, expect, it } from 'vitest';
import { toHundredths } from '@shared/scoring';
import { teamDraft } from '@module/helpers/results/scoringHelpers';
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
    priceCharacters,
    dropDefaultCostCoverage,
} from './s4-fixtures';
import {
    H,
    arrange,
    closeGame,
    insertCharacterCostLadder,
    insertRoster,
    recordScores,
    selectAccount,
    side,
} from './s7-fixtures';
import {
    TOURNAMENT_ARGS,
    assignAssistant,
    createTournament,
    host as tournamentHost,
    liveField,
    moderator,
    setUserRole,
    tRow,
    updateArgs,
    verified,
} from './s8-fixtures';
import { byKey, deferredDuel, draftGame, duel, offlinePastGrace, openMatchLobby, recordsOfLobby, sidesOf } from './s8d-fixtures';
import { presetArgs, presetNamed, settingsArgs, updatePresetArgs } from './s10-a1-fixtures';
import { settingsFrom } from './s10-a2-fixtures';
import { DAY_MS, HOUR_MS, createEvent, eventsOf, fromNow, invite, invitesOf, rejection } from './s10-c2-fixtures';

type Team = 'Blue' | 'Red';

// ─── Texts (the module code is the truth for the wording; the rows for the behaviour) ─────────────────────────────

const MIRROR_TWICE = 'Your team already picked this character.';
const ALREADY_PICKED = 'Character already picked.';
const LINKED = (action: string) => `Forbidden: Only the organizer, an Admin or tournament staff with the bracket permission can ${action}.`;
const PERSONAL = (action: string) => `Forbidden: Only the organizer or an Admin can ${action}.`;
const ACTIVE_CAP = 'Maximum 40 active calendar events per user.';
const DEFER_NEEDS = 'Defer needs a seated player who has been disconnected past the forfeit grace or whose disconnect pool is spent.';
const DEFERRED_ONLY = 'The Deferred disconnect policy is only available for tournaments and their lobbies.';
const NOACTION_ONLY = 'The NoAction disconnect policy is only available for casual lobbies.';
const FORFEIT_RANGE = 'disconnectForfeitSeconds must be between 30 and 600 (0 keeps the default of 60).';
const START_ONLINE = 'All Blue and Red players must be online before starting.';
const AWAY = 'You are away from this match. Return to it first.';
const ABANDONED = 'You left this match for another lobby and cannot act on it.';
const NOT_ELIGIBLE = 'Opposing team is not eligible for forfeit. At least one player is still connected or grace period has not expired.';
const SEATED_TIE = 'A referee seated on a team cannot decide a tie in a tournament lobby; staff must close this game.';

// ─── Shared builders ──────────────────────────────────────────────────────────────────────────────────────────────

/** A JSON snapshot of rows (bigint-safe), to prove "nothing changed" across a rejected call. */
const snap = (...rows: unknown[]) => JSON.stringify(rows, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));

const TURN_MS = 30_000; // DEFAULT_LOBBY_ARGS.standardTurnSeconds
const ONE_V_ONE: SetupOpts['seats'] = [['b1', 'BluePlayer'], ['r1', 'RedPlayer']];

const current = (test: Harness, lobbyId: number) => {
    const sess = session(test, lobbyId);
    return sess.draftSequence[sess.turnIndex];
};
const pickSteps = (test: Harness, lobbyId: number) =>
    steps(test, lobbyId).filter((st) => st.action.tag === 'Pick').sort((a, b) => a.sequence - b.sequence);
const lastPick = (test: Harness, lobbyId: number) => pickSteps(test, lobbyId).at(-1)!;
const pickValue = (st: ReturnType<typeof lastPick>) => st.payload.value as { characterName: string; eidolon: number; costPaid: number };

/** The captain of `team` (row flag), by actor. */
function captainOf(s: Lobby, team: Team): Actor {
    const slot = team === 'Blue' ? 'BluePlayer' : 'RedPlayer';
    const row = [...s.test.db.LobbyMember.lobby_id.filter(s.lobbyId)].find((m) => m.lobbySlot.tag === slot && m.isCaptain)!;
    return Object.values(s.a).find((a) => a.userId === row.userId)!;
}

/** pick_character by the captain of the team whose turn it is; asserts the turn belongs to `team`. */
function pickAs(s: Lobby, team: Team, characterName: string) {
    expect(current(s.test, s.lobbyId).teamTurn.tag).toBe(team);
    tx(s.test, captainOf(s, team), (ctx) => (priceCharacters(ctx, s.lobbyId, [characterName]), M.pick_character(ctx, { lobbyId: s.lobbyId, characterName, eidolon: 0 })));
}
const pickBody = (s: Lobby, characterName: string) => (ctx: any) => (priceCharacters(ctx, s.lobbyId, [characterName]), M.pick_character(ctx, { lobbyId: s.lobbyId, characterName, eidolon: 0 }));

/** The turn timer runs out and the host (a member) fires the expiry. */
function expire(s: Lobby) {
    advance(s.test, TURN_MS);
    tx(s.test, s.host, (ctx) => M.timer_expiry_classic(ctx, { lobbyId: s.lobbyId }));
}

const teamCosts = (test: Harness, lobbyId: number, team: Team) =>
    tx(test, 'internal', (ctx) => teamDraft(ctx, lobbyId, team).characterCosts);

/**
 * A Classic 1v1 (b1 Blue, r1 Red, host = Spectator referee) with autoRandomPick on: cost rows (cost set 0, MoC,
 * Classic) for `costs`; each player holds one selected account owning `owned` (start_draft's D-43b check wants
 * characters on every player's account).
 */
function autoPickLobby(o: {
    lobby?: Record<string, unknown>;
    costs: Record<string, number[]>;
    owned?: { b1?: Record<string, number>; r1?: Record<string, number> };
}): Lobby {
    const test = newHarness();
    insertRoster(test, Object.keys(o.costs));
    for (const [name, ladder] of Object.entries(o.costs)) insertCharacterCostLadder(test, name, 'Classic', ladder);
    return setupLobby(test, {
        seats: ONE_V_ONE,
        lobby: { autoRandomPick: true, ...(o.lobby ?? {}) },
        beforeStart: (l) => {
            dropDefaultCostCoverage(test); // T-S10i fix pass (review F2): the coverage rows leave the timer pool
            selectAccount(test, l.lobbyId, l.a.b1.userId, 900, o.owned?.b1 ?? { 'not-in-pool-b': 0 });
            selectAccount(test, l.lobbyId, l.a.r1.userId, 901, o.owned?.r1 ?? { 'not-in-pool-r': 0 });
        },
    });
}

const LADDER = (base: number) => [base, base + 1, base + 2, base + 3, base + 4, base + 5, base + 6];

// ════════════════════════════════════════════════════════════════════════════
// A86: the timer auto-pick is priced like a manual pick
// ════════════════════════════════════════════════════════════════════════════

describe('A86: a timer auto-pick of a real character is priced like a manual pick', () => {
    it('ownership off: the expired turn picks a real character at E0 with costPaid = its E0 cost, and the roster cost counts it; nothing left → EMPTY at 0 (A86)', () => {
        const s = autoPickLobby({ costs: { x: LADDER(10) } });
        const { test, lobbyId } = s;
        expect(current(test, lobbyId).teamTurn.tag).toBe('Blue');
        expire(s);
        const blue = lastPick(test, lobbyId);
        expect(blue.actorUserId).toBe(0);
        expect(blue.actorSlot.tag).toBe('Blue');
        expect(pickValue(blue)).toEqual({ characterName: 'x', eidolon: 0, costPaid: 10 });
        expect(teamCosts(test, lobbyId, 'Blue')).toEqual([toHundredths(10)]);

        // Red's turn: x is Blue's (no mirror), nothing else is pickable → the EMPTY placeholder at cost 0.
        expect(current(test, lobbyId).teamTurn.tag).toBe('Red');
        expire(s);
        expect(pickValue(lastPick(test, lobbyId))).toEqual({ characterName: 'EMPTY', eidolon: 0, costPaid: 0 });
        expect(teamCosts(test, lobbyId, 'Red')).toEqual([0]);
    });

    it('ownership on: the drawn character takes the acting team\'s owned eidolon (E3) and is priced at that level (A86)', () => {
        const s = autoPickLobby({ lobby: { requireOwnership: true }, costs: { x: LADDER(10) }, owned: { b1: { x: 3 }, r1: { x: 5 } } });
        const { test, lobbyId } = s;
        expire(s);
        expect(pickValue(lastPick(test, lobbyId))).toEqual({ characterName: 'x', eidolon: 3, costPaid: 13 });
        expect(teamCosts(test, lobbyId, 'Blue')).toEqual([toHundredths(13)]);
        // Red owns x too, but Blue holds it (no mirror): nothing legal is left for Red.
        expire(s);
        expect(pickValue(lastPick(test, lobbyId))).toEqual({ characterName: 'EMPTY', eidolon: 0, costPaid: 0 });
    });

    it('the draw skips banned characters and characters already blocked for the acting team (A86)', () => {
        const s = autoPickLobby({ lobby: { banMode: { tag: 'Four' } }, costs: { x: LADDER(10), y: LADDER(20), z: LADDER(30) } });
        const { test, lobbyId } = s;
        expect(current(test, lobbyId)).toMatchObject({ actionRequired: { tag: 'Ban' }, teamTurn: { tag: 'Blue' } });
        tx(test, captainOf(s, 'Blue'), (ctx) => M.ban_character(ctx, { lobbyId, characterName: 'x' }));
        tx(test, captainOf(s, 'Red'), (ctx) => M.ban_character(ctx, { lobbyId, characterName: 'y' }));
        expect(current(test, lobbyId)).toMatchObject({ actionRequired: { tag: 'Pick' }, teamTurn: { tag: 'Blue' } });
        expire(s);
        expect(pickValue(lastPick(test, lobbyId))).toEqual({ characterName: 'z', eidolon: 0, costPaid: 30 });
        expire(s); // Red: x, y banned, z picked by Blue
        expect(pickValue(lastPick(test, lobbyId))).toEqual({ characterName: 'EMPTY', eidolon: 0, costPaid: 0 });
    });

    it('autoRandomPick off: the expired turn records EMPTY at cost 0 even with cost rows present (A86)', () => {
        const test = newHarness();
        insertCharacterCostLadder(test, 'x', 'Classic', LADDER(10));
        const s = setupLobby(test, { seats: ONE_V_ONE });
        expire(s);
        expect(pickValue(lastPick(test, s.lobbyId))).toEqual({ characterName: 'EMPTY', eidolon: 0, costPaid: 0 });
        expect(teamCosts(test, s.lobbyId, 'Blue')).toEqual([0]);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// A87: mirror picks, once per team
// ════════════════════════════════════════════════════════════════════════════

describe('A87: with allowMirrorPicks a team may take the other team\'s pick, never its own twice', () => {
    /** Rejects `characterName` for the acting team: no step written, the turn unchanged; returns the text. */
    function rejectedPick(s: Lobby, team: Team, characterName: string): string {
        const before = snap(pickSteps(s.test, s.lobbyId), session(s.test, s.lobbyId).turnIndex);
        const msg = rejection(s.test, captainOf(s, team), pickBody(s, characterName));
        expect(snap(pickSteps(s.test, s.lobbyId), session(s.test, s.lobbyId).turnIndex)).toBe(before);
        return msg;
    }

    it('mirror on: Blue picks X, Red picks X; a second X by Red and by Blue is rejected (A87)', () => {
        const test = newHarness();
        const s = setupLobby(test, { lobby: { allowMirrorPicks: true } });
        pickAs(s, 'Blue', 'X');                        // turn 0 Blue
        pickAs(s, 'Red', 'X');                         // turn 1 Red: the other team's pick is open to Red
        expect(current(test, s.lobbyId).teamTurn.tag).toBe('Red');
        expect(rejectedPick(s, 'Red', 'X')).toBe(MIRROR_TWICE);  // turn 2 Red: its own pick again
        pickAs(s, 'Red', 'R-other');
        expect(current(test, s.lobbyId).teamTurn.tag).toBe('Blue');
        expect(rejectedPick(s, 'Blue', 'X')).toBe(MIRROR_TWICE); // turn 3 Blue: its own pick again
        expect(pickSteps(test, s.lobbyId).map((st) => pickValue(st).characterName)).toEqual(['X', 'X', 'R-other']);
    });

    it('mirror off: a second X by either team is rejected with the old text (A87)', () => {
        const test = newHarness();
        const s = setupLobby(test);
        pickAs(s, 'Blue', 'X');
        expect(rejectedPick(s, 'Red', 'X')).toBe(ALREADY_PICKED);
        pickAs(s, 'Red', 'R-1');
        pickAs(s, 'Red', 'R-2');
        expect(rejectedPick(s, 'Blue', 'X')).toBe(ALREADY_PICKED);
    });

    // EMPTY is the no-pick placeholder, not a character (S10d review F1): it never blocks, mirror on or off.
    for (const mirror of [true, false]) {
        it(`mirror ${mirror ? 'on' : 'off'}: a team holding an EMPTY pick (one by timer, one manual) picks EMPTY again by hand (A87)`, () => {
            const test = newHarness();
            const s = setupLobby(test, { lobby: { allowMirrorPicks: mirror } }); // autoRandomPick off: the timer records EMPTY
            expire(s);                      // turn 0 Blue: EMPTY by timer
            expect(lastPick(test, s.lobbyId).actorSlot.tag).toBe('Blue');
            pickAs(s, 'Red', 'EMPTY');      // turn 1 Red: the other team holds EMPTY
            pickAs(s, 'Red', 'EMPTY');      // turn 2 Red: its own manual EMPTY again
            pickAs(s, 'Blue', 'EMPTY');     // turn 3 Blue: holds a timer EMPTY
            pickAs(s, 'Red', 'x');          // turn 4 Red
            pickAs(s, 'Blue', 'EMPTY');     // turn 5 Blue: holds a timer EMPTY and a manual EMPTY
            expect(pickSteps(test, s.lobbyId).map((st) => [st.actorSlot.tag, pickValue(st).characterName, pickValue(st).costPaid]))
                .toEqual([['Blue', 'EMPTY', 0], ['Red', 'EMPTY', 0], ['Red', 'EMPTY', 0], ['Blue', 'EMPTY', 0], ['Red', 'x', 0], ['Blue', 'EMPTY', 0]]);
        });
    }

    it('the timer never draws a character the acting team holds, and under mirror may draw one the other team holds (A87)', () => {
        const s = autoPickLobby({ lobby: { allowMirrorPicks: true }, costs: { x: LADDER(10), y: LADDER(20) } });
        const { test, lobbyId } = s;
        pickAs(s, 'Blue', 'x'); // turn 0
        pickAs(s, 'Red', 'y');  // turn 1
        expire(s);              // turn 2, Red: holds y; x is Blue's and open under mirror
        expect(lastPick(test, lobbyId).actorSlot.tag).toBe('Red');
        expect(pickValue(lastPick(test, lobbyId))).toMatchObject({ characterName: 'x', costPaid: 10 });
        expire(s);              // turn 3, Blue: holds x → y
        expect(lastPick(test, lobbyId).actorSlot.tag).toBe('Blue');
        expect(pickValue(lastPick(test, lobbyId))).toMatchObject({ characterName: 'y', costPaid: 20 });
        expire(s);              // turn 4, Red: holds x and y
        expect(pickValue(lastPick(test, lobbyId)).characterName).toBe('EMPTY');
        for (const team of ['Blue', 'Red'] as const) {
            const real = pickSteps(test, lobbyId).filter((st) => st.actorSlot.tag === team).map((st) => pickValue(st).characterName)
                .filter((n) => n !== 'EMPTY');
            expect(new Set(real).size).toBe(real.length);
        }
    });
});

// ════════════════════════════════════════════════════════════════════════════
// A88: a team-seated tournament referee keeps score adjustments and the staff close (documentation test)
// ════════════════════════════════════════════════════════════════════════════

describe('A88: a referee seated on a team in a tournament lobby (documentation of A39 against A34a)', () => {
    /** A Bo1 tournament lobby created by the Blue captain (host + referee on the Blue player seat), played to Scoring. */
    function seatedRefereeGame() {
        const f = duel({ defaultBestOf: 1, grandFinalBestOf: 1 });
        const m = byKey(f.test, f.id, 'W-R1-M1');
        const s = openMatchLobby(f, m.id, { creator: sidesOf(f, m.id).blue.captain });
        const { test, lobbyId } = s;
        const ref = [...test.db.LobbyMember.lobby_id.filter(lobbyId)].find((r) => r.userId === s.host.userId)!;
        expect(ref.isReferee).toBe(true);
        expect(ref.lobbySlot.tag).toBe('BluePlayer');
        draftGame(s);
        for (const team of ['Blue', 'Red'] as const) {
            const names = tx(test, 'internal', (ctx) => teamDraft(ctx, lobbyId, team).characters);
            advance(test, 300); // the lineup throttle on the referee
            arrange(s, s.host, team, [names.slice(0, 4), names.slice(4, 8)]);
        }
        tx(test, s.host, (ctx) => M.advance_stage(ctx, { lobbyId }));
        expect(lobbyRow(test, lobbyId).stage.tag).toBe('Scoring');
        return { f, s };
    }

    it('the seated referee adjusts the other team\'s score and closes the game as staff: accepted (A88, A34a, A60(4))', () => {
        const { s } = seatedRefereeGame();
        const { test, lobbyId } = s;
        recordScores(s, s.host, 'Blue', [H(10), H(10)]);
        recordScores(s, s.host, 'Red', [H(20), H(20)]);
        tx(test, s.host, (ctx) => M.set_score_adjustment(ctx, { lobbyId, teamSide: side('Red'), value: H(1), reason: 'penalty' }));
        closeGame(s, s.host);
        expect(lobbyRow(test, lobbyId).stage.tag).toBe('AwaitingResult');
        const [rec] = recordsOfLobby(test, lobbyId);
        expect(rec.winnerTeamSide?.tag).toBe('Blue');
        expect(rec.refereeUserId).toBe(s.host.userId);
    });

    it('the same referee\'s winnerOverride on an unresolved tie is still rejected (A88 keeps A39)', () => {
        const { s } = seatedRefereeGame();
        const { test, lobbyId } = s;
        recordScores(s, s.host, 'Blue', [H(5), H(6)]);
        recordScores(s, s.host, 'Red', [H(5), H(6)]);
        const msg = rejection(test, s.host, (ctx) => M.close_game(ctx, { lobbyId, winnerOverride: side('Blue') }));
        expect(lobbyRow(test, lobbyId).stage.tag).toBe('Scoring');
        expect(recordsOfLobby(test, lobbyId)[0].status.tag).toBe('Pending');
        expect(msg).toBe(SEATED_TIE);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// A89: tournament staff manage tournament-linked calendar events
// ════════════════════════════════════════════════════════════════════════════

describe('A89: tournament-linked events accept the tournament organizer and bracket staff', () => {
    function calendarWorld() {
        const f = liveField(2);
        const { test, org, id } = f;
        const m = byKey(test, id, 'W-R1-M1');
        const asstA = verified(test, 'asstA');
        const asstB = verified(test, 'asstB');
        const asstP = verified(test, 'asstP');
        assignAssistant(test, org, id, asstA, { bracket: true });
        assignAssistant(test, org, id, asstB, { bracket: true });
        assignAssistant(test, org, id, asstP, { participants: true, results: true }); // no bracket permission
        const mod = moderator(test, 'calmod');
        const adm = verified(test, 'caladm');
        setUserRole(test, adm.userId, 'Admin');
        return {
            test, m, org, asstA, asstB, asstP, mod, adm,
            participant: f.ts[0].captain,
            stranger: verified(test, 'stranger'),
            invitee: verified(test, 'invitee'),
            invitee2: verified(test, 'invitee2'),
        };
    }
    type World = ReturnType<typeof calendarWorld>;

    const event = (test: Harness, id: number) => test.db.CalendarEvent.id.find(id) ?? undefined;
    const updateBody = (test: Harness, id: number, title: string) => (ctx: any) => {
        const e = ctx.db.CalendarEvent.id.find(id);
        return M.update_calendar_event(ctx, {
            eventId: id, title, description: '',
            startAt: e.startAt.microsSinceUnixEpoch.toString(), endAt: e.endAt.microsSinceUnixEpoch.toString(),
        });
    };
    const linkedEvent = (w: World) => createEvent(w.test, w.asstA, { title: 'Final', bracketMatchId: w.m.id });

    it.each(['org', 'asstB', 'mod', 'adm'] as const)('%s updates, invites, removes an invite and deletes an event an assistant scheduled (A89)', (who) => {
        const w = calendarWorld();
        const { test } = w;
        const caller = w[who];
        const id = linkedEvent(w);
        tx(test, caller, updateBody(test, id, 'Final (moved)'));
        expect(event(test, id)!.title).toBe('Final (moved)');
        tx(test, caller, (ctx) => M.invite_to_event(ctx, { eventId: id, inviteeUserId: w.invitee.userId }));
        expect(invite(test, id, w.invitee.userId)).toBeDefined();
        tx(test, caller, (ctx) => M.remove_invite(ctx, { eventId: id, inviteeUserId: w.invitee.userId }));
        expect(invite(test, id, w.invitee.userId)).toBeUndefined();
        tx(test, caller, (ctx) => M.delete_calendar_event(ctx, { eventId: id }));
        expect(event(test, id)).toBeUndefined();
    });

    it.each(['asstP', 'participant', 'stranger'] as const)('%s (no bracket permission) is rejected on every call with the linked text; nothing changes (A89)', (who) => {
        const w = calendarWorld();
        const { test } = w;
        const caller = w[who];
        const id = linkedEvent(w);
        tx(test, w.asstA, (ctx) => M.invite_to_event(ctx, { eventId: id, inviteeUserId: w.invitee.userId }));
        const before = snap(event(test, id), invitesOf(test, id));
        const calls: Array<[string, (ctx: any) => unknown]> = [
            ['update this event', updateBody(test, id, 'hijack')],
            ['delete this event', (ctx) => M.delete_calendar_event(ctx, { eventId: id })],
            ['invite users to this event', (ctx) => M.invite_to_event(ctx, { eventId: id, inviteeUserId: w.invitee2.userId })],
            ['remove invites from this event', (ctx) => M.remove_invite(ctx, { eventId: id, inviteeUserId: w.invitee.userId })],
        ];
        for (const [action, body] of calls) {
            const msg = rejection(test, caller, body);
            expect(snap(event(test, id), invitesOf(test, id))).toBe(before);
            expect(msg).toBe(LINKED(action));
        }
    });

    it('a personal event still rejects everyone but its organizer and an Admin, with the old text (A89, D-08)', () => {
        const w = calendarWorld();
        const { test } = w;
        const id = createEvent(test, w.asstA, { title: 'Personal' });
        for (const caller of [w.org, w.asstB, w.mod, w.stranger]) {
            const before = snap(event(test, id), invitesOf(test, id));
            const msg = rejection(test, caller, updateBody(test, id, 'hijack'));
            expect(snap(event(test, id), invitesOf(test, id))).toBe(before);
            expect(msg).toBe(PERSONAL('update this event'));
            const del = rejection(test, caller, (ctx) => M.delete_calendar_event(ctx, { eventId: id }));
            expect(event(test, id)).toBeDefined();
            expect(del).toBe(PERSONAL('delete this event'));
        }
        tx(test, w.adm, updateBody(test, id, 'By admin'));
        expect(event(test, id)!.title).toBe('By admin');
        tx(test, w.asstA, updateBody(test, id, 'By organizer'));
        expect(event(test, id)!.title).toBe('By organizer');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// A90: update_calendar_event enforces the active cap
// ════════════════════════════════════════════════════════════════════════════

describe('A90: reviving an ended event counts against the organizer\'s 40 active events', () => {
    const event = (test: Harness, id: number) => test.db.CalendarEvent.id.find(id)!;
    const updateBody = (id: number, o: { title?: string; endAt?: string }) => (ctx: any) => {
        const e = ctx.db.CalendarEvent.id.find(id);
        return M.update_calendar_event(ctx, {
            eventId: id, title: o.title ?? e.title, description: e.description ?? '',
            startAt: e.startAt.microsSinceUnixEpoch.toString(), endAt: o.endAt ?? e.endAt.microsSinceUnixEpoch.toString(),
        });
    };
    const activeOf = (test: Harness, who: Actor) =>
        eventsOf(test, who).filter((e) => e.endAt.microsSinceUnixEpoch >= test.clock.now().microsSinceUnixEpoch);

    it('40 active + ended events: a revive is rejected (row unchanged); an active edit and an ended title edit pass; at 39 the revive passes; an Admin\'s revive counts the organizer\'s events (A90)', () => {
        const test = newHarness();
        const a = verified(test, 'calorg');
        const adm = verified(test, 'caladm');
        setUserRole(test, adm.userId, 'Admin');
        const ended1 = createEvent(test, a, { title: 'ended-1', startMs: 0, endMs: HOUR_MS });
        const ended2 = createEvent(test, a, { title: 'ended-2', startMs: 0, endMs: HOUR_MS });
        advance(test, 2 * HOUR_MS);
        const active = Array.from({ length: 40 }, (_, i) => createEvent(test, a, { title: `E${i}`, startMs: (i + 1) * DAY_MS }));
        expect(activeOf(test, a)).toHaveLength(40);

        // The organizer revives an ended event: rejected, the row unchanged.
        const before = snap(event(test, ended1));
        const msg = rejection(test, a, updateBody(ended1, { endAt: fromNow(test, DAY_MS) }));
        expect(snap(event(test, ended1))).toBe(before);
        expect(activeOf(test, a)).toHaveLength(40);
        expect(msg).toBe(ACTIVE_CAP);

        // An active event's end time moved later (still active) is not counted again.
        tx(test, a, updateBody(active[0], { endAt: fromNow(test, DAY_MS + 3 * HOUR_MS) }));
        expect(event(test, active[0]).endAt.microsSinceUnixEpoch).toBe(BigInt(fromNow(test, DAY_MS + 3 * HOUR_MS)));
        // An ended event that stays ended (title only) is not counted either.
        tx(test, a, updateBody(ended2, { title: 'ended-2 renamed' }));
        expect(event(test, ended2).title).toBe('ended-2 renamed');

        // An Admin reviving the organizer's ended event: the organizer's 40 count (the Admin holds none).
        expect(eventsOf(test, adm)).toHaveLength(0);
        const adminBefore = snap(event(test, ended2));
        const adminMsg = rejection(test, adm, updateBody(ended2, { endAt: fromNow(test, DAY_MS) }));
        expect(snap(event(test, ended2))).toBe(adminBefore);
        expect(adminMsg).toBe(ACTIVE_CAP);

        // At 39 active the revive passes, and the event is active again.
        tx(test, a, (ctx) => M.delete_calendar_event(ctx, { eventId: active[39] }));
        expect(activeOf(test, a)).toHaveLength(39);
        tx(test, a, updateBody(ended1, { endAt: fromNow(test, DAY_MS) }));
        expect(activeOf(test, a)).toHaveLength(40);
        expect(activeOf(test, a).map((e) => e.id)).toContain(ended1);
    });
});

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
