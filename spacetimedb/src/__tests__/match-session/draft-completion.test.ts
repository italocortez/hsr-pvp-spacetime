// Match session: draft completion; the last pick or sale, the confirm window and the move to Equipping.
// Decisions: A100, A129, A130, A131
// Contracts: docs/match-session/contract.md
// From S10i, S10t (s10i-draft-cost.test.ts, s10t-undo-any-step.test.ts).
import { describe, expect, it } from 'vitest';
import { teamDraft } from '@module/helpers/results/scoringHelpers';
import {
    DEFAULT_LOBBY_ARGS,
    M,
    advance,
    disconnect,
    fireCheck,
    guest,
    lobbyRow,
    newHarness,
    pendingCheck,
    priceCharacters,
    session,
    setupLobby,
    tx,
    type Actor,
    type Lobby,
    rejection,
    type Team,
    AUCTION,
    ONE_V_ONE,
    TURN_MS,
    other,
    type Side,
} from '../fixtures/harness';
import {
    captain,
    completeDraft,
    engineerFullDraft,
    lobbyState,
    nominateBody,
    passBody,
    pickBody,
    advanceBody,
} from '../fixtures/draft-and-scoring';
import { budgets, stepsOf } from '../fixtures/auction';
import {
    FINISHED,
    classicTurn,
    lobby,
    nominate,
    pass,
    playClassic,
    stage,
    undo,
    undoBody,
    world,
} from '../fixtures/undo';
import { presetArgs, presetNamed, settingsArgs, updatePresetArgs } from '../fixtures/lobby';
import { byKey, createTournamentLobby, duel, seedElo } from '../fixtures/tournament-matches';
import { rankedHook } from '../fixtures/ranked';

const held = (s: Lobby, team: Team) => tx(s.test, 'internal', (ctx) => teamDraft(ctx, s.lobbyId, team).characters.length);

/**
 * Plays `n` draft turns through the reducers: a Classic Pick turn picks a priced filler, a Ban turn bans one; an Auction
 * turn is a nomination of a priced filler, passed by the other captain.
 */
function playSome(s: Lobby, n: number) {
    const { test, lobbyId } = s;
    for (let i = 0; i < n; i++) {
        const sess = session(test, lobbyId);
        const step = sess.draftSequence[sess.turnIndex];
        if (step && !sess.isAuctionPhase) {
            const team = step.teamTurn.tag as Team;
            const name = `some-${team}-${i}`;
            if (step.actionRequired.tag === 'Ban') {
                tx(test, captain(s, team), (ctx) => M.ban_character(ctx, { lobbyId, characterName: name }));
            } else {
                priceCharacters(test, lobbyId, [name]);
                tx(test, captain(s, team), pickBody(s, name));
            }
            continue;
        }
        const team = sess.nextNominatorTeam.tag as Team;
        const name = `some-${team}-${i}`;
        priceCharacters(test, lobbyId, [name]);
        tx(test, captain(s, team), nominateBody(s, name));
        tx(test, captain(s, team === 'Blue' ? 'Red' : 'Blue'), passBody(s));
    }
}

// ════════════════════════════════════════════════════════════════════════════
// B.1 A100: no advance out of an unfinished draft
// ════════════════════════════════════════════════════════════════════════════

describe('A100: advance_stage leaves Drafting only once both teams hold charactersPerTeam', () => {
    for (const mode of ['Classic', 'Auction'] as const) {
        for (const format of ['Halves', 'Thirds'] as const) {
            const perTeam = format === 'Halves' ? 8 : 12;

            it(`${mode} ${format}: refused with the counts while a team is short (nothing changes); accepted with both full, EMPTY placeholders counting (A100)`, () => {
                const test = newHarness();
                const s = setupLobby(test, { lobby: { draftMode: { tag: mode }, lineupFormat: { tag: format } } });
                playSome(s, 3);
                const [blue, red] = [held(s, 'Blue'), held(s, 'Red')];
                expect(blue + red).toBe(3);
                let before = lobbyState(s);
                let msg = rejection(test, s.host, advanceBody(s));
                expect(lobbyState(s)).toBe(before);
                expect(msg).toBe(`The draft is not finished: Blue holds ${blue} of ${perTeam} characters and Red holds ${red} of ${perTeam}.`);

                // Engineered: Blue full (EMPTY steps), Red still short; the reducers never leave this state in Drafting.
                engineerFullDraft(s, () => 'EMPTY', ['Blue']);
                before = lobbyState(s);
                msg = rejection(test, s.host, advanceBody(s));
                expect(lobbyState(s)).toBe(before);
                expect(msg).toBe(`The draft is not finished: Blue holds ${perTeam} of ${perTeam} characters and Red holds ${red} of ${perTeam}.`);

                engineerFullDraft(s, () => 'EMPTY', ['Red']);
                expect([held(s, 'Blue'), held(s, 'Red')]).toEqual([perTeam, perTeam]);
                tx(test, s.host, advanceBody(s));
                expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('Equipping');
            });

            it(`${mode} ${format}: the automatic transition at the end of the draft still reaches Equipping without advance_stage (A100)`, () => {
                const test = newHarness();
                const s = setupLobby(test, { lobby: { draftMode: { tag: mode }, lineupFormat: { tag: format } } });
                completeDraft(s);
                expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('Equipping');
                expect([held(s, 'Blue'), held(s, 'Red')]).toEqual([perTeam, perTeam]);
            });
        }
    }
});

// ════════════════════════════════════════════════════════════════════════════
// A129 / A130 / A131: the complete draft waits in Drafting for the referee or the confirm window
// ════════════════════════════════════════════════════════════════════════════

const COMPLETE = 'The draft is complete. It moves to Equipping when the referee advances it or the confirm window ends.';
const WINDOW_OPEN = 'The confirm window has not yet expired.';
const WINDOW_RANGE = 'confirmWindowSeconds must be between 0 and 300.';
const WINDOW_MS = 60_000; // the default confirm window (A131)
const CHAT_LINE = 'Draft complete. Stage: Equipping';
const chatLines = (s: Lobby) => [...s.test.db.ChatMessage.lobby_id.filter(s.lobbyId)].filter((m) => m.content === CHAT_LINE).length;
const expireClassic = (s: Lobby, who: Actor) => tx(s.test, who, (ctx) => M.timer_expiry_classic(ctx, { lobbyId: s.lobbyId }));
const expireAuctionBy = (s: Lobby, who: Actor) => tx(s.test, who, (ctx) => M.timer_expiry_auction(ctx, { lobbyId: s.lobbyId }));
/**
 * Plays the Auction until `sales` sales are made: Blue's nominations cost 5 and Red passes, Red's cost 0 and Blue
 * passes, so the sales alternate (Blue's 8th is sale 15). The 16th sale is always an A81(2) immediate sale: before it
 * one team is full and a full team never nominates.
 */
function playAuction(s: Lobby, sales = 16) {
    let n = stepsOf(s, 'Nominate').length + stepsOf(s, 'Undo').length;
    while (stage(s) === 'Drafting' && stepsOf(s, 'AuctionSold').length < sales) {
        const sess = session(s.test, s.lobbyId);
        const team = sess.nextNominatorTeam.tag as Side;
        const otherFull = (team === 'Blue' ? sess.redCharactersWon : sess.blueCharactersWon) >= 8;
        nominate(s, `a${++n}`, team === 'Blue' ? 5 : 0);
        if (!otherFull) pass(s, other(team));
    }
}

describe('A129: the last pick or sale leaves the lobby in Drafting with the draft complete', () => {
    it('A129: Classic: after the last manual pick the stage is Drafting, no roll-over, picks / bans / the turn timer do nothing; undo reopens the last turn; advance_stage rolls over once', () => {
        const s = lobby();
        playClassic(s, 1);
        const beforeLast = world(s);
        classicTurn(s);
        expect(stage(s)).toBe('Drafting');
        expect(budgets(s, 'Blue')).toMatchObject({ char: 100, lc: 50 });
        const complete = world(s);
        priceCharacters(s.test, s.lobbyId, ['late']);
        expect(rejection(s.test, captain(s, 'Blue'), (ctx) => M.pick_character(ctx, { lobbyId: s.lobbyId, characterName: 'late', eidolon: 0 }))).toBe(COMPLETE);
        expect(rejection(s.test, captain(s, 'Red'), (ctx) => M.ban_character(ctx, { lobbyId: s.lobbyId, characterName: 'late' }))).toBe(COMPLETE);
        advance(s.test, TURN_MS + 1_000); // a turn's length has passed, the window has not
        expect(rejection(s.test, captain(s, 'Blue'), (ctx) => M.timer_expiry_classic(ctx, { lobbyId: s.lobbyId }))).toBe(WINDOW_OPEN);
        expect(world(s)).toEqual(complete);

        undo(s); // the last pick: its turn reopens with a fresh clock
        expect(world(s)).toEqual(beforeLast);
        expect(session(s.test, s.lobbyId).timerState.turnStartAt.microsSinceUnixEpoch).toBe(s.test.clock.now().microsSinceUnixEpoch);
        classicTurn(s);
        expect(stage(s)).toBe('Drafting');

        tx(s.test, s.host, advanceBody(s));
        expect(stage(s)).toBe('Equipping');
        // D-50 roll-over (Classic charges no budget during the draft): 100 + 50 on each side.
        expect([budgets(s, 'Blue'), budgets(s, 'Red')]).toEqual([{ char: 0, lc: 150, won: 0 }, { char: 0, lc: 150, won: 0 }]);
        expect(chatLines(s)).toBe(1);
        expect(rejection(s.test, s.host, undoBody(s))).toBe(FINISHED);
    });

    it('A129: Classic: the last pick made by the timer also leaves the lobby in Drafting', () => {
        const s = lobby();
        playClassic(s, 1);
        advance(s.test, TURN_MS + 1_000);
        expireClassic(s, captain(s, 'Red'));
        expect(stepsOf(s, 'Pick')).toHaveLength(16);
        expect(stage(s)).toBe('Drafting');
        expect(budgets(s, 'Red')).toMatchObject({ char: 100, lc: 50 });
    });

    it('A129: Auction: after the last sale (an A81 immediate sale) the stage is Drafting, no roll-over; nominate / bid / pass / the timer do nothing; undo reopens the nomination turn', () => {
        const s = lobby(AUCTION);
        playAuction(s, 15);
        const beforeLast = world(s);
        playAuction(s, 16);
        expect(stage(s)).toBe('Drafting');
        expect(budgets(s, 'Blue')).toEqual({ char: 60, lc: 50, won: 8 });
        expect(budgets(s, 'Red')).toEqual({ char: 100, lc: 50, won: 8 });
        const complete = world(s);
        priceCharacters(s.test, s.lobbyId, ['late']);
        expect(rejection(s.test, captain(s, 'Red'), (ctx) => M.nominate_character(ctx, { lobbyId: s.lobbyId, characterName: 'late' }))).toBe(COMPLETE);
        expect(rejection(s.test, captain(s, 'Blue'), (ctx) => M.place_bid(ctx, { lobbyId: s.lobbyId, bidAmount: 1 }))).toBe(COMPLETE);
        expect(rejection(s.test, captain(s, 'Blue'), (ctx) => M.pass_bid(ctx, { lobbyId: s.lobbyId }))).toBe(COMPLETE);
        advance(s.test, TURN_MS + 1_000);
        expect(rejection(s.test, captain(s, 'Blue'), (ctx) => M.timer_expiry_auction(ctx, { lobbyId: s.lobbyId }))).toBe(WINDOW_OPEN);
        expect(world(s)).toEqual(complete);

        undo(s); // the immediate sale and its nomination
        expect(world(s)).toEqual(beforeLast);
        playAuction(s, 16);
        tx(s.test, s.host, advanceBody(s));
        expect(stage(s)).toBe('Equipping');
        expect([budgets(s, 'Blue'), budgets(s, 'Red')]).toEqual([{ char: 0, lc: 110, won: 8 }, { char: 0, lc: 150, won: 8 }]);
        expect(rejection(s.test, s.host, undoBody(s))).toBe(FINISHED);
    });

    it('A129: Auction: the last sale made through the timer (its EMPTY nomination sells at once) also leaves the lobby in Drafting', () => {
        const s = lobby(AUCTION);
        playAuction(s, 15);
        advance(s.test, TURN_MS + 1_000);
        expireAuctionBy(s, captain(s, 'Blue'));
        expect(stepsOf(s, 'AuctionSold')).toHaveLength(16);
        expect(stage(s)).toBe('Drafting');
        expect(budgets(s, 'Blue')).toMatchObject({ char: 60, lc: 50 });
    });

    it('A129 / A100 / A80: advance_stage before the draft is complete is refused; a player who is not the referee cannot advance', () => {
        const s = lobby();
        playClassic(s, 1);
        expect(rejection(s.test, s.host, advanceBody(s))).toMatch(/^The draft is not finished: Blue holds \d of 8 characters and Red holds \d of 8\.$/);
        classicTurn(s);
        rejection(s.test, captain(s, 'Blue'), advanceBody(s));
        expect(stage(s)).toBe('Drafting');
        tx(s.test, s.host, advanceBody(s));
        expect(stage(s)).toBe('Equipping');
    });
});

describe('A130: the confirm window after the last step', () => {
    for (const mode of ['Classic', 'Auction'] as const) {
        const finish = (s: Lobby) => (mode === 'Classic' ? playClassic(s) : playAuction(s));
        const expire = (s: Lobby, who: Actor) => (mode === 'Classic' ? expireClassic(s, who) : expireAuctionBy(s, who));
        const args = mode === 'Classic' ? {} : AUCTION;

        it(`A130 (${mode}): nobody can end the window early; at 60 s any present member moves the lobby to Equipping with the same state as the referee's advance`, () => {
            const s = lobby(args);
            finish(s);
            advance(s.test, WINDOW_MS - 1);
            for (const who of [s.host, captain(s, 'Blue'), captain(s, 'Red')]) {
                expect(rejection(s.test, who, (ctx) => (mode === 'Classic' ? M.timer_expiry_classic : M.timer_expiry_auction)(ctx, { lobbyId: s.lobbyId }))).toBe(WINDOW_OPEN);
            }
            expect(stage(s)).toBe('Drafting');
            advance(s.test, 1);
            expire(s, captain(s, 'Red'));
            expect(stage(s)).toBe('Equipping');
            expect(chatLines(s)).toBe(1);
            const byWindow = world(s);

            const t = lobby(args); // the same draft, advanced by the referee at once
            finish(t);
            tx(t.test, t.host, advanceBody(t));
            expect(world(t)).toEqual(byWindow);
            expect(chatLines(t)).toBe(1);
        });

        it(`A130 (${mode}): a pause holds the window (paused time does not count)`, () => {
            const s = lobby(args);
            finish(s);
            advance(s.test, 30_000);
            tx(s.test, s.host, (ctx) => M.pause_draft(ctx, { lobbyId: s.lobbyId }));
            advance(s.test, 120_000);
            expect(rejection(s.test, s.host, (ctx) => M.timer_expiry_classic(ctx, { lobbyId: s.lobbyId }))).toBe('Draft is paused.');
            tx(s.test, s.host, (ctx) => M.resume_draft(ctx, { lobbyId: s.lobbyId }));
            advance(s.test, 29_000);
            expect(rejection(s.test, captain(s, 'Blue'), (ctx) => M.timer_expiry_classic(ctx, { lobbyId: s.lobbyId }))).toBe(WINDOW_OPEN);
            advance(s.test, 1_000);
            expire(s, captain(s, 'Blue'));
            expect(stage(s)).toBe('Equipping');
        });

        it(`A130 (${mode}): an undo in the window ends it; finishing the draft again starts a fresh window`, () => {
            const s = lobby(args);
            finish(s);
            advance(s.test, 50_000);
            undo(s);
            expect(stage(s)).toBe('Drafting');
            finish(s);
            advance(s.test, 50_000);
            expect(rejection(s.test, captain(s, 'Blue'), (ctx) => M.timer_expiry_classic(ctx, { lobbyId: s.lobbyId }))).toBe(WINDOW_OPEN);
            advance(s.test, 10_000);
            expire(s, captain(s, 'Blue'));
            expect(stage(s)).toBe('Equipping');
        });
    }

    it('A130: the referee may advance at any time in the window', () => {
        const s = lobby(AUCTION);
        playAuction(s);
        advance(s.test, 1_000);
        tx(s.test, s.host, advanceBody(s));
        expect(stage(s)).toBe('Equipping');
    });
});

describe('A131: the confirm window is a lobby setting (0-300 s, default 60)', () => {
    it('A131: default 60 on a new lobby and a new preset; a preset update without the key keeps it', () => {
        const s = lobby();
        expect(lobbyRow(s.test, s.lobbyId).confirmWindowSeconds).toBe(60);
        tx(s.test, 'internal', (ctx) => M.create_lobby_preset(ctx, presetArgs('window-default')));
        expect(presetNamed(s.test, 'window-default')!.confirmWindowSeconds).toBe(60);
        tx(s.test, 'internal', (ctx) => M.create_lobby_preset(ctx, presetArgs('window-20', { confirmWindowSeconds: 20 })));
        const p = presetNamed(s.test, 'window-20')!;
        expect(p.confirmWindowSeconds).toBe(20);
        tx(s.test, 'internal', (ctx) => M.update_lobby_preset(ctx, updatePresetArgs(p.id, 'window-20')));
        expect(presetNamed(s.test, 'window-20')!.confirmWindowSeconds).toBe(20);
    });

    it('A131: a lobby set to 10 s moves at 10 s and not before', () => {
        const s = lobby({ confirmWindowSeconds: 10 });
        playClassic(s);
        advance(s.test, 9_999);
        expect(rejection(s.test, captain(s, 'Blue'), (ctx) => M.timer_expiry_classic(ctx, { lobbyId: s.lobbyId }))).toBe(WINDOW_OPEN);
        advance(s.test, 1);
        expireClassic(s, captain(s, 'Blue'));
        expect(stage(s)).toBe('Equipping');
    });

    it('A131: 0 = no window: the last pick and the last sale move to Equipping in the same call (with the roll-over), so they cannot be undone', () => {
        const c = lobby({ confirmWindowSeconds: 0 });
        playClassic(c);
        expect(stage(c)).toBe('Equipping');
        expect(budgets(c, 'Blue')).toMatchObject({ char: 0, lc: 150 });
        expect(chatLines(c)).toBe(1);
        expect(rejection(c.test, c.host, undoBody(c))).toBe(FINISHED);

        const a = lobby({ ...AUCTION, confirmWindowSeconds: 0 });
        playAuction(a);
        expect(stage(a)).toBe('Equipping');
        expect([budgets(a, 'Blue'), budgets(a, 'Red')]).toEqual([{ char: 0, lc: 110, won: 8 }, { char: 0, lc: 150, won: 8 }]);
    });

    it('A131: 301, negative and fractional values are refused on create_lobby, update_lobby_settings and the preset reducers', () => {
        const test = newHarness();
        const host = guest(test, 'h');
        for (const bad of [301, -1, 2.5]) {
            expect(rejection(test, host, (ctx) => M.create_lobby(ctx, { ...DEFAULT_LOBBY_ARGS, confirmWindowSeconds: bad } as any))).toBe(WINDOW_RANGE);
            expect(rejection(test, 'internal', (ctx) => M.create_lobby_preset(ctx, presetArgs(`bad-${bad}`, { confirmWindowSeconds: bad })))).toBe(WINDOW_RANGE);
        }
        const s = setupLobby(test, { seats: ONE_V_ONE, noStart: true });
        expect(rejection(test, s.host, (ctx) => M.update_lobby_settings(ctx, settingsArgs(s.lobbyId, { confirmWindowSeconds: 301 })))).toBe(WINDOW_RANGE);
        tx(test, s.host, (ctx) => M.update_lobby_settings(ctx, settingsArgs(s.lobbyId, { confirmWindowSeconds: 300 })));
        expect(lobbyRow(test, s.lobbyId).confirmWindowSeconds).toBe(300);
        tx(test, s.host, (ctx) => M.update_lobby_settings(ctx, settingsArgs(s.lobbyId))); // omitted = unchanged
        expect(lobbyRow(test, s.lobbyId).confirmWindowSeconds).toBe(300);
        tx(test, 'internal', (ctx) => M.create_lobby_preset(ctx, presetArgs('ok')));
        const p = presetNamed(test, 'ok')!;
        expect(rejection(test, 'internal', (ctx) => M.update_lobby_preset(ctx, updatePresetArgs(p.id, 'ok', { confirmWindowSeconds: -5 })))).toBe(WINDOW_RANGE);
    });

    it('A131: the setting cannot change after the draft started (the D-28 rule of every setting)', () => {
        const s = lobby();
        expect(rejection(s.test, s.host, (ctx) => M.update_lobby_settings(ctx, settingsArgs(s.lobbyId, { confirmWindowSeconds: 5 }))))
            .toBe('This action is not allowed in the current lobby stage (Drafting).');
        expect(lobbyRow(s.test, s.lobbyId).confirmWindowSeconds).toBe(60);
    });

    it("A131: a tournament lobby takes the window from the tournament's preset", () => {
        const f = duel();
        const presetId = f.test.db.Tournament.id.find(f.id)!.lobbyPresetId;
        const preset = f.test.db.LobbyPreset.id.find(presetId)!;
        f.test.db.LobbyPreset.id.update({ ...preset, confirmWindowSeconds: 25 });
        const m = byKey(f.test, f.id, 'W-R1-M1');
        const lobbyId = createTournamentLobby(f.test, f.org, m.id);
        expect(lobbyRow(f.test, lobbyId).confirmWindowSeconds).toBe(25);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Review F2 and F3 (S10t fix pass)
// ════════════════════════════════════════════════════════════════════════════

describe('S10t review F2 (A129): a concede in the confirm window counts like an Equipping concede for Ranked character stats', () => {
    function rankedLobby(): Lobby {
        const test = newHarness();
        seedElo(test); // a standalone concede finalizes inline (MMR for Ranked)
        return setupLobby(test, { lobby: { refereeExclusiveConcede: false }, beforeStart: rankedHook(test) });
    }
    const concede = (s: Lobby) => tx(s.test, s.a.b1, (ctx) => M.concede_match(ctx, { lobbyId: s.lobbyId, losingTeamSide: 0 }));

    it('S10t F2 / A129: Ranked, conceded in the window (draft complete, stage Drafting): the character stats are counted', () => {
        const s = rankedLobby();
        playClassic(s);
        expect(stage(s)).toBe('Drafting');
        concede(s);
        expect(s.test.db.MatchSessionHistory.count()).toBe(1n);
        expect([...s.test.db.PlayerCharacterStat.iter()]).toHaveLength(32); // 2v2 Halves: 16 characters, each played by its side's 2 players and faced by the other side's
        expect([...s.test.db.GlobalCharacterStat.iter()]).toHaveLength(16);
    });

    it('S10t F2 / D-79: Ranked, conceded mid-draft: the character stats are still skipped', () => {
        const s = rankedLobby();
        playClassic(s, 8);
        concede(s);
        expect(s.test.db.MatchSessionHistory.count()).toBe(1n);
        expect([...s.test.db.PlayerCharacterStat.iter()]).toEqual([]);
        expect([...s.test.db.GlobalCharacterStat.iter()]).toEqual([]);
    });
});

describe('S10t review F3 (A130): the move to Equipping ends a pause that held the window', () => {
    it('S10t F3: a manual pause in the window, then the referee advances: Equipping is not paused; the pause counters and the Pause row stay', () => {
        const s = lobby({ allowPlayerPause: true });
        playClassic(s);
        tx(s.test, captain(s, 'Blue'), (ctx) => M.pause_draft(ctx, { lobbyId: s.lobbyId }));
        expect(session(s.test, s.lobbyId)).toMatchObject({ pausesUsedBlue: 1, timerState: { isPaused: true } });
        tx(s.test, s.host, advanceBody(s));
        expect(stage(s)).toBe('Equipping');
        expect(session(s.test, s.lobbyId)).toMatchObject({ pausesUsedBlue: 1, pausesUsedRed: 0, timerState: { isPaused: false, accumulatedPauseMs: 0 } });
        expect(stepsOf(s, 'Pause')).toHaveLength(1);
    });

    it('S10t F3: a disconnect auto-pause in the window, then the referee advances: Equipping is not paused', () => {
        const s = setupLobby(newHarness(), { lobby: AUCTION });
        playAuction(s);
        disconnect(s.test, s.a.b2);
        const row = pendingCheck(s.test, s.lobbyId, s.a.b2.userId);
        advance(s.test, 15_000);
        fireCheck(s.test, row);
        expect(session(s.test, s.lobbyId).timerState).toMatchObject({ isPaused: true, accumulatedPauseMs: WINDOW_MS - 15_000 });
        expect((stepsOf(s, 'Pause')[0].payload.value as any).isAutoPause).toBe(true);
        tx(s.test, s.host, advanceBody(s));
        expect(stage(s)).toBe('Equipping');
        expect(session(s.test, s.lobbyId).timerState).toMatchObject({ isPaused: false, accumulatedPauseMs: 0 });
        expect(stepsOf(s, 'Pause')).toHaveLength(1);
    });
});
