// T-S10f: in-memory tests for the S10f module change. Findings: notes/audit-2026-11-09/audit-3-draft.md (#5, #8, LOW
// #15), audit-4-results-stats.md (#3, #7, #8, #9), audit-6-roster-calendar-crosscut.md (#2, #3, #5, #6, #9, #10),
// notes/migration/BACKEND-BUGS.md F10. Definitions: the "Phase S10f execution" sections of docs/{match-session,
// match-results, player-stats, mmr, calendar, roster, cost-sets, admin}/architecture.md. TestClock only; reducers run in
// withReducerTx, test.db is read outside it. Nothing reaches maincloud.
import { describe, expect, it } from 'vitest';
import { rebuildLeaderboard } from '@module/helpers/stats/leaderboardRebuild';
import {
    M,
    advance,
    connect,
    disconnect,
    expectReject,
    fireCheck,
    lobbyRow,
    newHarness,
    pauseSteps,
    pendingCheck,
    session,
    setupLobby,
    steps,
    tx,
    type Actor,
    type Harness,
    type Lobby,
    type SetupOpts,
} from './s4-fixtures';
import {
    H,
    blueNames,
    captain,
    draftClassic,
    finishGame,
    halves,
    insertAuctionCost,
    insertCharacterCostLadder,
    insertLightconeCost,
    insertRoster,
    playToScoring,
    record,
    recordScores,
    redNames,
    selectAccount,
    setRole,
    side,
} from './s7-fixtures';
import { AUDIT, host as tournamentHost, moderator, verified } from './s8-fixtures';
import { parkedLobby } from './s10-a2-fixtures';
import { E, S, costSetId, draftChar, draftLc, draftSyn, eCost, sCost } from './s10-c1-fixtures';
import {
    DAY_MS,
    HOUR_MS,
    account,
    addSlot,
    createAccount,
    createEvent,
    eventArgs,
    fromNow,
    invitesOf,
    micros,
    rejection,
    seedReferenceNames,
    slotArgs,
} from './s10-c2-fixtures';
import { seedUserRow } from './s10f-fixtures';

type Team = 'Blue' | 'Red';
const TURN_MS = 30_000; // DEFAULT_LOBBY_ARGS.standardTurnSeconds
const NOT_EXPIRED = 'Turn timer has not yet expired.';
const PAUSED_RECENTLY = 'The draft was paused moments ago. Please wait a few seconds before pausing again.';
// T-S10f review F1: the cap is per team side, edits and confirmations counted separately.
const EDIT_CAP = (team: Team) => `The ${team} side of this game has reached the limit of 300 edit steps; the referee or staff can still close it.`;
const CONFIRM_CAP = (team: Team) => `The ${team} side of this game has reached the limit of 300 confirmation steps; the referee or staff can still close it.`;
const TOO_QUICK = 'You are entering results too quickly. Please wait a moment.';
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
            tx(s.test, captain(s, team), (ctx) => M.pick_character(ctx, { lobbyId: s.lobbyId, characterName: 'kafka', eidolon: 0 }));
        },
    },
    {
        name: 'Auction',
        lobby: { draftMode: { tag: 'Auction' } },
        expire: (s) => (ctx) => M.timer_expiry_auction(ctx, { lobbyId: s.lobbyId }),
        newTurn: (s) => {
            const team = session(s.test, s.lobbyId).nextNominatorTeam.tag as Team;
            tx(s.test, captain(s, team), (ctx) => M.nominate_character(ctx, { lobbyId: s.lobbyId, characterName: 'kafka' }));
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
            (ctx) => M.equip_lightcone(ctx, { lobbyId, teamSide: side('Blue'), characterName: 'blue-1', lightconeName: 'lc-1', superimposition: 1 }),
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
        tx(test, s.host, (ctx) => M.equip_lightcone(ctx, { lobbyId, teamSide: side('Red'), characterName: 'red-1', lightconeName: 'lc-1', superimposition: 1 }));
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

// ════════════════════════════════════════════════════════════════════════════
// Draft LOW #15: the Undo row's sequence
// ════════════════════════════════════════════════════════════════════════════

describe('Draft LOW #15: undo sequence numbering', () => {
    it('after an undo every sequence stays unique and ordered; the Undo row never reuses the undone step\'s number (draft audit LOW #15)', () => {
        const test = newHarness();
        const s = setupLobby(test);
        const pickNext = (name: string) => {
            const sess = session(test, s.lobbyId);
            const team = sess.draftSequence[sess.turnIndex].teamTurn.tag as Team;
            tx(test, captain(s, team), (ctx) => M.pick_character(ctx, { lobbyId: s.lobbyId, characterName: name, eidolon: 0 }));
        };
        pickNext('a1');
        pickNext('a2');
        pickNext('a3');
        const undone = steps(test, s.lobbyId).sort((a, b) => b.sequence - a.sequence)[0];
        tx(test, s.host, (ctx) => M.undo_last_step(ctx, { lobbyId: s.lobbyId }));
        const undoRow = steps(test, s.lobbyId).find((st) => st.action.tag === 'Undo')!;
        expect(undoRow.payload).toMatchObject({ tag: 'Undo', value: { originalSequenceId: undone.sequence } });
        expect(undoRow.sequence).toBeGreaterThan(undone.sequence);
        pickNext('a4');
        const all = steps(test, s.lobbyId);
        const seqs = all.map((st) => st.sequence);
        expect(new Set(seqs).size).toBe(seqs.length);
        const newest = all.sort((a, b) => b.sequence - a.sequence)[0];
        expect((newest.payload.value as any).characterName).toBe('a4');
        expect(newest.sequence).toBeGreaterThan(undoRow.sequence);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Results #3: no stat rows for the sentinels or the system picker
// ════════════════════════════════════════════════════════════════════════════

describe('Results #3: finalization step 16 skips EMPTY, SKIP and the system user (match-results / player-stats architecture S10f)', () => {
    it('a timer EMPTY pick, a timer auto-pick of a real character and a SKIP ban: no row for EMPTY / SKIP, none for user 0; the real one has faced rows and one global row (results audit #3)', () => {
        const test = newHarness();
        // One Classic cost row ('solo'): the first Blue timer pick draws it, Red's timer pick then finds nothing (EMPTY),
        // and Red's timer ban in the second ban phase finds nothing left either (SKIP).
        insertRoster(test, ['solo']);
        insertCharacterCostLadder(test, 'solo', 'Classic', [10, 11, 12, 13, 14, 15, 16]);
        const s = setupLobby(test, {
            seats: [['b1', 'BluePlayer'], ['r1', 'RedPlayer']],
            lobby: { autoRandomPick: true, banMode: { tag: 'Four' } },
            beforeStart: (l) => {
                selectAccount(test, l.lobbyId, l.a.b1.userId, 900, { 'owned-b': 0 });
                selectAccount(test, l.lobbyId, l.a.r1.userId, 901, { 'owned-r': 0 });
            },
        });
        const { lobbyId } = s;
        const expire = () => {
            advance(test, TURN_MS);
            tx(test, s.host, (ctx) => M.timer_expiry_classic(ctx, { lobbyId }));
        };
        const last = () => steps(test, lobbyId).sort((a, b) => b.sequence - a.sequence)[0];
        let n = 0;
        let skipDone = false;
        for (;;) {
            const sess = session(test, lobbyId);
            const step = sess.draftSequence[sess.turnIndex];
            if (!step) break;
            const team = step.teamTurn.tag as Team;
            const kind = step.actionRequired.tag;
            if (sess.turnIndex === 2) {
                expect([kind, team]).toEqual(['Pick', 'Blue']);
                expire();
                expect([last().actorUserId, (last().payload.value as any).characterName]).toEqual([0, 'solo']);
            } else if (sess.turnIndex === 3) {
                expect([kind, team]).toEqual(['Pick', 'Red']);
                expire();
                expect([last().actorUserId, (last().payload.value as any).characterName]).toEqual([0, 'EMPTY']);
            } else if (kind === 'Ban' && team === 'Red' && sess.turnIndex > 3 && !skipDone) {
                expire();
                expect([last().actorUserId, (last().payload.value as any).characterName]).toEqual([0, 'SKIP']);
                skipDone = true;
            } else if (kind === 'Ban') {
                tx(test, captain(s, team), (ctx) => M.ban_character(ctx, { lobbyId, characterName: `ban-${n++}` }));
            } else {
                tx(test, captain(s, team), (ctx) => M.pick_character(ctx, { lobbyId, characterName: `${team.toLowerCase()}-p${n++}`, eidolon: 0 }));
            }
        }
        expect(skipDone).toBe(true);
        finishGame(s, 'Blue');
        expect(test.db.MatchSessionHistory.count()).toBe(1n); // casual: finalized at the close

        const playerRows = [...test.db.PlayerCharacterStat.iter()];
        const globalRows = [...test.db.GlobalCharacterStat.iter()];
        for (const sentinel of ['EMPTY', 'SKIP']) {
            expect(playerRows.filter((r) => r.characterName === sentinel), sentinel).toHaveLength(0);
            expect(globalRows.filter((r) => r.characterName === sentinel), sentinel).toHaveLength(0);
        }
        expect(playerRows.filter((r) => r.userId === 0)).toHaveLength(0);
        const solo = playerRows.filter((r) => r.characterName === 'solo');
        expect(solo.map((r) => r.userId)).toEqual([s.a.r1.userId]); // faced by the Red player; no "played" row for anyone
        expect(solo[0]).toMatchObject({ matchesPlayed: 0, timesFaced: 1, winsAgainst: 0, lossesAgainst: 1 });
        const soloGlobal = globalRows.filter((r) => r.characterName === 'solo');
        expect(soloGlobal).toHaveLength(1);
        expect(soloGlobal[0]).toMatchObject({ timesPicked: 1, timesBanned: 0, wins: 1, losses: 0 }); // side from actorSlot (Blue won)
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Results #7: the result-entry window and the adjustment bounds
// ════════════════════════════════════════════════════════════════════════════

const rateOf = (test: Harness, userId: number) => test.db.UserRateState.userId.find(userId) ?? undefined;
const adjustmentsOf = (test: Harness, recordId: number) => [...test.db.MatchResultAdjustment.by_result.filter(recordId)];

describe('Results #7: the per-user result-entry window (30 per 10 s) (match-results architecture S10f "Result-entry window")', () => {
    it('30 mixed writes inside 10 s pass, the 31st is rejected with its text and changes nothing; a new window passes (results audit #7)', () => {
        const test = newHarness();
        // The host sits on Blue: Blue captain (confirm_game) and referee (set_score_adjustment), one user for all three.
        const s = playToScoring(test, { hostSlot: 'BluePlayer', seats: [['b1', 'BluePlayer'], ['r1', 'RedPlayer'], ['r2', 'RedPlayer']] });
        const { lobbyId } = s;
        expect(captain(s, 'Blue').userId).toBe(s.host.userId);
        recordScores(s, captain(s, 'Red'), 'Red', [H(20), H(20)]); // another user's window
        const rec = record(test, lobbyId);
        for (let i = 0; i < 10; i++) {
            recordScores(s, s.host, 'Blue', [H(10), H(10 + i)]);
            advance(test, 300);
            tx(test, s.host, (ctx) => M.set_score_adjustment(ctx, { lobbyId, teamSide: side('Blue'), value: 1 }));
            advance(test, 300);
            tx(test, s.host, (ctx) => M.confirm_game(ctx, { lobbyId, teamSide: side('Blue') }));
            advance(test, 300);
        }
        // 30 writes, the first at t0, the last at t0 + 8.7 s; now t0 + 9 s
        expect(rateOf(test, s.host.userId)!.resultEntryCount).toBe(30);
        const msgs = [
            rejection(test, s.host, (ctx) => M.record_group_scores(ctx, { lobbyId, teamSide: side('Blue'), values: [H(1), H(1)], deaths: 0 })),
            rejection(test, s.host, (ctx) => M.set_score_adjustment(ctx, { lobbyId, teamSide: side('Blue'), value: 1 })),
        ];
        expect(adjustmentsOf(test, rec.id)).toHaveLength(10);
        expect(rateOf(test, s.host.userId)!.resultEntryCount).toBe(30);
        expect(msgs).toEqual([TOO_QUICK, TOO_QUICK]);
        advance(test, 999); // t0 + 9.999 s: still the same window
        expect(rejection(test, s.host, (ctx) => M.confirm_game(ctx, { lobbyId, teamSide: side('Blue') }))).toBe(TOO_QUICK);
        advance(test, 1); // t0 + 10 s: a new window
        tx(test, s.host, (ctx) => M.set_score_adjustment(ctx, { lobbyId, teamSide: side('Blue'), value: 1 }));
        expect(adjustmentsOf(test, rec.id)).toHaveLength(11);
        expect(rateOf(test, s.host.userId)!.resultEntryCount).toBe(1);
    });

    it('one referee saving both teams\' scores at the same instant passes (results audit #7)', () => {
        const test = newHarness();
        const s = playToScoring(test);
        recordScores(s, s.host, 'Blue', [H(10), H(10)]);
        recordScores(s, s.host, 'Red', [H(20), H(20)]); // same clock instant
        expect(rateOf(test, s.host.userId)!.resultEntryCount).toBe(2);
    });

    it('staff outside the lobby (a Moderator) is not counted: 31 edits at one instant pass (results audit #7)', () => {
        const test = newHarness();
        const s = playToScoring(test);
        const mod = moderator(test);
        tx(test, s.host, (ctx) => M.set_score_adjustment(ctx, { lobbyId: s.lobbyId, teamSide: side('Blue'), value: 1 }));
        const [adj] = adjustmentsOf(test, record(test, s.lobbyId).id);
        for (let i = 0; i < 31; i++) {
            tx(test, mod, (ctx) => M.set_score_adjustment(ctx, { lobbyId: s.lobbyId, teamSide: side('Blue'), value: i + 2, adjustmentId: adj.id }));
        }
        expect(test.db.MatchResultAdjustment.id.find(adj.id)!.value).toBe(32);
        expect(rateOf(test, mod.userId)?.resultEntryCount ?? 0).toBe(0);
    });

    it('the Admin closed-game edit is not counted, even by a lobby member: 31 edits at one instant pass (results audit #7, A60(7))', () => {
        const test = newHarness();
        const s = parkedLobby(test, {}, 'Blue'); // Ranked, Submitted, AwaitingResult; the host referee recorded both sides
        const before = rateOf(test, s.host.userId)!.resultEntryCount;
        setRole(test, s.host.userId, 'Admin');
        for (let i = 0; i < 31; i++) recordScores(s, s.host, 'Blue', [H(10), H(10)]);
        expect(rateOf(test, s.host.userId)!.resultEntryCount).toBe(before);
    });
});

describe('Results #7: adjustment bounds (match-results architecture S10f "Adjustment bounds")', () => {
    it('the 21st adjustment on a record is rejected with its text; an edit and a delete still pass, and a new one fits after the delete (results audit #7)', () => {
        const test = newHarness();
        const s = playToScoring(test);
        const rec = record(test, s.lobbyId);
        const add = (team: Team, value: number) =>
            tx(test, s.host, (ctx) => M.set_score_adjustment(ctx, { lobbyId: s.lobbyId, teamSide: side(team), value }));
        for (let i = 0; i < 20; i++) add(i % 2 ? 'Red' : 'Blue', 1);
        expect(adjustmentsOf(test, rec.id)).toHaveLength(20);
        const msg = rejection(test, s.host, (ctx) => M.set_score_adjustment(ctx, { lobbyId: s.lobbyId, teamSide: side('Blue'), value: 1 }));
        expect(adjustmentsOf(test, rec.id)).toHaveLength(20);
        expect(msg).toBe('A game can carry at most 20 adjustments; edit or delete one first.');
        const [first] = adjustmentsOf(test, rec.id);
        tx(test, s.host, (ctx) => M.set_score_adjustment(ctx, { lobbyId: s.lobbyId, teamSide: side('Red'), value: 5, adjustmentId: first.id }));
        tx(test, s.host, (ctx) => M.set_score_adjustment(ctx, { lobbyId: s.lobbyId, teamSide: side('Red'), value: 0, adjustmentId: first.id }));
        expect(adjustmentsOf(test, rec.id)).toHaveLength(19);
        add('Blue', 1);
        expect(adjustmentsOf(test, rec.id)).toHaveLength(20);
    });

    it('an adjustment that would push a team\'s sum past ±100000000 is rejected with its text; the other team is unaffected (results audit #7)', () => {
        const test = newHarness();
        const s = playToScoring(test);
        const rec = record(test, s.lobbyId);
        const adjust = (team: Team, value: number) => (ctx: any) =>
            M.set_score_adjustment(ctx, { lobbyId: s.lobbyId, teamSide: side(team), value });
        tx(test, s.host, adjust('Blue', 100_000_000));
        expect(rejection(test, s.host, adjust('Blue', 1))).toBe('The Blue adjustments cannot add up to more than 100000000 hundredths either way.');
        tx(test, s.host, adjust('Red', 1));
        tx(test, s.host, adjust('Blue', -1));
        tx(test, s.host, adjust('Red', -100_000_000));
        expect(rejection(test, s.host, adjust('Red', -2))).toBe('The Red adjustments cannot add up to more than 100000000 hundredths either way.');
        expect(adjustmentsOf(test, rec.id).map((a) => a.value).sort((a, b) => a - b)).toEqual([-100_000_000, -1, 1, 100_000_000]);
    });

    it('naming the other team cannot move or delete an entry past the old team\'s bound; a delete that keeps the bound passes whatever teamSide says (review F2)', () => {
        const test = newHarness();
        const s = playToScoring(test);
        const rec = record(test, s.lobbyId);
        const call = (team: Team, value: number, adjustmentId?: number) => (ctx: any) =>
            M.set_score_adjustment(ctx, { lobbyId: s.lobbyId, teamSide: side(team), value, adjustmentId });
        tx(test, s.host, call('Blue', 100_000_000));
        tx(test, s.host, call('Blue', -100_000_000));
        tx(test, s.host, call('Blue', 100_000_000)); // Blue: +1e8, -1e8, +1e8 = 1e8
        const rows = () => adjustmentsOf(test, rec.id).map((a) => [a.teamSide.tag, a.value]).sort();
        const before = rows();
        const negative = adjustmentsOf(test, rec.id).find((a) => a.value === -100_000_000)!;
        const BLUE_SUM = 'The Blue adjustments cannot add up to more than 100000000 hundredths either way.';
        const msgs = [
            rejection(test, s.host, call('Red', 0, negative.id)), // the review's bypass: delete named as Red
            rejection(test, s.host, call('Red', -5, negative.id)), // move the entry to Red
        ];
        expect(rows()).toEqual(before);
        expect(msgs).toEqual([BLUE_SUM, BLUE_SUM]);
        const positive = adjustmentsOf(test, rec.id).find((a) => a.value === 100_000_000)!;
        tx(test, s.host, call('Red', 0, positive.id)); // a legitimate delete of a Blue entry, teamSide ignored: Blue sum 0
        expect(rows()).toEqual([['Blue', -100_000_000], ['Blue', 100_000_000]]);
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
            ['equip_lightcone', (ctx) => M.equip_lightcone(ctx, { lobbyId, teamSide: side('Blue'), characterName: 'blue-1', lightconeName: 'lc-1', superimposition: 1 })],
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

// ════════════════════════════════════════════════════════════════════════════
// Results #8: override_match_result on a standalone record
// ════════════════════════════════════════════════════════════════════════════

const overrideCall = (matchResultId: number, newStatusTag = 'Validated', winner = 'Red') => (ctx: any) =>
    M.override_match_result(ctx, { matchResultId, newStatusTag, winnerTeamSideTag: winner, reason: 'staff' });

describe('Results #8: override_match_result on a standalone record (match-results architecture S10f)', () => {
    it('a Pending record in a live draft is rejected and unchanged (results audit #8)', () => {
        const test = newHarness();
        const s = setupLobby(test);
        const rec = record(test, s.lobbyId);
        const msg = rejection(test, 'internal', overrideCall(rec.id));
        expect(test.db.MatchResultRecord.id.find(rec.id)!.status.tag).toBe('Pending');
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('Drafting');
        expect(msg).toBe('Only a Submitted, Disputed or Validated result can be overridden (this one is Pending).');
    });

    it('a Voided record is rejected (status written on the row: no standalone reducer leaves a Voided record) (results audit #8)', () => {
        const test = newHarness();
        const s = parkedLobby(test);
        const rec = record(test, s.lobbyId);
        test.db.MatchResultRecord.id.update({ ...test.db.MatchResultRecord.id.find(rec.id)!, status: { tag: 'Voided' } as any });
        const msg = rejection(test, 'internal', overrideCall(rec.id));
        expect(test.db.MatchResultRecord.id.find(rec.id)!.status.tag).toBe('Voided');
        expect(msg).toBe('This result was voided.');
    });

    it('a Submitted record whose lobby is not in AwaitingResult is rejected; a record whose lobby is gone is rejected (results audit #8)', () => {
        const test = newHarness();
        const s = setupLobby(test); // Drafting
        const rec = record(test, s.lobbyId);
        test.db.MatchResultRecord.id.update({ ...test.db.MatchResultRecord.id.find(rec.id)!, status: { tag: 'Submitted' } as any });
        const msg = rejection(test, 'internal', overrideCall(rec.id));
        expect(test.db.MatchResultRecord.id.find(rec.id)!.status.tag).toBe('Submitted');
        expect(msg).toBe('Only the result of a match waiting for its result (AwaitingResult) can be overridden.');

        const t2 = newHarness();
        const parked = parkedLobby(t2);
        const rec2 = record(t2, parked.lobbyId);
        t2.db.Lobby.id.delete(parked.lobbyId);
        expect(rejection(t2, 'internal', overrideCall(rec2.id))).toBe('The match lobby no longer exists.');
        expect(t2.db.MatchResultRecord.id.find(rec2.id)!.status.tag).toBe('Submitted');
    });

    it('Submitted, Disputed and Validated records of a parked lobby are accepted (results audit #8)', () => {
        // Submitted
        const t1 = newHarness();
        const p1 = parkedLobby(t1, {}, 'Blue');
        const r1 = record(t1, p1.lobbyId);
        expect(r1.status.tag).toBe('Submitted');
        tx(t1, 'internal', overrideCall(r1.id, 'Validated', 'Red'));
        expect(t1.db.MatchResultRecord.id.find(r1.id)!).toMatchObject({ status: { tag: 'Validated' }, winnerTeamSide: { tag: 'Red' } });
        // Validated → overridden again
        tx(t1, 'internal', overrideCall(r1.id, 'Validated', 'Blue'));
        expect(t1.db.MatchResultRecord.id.find(r1.id)!.winnerTeamSide?.tag).toBe('Blue');
        expect(lobbyRow(t1, p1.lobbyId).stage.tag).toBe('AwaitingResult');
        // Disputed
        const t2 = newHarness();
        const p2 = parkedLobby(t2, {}, 'Blue');
        const r2 = record(t2, p2.lobbyId);
        tx(t2, captain(p2, 'Red'), (ctx) => M.dispute_match_result(ctx, { matchResultId: r2.id, reason: 'lag' }));
        expect(t2.db.MatchResultRecord.id.find(r2.id)!.status.tag).toBe('Disputed');
        tx(t2, 'internal', overrideCall(r2.id, 'Rejected', ''));
        expect(t2.db.MatchResultRecord.id.find(r2.id)!.status.tag).toBe('Rejected');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Results #9: the leaderboard skips deleted users
// ════════════════════════════════════════════════════════════════════════════

describe('Results #9: rebuildLeaderboard skips users with no live User row (mmr architecture S10f)', () => {
    const MOC = { tag: 'MemoryOfChaos' } as any;
    function seedRated(test: Harness, userId: number, rating: number) {
        test.db.MmrRating.insert({ userId, gameMode: MOC, rating, matchesPlayed: 5, globalCompositeRating: rating, seasonId: 0, ...AUDIT(test) } as any);
        test.db.PlayerStat.insert({
            userId, gameMode: MOC, draftMode: { tag: 'Classic' }, matchesPlayed: 5, wins: 3, losses: 2, matchesSpectated: 0,
            seasonId: 0, matchType: { tag: 'Ranked' }, teamSize: 2, ...AUDIT(test),
        } as any);
    }
    const board = (test: Harness, category: string) =>
        [...test.db.Leaderboard.iter()].filter((r) => r.category === category && r.seasonId === 0).sort((a, b) => a.rank - b.rank).map((r) => [r.rank, r.userId]);

    it('a soft-deleted user and a user with no row drop out at the next rebuild; the others keep their order with ranks 1..n (results audit #9)', () => {
        const test = newHarness();
        const users = [[8001, 1500], [8002, 1400], [8003, 1300], [8004, 1200], [8005, 1100]] as const;
        for (const [id, rating] of users) {
            seedUserRow(test, id);
            seedRated(test, id, rating);
        }
        tx(test, 'internal', (ctx) => rebuildLeaderboard(ctx, 0));
        expect(board(test, 'MemoryOfChaos')).toEqual([[1, 8001], [2, 8002], [3, 8003], [4, 8004], [5, 8005]]);

        test.db.User.id.update({ ...test.db.User.id.find(8002)!, deletedAt: test.clock.now() }); // soft-deleted, job pending
        test.db.User.id.delete(8004); // hard-deleted: MmrRating / PlayerStat kept as history
        tx(test, 'internal', (ctx) => rebuildLeaderboard(ctx, 0));
        for (const c of ['MemoryOfChaos', 'Global']) {
            expect(board(test, c), c).toEqual([[1, 8001], [2, 8003], [3, 8005]]);
        }
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Calendar #2, #3, #5
// ════════════════════════════════════════════════════════════════════════════

describe('Calendar #2: duplicate manual invitee ids (calendar architecture S10f)', () => {
    it('"b,b" produces one invite row for b; ten ids with one duplicate fit the 9-invitee cap (calendar audit #2)', () => {
        const test = newHarness();
        const org = verified(test, 'org');
        const others = Array.from({ length: 9 }, (_, i) => verified(test, `inv${i}`));
        const id = createEvent(test, org, { invitees: [others[0], others[0]] });
        expect(invitesOf(test, id).filter((r) => r.inviteeUserId === others[0].userId)).toHaveLength(1);
        expect(invitesOf(test, id)).toHaveLength(1);

        const full = createEvent(test, org, { invitees: [...others, others[3]] });
        const rows = invitesOf(test, full);
        expect(rows).toHaveLength(9);
        expect(new Set(rows.map((r) => r.inviteeUserId)).size).toBe(9);
    });
});

describe('Calendar #3: one "no end date" rule for recurring slots (calendar architecture S10f)', () => {
    const SIX_MONTHS_MS = 180 * DAY_MS;
    it.each(['', '0'])('endDate %j means no end date in create and update: expiresAt = now + 6 months, recurrenceRule.endDate = epoch (calendar audit #3)', (endDate) => {
        const test = newHarness();
        const a = verified(test, 'a');
        const id = addSlot(test, a, { isRecurring: true, recurrenceType: 'Weekly', interval: 1, dayOfWeek: 2, endDate });
        const row = test.db.AvailabilitySlot.id.find(id)!;
        expect(row.expiresAt.microsSinceUnixEpoch).toBe(test.clock.now().microsSinceUnixEpoch + micros(SIX_MONTHS_MS));
        expect(row.recurrenceRule.endDate!.microsSinceUnixEpoch).toBe(0n);

        advance(test, HOUR_MS);
        // first a real end date, then back to "none"
        const end = fromNow(test, 30 * DAY_MS);
        tx(test, a, (ctx) => M.update_availability_slot(ctx, { slotId: id, ...slotArgs(test, { isRecurring: true, recurrenceType: 'Weekly', interval: 1, dayOfWeek: 2, endDate: end }) }));
        const withEnd = test.db.AvailabilitySlot.id.find(id)!;
        expect(withEnd.expiresAt.microsSinceUnixEpoch).toBe(BigInt(end));
        expect(withEnd.recurrenceRule.endDate!.microsSinceUnixEpoch).toBe(BigInt(end));
        tx(test, a, (ctx) => M.update_availability_slot(ctx, { slotId: id, ...slotArgs(test, { isRecurring: true, recurrenceType: 'Weekly', interval: 1, dayOfWeek: 2, endDate }) }));
        const after = test.db.AvailabilitySlot.id.find(id)!;
        expect(after.expiresAt.microsSinceUnixEpoch).toBe(test.clock.now().microsSinceUnixEpoch + micros(SIX_MONTHS_MS));
        expect(after.recurrenceRule.endDate!.microsSinceUnixEpoch).toBe(0n);
    });
});

describe('Calendar #5: title and description length caps (calendar architecture S10f)', () => {
    const TITLE_LONG = 'Event title cannot exceed 100 characters.';
    const DESC_LONG = 'Event description cannot exceed 1000 characters.';
    const EMPTY_TITLE = 'Event title must not be empty.';

    it('create: title 100 and description 1000 pass; title 101, an empty / blank title and description 1001 are rejected with their texts (calendar audit #5)', () => {
        const test = newHarness();
        const org = verified(test, 'org');
        const id = createEvent(test, org, { title: 't'.repeat(100), description: 'd'.repeat(1000) });
        const row = test.db.CalendarEvent.id.find(id)!;
        expect([row.title.length, row.description?.length]).toEqual([100, 1000]);
        const count = () => [...test.db.CalendarEvent.organizer_id.filter(org.userId)].length;
        const create = (o: Parameters<typeof eventArgs>[1]) => (ctx: any) => M.create_calendar_event(ctx, eventArgs(test, o));
        const msgs = [
            rejection(test, org, create({ title: 't'.repeat(101) })),
            rejection(test, org, create({ title: '' })),
            rejection(test, org, create({ title: '   ' })),
            rejection(test, org, create({ description: 'd'.repeat(1001) })),
        ];
        expect(count()).toBe(1);
        expect(msgs).toEqual([TITLE_LONG, EMPTY_TITLE, EMPTY_TITLE, DESC_LONG]);
    });

    it('update: the same caps; a rejected update leaves the row as it was (calendar audit #5)', () => {
        const test = newHarness();
        const org = verified(test, 'org');
        const id = createEvent(test, org, { title: 'Scrim', description: 'old' });
        const base = { eventId: id, startAt: fromNow(test, 2 * DAY_MS), endAt: fromNow(test, 2 * DAY_MS + HOUR_MS) };
        const update = (title: string, description: string) => (ctx: any) => M.update_calendar_event(ctx, { ...base, title, description });
        const msgs = [
            rejection(test, org, update('t'.repeat(101), '')),
            rejection(test, org, update('', '')),
            rejection(test, org, update('ok', 'd'.repeat(1001))),
        ];
        expect([test.db.CalendarEvent.id.find(id)!.title, test.db.CalendarEvent.id.find(id)!.description]).toEqual(['Scrim', 'old']);
        expect(msgs).toEqual([TITLE_LONG, EMPTY_TITLE, DESC_LONG]);
        tx(test, org, update('t'.repeat(100), 'd'.repeat(1000)));
        const row = test.db.CalendarEvent.id.find(id)!;
        expect([row.title.length, row.description?.length]).toEqual([100, 1000]);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Roster #5, #6, #9, #10
// ════════════════════════════════════════════════════════════════════════════

describe('Roster #5: displayLabel at most 32 characters (roster architecture S10f)', () => {
    const LONG = 'Display label cannot exceed 32 characters';
    const L32 = 'x'.repeat(32);
    const L33 = 'x'.repeat(33);

    it('create_hsr_account / update_hsr_account: 32 pass (trimmed), 33 rejected with the text (roster audit #5)', () => {
        const test = newHarness();
        const p = verified(test, 'p');
        expect(rejection(test, p, (ctx) => M.create_hsr_account(ctx, { uid: '800000001', displayLabel: L33 }))).toBe(LONG);
        expect([...test.db.HsrAccount.user_id.filter(p.userId)]).toHaveLength(0);
        const id = createAccount(test, p, '800000001', `  ${L32}  `);
        expect(account(test, id)!.displayLabel).toBe(L32);
        const upd = (label: string) => (ctx: any) => M.update_hsr_account(ctx, { hsrAccountId: id, displayLabel: label, isRosterPublic: false, isRatingPublic: false });
        expect(rejection(test, p, upd(L33))).toBe(LONG);
        tx(test, p, upd('y'.repeat(32)));
        expect(account(test, id)!.displayLabel).toBe('y'.repeat(32));
    });

    it('admin_create_hsr_account / admin_update_hsr_account: the same cap (roster audit #5)', () => {
        const test = newHarness();
        const p = verified(test, 'p');
        expect(rejection(test, 'internal', (ctx) => M.admin_create_hsr_account(ctx, { targetUserId: p.userId, uid: '800000002', displayLabel: L33 }))).toBe(LONG);
        tx(test, 'internal', (ctx) => M.admin_create_hsr_account(ctx, { targetUserId: p.userId, uid: '800000002', displayLabel: L32 }));
        const [acct] = [...test.db.HsrAccount.user_id.filter(p.userId)];
        expect(acct.displayLabel).toBe(L32);
        const upd = (label: string) => (ctx: any) => M.admin_update_hsr_account(ctx, { hsrAccountId: acct.id, displayLabel: label, isRosterPublic: false, isRatingPublic: false });
        expect(rejection(test, 'internal', upd(L33))).toBe(LONG);
        expect(account(test, acct.id)!.displayLabel).toBe(L32);
        tx(test, 'internal', upd('z'.repeat(32)));
        expect(account(test, acct.id)!.displayLabel).toBe('z'.repeat(32));
    });
});

describe('Roster #6: user deletion recomputes isDuplicateUid (roster architecture S10f)', () => {
    it('after deleting a user who shared a UID, the other holder\'s duplicate flag is cleared (roster audit #6)', () => {
        const test = newHarness();
        const a = verified(test, 'a');
        const b = verified(test, 'b');
        createAccount(test, a, '800000001');
        const theirs = createAccount(test, b, '800000001');
        expect(account(test, theirs)!.isDuplicateUid).toBe(true);
        tx(test, a, (ctx) => M.delete_my_account(ctx, {}));
        expect([...test.db.HsrAccount.user_id.filter(a.userId)]).toHaveLength(0);
        expect(account(test, theirs)!.isDuplicateUid).toBe(false);
    });
});

describe('Roster #9: edit_draft_*_cost input rules (cost-sets architecture S10f)', () => {
    const MOC = 'MemoryOfChaos';
    function draftSet() {
        const test = newHarness();
        seedReferenceNames(test, ['kafka', 'pela'], ['patience']);
        const org = tournamentHost(test);
        tx(test, org, (ctx) => M.create_cost_set(ctx, { name: 'rules', sourceSetId: 0, gameModeTag: MOC }));
        return { test, org, id: costSetId(test, 'rules') };
    }
    const fieldMsg = (k: string) => `costsJson field "${k}" must be a number between 0 and 100000.`;
    const MODIFIER = 'costModifier must be a number between -100000 and 100000.';
    const WRONG_MODE = 'This cost set is for MemoryOfChaos; gameModeTag must be MemoryOfChaos.';
    const BAD_DRAFT_MODE = 'Invalid draftModeTag. Must be one of: Classic, Auction';
    const eJson = (over: Record<string, unknown>) => JSON.stringify({ e0: 1, e1: 1, e2: 1, e3: 1, e4: 1, e5: 1, e6: 1, ...over });
    const sJson = (over: Record<string, unknown>) => JSON.stringify({ s1: 1, s2: 1, s3: 1, s4: 1, s5: 1, ...over });

    it('character costs: Infinity, negative and above 100000 rejected; NaN is no JSON; 0 and 100000 pass (roster audit #9)', () => {
        const { test, org, id } = draftSet();
        const edit = (costsJson: string, characterName = 'kafka') => (ctx: any) =>
            M.edit_draft_character_cost(ctx, { costSetId: id, characterName, gameModeTag: MOC, draftModeTag: 'Classic', costsJson });
        const msgs = [
            rejection(test, org, edit('{"e0":1e999,"e1":1,"e2":1,"e3":1,"e4":1,"e5":1,"e6":1}')),
            rejection(test, org, edit(eJson({ e3: -1 }))),
            rejection(test, org, edit(eJson({ e6: 100_001 }))),
            rejection(test, org, edit('{"e0":NaN,"e1":1,"e2":1,"e3":1,"e4":1,"e5":1,"e6":1}')),
        ];
        expect(draftChar(test, id).filter((r) => r.characterName === 'kafka')).toHaveLength(0);
        expect(msgs).toEqual([fieldMsg('e0'), fieldMsg('e3'), fieldMsg('e6'), 'costsJson must be a valid JSON object.']);
        tx(test, org, edit(eJson({ e0: 0, e6: 100_000 })));
        expect(draftChar(test, id).find((r) => r.characterName === 'kafka')!.costs).toEqual({ ...eCost(1), e0: 0, e6: 100_000 });
    });

    it('light-cone costs: the same bounds (roster audit #9)', () => {
        const { test, org, id } = draftSet();
        const edit = (costsJson: string) => (ctx: any) =>
            M.edit_draft_lightcone_cost(ctx, { costSetId: id, lightconeName: 'patience', gameModeTag: MOC, draftModeTag: 'Classic', costsJson });
        const msgs = [
            rejection(test, org, edit('{"s1":1e999,"s2":1,"s3":1,"s4":1,"s5":1}')),
            rejection(test, org, edit(sJson({ s2: -0.5 }))),
            rejection(test, org, edit(sJson({ s5: 100_000.5 }))),
        ];
        expect(draftLc(test, id).filter((r) => r.lightconeName === 'patience')).toHaveLength(0);
        expect(msgs).toEqual([fieldMsg('s1'), fieldMsg('s2'), fieldMsg('s5')]);
    });

    it('synergy modifier: NaN, ±Infinity and |value| > 100000 rejected; -100000 and 100000 pass (roster audit #9)', () => {
        const { test, org, id } = draftSet();
        const edit = (costModifier: number, draftModeTag = 'Classic') => (ctx: any) =>
            M.edit_draft_synergy_cost(ctx, { costSetId: id, sourceName: 'kafka', targetName: 'pela', gameModeTag: MOC, draftModeTag, costModifier });
        const msgs = [NaN, Infinity, -Infinity, 100_001, -100_001].map((v) => rejection(test, org, edit(v)));
        expect(draftSyn(test, id)).toHaveLength(0);
        expect(msgs).toEqual(Array(5).fill(MODIFIER));
        tx(test, org, edit(-100_000));
        tx(test, org, edit(100_000, 'Auction'));
        expect(draftSyn(test, id).map((r) => [r.draftMode.tag, r.costModifier]).sort()).toEqual([['Auction', 100_000], ['Classic', -100_000]]);
    });

    it('unknown character / light-cone names are rejected (roster audit #9)', () => {
        const { test, org, id } = draftSet();
        const charMsg = rejection(test, org, (ctx) =>
            M.edit_draft_character_cost(ctx, { costSetId: id, characterName: 'nobody', gameModeTag: MOC, draftModeTag: 'Classic', costsJson: E(1) }));
        const lcMsg = rejection(test, org, (ctx) =>
            M.edit_draft_lightcone_cost(ctx, { costSetId: id, lightconeName: 'no-cone', gameModeTag: MOC, draftModeTag: 'Classic', costsJson: S(1) }));
        expect([draftChar(test, id).filter((r) => r.characterName === 'nobody'), draftLc(test, id).filter((r) => r.lightconeName === 'no-cone')].map((r) => r.length)).toEqual([0, 0]);
        expect([charMsg, lcMsg]).toEqual(['Character nobody not found.', 'Light cone no-cone not found.']);
    });

    it('a game-mode tag other than the set\'s, an unknown game-mode tag and an unknown draft-mode tag are rejected, for all three reducers (roster audit #9)', () => {
        const { test, org, id } = draftSet();
        const calls = (gameModeTag: string, draftModeTag: string): Array<(ctx: any) => unknown> => [
            (ctx) => M.edit_draft_character_cost(ctx, { costSetId: id, characterName: 'kafka', gameModeTag, draftModeTag, costsJson: E(1) }),
            (ctx) => M.edit_draft_lightcone_cost(ctx, { costSetId: id, lightconeName: 'patience', gameModeTag, draftModeTag, costsJson: S(1) }),
            (ctx) => M.edit_draft_synergy_cost(ctx, { costSetId: id, sourceName: 'kafka', targetName: 'pela', gameModeTag, draftModeTag, costModifier: 1 }),
        ];
        const wrong = calls('ApocalypticShadow', 'Classic').map((c) => rejection(test, org, c));
        const unknown = calls('Nope', 'Classic').map((c) => rejection(test, org, c));
        const badDraft = calls(MOC, 'Draft').map((c) => rejection(test, org, c));
        expect([draftChar(test, id), draftLc(test, id), draftSyn(test, id)].map((r) => r.length)).toEqual([0, 0, 0]); // set 0 is empty here: nothing cloned
        expect(wrong).toEqual(Array(3).fill(WRONG_MODE));
        for (const m of unknown) expect(m).toMatch(/^Invalid gameModeTag\. Must be one of: /);
        expect(badDraft).toEqual(Array(3).fill(BAD_DRAFT_MODE));
    });

    it('a valid edit is stored with only the documented fields (roster audit #9)', () => {
        const { test, org, id } = draftSet();
        tx(test, org, (ctx) => M.edit_draft_character_cost(ctx, {
            costSetId: id, characterName: 'kafka', gameModeTag: MOC, draftModeTag: 'Auction', costsJson: eJson({ e2: 7, extra: 99, note: 'x' }),
        }));
        tx(test, org, (ctx) => M.edit_draft_lightcone_cost(ctx, {
            costSetId: id, lightconeName: 'patience', gameModeTag: MOC, draftModeTag: 'Auction', costsJson: sJson({ s3: 4, bonus: 1 }),
        }));
        const c = draftChar(test, id).find((r) => r.characterName === 'kafka')!;
        expect(c.costs).toEqual({ ...eCost(1), e2: 7 });
        expect(Object.keys(c.costs).sort()).toEqual(['e0', 'e1', 'e2', 'e3', 'e4', 'e5', 'e6']);
        const l = draftLc(test, id).find((r) => r.lightconeName === 'patience')!;
        expect(l.costs).toEqual({ ...sCost(1), s3: 4 });
        expect(Object.keys(l.costs).sort()).toEqual(['s1', 's2', 's3', 's4', 's5']);
    });
});

describe('Roster #10: re-seed keeps archetype descriptions (cost-sets architecture S10f "Seed")', () => {
    // scripts/stdb/_seed.ts::seedGameData is a private async function over a live DbConnection (conn.db.Archetype.iter(),
    // conn.reducers.adminBulkUpsert) that reads data/seed/*.json; it is not exported and the module harness has no
    // DbConnection, so the filter is not reachable from an in-memory unit test without maincloud.
    it.todo('re-running the seed does not resend an existing archetype name, so an admin-written description survives (roster audit #10; needs a DbConnection: live residue or an exported pure filter)');
});
