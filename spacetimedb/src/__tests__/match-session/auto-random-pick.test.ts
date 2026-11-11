// Match session: autoRandomPick account checks at start_draft and the re-roll after an undo.
// Decisions: A117
// Contracts: docs/match-session/contract.md
// From S10o (s10o-autopick-guest-entry.test.ts).
import { describe, expect, it } from 'vitest';
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
} from '../fixtures/harness';
import { captain, selectAccount } from '../fixtures/draft-and-scoring-builders';
import {
    advanceStage,
    host,
    openTournament,
    register,
    seedAndGenerate,
    tRow,
    verified,
} from '../fixtures/tournament-builders';
import { byKey, createTournamentLobby, join } from '../fixtures/tournament-match-builders';
import { presetArgs, presetNamed } from '../fixtures/preset-and-account-builders';

// ─── Texts ───────────────────────────────────────────────────────────────────

const NO_ACCOUNT_AUTO = (n: number) =>
    `The player at seat ${n} has no account selected. autoRandomPick requires all players to have characters.`;
const NO_ACCOUNT_RANKED = (n: number) =>
    `The player at seat ${n} has no account selected for this match. All players must select an account before starting a ranked or MMR-counted match.`;

// ─── Builders ────────────────────────────────────────────────────────────────

const TURN_MS = 30_000; // DEFAULT_LOBBY_ARGS.standardTurnSeconds / PRESET_ARGS.standardTurnSeconds
const POOL = Array.from({ length: 12 }, (_, i) => `pool${i}`);
const ONE_V_ONE: Array<[string, 'BluePlayer' | 'RedPlayer']> = [['b1', 'BluePlayer'], ['r1', 'RedPlayer']];

const expireBody = (lobbyId: number) => (ctx: any) => M.timer_expiry_classic(ctx, { lobbyId });
const undoBody = (lobbyId: number) => (ctx: any) => M.undo_last_step(ctx, { lobbyId });
const lastStep = (test: Harness, lobbyId: number) => steps(test, lobbyId).sort((a, b) => b.sequence - a.sequence)[0];
const lastDraftName = (test: Harness, lobbyId: number) => (lastStep(test, lobbyId).payload.value as any).characterName as string;
const current = (test: Harness, lobbyId: number) => {
    const sess = session(test, lobbyId);
    return sess.draftSequence[sess.turnIndex];
};

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
