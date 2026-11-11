// Match session: the turn clock, the pause throttle, coaches and pause, the edit-step cap and the lineup throttle.
// Decisions: A122
// Contracts: docs/match-session/contract.md
// From S10f, S10r (s10f-draft-results.test.ts, s10r-triage-fixes.test.ts).
import { describe, expect, it } from 'vitest';
import {
    M,
    advance,
    connect,
    disconnect,
    expectReject,
    fireCheck,
    newHarness,
    pauseSteps,
    pendingCheck,
    priceCharacters,
    priceLightcones,
    session,
    setupLobby,
    steps,
    tx,
    type Actor,
    type Lobby,
    type SetupOpts,
    rejection,
    TURN_MS,
    type Team,
} from '../fixtures/harness';
import { moderator } from '../fixtures/identity';
import {
    H,
    blueNames,
    captain,
    draftClassic,
    halves,
    insertAuctionCost,
    insertLightconeCost,
    insertRoster,
    playToScoring,
    recordScores,
    redNames,
    side,
} from '../fixtures/draft-and-scoring';

const NOT_EXPIRED = 'Turn timer has not yet expired.';
const PAUSED_RECENTLY = 'The draft was paused moments ago. Please wait a few seconds before pausing again.';
// T-S10f review F1: the cap is per team side, edits and confirmations counted separately.
const EDIT_CAP = (team: Team) => `The ${team} side of this game has reached the limit of 300 edit steps; the referee or staff can still close it.`;
const CONFIRM_CAP = (team: Team) => `The ${team} side of this game has reached the limit of 300 confirmation steps; the referee or staff can still close it.`;
const THROTTLED = 'Lineup changes are too frequent. Please wait a moment.';

const pause = (s: Lobby, who: Actor) => tx(s.test, who, (ctx) => M.pause_draft(ctx, { lobbyId: s.lobbyId }));
const resume = (s: Lobby, who: Actor) => tx(s.test, who, (ctx) => M.resume_draft(ctx, { lobbyId: s.lobbyId }));
const timer = (s: Lobby) => session(s.test, s.lobbyId).timerState;
const lastPause = (s: Lobby) => pauseSteps(s.test, s.lobbyId).sort((a, b) => b.sequence - a.sequence)[0];
const pauseValue = (s: Lobby) => lastPause(s).payload.value as { timeRemainingMs: number; isAutoPause: boolean };

// ════════════════════════════════════════════════════════════════════════════
// Draft #5 / F10: one turn clock (docs/match-session/architecture.md, S10f "Turn clock")
// ════════════════════════════════════════════════════════════════════════════

interface ClockMode {
    name: 'Classic' | 'Auction';
    lobby: Record<string, unknown>;
    expire: (s: Lobby) => (ctx: any) => unknown;
    /** An action that starts a new turn (a pick, a nomination). */
    newTurn: (s: Lobby) => void;
}

const CLOCK_MODES: ClockMode[] = [
    {
        name: 'Classic',
        lobby: {},
        expire: (s) => (ctx) => M.timer_expiry_classic(ctx, { lobbyId: s.lobbyId }),
        newTurn: (s) => {
            const sess = session(s.test, s.lobbyId);
            const team = sess.draftSequence[sess.turnIndex].teamTurn.tag as Team;
            tx(s.test, captain(s, team), (ctx) => (priceCharacters(ctx, s.lobbyId, ['kafka']), M.pick_character(ctx, { lobbyId: s.lobbyId, characterName: 'kafka', eidolon: 0 })));
        },
    },
    {
        name: 'Auction',
        lobby: { draftMode: { tag: 'Auction' } },
        expire: (s) => (ctx) => M.timer_expiry_auction(ctx, { lobbyId: s.lobbyId }),
        newTurn: (s) => {
            const team = session(s.test, s.lobbyId).nextNominatorTeam.tag as Team;
            tx(s.test, captain(s, team), (ctx) => (priceCharacters(ctx, s.lobbyId, ['kafka']), M.nominate_character(ctx, { lobbyId: s.lobbyId, characterName: 'kafka' })));
        },
    },
];

function clockLobby(mode: ClockMode, opts: SetupOpts = {}): Lobby {
    const test = newHarness();
    insertAuctionCost(test, 'kafka', [10, 10, 10, 10, 10, 10, 10]);
    return setupLobby(test, { ...opts, lobby: { ...mode.lobby, ...(opts.lobby ?? {}) } });
}

/**
 * The time left as a client computes it from what the member views expose (view_my_match_session.timerState and
 * view_my_lobby.standardTurnSeconds), with the documented formula.
 */
function clientRemaining(s: Lobby, viewer: Actor = s.a.r1): number {
    const vctx = s.test.viewContext(viewer.auth);
    const sess = ((M as any).view_my_match_session(vctx, {}) as any[]).find((r) => r.lobbyId === s.lobbyId);
    const lobby = ((M as any).view_my_lobby(vctx, {}) as any[]).find((r) => r.id === s.lobbyId);
    const ts = sess.timerState;
    const budget = ts.accumulatedPauseMs > 0 ? ts.accumulatedPauseMs : lobby.standardTurnSeconds * 1000;
    if (ts.isPaused) return budget;
    const elapsedMs = Number(s.test.clock.now().microsSinceUnixEpoch - ts.turnStartAt.microsSinceUnixEpoch) / 1000;
    return Math.max(0, budget - elapsedMs);
}

/**
 * The running turn has exactly `ms` left: the client value says so; one ms before the end the expiry is rejected (and
 * the client shows 1 ms); at the end the client shows 0 and the expiry is accepted.
 */
function expectExpiresIn(s: Lobby, mode: ClockMode, ms: number) {
    expect(timer(s).isPaused).toBe(false);
    expect(clientRemaining(s)).toBe(ms);
    advance(s.test, ms - 1);
    expect(clientRemaining(s)).toBe(1);
    expectReject(s.test, s.host, mode.expire(s), NOT_EXPIRED);
    advance(s.test, 1);
    expect(clientRemaining(s)).toBe(0);
    tx(s.test, s.host, mode.expire(s));
}

describe.each(CLOCK_MODES)('Draft #5 / F10: the turn clock, $name (match-session architecture S10f "Turn clock")', (mode) => {
    it('pause with T left, any wait, resume: the turn expires exactly T after the resume (draft audit #5, F10)', () => {
        const s = clockLobby(mode);
        advance(s.test, 20_000);
        pause(s, s.a.b1);
        expect(pauseValue(s)).toEqual({ timeRemainingMs: 10_000, isAutoPause: false });
        expect(timer(s)).toMatchObject({ isPaused: true, accumulatedPauseMs: 10_000 });
        expect(clientRemaining(s)).toBe(10_000);
        advance(s.test, 123_456); // the clock is frozen while paused
        expect(clientRemaining(s)).toBe(10_000);
        expectReject(s.test, s.host, mode.expire(s), 'Draft is paused.');
        resume(s, s.a.b1);
        expectExpiresIn(s, mode, 10_000);
    });

    it('two pause / resume cycles in one turn keep the running remainder (draft audit #5, F10)', () => {
        const s = clockLobby(mode);
        advance(s.test, 5_000);
        pause(s, s.a.b1); // 25 s left
        expect(pauseValue(s).timeRemainingMs).toBe(25_000);
        advance(s.test, 10_000);
        resume(s, s.a.b1);
        advance(s.test, 5_000);
        pause(s, s.a.b1); // 20 s left (the old formula stored 30 - 5 + 25 = 50 s here)
        expect(pauseValue(s).timeRemainingMs).toBe(20_000);
        expect(timer(s).accumulatedPauseMs).toBe(20_000);
        advance(s.test, 1_000);
        resume(s, s.a.b1);
        expectExpiresIn(s, mode, 20_000);
    });

    it('a pause at 0 ms left does not come back as a full turn: 1 ms is frozen and the turn expires 1 ms after the resume (F10)', () => {
        const s = clockLobby(mode);
        advance(s.test, TURN_MS + 5_000); // the turn has run out, nobody fired the expiry
        pause(s, s.a.b1);
        expect(pauseValue(s).timeRemainingMs).toBe(1);
        expect(timer(s).accumulatedPauseMs).toBe(1);
        advance(s.test, 60_000);
        resume(s, s.a.b1);
        expectExpiresIn(s, mode, 1);
    });

    it('a new turn after a resumed one has the full standardTurnSeconds (F10)', () => {
        const s = clockLobby(mode);
        advance(s.test, 20_000);
        pause(s, s.a.b1);
        advance(s.test, 3_000);
        resume(s, s.a.b1);
        advance(s.test, 2_000);
        mode.newTurn(s);
        expect(timer(s)).toMatchObject({ isPaused: false, accumulatedPauseMs: 0 });
        expectExpiresIn(s, mode, TURN_MS);
    });

    /** b2 drops 3 s into the turn; the 15 s check auto-pauses with 12 s left. */
    function autoPausedByDrop(): Lobby {
        const s = clockLobby(mode);
        advance(s.test, 3_000);
        disconnect(s.test, s.a.b2);
        const row = pendingCheck(s.test, s.lobbyId, s.a.b2.userId);
        advance(s.test, 15_000);
        fireCheck(s.test, row);
        expect(timer(s)).toMatchObject({ isPaused: true, accumulatedPauseMs: 12_000 });
        expect(pauseValue(s)).toEqual({ timeRemainingMs: 12_000, isAutoPause: true });
        expect(clientRemaining(s)).toBe(12_000);
        advance(s.test, 2_000);
        return s;
    }

    it('auto-pause then the away player\'s return through client_connected: the turn continues with the time it had (F10, policy review G10)', () => {
        const s = autoPausedByDrop();
        connect(s.test, s.a.b2);
        expectExpiresIn(s, mode, 12_000);
    });

    it('auto-pause after a Leave then the away player\'s join_lobby: the same remaining time (F10, G10)', () => {
        const s = clockLobby(mode);
        advance(s.test, 3_000);
        tx(s.test, s.a.b2, (ctx) => M.leave_lobby(ctx, { lobbyId: s.lobbyId }));
        const row = pendingCheck(s.test, s.lobbyId, s.a.b2.userId);
        advance(s.test, 15_000);
        fireCheck(s.test, row);
        expect(pauseValue(s)).toEqual({ timeRemainingMs: 12_000, isAutoPause: true });
        advance(s.test, 2_000);
        tx(s.test, s.a.b2, (ctx) => M.join_lobby(ctx, { lobbyId: s.lobbyId, joinCode: '', password: '' }));
        expectExpiresIn(s, mode, 12_000);
    });

    it('auto-pause then a manual resume_draft by a seated player: the same remaining time (F10, A85(2))', () => {
        const s = autoPausedByDrop();
        resume(s, s.a.r1);
        expectExpiresIn(s, mode, 12_000);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Draft #8: the edit-step cap and the manual pause throttle
// ════════════════════════════════════════════════════════════════════════════

/** A Classic 2v2 in Scoring with both teams' scores recorded by the host referee and 300 SetEidolon steps. */
function cappedLobby(): Lobby {
    const test = newHarness();
    insertLightconeCost(test, 'lc-1', 1);
    const s = playToScoring(test);
    recordScores(s, s.host, 'Blue', [H(10), H(10)]);
    recordScores(s, s.host, 'Red', [H(20), H(20)]);
    const blueCap = captain(s, 'Blue');
    for (let n = 0; n < 300; n++) {
        advance(test, 300); // the 250 ms lineup throttle
        tx(test, blueCap, (ctx) => M.set_eidolon(ctx, { lobbyId: s.lobbyId, teamSide: side('Blue'), characterName: 'blue-2', eidolon: (n % 6) + 1 }));
    }
    advance(test, 300);
    return s;
}
const editSteps = (s: Lobby, team: Team) =>
    steps(s.test, s.lobbyId).filter((st) => ['SetEidolon', 'EquipLightcone', 'UnequipLightcone'].includes(st.action.tag) && st.actorSlot.tag === team);
const confirmSteps = (s: Lobby, team: Team) =>
    steps(s.test, s.lobbyId).filter((st) => st.action.tag === 'ConfirmGame' && (st.payload.value as any).confirmedSide.tag === team);
const confirmCall = (s: Lobby, team: Team) => (ctx: any) => M.confirm_game(ctx, { lobbyId: s.lobbyId, teamSide: side(team) });

describe('Draft #8: the per-side edit-step cap (300) (match-session architecture S10f "Edit-step cap")', () => {
    it('Blue\'s 301st edit step is rejected with its text for set_eidolon, equip_lightcone and unequip_lightcone, from its captain and from the referee; the referee still closes the game (draft audit #8, review F1)', () => {
        const s = cappedLobby();
        const { test, lobbyId } = s;
        expect(editSteps(s, 'Blue')).toHaveLength(300);
        const calls: Array<(ctx: any) => unknown> = [
            (ctx) => M.set_eidolon(ctx, { lobbyId, teamSide: side('Blue'), characterName: 'blue-2', eidolon: 0 }),
            (ctx) => (priceLightcones(ctx, lobbyId, ['lc-1']), M.equip_lightcone(ctx, { lobbyId, teamSide: side('Blue'), characterName: 'blue-1', lightconeName: 'lc-1', superimposition: 1 })),
            (ctx) => M.unequip_lightcone(ctx, { lobbyId, teamSide: side('Blue'), characterName: 'blue-1' }),
        ];
        for (const who of [captain(s, 'Blue'), s.host]) {
            for (const call of calls) {
                advance(test, 300);
                expect(rejection(test, who, call)).toBe(EDIT_CAP('Blue'));
            }
        }
        expect(editSteps(s, 'Blue')).toHaveLength(300);
        tx(test, s.host, (ctx) => M.close_game(ctx, { lobbyId, winnerOverride: undefined, winnerOverrideReason: undefined }));
        expect(test.db.MatchSessionHistory.count()).toBe(1n); // casual: the close finalized the match
        expect(test.db.Lobby.id.find(lobbyId)).toBeNull();
    });

    it('Blue exhausts its 300 edits: Red\'s captain and the referee still edit Red, and both captains still confirm (review F1)', () => {
        const s = cappedLobby();
        const { test, lobbyId } = s;
        tx(test, captain(s, 'Red'), (ctx) => M.set_eidolon(ctx, { lobbyId, teamSide: side('Red'), characterName: 'red-2', eidolon: 1 }));
        advance(test, 300);
        tx(test, s.host, (ctx) => (priceLightcones(ctx, lobbyId, ['lc-1']), M.equip_lightcone(ctx, { lobbyId, teamSide: side('Red'), characterName: 'red-1', lightconeName: 'lc-1', superimposition: 1 })));
        expect(editSteps(s, 'Red')).toHaveLength(2);
        tx(test, captain(s, 'Blue'), confirmCall(s, 'Blue'));
        tx(test, captain(s, 'Red'), confirmCall(s, 'Red'));
        expect([confirmSteps(s, 'Blue'), confirmSteps(s, 'Red')].map((r) => r.length)).toEqual([1, 1]);
        expect(rejection(test, captain(s, 'Blue'), (ctx) =>
            M.set_eidolon(ctx, { lobbyId, teamSide: side('Blue'), characterName: 'blue-2', eidolon: 0 }))).toBe(EDIT_CAP('Blue'));
    });

    it('a capped game is closed by staff outside the lobby (a Moderator) (draft audit #8)', () => {
        const s = cappedLobby();
        const mod = moderator(s.test);
        expect(rejection(s.test, captain(s, 'Blue'), (ctx) =>
            M.set_eidolon(ctx, { lobbyId: s.lobbyId, teamSide: side('Blue'), characterName: 'blue-2', eidolon: 0 }))).toBe(EDIT_CAP('Blue'));
        tx(s.test, mod, (ctx) => M.close_game(ctx, { lobbyId: s.lobbyId, winnerOverride: undefined, winnerOverrideReason: undefined }));
        expect(s.test.db.MatchSessionHistory.count()).toBe(1n);
    });

    it('confirmations are counted per confirming side: Blue\'s 301st confirm_game is rejected with its text, Red still confirms (review F1)', () => {
        const test = newHarness();
        const s = playToScoring(test);
        const { lobbyId } = s;
        recordScores(s, s.host, 'Blue', [H(10), H(10)]);
        recordScores(s, s.host, 'Red', [H(20), H(20)]);
        for (let n = 0; n < 300; n++) {
            advance(test, 400); // the 30-per-10-s result-entry window of the Blue captain, the referee's lineup throttle
            tx(test, captain(s, 'Blue'), confirmCall(s, 'Blue'));
            // the referee's Red edit clears both flags, so Blue can confirm again
            tx(test, s.host, (ctx) => M.set_eidolon(ctx, { lobbyId, teamSide: side('Red'), characterName: 'red-2', eidolon: (n % 6) + 1 }));
        }
        advance(test, 400);
        expect(confirmSteps(s, 'Blue')).toHaveLength(300);
        expect(rejection(test, captain(s, 'Blue'), confirmCall(s, 'Blue'))).toBe(CONFIRM_CAP('Blue'));
        expect(confirmSteps(s, 'Blue')).toHaveLength(300);
        tx(test, captain(s, 'Red'), confirmCall(s, 'Red'));
        expect(confirmSteps(s, 'Red')).toHaveLength(1);
    });
});

describe('Draft #8: the manual pause throttle (10 s) (match-session architecture S10f "Pause throttle")', () => {
    it.each([['a player', 'b1'], ['the referee', 'host']])('%s: a second manual pause inside 10 s is rejected with its text, after 10 s accepted (draft audit #8)', (_label, name) => {
        const test = newHarness();
        const s = setupLobby(test);
        const who = s.a[name];
        pause(s, who);
        resume(s, who);
        advance(test, 9_999);
        const before = JSON.stringify(session(test, s.lobbyId), (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
        expect(rejection(test, who, (ctx) => M.pause_draft(ctx, { lobbyId: s.lobbyId }))).toBe(PAUSED_RECENTLY);
        expect(JSON.stringify(session(test, s.lobbyId), (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).toBe(before);
        expect(pauseSteps(test, s.lobbyId)).toHaveLength(1);
        advance(test, 1);
        pause(s, who);
        expect(timer(s).isPaused).toBe(true);
        expect(pauseSteps(test, s.lobbyId)).toHaveLength(2);
    });

    it('an auto-pause 5 s after a manual pause is not rejected, and it does not restart the 10 s interval (draft audit #8)', () => {
        const test = newHarness();
        const s = setupLobby(test);
        disconnect(test, s.a.b2);
        const row = pendingCheck(test, s.lobbyId, s.a.b2.userId);
        advance(test, 10_000);
        pause(s, s.a.b1); // manual, t = 10 s
        resume(s, s.a.b1);
        advance(test, 5_000);
        fireCheck(test, row); // auto, t = 15 s
        expect(pauseValue(s).isAutoPause).toBe(true);
        expect(timer(s).isPaused).toBe(true);
        expect(session(test, s.lobbyId).pausesUsedBlue).toBe(1);
        connect(test, s.a.b2); // lifts the auto-pause
        expect(timer(s).isPaused).toBe(false);
        advance(test, 5_000); // t = 20 s: 10 s after the manual pause, 5 s after the auto-pause
        pause(s, s.a.b1);
        expect(pauseValue(s).isAutoPause).toBe(false);
        expect(session(test, s.lobbyId).pausesUsedBlue).toBe(2);
    });

    it('the interval is per pausing party: after Blue pauses and resumes, Red\'s first pause is accepted at once, Blue again inside 10 s is rejected, the referee inside 10 s is accepted (review F3)', () => {
        const test = newHarness();
        const s = setupLobby(test);
        pause(s, s.a.b1); // Blue, t = 0
        resume(s, s.a.b1);
        pause(s, s.a.r1); // Red, t = 0
        expect(timer(s).isPaused).toBe(true);
        expect(session(test, s.lobbyId).pausesUsedRed).toBe(1);
        resume(s, s.a.r1);
        advance(test, 5_000);
        expect(rejection(test, s.a.b2, (ctx) => M.pause_draft(ctx, { lobbyId: s.lobbyId }))).toBe(PAUSED_RECENTLY);
        expect(session(test, s.lobbyId).pausesUsedBlue).toBe(1);
        pause(s, s.host); // the referee, 5 s after both teams' pauses
        expect(timer(s).isPaused).toBe(true);
        expect(pauseSteps(test, s.lobbyId)).toHaveLength(3);
    });
});

describe('Results #7: the four package edits keep the 250 ms lineup throttle (match-session architecture S10f "Lineup throttle moved")', () => {
    it('arrange_lineup, equip_lightcone, unequip_lightcone and set_eidolon each reject a call inside the interval; record_group_scores does not (results audit #7)', () => {
        const test = newHarness();
        insertRoster(test, [...blueNames(), ...redNames()]);
        insertLightconeCost(test, 'lc-1', 1);
        const s = setupLobby(test);
        draftClassic(s, blueNames(), redNames());
        const { lobbyId } = s;
        const cap = captain(s, 'Blue');
        const ops: Array<[string, (ctx: any) => unknown]> = [
            ['set_eidolon', (ctx) => M.set_eidolon(ctx, { lobbyId, teamSide: side('Blue'), characterName: 'blue-2', eidolon: 1 })],
            ['equip_lightcone', (ctx) => (priceLightcones(ctx, lobbyId, ['lc-1']), M.equip_lightcone(ctx, { lobbyId, teamSide: side('Blue'), characterName: 'blue-1', lightconeName: 'lc-1', superimposition: 1 }))],
            ['unequip_lightcone', (ctx) => M.unequip_lightcone(ctx, { lobbyId, teamSide: side('Blue'), characterName: 'blue-1' })],
            ['arrange_lineup', (ctx) => M.arrange_lineup(ctx, { lobbyId, teamSide: side('Blue'), groups: JSON.stringify(halves(blueNames())) })],
        ];
        advance(test, 300);
        tx(test, cap, ops[0][1]);
        for (const [name, call] of ops.slice(1)) {
            expect(rejection(test, cap, call), name).toBe(THROTTLED);
            advance(test, 250);
            tx(test, cap, call);
        }
        expect(rejection(test, cap, ops[0][1])).toBe(THROTTLED); // right after the arrange
        // record_group_scores right after a package edit by the same member is not lineup-throttled
        tx(test, cap, (ctx) => M.record_group_scores(ctx, { lobbyId, teamSide: side('Blue'), values: [H(10), H(10)], deaths: 0 }));
    });
});

const COACH_PAUSE_TEXT = 'Coaches cannot pause the draft.';

// ════════════════════════════════════════════════════════════════════════════
// L33: a coach cannot pause
// ════════════════════════════════════════════════════════════════════════════

describe('A122(8), L33: a coach cannot pause the draft', () => {
    const SEATS: Array<[string, 'BluePlayer' | 'BlueCoach' | 'RedPlayer']> = [
        ['b1', 'BluePlayer'], ['b2', 'BluePlayer'], ['bc', 'BlueCoach'], ['r1', 'RedPlayer'], ['r2', 'RedPlayer'],
    ];

    it('A122(8) L33: the coach\'s pause is rejected and uses none of the team\'s three pauses', () => {
        const test = newHarness();
        const s = setupLobby(test, { seats: SEATS });
        expectReject(test, s.a.bc, (ctx) => M.pause_draft(ctx, { lobbyId: s.lobbyId }), COACH_PAUSE_TEXT);
        const sess = session(test, s.lobbyId);
        expect([sess.timerState.isPaused, sess.pausesUsedBlue]).toEqual([false, 0]);
    });

    it('A122(8) L33: a player of the same team still pauses (one of three); the coach cannot resume that pause', () => {
        const test = newHarness();
        const s = setupLobby(test, { seats: SEATS });
        tx(test, s.a.b2, (ctx) => M.pause_draft(ctx, { lobbyId: s.lobbyId }));
        const sess = session(test, s.lobbyId);
        expect([sess.timerState.isPaused, sess.pausesUsedBlue]).toEqual([true, 1]);
        expectReject(test, s.a.bc, (ctx) => M.resume_draft(ctx, { lobbyId: s.lobbyId }),
            'Only the referee or the player who paused can resume the draft.');
        tx(test, s.a.b2, (ctx) => M.resume_draft(ctx, { lobbyId: s.lobbyId }));
        expect(session(test, s.lobbyId).timerState.isPaused).toBe(false);
    });
});
