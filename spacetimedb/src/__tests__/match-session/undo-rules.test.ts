// Match session: undo rules (audit rows, sequence numbers, the Auction ban phase, open nominations, the Undo-row
//   cap, who may undo).
// Decisions: A122, A125, A127
// Contracts: docs/match-session/contract.md
// From S4, S10f, S10r, S10s, S10q (s4-lobby-fixes.test.ts, s10f-draft-results.test.ts, s10r-triage-fixes.test.ts,
//   s10s-triage-fixes.test.ts, s10q-gap-coverage.test.ts).
import { describe, expect, it } from 'vitest';
import {
    M,
    advance,
    expectReject,
    member,
    newHarness,
    now,
    priceBanNames,
    priceCharacters,
    session,
    setupLobby,
    steps,
    tx,
    type Actor,
    type Harness,
    type Lobby,
} from '../fixtures/harness';
import { blueCaptain, redCaptain } from '../fixtures/captain-actors';
import { captain } from '../fixtures/draft-and-scoring-builders';
import type { Team } from '../fixtures/team-and-turn';
import { AUDIT0, turnOf } from '../fixtures/admin-and-turn-helpers';

describe('F9: undo skips the audit rows and keeps sequences unique', () => {
    it('Pick, pause, undo → "Nothing to undo right now."; resume, undo → the Pick goes, Pause and Undo stay', () => {
        const test = newHarness();
        const s = setupLobby(test);
        const { lobbyId } = s;
        tx(test, blueCaptain(s), (ctx) => (priceCharacters(ctx, lobbyId, ['Acheron']), M.pick_character(ctx, { lobbyId, characterName: 'Acheron', eidolon: 0 })));
        expect(session(test, lobbyId).turnIndex).toBe(1);
        tx(test, s.host, (ctx) => M.pause_draft(ctx, { lobbyId }));

        expectReject(test, s.host, (ctx) => M.undo_last_step(ctx, { lobbyId }), 'Nothing to undo right now.');

        tx(test, s.host, (ctx) => M.resume_draft(ctx, { lobbyId }));
        tx(test, s.host, (ctx) => M.undo_last_step(ctx, { lobbyId }));

        const all = steps(test, lobbyId);
        expect(all.filter((x) => x.action.tag === 'Pick')).toHaveLength(0);
        expect(all.filter((x) => x.action.tag === 'Pause')).toHaveLength(1);
        const undo = all.filter((x) => x.action.tag === 'Undo');
        expect(undo).toHaveLength(1);
        expect(undo[0].payload).toMatchObject({ tag: 'Undo', value: { originalSequenceId: 0 } });
        expect(session(test, lobbyId).turnIndex).toBe(0);
        const seqs = all.map((x) => x.sequence);
        expect(new Set(seqs).size).toBe(seqs.length);

        // The same character can be picked again after the undo (the turn is Blue's again).
        tx(test, blueCaptain(s), (ctx) => (priceCharacters(ctx, lobbyId, ['Acheron']), M.pick_character(ctx, { lobbyId, characterName: 'Acheron', eidolon: 0 })));
        const seqs2 = steps(test, lobbyId).map((x) => x.sequence);
        expect(new Set(seqs2).size).toBe(seqs2.length);
    });

    // T-S10r re-aligned (A122(9), L34): the last ban of the Auction ban phase stays undoable until the auction begins.
    // S10s re-alignment (A125): the window now ends at the first bid, so the rejection needs a Bid step after the
    // nomination (contract "Undo During the Auction Phase" still holds once bidding has begun).
    // T-S10t re-alignment (A127): the auction-phase refusal is gone; the undo removes the bid (the last draft step), the
    // Pause / Undo rule of F9 is unchanged and the bans stay. T-S10u re-alignment (A134): the undo removes the whole
    // round, the bid and its nomination; the bans stay.
    it('undo during the auction phase removes the last round, the bid with its nomination (A127, A134)', () => {
        const test = newHarness();
        const s = setupLobby(test, { lobby: { draftMode: { tag: 'Auction' }, banMode: { tag: 'Four' } } });
        const { lobbyId } = s;
        // Auction ban order: Blue, Red, Red, Blue.
        const bans: Array<[() => Actor, string]> = [
            [() => blueCaptain(s), 'Acheron'],
            [() => redCaptain(s), 'Aventurine'],
            [() => redCaptain(s), 'Boothill'],
            [() => blueCaptain(s), 'Castorice'],
        ];
        for (const [who, name] of bans) tx(test, who(), (ctx) => (priceBanNames(ctx, lobbyId, [name]), M.ban_character(ctx, { lobbyId, characterName: name }))); // T-S10r (A122(7), L32): a ban names a priced character
        expect(session(test, lobbyId).isAuctionPhase).toBe(true);
        const nominator = session(test, lobbyId).nextNominatorTeam.tag === 'Blue' ? blueCaptain(s) : redCaptain(s);
        tx(test, nominator, (ctx) => (priceCharacters(ctx, lobbyId, ['Dan Heng']), M.nominate_character(ctx, { lobbyId, characterName: 'Dan Heng' })));
        const bidder = nominator.userId === blueCaptain(s).userId ? redCaptain(s) : blueCaptain(s);
        tx(test, bidder, (ctx) => M.place_bid(ctx, { lobbyId, bidAmount: 5 }));

        tx(test, s.host, (ctx) => M.undo_last_step(ctx, { lobbyId }));
        expect(steps(test, lobbyId).filter((x) => x.action.tag === 'Bid')).toHaveLength(0);
        expect(steps(test, lobbyId).filter((x) => x.action.tag === 'Nominate')).toHaveLength(0);
        expect(session(test, lobbyId).currentNomination).toBeUndefined();
        expect(steps(test, lobbyId).filter((x) => x.action.tag === 'Ban')).toHaveLength(4);
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
            tx(test, captain(s, team), (ctx) => (priceCharacters(ctx, s.lobbyId, [name]), M.pick_character(ctx, { lobbyId: s.lobbyId, characterName: name, eidolon: 0 })));
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

const UNDO_CAP_TEXT = 'This game has reached the limit of 300 undo steps.';
const pricedBan = (s: Lobby, characterName: string) => (ctx: any) => {
    priceBanNames(ctx, s.lobbyId, [characterName]);
    return M.ban_character(ctx, { lobbyId: s.lobbyId, characterName });
};
const pricedPick = (s: Lobby, characterName: string) => (ctx: any) => {
    priceCharacters(ctx, s.lobbyId, [characterName]);
    return M.pick_character(ctx, { lobbyId: s.lobbyId, characterName, eidolon: 0 });
};
const undoBody = (s: Lobby) => (ctx: any) => M.undo_last_step(ctx, { lobbyId: s.lobbyId });

/** Inserts `n` Undo audit rows for the lobby (sequences far above the draft's). */
function insertUndoRows(test: Harness, lobbyId: number, n: number) {
    const ts = test.clock.now();
    for (let i = 0; i < n; i++) {
        test.db.MatchSessionStep.insert({
            id: 0, lobbyId, sequence: 10_000 + i, actorUserId: 0, anonymousLabel: undefined, actorSlot: { tag: 'Spectator' } as any,
            action: { tag: 'Undo' } as any, payload: { tag: 'Undo', value: { originalSequenceId: 0 } } as any, timestamp: ts, ...AUDIT0(ts),
        } as any);
    }
}

// ════════════════════════════════════════════════════════════════════════════
// L34: undo of the last Auction ban
// ════════════════════════════════════════════════════════════════════════════

describe('A122(9), L34: the last ban of the Auction ban phase can be undone', () => {
    const AUCTION_FOUR = { draftMode: { tag: 'Auction' }, banMode: { tag: 'Four' } };
    function banAll(s: Lobby, names: string[]) {
        for (const name of names) {
            tx(s.test, captain(s, turnOf(s).teamTurn.tag as 'Blue' | 'Red'), pricedBan(s, name));
        }
    }

    it('A122(9) L34: before any nomination the undo deletes the fourth ban, reopens its turn with a fresh timer and clears the auction phase; the team bans again', () => {
        const test = newHarness();
        const s = setupLobby(test, { lobby: AUCTION_FOUR });
        banAll(s, ['ban-a', 'ban-b', 'ban-c', 'ban-d']);
        const fourth = steps(test, s.lobbyId).filter((x) => x.action.tag === 'Ban').sort((a, b) => b.sequence - a.sequence)[0];
        expect(session(test, s.lobbyId)).toMatchObject({ isAuctionPhase: true, turnIndex: 4 });

        advance(test, 5_000);
        tx(test, s.host, undoBody(s));
        const sess = session(test, s.lobbyId);
        expect([sess.isAuctionPhase, sess.turnIndex]).toEqual([false, 3]);
        // The turn timer restarts at the undo.
        expect(sess.timerState.turnStartAt.microsSinceUnixEpoch).toBe(now(test));
        expect(sess.timerState.accumulatedPauseMs).toBe(0);
        const bans = steps(test, s.lobbyId).filter((x) => x.action.tag === 'Ban').map((x) => (x.payload.value as any).characterName);
        expect(bans.sort()).toEqual(['ban-a', 'ban-b', 'ban-c']);
        const undoRow = steps(test, s.lobbyId).find((x) => x.action.tag === 'Undo')!;
        expect((undoRow.payload.value as any).originalSequenceId).toBe(fourth.sequence);
        expect(turnOf(s)).toMatchObject({ actionRequired: { tag: 'Ban' }, teamTurn: fourth.actorSlot });

        banAll(s, ['ban-e']);
        expect(session(test, s.lobbyId)).toMatchObject({ isAuctionPhase: true, turnIndex: 4 });
    });

    // S10s re-alignment (A125): the window now ends at the first bid, not the first nomination; this test bids first.
    // T-S10t re-alignment (A127): there is no window any more; with a bid placed, undo removes the bid, then the
    // nomination, then the fourth ban (one step per call). T-S10u re-alignment (A134): the bid and the nomination are one
    // round and go in one call; the next undo removes the fourth ban.
    it('A122(9) L34 / A127 / A134: with a bid placed, undo walks back the round (bid and nomination) and then the last ban', () => {
        const test = newHarness();
        const s = setupLobby(test, { lobby: AUCTION_FOUR });
        banAll(s, ['ban-a', 'ban-b', 'ban-c', 'ban-d']);
        const nominator = session(test, s.lobbyId).nextNominatorTeam.tag as 'Blue' | 'Red';
        tx(test, captain(s, nominator), (ctx) => {
            priceCharacters(ctx, s.lobbyId, ['nominee']);
            return M.nominate_character(ctx, { lobbyId: s.lobbyId, characterName: 'nominee' });
        });
        tx(test, captain(s, nominator === 'Blue' ? 'Red' : 'Blue'), (ctx) => M.place_bid(ctx, { lobbyId: s.lobbyId, bidAmount: 5 }));
        tx(test, s.host, undoBody(s));
        expect(steps(test, s.lobbyId).filter((x) => x.action.tag === 'Bid')).toHaveLength(0);
        expect(session(test, s.lobbyId)).toMatchObject({ currentNomination: undefined, isAuctionPhase: true });
        expect(steps(test, s.lobbyId).filter((x) => x.action.tag === 'Ban')).toHaveLength(4);
        tx(test, s.host, undoBody(s));
        expect(steps(test, s.lobbyId).filter((x) => x.action.tag === 'Ban')).toHaveLength(3);
        expect(session(test, s.lobbyId)).toMatchObject({ isAuctionPhase: false, turnIndex: 3 });
    });
});

// ════════════════════════════════════════════════════════════════════════════
// L35: Undo rows count toward the cap
// ════════════════════════════════════════════════════════════════════════════

describe('A122(10), L35: Undo rows count toward the edit-step cap (300 per game)', () => {
    it('A122(10) L35: with 300 Undo rows in the game the next undo is refused and the pick stays', () => {
        const test = newHarness();
        const s = setupLobby(test);
        tx(test, captain(s, 'Blue'), pricedPick(s, 'p1'));
        insertUndoRows(test, s.lobbyId, 300);
        expectReject(test, s.host, undoBody(s), UNDO_CAP_TEXT);
        expect(steps(test, s.lobbyId).filter((x) => x.action.tag === 'Pick')).toHaveLength(1);
        expect(session(test, s.lobbyId).turnIndex).toBe(1);
    });

    it('A122(10) L35: with 299 Undo rows the undo is accepted (the 300th row)', () => {
        const test = newHarness();
        const s = setupLobby(test);
        tx(test, captain(s, 'Blue'), pricedPick(s, 'p1'));
        insertUndoRows(test, s.lobbyId, 299);
        tx(test, s.host, undoBody(s));
        expect(steps(test, s.lobbyId).filter((x) => x.action.tag === 'Undo')).toHaveLength(300);
        expect(session(test, s.lobbyId).turnIndex).toBe(0);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// A125: in Auction the undo window stays open until the first bid
// ════════════════════════════════════════════════════════════════════════════

describe('A125: in Auction the undo cancels an open first nomination until the first bid or sale', () => {
    const AUCTION_FOUR = { draftMode: { tag: 'Auction' }, banMode: { tag: 'Four' } };
    const TURN_MS = 30_000; // DEFAULT_LOBBY_ARGS.standardTurnSeconds
    const undoBody = (s: Lobby) => (ctx: any) => M.undo_last_step(ctx, { lobbyId: s.lobbyId });
    const turnTeam = (s: Lobby) => {
        const sess = session(s.test, s.lobbyId);
        return sess.draftSequence[sess.turnIndex].teamTurn.tag as 'Blue' | 'Red';
    };
    /** Auction lobby with its four bans done (auction phase open, no nomination). */
    function auctionReady(): Lobby {
        const test = newHarness();
        const s = setupLobby(test, { lobby: AUCTION_FOUR });
        for (const name of ['ban-a', 'ban-b', 'ban-c', 'ban-d']) {
            tx(test, captain(s, turnTeam(s)), (ctx) => {
                priceBanNames(ctx, s.lobbyId, [name]);
                return M.ban_character(ctx, { lobbyId: s.lobbyId, characterName: name });
            });
        }
        expect(session(test, s.lobbyId)).toMatchObject({ isAuctionPhase: true, turnIndex: 4 });
        return s;
    }
    const nominatorOf = (s: Lobby) => session(s.test, s.lobbyId).nextNominatorTeam.tag as 'Blue' | 'Red';
    const otherSide = (side: 'Blue' | 'Red') => (side === 'Blue' ? 'Red' : 'Blue');
    function nominate(s: Lobby, name: string) {
        tx(s.test, captain(s, nominatorOf(s)), (ctx) => {
            priceCharacters(ctx, s.lobbyId, [name]);
            return M.nominate_character(ctx, { lobbyId: s.lobbyId, characterName: name });
        });
    }
    const stepsOf = (s: Lobby, tag: string) => steps(s.test, s.lobbyId).filter((x) => x.action.tag === tag);
    /** The session fields a nomination may write, plus the budgets and won counts that must not move. */
    const snapshot = (s: Lobby) => {
        const x = session(s.test, s.lobbyId);
        return {
            currentNomination: x.currentNomination, currentBidAmount: x.currentBidAmount, currentBidTeam: x.currentBidTeam.tag,
            nextNominatorTeam: x.nextNominatorTeam.tag, turnIndex: x.turnIndex, isAuctionPhase: x.isAuctionPhase,
            blue: x.teamBlueCharBudget, red: x.teamRedCharBudget, blueLc: x.teamBlueLcBudget, redLc: x.teamRedLcBudget,
            blueWon: x.blueCharactersWon, redWon: x.redCharactersWon,
        };
    };

    it('A125: a first undo cancels a manual nomination (state restored exactly, Undo row, fresh timer for the nominator); a second undo removes the last ban', () => {
        const s = auctionReady();
        const before = snapshot(s);
        const nominator = nominatorOf(s);
        nominate(s, 'nominee');
        const nom = stepsOf(s, 'Nominate')[0];
        expect(session(s.test, s.lobbyId).currentNomination).toBe('nominee');

        advance(s.test, 5_000);
        tx(s.test, s.host, undoBody(s));
        expect(snapshot(s)).toEqual(before);
        expect(nominatorOf(s)).toBe(nominator);
        const sess = session(s.test, s.lobbyId);
        expect([sess.timerState.turnStartAt.microsSinceUnixEpoch, sess.timerState.accumulatedPauseMs]).toEqual([now(s.test), 0]);
        expect(stepsOf(s, 'Nominate')).toEqual([]);
        expect((stepsOf(s, 'Undo')[0].payload.value as any).originalSequenceId).toBe(nom.sequence);

        tx(s.test, s.host, undoBody(s));
        expect(session(s.test, s.lobbyId)).toMatchObject({ isAuctionPhase: false, turnIndex: 3 });
        expect(stepsOf(s, 'Ban')).toHaveLength(3);
        expect(stepsOf(s, 'Undo')).toHaveLength(2);
    });

    it('A125: the timer\'s automatic EMPTY nomination (a Nominate step by actor 0, the turn not passed) is cancelled the same way', () => {
        const s = auctionReady();
        const before = snapshot(s);
        advance(s.test, TURN_MS + 1_000);
        tx(s.test, captain(s, 'Blue'), (ctx) => M.timer_expiry_auction(ctx, { lobbyId: s.lobbyId }));
        const nom = stepsOf(s, 'Nominate')[0];
        expect([nom.actorUserId, (nom.payload.value as any).characterName]).toEqual([0, 'EMPTY']);
        expect(session(s.test, s.lobbyId)).toMatchObject({ currentNomination: 'EMPTY', nextNominatorTeam: { tag: before.nextNominatorTeam } });

        tx(s.test, s.host, undoBody(s));
        expect(snapshot(s)).toEqual(before);
        expect(stepsOf(s, 'Nominate')).toEqual([]);
    });

    it('A125: after the undo the nominator nominates again normally', () => {
        const s = auctionReady();
        nominate(s, 'first-pick');
        tx(s.test, s.host, undoBody(s));
        nominate(s, 'second-pick');
        expect(session(s.test, s.lobbyId)).toMatchObject({ currentNomination: 'second-pick' });
        expect(stepsOf(s, 'Nominate')).toHaveLength(1);
    });

    // T-S10t re-alignment (A127): the refusal after the first bid is gone. T-S10u re-alignment (A134): the undo removes
    // the whole round (the bid and its nomination) and returns to the state before the nomination.
    it('A125 / A127 / A134: once a bid exists the undo removes the bid with its nomination: the state before the nomination', () => {
        const s = auctionReady();
        const nominator = nominatorOf(s);
        const before = snapshot(s);
        nominate(s, 'nominee');
        tx(s.test, captain(s, otherSide(nominator)), (ctx) => M.place_bid(ctx, { lobbyId: s.lobbyId, bidAmount: 5 }));
        tx(s.test, s.host, undoBody(s));
        expect(snapshot(s)).toEqual(before);
        expect(stepsOf(s, 'Bid')).toHaveLength(0);
        expect(stepsOf(s, 'Nominate')).toHaveLength(0);
    });

    // T-S10t re-alignment (A127): a sale is undone too; the next nomination goes first, then the sale. T-S10u
    // re-alignment (A134): the sale goes with its nomination: the state before that nomination.
    it('A125 / A127 / A134: once a sale exists the undo removes the open next nomination, then the sale with its nomination', () => {
        const s = auctionReady();
        const nominator = nominatorOf(s);
        const opened = snapshot(s); // before the nomination
        nominate(s, 'nominee');
        tx(s.test, captain(s, otherSide(nominator)), (ctx) => M.pass_bid(ctx, { lobbyId: s.lobbyId }));
        expect(stepsOf(s, 'AuctionSold')).toHaveLength(1);
        const sold = snapshot(s);
        nominate(s, 'next');
        tx(s.test, s.host, undoBody(s));
        expect(snapshot(s)).toEqual(sold);
        tx(s.test, s.host, undoBody(s));
        expect(snapshot(s)).toEqual(opened);
        expect(stepsOf(s, 'AuctionSold')).toHaveLength(0);
        expect(stepsOf(s, 'Nominate')).toHaveLength(0);
    });
});

const NO_STEPS_TEXT = 'No steps to undo.';
const UNDO_REFEREE_TEXT = 'Only referees with undo permission can undo.';

// ════════════════════════════════════════════════════════════════════════════
// Gap 7. A125 / A127 (S10s re-review N5)
// ════════════════════════════════════════════════════════════════════════════

describe('Gap 7, A125 / A127: Auction undo with no bans configured; undo by a non-referee (S10s re-review N5)', () => {
    const undoBody = (s: Lobby) => (ctx: any) => M.undo_last_step(ctx, { lobbyId: s.lobbyId });
    const nominatorOf = (s: Lobby) => session(s.test, s.lobbyId).nextNominatorTeam.tag as 'Blue' | 'Red';
    const otherSide = (side: 'Blue' | 'Red') => (side === 'Blue' ? 'Red' : 'Blue');
    function nominate(s: Lobby, name: string) {
        tx(s.test, captain(s, nominatorOf(s)), (ctx) => {
            priceCharacters(ctx, s.lobbyId, [name]);
            return M.nominate_character(ctx, { lobbyId: s.lobbyId, characterName: name });
        });
    }
    const stepsOf = (s: Lobby, tag: string) => steps(s.test, s.lobbyId).filter((x) => x.action.tag === tag);
    const snapshot = (s: Lobby) => {
        const x = session(s.test, s.lobbyId);
        return {
            currentNomination: x.currentNomination, currentBidAmount: x.currentBidAmount, currentBidTeam: x.currentBidTeam.tag,
            nextNominatorTeam: x.nextNominatorTeam.tag, turnIndex: x.turnIndex, isAuctionPhase: x.isAuctionPhase,
            blue: x.teamBlueCharBudget, red: x.teamRedCharBudget, blueLc: x.teamBlueLcBudget, redLc: x.teamRedLcBudget,
            blueWon: x.blueCharactersWon, redWon: x.redCharactersWon,
        };
    };
    const auctionNoBans = () => setupLobby(newHarness(), { lobby: { draftMode: { tag: 'Auction' }, banMode: { tag: 'None' } } });

    // T-S10u re-alignment (A134): in the auction phase the unit of undo is the round; two rounds (one sold, one open
    // with a bid) are undone in two calls, each back to the state before its nomination.
    it('A127, A125, A134 (N5: no bans): with nothing done the undo is refused; a sold round and an open round are undone one round per call back to the start; a further undo is refused', () => {
        const s = auctionNoBans();
        expect(session(s.test, s.lobbyId).isAuctionPhase).toBe(true);
        const start = snapshot(s);
        expectReject(s.test, s.host, undoBody(s), NO_STEPS_TEXT);

        const nominator = nominatorOf(s);
        nominate(s, 'lot-1');
        tx(s.test, captain(s, otherSide(nominator)), (ctx) => M.place_bid(ctx, { lobbyId: s.lobbyId, bidAmount: 5 }));
        tx(s.test, captain(s, nominator), (ctx) => M.pass_bid(ctx, { lobbyId: s.lobbyId }));
        expect(stepsOf(s, 'AuctionSold')).toHaveLength(1);
        const sold = snapshot(s);
        nominate(s, 'lot-2');
        tx(s.test, captain(s, nominatorOf(s) === 'Blue' ? 'Red' : 'Blue'), (ctx) => M.place_bid(ctx, { lobbyId: s.lobbyId, bidAmount: 5 }));

        tx(s.test, s.host, undoBody(s)); // the open round: lot-2 and its bid
        expect(snapshot(s)).toEqual(sold);
        tx(s.test, s.host, undoBody(s)); // the sold round: the sale, its bid and lot-1
        expect(snapshot(s)).toEqual(start);
        expect(stepsOf(s, 'Nominate')).toEqual([]);
        expect(stepsOf(s, 'Undo')).toHaveLength(2);
        expectReject(s.test, s.host, undoBody(s), NO_STEPS_TEXT);
    });

    // T-S10u re-alignment (A134): the referee's undo of the sale returns to the state before the nomination.
    it('A127, D-60, A134 (N5: a non-referee): in the auction phase a captain without the referee flag is refused for an open nomination and for a sale; nothing changes; the referee then undoes', () => {
        const s = auctionNoBans();
        const nominator = nominatorOf(s);
        const start = snapshot(s);
        nominate(s, 'lot-a');
        const opened = snapshot(s);
        for (const who of [captain(s, 'Blue'), captain(s, 'Red')]) {
            expect(member(s.test, s.lobbyId, who.userId)!.isReferee).toBe(false);
            expectReject(s.test, who, undoBody(s), UNDO_REFEREE_TEXT);
        }
        expect(snapshot(s)).toEqual(opened);
        tx(s.test, captain(s, otherSide(nominator)), (ctx) => M.pass_bid(ctx, { lobbyId: s.lobbyId }));
        const sold = snapshot(s);
        expectReject(s.test, captain(s, nominator), undoBody(s), UNDO_REFEREE_TEXT);
        expect(snapshot(s)).toEqual(sold);
        expect(stepsOf(s, 'Undo')).toEqual([]);
        tx(s.test, s.host, undoBody(s));
        expect(snapshot(s)).toEqual(start);
    });
});
