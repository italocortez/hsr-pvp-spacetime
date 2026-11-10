// T-S4: in-memory tests for the S4 lobby / draft fixes (BACKEND-BUGS F1, F3, F6, F7, F8, F9; DECISIONS A22(2)-(4)).
// Replaces the "NOT COVERED: requires clientDisconnected to fire" gap of test/backend/lobby/disconnect-concede.test.ts.
import { describe, expect, it } from 'vitest';
import {
    priceBanNames,
    M,
    advance,
    captainOf,
    connect,
    disconnect,
    expectReject,
    fireCheck,
    guest,
    lobbyRow,
    member,
    newHarness,
    pendingCheck,
    refereeIds,
    session,
    setupLobby,
    steps,
    tx,
    type Actor,
    type Lobby,
    priceCharacters,
} from './s4-fixtures';
import { groupCount, type LineupFormatTag } from '@shared/scoring';
import { H, completeDraft, confirmAndClose, gameRow, playToScoring, record, recordScores, setRole } from './s7-fixtures';

const NOT_ELIGIBLE = /Opposing team is not eligible for forfeit/;
const rejoin = (s: Lobby, who: Actor) =>
    tx(s.test, who, (ctx) => M.join_lobby(ctx, { lobbyId: s.lobbyId, joinCode: '', password: '' }));
const actorOf = (s: Lobby, userId: number) => Object.values(s.a).find((x) => x.userId === userId)!;
const blueCaptain = (s: Lobby) => actorOf(s, captainOf(s.test, s.lobbyId, 'BluePlayer')!.userId);
const redCaptain = (s: Lobby) => actorOf(s, captainOf(s.test, s.lobbyId, 'RedPlayer')!.userId);

describe('F1 / A22(2): reconnect', () => {
    it('join_lobby by a disconnected member in Drafting: accepted, online, disconnectedAt cleared, pool charged', () => {
        const test = newHarness();
        const s = setupLobby(test);
        const b1 = s.a.b1;
        disconnect(test, b1);
        expect(member(test, s.lobbyId, b1.userId).disconnectedAt).toBeDefined();
        advance(test, 5_000);

        rejoin(s, b1);
        const m = member(test, s.lobbyId, b1.userId);
        expect(m.isOnline).toBe(true);
        expect(m.disconnectedAt).toBeUndefined();
        expect(m.disconnectPoolRemainingMs).toBe(300_000 - 5_000);
    });

    it('join_lobby by a disconnected member in Waiting: accepted, online', () => {
        const test = newHarness();
        const s = setupLobby(test, { noStart: true });
        disconnect(test, s.a.b1);
        expect(member(test, s.lobbyId, s.a.b1.userId).isOnline).toBe(false);

        rejoin(s, s.a.b1);
        const m = member(test, s.lobbyId, s.a.b1.userId);
        expect(m.isOnline).toBe(true);
        expect(m.disconnectedAt).toBeUndefined();
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('Waiting');
    });

    it('client_connected alone restores the membership (Drafting and Waiting)', () => {
        const test = newHarness();
        const s = setupLobby(test);
        disconnect(test, s.a.b2);
        advance(test, 3_000);
        connect(test, s.a.b2);
        const m = member(test, s.lobbyId, s.a.b2.userId);
        expect(m.isOnline).toBe(true);
        expect(m.disconnectedAt).toBeUndefined();
        expect(m.disconnectPoolRemainingMs).toBe(300_000 - 3_000);

        const test2 = newHarness();
        const w = setupLobby(test2, { noStart: true });
        disconnect(test2, w.a.r1);
        connect(test2, w.a.r1);
        expect(member(test2, w.lobbyId, w.a.r1.userId).isOnline).toBe(true);
    });

    it('claim_forfeit against a team whose player reconnected is rejected', () => {
        const test = newHarness();
        // Host plays Red, so there is no exclusive spectator referee and players may claim (D-81).
        const s = setupLobby(test, {
            hostSlot: 'RedPlayer',
            seats: [['b1', 'BluePlayer'], ['b2', 'BluePlayer'], ['r1', 'RedPlayer']],
        });
        disconnect(test, s.a.b1);
        disconnect(test, s.a.b2);
        advance(test, 61_000); // past disconnectForfeitSeconds (60)

        // Blue is eligible at this point (the F7 test proves the success path with the same timing);
        // one Blue player reconnecting must close it.
        rejoin(s, s.a.b1);
        expectReject(test, s.a.r1, (ctx) => M.claim_forfeit(ctx, { lobbyId: s.lobbyId, forfeitingTeamSide: 0 }), NOT_ELIGIBLE);
        expect(lobbyRow(test, s.lobbyId).stage.tag).toBe('Drafting');
    });
});

describe('F3 / A22(3): expiry and draft actions are gated', () => {
    it('a non-member cannot fire timer_expiry_classic', () => {
        const test = newHarness();
        const s = setupLobby(test);
        const outsider = guest(test, 'outsider');
        advance(test, 31_000);
        expectReject(test, outsider, (ctx) => M.timer_expiry_classic(ctx, { lobbyId: s.lobbyId }), /not a member/i);
        expect(steps(test, s.lobbyId)).toHaveLength(0);
        expect(session(test, s.lobbyId).turnIndex).toBe(0);
    });

    it('Classic, paused: timer_expiry_classic, pick_character, ban_character → "Draft is paused."', () => {
        const test = newHarness();
        const s = setupLobby(test);
        tx(test, s.host, (ctx) => M.pause_draft(ctx, { lobbyId: s.lobbyId }));
        advance(test, 31_000);

        expectReject(test, s.a.b1, (ctx) => M.timer_expiry_classic(ctx, { lobbyId: s.lobbyId }), 'Draft is paused.');
        expectReject(test, blueCaptain(s), (ctx) => (priceCharacters(ctx, s.lobbyId, ['Acheron']), M.pick_character(ctx, { lobbyId: s.lobbyId, characterName: 'Acheron', eidolon: 0 })), 'Draft is paused.');
        expectReject(test, blueCaptain(s), (ctx) => M.ban_character(ctx, { lobbyId: s.lobbyId, characterName: 'Acheron' }), 'Draft is paused.');
        expect(session(test, s.lobbyId).turnIndex).toBe(0);
    });

    it('Auction, paused: nominate_character, place_bid, pass_bid, timer_expiry_auction → "Draft is paused."', () => {
        const test = newHarness();
        const s = setupLobby(test, { lobby: { draftMode: { tag: 'Auction' } } });
        expect(session(test, s.lobbyId).isAuctionPhase).toBe(true);
        tx(test, s.host, (ctx) => M.pause_draft(ctx, { lobbyId: s.lobbyId }));
        advance(test, 31_000);

        const cap = blueCaptain(s);
        expectReject(test, cap, (ctx) => (priceCharacters(ctx, s.lobbyId, ['Acheron']), M.nominate_character(ctx, { lobbyId: s.lobbyId, characterName: 'Acheron' })), 'Draft is paused.');
        expectReject(test, cap, (ctx) => M.place_bid(ctx, { lobbyId: s.lobbyId, bidAmount: 5 }), 'Draft is paused.');
        expectReject(test, cap, (ctx) => M.pass_bid(ctx, { lobbyId: s.lobbyId }), 'Draft is paused.');
        expectReject(test, cap, (ctx) => M.timer_expiry_auction(ctx, { lobbyId: s.lobbyId }), 'Draft is paused.');
    });
});

describe('F6: host leaves mid-draft', () => {
    it('the host flag goes to the new host and is not written back to the leaver', () => {
        const test = newHarness();
        const s = setupLobby(test, {
            hostSlot: 'BluePlayer',
            seats: [['b1', 'BluePlayer'], ['r1', 'RedPlayer'], ['r2', 'RedPlayer']],
        });
        tx(test, s.host, (ctx) => M.leave_lobby(ctx, { lobbyId: s.lobbyId }));

        // T-S8f (A68(1)(7)): a player's Leave in a live stage is a disconnect: the row is kept (away, leftAt) and the
        // flags move only through the 15 s check (D-35's immediate lowest-userId transfer is retired).
        expect(lobbyRow(test, s.lobbyId).hostUserId).toBe(s.host.userId);
        expect(member(test, s.lobbyId, s.host.userId).leftAt).toBeDefined();
        advance(test, 15_000);
        fireCheck(test, pendingCheck(test, s.lobbyId, s.host.userId));

        const lobby = lobbyRow(test, s.lobbyId);
        expect(lobby.hostUserId).not.toBe(s.host.userId);
        // A22(5): the leaver held the host tier, so the first online Blue player by joinSeq (b1) takes host and referee.
        expect(lobby.hostUserId).toBe(s.a.b1.userId);
        expect(refereeIds(test, s.lobbyId)).toEqual([s.a.b1.userId]);
        expect(lobby.stage.tag).toBe('Drafting');
        expect(member(test, s.lobbyId, s.host.userId).isReferee).toBe(false);
        expect(member(test, s.lobbyId, s.host.userId).leftAt).toBeDefined();
    });
});

describe('F7: claim_forfeit forfeitingTeamSide', () => {
    it('exclusive referee: 0 and 3 rejected; 1 reaches the eligibility gate, then succeeds once Blue is gone 60 s', () => {
        const test = newHarness();
        const s = setupLobby(test);
        const claim = (side: number) => (ctx: any) => M.claim_forfeit(ctx, { lobbyId: s.lobbyId, forfeitingTeamSide: side });

        expectReject(test, s.host, claim(0), 'Referee must specify forfeitingTeamSide');
        expectReject(test, s.host, claim(3), /forfeitingTeamSide must be 0/);
        expectReject(test, s.host, claim(1), NOT_ELIGIBLE);
        expectReject(test, s.host, claim(2), NOT_ELIGIBLE);

        disconnect(test, s.a.b1);
        disconnect(test, s.a.b2);
        advance(test, 61_000);
        tx(test, s.host, claim(1));

        // A casual non-tournament concede finalizes inline: runFinalization hard-deletes the lobby.
        expect(test.db.Lobby.id.find(s.lobbyId)).toBeNull();
    });
});

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
    // Pause / Undo rule of F9 is unchanged and the bans stay.
    it('undo during the auction phase removes the last step, the bid (A127)', () => {
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
        expect(session(test, lobbyId).currentNomination).toBe('Dan Heng');
        expect(steps(test, lobbyId).filter((x) => x.action.tag === 'Ban')).toHaveLength(4);
    });
});
