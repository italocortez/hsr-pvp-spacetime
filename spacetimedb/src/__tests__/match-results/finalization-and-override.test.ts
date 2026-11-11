// Match results: who finalizes, concede as surrender, overrides on standalone records, finalization skips, archived
//   budgets and history-row deletion.
// Decisions: A22, A122
// Contracts: docs/match-results/contract.md
// From S4, S10f, S10r (s4-lobby-fixes.test.ts, s10f-draft-results.test.ts, s10r-triage-fixes.test.ts).
import { describe, expect, it } from 'vitest';
import { groupCount, type LineupFormatTag } from '@shared/scoring';
import {
    M,
    advance,
    advanceToEquipping,
    expectReject,
    guest,
    lobbyRow,
    newHarness,
    priceBanNames,
    priceCharacters,
    seatOf,
    session,
    setupLobby,
    steps,
    tx,
    type Harness,
    type Lobby,
} from '../fixtures/harness';
import {
    H,
    blueNames,
    captain,
    completeDraft,
    confirmAndClose,
    finishGame,
    gameRow,
    insertCharacterCostLadder,
    insertRoster,
    playToScoring,
    record,
    recordScores,
    selectAccount,
    setRole,
} from '../fixtures/draft-and-scoring-builders';
import { blueCaptain, redCaptain } from '../fixtures/captain-actors';
import {
    parkedLobby,
    playRanked,
    rankedHook,
    validateAndFinalize,
} from '../fixtures/ranked-game-builders';
import { rejection } from '../fixtures/calendar-roster-rating-builders';
import { TURN_MS, type Team } from '../fixtures/team-and-turn';
import { liveField, moderator } from '../fixtures/tournament-builders';
import { byKey, openMatchLobby, seedElo, sidesOf } from '../fixtures/tournament-match-builders';

describe('F8 / A22(4): result reducers in AwaitingResult', () => {
    // T-S7b: advance_stage no longer reaches AwaitingResult (A60(8)); a game close does. A Ranked series closes into
    // Submitted + AwaitingResult, where the result reducers still run for an Admin (A60(7)) instead of failing with
    // "Match has ended.". Ranked is set on the lobby row in Waiting with one selected account per player (D-08 gate),
    // because guests cannot create a Ranked lobby (D-23).
    function rankedToAwaitingResult() {
        const test = newHarness();
        const s = playToScoring(test, {
            beforeStart: (l) => {
                test.db.Lobby.id.update({ ...lobbyRow(test, l.lobbyId), matchType: { tag: 'Ranked' } as any });
                let accountId = 700;
                for (const name of ['b1', 'b2', 'r1', 'r2']) {
                    test.db.LobbyMemberAccount.insert({ lobbyId: l.lobbyId, userId: l.a[name].userId, hsrAccountId: accountId++ });
                }
            },
        });
        recordScores(s, blueCaptain(s), 'Blue', [H(5), H(5)]);
        recordScores(s, redCaptain(s), 'Red', [H(6), H(6)]);
        const recordId = record(test, s.lobbyId).id;
        confirmAndClose(s); // A63: both ready, a captain submits
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('AwaitingResult');
        const rec = test.db.MatchResultRecord.id.find(recordId)!;
        expect(rec.status.tag).toBe('Submitted');
        expect(rec.winnerTeamSide?.tag).toBe('Blue');
        return { test, s, recordId };
    }
    // S7 (A21): one call per team side; values are hundredths, one per lineup group of the lobby's format.
    // Built before tx(): the lobby row is read outside the reducer transaction.
    const scores = (s: Lobby, side: 'Blue' | 'Red', value: number) => {
        const groups = groupCount(lobbyRow(s.test, s.lobbyId).lineupFormat.tag as LineupFormatTag);
        return {
            lobbyId: s.lobbyId,
            teamSide: { tag: side } as any,
            values: Array.from({ length: groups }, () => value),
            deaths: 0,
        };
    };

    it('in AwaitingResult an Admin edits the closed game (scores, adjustment), a Moderator gets "This game is closed.", a participant disputes', () => {
        const { test, s, recordId } = rankedToAwaitingResult();
        const admin = guest(test, 'admin');
        setRole(test, admin.userId, 'Admin');
        const mod = guest(test, 'mod');
        setRole(test, mod.userId, 'Moderator');

        const blueScores = scores(s, 'Blue', 400);
        tx(test, admin, (ctx) => M.record_group_scores(ctx, blueScores));
        tx(test, admin, (ctx) =>
            M.set_score_adjustment(ctx, { lobbyId: s.lobbyId, teamSide: { tag: 'Blue' } as any, value: 50 }));
        const g = gameRow(test, recordId);
        expect(g.teamBlueCyclesUsed).toBe(800);
        expect(g.teamBlueAdjustedResult).toBe(850);
        expect(g.closedAt).toBeDefined(); // the game stays closed, flags untouched (A60(7))
        expect(g.blueConfirmed && g.redConfirmed).toBe(true);
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('AwaitingResult');

        // A Moderator is not an Admin: the Submitted record is not editable for it (A60(7), A69(2):
        // ensureEditableRecord rejects a non-Admin on a Submitted record with the closed-game message).
        expectReject(test, mod, (ctx) =>
            M.set_score_adjustment(ctx, { lobbyId: s.lobbyId, teamSide: { tag: 'Blue' } as any, value: 50 }),
            'This game is closed.');

        tx(test, redCaptain(s), (ctx) => M.dispute_match_result(ctx, { matchResultId: recordId, reason: 'lag' }));
        expect(test.db.MatchResultRecord.id.find(recordId)!.status.tag).toBe('Disputed');
    });

    it('after a concede the result reducers fail: scores with "Match has been conceded.", confirm / close on the stage', () => {
        const test = newHarness();
        const s = setupLobby(test);
        const recordId = [...test.db.MatchResultRecord.lobby_id.filter(s.lobbyId)][0].id;
        completeDraft(s); // T-S10i (A100): the draft is finished first (automatic Drafting → Equipping)
        tx(test, s.host, (ctx) => M.advance_stage(ctx, { lobbyId: s.lobbyId }));
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('Scoring');
        // A casual concede finalizes inline and deletes the lobby; a tournament-controlled one stays in AwaitingResult
        // (D-80). The flag is set directly on the row (no bracket: bracketMatchId stays undefined).
        test.db.Lobby.id.update({ ...lobbyRow(test, s.lobbyId), isTournamentControlled: true });
        tx(test, s.host, (ctx) => M.concede_match(ctx, { lobbyId: s.lobbyId, losingTeamSide: 1 }));
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('AwaitingResult');
        // T-S8d (A54): the concede settles the lobby's one record in place (Validated, Concede), no second record.
        expect(test.db.MatchResultRecord.id.find(recordId)?.status.tag).toBe('Validated');
        expect(test.db.MatchResultRecord.id.find(recordId)?.matchEndReason?.tag).toBe('Concede');
        expect([...test.db.MatchResultRecord.lobby_id.filter(s.lobbyId)]).toHaveLength(1);

        const blueScores = scores(s, 'Blue', 1000);
        expectReject(test, s.host, (ctx) => M.record_group_scores(ctx, blueScores), 'Match has been conceded.');
        // A63: confirm_game is the captain's (the host referee is not one). confirm_game / close_game check the stage (Equipping or Scoring) before liveness: the lobby is AwaitingResult.
        const STAGE = 'This action is not allowed in the current lobby stage (AwaitingResult).';
        expectReject(test, blueCaptain(s), (ctx) => M.confirm_game(ctx, { lobbyId: s.lobbyId, teamSide: { tag: 'Blue' } as any }), STAGE);
        expectReject(test, s.host, (ctx) => M.close_game(ctx, { lobbyId: s.lobbyId }), STAGE);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Results #3: no stat rows for the sentinels or the system picker
// ════════════════════════════════════════════════════════════════════════════

describe('Results #3: finalization step 16 skips EMPTY, SKIP and the system user (match-results / player-stats architecture S10f)', () => {
    // T-S10i re-assertion (A106), T-S10k re-alignment (A110): the timer auto-pick of a real character credits the acting
    // side by ownership; in this 1v1 nobody owns 'solo', so the side's only player gets the played stat (A110(2)), with
    // Blue's win flag; Red has it as faced; one global row; still none for user 0.
    it('a timer EMPTY pick, a timer auto-pick of a real character and a SKIP ban: no row for EMPTY / SKIP, none for user 0; the real one is played by the acting side\'s only player, faced by the other, one global row (results audit #3, A110(2)(4))', () => {
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
                tx(test, captain(s, team), (ctx) => { const characterName = `ban-${n++}`; priceBanNames(ctx, lobbyId, [characterName]); return M.ban_character(ctx, { lobbyId, characterName }); }); // T-S10r (A122(7), L32): a ban names a priced character
            } else {
                const characterName = `${team.toLowerCase()}-p${n++}`;
                priceCharacters(test, lobbyId, [characterName]); // T-S10i (A107(5)): priced at 0 when picked (after the timer turns)
                tx(test, captain(s, team), (ctx) => M.pick_character(ctx, { lobbyId, characterName, eidolon: 0 }));
            }
        }
        expect(skipDone).toBe(true);
        advanceToEquipping(s); // T-S10t re-alignment (A129): the last step leaves the lobby in Drafting; the referee advances it.
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
        expect(solo.map((r) => r.userId).sort((a, b) => a - b)).toEqual([s.a.b1.userId, s.a.r1.userId].sort((a, b) => a - b));
        expect(solo.find((r) => r.userId === s.a.b1.userId)).toMatchObject({ matchesPlayed: 1, wins: 1, losses: 0, timesFaced: 0 }); // A110(2): the lone player
        expect(solo.find((r) => r.userId === s.a.r1.userId)).toMatchObject({ matchesPlayed: 0, timesFaced: 1, winsAgainst: 0, lossesAgainst: 1 });
        const soloGlobal = globalRows.filter((r) => r.characterName === 'solo');
        expect(soloGlobal).toHaveLength(1);
        expect(soloGlobal[0]).toMatchObject({ timesPicked: 1, timesBanned: 0, wins: 1, losses: 0 }); // side from actorSlot (Blue won)
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

const NO_AUTHORITY_TEXT = 'You do not have authority to finalize this match result.';
const recordOf = (test: Harness, lobbyId: number) => [...test.db.MatchResultRecord.lobby_id.filter(lobbyId)][0];

/** A standalone Ranked Classic lobby in Drafting where any seated player may concede (no referee exclusivity); a concede finalizes inline (D-37). */
function rankedDrafting(test: Harness): Lobby {
    seedElo(test); // a standalone concede finalizes inline (MMR for Ranked)
    return setupLobby(test, {
        lobby: { refereeExclusiveConcede: false },
        beforeStart: rankedHook(test),
    });
}

// ════════════════════════════════════════════════════════════════════════════
// L4: admin delete of a MatchSessionHistory row
// ════════════════════════════════════════════════════════════════════════════

describe('A122(2), L4: deleting a match history row removes its participant, step, game and lineup history rows', () => {
    const childCounts = (test: Harness, id: number) => [
        [...test.db.MatchParticipantHistory.by_match_history.filter(id)].length,
        [...test.db.MatchSessionStepHistory.by_match_history.filter(id)].length,
        [...test.db.MatchResultGameHistory.by_match_history.filter(id)].length,
        [...test.db.MatchLineupHistory.by_match_history.filter(id)].length,
    ];
    const actorsFor = (test: Harness, prefix: string) =>
        Object.fromEntries(['host', 'b1', 'b2', 'r1', 'r2'].map((n) => [n, guest(test, `${prefix}-${n}`)]));

    it('A122(2) L4: the deleted match loses all four kinds of child rows and keeps its MmrHistory rows; another finalized match keeps its own', () => {
        const test = newHarness();
        seedElo(test);
        const mod = moderator(test);
        const first = playRanked(test, 'Blue', { actors: actorsFor(test, 'one') });
        validateAndFinalize(test, first.s, first.recId, mod, 'Blue');
        const second = playRanked(test, 'Red', { actors: actorsFor(test, 'two') });
        validateAndFinalize(test, second.s, second.recId, mod, 'Red');
        const [h1, h2] = [...test.db.MatchSessionHistory.iter()].map((h) => h.id).sort((a, b) => a - b);
        for (const id of [h1, h2]) expect(childCounts(test, id).every((n) => n > 0)).toBe(true);
        const keep = childCounts(test, h2);
        const mmrOf = (id: number) => [...test.db.MmrHistory.iter()].filter((r) => r.matchHistoryId === id).length;
        const mmrBefore = mmrOf(h1);
        expect(mmrBefore).toBeGreaterThan(0);

        tx(test, 'internal', (ctx) => M.admin_delete_row(ctx, { tableName: 'MatchSessionHistory', primaryKeyJson: String(h1) }));
        expect(test.db.MatchSessionHistory.id.find(h1)).toBeFalsy();
        expect(childCounts(test, h1)).toEqual([0, 0, 0, 0]);
        expect(test.db.MatchSessionHistory.id.find(h2)).toBeTruthy();
        expect(childCounts(test, h2)).toEqual(keep);
        // A122(2): the rating itself is not reverted, so the user's MmrHistory rows of the deleted match stay.
        expect(mmrOf(h1)).toBe(mmrBefore);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// L40: the archived spent budget of a match that ended during the draft
// ════════════════════════════════════════════════════════════════════════════

describe('A122(11), L40: a match that ended during the draft archives the budget actually spent', () => {
    // The archived value is read from the session budgets (D-88). Auction sales move them; Classic picks do not (pick
    // costs are in neither budget). A Classic match that ends during the draft therefore archives 0; a finished one
    // archives what moved after the D-50 carryover (light-cone equips and eidolon changes), as before S10r.

    it('A122(11) L40: Auction, Blue buys a 7-cost character and concedes mid-auction: history shows Blue 7, Red 0 (not the whole character budget)', () => {
        const test = newHarness();
        seedElo(test);
        const s = setupLobby(test, { lobby: { draftMode: { tag: 'Auction' }, refereeExclusiveConcede: false }, beforeStart: rankedHook(test) });
        expect(session(test, s.lobbyId)).toMatchObject({ isAuctionPhase: true, nextNominatorTeam: { tag: 'Blue' } });
        tx(test, captain(s, 'Blue'), (ctx) => {
            priceCharacters(ctx, s.lobbyId, ['c7'], 7);
            return M.nominate_character(ctx, { lobbyId: s.lobbyId, characterName: 'c7' });
        });
        tx(test, captain(s, 'Red'), (ctx) => M.pass_bid(ctx, { lobbyId: s.lobbyId }));
        expect(session(test, s.lobbyId).teamBlueCharBudget).toBe(93);
        tx(test, s.a.b1, (ctx) => M.concede_match(ctx, { lobbyId: s.lobbyId, losingTeamSide: 0 })); // finalized inline (D-37)
        const history = [...test.db.MatchSessionHistory.iter()];
        expect(history).toHaveLength(1);
        expect([history[0].teamBlueSpent, history[0].teamRedSpent]).toEqual([7, 0]);
    });

    it('A122(11) L40: Classic, conceded in Drafting before the carryover: no team is shown as having spent its character budget', () => {
        const test = newHarness();
        const s = rankedDrafting(test);
        priceCharacters(test, s.lobbyId, ['c7'], 7);
        tx(test, captain(s, 'Blue'), (ctx) => M.pick_character(ctx, { lobbyId: s.lobbyId, characterName: 'c7', eidolon: 0 }));
        tx(test, s.a.b1, (ctx) => M.concede_match(ctx, { lobbyId: s.lobbyId, losingTeamSide: 0 })); // finalized inline (D-37)
        const history = [...test.db.MatchSessionHistory.iter()];
        expect(history).toHaveLength(1);
        expect([history[0].teamBlueSpent, history[0].teamRedSpent]).toEqual([0, 0]);
    });

    it('A122(11) L40: a Classic match drafted to the end (carryover done) archives the same value as before the fix', () => {
        const test = newHarness();
        seedElo(test);
        const mod = moderator(test);
        const { s, recId } = playRanked(test, 'Blue', { afterStart: (l) => priceCharacters(test, l.lobbyId, blueNames(), 2) });
        const sess = session(test, s.lobbyId);
        const lobby = lobbyRow(test, s.lobbyId);
        expect([sess.teamBlueCharBudget, sess.teamRedCharBudget]).toEqual([0, 0]);
        validateAndFinalize(test, s, recId, mod, 'Blue');
        const history = [...test.db.MatchSessionHistory.iter()];
        // D-88 before S10r: characterBudget + lightconeBudget - teamXLcBudget (the carryover left the char budget at 0).
        expect(history[0].teamBlueSpent).toBe(lobby.characterBudget + lobby.lightconeBudget - sess.teamBlueLcBudget);
        expect(history[0].teamRedSpent).toBe(lobby.characterBudget + lobby.lightconeBudget - sess.teamRedLcBudget);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// L51: who finalizes
// ════════════════════════════════════════════════════════════════════════════

describe('A122(14), L51: finalizing a result is a power of the lobby\'s referee and staff, not of whoever closed the game', () => {
    /**
     * A standalone Ranked game closed by the host referee (the record's refereeUserId = the closer, Submitted), the
     * referee flag then handed to r1, and the record validated by a Moderator (override_match_result).
     */
    function validatedAfterHandOver() {
        const test = newHarness();
        seedElo(test);
        const mod = moderator(test);
        const { s, recId } = playRanked(test, 'Blue');
        expect(test.db.MatchResultRecord.id.find(recId)!.refereeUserId).toBe(s.host.userId);
        const seat = seatOf(test, s.lobbyId, s.a.r1.userId);
        tx(test, s.host, (ctx) => M.transfer_referee(ctx, { lobbyId: s.lobbyId, targetJoinSeq: seat }));
        tx(test, mod, (ctx) => M.override_match_result(ctx, { matchResultId: recId, newStatusTag: 'Validated', winnerTeamSideTag: 'Blue', reason: 'reviewed' }));
        return { test, s, recId, mod };
    }

    it('A122(14) L51: the member who closed the game but no longer holds the referee flag cannot finalize; the lobby\'s referee can', () => {
        const { test, s, recId } = validatedAfterHandOver();
        expectReject(test, s.host, (ctx) => M.finalize_match_result(ctx, { matchResultId: recId }), NO_AUTHORITY_TEXT);
        expect([...test.db.MatchSessionHistory.iter()]).toHaveLength(0);
        tx(test, s.a.r1, (ctx) => M.finalize_match_result(ctx, { matchResultId: recId }));
        expect([...test.db.MatchSessionHistory.iter()]).toHaveLength(1);
    });

    it('A122(14) L51: a captain without the flag cannot finalize; a Moderator who is not in the lobby can', () => {
        const { test, s, recId, mod } = validatedAfterHandOver();
        expectReject(test, captain(s, 'Blue'), (ctx) => M.finalize_match_result(ctx, { matchResultId: recId }), NO_AUTHORITY_TEXT);
        tx(test, mod, (ctx) => M.finalize_match_result(ctx, { matchResultId: recId }));
        expect([...test.db.MatchSessionHistory.iter()]).toHaveLength(1);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// L52: a seated referee conceding their own team
// ════════════════════════════════════════════════════════════════════════════

describe('A122(15), L52: a seated referee conceding their own team is a surrender', () => {
    it('A122(15) L52: the Blue captain created the match lobby (seated referee) and concedes Blue: concedeTrigger VoluntaryLeave', () => {
        const f = liveField(2, { defaultBestOf: 1, grandFinalBestOf: 1 });
        const m = byKey(f.test, f.id, 'W-R1-M1');
        const creator = sidesOf(f, m.id).blue.captain;
        const s = openMatchLobby(f, m.id, { creator });
        const { test } = f;
        const row = [...test.db.LobbyMember.by_lobby_and_user.filter([s.lobbyId, creator.userId])][0];
        expect([row.isReferee, row.lobbySlot.tag]).toEqual([true, 'BluePlayer']);
        tx(test, creator, (ctx) => M.concede_match(ctx, { lobbyId: s.lobbyId, losingTeamSide: 0 }));
        const rec = recordOf(test, s.lobbyId);
        expect([rec.winnerTeamSide!.tag, rec.concedeTrigger!.tag]).toEqual(['Red', 'VoluntaryLeave']);
    });

    it('A122(15) L52: the unseated (Spectator) referee concedes a team: RefereeDecision', () => {
        const f = liveField(2, { defaultBestOf: 1, grandFinalBestOf: 1 });
        const s = openMatchLobby(f, byKey(f.test, f.id, 'W-R1-M1').id);
        tx(f.test, s.host, (ctx) => M.concede_match(ctx, { lobbyId: s.lobbyId, losingTeamSide: 2 }));
        const rec = recordOf(f.test, s.lobbyId);
        expect([rec.winnerTeamSide!.tag, rec.concedeTrigger!.tag]).toEqual(['Blue', 'RefereeDecision']);
    });
});
