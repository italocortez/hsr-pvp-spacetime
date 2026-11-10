// T-S10 (batch A2): in-memory port of the live draft suites (test/backend/match-session/draft-classic, draft-control,
// draft-auction, auto-pick-ownership-pool). Contract: docs/match-session/contract.md (start_draft, pick_character,
// ban_character, timer_expiry_classic, nominate_character, place_bid, pass_bid, undo_last_step, pause_draft,
// resume_draft, the Acceptance Scenarios). TestClock; the timers validate the elapsed time, so every expiry follows an
// `advance`. Nothing reaches maincloud.
import { describe, expect, it } from 'vitest';
import {
    priceBanNames,
    M,
    advance,
    captainOf,
    expectReject,
    guest,
    lobbyRow,
    newHarness,
    pauseSteps,
    priceCharacters,
    session,
    setupLobby,
    steps,
    tx,
    type Harness,
    type Lobby,
} from './s4-fixtures';
import { captain, insertAuctionCost } from './s7-fixtures';
import { liveField, verified } from './s8-fixtures';
import { byKey, createTournamentLobby, join, sidesOf } from './s8d-fixtures';
import { lmaOf, lockAccount, ownedAccount, settingsFrom } from './s10-a2-fixtures';

// T-S10i (A107(5)): the pick and nomination helpers price their name at 0 in the lobby's cost set, game mode and draft
// mode inside the call's transaction (rolled back with a rejected call), so every name these tests draft has a cost row.
const pick = (s: Lobby, characterName: string) => (ctx: any) => {
    priceCharacters(ctx, s.lobbyId, [characterName]);
    return M.pick_character(ctx, { lobbyId: s.lobbyId, characterName, eidolon: 0 });
};
// T-S10r (A122(7), L32): a ban names a character of the lobby's pool (a cost row), so the banned name is priced like a pick.
const ban = (s: Lobby, characterName: string) => (ctx: any) => {
    priceBanNames(ctx, s.lobbyId, [characterName]);
    return M.ban_character(ctx, { lobbyId: s.lobbyId, characterName });
};
const expire = (s: Lobby) => (ctx: any) => M.timer_expiry_classic(ctx, { lobbyId: s.lobbyId });
const undo = (s: Lobby) => (ctx: any) => M.undo_last_step(ctx, { lobbyId: s.lobbyId });
const pause = (s: Lobby) => (ctx: any) => M.pause_draft(ctx, { lobbyId: s.lobbyId });
const resume = (s: Lobby) => (ctx: any) => M.resume_draft(ctx, { lobbyId: s.lobbyId });
const nominate = (s: Lobby, characterName: string) => (ctx: any) => {
    priceCharacters(ctx, s.lobbyId, [characterName]);
    return M.nominate_character(ctx, { lobbyId: s.lobbyId, characterName });
};
const bid = (s: Lobby, bidAmount: number) => (ctx: any) => M.place_bid(ctx, { lobbyId: s.lobbyId, bidAmount });
const pass = (s: Lobby) => (ctx: any) => M.pass_bid(ctx, { lobbyId: s.lobbyId });

const current = (test: Harness, lobbyId: number) => {
    const sess = session(test, lobbyId);
    return sess.draftSequence[sess.turnIndex];
};
const lastStep = (test: Harness, lobbyId: number) => steps(test, lobbyId).sort((a, b) => b.sequence - a.sequence)[0];
/** The non-captain Blue player of a 2v2 lobby. */
const blueMate = (s: Lobby) => [s.a.b1, s.a.b2].find((a) => a.userId !== captain(s, 'Blue').userId)!;
const ONE_V_ONE: Array<[string, 'BluePlayer' | 'RedPlayer']> = [['b1', 'BluePlayer'], ['r1', 'RedPlayer']];
/** teamSize 3: two Blue players, a Blue coach (seated by the host), one Red player. */
const WITH_COACH: Array<[string, any]> = [['b1', 'BluePlayer'], ['b2', 'BluePlayer'], ['bc', 'BlueCoach'], ['r1', 'RedPlayer']];
const AUCTION = { draftMode: { tag: 'Auction' } };
const TURN_MS = 30_000; // DEFAULT_LOBBY_ARGS.standardTurnSeconds

// ─── start_draft ──────────────────────────────────────────────────────────────

describe('start_draft (contract start_draft, D-29, D-30)', () => {
    it('creates the session at turnIndex 0, the Pending record and one participant per player; stage Drafting', () => {
        const test = newHarness();
        const s = setupLobby(test);
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('Drafting');
        expect(session(test, s.lobbyId).turnIndex).toBe(0);
        const records = [...test.db.MatchResultRecord.lobby_id.filter(s.lobbyId)];
        expect(records).toHaveLength(1);
        expect(records[0].status.tag).toBe('Pending');
        const parts = [...test.db.MatchResultParticipant.match_result_id.filter(records[0].id)];
        const sideOf = (userId: number) => parts.find((p) => p.userId === userId)?.teamSide.tag;
        expect(parts).toHaveLength(4);
        expect([sideOf(s.a.b1.userId), sideOf(s.a.b2.userId), sideOf(s.a.r1.userId), sideOf(s.a.r2.userId)]).toEqual(['Blue', 'Blue', 'Red', 'Red']);
        expect(sideOf(s.host.userId)).toBeUndefined(); // the Spectator referee is no participant
    });

    it('auto-assigns one captain per team when none is set: the first player of each side (D-30)', () => {
        const test = newHarness();
        const s = setupLobby(test);
        expect(captainOf(test, s.lobbyId, 'BluePlayer')!.userId).toBe(s.a.b1.userId);
        expect(captainOf(test, s.lobbyId, 'RedPlayer')!.userId).toBe(s.a.r1.userId);
        const captains = [...test.db.LobbyMember.lobby_id.filter(s.lobbyId)].filter((m) => m.isCaptain);
        expect(captains).toHaveLength(2);
    });

    it('rejects an unconfirmed player (D-29)', () => {
        const test = newHarness();
        const s = setupLobby(test, { noStart: true });
        tx(test, s.a.b2, (ctx) => M.unconfirm_ready(ctx, { lobbyId: s.lobbyId }));
        expectReject(test, s.host, (ctx) => M.start_draft(ctx, { lobbyId: s.lobbyId }),
            'All Blue and Red players must be confirmed before starting.');
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('Waiting');
    });

    it('rejects a side without a non-coach player (Blue, then Red)', () => {
        const test = newHarness();
        const noBlue = setupLobby(test, { noStart: true, seats: [['r1', 'RedPlayer']] });
        expectReject(test, noBlue.host, (ctx) => M.start_draft(ctx, { lobbyId: noBlue.lobbyId }),
            'Blue team must have at least one non-coach player.');
        const t2 = newHarness();
        const noRed = setupLobby(t2, { noStart: true, seats: [['b1', 'BluePlayer']] });
        expectReject(t2, noRed.host, (ctx) => M.start_draft(ctx, { lobbyId: noRed.lobbyId }),
            'Red team must have at least one non-coach player.');
    });
});

// ─── pick_character / ban_character ──────────────────────────────────────────

describe('pick_character (contract pick_character)', () => {
    it('the Blue captain picks on Blue\'s turn: Pick step by the captain (actorSlot Blue), turnIndex 0 → 1', () => {
        const test = newHarness();
        const s = setupLobby(test);
        expect(current(test, s.lobbyId)).toMatchObject({ actionRequired: { tag: 'Pick' }, teamTurn: { tag: 'Blue' } });
        tx(test, captain(s, 'Blue'), pick(s, 'acheron'));
        const step = lastStep(test, s.lobbyId);
        expect(step.action.tag).toBe('Pick');
        expect(step.actorUserId).toBe(captain(s, 'Blue').userId);
        expect(step.actorSlot.tag).toBe('Blue');
        expect(step.payload.value).toMatchObject({ characterName: 'acheron', eidolon: 0 });
        expect(session(test, s.lobbyId).turnIndex).toBe(1);
    });

    it('rejects the team whose turn it is not', () => {
        const test = newHarness();
        const s = setupLobby(test);
        tx(test, captain(s, 'Blue'), pick(s, 'acheron'));
        expect(current(test, s.lobbyId).teamTurn.tag).toBe('Red');
        expectReject(test, captain(s, 'Blue'), pick(s, 'aglaea'), "It is not your team's turn to pick.");
        expect(session(test, s.lobbyId).turnIndex).toBe(1);
    });

    it('Mirror Picks: rejected with allowMirrorPicks false, accepted with it true (Acceptance: Classic Draft: Mirror Picks)', () => {
        const test = newHarness();
        const s = setupLobby(test, { lobby: { allowMirrorPicks: false } });
        tx(test, captain(s, 'Blue'), pick(s, 'acheron'));
        expectReject(test, captain(s, 'Red'), pick(s, 'acheron'), 'Character already picked.');

        const t2 = newHarness();
        const m = setupLobby(t2, { lobby: { allowMirrorPicks: true } });
        tx(t2, captain(m, 'Blue'), pick(m, 'acheron'));
        tx(t2, captain(m, 'Red'), pick(m, 'acheron'));
        expect(steps(t2, m.lobbyId).filter((st) => st.action.tag === 'Pick' && (st.payload.value as any).characterName === 'acheron')).toHaveLength(2);
    });

    it('a banned character cannot be picked, even with allowMirrorPicks (Acceptance: Banned Character Cannot Be Picked)', () => {
        const test = newHarness();
        const s = setupLobby(test, { lobby: { banMode: { tag: 'Four' }, allowMirrorPicks: true } });
        tx(test, captain(s, 'Blue'), ban(s, 'acheron'));
        tx(test, captain(s, 'Red'), ban(s, 'aglaea'));
        expect(session(test, s.lobbyId).turnIndex).toBe(2);
        expect(current(test, s.lobbyId)).toMatchObject({ actionRequired: { tag: 'Pick' }, teamTurn: { tag: 'Blue' } });
        expectReject(test, captain(s, 'Blue'), pick(s, 'acheron'), 'Character is banned and cannot be picked.');
        expectReject(test, captain(s, 'Blue'), pick(s, 'aglaea'), 'Character is banned and cannot be picked.');
    });

    it('the turn kind is enforced: a ban on a Pick turn and a pick on a Ban turn are rejected', () => {
        const test = newHarness();
        const s = setupLobby(test, { lobby: { banMode: { tag: 'Four' } } });
        expectReject(test, captain(s, 'Blue'), pick(s, 'acheron'), 'Current turn is not a Pick.');
        tx(test, captain(s, 'Blue'), ban(s, 'x'));
        tx(test, captain(s, 'Red'), ban(s, 'y'));
        expectReject(test, captain(s, 'Blue'), ban(s, 'z'), 'Current turn is not a Ban.');
    });
});

describe('ban_character (contract ban_character)', () => {
    it('BanMode Four opens on a Blue ban: Ban step (payload, actorSlot Blue), turnIndex 0 → 1', () => {
        const test = newHarness();
        const s = setupLobby(test, { lobby: { banMode: { tag: 'Four' } } });
        expect(current(test, s.lobbyId)).toMatchObject({ actionRequired: { tag: 'Ban' }, teamTurn: { tag: 'Blue' } });
        tx(test, captain(s, 'Blue'), ban(s, 'acheron'));
        const step = lastStep(test, s.lobbyId);
        expect(step.action.tag).toBe('Ban');
        expect(step.payload).toMatchObject({ tag: 'Ban', value: { characterName: 'acheron' } });
        expect(step.actorSlot.tag).toBe('Blue');
        expect(step.actorUserId).toBe(captain(s, 'Blue').userId);
        expect(session(test, s.lobbyId).turnIndex).toBe(1);
    });

    it('rejects a duplicate ban and the ban of a picked character', () => {
        const test = newHarness();
        const s = setupLobby(test, { lobby: { banMode: { tag: 'Four' } } });
        tx(test, captain(s, 'Blue'), ban(s, 'acheron'));
        expect(current(test, s.lobbyId).teamTurn.tag).toBe('Red');
        expectReject(test, captain(s, 'Red'), ban(s, 'acheron'), 'Character already banned.');
        // Four: [B] [R] B R R B [R] [B] …: play to the Red ban at turn 6, then ban a picked name.
        tx(test, captain(s, 'Red'), ban(s, 'aglaea'));
        tx(test, captain(s, 'Blue'), pick(s, 'p1'));
        tx(test, captain(s, 'Red'), pick(s, 'p2'));
        tx(test, captain(s, 'Red'), pick(s, 'p3'));
        tx(test, captain(s, 'Blue'), pick(s, 'p4'));
        expect(current(test, s.lobbyId)).toMatchObject({ actionRequired: { tag: 'Ban' }, teamTurn: { tag: 'Red' } });
        expectReject(test, captain(s, 'Red'), ban(s, 'p1'), 'Character already picked and cannot be banned.');
    });
});

describe('captain-only and coach guards on picks and bans (contract pick/ban Permission, D-39 / MOUS-03)', () => {
    it('a non-captain Blue player cannot pick or ban', () => {
        const test = newHarness();
        const s = setupLobby(test);
        expectReject(test, blueMate(s), pick(s, 'acheron'), 'Only the team captain can pick characters.');
        const t2 = newHarness();
        const b = setupLobby(t2, { lobby: { banMode: { tag: 'Four' } } });
        expectReject(t2, blueMate(b), ban(b, 'acheron'), 'Only the team captain can ban characters.');
        expect(session(t2, b.lobbyId).turnIndex).toBe(0);
    });

    it('a Blue coach cannot pick or ban (Acceptance: Coach Blocked From All Actions)', () => {
        const test = newHarness();
        const s = setupLobby(test, { lobby: { teamSize: 3 }, seats: WITH_COACH });
        expect(current(test, s.lobbyId)).toMatchObject({ actionRequired: { tag: 'Pick' }, teamTurn: { tag: 'Blue' } });
        expectReject(test, s.a.bc, pick(s, 'acheron'), 'Coaches cannot perform draft actions.');
        const t2 = newHarness();
        const b = setupLobby(t2, { lobby: { teamSize: 3, banMode: { tag: 'Four' } }, seats: WITH_COACH });
        expect(current(t2, b.lobbyId)).toMatchObject({ actionRequired: { tag: 'Ban' }, teamTurn: { tag: 'Blue' } });
        expectReject(t2, b.a.bc, ban(b, 'acheron'), 'Coaches cannot perform draft actions.');
    });
});

// ─── timer_expiry_classic ─────────────────────────────────────────────────────

describe('timer_expiry_classic (contract timer_expiry_classic; Acceptance: Timer Expiry Auto-Pick / Auto-Ban)', () => {
    it('rejected before the turn limit; after it, an EMPTY pick by the system actor (0) at costPaid 0, turnIndex + 1', () => {
        const test = newHarness();
        const s = setupLobby(test);
        advance(test, TURN_MS - 1_000);
        expectReject(test, s.host, expire(s), 'Turn timer has not yet expired.');
        advance(test, 1_000);
        tx(test, s.host, expire(s));
        expect(session(test, s.lobbyId).turnIndex).toBe(1);
        const step = lastStep(test, s.lobbyId);
        expect(step.action.tag).toBe('Pick');
        expect(step.actorUserId).toBe(0);
        expect(step.actorSlot.tag).toBe('Blue');
        expect(step.payload.value).toMatchObject({ characterName: 'EMPTY', eidolon: 0, costPaid: 0 });
    });

    it('successive expiries: the timer restarts on each turn, so the next expiry needs the clock to move again (Q4 ruling)', () => {
        const test = newHarness();
        const s = setupLobby(test);
        advance(test, TURN_MS);
        tx(test, s.a.r1, expire(s));
        expect(session(test, s.lobbyId).turnIndex).toBe(1);
        expectReject(test, s.a.r1, expire(s), 'Turn timer has not yet expired.');
        advance(test, TURN_MS);
        tx(test, s.a.r1, expire(s));
        expect(session(test, s.lobbyId).turnIndex).toBe(2);
        expect(steps(test, s.lobbyId).filter((st) => (st.payload.value as any).characterName === 'EMPTY')).toHaveLength(2);
    });

    it('a Ban turn expires into a SKIP ban by the system actor', () => {
        const test = newHarness();
        const s = setupLobby(test, { lobby: { banMode: { tag: 'Four' } } });
        advance(test, TURN_MS);
        tx(test, s.host, expire(s));
        const step = lastStep(test, s.lobbyId);
        expect(step.action.tag).toBe('Ban');
        expect(step.actorUserId).toBe(0);
        expect(step.payload.value).toMatchObject({ characterName: 'SKIP' });
        expect(session(test, s.lobbyId).turnIndex).toBe(1);
    });
});

// ─── undo_last_step (D-60) ────────────────────────────────────────────────────

describe('undo_last_step and refereeCanUndo (contract undo_last_step, D-60; Acceptance: Referee Undo)', () => {
    it('refereeCanUndo true: the referee undoes the pick (step deleted, Undo audit row, turnIndex back to 0)', () => {
        const test = newHarness();
        const s = setupLobby(test, { lobby: { refereeCanUndo: true } });
        tx(test, captain(s, 'Blue'), pick(s, 'acheron'));
        const picked = lastStep(test, s.lobbyId);
        expect(session(test, s.lobbyId).turnIndex).toBe(1);
        tx(test, s.host, undo(s));
        expect(session(test, s.lobbyId).turnIndex).toBe(0);
        const all = steps(test, s.lobbyId);
        expect(all.filter((st) => st.action.tag === 'Pick')).toHaveLength(0);
        const undoRow = all.find((st) => st.action.tag === 'Undo')!;
        expect(undoRow.payload).toMatchObject({ tag: 'Undo', value: { originalSequenceId: picked.sequence } });
    });

    it('a player (non-referee) is rejected even with refereeCanUndo true', () => {
        const test = newHarness();
        const s = setupLobby(test);
        tx(test, captain(s, 'Blue'), pick(s, 'aglaea'));
        expectReject(test, captain(s, 'Blue'), undo(s), 'Only referees with undo permission can undo.');
        expect(session(test, s.lobbyId).turnIndex).toBe(1);
    });

    it('refereeCanUndo false: the referee is rejected and the turn stays', () => {
        const test = newHarness();
        const s = setupLobby(test, { lobby: { refereeCanUndo: false } });
        tx(test, captain(s, 'Blue'), pick(s, 'acheron'));
        expectReject(test, s.host, undo(s), 'Only referees with undo permission can undo.');
        expect(session(test, s.lobbyId).turnIndex).toBe(1);
        expect(steps(test, s.lobbyId).filter((st) => st.action.tag === 'Pick')).toHaveLength(1);
    });
});

// ─── pause_draft / resume_draft ───────────────────────────────────────────────

describe('pause_draft / resume_draft (contract pause_draft, resume_draft, D-62; Acceptance: Pause and Resume)', () => {
    it('a player pauses (Pause step, isPaused, pausesUsedBlue 1); a second pause is rejected; the pauser resumes (accumulatedPauseMs = timeRemainingMs)', () => {
        const test = newHarness();
        const s = setupLobby(test, { lobby: { allowPlayerPause: true } });
        advance(test, 5_000);
        tx(test, s.a.b1, pause(s));
        const sess = session(test, s.lobbyId);
        expect(sess.timerState.isPaused).toBe(true);
        expect(sess.pausesUsedBlue).toBe(1);
        const [p] = pauseSteps(test, s.lobbyId);
        expect(p.actorUserId).toBe(s.a.b1.userId);
        const payload = p.payload.value as { timeRemainingMs: number; isAutoPause: boolean };
        expect(payload.isAutoPause).toBe(false);
        expectReject(test, s.a.r1, pause(s), 'Draft is already paused.');

        tx(test, s.a.b1, resume(s));
        const after = session(test, s.lobbyId);
        expect(after.timerState.isPaused).toBe(false);
        expect(after.timerState.accumulatedPauseMs).toBe(payload.timeRemainingMs);
    });

    it('only the referee or the player who paused can resume', () => {
        const test = newHarness();
        const s = setupLobby(test);
        tx(test, s.a.b1, pause(s));
        expectReject(test, s.a.r1, resume(s), 'Only the referee or the player who paused can resume the draft.');
        tx(test, s.host, resume(s));
        expect(session(test, s.lobbyId).timerState.isPaused).toBe(false);
    });

    it('allowPlayerPause false: a player pause is rejected', () => {
        const test = newHarness();
        const s = setupLobby(test, { lobby: { allowPlayerPause: false } });
        expectReject(test, s.a.b1, pause(s), 'Player pausing is not allowed in this lobby.');
        expect(session(test, s.lobbyId).timerState.isPaused).toBe(false);
    });

    it('3 pauses per team: the 4th Blue pause is rejected (count stays 3, not paused); Red keeps its own 3 (Acceptance: Pause: 3-Per-Team Limit)', () => {
        const test = newHarness();
        const s = setupLobby(test, { lobby: { allowPlayerPause: true } });
        for (let i = 1; i <= 3; i++) {
            advance(test, 10_000); // T-S10f (draft audit #8): a manual pause within 10 s of the previous manual pause is rejected
            tx(test, s.a.b1, pause(s));
            expect(session(test, s.lobbyId).pausesUsedBlue).toBe(i);
            tx(test, s.a.b1, resume(s));
        }
        expectReject(test, s.a.b2, pause(s), 'Blue team has used all 3 pauses.');
        expect(session(test, s.lobbyId).timerState.isPaused).toBe(false);
        expect(session(test, s.lobbyId).pausesUsedBlue).toBe(3);
        advance(test, 10_000); // T-S10f: not needed since review F3 (the 10 s interval is per pausing party), kept harmless
        tx(test, s.a.r1, pause(s));
        expect(session(test, s.lobbyId).pausesUsedRed).toBe(1);
    });

    it('the referee pauses without limit and without touching the team counters (Acceptance: Pause and Resume: Referee)', () => {
        const test = newHarness();
        const s = setupLobby(test, { lobby: { allowPlayerPause: true, refereeCanPause: true } });
        for (let i = 1; i <= 4; i++) {
            advance(test, 10_000); // T-S10f (draft audit #8): a manual pause within 10 s of the previous manual pause is rejected
            tx(test, s.host, pause(s));
            expect(session(test, s.lobbyId).timerState.isPaused).toBe(true);
            tx(test, s.host, resume(s));
            expect(session(test, s.lobbyId).timerState.isPaused).toBe(false);
        }
        const sess = session(test, s.lobbyId);
        expect([sess.pausesUsedBlue, sess.pausesUsedRed]).toEqual([0, 0]);
        expect(pauseSteps(test, s.lobbyId)).toHaveLength(4);
    });
});

// ─── Auction ──────────────────────────────────────────────────────────────────

describe('Auction start (contract start_draft step 7, D-48)', () => {
    it('BanMode None: no ban phase; auction phase open, Blue nominates first', () => {
        const test = newHarness();
        const s = setupLobby(test, { lobby: AUCTION });
        const sess = session(test, s.lobbyId);
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('Drafting');
        expect(sess.isAuctionPhase).toBe(true);
        expect(sess.draftSequence).toHaveLength(0);
        expect(sess.nextNominatorTeam.tag).toBe('Blue');
    });

    it('BanMode Four: four ban steps first (Blue opens), then the auction phase at turnIndex 4', () => {
        const test = newHarness();
        const s = setupLobby(test, { lobby: { ...AUCTION, banMode: { tag: 'Four' } } });
        const sess = session(test, s.lobbyId);
        expect(sess.isAuctionPhase).toBe(false);
        expect(sess.draftSequence).toHaveLength(4);
        expect(sess.draftSequence.every((st) => st.actionRequired.tag === 'Ban')).toBe(true);
        expect(sess.draftSequence[0].teamTurn.tag).toBe('Blue');
        for (const name of ['acheron', 'aglaea', 'anaxa', 'archer']) {
            tx(test, captain(s, current(test, s.lobbyId).teamTurn.tag as 'Blue' | 'Red'), ban(s, name));
        }
        const after = session(test, s.lobbyId);
        expect(after.isAuctionPhase).toBe(true);
        expect(after.turnIndex).toBe(4);
        // A banned character cannot be nominated (contract nominate_character).
        expectReject(test, captain(s, 'Blue'), nominate(s, 'acheron'), 'Character is banned and cannot be nominated.');
    });
});

describe('nominate_character / place_bid / pass_bid (contract; Acceptance: Auction Draft: Nomination and Bidding)', () => {
    it('a nomination: Nominate step by the Blue captain; currentNomination / currentBidAmount (E0 base) / currentBidTeam Blue', () => {
        const test = newHarness();
        insertAuctionCost(test, 'kafka', [10, 10, 10, 10, 10, 10, 10]);
        const s = setupLobby(test, { lobby: AUCTION });
        tx(test, captain(s, 'Blue'), nominate(s, 'kafka'));
        const step = lastStep(test, s.lobbyId);
        expect(step.action.tag).toBe('Nominate');
        expect(step.actorUserId).toBe(captain(s, 'Blue').userId);
        expect(step.actorSlot.tag).toBe('Blue');
        const sess = session(test, s.lobbyId);
        expect(sess.currentNomination).toBe('kafka');
        expect(sess.currentBidAmount).toBe(10);
        expect(sess.currentBidTeam.tag).toBe('Blue');
        expectReject(test, captain(s, 'Red'), nominate(s, 'other'), 'An auction is already in progress.');
    });

    it('the opposing team bids (Bid step, currentBidTeam Red); the holder cannot bid again; below the minimum raise and over the budget are rejected', () => {
        const test = newHarness();
        insertAuctionCost(test, 'kafka', [10, 10, 10, 10, 10, 10, 10]);
        const s = setupLobby(test, { lobby: { ...AUCTION, characterBudget: 12, minimumBidRaise: 1 } });
        tx(test, captain(s, 'Blue'), nominate(s, 'kafka'));
        expectReject(test, captain(s, 'Blue'), bid(s, 11), 'Your team already holds the current bid. Wait for the other team to respond.');
        expectReject(test, captain(s, 'Red'), bid(s, 10.5), 'Bid must be at least 11 (current bid 10 + minimum raise 1).');
        expectReject(test, captain(s, 'Red'), bid(s, 15), 'Bid exceeds your remaining character budget.'); // 15 > 12
        tx(test, captain(s, 'Red'), bid(s, 11));
        const step = lastStep(test, s.lobbyId);
        expect(step.action.tag).toBe('Bid');
        expect(step.actorSlot.tag).toBe('Red');
        const sess = session(test, s.lobbyId);
        expect(sess.currentBidAmount).toBe(11);
        expect(sess.currentBidTeam.tag).toBe('Red');
        expectReject(test, captain(s, 'Red'), bid(s, 12), 'Your team already holds the current bid. Wait for the other team to respond.');
    });

    it('pass sells to the holder (AuctionSold, budget and won count), normal rotation; the holder cannot pass; the wrong team cannot nominate', () => {
        const test = newHarness();
        insertAuctionCost(test, 'kafka', [10, 10, 10, 10, 10, 10, 10]);
        const s = setupLobby(test, { lobby: AUCTION });
        tx(test, captain(s, 'Blue'), nominate(s, 'kafka'));
        expectReject(test, captain(s, 'Blue'), pass(s), 'Your team holds the current bid. The other team must respond.');
        tx(test, captain(s, 'Red'), pass(s));
        const sold = lastStep(test, s.lobbyId);
        expect(sold.action.tag).toBe('AuctionSold');
        expect(sold.payload.value).toMatchObject({ characterName: 'kafka', winningAmount: 10, winningTeam: { tag: 'Blue' } });
        const sess = session(test, s.lobbyId);
        expect(sess.teamBlueCharBudget).toBe(90);
        expect(sess.blueCharactersWon).toBe(1);
        expect(sess.currentNomination).toBeUndefined();
        expect(sess.nextNominatorTeam.tag).toBe('Red'); // Blue nominated and won: normal rotation (D-46)
        expectReject(test, captain(s, 'Blue'), nominate(s, 'other'), "It is not your team's turn to nominate.");
    });

    it('steal-skip: Red outbids and wins, Blue (the nominator) keeps the turn (Acceptance: Auction Draft: Steal-Skip Logic, D-46)', () => {
        const test = newHarness();
        insertAuctionCost(test, 'kafka', [10, 10, 10, 10, 10, 10, 10]);
        const s = setupLobby(test, { lobby: AUCTION });
        tx(test, captain(s, 'Blue'), nominate(s, 'kafka'));
        tx(test, captain(s, 'Red'), bid(s, 15));
        tx(test, captain(s, 'Blue'), pass(s));
        const sold = lastStep(test, s.lobbyId);
        expect(sold.payload.value).toMatchObject({ characterName: 'kafka', winningAmount: 15, winningTeam: { tag: 'Red' } });
        const sess = session(test, s.lobbyId);
        expect(sess.teamRedCharBudget).toBe(85);
        expect(sess.redCharactersWon).toBe(1);
        expect(sess.nextNominatorTeam.tag).toBe('Blue');
        // A won character cannot be nominated again.
        expectReject(test, captain(s, 'Blue'), nominate(s, 'kafka'), 'Character has already been won in this auction.');
    });

    it('captain-only and coach guards on nominate / bid / pass (contract Permission, D-39)', () => {
        const test = newHarness();
        const s = setupLobby(test, { lobby: { ...AUCTION, teamSize: 3 }, seats: [...WITH_COACH, ['r2', 'RedPlayer']] });
        expectReject(test, blueMate(s), nominate(s, 'x'), 'Only the team captain can nominate characters.');
        expectReject(test, s.a.bc, nominate(s, 'x'), 'Coaches cannot perform draft actions.');
        tx(test, captain(s, 'Blue'), nominate(s, 'x'));
        const redMate = [s.a.r1, s.a.r2].find((a) => a.userId !== captain(s, 'Red').userId)!;
        expectReject(test, redMate, bid(s, 5), 'Only the team captain can place bids.');
        expectReject(test, redMate, pass(s), 'Only the team captain can pass the bid.');
        expectReject(test, s.a.bc, pass(s), 'Coaches cannot perform draft actions.');
        expectReject(test, s.host, bid(s, 5), 'Spectators cannot bid.');
    });
});

// ─── Auto-pick ownership pool (D-I-01/02, D-I-04) ─────────────────────────────

/** Expires turns until `team` has `n` auto-picks; returns that team's auto-picked names in order. */
function autoPicks(test: Harness, s: Lobby, team: 'Blue' | 'Red', n: number): string[] {
    const turnMs = lobbyRow(test, s.lobbyId).standardTurnSeconds * 1000;
    const picked = () => steps(test, s.lobbyId)
        .filter((st) => st.action.tag === 'Pick' && st.actorUserId === 0 && st.actorSlot.tag === team)
        .sort((a, b) => a.sequence - b.sequence)
        .map((st) => (st.payload.value as { characterName: string }).characterName);
    let guard = 0;
    while (picked().length < n && guard++ < 16) {
        advance(test, turnMs);
        tx(test, s.host, expire(s));
    }
    return picked();
}

describe('timer_expiry_classic auto-pick pool with requireOwnership (Acceptance: Auto-Pick Uses Match-Selected Account, D-I-01/02/04)', () => {
    it('casual: the pool is the match-selected account (LobbyMemberAccount B), not the globally active account A', () => {
        const test = newHarness();
        const b1 = guest(test, 'b1');
        const r1 = guest(test, 'r1');
        const acctA = ownedAccount(test, b1.userId, 'A', ['a1', 'a2']); // active
        const acctB = ownedAccount(test, b1.userId, 'B', ['bx', 'by'], false);
        ownedAccount(test, r1.userId, 'R', ['rx']);
        const s = setupLobby(test, {
            actors: { b1, r1 },
            seats: ONE_V_ONE,
            lobby: { autoRandomPick: true, requireOwnership: true },
            beforeStart: (l) => {
                // T-S10i (A107(5)): every owned character is priced, so the pool is decided by the selected accounts alone.
                priceCharacters(test, l.lobbyId, ['a1', 'a2', 'bx', 'by', 'rx']);
                expect(lmaOf(test, l.lobbyId, b1.userId)).toEqual([acctA]); // join auto-selected the active account (D-04)
                tx(test, b1, (ctx) => M.select_match_account(ctx, { lobbyId: l.lobbyId, hsrAccountId: acctB }));
                expect(lmaOf(test, l.lobbyId, b1.userId)).toEqual([acctB]); // casual: replace (D-07)
            },
        });
        const blue = autoPicks(test, s, 'Blue', 3);
        expect(new Set(blue.slice(0, 2))).toEqual(new Set(['bx', 'by']));
        expect(blue[2]).toBe('EMPTY'); // B exhausted; A's characters are never drawn
        expect(blue).not.toContain('a1');
        expect(blue).not.toContain('a2');
    });

    it('tournament: the pool is the union of every selected account of the acting team (two accounts of one player)', () => {
        // T-S10v (A137(4)): registration in a requireOwnership tournament now needs an active game account; the fixture
        // players own none, so the field is built without the flag and the flag is set on the row before the lobby.
        const f = liveField(2, { maxAccountsPerPlayer: 2 });
        const { test } = f;
        test.db.Tournament.id.update({ ...test.db.Tournament.id.find(f.id)!, requireOwnership: true });
        const m = byKey(test, f.id, 'W-R1-M1');
        const { blue, red } = sidesOf(f, m.id);
        const p1A = ownedAccount(test, blue.captain.userId, 'p1A', ['ax']);
        const p1B = ownedAccount(test, blue.captain.userId, 'p1B', ['bx'], false);
        const p2 = ownedAccount(test, blue.mate.userId, 'p2', ['ax']); // overlaps A: only B adds bx
        const r1 = ownedAccount(test, red.captain.userId, 'r1', ['rx']);
        const r2 = ownedAccount(test, red.mate.userId, 'r2', ['ry']);
        for (const [who, acct] of [[blue.captain, p1A], [blue.captain, p1B], [blue.mate, p2], [red.captain, r1], [red.mate, r2]] as const) {
            lockAccount(test, f.id, who.userId, acct);
        }
        const lobbyId = createTournamentLobby(test, f.org, m.id);
        priceCharacters(test, lobbyId, ['ax', 'bx', 'rx', 'ry']); // T-S10i (A107(5)): every owned character is priced
        // A settings change resets every confirmation (Backlog #9): set autoRandomPick before the players confirm.
        // T-S10i: banMode None: the auto-ban pool now draws the priced characters (A107(1)), which would ban the owned ones
        // this test draws its picks from; before S10i nothing was priced and every timer ban was a SKIP.
        const args = settingsFrom(test, lobbyId, { autoRandomPick: true, banMode: { tag: 'None' } });
        tx(test, f.org, (ctx) => M.update_lobby_settings(ctx, args));
        for (const who of [blue.captain, blue.mate, red.captain, red.mate]) {
            join(test, who, lobbyId);
            tx(test, who, (ctx) => M.confirm_ready(ctx, { lobbyId }));
        }
        tx(test, blue.captain, (ctx) => M.select_match_account(ctx, { lobbyId, hsrAccountId: p1B })); // additive (D-05)
        expect(lmaOf(test, lobbyId, blue.captain.userId)).toEqual([p1A, p1B].sort((a, b) => a - b));
        tx(test, f.org, (ctx) => M.start_draft(ctx, { lobbyId }));
        const s: Lobby = { test, lobbyId, host: f.org, a: { b1: blue.captain, b2: blue.mate, r1: red.captain, r2: red.mate } };

        const picks = autoPicks(test, s, 'Blue', 3);
        expect(new Set(picks.slice(0, 2))).toEqual(new Set(['ax', 'bx']));
        expect(picks[2]).toBe('EMPTY');
    });

    it('stand-in: the stand-in\'s selected account feeds the pool; the replaced player\'s account does not', () => {
        // T-S10v (A137(4)): registration in a requireOwnership tournament now needs an active game account; the fixture
        // players own none, so the field is built without the flag and the flag is set on the row before the lobby.
        const f = liveField(2);
        const { test } = f;
        test.db.Tournament.id.update({ ...test.db.Tournament.id.find(f.id)!, requireOwnership: true });
        const m = byKey(test, f.id, 'W-R1-M1');
        const { blue, red } = sidesOf(f, m.id);
        const sub = verified(test, 'sub');
        const capAcct = ownedAccount(test, blue.captain.userId, 'cap', ['cx']);
        const origAcct = ownedAccount(test, blue.mate.userId, 'orig', ['ox']); // the replaced mate: never joins
        const subAcct = ownedAccount(test, sub.userId, 'sub', ['sx']);
        const r1 = ownedAccount(test, red.captain.userId, 'r1', ['rx']);
        const r2 = ownedAccount(test, red.mate.userId, 'r2', ['ry']);
        for (const [who, acct] of [[blue.captain, capAcct], [blue.mate, origAcct], [red.captain, r1], [red.mate, r2]] as const) {
            lockAccount(test, f.id, who.userId, acct);
        }
        tx(test, f.org, (ctx) => M.approve_stand_in(ctx, { bracketMatchId: m.id, teamId: m.team1Id!, userId: sub.userId }));
        const lobbyId = createTournamentLobby(test, f.org, m.id);
        priceCharacters(test, lobbyId, ['cx', 'ox', 'sx', 'rx', 'ry']); // T-S10i (A107(5)): every owned character is priced
        // T-S10i: banMode None: the auto-ban pool now draws the priced characters (A107(1)), which would ban the owned ones
        // this test draws its picks from; before S10i nothing was priced and every timer ban was a SKIP.
        const args = settingsFrom(test, lobbyId, { autoRandomPick: true, banMode: { tag: 'None' } }); // before the confirmations (Backlog #9)
        tx(test, f.org, (ctx) => M.update_lobby_settings(ctx, args));
        for (const who of [blue.captain, sub, red.captain, red.mate]) {
            join(test, who, lobbyId);
            tx(test, who, (ctx) => M.confirm_ready(ctx, { lobbyId }));
        }
        expect(lmaOf(test, lobbyId, sub.userId)).toEqual([subAcct]); // D-26: snapshot + auto-selection on join (S10v F7: not at approval)
        tx(test, f.org, (ctx) => M.start_draft(ctx, { lobbyId }));
        const s: Lobby = { test, lobbyId, host: f.org, a: { b1: blue.captain, sub, r1: red.captain, r2: red.mate } };

        const picks = autoPicks(test, s, 'Blue', 3);
        expect(new Set(picks.slice(0, 2))).toEqual(new Set(['cx', 'sx']));
        expect(picks[2]).toBe('EMPTY');
        expect(picks).not.toContain('ox');
    });
});
