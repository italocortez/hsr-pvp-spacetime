// Match session: timer auto-picks: autoRandomPick account checks at start_draft and the re-roll after an undo; a timer
//   auto-pick is priced like a manual pick; mirror picks take the other team's pick, never a team's own twice.
// Decisions: A86, A87, A117
// Contracts: docs/match-session/contract.md
// From S10d, S10o (s10d-rulings.test.ts, s10o-autopick-guest-entry.test.ts); merged by T-REORG2.
import { describe, expect, it } from 'vitest';
import { toHundredths } from '@shared/scoring';
import { teamDraft } from '@module/helpers/results/scoringHelpers';
import {
    M,
    advance,
    dropDefaultCostCoverage,
    expectReject,
    guest,
    lobbyRow,
    newHarness,
    priceCharacters,
    seatOf,
    session,
    setupLobby,
    steps,
    tx,
    type Harness,
    type Lobby,
    TURN_MS,
    ONE_V_ONE,
    type Actor,
    rejection,
    snap,
    type Team,
} from '../fixtures/harness';
import { host, verified } from '../fixtures/identity';
import {
    captain,
    selectAccount,
    current,
    insertCharacterCostLadder,
    insertRoster,
} from '../fixtures/draft-and-scoring';
import { join, presetArgs, presetNamed } from '../fixtures/lobby';
import { advanceStage, openTournament, register, seedAndGenerate, tRow } from '../fixtures/tournaments';
import { byKey, createTournamentLobby } from '../fixtures/tournament-matches';

// ─── Texts ───────────────────────────────────────────────────────────────────

const NO_ACCOUNT_AUTO = (n: number) =>
    `The player at seat ${n} has no account selected. autoRandomPick requires all players to have characters.`;
const NO_ACCOUNT_RANKED = (n: number) =>
    `The player at seat ${n} has no account selected for this match. All players must select an account before starting a ranked or MMR-counted match.`;

// ─── Builders ────────────────────────────────────────────────────────────────

const POOL = Array.from({ length: 12 }, (_, i) => `pool${i}`);

const expireBody = (lobbyId: number) => (ctx: any) => M.timer_expiry_classic(ctx, { lobbyId });
const undoBody = (lobbyId: number) => (ctx: any) => M.undo_last_step(ctx, { lobbyId });
const lastStep = (test: Harness, lobbyId: number) => steps(test, lobbyId).sort((a, b) => b.sequence - a.sequence)[0];
const lastDraftName = (test: Harness, lobbyId: number) => (lastStep(test, lobbyId).payload.value as any).characterName as string;

/** A 1v1 lobby (b1 Blue, r1 Red, the guest host a Spectator referee) with autoRandomPick on, started; `names` priced. */
function autoLobby(test: Harness, names: string[], lobby: Record<string, unknown> = {}, cost = 0): Lobby {
    const s = setupLobby(test, { seats: ONE_V_ONE, lobby: { autoRandomPick: true, ...lobby } });
    priceCharacters(test, s.lobbyId, names, cost);
    dropDefaultCostCoverage(test);
    return s;
}

/** `cycles` rounds of: the turn expires (the timer draw is recorded), the referee undoes it. Returns the drawn names. */
function rerollCycles(s: Lobby, cycles: number): string[] {
    const drawn: string[] = [];
    const turn = session(s.test, s.lobbyId).turnIndex;
    for (let i = 0; i < cycles; i++) {
        advance(s.test, TURN_MS);
        tx(s.test, s.host, expireBody(s.lobbyId));
        expect(lastStep(s.test, s.lobbyId).actorUserId).toBe(0);
        drawn.push(lastDraftName(s.test, s.lobbyId));
        tx(s.test, s.host, undoBody(s.lobbyId));
        expect(session(s.test, s.lobbyId).turnIndex).toBe(turn);
    }
    return drawn;
}

// ════════════════════════════════════════════════════════════════════════════
// A117(1): the start check follows requireOwnership
// ════════════════════════════════════════════════════════════════════════════

describe('A117(1): start_draft checks accounts for autoRandomPick only when the lobby requires ownership', () => {
    it('A117(1): casual lobby, ownership off, a guest and a verified player without a game account seated: the draft starts', () => {
        const test = newHarness();
        const b1 = guest(test, 'b1');
        const r1 = verified(test, 'r1');
        const s = setupLobby(test, { seats: ONE_V_ONE, actors: { b1, r1 }, lobby: { autoRandomPick: true } });
        expect(test.db.User.id.find(b1.userId)!.isGuest).toBe(true);
        expect(test.db.User.id.find(r1.userId)!.isGuest).toBe(false);
        expect([...test.db.LobbyMemberAccount.lobby_id.filter(s.lobbyId)]).toHaveLength(0);
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('Drafting');
    });

    it('A117(1)(2): without ownership the timer picks a character priced in the lobby\'s cost set, at its cost', () => {
        const test = newHarness();
        const s = autoLobby(test, POOL, {}, 7);
        advance(test, TURN_MS);
        tx(test, s.host, expireBody(s.lobbyId));
        const step = lastStep(test, s.lobbyId);
        expect(step.action.tag).toBe('Pick');
        expect(step.actorUserId).toBe(0);
        expect(POOL).toContain((step.payload.value as any).characterName);
        expect(step.payload.value).toMatchObject({ eidolon: 0, costPaid: 7 });
    });

    it('A117(1): with ownership on, a player without an account is still rejected with the existing text', () => {
        const test = newHarness();
        const actors = { host: verified(test, 'h'), b1: verified(test, 'b1'), r1: verified(test, 'r1') };
        const s = setupLobby(test, { noStart: true, seats: ONE_V_ONE, actors, lobby: { autoRandomPick: true, requireOwnership: true } });
        selectAccount(test, s.lobbyId, s.a.b1.userId, 900, { c1: 0 });
        const seat = seatOf(test, s.lobbyId, s.a.r1.userId);
        expectReject(test, s.host, (ctx) => M.start_draft(ctx, { lobbyId: s.lobbyId }), NO_ACCOUNT_AUTO(seat));
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('Waiting');
    });

    it('A117(1): a Ranked lobby still requires selected accounts (autoRandomPick on, ownership off)', () => {
        const test = newHarness();
        const actors = { host: verified(test, 'h'), b1: verified(test, 'b1'), r1: verified(test, 'r1') };
        const s = setupLobby(test, {
            noStart: true, seats: ONE_V_ONE, actors,
            lobby: { autoRandomPick: true, requireOwnership: false, matchType: { tag: 'Ranked' } },
        });
        selectAccount(test, s.lobbyId, s.a.b1.userId, 900, { c1: 0 });
        const seat = seatOf(test, s.lobbyId, s.a.r1.userId);
        expectReject(test, s.host, (ctx) => M.start_draft(ctx, { lobbyId: s.lobbyId }), NO_ACCOUNT_RANKED(seat));
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('Waiting');
    });

    it('A117(1): a guest-admitting tournament whose preset has autoRandomPick on: a match lobby with a guest starts and auto-picks', () => {
        const test = newHarness();
        const org = host(test);
        tx(test, org, (ctx) => M.create_lobby_preset(ctx, presetArgs('Auto preset', { teamSize: 1, autoRandomPick: true })));
        const presetId = presetNamed(test, 'Auto preset')!.id;
        const id = openTournament(test, org, { teamSize: 1, maxParticipants: 8, lobbyPresetId: presetId });
        expect(tRow(test, id).requireVerified).toBe(false);
        const g = guest(test, 'tg');
        const v = verified(test, 'tv');
        register(test, g, id);
        register(test, v, id);
        advanceStage(test, org, id, 'Seeding');
        seedAndGenerate(test, org, id);
        advanceStage(test, org, id, 'InProgress');

        const m = byKey(test, id, 'W-R1-M1');
        const lobbyId = createTournamentLobby(test, org, m.id);
        expect(lobbyRow(test, lobbyId).autoRandomPick).toBe(true);
        expect(lobbyRow(test, lobbyId).requireOwnership).toBe(false);
        for (const who of [g, v]) {
            join(test, who, lobbyId);
            tx(test, who, (ctx) => M.confirm_ready(ctx, { lobbyId }));
        }
        tx(test, org, (ctx) => M.start_draft(ctx, { lobbyId }));
        expect(lobbyRow(test, lobbyId).stage.tag).toBe('Drafting');

        priceCharacters(test, lobbyId, POOL);
        dropDefaultCostCoverage(test);
        expect(current(test, lobbyId).actionRequired.tag).toBe('Pick');
        advance(test, TURN_MS);
        tx(test, org, expireBody(lobbyId));
        expect(lastStep(test, lobbyId).actorUserId).toBe(0);
        expect(POOL).toContain(lastDraftName(test, lobbyId));
    });
});

// ════════════════════════════════════════════════════════════════════════════
// A117(3): an undone timer draw can land elsewhere
// ════════════════════════════════════════════════════════════════════════════

describe('A117(3): after an undo the same turn re-rolls', () => {
    it('A117(3): over undo / expire cycles on one Pick turn the draw changes; every draw is in the pool, never banned or already held', () => {
        const test = newHarness();
        const s = autoLobby(test, [...POOL, 'banB', 'banR', 'heldB', 'heldR1', 'heldR2'], { banMode: { tag: 'Four' } });
        // Four: [B] [R] B R R B ...: two manual bans, three manual picks, then Blue's second pick turn (turn 5).
        tx(test, captain(s, 'Blue'), (ctx) => M.ban_character(ctx, { lobbyId: s.lobbyId, characterName: 'banB' }));
        tx(test, captain(s, 'Red'), (ctx) => M.ban_character(ctx, { lobbyId: s.lobbyId, characterName: 'banR' }));
        tx(test, captain(s, 'Blue'), (ctx) => M.pick_character(ctx, { lobbyId: s.lobbyId, characterName: 'heldB', eidolon: 0 }));
        tx(test, captain(s, 'Red'), (ctx) => M.pick_character(ctx, { lobbyId: s.lobbyId, characterName: 'heldR1', eidolon: 0 }));
        tx(test, captain(s, 'Red'), (ctx) => M.pick_character(ctx, { lobbyId: s.lobbyId, characterName: 'heldR2', eidolon: 0 }));
        expect(current(test, s.lobbyId)).toMatchObject({ actionRequired: { tag: 'Pick' }, teamTurn: { tag: 'Blue' } });

        const drawn = rerollCycles(s, 10);
        expect(new Set(drawn).size).toBeGreaterThanOrEqual(2);
        for (const name of drawn) expect(POOL).toContain(name); // not banB / banR / heldB / heldR1 / heldR2 (mirror off)
    });

    it('A117(3): with a pool of exactly one entry the same entry is drawn every time', () => {
        const test = newHarness();
        const s = autoLobby(test, ['only']);
        expect(rerollCycles(s, 5)).toEqual(Array(5).fill('only'));
    });

    it('A117(3): the draw is deterministic for a given state: replaying the same sequence in a fresh harness gives the same draws', () => {
        const run = () => rerollCycles(autoLobby(newHarness(), POOL), 6);
        const first = run();
        expect(run()).toEqual(first);
        expect(new Set(first).size).toBeGreaterThanOrEqual(2);
    });

    it('A117(3) (review F2): the draw depends on the transaction time: fresh harnesses that differ only in when the expired turn is fired draw different entries', () => {
        const drawn: string[] = [];
        const keys = new Set<string>();
        for (let ms = 0; ms < 10; ms++) {
            const test = newHarness();
            const s = autoLobby(test, POOL);
            advance(test, TURN_MS + 1 + ms * 7); // only the expiry's timestamp differs between the runs
            const turn = session(test, s.lobbyId).turnIndex;
            tx(test, s.host, expireBody(s.lobbyId));
            const step = lastStep(test, s.lobbyId);
            keys.add(`${s.lobbyId}/${turn}/${step.sequence}`);
            drawn.push(lastDraftName(test, s.lobbyId));
        }
        expect(keys.size).toBe(1); // same lobby, turn and sequence every run
        expect(new Set(drawn).size).toBeGreaterThanOrEqual(3);
    });

    it('A117(3): the auto-ban follows the same re-roll rule (Ban turn; every draw in the pool)', () => {
        const test = newHarness();
        const s = autoLobby(test, POOL, { banMode: { tag: 'Four' } });
        expect(current(test, s.lobbyId)).toMatchObject({ actionRequired: { tag: 'Ban' }, teamTurn: { tag: 'Blue' } });
        const drawn = rerollCycles(s, 10);
        for (const name of drawn) expect(POOL).toContain(name);
        expect(new Set(drawn).size).toBeGreaterThanOrEqual(2);
        expect(steps(test, s.lobbyId).filter((st) => st.action.tag === 'Ban')).toHaveLength(0); // every auto-ban undone
    });

    it('A117(3): a one-entry ban pool bans that entry every time', () => {
        const test = newHarness();
        const s = autoLobby(test, ['only'], { banMode: { tag: 'Four' } });
        expect(rerollCycles(s, 4)).toEqual(Array(4).fill('only'));
    });
});

// ─── Texts (the module code is the truth for the wording; the rows for the behaviour) ─────────────────────────────

const MIRROR_TWICE = 'Your team already picked this character.';
const ALREADY_PICKED = 'Character already picked.';


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
