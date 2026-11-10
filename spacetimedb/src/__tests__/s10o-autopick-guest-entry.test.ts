// T-S10o: in-memory tests for step S10o (DECISIONS.md A117, A118). A117: start_draft's autoRandomPick account check runs
// only when the lobby requires ownership; the timer draw (pick and ban) can land on another entry after the referee
// undoes it and the turn expires again; the pools are unchanged. A118: before the bracket exists, staff with the
// participants permission remove a guest's approved entry with reject_participant, as a withdrawal. TestClock; every
// expiry follows an `advance`. Cost rows and accounts are written straight into the in-memory datastore outside any
// reducer; the set-0 coverage rows are dropped once the lobby exists so the timer pools hold only the names a test
// prices. Nothing reaches maincloud.
// T-S10o fix pass (review F2, F3): the timer draw now hashes the transaction time (shared/lobby-rules/timerDraw.ts, its
// distribution tested there); a test here proves the reducer's draw follows the time; three A118 branches added.
import { describe, expect, it } from 'vitest';
import {
    M,
    advance,
    dropDefaultCostCoverage,
    expectReject,
    guest,
    linkDiscord,
    lobbyRow,
    newHarness,
    priceCharacters,
    seatOf,
    session,
    setupLobby,
    steps,
    tx,
    type Actor,
    type Harness,
    type Lobby,
} from './s4-fixtures';
import { captain, selectAccount } from './s7-fixtures';
import {
    advanceStage,
    assignAssistant,
    bracketRows,
    createTournament,
    enrolled,
    generateBracket,
    host,
    makeTeam,
    membersOf,
    membership,
    openTournament,
    register,
    seedAndGenerate,
    seedBracket,
    tRow,
    teamRow,
    updateBody,
    verified,
} from './s8-fixtures';
import { byKey, createTournamentLobby, join } from './s8d-fixtures';
import { presetArgs, presetNamed } from './s10-a1-fixtures';

// ─── Texts ───────────────────────────────────────────────────────────────────

const NO_ACCOUNT_AUTO = (n: number) =>
    `The player at seat ${n} has no account selected. autoRandomPick requires all players to have characters.`;
const NO_ACCOUNT_RANKED = (n: number) =>
    `The player at seat ${n} has no account selected for this match. All players must select an account before starting a ranked or MMR-counted match.`;
const APPROVED = 'Participant is already approved; disqualify them instead.';
const GENERATED = 'Bracket generated; use stand-ins.';
const NO_PERMISSION = 'This action needs the participants permission.';
const guestsText = (n: number) => `These settings require verified accounts, and ${n} guest player(s) are registered.`;

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

// ════════════════════════════════════════════════════════════════════════════
// A118: staff remove a guest's approved entry before the bracket
// ════════════════════════════════════════════════════════════════════════════

const reject = (tournamentId: number, userId: number) => (ctx: any) => M.reject_participant(ctx, { tournamentId, userId });

describe('A118: reject_participant removes a guest\'s approved entry as a withdrawal before the bracket exists', () => {
    it('A118: solo guest: no Disqualified row, the empty solo team is deleted, the spot is freed for a third player', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { teamSize: 1, maxParticipants: 2 });
        const g = guest(test, 'g');
        const v = verified(test, 'v');
        register(test, g, id);
        register(test, v, id);
        const soloTeam = membership(test, id, g.userId)!.teamId;
        expect(enrolled(test, id, g.userId).approvedByToAt).toBeDefined();

        tx(test, org, reject(id, g.userId));
        expect(enrolled(test, id, g.userId)).toBeUndefined(); // no row at all, so no Disqualified row
        expect(membership(test, id, g.userId)).toBeUndefined();
        expect(teamRow(test, soloTeam)).toBeFalsy(); // Registration: the empty solo team is deleted

        // The freed spot: a third player takes it without the waitlist.
        const w = verified(test, 'w');
        register(test, w, id);
        expect(enrolled(test, id, w.userId).isWaitlisted).toBe(false);
        expect(enrolled(test, id, v.userId)).toBeTruthy();
    });

    it('A118: the removed guest can register again, and after signing in to a verified account can register too', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { teamSize: 1, maxParticipants: 4 });
        const g = guest(test, 'g');
        register(test, g, id);
        tx(test, org, reject(id, g.userId));
        register(test, g, id);
        expect(enrolled(test, id, g.userId).status.tag).toBe('Registered');

        tx(test, org, reject(id, g.userId));
        linkDiscord(test, g, 'pid-g', 'g'); // first-time link: the guest is upgraded in place
        expect(test.db.User.id.find(g.userId)!.isGuest).toBe(false);
        register(test, g, id);
        expect(enrolled(test, id, g.userId).status.tag).toBe('Registered');
    });

    it('A118: a guest team member is removed; the team keeps its captain', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { teamSize: 2 });
        const cap = verified(test, 'cap');
        const g = guest(test, 'g');
        register(test, cap, id);
        register(test, g, id);
        const teamId = makeTeam(test, id, cap, [g], 'Mixed');
        expect(membersOf(test, teamId)).toEqual([cap.userId, g.userId].sort((a, b) => a - b));

        tx(test, org, reject(id, g.userId));
        expect(enrolled(test, id, g.userId)).toBeUndefined();
        expect(membersOf(test, teamId)).toEqual([cap.userId]);
        expect(teamRow(test, teamId)!.captainUserId).toBe(cap.userId);
    });

    it('A118: a guest captain with a mate is removed; the captaincy passes to the mate', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { teamSize: 2 });
        const g = guest(test, 'g');
        const mate = verified(test, 'mate');
        register(test, g, id);
        register(test, mate, id);
        const teamId = makeTeam(test, id, g, [mate], 'Guest led');

        tx(test, org, reject(id, g.userId));
        expect(enrolled(test, id, g.userId)).toBeUndefined();
        expect(membersOf(test, teamId)).toEqual([mate.userId]);
        expect(teamRow(test, teamId)!.captainUserId).toBe(mate.userId);
    });

    it('A118: the guest\'s team requests are removed with the entry', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { teamSize: 2 });
        const cap = verified(test, 'cap');
        const g = guest(test, 'g');
        register(test, cap, id);
        register(test, g, id);
        tx(test, cap, (ctx) => M.create_tournament_team(ctx, { tournamentId: id, teamName: 'T' }));
        const teamId = membership(test, id, cap.userId)!.teamId;
        tx(test, g, (ctx) => M.request_join_team(ctx, { teamId }));
        expect([...test.db.TournamentTeamRequest.user_id.filter(g.userId)]).toHaveLength(1);
        tx(test, org, reject(id, g.userId));
        expect([...test.db.TournamentTeamRequest.user_id.filter(g.userId)]).toHaveLength(0);
    });

    it('A118: a waitlisted player is not promoted by the removal (a withdrawal promotes nobody), and the freed spot lets staff promote them', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { teamSize: 1, maxParticipants: 2, waitlistEnabled: true });
        const g = guest(test, 'g');
        const v = verified(test, 'v');
        const w = verified(test, 'w');
        for (const p of [g, v, w]) register(test, p, id);
        expect(enrolled(test, id, w.userId).isWaitlisted).toBe(true);
        expectReject(test, org, (ctx) => M.waitlist_promote(ctx, { tournamentId: id, userId: w.userId }), 'No free spot: the tournament is full.');

        tx(test, org, reject(id, g.userId));
        expect(enrolled(test, id, w.userId).isWaitlisted).toBe(true);
        tx(test, org, (ctx) => M.waitlist_promote(ctx, { tournamentId: id, userId: w.userId }));
        expect(enrolled(test, id, w.userId).isWaitlisted).toBe(false);
    });

    it('A118: in CheckIn and in Seeding before generation the guest entry is removed too', () => {
        for (const stage of ['CheckIn', 'Seeding']) {
            const test = newHarness();
            const org = host(test);
            const id = openTournament(test, org, { teamSize: 1, checkInEnabled: stage === 'CheckIn' });
            const g = guest(test, 'g');
            const v = verified(test, 'v');
            register(test, g, id);
            register(test, v, id);
            advanceStage(test, org, id, stage);
            expect(tRow(test, id).stage.tag).toBe(stage);
            tx(test, org, reject(id, g.userId));
            expect(enrolled(test, id, g.userId)).toBeUndefined();
            expect(enrolled(test, id, v.userId)).toBeTruthy();
        }
    });

    it('A118: an approved verified player is still refused with the existing text', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { teamSize: 1 });
        const v = verified(test, 'v');
        register(test, v, id);
        expectReject(test, org, reject(id, v.userId), APPROVED);
        expect(enrolled(test, id, v.userId)).toBeTruthy();
    });

    it('A118: a guest whose approved row is already Disqualified is refused with the existing text; the row stays', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { teamSize: 1 });
        const g = guest(test, 'g');
        const v = verified(test, 'v');
        register(test, g, id);
        register(test, v, id);
        tx(test, org, (ctx) => M.dq_participant(ctx, { tournamentId: id, userId: g.userId, reason: 'test' }));
        const before = enrolled(test, id, g.userId)!;
        expect(before.status.tag).toBe('Disqualified');
        expect(before.approvedByToAt).toBeDefined();

        expectReject(test, org, reject(id, g.userId), APPROVED);
        expect(enrolled(test, id, g.userId)).toEqual(before);
    });

    it('A118: a guest upgraded in place while still enrolled is a verified player: refused with the existing text', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { teamSize: 1 });
        const g = guest(test, 'g');
        register(test, g, id);
        linkDiscord(test, g, 'pid-g', 'g'); // first-time link: the same User row, now verified, keeps its entry
        expect(test.db.User.id.find(g.userId)!.isGuest).toBe(false);
        const before = enrolled(test, id, g.userId)!;
        expect(before.approvedByToAt).toBeDefined();

        expectReject(test, org, reject(id, g.userId), APPROVED);
        expect(enrolled(test, id, g.userId)).toEqual(before);
    });

    it('A118: in Seeding a seeded guest\'s solo team is removed (marked Withdrawn), then generate_bracket places the other teams only', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { teamSize: 1, maxParticipants: 8 });
        const g = guest(test, 'g');
        const others = ['v1', 'v2', 'v3', 'v4'].map((n) => verified(test, n));
        for (const p of [g, ...others]) register(test, p, id);
        advanceStage(test, org, id, 'Seeding');
        seedBracket(test, org, id);
        const guestTeam = membership(test, id, g.userId)!.teamId;
        expect(teamRow(test, guestTeam)!.seedNumber).toBeDefined();

        tx(test, org, reject(id, g.userId));
        expect(enrolled(test, id, g.userId)).toBeUndefined();
        expect(teamRow(test, guestTeam)!.status.tag).toBe('Withdrawn'); // after Registration: kept, marked Withdrawn

        generateBracket(test, org, id);
        expect(tRow(test, id).bracketGeneratedAt).toBeDefined();
        const placed = new Set(bracketRows(test, id).flatMap((r) => [r.team1Id, r.team2Id]).filter((t) => t !== undefined));
        expect(placed.has(guestTeam)).toBe(false);
        for (const p of others) expect(placed.has(membership(test, id, p.userId)!.teamId)).toBe(true);
    });

    it('A118: after the bracket exists a guest is refused with the existing text', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { teamSize: 1 });
        const g = guest(test, 'g');
        const v = verified(test, 'v');
        register(test, g, id);
        register(test, v, id);
        advanceStage(test, org, id, 'Seeding');
        seedAndGenerate(test, org, id);
        expectReject(test, org, reject(id, g.userId), GENERATED);
        expect(enrolled(test, id, g.userId)).toBeTruthy();
    });

    it('A118: a caller without the participants permission is refused', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { teamSize: 1 });
        const g = guest(test, 'g');
        register(test, g, id);
        const bracketOnly = verified(test, 'bo');
        assignAssistant(test, org, id, bracketOnly, { bracket: true });
        const stranger = verified(test, 'stranger');
        for (const who of [bracketOnly, stranger] as Actor[]) {
            expectReject(test, who, reject(id, g.userId), NO_PERMISSION);
        }
        expect(enrolled(test, id, g.userId)).toBeTruthy();

        const helper = verified(test, 'helper');
        assignAssistant(test, org, id, helper, { participants: true });
        tx(test, helper, reject(id, g.userId));
        expect(enrolled(test, id, g.userId)).toBeUndefined();
    });

    it('A118 / A113(2): with the guests removed this way, the setting change that was refused now passes', () => {
        const test = newHarness();
        const org = host(test);
        const id = openTournament(test, org, { teamSize: 1, maxParticipants: 8 });
        const g1 = guest(test, 'g1');
        const g2 = guest(test, 'g2');
        const v = verified(test, 'v');
        for (const p of [g1, g2, v]) register(test, p, id);
        expectReject(test, org, updateBody(test, id, { requireRoster: true }), guestsText(2));

        tx(test, org, reject(id, g1.userId));
        tx(test, org, reject(id, g2.userId));
        tx(test, org, updateBody(test, id, { requireRoster: true }));
        expect(tRow(test, id)).toMatchObject({ requireRoster: true, requireVerified: true });
        expect(enrolled(test, id, v.userId)).toBeTruthy();
    });
});
