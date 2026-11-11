// Match session: a timer auto-pick is priced like a manual pick; mirror picks take the other team's pick, never a
//   team's own twice.
// Decisions: A86, A87
// Contracts: docs/match-session/contract.md
// From S10d (s10d-rulings.test.ts).
import { describe, expect, it } from 'vitest';
import { toHundredths } from '@shared/scoring';
import { teamDraft } from '@module/helpers/results/scoringHelpers';
import {
    M,
    advance,
    dropDefaultCostCoverage,
    newHarness,
    priceCharacters,
    session,
    setupLobby,
    steps,
    tx,
    type Actor,
    type Harness,
    type Lobby,
} from '../fixtures/harness';
import {
    insertCharacterCostLadder,
    insertRoster,
    selectAccount,
} from '../fixtures/draft-and-scoring-builders';
import { rejection } from '../fixtures/calendar-roster-rating-builders';
import { ONE_V_ONE, snap } from '../fixtures/seat-and-snapshot-helpers';

type Team = 'Blue' | 'Red';

// ─── Texts (the module code is the truth for the wording; the rows for the behaviour) ─────────────────────────────

const MIRROR_TWICE = 'Your team already picked this character.';
const ALREADY_PICKED = 'Character already picked.';

const TURN_MS = 30_000; // DEFAULT_LOBBY_ARGS.standardTurnSeconds

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
